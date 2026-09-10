import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Cloud, Droplets, ExternalLink, Loader2, MapPin, RefreshCw, Wind } from "lucide-react";
import { calendarApi, type WeatherBrief, type WeatherDetail, type WeatherWarning } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
// Mapa WMO, formatowanie i teksty siedzą w module bez JSX — plik z komponentami NIE MOŻE
// eksportować niczego innego, bo Fast Refresh Vite'a przestaje działać (react-refresh).
import {
  WARNING_BOX,
  WARNING_LABEL,
  WARNING_TONE,
  flat,
  fmtDay,
  fmtFetched,
  fmtHour,
  fmtWarningRange,
  hourNum,
  markTip,
  mm,
  round,
  temp,
  weatherFacts,
  weatherHeadline,
  weatherLabel,
  weatherMeta,
  weatherTip,
} from "@/lib/weather-meta";

/**
 * Ikona zjawiska jako element — przez `meta.icon`, nie przez lokalną zmienną-komponent.
 * Kolor bierze się z mapy (`meta.className`), więc każde miejsce w UI koloruje tak samo;
 * `className` z wywołania dokłada tylko rozmiar/układ.
 */
function renderIcon(code: number, className: string) {
  const meta = weatherMeta(code);
  return <meta.icon className={cn(className, meta.className)} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Znacznik na kafelku / karcie
// ---------------------------------------------------------------------------

/**
 * Wąska pigułka pogody: ikona + temperatura (+ trójkąt ostrzeżenia IMGW).
 * Nic nie renderuje bez prognozy (brak punktu / dzień poza oknem prognozy).
 */
export function WeatherMark({
  brief,
  compact,
  className,
}: {
  brief: WeatherBrief | null | undefined;
  /** Mniejsza pigułka — kafelki siatki, karty tablicy. */
  compact?: boolean;
  className?: string;
}) {
  if (!brief) return null;
  const label = weatherTip(brief);
  const warn = brief.warningLevel > 0 ? (brief.warningLevel as 1 | 2 | 3) : null;
  return (
    <span
      data-testid="weather-mark"
      data-code={brief.code}
      data-warning={warn ?? undefined}
      aria-label={flat(label)}
      {...markTip(label)}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded text-muted-foreground tabular-nums",
        compact ? "text-[10px]" : "text-[11px]",
        className
      )}
    >
      {renderIcon(brief.code, cn("shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5"))}
      {temp(brief.tempC)}
      {warn && (
        <AlertTriangle
          className={cn("shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5", WARNING_TONE[warn])}
          aria-hidden
        />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sekcja „Pogoda” w dialogu wydarzenia
// ---------------------------------------------------------------------------

interface WeatherSectionProps {
  eventId: number;
  /** Skrót z listy (jeśli rodzic już go ma) — pokazuje się natychmiast. */
  brief?: WeatherBrief | null;
  /** Termin wydarzenia — podświetla jego godziny w szczegółowej prognozie. */
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  className?: string;
}

/**
 * Jedna linia z pogodą dla dnia wydarzenia + przycisk „Szczegółowa prognoza”.
 * Dociąga pełną prognozę sama (jeden request per otwarcie dialogu), więc działa
 * też tam, gdzie rodzic nie ma skrótu (karta obiektu).
 */
export function WeatherSection({ eventId, brief, startAt, endAt, allDay, className }: WeatherSectionProps) {
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Wynik trzymany razem z kluczem zapytania — dzięki temu „ładowanie” wynika
  // z porównania w renderze zamiast z synchronicznego setState w efekcie.
  const [result, setResult] = useState<{ key: string; detail: WeatherDetail | null; failed: boolean } | null>(
    null
  );
  const key = `${eventId}:${nonce}`;

  useEffect(() => {
    let cancelled = false;
    calendarApi
      .eventWeather(eventId)
      .then((res) => {
        if (!cancelled) setResult({ key, detail: res.data ?? null, failed: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, detail: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, key]);

  const current = result?.key === key ? result : null;
  const detail = current?.detail ?? null;
  const loading = !current;
  const failed = current?.failed ?? false;
  const shown: WeatherBrief | null = detail ?? brief ?? null;

  return (
    <div className={cn("space-y-1", className)} data-testid="weather-section">
      {shown ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-sm">
            {renderIcon(shown.code, "h-4 w-4 shrink-0")}
            <span className="font-medium">{weatherHeadline(shown)}</span>
            <span className="text-muted-foreground">· {weatherFacts(shown)}</span>
          </span>
          {shown.warningLevel > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium",
                WARNING_BOX[shown.warningLevel as 1 | 2 | 3],
                WARNING_TONE[shown.warningLevel as 1 | 2 | 3]
              )}
            >
              <AlertTriangle className="h-3 w-3" aria-hidden />
              IMGW {shown.warningLevel}°
            </span>
          )}
        </div>
      ) : loading ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Sprawdzam prognozę…
        </p>
      ) : failed ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          Nie udało się pobrać prognozy.
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Spróbuj ponownie
          </button>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Brak prognozy — nieznane miejsce albo termin poza zakresem prognozy (do 15 dni w przód).
        </p>
      )}
      {shown && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => setOpen(true)}
            data-testid="weather-detail-open"
          >
            Szczegółowa prognoza
          </Button>
          {shown.point.label && (
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{shown.point.label}</span>
            </span>
          )}
        </div>
      )}
      <WeatherDetailDialog
        eventId={eventId}
        open={open}
        onOpenChange={setOpen}
        preloaded={detail}
        startAt={startAt}
        endAt={endAt}
        allDay={allDay}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog szczegółowej prognozy
// ---------------------------------------------------------------------------

interface WeatherDetailDialogProps {
  eventId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prognoza pobrana już przez `WeatherSection` — bez drugiego requestu. */
  preloaded?: WeatherDetail | null;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
}

/**
 * Prognoza godzinowa dla dnia wydarzenia, 7 dni, ostrzeżenia IMGW i linki
 * zewnętrzne. Dociąga dane sama, jeśli nie dostała ich od rodzica.
 */
export function WeatherDetailDialog({
  eventId,
  open,
  onOpenChange,
  preloaded,
  startAt,
  endAt,
  allDay,
}: WeatherDetailDialogProps) {
  // Rodzic zwykle podaje `preloaded` — dociąganie dotyczy tylko użycia dialogu
  // bez `WeatherSection`. Wynik z kluczem, żeby stan „ładowanie” liczyć w renderze.
  const [result, setResult] = useState<{ key: number; detail: WeatherDetail | null; error: string | null } | null>(
    null
  );
  const firstHourRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || preloaded) return;
    let cancelled = false;
    calendarApi
      .eventWeather(eventId)
      .then((res) => {
        if (!cancelled) setResult({ key: eventId, detail: res.data ?? null, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          key: eventId,
          detail: null,
          error: err instanceof Error ? err.message : "Nie udało się pobrać prognozy",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventId, preloaded]);

  const fetched = result?.key === eventId ? result : null;
  const detail = preloaded ?? fetched?.detail ?? null;
  const error = preloaded ? null : (fetched?.error ?? null);
  const loading = !preloaded && !fetched;

  // Godziny wydarzenia podświetlone w siatce godzinowej — DOKŁADNIE to okno [start, koniec),
  // z którego backend liczy kod i temperaturę briefu (14:00 jako koniec nie podświetla 14:00).
  const inEvent = useCallback(
    (iso: string): boolean => {
      if (!startAt || allDay) return false;
      if (startAt.slice(0, 10) !== iso.slice(0, 10)) return false;
      const h = hourNum(iso);
      const from = Number(startAt.slice(11, 13));
      const sameDayEnd = endAt && endAt.slice(0, 10) === iso.slice(0, 10);
      const endH = sameDayEnd ? Number(endAt.slice(11, 13)) : 24;
      const endM = sameDayEnd ? Number(endAt.slice(14, 16)) : 0;
      const last = endM > 0 ? endH : endH - 1;
      return h >= from && h <= Math.max(from, last);
    },
    [startAt, endAt, allDay]
  );

  // Po otwarciu przewiń siatkę do pierwszej godziny wydarzenia.
  useEffect(() => {
    if (!open || !detail) return;
    const t = window.setTimeout(() => {
      firstHourRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [open, detail]);

  /** Pierwsza godzina wydarzenia w siatce — do przewinięcia po otwarciu. */
  const firstHotHour = detail?.hourly.find((h) => inEvent(h.time))?.time ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {detail ? (
              renderIcon(detail.code, "h-5 w-5")
            ) : (
              <Cloud className="h-5 w-5 text-muted-foreground" aria-hidden />
            )}
            Prognoza pogody
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `${fmtDay(detail.date)} · ${weatherHeadline(detail)}${detail.point.label ? ` · ${detail.point.label}` : ""}`
              : "Prognoza dla miejsca wydarzenia."}
          </DialogDescription>
        </DialogHeader>

        {loading && !detail && (
          <p className="inline-flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytuję prognozę…
          </p>
        )}
        {!loading && error && <p className="py-6 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!loading && !error && !detail && (
          <p className="py-6 text-sm text-muted-foreground">
            Brak prognozy dla tego wydarzenia — nieznane miejsce albo termin poza zakresem prognozy.
          </p>
        )}

        {detail && (
          <div className="space-y-5">
            {/* Ostrzeżenia IMGW */}
            {detail.warnings.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Ostrzeżenia IMGW{detail.county ? ` · powiat ${detail.county}` : ""}
                </h3>
                {detail.warnings.map((w, i) => (
                  <WarningBox key={`${w.event}-${w.from}-${i}`} warning={w} />
                ))}
              </section>
            )}

            {/* Godziny dnia wydarzenia */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Godzinowo · {fmtDay(detail.date)}
              </h3>
              {detail.hourly.length === 0 ? (
                <p className="text-sm text-muted-foreground">Brak danych godzinowych.</p>
              ) : (
                <div className="grid grid-cols-4 gap-1 sm:grid-cols-6 md:grid-cols-8">
                  {detail.hourly.map((h) => {
                    const hot = inEvent(h.time);
                    return (
                      <div
                        key={h.time}
                        ref={h.time === firstHotHour ? firstHourRef : undefined}
                        data-testid="weather-hour"
                        data-active={hot ? "true" : undefined}
                        {...markTip(
                          `${fmtHour(h.time)} · ${weatherLabel(h.code)} — ${temp(h.tempC)}C, opady ${mm(h.precipMm)} mm${h.precipProb != null ? ` (${round(h.precipProb)}%)` : ""}, wiatr ${round(h.windKmh)} km/h`
                        )}
                        className={cn(
                          "flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 text-center tabular-nums",
                          hot
                            ? "border-primary/60 bg-primary/10 font-medium"
                            : "border-transparent bg-muted/40 text-muted-foreground"
                        )}
                      >
                        <span className="text-[11px]">{fmtHour(h.time)}</span>
                        {renderIcon(h.code, "h-4 w-4")}
                        <span className="text-sm text-foreground">{temp(h.tempC)}</span>
                        <span className="inline-flex items-center gap-0.5 text-[10px]">
                          <Droplets className="h-2.5 w-2.5" aria-hidden />
                          {h.precipProb != null ? `${round(h.precipProb)}%` : "—"}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-[10px]">
                          <Wind className="h-2.5 w-2.5" aria-hidden />
                          {round(h.windKmh)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 7 dni */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Najbliższe dni
              </h3>
              {detail.daily.length === 0 ? (
                <p className="text-sm text-muted-foreground">Brak prognozy dziennej.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {detail.daily.map((d) => (
                      <li
                        key={d.date}
                        data-testid="weather-day"
                        data-active={d.date === detail.date ? "true" : undefined}
                        className={cn(
                          "flex items-center gap-2 px-2 py-1.5 text-sm",
                          d.date === detail.date && "bg-primary/5 font-medium"
                        )}
                      >
                        {/* w-28: „niedz., 13 wrz” nie mieści się w w-24 i łamie wiersz na dwie linie */}
                        <span className="w-28 shrink-0 capitalize">{fmtDay(d.date)}</span>
                        {renderIcon(d.code, "h-4 w-4 shrink-0")}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {weatherLabel(d.code)}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-xs tabular-nums text-muted-foreground">
                          <Droplets className="h-3 w-3" aria-hidden />
                          {mm(d.precipMm)} mm
                          {d.precipProb != null ? ` (${round(d.precipProb)}%)` : ""}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-xs tabular-nums text-muted-foreground">
                          <Wind className="h-3 w-3" aria-hidden />
                          {round(d.windKmh)}
                        </span>
                        <span className="w-16 shrink-0 text-right tabular-nums">
                          {temp(d.tempMinC)}/{temp(d.tempMaxC)}
                        </span>
                      </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Linki zewnętrzne + metryczka */}
            <section className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
              <a
                href={detail.links.windy}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Windy <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
              <a
                href={detail.links.imgw}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                IMGW <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
              <span>
                Dane: Open-Meteo{detail.warnings.length > 0 ? " + IMGW" : ""} · pobrano{" "}
                {fmtFetched(detail.fetchedAt)}
              </span>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WarningBox({ warning }: { warning: WeatherWarning }) {
  const level = (warning.level >= 1 && warning.level <= 3 ? warning.level : 1) as 1 | 2 | 3;
  return (
    <div className={cn("rounded-md border p-2 text-sm", WARNING_BOX[level])} data-testid="weather-warning">
      <div className={cn("flex flex-wrap items-center gap-1.5 font-medium", WARNING_TONE[level])}>
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        {warning.event}
        <span className="rounded-full border border-current px-1.5 text-[10px] uppercase">
          {level}° {WARNING_LABEL[level]}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {fmtWarningRange(warning.from, warning.to)}
      </p>
      {warning.text && <p className="mt-1 whitespace-pre-line text-xs">{warning.text}</p>}
    </div>
  );
}
