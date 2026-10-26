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

function utcTodayIso() {
  return new Date().toISOString().slice(0, 10);
}

function utcDaysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Absolute calendar bounds (UTC) for cohorting on person.properties.first_seen_at.
 * Event dateRange still uses PostHog relative tokens (dStart / -7d / …).
 */
function absoluteCohortBounds(range) {
  const today = utcTodayIso();
  if (range.date_from === "dStart") {
    return { from: today, to: today };
  }
  if (range.date_from === "-1dStart") {
    const y = utcDaysAgoIso(1);
    return { from: y, to: y };
  }
  if (range.date_from === "-7d") {
    return { from: utcDaysAgoIso(6), to: today };
  }
  if (range.date_from === "-30d") {
    return { from: utcDaysAgoIso(29), to: today };
  }
  if (range.date_from === "-90d") {
    return { from: utcDaysAgoIso(89), to: today };
  }
  if (isIsoDate(range.date_from)) {
    return {
      from: range.date_from,
      to: isIsoDate(range.date_to) ? range.date_to : range.date_from,
    };
  }
  return { from: utcDaysAgoIso(29), to: today };
}

/**
 * new = first_seen_at inside the selected range (installed in period)
 * old = first_seen_at before the range start (returning / earlier installs)
 */
function cohortFilters(cohort, bounds) {
  if (!cohort || cohort === "all" || !bounds?.from) return [];
  const from = bounds.from;
  const to = bounds.to || bounds.from;
  const seen = "toDate(toTimeZone(toDateTime(person.properties.first_seen_at), 'UTC'))";
  if (cohort === "new") {
    return [
      {
        type: "hogql",
        key:
          `person.properties.first_seen_at IS NOT NULL AND ` +
          `${seen} >= toDate('${from}') AND ${seen} <= toDate('${to}')`,
      },
    ];
  }
  if (cohort === "old") {
    return [
      {
        type: "hogql",
        key:
          `person.properties.first_seen_at IS NOT NULL AND ` +
          `${seen} < toDate('${from}')`,
      },
    ];
  }
  return [];
}

function resolveCohort(url) {
  const raw = (url.searchParams.get("cohort") || "new").trim().toLowerCase();
  if (raw === "old" || raw === "returning") return "old";
  if (raw === "all") return "all";
  return "new";
}

function stepProp(names) {
  return {
    key: "step_name",
    operator: "exact",
    type: "event",
    value: Array.isArray(names) ? names : [names],
  };
}

/** single | multi — matches store_type and legacy mode on generate/publish. */
function storeTypeProp(type) {
  if (type === "multi") {
    return {
      type: "hogql",
      key: "(toString(properties.store_type) = 'multi' OR toString(properties.mode) = 'multi_product')",
    };
  }
  return {
    type: "hogql",
    key: "(toString(properties.store_type) = 'single' OR toString(properties.mode) = 'single_product')",
  };
}

function storeTypeExact(type) {
  return {
    key: "store_type",
    operator: "exact",
    type: "event",
    value: [type],
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

/**
 * "AE|United Arab Emirates" — code for flags, name for display.
 * Missing both → filtered client-side as XX|Unknown.
 */
const COUNTRY_EXPR =
  "concat(" +
  "coalesce(nullIf(toString(properties.target_country_code), ''), 'XX'), " +
  "'|', " +
  "coalesce(nullIf(toString(properties.target_country_name), ''), nullIf(toString(properties.target_country_code), ''), 'Unknown')" +
  ")";

/**
 * Paid events historically lacked country on the event; fall back to person props
 * set when market prefs were saved.
 */
const PAID_COUNTRY_EXPR =
  "concat(" +
  "coalesce(" +
  "nullIf(toString(properties.target_country_code), ''), " +
  "nullIf(toString(person.properties.target_country_code), ''), " +
  "'XX'" +
  "), " +
  "'|', " +
  "coalesce(" +
  "nullIf(toString(properties.target_country_name), ''), " +
  "nullIf(toString(person.properties.target_country_name), ''), " +
  "nullIf(toString(properties.target_country_code), ''), " +
  "nullIf(toString(person.properties.target_country_code), ''), " +
  "'Unknown'" +
  ")" +
  ")";

const LANGUAGE_EXPR =
  "nullIf(toString(properties.store_language), '')";

/** Prefer human label; fall back to raw category slug. */
const CATEGORY_EXPR =
  "coalesce(" +
  "nullIf(toString(properties.category_label), ''), " +
  "nullIf(toString(properties.category), '')" +
  ")";

const CATEGORY_LABELS = {
  car_accessories: "Car Accessories",
  fashion: "Fashion",
  health_beauty: "Health & Beauty",
  kids_toys: "Kids Toys",
  home_kitchen: "Home & Kitchen",
  general: "General",
};

/** Catalog defaults (USD) — used when older purchase events lack `price`. */
const PACK_PRICES = {
  starter: 20,
  value: 39,
  agency: 69,
};

const PACK_LABELS = {
  starter: "Starter",
  value: "Value",
  agency: "Growth",
};

function packRename(name) {
  const key = String(name || "")
    .trim()
    .toLowerCase();
  if (!key || isNullBreakdownName(key)) return null;
  if (PACK_LABELS[key]) return PACK_LABELS[key];
  if (key === "growth") return "Growth";
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function packKeyFromLabel(name) {
  const n = String(name || "").trim().toLowerCase();
  if (n === "starter") return "starter";
  if (n === "value") return "value";
  if (n === "agency" || n === "growth") return "agency";
  for (const [key, label] of Object.entries(PACK_LABELS)) {
    if (label.toLowerCase() === n) return key;
  }
  return null;
}

function estimateRevenueFromPacks(items) {
  return (items || []).reduce((sum, item) => {
    const key = packKeyFromLabel(item.name) || packKeyFromLabel(item.code);
    const price = key ? PACK_PRICES[key] || 0 : 0;
    return sum + price * (Number(item.count) || 0);
  }, 0);
}

function themeRename(name) {
  if (name === "Template 3" || name === "template 3") return "Glow / Play";
  return name;
}

function categoryRename(name) {
  const key = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");
  if (!key || isNullBreakdownName(key)) return null;
  if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];
  // Already a display label like "Health & Beauty"
  if (String(name).includes(" ") || String(name).includes("&")) {
    return String(name).trim();
  }
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function mergeGeneratedPublished(generated, published) {
  const map = new Map();
  for (const item of generated?.items || []) {
    map.set(item.name, {
      name: item.name,
      code: item.code || null,
      generated: item.count,
      published: 0,
    });
  }
  for (const item of published?.items || []) {
    const cur = map.get(item.name) || {
      name: item.name,
      code: item.code || null,
      generated: 0,
      published: 0,
    };
    cur.published = item.count;
    if (!cur.code && item.code) cur.code = item.code;
    map.set(item.name, cur);
  }
  return [...map.values()].sort(
    (a, b) => b.generated + b.published - (a.generated + a.published),
  );
}

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

function isNullBreakdownName(name) {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  return (
    !n ||
    n === "(none)" ||
    n === "none" ||
    n === "null" ||
    n === "undefined" ||
    n === "$$_posthog_breakdown_null_$$" ||
    n.includes("posthog_breakdown_null")
  );
}

function breakdownLabel(row) {
  const raw =
    row?.breakdown_value ??
    row?.label ??
    row?.action?.name ??
    "";
  if (raw === null || raw === undefined || raw === "") return "";
  if (Array.isArray(raw)) return raw.filter(Boolean).join(", ");
  return String(raw);
}

function parseCountryKey(raw) {
  const text = String(raw || "");
  if (text.includes("|")) {
    const [codePart, ...rest] = text.split("|");
    const code = String(codePart || "")
      .trim()
      .toUpperCase();
    const name = rest.join("|").trim() || code;
    return {
      code: /^[A-Z]{2}$/.test(code) ? code : null,
      name: name || code || "Unknown",
    };
  }
  const maybeCode = text.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(maybeCode)) {
    return { code: maybeCode, name: maybeCode };
  }
  return { code: null, name: text.trim() };
}

function parseBreakdown(results, { rename, country = false, language = false } = {}) {
  const rows = Array.isArray(results) ? results : [];
  let missing = 0;
  const merged = new Map();

  for (const row of rows) {
    let label = breakdownLabel(row);
    const count = seriesTotal(row);
    if (count <= 0) continue;
    if (isNullBreakdownName(label) || label === "XX|Unknown") {
      missing += count;
      continue;
    }

    let code = null;
    let name = label;
    if (country) {
      const parsed = parseCountryKey(label);
      code = parsed.code;
      name = parsed.name;
      if (!name || isNullBreakdownName(name) || (code === "XX" && name === "Unknown")) {
        missing += count;
        continue;
      }
    } else if (language) {
      code = String(label).trim().toLowerCase().split("-")[0];
      name = languageLabel(code);
      if (!name) {
        missing += count;
        continue;
      }
    }

    if (!language && typeof rename === "function") {
      name = rename(name);
      if (!name || isNullBreakdownName(name)) {
        missing += count;
        continue;
      }
    }

    const key = country || language ? code || name : name;
    const prev = merged.get(key);
    if (prev) {
      prev.count += count;
      if (!prev.code && code) prev.code = code;
      if (String(prev.name).length < String(name).length) prev.name = name;
    } else {
      merged.set(key, { name, code, count });
    }
  }

  const items = [...merged.values()].sort((a, b) => b.count - a.count);
  return { items, missing };
}

/** Union labels from several breakdowns; keep the highest count per name (no double-count). */
function unionBreakdownMax(lists) {
  const merged = new Map();
  let missing = 0;
  for (const list of lists) {
    missing = Math.max(missing, list?.missing || 0);
    for (const item of list?.items || []) {
      const key = item.code || item.name;
      const prev = merged.get(key);
      if (!prev || item.count > prev.count) {
        merged.set(key, {
          name: item.name,
          code: item.code || prev?.code || null,
          count: item.count,
        });
      } else if (prev && !prev.code && item.code) {
        prev.code = item.code;
      }
    }
  }
  const items = [...merged.values()].sort((a, b) => b.count - a.count);
  return { items, missing };
}

function languageLabel(code) {
  const key = String(code || "")
    .trim()
    .toLowerCase()
    .split("-")[0];
  if (!key || isNullBreakdownName(key)) return null;
  return LANG_LABELS[key] || key.toUpperCase();
}

async function fetchTrendsBreakdown(market, range, {
  event,
  name,
  properties = [],
  breakdown,
  breakdownType = "event",
  math = "total",
  limit = 50,
  cohortProps = [],
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
    properties: [marketFilter(market), ...cohortProps],
    breakdownFilter: {
      breakdown,
      breakdown_type: breakdownType,
      breakdown_limit: limit,
    },
    trendsFilter: { display: "ActionsBarValue" },
  });
  return trends?.results;
}

/**
 * App-wide installs / uninstalls (not market-split — events have no market_type).
 */
async function fetchInstallStats(range, cohortProps = []) {
  const trends = await posthogQuery({
    kind: "TrendsQuery",
    series: [
      {
        kind: "EventsNode",
        event: "app_installed",
        name: "installs",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "app_uninstalled",
        name: "uninstalls",
        math: "total",
      },
    ],
    dateRange: posthogDateRange(range),
    interval: "day",
    filterTestAccounts: true,
    properties: cohortProps.length ? cohortProps : undefined,
    trendsFilter: { display: "BoldNumber" },
  });

  const rows = Array.isArray(trends?.results) ? trends.results : [];
  const byName = Object.fromEntries(
    rows.map((row) => [seriesKey(row), seriesTotal(row)]),
  );
  const installs = byName.installs ?? seriesTotal(rows[0]);
  const uninstalls = byName.uninstalls ?? seriesTotal(rows[1]);
  return {
    installs,
    uninstalls,
    net: installs - uninstalls,
  };
}

function seriesKey(row) {
  return (
    row?.action?.custom_name ||
    row?.action?.name ||
    row?.label ||
    ""
  );
}

function trendsByName(trends) {
  const rows = Array.isArray(trends?.results) ? trends.results : [];
  return Object.fromEntries(
    rows.map((row) => [seriesKey(row), seriesTotal(row)]),
  );
}

function funnelSteps(byName, defs) {
  return defs.map((def) => ({
    key: def.key,
    label: def.label,
    count: Number(byName[def.key]) || 0,
  }));
}

async function fetchMarketStats(market, range, cohortProps = []) {
  const props = [marketFilter(market), ...cohortProps];
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
        event: "onboarding_step_completed",
        name: "product_configured",
        math: "total",
        properties: [stepProp("product_configured")],
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
        event: "onboarding_step_completed",
        name: "store_configured_single",
        math: "total",
        properties: [stepProp("store_configured"), storeTypeExact("single")],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "store_configured_multi",
        math: "total",
        properties: [stepProp("store_configured"), storeTypeExact("multi")],
      },
      {
        kind: "EventsNode",
        event: "store_generated",
        name: "store_generated",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "store_generated",
        name: "store_generated_single",
        math: "total",
        properties: [storeTypeProp("single")],
      },
      {
        kind: "EventsNode",
        event: "store_generated",
        name: "store_generated_multi",
        math: "total",
        properties: [storeTypeProp("multi")],
      },
      {
        kind: "EventsNode",
        event: "store_published",
        name: "store_published",
        math: "total",
      },
      {
        kind: "EventsNode",
        event: "store_published",
        name: "store_published_single",
        math: "total",
        properties: [storeTypeProp("single")],
      },
      {
        kind: "EventsNode",
        event: "store_published",
        name: "store_published_multi",
        math: "total",
        properties: [storeTypeProp("multi")],
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
      {
        kind: "EventsNode",
        event: "credits_pack_purchased",
        name: "revenue",
        math: "sum",
        math_property: "price",
      },
    ],
    dateRange: posthogDateRange(range),
    interval: "day",
    filterTestAccounts: true,
    properties: props,
    trendsFilter: { display: "BoldNumber" },
  });

  const byName = trendsByName(trends);

  const funnels = {
    product: funnelSteps(byName, [
      { key: "product_flow", label: "Chose product flow" },
      { key: "product_configured", label: "Product configured" },
      { key: "pdp_generated", label: "PDP generated" },
      { key: "pdp_published", label: "PDP published" },
    ]),
    store_single: funnelSteps(byName, [
      { key: "store_flow", label: "Chose store flow" },
      { key: "store_configured_single", label: "Single store configured" },
      { key: "store_generated_single", label: "Single store generated" },
      { key: "store_published_single", label: "Single store published" },
    ]),
    store_multi: funnelSteps(byName, [
      { key: "store_flow", label: "Chose store flow" },
      { key: "store_configured_multi", label: "Multi store configured" },
      { key: "store_generated_multi", label: "Multi store generated" },
      { key: "store_published_multi", label: "Multi store published" },
    ]),
  };

  return {
    market_prefs: byName.market_prefs || 0,
    product_flow: byName.product_flow || 0,
    store_flow: byName.store_flow || 0,
    product_configured: byName.product_configured || 0,
    pdp_generated: byName.pdp_generated || 0,
    pdp_published: byName.pdp_published || 0,
    store_configured_single: byName.store_configured_single || 0,
    store_configured_multi: byName.store_configured_multi || 0,
    store_generated: byName.store_generated || 0,
    store_generated_single: byName.store_generated_single || 0,
    store_generated_multi: byName.store_generated_multi || 0,
    store_published: byName.store_published || 0,
    store_published_single: byName.store_published_single || 0,
    store_published_multi: byName.store_published_multi || 0,
    checkout_started: byName.checkout_started || 0,
    paid: byName.paid || 0,
    revenue: byName.revenue || 0,
    funnels,
  };
}

async function fetchMarketBreakdowns(market, range, cohortProps = []) {
  const prefsStep = [stepProp("market_preferences_saved")];
  const countryOpts = {
    breakdown: COUNTRY_EXPR,
    breakdownType: "hogql",
    math: "total",
    limit: 50,
    cohortProps,
  };
  const langOpts = {
    breakdown: LANGUAGE_EXPR,
    breakdownType: "hogql",
    math: "total",
    limit: 50,
    cohortProps,
  };
  const withCohort = { cohortProps };

  const [
    countriesPrefs,
    countriesPdpGen,
    countriesPdpPub,
    countriesStoreGen,
    countriesStorePub,
    languagesPrefs,
    languagesPdpGen,
    languagesPdpPub,
    pdpThemesGen,
    pdpThemesPub,
    storeThemesGen,
    storeThemesPub,
    storeCategoriesGen,
    storeCategoriesPub,
    pdpCategoriesGen,
    pdpCategoriesPub,
    paidCountriesRaw,
    paidPacksRaw,
  ] = await Promise.all([
    fetchTrendsBreakdown(market, range, {
      event: "onboarding_step_completed",
      name: "countries_prefs",
      properties: prefsStep,
      ...countryOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_generated",
      name: "countries_pdp_gen",
      ...countryOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_published",
      name: "countries_pdp_pub",
      ...countryOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "store_generated",
      name: "countries_store_gen",
      ...countryOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "store_published",
      name: "countries_store_pub",
      ...countryOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "onboarding_step_completed",
      name: "languages_prefs",
      properties: prefsStep,
      ...langOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_generated",
      name: "languages_pdp_gen",
      ...langOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_published",
      name: "languages_pdp_pub",
      ...langOpts,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_generated",
      name: "pdp_themes_gen",
      breakdown: THEME_EXPR,
      breakdownType: "hogql",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_published",
      name: "pdp_themes_pub",
      breakdown: THEME_EXPR,
      breakdownType: "hogql",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "store_generated",
      name: "store_themes_gen",
      breakdown: "theme_name",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "store_published",
      name: "store_themes_pub",
      breakdown: "theme_name",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "store_generated",
      name: "store_categories_gen",
      breakdown: CATEGORY_EXPR,
      breakdownType: "hogql",
      math: "total",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "store_published",
      name: "store_categories_pub",
      breakdown: CATEGORY_EXPR,
      breakdownType: "hogql",
      math: "total",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_generated",
      name: "pdp_categories_gen",
      breakdown: CATEGORY_EXPR,
      breakdownType: "hogql",
      math: "total",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "pdp_published",
      name: "pdp_categories_pub",
      breakdown: CATEGORY_EXPR,
      breakdownType: "hogql",
      math: "total",
      limit: 50,
      ...withCohort,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "credits_pack_purchased",
      name: "paid_countries",
      breakdown: PAID_COUNTRY_EXPR,
      breakdownType: "hogql",
      math: "total",
      limit: 50,
      ...withCohort,
    }).catch(async () =>
      // person.properties may fail on some projects — fall back to event-only.
      fetchTrendsBreakdown(market, range, {
        event: "credits_pack_purchased",
        name: "paid_countries_event",
        ...countryOpts,
      }),
    ),
    fetchTrendsBreakdown(market, range, {
      event: "credits_pack_purchased",
      name: "paid_packs",
      breakdown: "pack_name",
      math: "total",
      limit: 20,
      ...withCohort,
    }),
  ]);

  const countries = unionBreakdownMax([
    parseBreakdown(countriesPrefs, { country: true }),
    parseBreakdown(countriesPdpGen, { country: true }),
    parseBreakdown(countriesPdpPub, { country: true }),
    parseBreakdown(countriesStoreGen, { country: true }),
    parseBreakdown(countriesStorePub, { country: true }),
  ]);
  const languages = unionBreakdownMax([
    parseBreakdown(languagesPrefs, { language: true }),
    parseBreakdown(languagesPdpGen, { language: true }),
    parseBreakdown(languagesPdpPub, { language: true }),
  ]);
  const paidCountries = parseBreakdown(paidCountriesRaw, { country: true });
  const paidPacks = parseBreakdown(paidPacksRaw, { rename: packRename });
  const estimatedRevenue = estimateRevenueFromPacks(paidPacks.items);

  return {
    countries: countries.items,
    countries_missing: countries.missing,
    languages: languages.items,
    languages_missing: languages.missing,
    paid_countries: paidCountries.items,
    paid_countries_missing: paidCountries.missing,
    paid_packs: paidPacks.items.map((item) => {
      const key = packKeyFromLabel(item.name);
      const unit = key ? PACK_PRICES[key] || 0 : 0;
      return {
        ...item,
        code: key,
        revenue: Math.round(unit * (item.count || 0) * 100) / 100,
      };
    }),
    revenue_estimated: Math.round(estimatedRevenue * 100) / 100,
    pdp_templates: mergeGeneratedPublished(
      parseBreakdown(pdpThemesGen, { rename: themeRename }),
      parseBreakdown(pdpThemesPub, { rename: themeRename }),
    ),
    store_templates: mergeGeneratedPublished(
      parseBreakdown(storeThemesGen, { rename: themeRename }),
      parseBreakdown(storeThemesPub, { rename: themeRename }),
    ),
    pdp_categories: mergeGeneratedPublished(
      parseBreakdown(pdpCategoriesGen, { rename: categoryRename }),
      parseBreakdown(pdpCategoriesPub, { rename: categoryRename }),
    ),
    store_categories: mergeGeneratedPublished(
      parseBreakdown(storeCategoriesGen, { rename: categoryRename }),
      parseBreakdown(storeCategoriesPub, { rename: categoryRename }),
    ),
  };
}

async function loadMarket(market, range, cohortProps = []) {
  const [stats, breakdowns] = await Promise.all([
    fetchMarketStats(market, range, cohortProps),
    fetchMarketBreakdowns(market, range, cohortProps),
  ]);
  // Prefer live PostHog sum(price); fall back to catalog × pack counts for older events.
  const revenueTracked = Number(stats?.revenue) || 0;
  const revenueEstimated = Number(breakdowns?.revenue_estimated) || 0;
  const revenue = revenueTracked > 0 ? revenueTracked : revenueEstimated;
  const { funnels, ...statFields } = stats || {};
  return {
    stats: {
      ...statFields,
      revenue: Math.round(revenue * 100) / 100,
      revenue_source: revenueTracked > 0 ? "price" : "catalog",
    },
    funnels: funnels || { product: [], store_single: [], store_multi: [] },
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
  const cohort = resolveCohort(url);
  const bounds = absoluteCohortBounds(range);
  const cohortProps = cohortFilters(cohort, bounds);

  try {
    const [cod, prepaid, installs] = await Promise.all([
      loadMarket("cod", range, cohortProps),
      loadMarket("prepaid", range, cohortProps),
      fetchInstallStats(range, cohortProps),
    ]);
    json(res, 200, {
      success: true,
      preset: url.searchParams.get("preset") || null,
      cohort,
      cohort_from: bounds.from,
      cohort_to: bounds.to,
      date_from: range.date_from,
      date_to: range.date_to,
      label: range.label,
      days: range.days,
      installs,
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
