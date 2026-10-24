/**
 * Vercel serverless: COD + prepaid PostHog KPIs and funnel.
 * Secrets stay server-side (never VITE_*). Auth = same HMAC token as support login.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const ALLOWED_DATE_FROM = new Set(["-7d", "-30d", "-90d"]);

const DASHBOARDS = {
  cod: "https://us.posthog.com/project/296750/dashboard/2252081",
  prepaid: "https://us.posthog.com/project/296750/dashboard/2252082",
};

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

function daysFromDateFrom(dateFrom) {
  if (dateFrom === "-7d") return 7;
  if (dateFrom === "-90d") return 90;
  return 30;
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

async function fetchMarketStats(market, dateFrom) {
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
    ],
    dateRange: { date_from: dateFrom },
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
  };
}

async function fetchMarketFunnel(market, dateFrom) {
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
    dateRange: { date_from: dateFrom },
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

async function loadMarket(market, dateFrom) {
  const [stats, funnel] = await Promise.all([
    fetchMarketStats(market, dateFrom),
    fetchMarketFunnel(market, dateFrom),
  ]);
  return {
    stats,
    funnel,
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
  let dateFrom = url.searchParams.get("date_from") || "-30d";
  if (!ALLOWED_DATE_FROM.has(dateFrom)) dateFrom = "-30d";

  try {
    const [cod, prepaid] = await Promise.all([
      loadMarket("cod", dateFrom),
      loadMarket("prepaid", dateFrom),
    ]);
    json(res, 200, {
      success: true,
      date_from: dateFrom,
      days: daysFromDateFrom(dateFrom),
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
