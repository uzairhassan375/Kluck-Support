/**
 * Vercel serverless: COD + prepaid PostHog KPIs and funnel.
 * Secrets stay server-side (never VITE_*). Auth = same HMAC token as support login.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Relative presets PostHog understands (calendar / rolling). */
const RELATIVE_FROM = new Set([
  "dStart",
  "-1dStart",
  "-7d",
  "-30d",
  "-90d",
]);
const RELATIVE_TO = new Set(["-1dEnd", "now", "dEnd"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DASHBOARDS = {
  cod: "https://us.posthog.com/project/296750/dashboard/2252081",
  prepaid: "https://us.posthog.com/project/296750/dashboard/2252082",
};

function isIsoDate(value) {
  if (!ISO_DATE.test(value || "")) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t);
}

/**
 * Resolve date_from / date_to from query params.
 * Presets: today | yesterday | -7d | -30d | -90d
 * Or absolute ISO dates via date_from + optional date_to.
 */
function resolveDateRange(url) {
  const preset = (url.searchParams.get("preset") || "").trim();
  let dateFrom = (url.searchParams.get("date_from") || "").trim();
  let dateTo = (url.searchParams.get("date_to") || "").trim();

  if (preset === "today") {
    return { date_from: "dStart", date_to: null, label: "Today", days: 1 };
  }
  if (preset === "yesterday") {
    return {
      date_from: "-1dStart",
      date_to: "-1dEnd",
      label: "Yesterday",
      days: 1,
    };
  }
  if (preset === "-7d" || preset === "-30d" || preset === "-90d") {
    const days = preset === "-7d" ? 7 : preset === "-90d" ? 90 : 30;
    return { date_from: preset, date_to: null, label: `${days} days`, days };
  }

  // Absolute custom range
  if (isIsoDate(dateFrom)) {
    if (dateTo && !isIsoDate(dateTo)) dateTo = "";
    if (dateTo && dateTo < dateFrom) {
      const tmp = dateFrom;
      dateFrom = dateTo;
      dateTo = tmp;
    }
    const start = Date.parse(`${dateFrom}T00:00:00Z`);
    const end = Date.parse(`${(dateTo || dateFrom)}T00:00:00Z`);
    const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
    return {
      date_from: dateFrom,
      date_to: dateTo || dateFrom,
      label: dateTo && dateTo !== dateFrom ? `${dateFrom} → ${dateTo}` : dateFrom,
      days,
    };
  }

  // Legacy / relative raw values
  if (RELATIVE_FROM.has(dateFrom)) {
    if (dateFrom === "dStart") {
      return { date_from: "dStart", date_to: null, label: "Today", days: 1 };
    }
    if (dateFrom === "-1dStart") {
      const to = RELATIVE_TO.has(dateTo) ? dateTo : "-1dEnd";
      return { date_from: "-1dStart", date_to: to, label: "Yesterday", days: 1 };
    }
    const days = dateFrom === "-7d" ? 7 : dateFrom === "-90d" ? 90 : 30;
    return { date_from: dateFrom, date_to: null, label: `${days} days`, days };
  }

  return { date_from: "-30d", date_to: null, label: "30 days", days: 30 };
}

function posthogDateRange(range) {
  const out = { date_from: range.date_from };
  if (range.date_to) out.date_to = range.date_to;
  return out;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function supportSecret() {
  return (
    process.env.SUPPORT_ADMIN_TOKEN_SECRET ||
    process.env.SUPPORT_ADMIN_PASSWORD ||
    ""
  );
}

function supportAuthorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  const secret = supportSecret();
  if (!secret || !token.includes(".")) return false;
  const [exp, sig] = token.split(".", 2);
  if (!exp || !sig) return false;
  try {
    if (Number.parseInt(exp, 10) < Math.floor(Date.now() / 1000)) return false;
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(exp).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function posthogQuery(query) {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID || "296750";
  const host = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(
    /\/$/,
    "",
  );
  if (!apiKey) {
    const err = new Error("PostHog query is not configured");
    err.status = 503;
    throw err;
  }

  const response = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data?.detail || data?.error || data?.message || `PostHog HTTP ${response.status}`;
    const err = new Error(String(message));
    err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw err;
  }
  return data;
}

function marketFilter(market) {
  return {
    key: "market_type",
    operator: "exact",
    type: "event",
    value: [market],
  };
}

function stepProp(names) {
  return {
    key: "step_name",
    operator: "exact",
    type: "event",
    value: Array.isArray(names) ? names : [names],
  };
}

/** Remap legacy "Template 3" → Glow / Play (same as product dashboard). */
const OLD_PLAY_PAGE_IDS = [
  "e6f8f771-daa4-4f6d-aee3-99344c1acab1",
  "ee3c9341-c9ea-4526-b1c1-6d3c4805e239",
];
const THEME_EXPR =
  "if(properties.theme_name = 'Template 3', " +
  "if(toString(properties.page_id) IN (" +
  OLD_PLAY_PAGE_IDS.map((id) => `'${id}'`).join(", ") +
  "), 'Play', 'Glow'), properties.theme_name)";

const LANG_LABELS = {
  en: "English",
  zh: "Mandarin Chinese",
  es: "Spanish",
  hi: "Hindi",
  ar: "Arabic",
  fr: "French",
  pt: "Portuguese",
  ru: "Russian",
  de: "German",
  ja: "Japanese",
  ko: "Korean",
  it: "Italian",
  tr: "Turkish",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
};

/** Sum of series data points (period total). */
function seriesTotal(resultRow) {
  if (!resultRow) return 0;
  if (typeof resultRow.aggregated_value === "number") {
    return Math.round(resultRow.aggregated_value);
  }
  if (typeof resultRow.count === "number") return Math.round(resultRow.count);
  if (Array.isArray(resultRow.data)) {
    return Math.round(resultRow.data.reduce((a, b) => a + (Number(b) || 0), 0));
  }
  return 0;
}

function breakdownLabel(row) {
  const raw =
    row?.breakdown_value ??
    row?.label ??
    row?.action?.name ??
    "";
  if (raw === null || raw === undefined || raw === "") return "(none)";
  if (Array.isArray(raw)) return raw.filter(Boolean).join(", ") || "(none)";
  return String(raw);
}

function parseBreakdown(results, { rename } = {}) {
  const rows = Array.isArray(results) ? results : [];
  const items = rows
    .map((row) => {
      let name = breakdownLabel(row);
      if (typeof rename === "function") name = rename(name) || name;
      return { name, count: seriesTotal(row) };
    })
    .filter((item) => item.count > 0 && item.name !== "(none)");
  items.sort((a, b) => b.count - a.count);
  return items;
}

function languageLabel(code) {
  const key = String(code || "")
    .trim()
    .toLowerCase()
    .split("-")[0];
  if (!key || key === "(none)" || key === "null") return null;
  return LANG_LABELS[key] || key.toUpperCase();
}

async function fetchTrendsBreakdown(market, range, {
  event,
  name,
  properties = [],
  breakdown,
  breakdownType = "event",
  math = "total",
}) {
  const trends = await posthogQuery({
    kind: "TrendsQuery",
    series: [
      {
        kind: "EventsNode",
        event,
        name,
        math,
        properties,
      },
    ],
    dateRange: posthogDateRange(range),
    interval: "day",
    filterTestAccounts: true,
    properties: [marketFilter(market)],
    breakdownFilter: {
      breakdown,
      breakdown_type: breakdownType,
      breakdown_limit: 25,
    },
    trendsFilter: { display: "ActionsBarValue" },
  });
  return trends?.results;
}

async function fetchMarketStats(market, range) {
  const props = [marketFilter(market)];
  const trends = await posthogQuery({
    kind: "TrendsQuery",
    series: [
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "market_prefs",
        math: "dau",
        properties: [stepProp("market_preferences_saved")],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "product_flow",
        math: "total",
        properties: [stepProp("product_flow_selected")],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "store_flow",
        math: "total",
        properties: [stepProp("store_flow_selected")],
      },
      {
        kind: "EventsNode",
        event: "pdp_generated",
        name: "pdp_generated",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "pdp_published",
        name: "pdp_published",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "store_generated",
        name: "store_generated",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "store_published",
        name: "store_published",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "credits_pack_checkout_started",
        name: "checkout_started",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "credits_pack_purchased",
        name: "paid",
        math: "total",
      },
    ],
    dateRange: posthogDateRange(range),
    interval: "day",
    filterTestAccounts: true,
    properties: props,
    trendsFilter: { display: "BoldNumber" },
  });

  const rows = Array.isArray(trends?.results) ? trends.results : [];
  const byName = Object.fromEntries(
    rows.map((row) => [row?.action?.name || row?.label || "", seriesTotal(row)]),
  );

  return {
    market_prefs: byName.market_prefs ?? seriesTotal(rows[0]),
    product_flow: byName.product_flow ?? seriesTotal(rows[1]),
    store_flow: byName.store_flow ?? seriesTotal(rows[2]),
    pdp_generated: byName.pdp_generated ?? seriesTotal(rows[3]),
    pdp_published: byName.pdp_published ?? seriesTotal(rows[4]),
    store_generated: byName.store_generated ?? seriesTotal(rows[5]),
    store_published: byName.store_published ?? seriesTotal(rows[6]),
    checkout_started: byName.checkout_started ?? seriesTotal(rows[7]),
    paid: byName.paid ?? seriesTotal(rows[8]),
  };
}

async function fetchMarketBreakdowns(market, range) {
  const prefsStep = [stepProp("market_preferences_saved")];
  const [countriesRaw, languagesRaw, pdpThemesRaw, storeThemesRaw] =
    await Promise.all([
      fetchTrendsBreakdown(market, range, {
        event: "onboarding_step_completed",
        name: "countries",
        properties: prefsStep,
        breakdown: "target_country_name",
        math: "dau",
      }),
      fetchTrendsBreakdown(market, range, {
        event: "onboarding_step_completed",
        name: "languages",
        properties: prefsStep,
        breakdown: "store_language",
        math: "dau",
      }),
      fetchTrendsBreakdown(market, range, {
        event: "pdp_generated",
        name: "pdp_themes",
        breakdown: THEME_EXPR,
        breakdownType: "hogql",
      }),
      fetchTrendsBreakdown(market, range, {
        event: "store_generated",
        name: "store_themes",
        breakdown: "theme_name",
      }),
    ]);

  return {
    countries: parseBreakdown(countriesRaw),
    languages: parseBreakdown(languagesRaw, { rename: languageLabel }).filter(
      (item) => item.name,
    ),
    pdp_templates: parseBreakdown(pdpThemesRaw, {
      rename: (name) =>
        name === "Template 3" || name === "template 3" ? "Glow / Play" : name,
    }),
    store_templates: parseBreakdown(storeThemesRaw),
  };
}

async function fetchMarketFunnel(market, range) {
  const funnel = await posthogQuery({
    kind: "FunnelsQuery",
    series: [
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "Market prefs",
        properties: [stepProp("market_preferences_saved")],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "Flow chosen",
        properties: [
          stepProp(["product_flow_selected", "store_flow_selected"]),
        ],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "Content generated",
        properties: [stepProp("content_generated")],
      },
      {
        kind: "EventsNode",
        event: "pdp_published",
        name: "PDP published",
      },
    ],
    dateRange: posthogDateRange(range),
    filterTestAccounts: true,
    properties: [marketFilter(market)],
    funnelsFilter: {
      funnelOrderType: "ordered",
      funnelVizType: "steps",
      funnelWindowInterval: 14,
      funnelWindowIntervalUnit: "day",
    },
  });

  const labels = [
    "Market prefs",
    "Flow chosen",
    "Content generated",
    "PDP published",
  ];
  const raw = funnel?.results;
  let stepRows = [];
  if (Array.isArray(raw)) {
    if (Array.isArray(raw[0])) {
      stepRows = raw[0];
    } else if (raw[0] && typeof raw[0] === "object" && "count" in raw[0]) {
      stepRows = raw;
    }
  }

  return labels.map((name, i) => {
    const step = stepRows[i];
    return {
      name: step?.name || step?.custom_name || name,
      count: Math.round(Number(step?.count) || 0),
    };
  });
}

async function loadMarket(market, range) {
  const [stats, funnel, breakdowns] = await Promise.all([
    fetchMarketStats(market, range),
    fetchMarketFunnel(market, range),
    fetchMarketBreakdowns(market, range),
  ]);
  return {
    stats,
    funnel,
    ...breakdowns,
    dashboard_url: DASHBOARDS[market],
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.end();
    return;
  }

  if (req.method !== "GET") {
    json(res, 405, { success: false, error: "Method not allowed" });
    return;
  }

  if (!supportSecret()) {
    json(res, 503, {
      success: false,
      error:
        "SUPPORT_ADMIN_TOKEN_SECRET (or SUPPORT_ADMIN_PASSWORD) is not set on Vercel — must match the Kluck API so your login token validates here.",
    });
    return;
  }

  if (!supportAuthorized(req)) {
    json(res, 401, {
      success: false,
      error:
        "Login required — Vercel token secret may not match the API (SUPPORT_ADMIN_TOKEN_SECRET / SUPPORT_ADMIN_PASSWORD).",
    });
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const range = resolveDateRange(url);

  try {
    const [cod, prepaid] = await Promise.all([
      loadMarket("cod", range),
      loadMarket("prepaid", range),
    ]);
    json(res, 200, {
      success: true,
      preset: url.searchParams.get("preset") || null,
      date_from: range.date_from,
      date_to: range.date_to,
      label: range.label,
      days: range.days,
      cod,
      prepaid,
    });
  } catch (err) {
    const status = err.status || 500;
    json(res, status, {
      success: false,
      error: err.message || "Failed to load PostHog stats",
    });
  }
}
