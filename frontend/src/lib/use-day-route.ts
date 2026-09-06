/**
 * Pobranie surowców planera trasy (punkty + macierz odległości dnia).
 *
 * Backend odpowiada natychmiast z cache'u, a brakujące trasy dolicza w tle, więc przy
 * `pending: true` dopytujemy — tak samo jak `useTravel` w @/lib/travel. Bez tego pierwsze
 * wejście na dzień pokazywałoby linie proste aż do ręcznego odświeżenia.
 *
 * `loading` jest WYLICZANE, a nie trzymane w stanie: dopóki pobrany plan nie dotyczy
 * pytanej daty, widok wie, że czeka. Dzięki temu efekt nie ustawia stanu synchronicznie
 * i nie wywołuje kaskady renderów.
 */
import { useCallback, useEffect, useState } from "react";
import { calendarApi, type DayRoute } from "@/lib/api";

export interface UseDayRouteResult {
  route: DayRoute | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useDayRoute(date: string, eventIds: number[]): UseDayRouteResult {
  const [state, setState] = useState<{ date: string; route: DayRoute | null; error: string | null; settled: boolean } | null>(
    null
  );
  const [nonce, setNonce] = useState(0);

  // Tablica id zmienia tożsamość przy każdym renderze, więc efekt zależy od jej TREŚCI,
  // a listę odtwarzamy z tego samego klucza — inaczej zapytanie leciałoby w kółko.
  const idsKey = eventIds.join(",");

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const ask = async (attempt: number) => {
      try {
        const res = await calendarApi.getDayRoute(date, idsKey ? idsKey.split(",").map(Number) : []);
        if (cancelled) return;
        if (!res.success || !res.data) {
          setState({ date, route: null, error: res.error ?? "Nie udało się policzyć trasy dnia", settled: true });
          return;
        }
        const retry = res.data.pending && attempt < 2;
        setState({ date, route: res.data, error: null, settled: !retry });
        if (retry) timers.push(setTimeout(() => void ask(attempt + 1), attempt === 0 ? 3000 : 5000));
      } catch (err) {
        if (cancelled) return;
        setState({
          date,
          route: null,
          error: err instanceof Error ? err.message : "Nie udało się policzyć trasy dnia",
          settled: true,
        });
      }
    };

    void ask(0);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [date, idsKey, nonce]);

  const fresh = state?.date === date ? state : null;
  return {
    route: fresh?.route ?? null,
    loading: !fresh?.settled,
    error: fresh?.error ?? null,
    reload,
  };
}
