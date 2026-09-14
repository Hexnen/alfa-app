import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: string;
  /** Mapa uprawnień per podzakładka: { [tabKey]: 'view' | 'edit' }. Admin ma pełny dostęp. */
  permissions?: Record<string, "view" | "edit">;
  /**
   * Handlowiec ze słownika przypięty do tego konta (`salespeople.user_id`).
   * `null`/brak = konto bez własnego portfela — przełącznik „Moje / Wszyscy"
   * w sekcji Handlowy chowa się, a widoki startują na „Wszyscy".
   */
  salespersonId?: number | null;
  /**
   * Technik z kartoteki przypięty do tego konta (`technicians.user_id`).
   * `null`/brak = konto bez powiązania — panel `/technik` pokaże pustą listę
   * i podpowie, żeby administrator dopiął technika (autoryzacja zleceń idzie
   * po tym polu, nigdy po zgodności nazwiska).
   */
  technicianId?: number | null;
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  /**
   * `true` = nie wiemy, kim jest użytkownik, bo `/api/auth/me` w ogóle nie
   * doszło (brak sieci, padł backend). To NIE jest „wylogowany”: sesja może być
   * najzupełniej ważna, a ekran logowania w tej sytuacji tylko wprowadza
   * w błąd — technik przy kliencie zobaczyłby „zaloguj się”, choć jest
   * zalogowany, i wpisywał hasło w nieskończoność. 401 dalej znaczy wylogowanie.
   */
  offline: boolean;
  /** Zwraca komunikat błędu albo null przy sukcesie. */
  login: (email: string, password: string) => Promise<string | null>;
  register: (email: string, password: string, displayName: string) => Promise<string | null>;
  logout: () => Promise<void>;
  /** Ponawia `/api/auth/me` — przycisk „Spróbuj ponownie” na ekranie braku połączenia. */
  retry: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth poza AuthProvider");
  return c;
}

interface AuthResponse {
  user?: AuthUser;
  error?: string;
}

/** Jedyny komunikat, jaki ma sens, gdy żądanie nie doszło do serwera. */
export const OFFLINE_MESSAGE = "Brak połączenia z internetem — spróbuj ponownie.";

/**
 * POST na API, który NIGDY nie rzuca. `fetch` odrzuca obietnicę przy braku
 * sieci, a wołający (`login`) nie miał tego jak obsłużyć — przycisk zostawał
 * na „Logowanie…” do końca świata. Teraz odrzucenie wraca jako zwykła
 * odpowiedź z `offline: true` i polskim zdaniem w `error`.
 */
async function postJson(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; offline: boolean; data: AuthResponse }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, offline: true, data: { error: OFFLINE_MESSAGE } };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, offline: false, data };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  /** Zmiana licznika = ponowne pytanie o `/api/auth/me` (przycisk „Spróbuj ponownie”). */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/auth/me");
        // Odpowiedź PRZYSZŁA — serwer wie, kim jesteśmy (albo że nikim).
        // 401 to prawdziwe wylogowanie i wtedy `user` musi zejść do `null`.
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setUser((data as { user?: AuthUser }).user ?? null);
        setOffline(false);
      } catch {
        // Żądanie NIE doszło. Zerowanie usera zrobiłoby z braku zasięgu
        // wylogowanie; zamiast tego panel pokaże ekran „Brak połączenia”.
        if (!cancelled) setOffline(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const login = useCallback(async (email: string, password: string) => {
    const { ok, data } = await postJson("/api/auth/login", { email, password });
    if (!ok) return data.error || "Nie udało się zalogować.";
    setUser(data.user ?? null);
    setOffline(false);
    return null;
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      const { ok, data } = await postJson("/api/auth/register", { email, password, displayName });
      if (!ok) return data.error || "Nie udało się zarejestrować.";
      setUser(data.user ?? null);
      setOffline(false);
      return null;
    },
    [],
  );

  const logout = useCallback(async () => {
    await postJson("/api/auth/logout", {}).catch(() => {});
    setUser(null);
    // Twardy reset stanu apki po wylogowaniu.
    window.location.reload();
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, offline, login, register, logout, retry }}>
      {children}
    </Ctx.Provider>
  );
}
