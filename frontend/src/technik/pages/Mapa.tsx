import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MapPinOff } from "lucide-react";
import { useTechnikMe } from "../lib/me";
import { Chip } from "../ui/chip";
import { SegmentedControl } from "../ui/segmented";
import { useToast } from "../ui/toast";
import { addDays, todayIso } from "../lib/dates";
import { useJobs } from "../lib/useJobs";
import { useWeather } from "../lib/useWeather";
import { JobsMap } from "../mapa/JobsMap";
import { MapSheet, PinJobs, PlainJobs } from "../mapa/MapSheet";
import { pinSubtitle, pinTitle, pinsOf, withoutLocation, type MapRange } from "../mapa/pins";

/**
 * MAPA — „gdzie dziś jadę”, zakładka obok „Nadchodzących”.
 *
 * Jedno źródło danych z listami (`GET /technik/jobs`), żadnego nowego
 * endpointu: mapa to inny WIDOK tych samych zleceń, więc po przełączeniu
 * zakładki nie ma czekania na drugi komplet danych.
 *
 * Zakres siedzi w adresie (`?zakres=dzis|14`), bo technik wraca tu ze zlecenia
 * i ma zastać to, co zostawił — a link da się wysłać w rozmowie z biurem.
 *
 * Ekran jest WYSOKOŚCI OKNA i sam się nie przewija: przeciąganie mapy nie ma
 * prawa ruszać strony pod spodem (patrz `.tm-screen` w technik.css).
 */

/** Koniec zakresu jest wyłączny (`startAt < to`) — stąd +1 / +15 dnia. */
const RANGE_TO: Record<MapRange, number> = { dzis: 1, "14": 15 };

type Sheet = { kind: "pin"; key: string } | { kind: "missing" } | null;

export function Mapa() {
  const [params, setParams] = useSearchParams();
  const range: MapRange = params.get("zakres") === "14" ? "14" : "dzis";
  const today = todayIso();
  const { jobs, loading, error } = useJobs(today, addDays(today, RANGE_TO[range]));
  const { me } = useTechnikMe();
  const { toastError } = useToast();
  const weather = useWeather(jobs);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [sheetHeight, setSheetHeight] = useState(0);

  const pins = useMemo(() => pinsOf(jobs), [jobs]);
  const missing = useMemo(() => withoutLocation(jobs), [jobs]);
  const selected = sheet?.kind === "pin" ? pins.find((p) => p.key === sheet.key) ?? null : null;

  const selectPin = useCallback((key: string | null) => {
    setSheet(key ? { kind: "pin", key } : null);
  }, []);

  const setRange = (next: MapRange) => {
    const p = new URLSearchParams(params);
    if (next === "dzis") p.delete("zakres");
    else p.set("zakres", next);
    // `replace`, bo „wstecz” ma wyjść z mapy, a nie odklikiwać zakresy.
    setParams(p, { replace: true });
    setSheet(null);
  };

  if (loading && jobs.length === 0) {
    return (
      <div className="tm-screen flex flex-col gap-2">
        <div className="h-11 shrink-0 animate-pulse rounded-xl bg-muted" />
        <div className="min-h-0 flex-1 animate-pulse rounded-xl border bg-muted" />
      </div>
    );
  }

  return (
    <div className="tm-screen flex flex-col gap-2">
      <div className="shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <SegmentedControl<MapRange>
            label="Zakres mapy"
            value={range}
            onChange={setRange}
            options={[
              { value: "dzis", label: "Dziś", "data-testid": "technik-mapa-zakres-dzis" },
              { value: "14", label: "14 dni", "data-testid": "technik-mapa-zakres-14" },
            ]}
            // `full={false}` + `flex-1`: z `w-full` segmenty wypychały licznik
            // poza ekran na 390 px (szerokość 100% wygrywa z `flex-1`).
            full={false}
            className="min-w-0 flex-1"
          />
          <span
            data-testid="technik-mapa-licznik"
            className="shrink-0 whitespace-nowrap text-sm text-muted-foreground tabular-nums"
          >
            {jobsLabel(jobs.length)}
          </span>
        </div>

        {/* Chip tylko wtedy, gdy jest o czym mówić — pusty pasek „0 bez
            lokalizacji” zabierałby wysokość mapy, żeby nie powiedzieć nic. */}
        {missing.length > 0 && (
          <Chip
            tone="neutral"
            selected={sheet?.kind === "missing"}
            data-testid="technik-mapa-chip-bez-lokalizacji"
            onClick={() => setSheet(sheet?.kind === "missing" ? null : { kind: "missing" })}
          >
            <MapPinOff className="h-4 w-4" aria-hidden />
            {missing.length} bez lokalizacji
          </Chip>
        )}
      </div>

      <JobsMap
        className="min-h-0 flex-1"
        pins={pins}
        office={me?.office ?? null}
        range={range}
        selectedKey={sheet?.kind === "pin" ? sheet.key : null}
        onSelect={selectPin}
        sheetHeight={sheetHeight}
        onGeoError={toastError}
      />

      {selected && (
        <MapSheet
          testId="technik-mapa-karta"
          title={pinTitle(selected.jobs[0])}
          subtitle={pinSubtitle(selected, today)}
          onClose={() => setSheet(null)}
          onHeight={setSheetHeight}
        >
          <PinJobs pin={selected} weather={weather} />
        </MapSheet>
      )}

      {sheet?.kind === "missing" && (
        <MapSheet
          testId="technik-mapa-karta-bez-lokalizacji"
          title="Bez lokalizacji na mapie"
          subtitle="Obiekt nie ma jeszcze pinezki — zgłoś to biuru, żeby dopisało współrzędne."
          onClose={() => setSheet(null)}
          onHeight={setSheetHeight}
        >
          <PlainJobs jobs={missing} weather={weather} />
        </MapSheet>
      )}

      {!sheet && !loading && jobs.length === 0 && (
        <MapSheet
          testId="technik-mapa-pusto"
          title={error ? "Nie udało się wczytać zleceń" : "Brak zleceń w tym zakresie"}
          subtitle={
            error
              ? "Sprawdź połączenie — mapa pokaże zlecenia, gdy tylko wrócą."
              : range === "dzis"
                ? "Sprawdź „14 dni” albo zajrzyj do zakładki „Nadchodzące”."
                : "Nowe zlecenia pojawią się tu, gdy biuro przypisze Cię do wydarzenia."
          }
          onHeight={setSheetHeight}
        />
      )}
    </div>
  );
}

/** „1 zlecenie” / „2 zlecenia” / „5 zleceń” — polska odmiana, nie „5 zlecenie”. */
function jobsLabel(n: number): string {
  if (n === 1) return "1 zlecenie";
  const last = n % 10;
  const tens = n % 100;
  const few = last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14);
  return `${n} ${few ? "zlecenia" : "zleceń"}`;
}
