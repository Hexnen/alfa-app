import { useState } from "react";
import { useAuth } from "./AuthProvider";

export default function AuthScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await login(email.trim(), password);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <img src="/favicon-192.png" className="h-8 w-8 rounded" alt="" />
          <span className="text-2xl font-bold">Alfa Group</span>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">Login</span>
            <input
              type="text"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="np. moinen"
              autoComplete="username"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Hasło</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
              autoComplete="current-password"
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "…" : "Zaloguj się"}
          </button>
        </form>

        <p className="text-[11px] text-muted-foreground text-center mt-4">
          Konta zakłada administrator.
        </p>
      </div>
    </div>
  );
}
