import { useState } from "react";
import { useAuth } from "./AuthProvider";

export default function AuthScreen() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err =
      mode === "login"
        ? await login(email.trim(), password)
        : await register(email.trim(), password, displayName.trim());
    setBusy(false);
    if (err) setError(err);
  };

  const swap = (m: "login" | "register") => {
    setMode(m);
    setError(null);
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <img src="/favicon-192.png" className="h-8 w-8 rounded" alt="" />
          <span className="text-2xl font-bold">Alfa Group</span>
        </div>

        <div className="flex rounded-md border p-0.5 mb-4 text-sm">
          <button
            type="button"
            onClick={() => swap("login")}
            className={`flex-1 rounded py-1.5 transition-colors ${
              mode === "login" ? "bg-accent font-semibold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Logowanie
          </button>
          <button
            type="button"
            onClick={() => swap("register")}
            className={`flex-1 rounded py-1.5 transition-colors ${
              mode === "register" ? "bg-accent font-semibold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Rejestracja
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <label className="block text-sm">
              <span className="text-muted-foreground">Nazwa (widoczna)</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="np. Mikołaj"
              />
            </label>
          )}
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
              minLength={mode === "register" ? 6 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder={mode === "register" ? "min. 6 znaków" : ""}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "…" : mode === "login" ? "Zaloguj się" : "Utwórz konto"}
          </button>
        </form>

        <p className="text-[11px] text-muted-foreground text-center mt-4">
          {mode === "login" ? "Nie masz konta? Wybierz „Rejestracja”." : "Rejestracja jest otwarta."}
        </p>
      </div>
    </div>
  );
}
