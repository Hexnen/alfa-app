import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { HardHat } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * EKRAN LOGOWANIA DO PANELU TECHNIKA.
 *
 * Karta stoi U GÓRY (`pt-[8dvh]`), a nie na środku: przy otwartej klawiaturze
 * na tablecie wyśrodkowany formularz wyjeżdża poza widok. Pola mają 16 px
 * (inaczej iOS zoomuje stronę), komplet `autocomplete` i `enterKeyHint="go"`,
 * żeby pęk kluczy podstawił hasło bez walki. Wartości nie są przetwarzane
 * w trakcie pisania — dopiero `trim()` przy wysyłce.
 *
 * To te same konta co w CRM, więc na dole jest droga powrotna na `/`.
 */
export function TechnikAuthScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // `login` nie rzuca (brak sieci wraca jako komunikat), ale `finally` stoi
    // tu jako bezpiecznik: przycisk „Logowanie…” zablokowany na zawsze to
    // najgorsze, co może spotkać technika w bramie z jedną kreską zasięgu.
    try {
      const err = await login(email.trim(), password);
      if (err) setError(err);
    } catch {
      setError("Nie udało się zalogować. Spróbuj ponownie.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-background px-4 pt-[8dvh]">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <HardHat className="h-8 w-8 text-primary" aria-hidden />
          <span className="text-2xl font-semibold tracking-tight">Panel technika</span>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border bg-card p-5 shadow-sm"
          aria-describedby={error ? "technik-auth-error" : undefined}
        >
          <div className="space-y-1.5">
            <Label htmlFor="technik-login">Login</Label>
            <Input
              id="technik-login"
              type="text"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              placeholder="np. jkowalski"
              className="h-11 text-base"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="technik-password">Hasło</Label>
            <Input
              id="technik-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              enterKeyHint="go"
              className="h-11 text-base"
            />
          </div>

          {error && (
            <p id="technik-auth-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={busy}>
            {busy ? "Logowanie…" : "Zaloguj się"}
          </Button>
        </form>

        <Link
          to="/"
          className="mt-4 flex min-h-11 w-full items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Logowanie do CRM
        </Link>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Konta zakłada administrator.
        </p>
      </div>
    </div>
  );
}

export default TechnikAuthScreen;
