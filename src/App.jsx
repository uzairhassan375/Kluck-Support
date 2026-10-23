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
];

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
    if (raw === "credits" || raw === "posthog") return raw;
  } catch {
    /* ignore */
  }
  return "credits";
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

const ICONS = {
  credits: IconCredits,
  posthog: IconPosthog,
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
            Sign in to grant credits and manage PostHog exclusions.
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
        </header>

        <div className="content">
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
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
