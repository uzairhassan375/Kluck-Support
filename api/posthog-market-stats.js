/**
 * Vercel serverless: COD + prepaid PostHog KPIs and funnel.
 * Secrets stay server-side (never VITE_*). Auth = same HMAC token as support login.
 *
 * PostHog queries are paced (≤2 concurrent) with 429 retry — keep maxDuration high.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";

// Per-request PostHog cache mode; module state is shared across concurrent requests.
const requestContext = new AsyncLocalStorage();

export const config = {
  maxDuration: 60,
};

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

/**
 * PostHog query API limits (project-level): 3 concurrent, hundreds/min.
 * Support is single-operator — run at the concurrent cap; only back off on 429.
 */
const POSTHOG_MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.POSTHOG_MAX_CONCURRENT || 3),
);
const POSTHOG_MIN_GAP_MS = Math.max(
  0,
  Number(process.env.POSTHOG_MIN_GAP_MS || 0),
);
const POSTHOG_MAX_RETRIES = Math.max(
  0,
  Number(process.env.POSTHOG_MAX_RETRIES || 4),
);

let posthogActive = 0;
let posthogLastStartMs = 0;
const posthogWaiters = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquirePosthogSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (posthogActive >= POSTHOG_MAX_CONCURRENT) {
        posthogWaiters.push(tryAcquire);
        return;
      }
      posthogActive += 1;
      const gap = Math.max(0, POSTHOG_MIN_GAP_MS - (Date.now() - posthogLastStartMs));
      if (gap > 0) {
        sleep(gap).then(() => {
          posthogLastStartMs = Date.now();
          resolve();
        });
      } else {
        posthogLastStartMs = Date.now();
        resolve();
      }
    };
    tryAcquire();
  });
}

function releasePosthogSlot() {
  posthogActive = Math.max(0, posthogActive - 1);
  const next = posthogWaiters.shift();
  if (next) next();
}

function parseThrottleWaitMs(message, response) {
  const header = response?.headers?.get?.("retry-after");
  if (header) {
    const asNum = Number(header);
    if (Number.isFinite(asNum) && asNum >= 0) {
      return Math.ceil(asNum * 1000) + 250;
    }
    const when = Date.parse(header);
    if (Number.isFinite(when)) {
      return Math.max(250, when - Date.now() + 250);
    }
  }
  const text = String(message || "");
  const m = text.match(/available in\s+(\d+)\s*seconds?/i);
  if (m) return (Number(m[1]) + 1) * 1000;
  return 5000;
}

function isThrottleError(status, data) {
  if (status === 429) return true;
  const text = String(data?.detail || data?.error || data?.message || "");
  return /throttl|rate.?limit|too many requests/i.test(text);
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

  let lastError;
  for (let attempt = 0; attempt <= POSTHOG_MAX_RETRIES; attempt++) {
    await acquirePosthogSlot();
    try {
      const response = await fetch(`${host}/api/projects/${projectId}/query/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          // "blocking" serves PostHog's cached result if it is still fresh, which
          // for past days can hide late or backfilled events for hours.
          refresh: requestContext.getStore()?.forceRefresh
            ? "force_blocking"
            : "blocking",
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (isThrottleError(response.status, data)) {
        const message =
          data?.detail ||
          data?.error ||
          data?.message ||
          `PostHog throttled (${response.status})`;
        lastError = new Error(String(message));
        lastError.status = 429;
        if (attempt >= POSTHOG_MAX_RETRIES) break;
        const waitMs = parseThrottleWaitMs(message, response);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const message =
          data?.detail ||
          data?.error ||
          data?.message ||
          `PostHog HTTP ${response.status}`;
        const err = new Error(String(message));
        err.status =
          response.status >= 400 && response.status < 600 ? response.status : 502;
        throw err;
      }
      return data;
    } finally {
      releasePosthogSlot();
    }
  }

  throw (
    lastError ||
    Object.assign(new Error("PostHog request was throttled"), { status: 429 })
  );
}

function marketFilter(market) {
  return {
    key: "market_type",
    operator: "exact",
    type: "event",
    value: [market],
  };
}

/** Match PostHog project timezone (Kluck = Asia/Karachi) so "today" aligns with dStart. */
const POSTHOG_TZ = process.env.POSTHOG_TIMEZONE || "Asia/Karachi";

function projectTodayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: POSTHOG_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function projectDaysAgoIso(days) {
  // Noon UTC avoids DST edge flips when shifting calendar days in POSTHOG_TZ.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: POSTHOG_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const shifted = new Date(noonUtc - days * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
}

/**
 * Absolute calendar bounds in PostHog project TZ for new/old cohorts.
 * Event dateRange still uses PostHog relative tokens (dStart / -7d / …).
 */
function absoluteCohortBounds(range) {
  const today = projectTodayIso();
  if (range.date_from === "dStart") {
    return { from: today, to: today };
  }
  if (range.date_from === "-1dStart") {
    const y = projectDaysAgoIso(1);
    return { from: y, to: y };
  }
  if (range.date_from === "-7d") {
    return { from: projectDaysAgoIso(6), to: today };
  }
  if (range.date_from === "-30d") {
    return { from: projectDaysAgoIso(29), to: today };
  }
  if (range.date_from === "-90d") {
    return { from: projectDaysAgoIso(89), to: today };
  }
  if (isIsoDate(range.date_from)) {
    return {
      from: range.date_from,
      to: isIsoDate(range.date_to) ? range.date_to : range.date_from,
    };
  }
  return { from: projectDaysAgoIso(29), to: today };
}

/**
 * new = person first appeared in PostHog during the selected range (install day),
 *       or the shop reinstalled during the range
 * old = person existed before the range start and did not reinstall in it
 *
 * Uses person.created_at (always set) — not first_seen_at, which is often null
 * until identify and was undercounting installs.
 *
 * last_reinstalled_date is a YYYY-MM-DD string in the project TZ, set by the
 * backend on reinstall. Events before the reinstall don't carry it
 * (person-on-events), so pre-reinstall activity stays in "old".
 */
function cohortFilters(cohort, bounds) {
  if (!cohort || cohort === "all" || !bounds?.from) return [];
  const from = bounds.from;
  const to = bounds.to || bounds.from;
  // person.created_at is interpreted in the project timezone by PostHog/HogQL.
  const created = "toDate(person.created_at)";
  const createdInRange = `(${created} >= toDate('${from}') AND ${created} <= toDate('${to}'))`;
  const reinstalled = "coalesce(toString(person.properties.last_reinstalled_date), '')";
  const reinstalledInRange = `(${reinstalled} >= '${from}' AND ${reinstalled} <= '${to}')`;
  const isReinstallEvent = "coalesce(toBool(properties.is_reinstall), false)";
  if (cohort === "new") {
    return [
      {
        type: "hogql",
        key: `${createdInRange} OR ${reinstalledInRange} OR ${isReinstallEvent}`,
      },
    ];
  }
  if (cohort === "old") {
    return [
      {
        type: "hogql",
        key: `${created} < toDate('${from}') AND NOT ${reinstalledInRange} AND NOT ${isReinstallEvent}`,
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

/**
 * One row per person who saved market prefs (latest country + language).
 * Trends DAU + daily bars sum day-uniques and can exceed the green unique count.
 */
async function fetchPrefsAudienceUnique(market, range, cohortProps = []) {
  const data = await posthogQuery({
    kind: "HogQLQuery",
    query: `
SELECT
  person_id,
  argMax(${COUNTRY_EXPR}, timestamp) AS country_key,
  argMax(${LANGUAGE_EXPR}, timestamp) AS language_key
FROM events
WHERE event = 'onboarding_step_completed'
  AND {filters}
GROUP BY person_id
`.trim(),
    filters: {
      filterTestAccounts: true,
      dateRange: posthogDateRange(range),
      properties: [
        marketFilter(market),
        stepProp("market_preferences_saved"),
        ...(cohortProps || []),
      ],
    },
  });

  const rows = Array.isArray(data?.results) ? data.results : [];
  const countryRows = [];
  const languageRows = [];
  for (const row of rows) {
    const countryKey = Array.isArray(row) ? row[1] : row?.country_key;
    const languageKey = Array.isArray(row) ? row[2] : row?.language_key;
    countryRows.push({
      breakdown_value: countryKey == null ? "" : String(countryKey),
      aggregated_value: 1,
    });
    languageRows.push({
      breakdown_value: languageKey == null ? "" : String(languageKey),
      aggregated_value: 1,
    });
  }

  const countries = parseBreakdown(countryRows, { country: true });
  const languages = parseBreakdown(languageRows, { language: true });
  return {
    unique_users: rows.length,
    countries: countries.items,
    countries_missing: countries.missing,
    languages: languages.items,
    languages_missing: languages.missing,
  };
}

/** Prefer human label; fall back to raw category slug. */
const CATEGORY_EXPR =
  "coalesce(" +
  "nullIf(toString(properties.category_label), ''), " +
  "nullIf(toString(properties.category), '')" +
  ")";

const STORE_THEME_EXPR = "nullIf(toString(properties.theme_name), '')";

/**
 * Single vs multi — prefer explicit props, else infer from known theme names.
 * (Collective/Meridian/Luminous are always multi; avoids gen landing in "unknown".)
 */
const STORE_KIND_EXPR =
  "if(" +
  "toString(properties.store_type) = 'multi' OR toString(properties.mode) = 'multi_product' OR " +
  "toString(properties.theme_name) IN ('The Collective', 'Meridian', 'Luminous'), 'multi', " +
  "if(" +
  "toString(properties.store_type) = 'single' OR toString(properties.mode) = 'single_product' OR " +
  "toString(properties.theme_name) IN ('Linen', 'Pulse', 'Eclipse', 'Velvet', 'Amour', 'QuickCart', 'Glow', 'Play'), 'single', " +
  "'unknown'))";

/**
 * Market on the event, or person prop when generate (browser) omitted market_type
 * but publish (server) / identify set it.
 */
function marketFilterLoose(market) {
  const m = market === "cod" ? "cod" : "prepaid";
  return {
    type: "hogql",
    key:
      `(toString(properties.market_type) = '${m}' OR ` +
      `(empty(nullIf(toString(properties.market_type), '')) AND ` +
      `toString(person.properties.market_type) = '${m}'))`,
  };
}

/**
 * One shop (distinct_id) → one latest category + theme (+ store kind) per event.
 * Uses distinct_id (myshopify domain) so browser generate + server publish match —
 * person_id can split anon vs identified and fake "publish without generate" for new installs.
 */
async function fetchOutputUniqueByEvent(
  market,
  range,
  { events, categoryExpr, themeExpr, cohortProps = [] },
) {
  const eventList = events.map((e) => `'${e}'`).join(", ");
  const data = await posthogQuery({
    kind: "HogQLQuery",
    query: `
SELECT
  event,
  distinct_id,
  argMax(${categoryExpr}, timestamp) AS category_key,
  argMax(${themeExpr}, timestamp) AS theme_key,
  argMax(${STORE_KIND_EXPR}, timestamp) AS store_kind
FROM events
WHERE event IN (${eventList})
  AND {filters}
GROUP BY event, distinct_id
`.trim(),
    filters: {
      filterTestAccounts: true,
      dateRange: posthogDateRange(range),
      properties: [marketFilterLoose(market), ...(cohortProps || [])],
    },
  });

  const rows = Array.isArray(data?.results) ? data.results : [];
  const byEvent = Object.fromEntries(events.map((e) => [e, []]));
  for (const row of rows) {
    const eventName = Array.isArray(row) ? row[0] : row?.event;
    if (!byEvent[eventName]) continue;
    const categoryKey = Array.isArray(row) ? row[2] : row?.category_key;
    const themeKey = Array.isArray(row) ? row[3] : row?.theme_key;
    const storeKind = Array.isArray(row) ? row[4] : row?.store_kind;
    byEvent[eventName].push({
      category: categoryKey == null ? "" : String(categoryKey),
      theme: themeKey == null ? "" : String(themeKey),
      store_kind: storeKind == null ? "unknown" : String(storeKind),
    });
  }
  return byEvent;
}

function personFieldBreakdown(personRows, field, parseOpts) {
  const fake = (personRows || []).map((r) => ({
    breakdown_value: r[field] || "",
    aggregated_value: 1,
  }));
  return parseBreakdown(fake, parseOpts);
}

function filterStoreKind(personRows, kind) {
  return (personRows || []).filter((r) => r.store_kind === kind);
}

function mergeOutputPair(genRows, pubRows) {
  return {
    categories: mergeGeneratedPublished(
      personFieldBreakdown(genRows, "category", { rename: categoryRename }),
      personFieldBreakdown(pubRows, "category", { rename: categoryRename }),
    ),
    templates: mergeGeneratedPublished(
      personFieldBreakdown(genRows, "theme", { rename: themeRename }),
      personFieldBreakdown(pubRows, "theme", { rename: themeRename }),
    ),
    generated_users: (genRows || []).length,
    published_users: (pubRows || []).length,
  };
}

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
 * App-wide installs / reinstalls / uninstalls (not market-split — events have no market_type).
 * Reinstalls are app_installed with is_reinstall = true (sent since Oct 2026).
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
        properties: [
          { type: "hogql", key: "NOT coalesce(toBool(properties.is_reinstall), false)" },
        ],
      },
      {
        kind: "EventsNode",
        event: "app_installed",
        name: "reinstalls",
        math: "total",
        properties: [
          { type: "hogql", key: "coalesce(toBool(properties.is_reinstall), false)" },
        ],
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
  const reinstalls = byName.reinstalls ?? seriesTotal(rows[1]);
  const uninstalls = byName.uninstalls ?? seriesTotal(rows[2]);
  return {
    installs,
    reinstalls,
    total_installs: installs + reinstalls,
    uninstalls,
    net: installs + reinstalls - uninstalls,
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
      // All progress KPIs use unique users (dau), not click totals.
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "product_flow",
        math: "dau",
        properties: [stepProp("product_flow_selected")],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "store_flow",
        math: "dau",
        properties: [stepProp("store_flow_selected")],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "product_configured",
        math: "dau",
        properties: [stepProp("product_configured")],
      },
      {
        kind: "EventsNode",
        event: "pdp_generated",
        name: "pdp_generated",
        math: "dau",
      },
      {
        kind: "EventsNode",
        event: "pdp_published",
        name: "pdp_published",
        math: "dau",
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "store_configured_single",
        math: "dau",
        properties: [stepProp("store_configured"), storeTypeExact("single")],
      },
      {
        kind: "EventsNode",
        event: "onboarding_step_completed",
        name: "store_configured_multi",
        math: "dau",
        properties: [stepProp("store_configured"), storeTypeExact("multi")],
      },
      {
        kind: "EventsNode",
        event: "store_generated",
        name: "store_generated",
        math: "dau",
      },
      {
        kind: "EventsNode",
        event: "store_generated",
        name: "store_generated_single",
        math: "dau",
        properties: [storeTypeProp("single")],
      },
      {
        kind: "EventsNode",
        event: "store_generated",
        name: "store_generated_multi",
        math: "dau",
        properties: [storeTypeProp("multi")],
      },
      {
        kind: "EventsNode",
        event: "store_published",
        name: "store_published",
        math: "dau",
      },
      {
        kind: "EventsNode",
        event: "store_published",
        name: "store_published_single",
        math: "dau",
        properties: [storeTypeProp("single")],
      },
      {
        kind: "EventsNode",
        event: "store_published",
        name: "store_published_multi",
        math: "dau",
        properties: [storeTypeProp("multi")],
      },
      {
        kind: "EventsNode",
        event: "credits_pack_checkout_started",
        name: "checkout_started",
        math: "dau",
      },
      {
        kind: "EventsNode",
        event: "credits_pack_purchased",
        name: "paid",
        math: "dau",
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
  // Prefs + PDP/store category/template: distinct persons (not event totals).
  const withCohort = { cohortProps };

  const [
    prefsAudience,
    pdpOutput,
    storeOutput,
    paidCountriesRaw,
    paidPacksRaw,
  ] = await Promise.all([
    fetchPrefsAudienceUnique(market, range, cohortProps),
    fetchOutputUniqueByEvent(market, range, {
      events: ["pdp_generated", "pdp_published"],
      categoryExpr: CATEGORY_EXPR,
      themeExpr: THEME_EXPR,
      cohortProps,
    }),
    fetchOutputUniqueByEvent(market, range, {
      events: ["store_generated", "store_published"],
      categoryExpr: CATEGORY_EXPR,
      themeExpr: STORE_THEME_EXPR,
      cohortProps,
    }),
    fetchTrendsBreakdown(market, range, {
      event: "credits_pack_purchased",
      name: "paid_countries",
      breakdown: PAID_COUNTRY_EXPR,
      breakdownType: "hogql",
      math: "dau",
      limit: 50,
      ...withCohort,
    }).catch(async () =>
      // person.properties may fail on some projects — fall back to event-only.
      fetchTrendsBreakdown(market, range, {
        event: "credits_pack_purchased",
        name: "paid_countries_event",
        breakdown: COUNTRY_EXPR,
        breakdownType: "hogql",
        math: "dau",
        limit: 50,
        cohortProps,
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

  const pdpGen = pdpOutput.pdp_generated || [];
  const pdpPub = pdpOutput.pdp_published || [];
  const storeGen = storeOutput.store_generated || [];
  const storePub = storeOutput.store_published || [];

  const pdp = mergeOutputPair(pdpGen, pdpPub);
  const storeSingle = mergeOutputPair(
    filterStoreKind(storeGen, "single"),
    filterStoreKind(storePub, "single"),
  );
  const storeMulti = mergeOutputPair(
    filterStoreKind(storeGen, "multi"),
    filterStoreKind(storePub, "multi"),
  );
  // Combined store (legacy UI keys) — unique people who generated any store.
  const storeAll = mergeOutputPair(storeGen, storePub);

  const paidCountries = parseBreakdown(paidCountriesRaw, { country: true });
  const paidPacks = parseBreakdown(paidPacksRaw, { rename: packRename });
  const estimatedRevenue = estimateRevenueFromPacks(paidPacks.items);

  return {
    prefs_unique_users: prefsAudience.unique_users,
    countries: prefsAudience.countries,
    countries_missing: prefsAudience.countries_missing,
    languages: prefsAudience.languages,
    languages_missing: prefsAudience.languages_missing,
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
    // Same unique people as Generated/Published totals — one category/template each.
    output_uniques: {
      pdp_generated: pdp.generated_users,
      pdp_published: pdp.published_users,
      store_generated_single: storeSingle.generated_users,
      store_published_single: storeSingle.published_users,
      store_generated_multi: storeMulti.generated_users,
      store_published_multi: storeMulti.published_users,
      store_generated: storeAll.generated_users,
      store_published: storeAll.published_users,
    },
    pdp_templates: pdp.templates,
    pdp_categories: pdp.categories,
    store_templates: storeAll.templates,
    store_categories: storeAll.categories,
    store_templates_single: storeSingle.templates,
    store_categories_single: storeSingle.categories,
    store_templates_multi: storeMulti.templates,
    store_categories_multi: storeMulti.categories,
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
  // Prefs + generate/publish totals must match category/template distinct persons.
  const prefsUnique = Number(breakdowns?.prefs_unique_users);
  const marketPrefs =
    Number.isFinite(prefsUnique) && prefsUnique >= 0
      ? prefsUnique
      : Number(statFields.market_prefs) || 0;
  const ou = breakdowns?.output_uniques || {};
  const pickUnique = (key, fallback) => {
    const n = Number(ou[key]);
    return Number.isFinite(n) && n >= 0 ? n : Number(fallback) || 0;
  };
  return {
    stats: {
      ...statFields,
      market_prefs: marketPrefs,
      pdp_generated: pickUnique("pdp_generated", statFields.pdp_generated),
      pdp_published: pickUnique("pdp_published", statFields.pdp_published),
      store_generated: pickUnique("store_generated", statFields.store_generated),
      store_published: pickUnique("store_published", statFields.store_published),
      store_generated_single: pickUnique(
        "store_generated_single",
        statFields.store_generated_single,
      ),
      store_published_single: pickUnique(
        "store_published_single",
        statFields.store_published_single,
      ),
      store_generated_multi: pickUnique(
        "store_generated_multi",
        statFields.store_generated_multi,
      ),
      store_published_multi: pickUnique(
        "store_published_multi",
        statFields.store_published_multi,
      ),
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
  const forceRefresh = url.searchParams.get("refresh") === "1";

  try {
    const [cod, prepaid, installs] = await requestContext.run(
      { forceRefresh },
      () =>
        Promise.all([
          loadMarket("cod", range, cohortProps),
          loadMarket("prepaid", range, cohortProps),
          fetchInstallStats(range, cohortProps),
        ]),
    );
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
