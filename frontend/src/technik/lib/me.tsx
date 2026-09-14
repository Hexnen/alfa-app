import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { technikApi, type TechnikMe } from "@/lib/api";
import { useRefreshOnFocus } from "./refresh";
import { noteServerNow, readSeen } from "./seen";

/**
 * `GET /technik/me` POBIERANE RAZ, dla całego panelu.
 *
 * To samo zapytanie odpowiada na trzy pytania (kim jestem w kartotece, czy
 * mogę cokolwiek zapisać, ile mam roboty), a czytają je „Dziś”, „Więcej”
 * i bramka dostępu. Bez wspólnego kontekstu każdy z tych ekranów strzelałby
 * osobno przy każdym wejściu — na łączu w terenie to widać.
 */
interface MeCtxValue {
  me: TechnikMe | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const MeCtx = createContext<MeCtxValue | null>(null);

export function TechnikMeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<TechnikMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await technikApi.me(readSeen());
      noteServerNow(next.now);
      setMe(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się wczytać danych technika.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshOnFocus(() => void load());

  const value = useMemo<MeCtxValue>(
    () => ({ me, loading, error, reload: () => void load() }),
    [me, loading, error, load],
  );

  return <MeCtx.Provider value={value}>{children}</MeCtx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTechnikMe(): MeCtxValue {
  const c = useContext(MeCtx);
  if (!c) throw new Error("useTechnikMe poza TechnikMeProvider");
  return c;
}
