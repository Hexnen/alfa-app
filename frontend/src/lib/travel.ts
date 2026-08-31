/**
 * Dojazd biuro → obiekt — wspólne dla dialogu wydarzenia i podglądu w kalendarzu.
 *
 * Backend (`GET /company/travel`) liczy dystans i czas w jedną stronę; tutaj jest tylko
 * formatowanie po polsku i pobranie z dopytkami, gdy trasa dolicza się jeszcze w tle.
 */
import { useEffect, useState } from "react";
import { getCompanyTravel, type CompanyTravel } from "@/lib/api";
import { fmtMinutes, parseLocal } from "@/lib/calendar-labels";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Kilometry po polsku: 24.3 → „24,3 km”. */
export function fmtKm(km: number): string {
  return `${km.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} km`;
}

export interface TravelContext {
  /** Początek wydarzenia — z niego liczy się godzina wyjazdu. */
  startAt?: string | null;
  /** Całodniowe: nie ma od czego odejmować dojazdu, więc dopisek znika. */
  allDay?: boolean;
}

/**
 * „417,3 km · 4 godz. 39 min (w jedną stronę) · wyjazd o 06:21”.
 * `null`, gdy nie ma czego pokazać (brak danych albo komunikat błędu).
 */
export function travelSummary(travel: CompanyTravel | null, ctx: TravelContext = {}): string | null {
  if (!travel || travel.error || travel.km == null || travel.minutes == null) return null;
  const time = travel.minutesEstimated ? `ok. ${fmtMinutes(travel.minutes)}` : fmtMinutes(travel.minutes);
  let departure = "";
  if (!ctx.allDay && ctx.startAt) {
    const start = parseLocal(ctx.startAt);
    if (!Number.isNaN(start.getTime())) {
      const dep = new Date(start.getTime() - travel.minutes * 60_000);
      const dayBefore = dep.toDateString() !== start.toDateString();
      departure = ` · wyjazd o ${pad2(dep.getHours())}:${pad2(dep.getMinutes())}${dayBefore ? " (dzień wcześniej)" : ""}`;
    }
  }
  return `${fmtKm(travel.km)} · ${time} (w jedną stronę)${departure}`;
}

/**
 * Godzina wyjazdu = początek wydarzenia minus dojazd. `null`, gdy nie ma z czego liczyć
 * (brak danych, wydarzenie całodniowe, brak początku).
 */
export function departureAt(
  travel: CompanyTravel | null,
  ctx: TravelContext = {}
): { time: string; dayBefore: boolean } | null {
  if (!travel || travel.error || travel.minutes == null) return null;
  if (ctx.allDay || !ctx.startAt) return null;
  const start = parseLocal(ctx.startAt);
  if (Number.isNaN(start.getTime())) return null;
  const dep = new Date(start.getTime() - travel.minutes * 60_000);
  return {
    time: `${pad2(dep.getHours())}:${pad2(dep.getMinutes())}`,
    dayBefore: dep.toDateString() !== start.toDateString(),
  };
}

/** „wyjazd 05:21 · dojazd 4 godz. 39 min” — linia do dymka nad wydarzeniem. */
export function departureLine(travel: CompanyTravel | null, ctx: TravelContext = {}): string | null {
  const dep = departureAt(travel, ctx);
  if (!dep || travel?.minutes == null) return null;
  const drive = travel.minutesEstimated ? `ok. ${fmtMinutes(travel.minutes)}` : fmtMinutes(travel.minutes);
  return `wyjazd ${dep.time}${dep.dayBefore ? " (dzień wcześniej)" : ""} · dojazd ${drive}`;
}


/** Wiersz dla formularza: obok wyniku pokazuje też stan liczenia i komunikat błędu. */
export function travelLine(travel: CompanyTravel | null, loading: boolean, ctx: TravelContext = {}): string {
  if (!travel) return loading ? "liczę…" : "—";
  if (travel.error) return travel.error;
  return travelSummary(travel, ctx) ?? "—";
}

/** Skąd wzięty dystans (druga, drobniejsza linia pod wynikiem). */
export function travelSourceLabel(travel: CompanyTravel | null, loading: boolean): string {
  if (!travel || travel.error || travel.km == null) return "";
  // Po wyczerpaniu dopytek zostaje sam sposób liczenia — inaczej „dolicza się w tle”
  // wisiałoby w kółko, choć nikt już nic nie dolicza.
  if (travel.pending && loading) return "wstępny szacunek — trasa dolicza się w tle";
  return travel.method === "route" ? "trasa OSRM" : "szacunek z linii prostej";
}

/**
 * Pobiera dojazd dla obiektu. Backend odpowiada z cache'u od ręki, a gdy trasy jeszcze
 * nie policzył (`pending`), dolicza ją w tle — stąd najwyżej dwie dopytki.
 *
 * Wynik trzymamy razem z id obiektu, żeby po przełączeniu obiektu nie mignął dystans
 * poprzedniego (i żeby nie czyścić stanu setState-em w ciele efektu).
 */
export function useTravel(
  objectId: number | string | null | undefined,
  enabled = true
): { travel: CompanyTravel | null; loading: boolean } {
  const id = Number(objectId);
  const active = enabled && Number.isInteger(id) && id > 0;
  const [result, setResult] = useState<{ id: number; travel: CompanyTravel | null; done: boolean } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const ask = async (attempt: number) => {
      const res = await getCompanyTravel(id);
      if (cancelled) return;
      const retry = !!res?.pending && attempt < 2;
      setResult({ id, travel: res, done: !retry });
      if (retry) timers.push(setTimeout(() => void ask(attempt + 1), attempt === 0 ? 3000 : 5000));
    };
    void ask(0);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [id, active]);

  const fresh = active && result?.id === id ? result : null;
  return { travel: fresh?.travel ?? null, loading: active && !fresh?.done };
}
