import { FormEvent, useState } from "react";
import { api, useSession } from "../state/session";

interface AuthResponse {
  token: string;
  username: string;
}

export function Login() {
  const setAuth = useSession((s) => s.setAuth);
  const enterAssetLab = useSession((s) => s.enterAssetLab);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<AuthResponse>(`/api/${mode}`, {
        method: "POST",
        body: { username, password },
      });
      setAuth(res.token, res.username);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function devLogin() {
    setBusy(true);
    setError("");
    try {
      const res = await api<AuthResponse>("/dev/login", { method: "POST" });
      setAuth(res.token, res.username);
    } catch (e) {
      setError(`dev login failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <form className="panel" onSubmit={submit}>
        <h1 className="logo">WILDER</h1>
        <p className="tagline">breach the city. extract alive.</p>
        <input
          className="field"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          className="field"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="error">{error}</div>
        <button className="btn btn-primary" disabled={busy} type="submit">
          {mode === "login" ? "LOG IN" : "CREATE ACCOUNT"}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Need an account? Register" : "Have an account? Log in"}
        </button>
        {import.meta.env.DEV && (
          <>
            <button className="btn btn-dev" type="button" disabled={busy} onClick={devLogin}>
              ⚡ DEV LOGIN
            </button>
            <button className="btn btn-ghost" type="button" onClick={enterAssetLab}>
              🔧 ASSET LAB
            </button>
          </>
        )}
      </form>
    </div>
  );
}
