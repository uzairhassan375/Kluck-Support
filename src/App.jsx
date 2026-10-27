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
    label: "🎀 Grant credits",
    hint: "Wallet top-ups",
  },
  {
    id: "promos",
    label: "Promo codes",
    hint: "Double or bonus credits",
  },
  {
    id: "posthog",
    label: "PostHog excluded stores",
    hint: "No events or replay",
  },
  {
    id: "stats-new",
    label: "Market flow stats — new",
    hint: "Installed in selected period",
  },
  {
    id: "stats-old",
    label: "Market flow stats — old",
    hint: "Installed earlier, active now",
  },
];

function isStatsPage(id) {
  return id === "stats-new" || id === "stats-old" || id === "stats";
}

function statsCohortFromPage(id) {
  return id === "stats-old" ? "old" : "new";
}

const FLOW_CHOICE_CARDS = [
  { key: "product_flow", label: "Product" },
  { key: "store_flow", label: "Store" },
];

const REVENUE_KPI_CARDS = [
  { key: "checkout_started", label: "Checkout started" },
  { key: "paid", label: "Paid users" },
];

const OUTPUT_TABS = [
  { id: "pdp", label: "PDP" },
  { id: "single", label: "Single store" },
  { id: "multi", label: "Multi store" },
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

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function publishRate(generated, published) {
  const g = Number(generated) || 0;
  const p = Number(published) || 0;
  // Publish can land on a different day than generate — rate only when both are in range.
  if (!g) return p ? "n/a" : "0%";
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
    if (raw === "stats") return "stats-new";
    if (
      raw === "credits" ||
      raw === "promos" ||
      raw === "posthog" ||
      raw === "stats-new" ||
      raw === "stats-old"
    ) {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "credits";
}

function ShareList({ market, sectionKey, empty, items, missing, kind }) {
  const rows = Array.isArray(items) ? items : [];
  const knownTotal = rows.reduce((sum, r) => sum + (r.count || 0), 0);
  const max = Math.max(1, ...rows.map((r) => r.count || 0));
  const missingCount = Number(missing) || 0;

  return (
    <div className="compare-panel-body">
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

function TemplateTable({
  market,
  empty,
  items,
  nameHeader = "Template",
  nested = false,
}) {
  const rows = Array.isArray(items) ? items : [];
  const maxGen = Math.max(1, ...rows.map((r) => r.generated || 0));

  return (
    <div className={nested ? "template-table-nested" : "compare-panel-body"}>
      {rows.length === 0 ? (
        <p className="breakdown-empty">{empty}</p>
      ) : (
        <div className="template-table">
          <div className="template-table-head">
            <span>{nameHeader}</span>
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

function OutputFlowBlock({
  market,
  generated,
  published,
  categories,
  templates,
  catEmpty,
  tplEmpty,
}) {
  const gen = Number(generated) || 0;
  const pub = Number(published) || 0;
  const publishOnly = pub > 0 && gen === 0;

  return (
    <div className="output-flow-panel">
      <div className="kpi-grid kpi-grid-2 output-flow-counts">
        <div className="kpi-card kpi-card-green">
          <span className="kpi-label">Generated</span>
          <span className="kpi-value">{formatInt(generated)}</span>
          <span className="kpi-sub">unique shops</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Published</span>
          <span className="kpi-value">{formatInt(published)}</span>
          <span className="kpi-sub">
            {publishOnly
              ? "generate event missing"
              : `${publishRate(generated, published)} publish rate`}
          </span>
        </div>
      </div>
      <p className="stats-section-hint output-flow-hint">
        {publishOnly
          ? "Same-day new shops: publish is logged on the server, but store_generated didn’t arrive from the browser (or lacked market_type) — not a later-day publish."
          : "Same shops in this range — niche they sell in vs design theme they picked."}
      </p>
      <div className="output-split-grid">
        <div className="output-split-card output-split-category">
          <div className="output-split-head">
            <span className="output-split-eyebrow">Niche</span>
            <h3 className="output-split-title">Categories</h3>
            <p className="output-split-desc">
              What they sell — Fashion, Kids Toys, Home & Kitchen…
            </p>
          </div>
          <TemplateTable
            market={`${market}-cat`}
            empty={catEmpty}
            items={categories}
            nameHeader="Category"
            nested
          />
        </div>
        <div className="output-split-card output-split-template">
          <div className="output-split-head">
            <span className="output-split-eyebrow">Design</span>
            <h3 className="output-split-title">Templates</h3>
            <p className="output-split-desc">
              Layout theme — Sleek, Vibe, Collective, Glow…
            </p>
          </div>
          <TemplateTable
            market={`${market}-tpl`}
            empty={tplEmpty}
            items={templates}
            nameHeader="Template"
            nested
          />
        </div>
      </div>
    </div>
  );
}

function RevenueAboveMarkets({ cod, prepaid, label }) {
  const codRev = Number(cod?.stats?.revenue) || 0;
  const prepaidRev = Number(prepaid?.stats?.revenue) || 0;
  const total = codRev + prepaidRev;
  return (
    <section className="revenue-above" aria-label="Revenue by market">
      <div className="revenue-above-head">
        <h3>Revenue</h3>
        <p className="stats-section-hint">
          Combined {formatMoney(total)}
          {label ? ` · ${label}` : ""}
        </p>
      </div>
      <div className="revenue-above-grid">
        <div className="revenue-above-card market-col-cod">
          <span className="highlight-label">COD</span>
          <strong>{formatMoney(codRev)}</strong>
        </div>
        <div className="revenue-above-card market-col-prepaid">
          <span className="highlight-label">Prepaid</span>
          <strong>{formatMoney(prepaidRev)}</strong>
        </div>
      </div>
    </section>
  );
}

function PaidPacksList({ market, items, empty }) {
  const rows = Array.isArray(items) ? items : [];
  const max = Math.max(1, ...rows.map((r) => r.count || 0));
  if (rows.length === 0) {
    return <p className="breakdown-empty">{empty}</p>;
  }
  return (
    <ul className="share-list">
      {rows.map((row) => (
        <li key={`${market}-pack-${row.name}`}>
          <div className="share-row share-row-pack">
            <span className="share-flag" aria-hidden>
              💳
            </span>
            <span className="share-name" title={row.name}>
              {row.name}
            </span>
            <span className="share-pct">{formatInt(row.count)}</span>
            <span className="share-count">{formatMoney(row.revenue)}</span>
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
      ))}
    </ul>
  );
}

function Step1MarketPrefs({ market, data }) {
  const stats = data?.stats || {};
  return (
    <div className="compare-panel-body">
      <p className="kpi-step-badge">Step 1</p>
      <div className="kpi-group">
        <h3 className="kpi-group-title">Saved market prefs</h3>
        <div className="kpi-grid">
          <div className="kpi-card kpi-card-green">
            <span className="kpi-label">Users who saved prefs</span>
            <span className="kpi-value">{formatInt(stats.market_prefs)}</span>
          </div>
        </div>
      </div>

      <div className="kpi-group">
        <h3 className="kpi-group-title">Target audience</h3>
        <p className="stats-section-hint">
          Same people as the green count — one country each
        </p>
        <ShareList
          market={market}
          sectionKey="countries"
          empty="No country data"
          items={data?.countries}
          missing={data?.countries_missing}
          kind="country"
        />
      </div>

      <div className="kpi-group">
        <h3 className="kpi-group-title">Store language</h3>
        <p className="stats-section-hint">
          Same people as the green count — one language each
        </p>
        <ShareList
          market={market}
          sectionKey="languages"
          empty="No language data"
          items={data?.languages}
          missing={data?.languages_missing}
          kind="language"
        />
      </div>
    </div>
  );
}

function Step2ChoseFlow({ market, data }) {
  const stats = data?.stats || {};
  return (
    <div className="compare-panel-body">
      <p className="kpi-step-badge">Step 2</p>
      <div className="kpi-group">
        <h3 className="kpi-group-title">Chose flow</h3>
        <p className="stats-section-hint">
          Unique users who continued to Product or Store
        </p>
        <div className="kpi-grid">
          {FLOW_CHOICE_CARDS.map((card) => (
            <div key={`${market}-${card.key}`} className="kpi-card">
              <span className="kpi-label">{card.label}</span>
              <span className="kpi-value">{formatInt(stats[card.key])}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Step3GeneratePublish({ market, data, outputTab = "pdp" }) {
  const stats = data?.stats || {};
  const tab = OUTPUT_TABS.some((t) => t.id === outputTab) ? outputTab : "pdp";

  let flow = null;
  if (tab === "single") {
    flow = (
      <OutputFlowBlock
        market={`${market}-single`}
        generated={stats.store_generated_single}
        published={stats.store_published_single}
        categories={data?.store_categories_single}
        templates={data?.store_templates_single}
        catEmpty="No single-store categories"
        tplEmpty="No single-store templates"
      />
    );
  } else if (tab === "multi") {
    flow = (
      <OutputFlowBlock
        market={`${market}-multi`}
        generated={stats.store_generated_multi}
        published={stats.store_published_multi}
        categories={data?.store_categories_multi}
        templates={data?.store_templates_multi}
        catEmpty="No multi-store categories"
        tplEmpty="No multi-store templates"
      />
    );
  } else {
    flow = (
      <OutputFlowBlock
        market={`${market}-pdp`}
        generated={stats.pdp_generated}
        published={stats.pdp_published}
        categories={data?.pdp_categories}
        templates={data?.pdp_templates}
        catEmpty="No PDP categories"
        tplEmpty="No PDP templates"
      />
    );
  }

  return (
    <div className="compare-panel-body">
      <p className="kpi-step-badge">Step 3</p>
      {flow}
    </div>
  );
}

function MarketRevenueKpis({ market, data }) {
  const stats = data?.stats || {};
  return (
    <div className="compare-panel-body">
      <div className="kpi-grid kpi-grid-revenue">
        {REVENUE_KPI_CARDS.map((card) => (
          <div
            key={`${market}-${card.key}`}
            className="kpi-card kpi-card-accent"
          >
            <span className="kpi-label">{card.label}</span>
            <span className="kpi-value">{formatInt(stats[card.key])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompareRow({ title, hint, cod, prepaid, tabs, activeTab, onTabChange }) {
  return (
    <section className="compare-row">
      <div className="compare-row-head">
        <h3>{title}</h3>
        {hint ? <p className="stats-section-hint">{hint}</p> : null}
        {Array.isArray(tabs) && tabs.length > 0 ? (
          <div className="step-tabs" role="tablist" aria-label={title}>
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={selected ? "step-tab active" : "step-tab"}
                  onClick={() => onTabChange?.(tab.id)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="compare-row-grid">
        <div className="compare-panel compare-panel-cod">{cod}</div>
        <div className="compare-panel compare-panel-prepaid">{prepaid}</div>
      </div>
    </section>
  );
}

function InstallsStrip({ data, label, cohort }) {
  const installs = data?.installs;
  const uninstalls = data?.uninstalls;
  const net = data?.net;
  const netValue = Number(net);
  const netClass =
    Number.isFinite(netValue) && netValue < 0
      ? "installs-net negative"
      : Number.isFinite(netValue) && netValue > 0
        ? "installs-net positive"
        : "installs-net";
  const netText = `${Number.isFinite(netValue) && netValue > 0 ? "+" : ""}${formatInt(net)}`;
  return (
    <section className="installs-strip" aria-label="Installs and uninstalls">
      <div className="installs-strip-head">
        <h3>App installs</h3>
        <p className="stats-section-hint">
          {cohort === "old"
            ? "Earlier installs only (new installs excluded)"
            : "New installs in this period"}
          {label ? ` · ${label}` : ""}
        </p>
      </div>
      <div className="installs-metrics-row">
        <div className="installs-metric">
          <span className="highlight-label">Installs</span>
          <strong>{formatInt(installs)}</strong>
        </div>
        <div className="installs-metric">
          <span className="highlight-label">Uninstalls</span>
          <strong>{formatInt(uninstalls)}</strong>
        </div>
        <div className="installs-metric installs-metric-net">
          <span className="highlight-label">Net</span>
          <strong className={netClass}>{netText}</strong>
        </div>
      </div>
    </section>
  );
}

function MarketsCompare({ cod, prepaid, installs, label, cohort }) {
  const [outputTab, setOutputTab] = useState("pdp");

  return (
    <div className="markets-compare">
      <InstallsStrip data={installs} label={label} cohort={cohort} />

      <RevenueAboveMarkets cod={cod} prepaid={prepaid} label={label} />

      <div className="compare-markets-head">
        <div className="market-head-card market-col-cod">
          <p className="market-eyebrow">Cash on delivery</p>
          <div className="market-col-head">
            <h2>COD</h2>
            {cod?.dashboard_url ? (
              <a
                className="market-link"
                href={cod.dashboard_url}
                target="_blank"
                rel="noreferrer"
              >
                PostHog ↗
              </a>
            ) : null}
          </div>
        </div>
        <div className="market-head-card market-col-prepaid">
          <p className="market-eyebrow">Prepaid / online pay</p>
          <div className="market-col-head">
            <h2>Prepaid</h2>
            {prepaid?.dashboard_url ? (
              <a
                className="market-link"
                href={prepaid.dashboard_url}
                target="_blank"
                rel="noreferrer"
              >
                PostHog ↗
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <CompareRow
        title="Step 1 · Market prefs"
        hint="Saved prefs, target audience, and store language"
        cod={<Step1MarketPrefs market="cod" data={cod} />}
        prepaid={<Step1MarketPrefs market="prepaid" data={prepaid} />}
      />

      <CompareRow
        title="Step 2 · Chose flow"
        hint="Product vs Store — unique users who continued after prefs"
        cod={<Step2ChoseFlow market="cod" data={cod} />}
        prepaid={<Step2ChoseFlow market="prepaid" data={prepaid} />}
      />

      <CompareRow
        title="Step 3 · Generate & publish"
        hint="Unique users who generated — then the category & template each one used"
        tabs={OUTPUT_TABS}
        activeTab={outputTab}
        onTabChange={setOutputTab}
        cod={
          <Step3GeneratePublish
            market="cod"
            data={cod}
            outputTab={outputTab}
          />
        }
        prepaid={
          <Step3GeneratePublish
            market="prepaid"
            data={prepaid}
            outputTab={outputTab}
          />
        }
      />

      <CompareRow
        title="Checkout & paid"
        hint="Unique users who started checkout or paid in this range"
        cod={<MarketRevenueKpis market="cod" data={cod} />}
        prepaid={<MarketRevenueKpis market="prepaid" data={prepaid} />}
      />

      <CompareRow
        title="Paid plans"
        hint="Starter · Value · Growth — purchases and revenue in this range"
        cod={
          <PaidPacksList
            market="cod"
            empty="No pack purchases"
            items={cod?.paid_packs}
          />
        }
        prepaid={
          <PaidPacksList
            market="prepaid"
            empty="No pack purchases"
            items={prepaid?.paid_packs}
          />
        }
      />

      <CompareRow
        title="Paid by country"
        hint="Where credit-pack buyers came from (market prefs country)"
        cod={
          <ShareList
            market="cod"
            sectionKey="paid_countries"
            empty="No paid-by-country data yet"
            items={cod?.paid_countries}
            missing={cod?.paid_countries_missing}
            kind="country"
          />
        }
        prepaid={
          <ShareList
            market="prepaid"
            sectionKey="paid_countries"
            empty="No paid-by-country data yet"
            items={prepaid?.paid_countries}
            missing={prepaid?.paid_countries_missing}
            kind="country"
          />
        }
      />
    </div>
  );
}

function IconCredits() {
  // Gift bow — grant credits
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="4"
        y="10"
        width="16"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 10v10M4 14h16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 10c-1.8-3.2-5.2-3.5-5.2-1.4C6.8 10.2 9.2 10.8 12 10c2.8.8 5.2.2 5.2-1.4 0-2.1-3.4-1.8-5.2 1.4Z"
        stroke="currentColor"
        strokeWidth="1.75"
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

function IconPromos() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 9.5 9.5 4h5L20 9.5v5L14.5 20h-5L4 14.5v-5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="9.5" r="1.25" fill="currentColor" />
      <path
        d="m10.5 13.5 3-3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

const ICONS = {
  credits: IconCredits,
  promos: IconPromos,
  posthog: IconPosthog,
  "stats-new": IconStats,
  "stats-old": IconStats,
  stats: IconStats,
};

function promoTypeLabel(type) {
  if (type === "bonus_credits") return "Extra credits";
  if (type === "multiplier") return "Multiplier";
  return type || "—";
}

function promoEffectLabel(promo) {
  if (!promo) return "—";
  if (promo.type === "bonus_credits") {
    return `+${Number(promo.bonus_credits) || 0} credits on redeem`;
  }
  const mult = Number(promo.multiplier) || 2;
  return `${mult}× next pack purchase`;
}

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

  const [promos, setPromos] = useState([]);
  const [promosLoaded, setPromosLoaded] = useState(false);
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState("");
  const [promoOk, setPromoOk] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [promoType, setPromoType] = useState("multiplier");
  const [promoMultiplier, setPromoMultiplier] = useState("2");
  const [promoBonus, setPromoBonus] = useState("");
  const [promoDescription, setPromoDescription] = useState("");

  const [statsPreset, setStatsPreset] = useState("today");
  const [statsCustomFrom, setStatsCustomFrom] = useState(() => daysAgoIso(7));
  const [statsCustomTo, setStatsCustomTo] = useState(() => todayIso());
  const [statsRangeKey, setStatsRangeKey] = useState("today");
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

  const loadPromos = useCallback(async (authToken) => {
    const data = await readJson(
      await fetch(`${API_URL}/api/support/promos`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
    );
    setPromos(Array.isArray(data.promos) ? data.promos : []);
    setPromosLoaded(true);
  }, []);

  useEffect(() => {
    if (!token) {
      setExcludedShops([]);
      setExcludeLoaded(false);
      setPromos([]);
      setPromosLoaded(false);
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

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        await loadPromos(token);
      } catch (err) {
        if (cancelled) return;
        if (err.message === "Login required") {
          sessionStorage.removeItem(TOKEN_KEY);
          setToken("");
        } else {
          setPromoError(err.message);
          setPromosLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, loadPromos]);

  const loadStats = useCallback(async (authToken, rangeKey, cohort) => {
    setStatsBusy(true);
    setStatsError("");
    try {
      const params = new URLSearchParams();
      params.set("cohort", cohort === "old" ? "old" : "new");
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
          ? "Stats auth failed. On localhost set SUPPORT_ADMIN_TOKEN_SECRET in .env to the same value that signs your login token (must match api.kluck.ai)."
          : /throttl|rate.?limit|too many requests/i.test(err.message || "")
            ? "PostHog is rate-limiting right now. Wait ~30s and hit Refresh — Support paces queries automatically."
            : /Unexpected token|is not valid JSON|Failed to fetch/i.test(
                  err.message || "",
                )
              ? "Stats API is not running. Restart npm run dev (Vite now serves /api/posthog-market-stats locally)."
              : err.message;
      setStatsError(message);
      setStatsLoaded(true);
    } finally {
      setStatsBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!token || !isStatsPage(page)) return;
    setStatsLoaded(false);
    setStatsData(null);
    void loadStats(token, statsRangeKey, statsCohortFromPage(page));
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

  async function addPromo(event) {
    event.preventDefault();
    setPromoBusy(true);
    setPromoError("");
    setPromoOk("");
    try {
      const body = {
        code: promoCode,
        type: promoType,
        description: promoDescription,
      };
      if (promoType === "multiplier") {
        body.multiplier = Number(promoMultiplier) || 2;
      } else {
        body.bonus_credits = Number(promoBonus);
      }
      const data = await readJson(
        await fetch(`${API_URL}/api/support/promos`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }),
      );
      await loadPromos(token);
      setPromoCode("");
      setPromoDescription("");
      setPromoBonus("");
      setPromoMultiplier("2");
      setPromoOk(`Saved ${data.promo?.code || body.code}`);
    } catch (err) {
      if (err.message === "Login required") {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
      }
      setPromoError(err.message);
    } finally {
      setPromoBusy(false);
    }
  }

  async function removePromo(code) {
    setPromoBusy(true);
    setPromoError("");
    setPromoOk("");
    try {
      await readJson(
        await fetch(`${API_URL}/api/support/promos`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ code }),
        }),
      );
      await loadPromos(token);
      setPromoOk(`Removed ${code}`);
    } catch (err) {
      if (err.message === "Login required") {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
      }
      setPromoError(err.message);
    } finally {
      setPromoBusy(false);
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
    setPromos([]);
    setPromosLoaded(false);
    setPromoError("");
    setPromoOk("");
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
            Sign in to grant credits, manage promo codes, PostHog exclusions, and market flow stats.
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
          {isStatsPage(page) ? (
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
                <button
                  type="button"
                  className="date-pill date-pill-refresh"
                  disabled={statsBusy || !token}
                  onClick={() =>
                    void loadStats(token, statsRangeKey, statsCohortFromPage(page))
                  }
                  aria-label="Refresh PostHog stats"
                  title="Refresh from PostHog"
                >
                  {statsBusy ? "Refreshing…" : "Refresh"}
                </button>
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

        <div className={isStatsPage(page) ? "content content-wide" : "content"}>
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

          {page === "promos" ? (
            <section className="panel">
              <div className="panel-head">
                <h2>Promo codes</h2>
                <p>
                  Multiplier codes double (or more) the next credit pack.
                  Extra-credit codes grant credits as soon as a merchant redeems
                  them.
                </p>
              </div>
              {promoError ? <p className="error">{promoError}</p> : null}
              {promoOk ? <p className="ok">{promoOk}</p> : null}
              <form className="panel-form" onSubmit={addPromo}>
                <label>
                  Code
                  <input
                    value={promoCode}
                    onChange={(event) => setPromoCode(event.target.value)}
                    placeholder="KLUCK2X"
                    autoComplete="off"
                    required
                  />
                </label>
                <label>
                  Type
                  <select
                    value={promoType}
                    onChange={(event) => setPromoType(event.target.value)}
                  >
                    <option value="multiplier">Double / multiplier credits</option>
                    <option value="bonus_credits">Extra credits on redeem</option>
                  </select>
                </label>
                {promoType === "multiplier" ? (
                  <label>
                    Multiplier
                    <input
                      value={promoMultiplier}
                      onChange={(event) => setPromoMultiplier(event.target.value)}
                      inputMode="numeric"
                      placeholder="2"
                      required
                    />
                  </label>
                ) : (
                  <label>
                    Bonus credits
                    <input
                      value={promoBonus}
                      onChange={(event) => setPromoBonus(event.target.value)}
                      inputMode="numeric"
                      placeholder="200"
                      required
                    />
                  </label>
                )}
                <label className="full">
                  Description
                  <input
                    value={promoDescription}
                    onChange={(event) => setPromoDescription(event.target.value)}
                    placeholder="Shown to merchants when they apply the code"
                  />
                </label>
                <button type="submit" className="btn-primary full" disabled={promoBusy}>
                  {promoBusy ? "Saving…" : "Add promo code"}
                </button>
              </form>

              <div className="list-block">
                <div className="list-head list-head-promo">
                  <span>Code</span>
                  <span>Effect</span>
                  <span>Action</span>
                </div>
                {!promosLoaded ? (
                  <p className="empty">Loading…</p>
                ) : promos.length === 0 ? (
                  <div className="empty-state">
                    <p>No promo codes yet</p>
                    <span>Add a multiplier or bonus code above.</span>
                  </div>
                ) : (
                  <ul className="shop-list promo-list">
                    {promos.map((promo) => (
                      <li key={promo.code}>
                        <div className="promo-meta">
                          <code className="shop-domain">{promo.code}</code>
                          <span className="promo-type">
                            {promoTypeLabel(promo.type)}
                          </span>
                          <span className="promo-effect">
                            {promoEffectLabel(promo)}
                          </span>
                          {promo.description ? (
                            <span className="promo-desc">{promo.description}</span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="btn-ghost danger"
                          disabled={promoBusy}
                          onClick={() => removePromo(promo.code)}
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

          {isStatsPage(page) ? (
            <div className={`stats-page${statsBusy && statsLoaded ? " stats-page-refreshing" : ""}`}>
              {statsError ? <p className="error">{statsError}</p> : null}
              {!statsLoaded ? (
                <p className="empty">
                  {statsBusy ? "Loading PostHog…" : "Loading…"}
                </p>
              ) : (
                <MarketsCompare
                  cod={statsData?.cod}
                  prepaid={statsData?.prepaid}
                  installs={statsData?.installs}
                  label={statsData?.label}
                  cohort={statsData?.cohort || statsCohortFromPage(page)}
                />
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
