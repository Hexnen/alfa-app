import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: string;
  /** Mapa uprawnień per podzakładka: { [tabKey]: 'view' | 'edit' }. Admin ma pełny dostęp. */
  permissions?: Record<string, "view" | "edit">;
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  /** Zwraca komunikat błędu albo null przy sukcesie. */
  login: (email: string, password: string) => Promise<string | null>;
  register: (email: string, password: string, displayName: string) => Promise<string | null>;
  logout: () => Promise<void>;
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

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; data: AuthResponse }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setUser(d.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { ok, data } = await postJson("/api/auth/login", { email, password });
    if (!ok) return data.error || "Nie udało się zalogować.";
    setUser(data.user ?? null);
    return null;
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      const { ok, data } = await postJson("/api/auth/register", { email, password, displayName });
      if (!ok) return data.error || "Nie udało się zarejestrować.";
      setUser(data.user ?? null);
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

  return <Ctx.Provider value={{ user, loading, login, register, logout }}>{children}</Ctx.Provider>;
}
