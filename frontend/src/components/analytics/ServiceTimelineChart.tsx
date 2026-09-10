/**
 * Seria czasowa usług — odpowiada na dwa pytania naraz: „ile obiektów mieliśmy
 * pod dozorem w danym miesiącu" i „ile usług w tym miesiącu przybyło, a ile
 * ubyło".
 *
 * DWA PANELE, NIE DWIE OSIE. Liczba aktywnych obiektów (setki) i ruch usług
 * (jednostki) różnią się o dwa rzędy wielkości; wspólny wykres z drugą osią
 * pionową wymyśliłby korelację, której w danych nie ma (skill `dataviz`,
 * anti-patterns: „dual-axis"). Dlatego panele dzielą tylko OŚ CZASU:
 *
 *  - górny: słupki rozbieżne od linii zera — rozpoczęcia w górę (zieleń zysku),
 *    zakończenia w dół (czerwień straty). Kierunek jest drugim kanałem obok
 *    barwy, więc para czyta się także przy daltonizmie.
 *  - dolny: linia aktywnych obiektów, jedna seria, z etykietą przy ostatnim
 *    punkcie (bez liczby nad każdym punktem — to szum, nie informacja).
 *
 * Cała reszta modułu rysuje w SVG ręcznie (w repo NIE MA biblioteki wykresów
 * i celowo jej nie dodajemy) — ten plik trzyma się tego samego idiomu:
 * geometria z `./scale`, barwy z `./palette`, dymki z `ui/tooltip`.
 *
 * Chrom (siatka, opisy osi) jedzie przez `currentColor` + tokeny Tailwinda
 * (`text-muted-foreground`, `text-border`), a nie przez zaszyte szarości — tylko
 * tak panel przeżyje tryb ciemny. Barwy DANYCH zostają z palety modułu, bo
 * znaczą to samo, co na pozostałych wykresach analityki.
 */
import { useMemo } from "react";
import { tipAttrs } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Legend, LegendItem } from "./Legend";
import { barPath, niceScale } from "./scale";
import { COLOR_LOSS, COLOR_PROFIT, COLOR_REVENUE } from "./palette";
import { nf, plnFull } from "./format";

export interface ServiceTimelinePoint {
  /** YYYY-MM */
  month: string;
  activeObjects: number;
  started: number;
  ended: number;
  revenue: number;
}

export interface ServiceTimelineChartProps {
  points: ServiceTimelinePoint[];
  /** Zdanie po polsku opisujące, co pokazuje wykres. */
  ariaLabel: string;
  className?: string;
}

const W = 760;
const PAD_L = 32;
const PAD_R = 12;
const MT = 12;
/** Połowa panelu rozbieżnego — góra i dół dostają tyle samo miejsca. */
const HALF = 52;
/** Przerwa między panelami; mieści podpis dolnego. */
const GAP = 28;
const LINE_H = 58;
const AXIS_H = 26;
const BAR_MAX_W = 20;
/** Odstęp powierzchni między słupkiem a sąsiadem — 2px z każdej strony. */
const BAR_GAP = 4;

const MONTHS_SHORT = [
  "sty", "lut", "mar", "kwi", "maj", "cze",
  "lip", "sie", "wrz", "paź", "lis", "gru",
];

/** „2026-03" → „mar". Rok jedzie osobną linią, tylko na przełomie. */
function monthShort(month: string): string {
  const m = Number(month.slice(5, 7));
  return MONTHS_SHORT[m - 1] ?? month;
}

/**
 * Podzbiór działek do narysowania. `niceScale` przy małych licznikach zwraca
 * pięć działek (0…4), a przy słupkach rozbieżnych każda jest rysowana DWA razy
 * — dziewięć linii siatki na 100 px wysokości to krata, nie tło.
 */
function sparseTicks(ticks: number[]): number[] {
  if (ticks.length <= 3) return ticks;
  const last = ticks.length - 1;
  const mid = Math.round(last / 2);
  return [...new Set([ticks[0], ticks[mid], ticks[last]])];
}

export function ServiceTimelineChart({
  points,
  ariaLabel,
  className,
}: ServiceTimelineChartProps) {
  const H = MT + 2 * HALF + GAP + LINE_H + AXIS_H;
  const zeroY = MT + HALF;
  const lineTop = MT + 2 * HALF + GAP;
  const lineBottom = lineTop + LINE_H;
  const x0 = PAD_L;
  const x1 = W - PAD_R;
  const plotW = x1 - x0;

  const band = points.length > 0 ? plotW / points.length : plotW;
  const barW = Math.max(4, Math.min(BAR_MAX_W, band - BAR_GAP * 2));
  const cx = (i: number) => x0 + band * (i + 0.5);

  /** Skala ruchu usług — WSPÓLNA dla obu kierunków, inaczej „w górę" i „w dół"
      znaczyłyby co innego w tym samym słupku. */
  const moveScale = useMemo(
    () =>
      niceScale(
        points.reduce((m, p) => Math.max(m, p.started, p.ended), 0)
      ),
    [points]
  );
  const activeScale = useMemo(
    () => niceScale(points.reduce((m, p) => Math.max(m, p.activeObjects), 0)),
    [points]
  );

  const upY = (v: number) => zeroY - (v / moveScale.max) * HALF;
  const downY = (v: number) => zeroY + (v / moveScale.max) * HALF;
  const activeY = (v: number) =>
    lineBottom - (v / activeScale.max) * (lineBottom - lineTop);

  const linePath = useMemo(
    () =>
      points
        .map((p, i) => `${i === 0 ? "M" : "L"}${cx(i)},${activeY(p.activeObjects)}`)
        .join(" "),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, activeScale.max, band]
  );

  if (points.length === 0) return null;

  const moveTicks = sparseTicks(moveScale.ticks).filter((t) => t > 0);
  const last = points[points.length - 1];

  return (
    <div className={cn("space-y-3", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={ariaLabel}
        className="select-none"
      >
        {/* --- siatka i osie: hairline, ciągłe, recesywne ------------------ */}
        <g className="text-border" stroke="currentColor" strokeWidth={1}>
          {moveTicks.map((t) => (
            <g key={`g-${t}`}>
              <line x1={x0} x2={x1} y1={upY(t)} y2={upY(t)} />
              <line x1={x0} x2={x1} y1={downY(t)} y2={downY(t)} />
            </g>
          ))}
          {sparseTicks(activeScale.ticks).map((t) => (
            <line
              key={`a-${t}`}
              x1={x0}
              x2={x1}
              y1={activeY(t)}
              y2={activeY(t)}
            />
          ))}
        </g>
        {/* Linia zera jest mocniejsza od siatki — to od niej mierzy się oba
            kierunki, a nie kolejna działka. */}
        <line
          x1={x0}
          x2={x1}
          y1={zeroY}
          y2={zeroY}
          className="text-muted-foreground"
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.5}
        />

        {/* --- opisy działek ---------------------------------------------- */}
        <g
          className="text-muted-foreground"
          fill="currentColor"
          fontSize={9}
          textAnchor="end"
        >
          {moveTicks.map((t) => (
            <g key={`lt-${t}`}>
              <text x={x0 - 5} y={upY(t) + 3}>
                {nf(t)}
              </text>
              <text x={x0 - 5} y={downY(t) + 3}>
                {nf(t)}
              </text>
            </g>
          ))}
          {sparseTicks(activeScale.ticks)
            .filter((t) => t > 0)
            .map((t) => (
              <text key={`la-${t}`} x={x0 - 5} y={activeY(t) + 3}>
                {nf(t)}
              </text>
            ))}
        </g>

        {/* --- słupki rozbieżne: rozpoczęcia w górę, zakończenia w dół ----- */}
        {points.map((p, i) => (
          <g key={`bars-${p.month}`}>
            {p.started > 0 && (
              <path
                d={barPath(cx(i), upY(p.started), barW, zeroY - upY(p.started))}
                fill={COLOR_PROFIT}
              />
            )}
            {p.ended > 0 && (
              <path
                // Ten sam kształt obrócony: zaokrąglony koniec od strony danych
                // (na dole), prosty przy linii zera.
                d={barPath(cx(i), zeroY, barW, downY(p.ended) - zeroY)}
                fill={COLOR_LOSS}
                transform={`rotate(180 ${cx(i)} ${(zeroY + downY(p.ended)) / 2})`}
              />
            )}
          </g>
        ))}

        {/* --- panel dolny: aktywne obiekty -------------------------------- */}
        <text
          x={x0}
          y={lineTop - 8}
          className="text-muted-foreground"
          fill="currentColor"
          fontSize={9}
        >
          AKTYWNE OBIEKTY
        </text>
        <path
          d={linePath}
          fill="none"
          stroke={COLOR_REVENUE}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Pierścień w kolorze powierzchni — kropka musi zostać czytelna tam,
            gdzie krzyżuje linię i siatkę. */}
        <circle
          cx={cx(points.length - 1)}
          cy={activeY(last.activeObjects)}
          r={4}
          fill={COLOR_REVENUE}
          className="stroke-background"
          strokeWidth={2}
        />
        {/* Etykieta bezpośrednia TYLKO przy ostatnim punkcie — liczba nad każdym
            punktem to szum, resztę niesie oś, dymek i tabela pod wykresem. */}
        <text
          x={cx(points.length - 1)}
          y={activeY(last.activeObjects) - 9}
          textAnchor="end"
          className="text-foreground"
          fill="currentColor"
          fontSize={11}
          fontWeight={600}
        >
          {nf(last.activeObjects)}
        </text>

        {/* --- oś czasu + pola trafień dymka ------------------------------- */}
        {points.map((p, i) => {
          const year = p.month.slice(0, 4);
          const showYear = i === 0 || p.month.slice(5, 7) === "01";
          const tip = tipAttrs({
            title: `${monthShort(p.month)} ${year}`,
            rows: [
              { label: "Aktywne obiekty", text: nf(p.activeObjects) },
              { label: "Rozpoczęte usługi", text: nf(p.started) },
              { label: "Zakończone usługi", text: nf(p.ended) },
              { label: "Przychód (stawki bieżące)", text: plnFull(p.revenue) },
            ],
          });
          return (
            <g key={`x-${p.month}`}>
              <rect
                x={x0 + band * i}
                y={MT}
                width={band}
                height={lineBottom - MT}
                className="fill-transparent hover:fill-muted/40"
                {...tip}
              />
              <text
                x={cx(i)}
                y={lineBottom + 14}
                textAnchor="middle"
                className="text-muted-foreground"
                fill="currentColor"
                fontSize={10}
              >
                {monthShort(p.month)}
              </text>
              {showYear && (
                <text
                  x={cx(i)}
                  y={lineBottom + 24}
                  textAnchor="middle"
                  className="text-muted-foreground"
                  fill="currentColor"
                  fontSize={9}
                  opacity={0.75}
                >
                  {year}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <Legend>
        <LegendItem color={COLOR_PROFIT} label="rozpoczęte usługi (w górę)" />
        <LegendItem color={COLOR_LOSS} label="zakończone usługi (w dół)" />
        <LegendItem color={COLOR_REVENUE} label="aktywne obiekty (linia)" />
      </Legend>
    </div>
  );
}
