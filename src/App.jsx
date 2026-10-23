import { useState } from "react";

const API_URL = (import.meta.env.VITE_API_URL || "https://api.kluck.ai").replace(
  /\/$/,
  "",
);
const TOKEN_KEY = "kluck_support_token";

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || "");
  const [password, setPassword] = useState("");
  const [shop, setShop] = useState("");
  const [credits, setCredits] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

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

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setResult(null);
    setError("");
  }

  return (
    <main className="app">
      <section className="card">
        <h1>Grant credits</h1>
        <p className="sub">
          {token ? "Add credits to a shop wallet." : "Admin login"}
        </p>
        {error ? <p className="error">{error}</p> : null}
        {token && result ? (
          <p className="ok">
            Granted {result.granted} to {result.shop}. New balance{" "}
            {result.balance}.
          </p>
        ) : null}
        {token ? (
          <form onSubmit={grant}>
            <label>
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
            <button type="submit" disabled={busy}>
              {busy ? "Granting…" : "Grant credits"}
            </button>
            <button type="button" className="ghost" onClick={logout}>
              Log out
            </button>
          </form>
        ) : (
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
            <button type="submit" disabled={busy}>
              {busy ? "Checking…" : "Log in"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
