import { useCallback, useEffect, useState } from "react";

const API_URL = (import.meta.env.VITE_API_URL || "https://api.kluck.ai").replace(
  /\/$/,
  "",
);
const TOKEN_KEY = "kluck_support_token";
const PAGE_KEY = "kluck_support_page";

const PAGES = [
  {
    id: "credits",
    label: "😢 Free users",
    hint: "Wallet top-ups",
  },
  {
    id: "posthog",
    label: "PostHog excluded stores",
    hint: "No events or replay",
  },
  {
    id: "stats",
    label: "Market flow stats",
    hint: "COD vs prepaid funnel",
  },
];

const KPI_GROUPS = [
  {
    title: "Onboarding",
    cards: [
      { key: "market_prefs", label: "Market prefs" },
      { key: "product_flow", label: "Product flow" },
      { key: "store_flow", label: "Store flow" },
    ],
  },
  {
    title: "Output",
    cards: [
      { key: "pdp_generated", label: "PDP generated" },
      { key: "pdp_published", label: "PDP published" },
      { key: "store_generated", label: "Store generated" },
      { key: "store_published", label: "Store published" },
    ],
  },
  {
    title: "Revenue",
    accent: true,
    cards: [
      { key: "checkout_started", label: "Checkout started" },
      { key: "paid", label: "Paid users" },
    ],
  },
];

const LANG_FLAGS = {
  en: "🇬🇧",
  zh: "🇨🇳",
  es: "🇪🇸",
  hi: "🇮🇳",
  ar: "🇸🇦",
  fr: "🇫🇷",
  pt: "🇵🇹",
  ru: "🇷🇺",
  de: "🇩🇪",
  ja: "🇯🇵",
  ko: "🇰🇷",
  it: "🇮🇹",
  tr: "🇹🇷",
  id: "🇮🇩",
  vi: "🇻🇳",
  th: "🇹🇭",
};

function flagFromCountryCode(code) {
  const cc = String(code || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === "XX") return "🌍";
  return String.fromCodePoint(
    ...[...cc].map((ch) => 127397 + ch.charCodeAt(0)),
  );
}

function formatInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function publishRate(generated, published) {
  const g = Number(generated) || 0;
  const p = Number(published) || 0;
  if (!g) return p ? "—" : "0%";
  return `${Math.round((1000 * p) / g) / 10}%`;
}

const DATE_PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "-7d", label: "7 days" },
  { value: "-30d", label: "30 days" },
  { value: "-90d", label: "90 days" },
  { value: "custom", label: "Custom" },
];

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function readPage() {
  try {
    const raw = sessionStorage.getItem(PAGE_KEY);
    if (raw === "credits" || raw === "posthog" || raw === "stats") return raw;
  } catch {
    /* ignore */
  }
  return "credits";
}

function funnelConversion(steps, index) {
  if (index <= 0) return null;
  const prev = steps[index - 1]?.count ?? 0;
  const cur = steps[index]?.count ?? 0;
  if (!prev) return prev === 0 && cur === 0 ? "—" : "0%";
  return `${Math.round((cur / prev) * 1000) / 10}%`;
}

function ShareList({
  market,
  sectionKey,
  title,
  hint,
  empty,
  items,
  missing,
  kind,
}) {
  const rows = Array.isArray(items) ? items : [];
  const knownTotal = rows.reduce((sum, r) => sum + (r.count || 0), 0);
  const max = Math.max(1, ...rows.map((r) => r.count || 0));
  const missingCount = Number(missing) || 0;

  return (
    <div className="stats-section">
      <div className="stats-section-head">
        <div>
          <h3>{title}</h3>
          {hint ? <p className="stats-section-hint">{hint}</p> : null}
        </div>
        {rows.length > 0 ? (
          <span className="breakdown-meta">{rows.length}</span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="breakdown-empty">{empty}</p>
      ) : (
        <ul className="share-list">
          {rows.map((row) => {
            const pct =
              knownTotal > 0
                ? Math.round((1000 * (row.count || 0)) / knownTotal) / 10
                : 0;
            let emoji = "•";
            if (kind === "country") emoji = flagFromCountryCode(row.code);
            if (kind === "language") {
              emoji = LANG_FLAGS[row.code] || "🌐";
            }
            return (
              <li key={`${market}-${sectionKey}-${row.code || row.name}`}>
                <div className="share-row">
                  <span className="share-flag" aria-hidden>
                    {emoji}
                  </span>
                  <span className="share-name" title={row.name}>
                    {row.name}
                    {kind === "country" && row.code ? (
                      <span className="share-code">{row.code}</span>
                    ) : null}
                  </span>
                  <span className="share-pct">{pct}%</span>
                  <span className="share-count">{formatInt(row.count)}</span>
                </div>
                <div className="breakdown-bar-track">
                  <div
                    className="breakdown-bar-fill"
                    style={{
                      width: `${Math.max(4, (100 * (row.count || 0)) / max)}%`,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {missingCount > 0 ? (
        <p className="breakdown-missing">
          {formatInt(missingCount)} without a value (hidden)
        </p>
      ) : null}
    </div>
  );
}

function TemplateTable({ market, title, hint, empty, items }) {
  const rows = Array.isArray(items) ? items : [];
  const maxGen = Math.max(1, ...rows.map((r) => r.generated || 0));

  return (
    <div className="stats-section">
      <div className="stats-section-head">
        <div>
          <h3>{title}</h3>
          {hint ? <p className="stats-section-hint">{hint}</p> : null}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="breakdown-empty">{empty}</p>
      ) : (
        <div className="template-table">
          <div className="template-table-head">
            <span>Template</span>
            <span>Generated</span>
            <span>Published</span>
            <span>Rate</span>
          </div>
          <ul>
            {rows.map((row) => (
              <li key={`${market}-tpl-${row.name}`}>
                <div className="template-row">
                  <span className="template-name">{row.name}</span>
                  <span className="template-gen">{formatInt(row.generated)}</span>
                  <span className="template-pub">{formatInt(row.published)}</span>
                  <span className="template-rate">
                    {publishRate(row.generated, row.published)}
                  </span>
                </div>
                <div className="template-bars">
                  <div className="breakdown-bar-track">
                    <div
                      className="breakdown-bar-fill gen-fill"
                      style={{
                        width: `${Math.max(3, (100 * (row.generated || 0)) / maxGen)}%`,
                      }}
                      title={`Generated ${row.generated}`}
                    />
                  </div>
                  <div className="breakdown-bar-track">
                    <div
                      className="breakdown-bar-fill pub-fill"
                      style={{
                        width: `${Math.max(
                          row.published ? 3 : 0,
                          (100 * (row.published || 0)) / maxGen,
                        )}%`,
                      }}
                      title={`Published ${row.published}`}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MarketColumn({ title, market, data }) {
  const stats = data?.stats || {};
  const funnel = Array.isArray(data?.funnel) ? data.funnel : [];
  const maxFunnel = Math.max(1, ...funnel.map((s) => s.count || 0));
  const pdpPublishRate = publishRate(stats.pdp_generated, stats.pdp_published);
  const storePublishRate = publishRate(
    stats.store_generated,
    stats.store_published,
  );

  return (
    <section className={`market-col market-col-${market}`}>
      <div className="market-col-head">
        <div>
          <p className="market-eyebrow">
            {market === "cod" ? "Cash on delivery" : "Prepaid / online pay"}
          </p>
          <h2>{title}</h2>
        </div>
        {data?.dashboard_url ? (
          <a
            className="market-link"
            href={data.dashboard_url}
            target="_blank"
            rel="noreferrer"
          >
            PostHog ↗
          </a>
        ) : null}
      </div>

      <div className="highlight-strip">
        <div>
          <span className="highlight-label">PDP publish rate</span>
          <strong>{pdpPublishRate}</strong>
        </div>
        <div>
          <span className="highlight-label">Store publish rate</span>
          <strong>{storePublishRate}</strong>
        </div>
        <div>
          <span className="highlight-label">Paid</span>
          <strong>{formatInt(stats.paid)}</strong>
        </div>
      </div>

      {KPI_GROUPS.map((group) => (
        <div key={`${market}-${group.title}`} className="kpi-group">
          <h3 className="kpi-group-title">{group.title}</h3>
          <div
            className={
              group.accent ? "kpi-grid kpi-grid-revenue" : "kpi-grid"
            }
          >
            {group.cards.map((card) => (
              <div
                key={`${market}-${card.key}`}
                className={group.accent ? "kpi-card kpi-card-accent" : "kpi-card"}
              >
                <span className="kpi-label">{card.label}</span>
                <span className="kpi-value">
                  {formatInt(stats[card.key])}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <ShareList
        market={market}
        sectionKey="countries"
        title="Target audience"
        hint="Countries from prefs, generated, and published events"
        empty="No country data in this range"
        items={data?.countries}
        missing={data?.countries_missing}
        kind="country"
      />

      <ShareList
        market={market}
        sectionKey="languages"
        title="Store language"
        hint="Language chosen for the storefront"
        empty="No language data in this range"
        items={data?.languages}
        missing={data?.languages_missing}
        kind="language"
      />

      <TemplateTable
        market={market}
        title="PDP templates"
        hint="Generated vs published by theme name"
        empty="No PDP templates in this range"
        items={data?.pdp_templates}
      />

      <TemplateTable
        market={market}
        title="Store templates"
        hint="Generated vs published by theme name"
        empty="No store templates in this range"
        items={data?.store_templates}
      />

      <div className="stats-section">
        <div className="stats-section-head">
          <div>
            <h3>Onboarding funnel</h3>
            <p className="stats-section-hint">
              Prefs → flow → content → PDP published
            </p>
          </div>
        </div>
        <ol className="funnel-list">
          {funnel.map((step, index) => (
            <li key={`${market}-funnel-${step.name}`}>
              <div className="funnel-meta">
                <span className="funnel-name">
                  <span className="funnel-step">{index + 1}</span>
                  {step.name}
                </span>
                <span className="funnel-count">{formatInt(step.count)}</span>
              </div>
              <div className="funnel-bar-track">
                <div
                  className="funnel-bar-fill"
                  style={{
                    width: `${Math.max(4, (100 * (step.count || 0)) / maxFunnel)}%`,
                  }}
                />
              </div>
              {index > 0 ? (
                <p className="funnel-conv">
                  {funnelConversion(funnel, index)} from previous step
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function IconCredits() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 7.5v9M9.25 10.25c.5-.7 1.35-1.15 2.75-1.15 1.7 0 2.9.85 2.9 2.15S13.7 13.4 12 13.4 9.1 14.25 9.1 15.55c0 1.3 1.2 2.15 2.9 2.15 1.4 0 2.25-.45 2.75-1.15"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPosthog() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.5 12a7.5 7.5 0 0 1 15 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.25" fill="currentColor" />
      <path
        d="M12 14.25V19"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M9 19h6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconStats() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 19V10M12 19V5M19 19v-7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

const ICONS = {
  credits: IconCredits,
  posthog: IconPosthog,
  stats: IconStats,
};

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || "");
  const [page, setPage] = useState(readPage);
  const [password, setPassword] = useState("");
  const [shop, setShop] = useState("");
  const [credits, setCredits] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const [excludeShop, setExcludeShop] = useState("");
  const [excludedShops, setExcludedShops] = useState([]);
  const [excludeBusy, setExcludeBusy] = useState(false);
  const [excludeError, setExcludeError] = useState("");
  const [excludeOk, setExcludeOk] = useState("");
  const [excludeLoaded, setExcludeLoaded] = useState(false);

  const [statsPreset, setStatsPreset] = useState("-30d");
  const [statsCustomFrom, setStatsCustomFrom] = useState(() => daysAgoIso(7));
  const [statsCustomTo, setStatsCustomTo] = useState(() => todayIso());
  const [statsRangeKey, setStatsRangeKey] = useState("-30d");
  const [statsData, setStatsData] = useState(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [statsLoaded, setStatsLoaded] = useState(false);

  const loadExcluded = useCallback(async (authToken) => {
    const data = await readJson(
      await fetch(`${API_URL}/api/support/posthog-excluded-stores`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
    );
    setExcludedShops(Array.isArray(data.shops) ? data.shops : []);
    setExcludeLoaded(true);
  }, []);

  useEffect(() => {
    if (!token) {
      setExcludedShops([]);
      setExcludeLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await loadExcluded(token);
      } catch (err) {
        if (cancelled) return;
        if (err.message === "Login required") {
          sessionStorage.removeItem(TOKEN_KEY);
          setToken("");
        } else {
          setExcludeError(err.message);
          setExcludeLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, loadExcluded]);

  const loadStats = useCallback(async (authToken, rangeKey) => {
    setStatsBusy(true);
    setStatsError("");
    try {
      const params = new URLSearchParams();
      if (rangeKey.startsWith("custom:")) {
        const [, from, to] = rangeKey.split(":");
        params.set("date_from", from);
        params.set("date_to", to || from);
      } else {
        params.set("preset", rangeKey);
      }
      const data = await readJson(
        await fetch(`/api/posthog-market-stats?${params}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
      );
      setStatsData(data);
      setStatsLoaded(true);
    } catch (err) {
      // Do not clear the session here. Login tokens are issued by the Fly API;
      // a 401 from this Vercel route usually means SUPPORT_ADMIN_TOKEN_SECRET
      // (or PASSWORD) is missing/mismatched on Vercel — not that the user logged out.
      const message =
        err.message === "Login required"
          ? "Stats auth failed. On Vercel set SUPPORT_ADMIN_TOKEN_SECRET (or SUPPORT_ADMIN_PASSWORD) to the same value as the Kluck API."
          : err.message;
      setStatsError(message);
      setStatsLoaded(true);
    } finally {
      setStatsBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!token || page !== "stats") return;
    void loadStats(token, statsRangeKey);
  }, [token, page, statsRangeKey, loadStats]);

  function selectPreset(value) {
    setStatsPreset(value);
    if (value === "custom") return;
    setStatsRangeKey(value);
  }

  function applyCustomRange(event) {
    event?.preventDefault?.();
    if (!statsCustomFrom) {
      setStatsError("Pick a start date");
      return;
    }
    let from = statsCustomFrom;
    let to = statsCustomTo || statsCustomFrom;
    if (to < from) {
      const tmp = from;
      from = to;
      to = tmp;
      setStatsCustomFrom(from);
      setStatsCustomTo(to);
    }
    setStatsPreset("custom");
    setStatsRangeKey(`custom:${from}:${to}`);
  }

  function goTo(next) {
    setPage(next);
    try {
      sessionStorage.setItem(PAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await readJson(
        await fetch(`${API_URL}/api/support/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        }),
      );
      sessionStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPassword("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function grant(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await readJson(
        await fetch(`${API_URL}/api/support/grant-credits`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            shop,
            credits: Number(credits),
            note,
          }),
        }),
      );
      setResult(data);
      setCredits("");
      setNote("");
    } catch (err) {
      if (err.message === "Login required") {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
      }
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addExcluded(event) {
    event.preventDefault();
    setExcludeBusy(true);
    setExcludeError("");
    setExcludeOk("");
    try {
      const data = await readJson(
        await fetch(`${API_URL}/api/support/posthog-excluded-stores`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ shop: excludeShop }),
        }),
      );
      setExcludedShops(Array.isArray(data.shops) ? data.shops : []);
      setExcludeShop("");
      setExcludeOk(`Excluded ${data.shop}`);
    } catch (err) {
      if (err.message === "Login required") {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
      }
      setExcludeError(err.message);
    } finally {
      setExcludeBusy(false);
    }
  }

  async function removeExcluded(domain) {
    setExcludeBusy(true);
    setExcludeError("");
    setExcludeOk("");
    try {
      const data = await readJson(
        await fetch(`${API_URL}/api/support/posthog-excluded-stores`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ shop: domain }),
        }),
      );
      setExcludedShops(Array.isArray(data.shops) ? data.shops : []);
      setExcludeOk(`Removed ${domain}`);
    } catch (err) {
      if (err.message === "Login required") {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
      }
      setExcludeError(err.message);
    } finally {
      setExcludeBusy(false);
    }
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setResult(null);
    setError("");
    setExcludeError("");
    setExcludeOk("");
    setExcludedShops([]);
    setExcludeLoaded(false);
    setStatsData(null);
    setStatsError("");
    setStatsLoaded(false);
  }

  if (!token) {
    return (
      <main className="login-screen">
        <div className="login-glow" aria-hidden />
        <section className="login-card">
          <img
            className="login-logo"
            src="/kluck-logo.jpg"
            alt="Kluck"
            width={56}
            height={56}
          />
          <p className="brand">Kluck</p>
          <h1>Support admin</h1>
          <p className="sub">
            Sign in to grant credits, manage PostHog exclusions, and view market flow stats.
          </p>
          {error ? <p className="error">{error}</p> : null}
          <form onSubmit={login}>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Checking…" : "Log in"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  const active = PAGES.find((p) => p.id === page) || PAGES[0];

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img
            className="sidebar-logo"
            src="/kluck-logo.jpg"
            alt=""
            width={40}
            height={40}
          />
          <div>
            <strong>Kluck support</strong>
            <span>Internal admin</span>
          </div>
        </div>

        <p className="sidebar-section">Menu</p>
        <nav className="sidebar-nav" aria-label="Main">
          {PAGES.map((item) => {
            const Icon = ICONS[item.id];
            return (
              <button
                key={item.id}
                type="button"
                className={page === item.id ? "nav-item active" : "nav-item"}
                onClick={() => goTo(item.id)}
              >
                <span className="nav-icon">
                  <Icon />
                </span>
                <span className="nav-copy">
                  <span className="nav-label">{item.label}</span>
                  <span className="nav-hint">{item.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <button type="button" className="sidebar-logout" onClick={logout}>
          Log out
        </button>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Support</p>
            <h1>{active.label}</h1>
            <p className="topbar-sub">{active.hint}</p>
          </div>
          {page === "posthog" && excludeLoaded ? (
            <div className="stat-pill">
              <span className="stat-value">{excludedShops.length}</span>
              <span className="stat-label">excluded</span>
            </div>
          ) : null}
          {page === "stats" ? (
            <div className="date-filters">
              <div className="date-pills" role="group" aria-label="Date range">
                {DATE_PRESETS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={
                      statsPreset === opt.value ? "date-pill active" : "date-pill"
                    }
                    disabled={statsBusy}
                    onClick={() => selectPreset(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {statsPreset === "custom" ? (
                <form className="custom-range" onSubmit={applyCustomRange}>
                  <label>
                    From
                    <input
                      type="date"
                      value={statsCustomFrom}
                      max={todayIso()}
                      disabled={statsBusy}
                      onChange={(e) => setStatsCustomFrom(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    To
                    <input
                      type="date"
                      value={statsCustomTo}
                      max={todayIso()}
                      min={statsCustomFrom || undefined}
                      disabled={statsBusy}
                      onChange={(e) => setStatsCustomTo(e.target.value)}
                      required
                    />
                  </label>
                  <button type="submit" className="btn-primary" disabled={statsBusy}>
                    Apply
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </header>

        <div className={page === "stats" ? "content content-wide" : "content"}>
          {page === "credits" ? (
            <section className="panel">
              <div className="panel-head">
                <h2>Wallet top-up</h2>
                <p>Credits are added immediately to the shop’s wallet.</p>
              </div>
              {error ? <p className="error">{error}</p> : null}
              {result ? (
                <p className="ok">
                  Granted <strong>{result.granted}</strong> to{" "}
                  <code>{result.shop}</code>. Balance is now{" "}
                  <strong>{result.balance}</strong>.
                </p>
              ) : null}
              <form className="panel-form" onSubmit={grant}>
                <label className="full">
                  Shop domain
                  <input
                    value={shop}
                    onChange={(event) => setShop(event.target.value)}
                    placeholder="store-name.myshopify.com"
                    autoComplete="off"
                    required
                  />
                </label>
                <label>
                  Credits
                  <input
                    value={credits}
                    onChange={(event) => setCredits(event.target.value)}
                    inputMode="numeric"
                    placeholder="200"
                    required
                  />
                </label>
                <label>
                  Note
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Ticket or reason"
                  />
                </label>
                <button type="submit" className="btn-primary full" disabled={busy}>
                  {busy ? "Granting…" : "Grant credits"}
                </button>
              </form>
            </section>
          ) : null}

          {page === "posthog" ? (
            <section className="panel">
              <div className="panel-head">
                <h2>Exclusion list</h2>
                <p>
                  These shops send no PostHog events and no session recordings.
                </p>
              </div>
              {excludeError ? <p className="error">{excludeError}</p> : null}
              {excludeOk ? <p className="ok">{excludeOk}</p> : null}
              <form className="add-row" onSubmit={addExcluded}>
                <label className="grow">
                  Shop domain
                  <input
                    value={excludeShop}
                    onChange={(event) => setExcludeShop(event.target.value)}
                    placeholder="store-name.myshopify.com"
                    autoComplete="off"
                    required
                  />
                </label>
                <button type="submit" className="btn-primary" disabled={excludeBusy}>
                  {excludeBusy ? "Saving…" : "Add store"}
                </button>
              </form>

              <div className="list-block">
                <div className="list-head">
                  <span>Store</span>
                  <span>Action</span>
                </div>
                {!excludeLoaded ? (
                  <p className="empty">Loading…</p>
                ) : excludedShops.length === 0 ? (
                  <div className="empty-state">
                    <p>No excluded stores yet</p>
                    <span>Add a myshopify domain above to keep it out of PostHog.</span>
                  </div>
                ) : (
                  <ul className="shop-list">
                    {excludedShops.map((domain) => (
                      <li key={domain}>
                        <code className="shop-domain">{domain}</code>
                        <button
                          type="button"
                          className="btn-ghost danger"
                          disabled={excludeBusy}
                          onClick={() => removeExcluded(domain)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ) : null}

          {page === "stats" ? (
            <div className="stats-page">
              <p className="stats-note">
                COD vs prepaid side by side — KPIs, countries, languages, templates
                (generated + published), and funnel.
                {statsData?.label ? (
                  <>
                    {" "}
                    Range: <strong>{statsData.label}</strong>
                    {statsData.days ? ` · ${statsData.days}d` : ""}.
                  </>
                ) : null}
              </p>
              {statsError ? <p className="error">{statsError}</p> : null}
              {!statsLoaded || statsBusy ? (
                <p className="empty">{statsBusy ? "Loading PostHog…" : "Loading…"}</p>
              ) : (
                <div className="markets-grid">
                  <MarketColumn title="COD" market="cod" data={statsData?.cod} />
                  <MarketColumn
                    title="Prepaid"
                    market="prepaid"
                    data={statsData?.prepaid}
                  />
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
