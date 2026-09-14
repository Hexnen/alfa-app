import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEATHER_BATCH_MAX, technikApi, type WeatherBrief } from "@/lib/api";
import { addDays, dayOf, todayIso } from "./dates";

/**
 * POGODA DLA ZLECEŃ — jeden batch na listę, nie zapytanie na kartę.
 *
 * Panel ma własną trasę (`GET /technik/jobs/weather`), bo rola `technik` nie
 * ma dostępu do `/api/calendar`; liczy ją ta sama funkcja co kalendarzowi,
 * więc ikona i temperatura znaczą dokładnie to samo w obu miejscach.
 *
 * Zasady przepisane z kalendarza (`CalendarPage.tsx`), bez jego skali:
 *   - każdy skrót jest zapamiętany RAZEM z sygnaturą zlecenia (termin + miejsce)
 *     i pokazujemy go tylko wtedy, gdy sygnatura się zgadza — po przesunięciu
 *     zlecenia stary skrót opisywałby nieistniejący już termin,
 *   - `retry` z odpowiedzi odróżnia „pogody nie będzie" (poza oknem prognozy,
 *     brak punktu) od „nie udało się" (offline, limit geokodowań); ponawiamy
 *     wyłącznie te drugie, najwyżej `MAX_TRIES` razy, jednym wspólnym timerem,
 *   - brak pogody = `null` i UI nic nie renderuje. Panel ma działać bez niej.
 *
 * Stan ustawiamy WYŁĄCZNIE w odpowiedzi na zapytanie (callback obietnicy), nigdy
 * w ciele efektu — nieaktualne wpisy odsiewa render, a nie kaskada `setState`
 * (reguła react-hooks/set-state-in-effect).
 */

/** Okno prognozy backendu: [dziś-2, dziś+15]. Poza nim nie ma po co pytać. */
const PAST_DAYS = 2;
const FUTURE_DAYS = 15;

/** Ile razy ponawiamy batch dla tej samej sygnatury, zanim odpuścimy. */
const MAX_TRIES = 3;
/** Odstęp ponowienia po nieudanej próbie (jeden timer na cały ekran). */
const RETRY_MS = 60_000;

/** Tyle ze zlecenia wystarczy, żeby zapytać o pogodę (pasuje i do `TechnikJob`, i do szczegółów). */
export interface WeatherJob {
  id: number;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  status: string;
  objectId: number | null;
  address: string | null;
}

/** Wszystko, co wpływa na prognozę: termin + miejsce. */
const sigOf = (j: WeatherJob): string =>
  `${j.startAt}|${j.endAt ?? ""}|${j.allDay}|${j.objectId ?? ""}|${j.address ?? ""}`;

/** Czy dzień zlecenia mieści się w oknie prognozy (poza nim backend zwraca null). */
const inWindow = (startAt: string, today: string): boolean => {
  const day = dayOf(startAt);
  return day >= addDays(today, -PAST_DAYS) && day <= addDays(today, FUTURE_DAYS);
};

/** Zlecenia, dla których w ogóle warto pytać (anulowanych backend i tak nie odda). */
const applies = (j: WeatherJob, today: string): boolean =>
  j.status !== "cancelled" && inWindow(j.startAt, today);

/** Wpis rejestru zapytań — per zlecenie. */
interface Ask {
  sig: string;
  tries: number;
  /** Backend dał ostateczną odpowiedź — nie pytamy więcej. */
  settled: boolean;
  /** Zapytanie w locie — nie dublujemy go przy kolejnym przeliczeniu listy. */
  inFlight: boolean;
}

/** Zapamiętany skrót razem z sygnaturą, dla której go policzono. */
interface Entry {
  sig: string;
  brief: WeatherBrief | null;
}

/**
 * Skróty pogody dla podanych zleceń: `id → brief | null`.
 * Lista może się zmieniać (odświeżenie po powrocie do karty) — pytamy tylko
 * o to, czego jeszcze nie mamy albo co zmieniło termin/miejsce.
 */
export function useWeather(jobs: WeatherJob[]): Record<number, WeatherBrief | null> {
  const [store, setStore] = useState<Record<number, Entry>>({});
  const askedRef = useRef<Map<number, Ask>>(new Map());

  const [retryTick, setRetryTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRetry = useCallback(() => {
    if (timerRef.current != null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRetryTick((n) => n + 1);
    }, RETRY_MS);
  }, []);
  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    []
  );

  useEffect(() => {
    const today = todayIso();
    const asked = askedRef.current;
    const alive = new Set<number>();
    const ids: number[] = [];

    for (const job of jobs) {
      alive.add(job.id);
      if (!applies(job, today)) {
        asked.delete(job.id);
        continue;
      }
      const sig = sigOf(job);
      const cur = asked.get(job.id);
      if (!cur || cur.sig !== sig) {
        asked.set(job.id, { sig, tries: 0, settled: false, inFlight: false });
        ids.push(job.id);
      } else if (!cur.settled && !cur.inFlight && cur.tries < MAX_TRIES) {
        ids.push(job.id);
      }
    }
    // Zlecenia, których nie ma już na liście (inny dzień, usunięte) — rejestr
    // czyścimy od razu, a ich wpisy w stanie znikną przy najbliższym zapisie.
    for (const id of [...asked.keys()]) if (!alive.has(id)) asked.delete(id);

    if (!ids.length) return;

    for (let i = 0; i < ids.length; i += WEATHER_BATCH_MAX) {
      const chunk = ids.slice(i, i + WEATHER_BATCH_MAX);
      // Sygnatury z chwili wysyłki: odpowiedź na nieaktualną sygnaturę odrzucamy.
      const sent = new Map<number, string>();
      for (const id of chunk) {
        const cur = asked.get(id);
        if (!cur) continue;
        cur.inFlight = true;
        cur.tries += 1;
        sent.set(id, cur.sig);
      }
      technikApi
        .weather(chunk)
        .then((res) => {
          const items = res.data?.items ?? {};
          const retry = new Set(res.data?.retry ?? []);
          for (const [id, sig] of sent) {
            const cur = asked.get(id);
            if (!cur || cur.sig !== sig) continue;
            cur.inFlight = false;
            cur.settled = !retry.has(id);
          }
          setStore((prev) => {
            const next: Record<number, Entry> = {};
            // Przepisujemy tylko wpisy, o które wciąż pytamy — to jest sprzątanie
            // po dniach, których technik już nie ogląda.
            for (const [key, entry] of Object.entries(prev)) {
              if (asked.has(Number(key))) next[Number(key)] = entry;
            }
            let changed = Object.keys(next).length !== Object.keys(prev).length;
            for (const [key, brief] of Object.entries(items)) {
              const id = Number(key);
              if (retry.has(id)) continue; // wynik tymczasowy — nie zapisujemy „braku"
              const sig = sent.get(id);
              if (!sig || asked.get(id)?.sig !== sig) continue; // odpowiedź na stary termin
              next[id] = { sig, brief };
              changed = true;
            }
            return changed ? next : prev;
          });
          if (retry.size) scheduleRetry();
        })
        .catch(() => {
          // Offline / starszy backend bez tej trasy — spróbujemy jeszcze raz.
          for (const [id, sig] of sent) {
            const cur = asked.get(id);
            if (cur && cur.sig === sig) cur.inFlight = false;
          }
          scheduleRetry();
        });
    }
  }, [jobs, retryTick, scheduleRetry]);

  // Skrót pokazujemy tylko dla AKTUALNEJ sygnatury zlecenia — po przesunięciu
  // terminu stary wpis po prostu przestaje pasować i znika z wyniku.
  return useMemo(() => {
    const out: Record<number, WeatherBrief | null> = {};
    for (const job of jobs) {
      const entry = store[job.id];
      if (entry && entry.sig === sigOf(job)) out[job.id] = entry.brief;
    }
    return out;
  }, [jobs, store]);
}

/** Wariant dla ekranu jednego zlecenia — ta sama logika, stabilna jednoelementowa lista. */
export function useJobWeather(job: WeatherJob | null): WeatherBrief | null {
  const list = useMemo(() => (job ? [job] : []), [job]);
  const weather = useWeather(list);
  return job ? (weather[job.id] ?? null) : null;
}
