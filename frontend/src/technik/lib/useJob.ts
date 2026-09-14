import { useCallback, useEffect, useState } from "react";
import { technikApi, type TechnikJobDetails } from "@/lib/api";
import { useRefreshOnFocus } from "./refresh";

/**
 * Szczegóły jednego zlecenia. Cudze zlecenie backend zwraca jako 404 — tu
 * wychodzi to jako `notFound`, żeby ekran mógł powiedzieć „nie ma takiego
 * zlecenia” zamiast pokazywać surowy błąd sieci.
 *
 * Zlecenie ODWOŁANE przez biuro wraca normalnym 200 ze `status: "cancelled"` —
 * to nie jest błąd i nie ma prawa wyglądać jak brak dostępu. Ekran zlecenia
 * pokazuje je z pigułką „Odwołane” i bez akcji.
 */
export interface JobState {
  job: TechnikJobDetails | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  reload: () => void;
  /** Podmiana lokalna po akcji (start/finish) — bez dodatkowego zapytania. */
  patch: (next: Partial<TechnikJobDetails>) => void;
}

export function useJob(id: number | null): JobState {
  const [job, setJob] = useState<TechnikJobDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (id === null || Number.isNaN(id)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await technikApi.job(id);
      setJob(data);
      setError(null);
      setNotFound(false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) {
        setNotFound(true);
      } else {
        // Błąd sieci PO wcześniejszym 404 zostawiał na ekranie „zlecenie nie
        // jest już przypisane” bez żadnego sposobu na ponowienie — a to zwykle
        // nie była prawda, tylko brak zasięgu. Każda nieudana próba inna niż
        // 404 zdejmuje ten stan i pokazuje „Spróbuj ponownie”.
        setNotFound(false);
        setError(e instanceof Error ? e.message : "Nie udało się wczytać zlecenia.");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshOnFocus(() => void load());

  const patch = useCallback((next: Partial<TechnikJobDetails>) => {
    setJob((prev) => (prev ? { ...prev, ...next } : prev));
  }, []);

  return { job, loading, error, notFound, reload: () => void load(), patch };
}
