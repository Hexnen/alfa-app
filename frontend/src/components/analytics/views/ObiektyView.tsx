/**
 * Analityka → Obiekty: „które obiekty dokładamy”.
 *
 * Obiekt jest tu jednostką rozliczeniową: abonament minus koszt miesięczny,
 * plus jednorazowy nakład na instalację. Kluczowe pytanie tej zakładki brzmi
 * „co jest DUŻE i jednocześnie CIENKIE” — na to odpowiada tylko wykres
 * rozrzutu, bo żaden ranking nie pokazuje dwóch wymiarów naraz.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { cn, objectTypeLabels, statusLabels } from "@/lib/utils";
import {
  getAnalyticsObjects,
  type AnalyticsObjectRow,
  type AnalyticsObjectsData,
  type AnalyticsScope,
} from "@/lib/api";
import {
  ChartCard,
  COLOR_COST,
  COLOR_LOSS,
  COLOR_PROFIT,
  COLOR_REVENUE,
  DASH,
  KpiRow,
  KpiTile,
  MarginGauge,
  RankBar,
  RankBarDiverging,
  SCATTER_MIN_ROWS,
  ScatterQuadrant,
  ShareBar,
  monthsLabel,
  pct,
  plnFull,
} from "@/components/analytics";
import {
  aggregate,
  cmpNullLast,
  cmpText,
  matches,
  spLabel,
  tintOf,
  useAnalyticsResource,
  type AnalyticsViewProps,
} from "./shared";
import { NoCostEmpty, ResourceNotice, SortHeader } from "./parts";

const load = (scope: AnalyticsScope) => getAnalyticsObjects({ scope });

type SortKey =
  | "name"
  | "contractor"
  | "type"
  | "status"
  | "salesperson"
  | "revenue"
  | "cost"
  | "profit"
  | "margin"
  | "setup"
  | "payback";

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  contractor: "asc",
  type: "asc",
  status: "asc",
  salesperson: "asc",
  revenue: "desc",
  cost: "desc",
  profit: "asc",
  margin: "asc",
  setup: "desc",
  payback: "asc",
};

/** Filtr rentowności nad tabelą. */
type Chip = "all" | "profitable" | "unprofitable" | "nocost";

const CHIP_LABELS: Record<Chip, string> = {
  all: "Wszystkie",
  profitable: "Rentowne",
  unprofitable: "Nierentowne",
  nocost: "Bez danych kosztowych",
};

/**
 * Pasma zwrotu z instalacji. Granice są umowne, ale muszą być stałe —
 * inaczej „dobry zwrot” znaczy co innego na każdym ekranie.
 */
function paybackBand(months: number): { color: string; label: string } {
  if (months <= 12) return { color: COLOR_PROFIT, label: "do roku" };
  if (months <= 24) return { color: COLOR_COST, label: "1–2 lata" };
  return { color: COLOR_LOSS, label: "ponad 2 lata" };
}

export function ObiektyView({ scope, search, reloadKey }: AnalyticsViewProps) {
  const navigate = useNavigate();
  const { data, state } = useAnalyticsResource<AnalyticsObjectsData>(
    load,
    scope,
    reloadKey
  );
  const [sort, setSort] = useState<SortKey>("revenue");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [chip, setChip] = useState<Chip>("all");

  const toggleSort = useCallback((key: string) => {
    const k = key as SortKey;
    setSort((prev) => {
      if (prev === k) {
        setDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setDir(DEFAULT_DIR[k]);
      return k;
    });
  }, []);

  /** Wiersze po szukajce — podstawa WSZYSTKICH liczb na tej zakładce. */
  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter((r) =>
        matches(
          search,
          r.name,
          r.city,
          r.contractorName,
          r.companyName,
          spLabel(r.salesperson)
        )
      ),
    [data, search]
  );

  const agg = useMemo(
    () =>
      aggregate(
        rows.map((r) => ({
          objects: 1,
          withCost: r.hasCost ? 1 : 0,
          revenue: r.revenue,
          cost: r.hasCost ? r.cost : 0,
          profit: r.hasCost ? r.profit : 0,
          setupCost: r.setupCost,
        }))
      ),
    [rows]
  );

  const hasCostData = agg.objectsWithCost > 0;
  const coverageProps = {
    known: agg.objectsWithCost,
    total: agg.objects,
    noun: "obiektów",
    href: "/objects?hasCost=0",
  };

  /** Średni zwrot z nakładu — tylko z obiektów, które w ogóle się zwracają. */
  const avgPayback = useMemo(() => {
    const known = rows
      .map((r) => r.payback)
      .filter((p): p is number => p !== null && Number.isFinite(p));
    if (known.length === 0) return null;
    return known.reduce((s, p) => s + p, 0) / known.length;
  }, [rows]);

  /** Punkty rozrzutu — tylko obiekty z policzalną marżą. */
  const scatterRows = useMemo(
    () =>
      rows
        .filter((r) => r.margin !== null)
        .map((r) => ({
          id: String(r.id),
          label: r.name,
          revenue: r.revenue,
          marginPct: r.margin,
          setupCost: r.setupCost > 0 ? r.setupCost : null,
        })),
    [rows]
  );

  /** Dziesięć najsłabszych — rosnąco po zysku, bez wierszy bez kosztu. */
  const worstRows = useMemo(
    () =>
      rows
        .filter((r) => r.hasCost)
        .sort((a, b) => a.profit - b.profit)
        .slice(0, 10),
    [rows]
  );
  const worstAbsMax = useMemo(
    () => worstRows.reduce((m, r) => Math.max(m, Math.abs(r.profit)), 0),
    [worstRows]
  );

  /** Zwrot z instalacji — obiekty, w które faktycznie coś włożyliśmy. */
  const payback = useMemo(() => {
    const withSetup = rows.filter((r) => r.setupCost > 0);
    const entries = withSetup.map((r) => {
      // „Nigdy” to nie to samo co „nie wiemy”: zysk <= 0 przy poniesionym
      // nakładzie znaczy, że ten obiekt się nie zwróci przy obecnych stawkach.
      const never = r.hasCost && r.profit <= 0;
      return { row: r, never, months: r.payback };
    });
    const known = entries
      .map((e) => e.months)
      .filter((m): m is number => m !== null && Number.isFinite(m));
    const axisMax = Math.max(12, ...known);
    const counts = {
      fast: known.filter((m) => m <= 12).length,
      mid: known.filter((m) => m > 12 && m <= 24).length,
      slow: known.filter((m) => m > 24).length,
      never: entries.filter((e) => e.never).length,
    };
    const sorted = [...entries].sort((a, b) => {
      // Kolejność: najszybszy zwrot → najwolniejszy → „nigdy” → brak danych.
      const rank = (e: (typeof entries)[number]) =>
        e.months !== null ? 0 : e.never ? 1 : 2;
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      return (a.months ?? 0) - (b.months ?? 0);
    });
    return { entries: sorted, axisMax, counts, total: withSetup.length };
  }, [rows]);

  /** Struktura wg typu ochrony — liczona z widocznych wierszy, nie z API. */
  const byType = useMemo(() => {
    const map = new Map<string, { revenue: number; cost: number; withCost: number; count: number }>();
    for (const r of rows) {
      const cur = map.get(r.type) ?? { revenue: 0, cost: 0, withCost: 0, count: 0 };
      cur.revenue += r.revenue;
      cur.cost += r.hasCost ? r.cost : 0;
      cur.withCost += r.hasCost ? 1 : 0;
      cur.count += 1;
      map.set(r.type, cur);
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, label: objectTypeLabels[key] ?? key, ...v }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [rows]);

  const chipCounts = useMemo(
    () => ({
      all: rows.length,
      profitable: rows.filter((r) => r.hasCost && r.profit > 0).length,
      unprofitable: rows.filter((r) => r.hasCost && r.profit <= 0).length,
      nocost: rows.filter((r) => !r.hasCost).length,
    }),
    [rows]
  );

  const tableRows = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (chip === "profitable") return r.hasCost && r.profit > 0;
      if (chip === "unprofitable") return r.hasCost && r.profit <= 0;
      if (chip === "nocost") return !r.hasCost;
      return true;
    });
    const out = [...filtered];
    out.sort((a, b) => {
      switch (sort) {
        case "name":
          return cmpText(a.name, b.name, dir);
        case "contractor":
          return cmpText(a.contractorName ?? "￿", b.contractorName ?? "￿", dir);
        case "type":
          return cmpText(
            objectTypeLabels[a.type] ?? a.type,
            objectTypeLabels[b.type] ?? b.type,
            dir
          );
        case "status":
          return cmpText(
            statusLabels[a.status] ?? a.status,
            statusLabels[b.status] ?? b.status,
            dir
          );
        case "salesperson":
          return cmpText(
            spLabel(a.salesperson) ?? "￿",
            spLabel(b.salesperson) ?? "￿",
            dir
          );
        case "revenue":
          return dir === "asc" ? a.revenue - b.revenue : b.revenue - a.revenue;
        case "setup":
          return dir === "asc" ? a.setupCost - b.setupCost : b.setupCost - a.setupCost;
        case "cost":
          return cmpNullLast(a.hasCost ? a.cost : null, b.hasCost ? b.cost : null, dir);
        case "profit":
          return cmpNullLast(
            a.hasCost ? a.profit : null,
            b.hasCost ? b.profit : null,
            dir
          );
        case "margin":
          return cmpNullLast(a.margin, b.margin, dir);
        case "payback":
          return cmpNullLast(a.payback, b.payback, dir);
        default:
          return 0;
      }
    });
    return out;
  }, [rows, chip, sort, dir]);

  if (state !== "ready" || !data) {
    return <ResourceNotice state={state === "ready" ? "error" : state} />;
  }

  return (
    <div className="space-y-3">
      <KpiRow>
        <KpiTile
          label="Przychód mies."
          value={plnFull(agg.revenue)}
          sub={`${agg.objects} ${agg.objects === 1 ? "obiekt" : "obiektów"}`}
          tip="Suma abonamentów miesięcznych widocznych obiektów"
        />
        <KpiTile
          label="Koszt mies."
          value={hasCostData ? plnFull(agg.cost) : DASH}
          sub={hasCostData ? undefined : "koszty nieuzupełnione"}
          tip="Suma kosztów miesięcznych. Obiekt bez kosztu wchodzi do sumy jako zero — patrz pokrycie."
          coverage={coverageProps}
        />
        <KpiTile
          label="Zysk mies."
          value={hasCostData ? plnFull(agg.profit) : DASH}
          tone={!hasCostData ? "neutral" : agg.profit >= 0 ? "good" : "bad"}
          sub={hasCostData ? "przychód − koszt" : "uzupełnij koszty, żeby policzyć"}
          tip="Przychód minus koszt miesięczny obiektów"
          coverage={coverageProps}
        />
        <KpiTile
          label="Marża"
          value={<MarginGauge value={hasCostData ? agg.margin : null} size="lg" />}
          sub={hasCostData ? "zysk / przychód" : "nieznana bez kosztów"}
          tip="Zysk podzielony przez przychód. Bez kosztów marża jest nieznana, a nie stuprocentowa."
          coverage={coverageProps}
        />
        <KpiTile
          label="ARPO"
          value={plnFull(agg.arpo)}
          sub="średni przychód na obiekt"
          tip="Average Revenue Per Object — przychód miesięczny podzielony przez liczbę obiektów"
        />
        <KpiTile
          label="Nakłady jednorazowe"
          value={plnFull(agg.setupCost)}
          sub={
            avgPayback !== null
              ? `średni zwrot ${monthsLabel(avgPayback)}`
              : "zwrot nieznany bez kosztów"
          }
          tip="Suma kosztów instalacji. Zwrot liczy się z miesięcznego zysku obiektu."
        />
      </KpiRow>

      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard
          title="Przychód vs marża"
          description="Oś pozioma: przychód miesięczny. Oś pionowa: marża. Wielkość bąbla: nakład na instalację."
          tableData={{
            headers: ["Obiekt", "Przychód", "Marża", "Nakład"],
            rows: scatterRows.map((r) => [
              r.label,
              plnFull(r.revenue),
              pct(r.marginPct),
              plnFull(r.setupCost),
            ]),
          }}
          isEmpty={scatterRows.length < SCATTER_MIN_ROWS}
          empty={
            hasCostData ? (
              <p className="py-8 text-center text-sm text-slate-500">
                Marżę zna {scatterRows.length} z {agg.objects} obiektów — na wykres
                rozrzutu potrzeba co najmniej {SCATTER_MIN_ROWS}. Do tego czasu
                korzystaj z tabeli poniżej.
              </p>
            ) : (
              <NoCostEmpty what="marży obiektów" />
            )
          }
        >
          <ScatterQuadrant
            rows={scatterRows}
            ariaLabel="Rozrzut obiektów: przychód miesięczny na osi poziomej, marża na osi pionowej, wielkość bąbla to nakład na instalację"
            onPointClick={(p) => navigate(`/objects/${p.id}`)}
          />
        </ChartCard>

        <ChartCard
          title="Zysk mies. — 10 najsłabszych obiektów"
          description="Rosnąco: na górze te, które kosztują więcej, niż przynoszą."
          tableData={{
            headers: ["Obiekt", "Przychód", "Koszt", "Zysk", "Marża"],
            rows: worstRows.map((r) => [
              r.name,
              plnFull(r.revenue),
              plnFull(r.cost),
              plnFull(r.profit),
              pct(r.margin),
            ]),
          }}
          isEmpty={!hasCostData || worstRows.length === 0}
          empty={
            hasCostData ? (
              <p className="py-8 text-center text-sm text-slate-500">
                Brak obiektów z policzonym zyskiem w tym zakresie.
              </p>
            ) : (
              <NoCostEmpty what="zysku obiektów" />
            )
          }
        >
          <div className="space-y-1">
            {worstRows.map((r) => (
              <RankBarDiverging
                key={r.id}
                label={r.name}
                subLabel={r.contractorName ?? undefined}
                value={r.profit}
                absMax={worstAbsMax}
                valueLabel={plnFull(r.profit)}
                detail={pct(r.margin)}
                onClick={() => navigate(`/objects/${r.id}`)}
              />
            ))}
          </div>
        </ChartCard>
      </div>

      <ChartCard
        title="Zwrot z instalacji"
        description="Po ilu miesiącach miesięczny zysk pokryje jednorazowy nakład."
        tableData={{
          headers: ["Obiekt", "Nakład", "Zysk mies.", "Zwrot"],
          rows: payback.entries.map((e) => [
            e.row.name,
            plnFull(e.row.setupCost),
            e.row.hasCost ? plnFull(e.row.profit) : DASH,
            e.never ? "nigdy" : monthsLabel(e.months),
          ]),
        }}
        isEmpty={payback.total === 0}
        empty={
          <p className="py-8 text-center text-sm text-slate-500">
            Żaden obiekt w tym zakresie nie ma zapisanego kosztu instalacji.
          </p>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <Counter color={COLOR_PROFIT} label="do roku" value={payback.counts.fast} />
            <Counter color={COLOR_COST} label="1–2 lata" value={payback.counts.mid} />
            <Counter color={COLOR_LOSS} label="ponad 2 lata" value={payback.counts.slow} />
            <Counter color={COLOR_LOSS} label="nigdy" value={payback.counts.never} dim />
          </div>
          <div className="space-y-1">
            {payback.entries.map((e) => {
              const band =
                e.months !== null
                  ? paybackBand(e.months)
                  : { color: COLOR_LOSS, label: "nie zwraca się" };
              return (
                <RankBar
                  key={e.row.id}
                  label={e.row.name}
                  subLabel={e.row.contractorName ?? undefined}
                  // „Nigdy” dostaje pełną długość osi: to najgorszy możliwy
                  // wynik, a nie brak danych. Brak danych zostaje `null` i
                  // rysuje się szrafurą.
                  value={e.months ?? (e.never ? payback.axisMax : null)}
                  max={payback.axisMax}
                  valueLabel={e.never ? "nigdy" : monthsLabel(e.months)}
                  detail={
                    e.never ? band.label : `nakład ${plnFull(e.row.setupCost)}`
                  }
                  color={band.color}
                  onClick={() => navigate(`/objects/${e.row.id}`)}
                />
              );
            })}
          </div>
        </div>
      </ChartCard>

      <ChartCard
        title="Struktura wg typu ochrony"
        description="Ten sam podział dwa razy: górny pasek to przychód, dolny koszt. Segment szerszy na dole niż na górze zjada marżę."
        tableData={{
          headers: ["Typ ochrony", "Obiekty", "Przychód", "Koszt", "Marża"],
          rows: byType.map((t) => [
            t.label,
            t.count,
            plnFull(t.revenue),
            t.withCost > 0 ? plnFull(t.cost) : DASH,
            t.withCost > 0 && t.revenue > 0
              ? pct(((t.revenue - t.cost) / t.revenue) * 100)
              : DASH,
          ]),
        }}
        empty={
          <p className="py-8 text-center text-sm text-slate-500">
            Brak obiektów w tym zakresie.
          </p>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Przychód
            </p>
            <ShareBar
              segments={byType.map((t, i) => ({
                key: t.key,
                label: t.label,
                value: t.revenue,
                color: tintOf(COLOR_REVENUE, i, byType.length),
              }))}
              formatValue={plnFull}
              ariaLabel="Udział typów ochrony w miesięcznym przychodzie"
            />
          </div>
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Koszt
            </p>
            <ShareBar
              segments={byType.map((t, i) => ({
                key: t.key,
                label: t.label,
                value: t.cost,
                color: tintOf(COLOR_COST, i, byType.length),
              }))}
              formatValue={plnFull}
              ariaLabel="Udział typów ochrony w miesięcznym koszcie"
              emptyLabel="koszty nieuzupełnione"
            />
          </div>
        </div>
      </ChartCard>

      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(CHIP_LABELS) as Chip[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChip(c)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              chip === c
                ? "border-slate-800 bg-slate-800 text-white"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            )}
          >
            {CHIP_LABELS[c]}
            <span
              className={cn(
                "ml-1.5 tabular-nums",
                chip === c ? "text-slate-300" : "text-slate-400"
              )}
            >
              {chipCounts[c]}
            </span>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <SortHeader label="Obiekt" sortKey="name" active={sort === "name"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Kontrahent" sortKey="contractor" active={sort === "contractor"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Typ" sortKey="type" active={sort === "type"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Status" sortKey="status" active={sort === "status"} dir={dir} onToggle={toggleSort} />
                <SortHeader
                  label="Handlowiec"
                  sortKey="salesperson"
                  active={sort === "salesperson"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Kursywą — opiekun odziedziczony po kontrahencie"
                />
                <SortHeader label="Przychód" sortKey="revenue" align="right" active={sort === "revenue"} dir={dir} onToggle={toggleSort} />
                <SortHeader
                  label="Koszt"
                  sortKey="cost"
                  align="right"
                  active={sort === "cost"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="„—” = koszt nieuzupełniony, a nie zero"
                />
                <SortHeader label="Zysk" sortKey="profit" align="right" active={sort === "profit"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Marża" sortKey="margin" active={sort === "margin"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Nakład" sortKey="setup" align="right" active={sort === "setup"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Zwrot" sortKey="payback" align="right" active={sort === "payback"} dir={dir} onToggle={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <ObjectRow key={r.id} row={r} onClick={() => navigate(`/objects/${r.id}`)} />
              ))}
              {tableRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-sm text-muted-foreground">
                    Brak obiektów spełniających kryteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Counter({
  color,
  label,
  value,
  dim,
}: {
  color: string;
  label: string;
  value: number;
  dim?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={cn("inline-block h-2.5 w-2.5 rounded-[3px]", dim && "opacity-50")}
        style={{ backgroundColor: color }}
      />
      <span className="font-semibold tabular-nums text-slate-900">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function ObjectRow({
  row,
  onClick,
}: {
  row: AnalyticsObjectRow;
  onClick: () => void;
}) {
  const never = row.hasCost && row.setupCost > 0 && row.profit <= 0;
  const sp = spLabel(row.salesperson);

  return (
    <tr
      onClick={onClick}
      className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
    >
      <td className="px-2 py-2">
        <div className="font-medium text-slate-800">{row.name}</div>
        {row.city && <div className="text-xs text-muted-foreground">{row.city}</div>}
      </td>
      <td className="px-2 py-2 text-muted-foreground">{row.contractorName ?? DASH}</td>
      <td className="px-2 py-2">{objectTypeLabels[row.type] ?? row.type}</td>
      <td className="px-2 py-2 text-muted-foreground">
        {statusLabels[row.status] ?? row.status}
      </td>
      <td className="px-2 py-2 text-muted-foreground">
        {sp ? (
          // Opiekun odziedziczony po kontrahencie nie jest przypisany do
          // obiektu — kursywa mówi, że to domysł, a nie decyzja.
          <span className={cn(row.salesperson?.inherited && "italic")}>{sp}</span>
        ) : (
          DASH
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{plnFull(row.revenue)}</td>
      <td className="px-2 py-2 text-right tabular-nums">
        {row.hasCost ? plnFull(row.cost) : <span className="text-slate-400">{DASH}</span>}
      </td>
      <td
        className={cn(
          "px-2 py-2 text-right font-medium tabular-nums",
          row.hasCost && row.profit < 0 && "text-red-600"
        )}
      >
        {row.hasCost ? plnFull(row.profit) : <span className="text-slate-400">{DASH}</span>}
      </td>
      <td className="px-2 py-2">
        <MarginGauge value={row.margin} size="sm" />
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {row.setupCost > 0 ? plnFull(row.setupCost) : DASH}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {never ? <span style={{ color: COLOR_LOSS }}>nigdy</span> : monthsLabel(row.payback)}
      </td>
    </tr>
  );
}
