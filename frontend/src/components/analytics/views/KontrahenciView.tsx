/**
 * Analityka → Kontrahenci: „kto realnie zarabia”.
 *
 * Lista kontrahentów w CRM mówi, kto z nami współpracuje. Ta zakładka mówi,
 * ilu z nich na siebie zarabia — i to jest inne pytanie: największy przychód
 * bywa najgorszą marżą, a ranking rentowności jest posortowany rosnąco,
 * bo aktualny jest jego lewy koniec, nie prawy.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  getAnalyticsContractors,
  type AnalyticsContractorRow,
  type AnalyticsContractorsData,
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
  RankBarDiverging,
  ShareBar,
  StackedBarChart,
  monthsLabel,
  pct,
  plnFull,
  type StackedRow,
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

/** Stabilna tożsamość dla efektu w `useAnalyticsResource`. */
const load = (scope: AnalyticsScope) => getAnalyticsContractors({ scope });

type SortKey =
  | "name"
  | "salesperson"
  | "objects"
  | "revenue"
  | "cost"
  | "profit"
  | "margin"
  | "share"
  | "setup"
  | "payback";

/** Kwoty ludzie czytają od największej, nazwy od A. */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  salesperson: "asc",
  objects: "desc",
  revenue: "desc",
  cost: "desc",
  profit: "desc",
  margin: "asc",
  share: "desc",
  setup: "desc",
  payback: "asc",
};

export function KontrahenciView({ scope, search, reloadKey }: AnalyticsViewProps) {
  const navigate = useNavigate();
  const { data, state } = useAnalyticsResource<AnalyticsContractorsData>(
    load,
    scope,
    reloadKey
  );
  const [sort, setSort] = useState<SortKey>("revenue");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const toggleSort = useCallback(
    (key: string) => {
      const k = key as SortKey;
      setSort((prev) => {
        if (prev === k) {
          setDir((d) => (d === "asc" ? "desc" : "asc"));
          return prev;
        }
        setDir(DEFAULT_DIR[k]);
        return k;
      });
    },
    []
  );

  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter((r) =>
        matches(search, r.name, r.city, spLabel(r.salesperson))
      ),
    [data, search]
  );

  // Sumy liczymy z widocznych wierszy — po wpisaniu czegoś w szukajkę kafelki
  // muszą mówić o tym samym zbiorze, co tabela pod nimi.
  const agg = useMemo(
    () =>
      aggregate(
        rows.map((r) => ({
          objects: r.objectsCount,
          withCost: r.objectsWithCost,
          revenue: r.revenue,
          cost: r.cost,
          profit: r.profit,
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

  // Udział w przychodzie liczymy raz — używa go i tabela, i wykres koncentracji.
  const shareOf = useCallback(
    (revenue: number) => (agg.revenue > 0 ? (revenue / agg.revenue) * 100 : 0),
    [agg.revenue]
  );

  /** Koncentracja przychodu: HHI-lite = Σ (udział)². */
  const concentration = useMemo(() => {
    if (agg.revenue <= 0) return null;
    const hhi = rows.reduce((s, r) => {
      const share = r.revenue / agg.revenue;
      return s + share * share;
    }, 0);
    const top3 = [...rows]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 3)
      .reduce((s, r) => s + r.revenue, 0);
    // Progi jak w klasycznym HHI (0,15 / 0,25). Liczba sama w sobie nikomu nic
    // nie mówi, więc na ekran idzie tylko słowo.
    const verdict =
      hhi >= 0.25 ? "wysoka" : hhi >= 0.15 ? "średnia" : "niska";
    return { hhi, top3Share: (top3 / agg.revenue) * 100, verdict };
  }, [rows, agg.revenue]);

  /** Top 10 — wg zysku, gdy jest z czego, inaczej wg przychodu. */
  const topRows = useMemo<StackedRow[]>(() => {
    const sorted = [...rows].sort((a, b) =>
      hasCostData ? b.profit - a.profit : b.revenue - a.revenue
    );
    return sorted.slice(0, 10).map((r) => {
      const partial = r.objectsWithCost > 0 && r.objectsWithCost < r.objectsCount;
      return {
        id: String(r.id),
        label: r.name,
        subLabel: spLabel(r.salesperson) ?? r.city ?? undefined,
        // Brak kosztu = brak segmentów: wykres narysuje wtedy szrafurę na całym
        // przychodzie zamiast udawać 100% marży.
        segments:
          r.objectsWithCost > 0
            ? [
                { key: "cost", label: "Koszt", value: r.cost, color: COLOR_COST },
                {
                  key: "profit",
                  label: "Zysk",
                  value: Math.max(r.profit, 0),
                  color: COLOR_PROFIT,
                },
              ]
            : [],
        total: r.revenue,
        note:
          r.objectsWithCost === 0
            ? "brak danych kosztowych"
            : partial
              ? `koszt z ${r.objectsWithCost} z ${r.objectsCount} obiektów`
              : undefined,
      };
    });
  }, [rows, hasCostData]);

  /** Ranking marży — rosnąco, bo działania wymaga dół tabeli, nie góra. */
  const marginRows = useMemo(
    () =>
      rows
        .filter((r) => r.margin !== null)
        .sort((a, b) => (a.margin as number) - (b.margin as number)),
    [rows]
  );
  const marginAbsMax = useMemo(
    () =>
      marginRows.reduce((m, r) => Math.max(m, Math.abs(r.margin as number)), 0),
    [marginRows]
  );

  const tableRows = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      switch (sort) {
        case "name":
          return cmpText(a.name, b.name, dir);
        case "salesperson":
          return cmpText(
            spLabel(a.salesperson) ?? "￿",
            spLabel(b.salesperson) ?? "￿",
            dir
          );
        case "objects":
          return dir === "asc"
            ? a.objectsCount - b.objectsCount
            : b.objectsCount - a.objectsCount;
        case "revenue":
        case "share":
          return dir === "asc" ? a.revenue - b.revenue : b.revenue - a.revenue;
        case "setup":
          return dir === "asc" ? a.setupCost - b.setupCost : b.setupCost - a.setupCost;
        // Koszt, zysk i marża są nieznane przy nieuzupełnionym koszcie —
        // takie wiersze lądują na końcu niezależnie od kierunku.
        case "cost":
          return cmpNullLast(
            a.objectsWithCost > 0 ? a.cost : null,
            b.objectsWithCost > 0 ? b.cost : null,
            dir
          );
        case "profit":
          return cmpNullLast(
            a.objectsWithCost > 0 ? a.profit : null,
            b.objectsWithCost > 0 ? b.profit : null,
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
  }, [rows, sort, dir]);

  if (state !== "ready" || !data) {
    return <ResourceNotice state={state === "ready" ? "error" : state} />;
  }

  return (
    <div className="space-y-3">
      <KpiRow>
        <KpiTile
          label="Przychód mies."
          value={plnFull(agg.revenue)}
          sub={`${rows.length} ${rows.length === 1 ? "kontrahent" : "kontrahentów"} · ${agg.objects} obiektów`}
          tip="Suma abonamentów miesięcznych obiektów przypisanych do kontrahentów"
        />
        <KpiTile
          label="Koszt mies."
          value={hasCostData ? plnFull(agg.cost) : DASH}
          sub={hasCostData ? undefined : "koszty nieuzupełnione"}
          tip="Suma kosztów miesięcznych obiektów. Koszt nieuzupełniony liczy się jak zero — patrz pokrycie."
          coverage={coverageProps}
        />
        <KpiTile
          label="Zysk mies."
          value={hasCostData ? plnFull(agg.profit) : DASH}
          tone={!hasCostData ? "neutral" : agg.profit >= 0 ? "good" : "bad"}
          sub={hasCostData ? "przychód − koszt" : "uzupełnij koszty, żeby policzyć"}
          tip="Przychód minus koszt miesięczny. Liczony tylko z obiektów z uzupełnionym kosztem."
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
          label="Śr. przychód / kontrahenta"
          value={plnFull(rows.length > 0 ? agg.revenue / rows.length : null)}
          sub={
            data.contractorsWithoutObjects > 0
              ? `${data.contractorsWithoutObjects} bez obiektów (poza rankingiem)`
              : "liczony z kontrahentów z obiektami"
          }
          tip="Przychód miesięczny podzielony przez liczbę kontrahentów w zakresie"
        />
        <KpiTile
          label="Pokrycie kosztami"
          value={pct(agg.coverage * 100)}
          tone={agg.coverage >= 1 ? "good" : agg.coverage > 0 ? "warn" : "bad"}
          sub={`${agg.objectsWithCost} z ${agg.objects} obiektów`}
          tip="Ile obiektów ma uzupełniony koszt miesięczny. Wszystkie liczby zysku i marży stoją na tej próbce."
          onClick={() => navigate("/objects?hasCost=0")}
        />
      </KpiRow>

      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard
          title={
            hasCostData
              ? "Top 10 kontrahentów wg zysku"
              : "Top 10 kontrahentów wg przychodu"
          }
          description={
            hasCostData
              ? "Długość paska to przychód, podział wewnątrz to koszt i zysk."
              : "Koszt nieuzupełniony — paski pokazują sam przychód, bez podziału."
          }
          tableData={{
            headers: ["Kontrahent", "Przychód", "Koszt", "Zysk", "Marża"],
            rows: topRows.map((r) => {
              const src = rows.find((x) => String(x.id) === r.id)!;
              const known = src.objectsWithCost > 0;
              return [
                src.name,
                plnFull(src.revenue),
                known ? plnFull(src.cost) : DASH,
                known ? plnFull(src.profit) : DASH,
                pct(src.margin),
              ];
            }),
          }}
          empty={
            <p className="py-8 text-center text-sm text-slate-500">
              Brak kontrahentów w tym zakresie.
            </p>
          }
        >
          <StackedBarChart
            rows={topRows}
            formatValue={plnFull}
            ariaLabel="Dziesięciu kontrahentów o największym zysku miesięcznym: długość paska to przychód, podział wewnątrz paska to koszt i zysk"
            onRowClick={(r) => navigate(`/objects?contractorId=${r.id}`)}
          />
        </ChartCard>

        <ChartCard
          title="Koncentracja przychodu"
          description={
            concentration
              ? `Top 3 = ${pct(concentration.top3Share)} przychodu — ${concentration.verdict} koncentracja.`
              : "Brak przychodu w tym zakresie."
          }
          tableData={{
            headers: ["Kontrahent", "Przychód", "Udział"],
            rows: [...rows]
              .sort((a, b) => b.revenue - a.revenue)
              .map((r) => [r.name, plnFull(r.revenue), pct(shareOf(r.revenue))]),
          }}
          empty={
            <p className="py-8 text-center text-sm text-slate-500">
              Brak przychodu w tym zakresie.
            </p>
          }
        >
          <div className="space-y-4 pt-2">
            <ShareBar
              segments={[...rows]
                .sort((a, b) => b.revenue - a.revenue)
                .map((r, i, arr) => ({
                  key: String(r.id),
                  label: r.name,
                  value: r.revenue,
                  // Odcienie jednej barwy przychodu — segmenty to tożsamości,
                  // nie osobne znaczenia finansowe.
                  color: tintOf(COLOR_REVENUE, i, Math.min(arr.length, 6)),
                }))}
              maxSegments={6}
              formatValue={plnFull}
              ariaLabel="Udział poszczególnych kontrahentów w miesięcznym przychodzie"
            />
            {concentration && (
              <p className="text-sm text-muted-foreground">
                Im wyżej skupiony przychód, tym mocniej wynik firmy zależy od
                jednego klienta. Tu jest{" "}
                <span className="font-medium text-slate-800">
                  {concentration.verdict}
                </span>
                : trzej najwięksi odpowiadają za {pct(concentration.top3Share)}{" "}
                miesięcznych wpływów.
              </p>
            )}
          </div>
        </ChartCard>
      </div>

      <ChartCard
        title="Marża wg kontrahenta"
        description="Rosnąco — na górze ci, na których dokładamy."
        tableData={{
          headers: ["Kontrahent", "Marża", "Zysk mies."],
          rows: marginRows.map((r) => [r.name, pct(r.margin), plnFull(r.profit)]),
        }}
        isEmpty={!hasCostData || marginRows.length === 0}
        empty={
          hasCostData ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Żaden kontrahent w tym zakresie nie ma policzonej marży.
            </p>
          ) : (
            <NoCostEmpty what="marży kontrahentów" />
          )
        }
      >
        <div className="space-y-1">
          {marginRows.map((r) => (
            <RankBarDiverging
              key={r.id}
              label={r.name}
              subLabel={spLabel(r.salesperson) ?? undefined}
              value={r.margin}
              absMax={marginAbsMax}
              valueLabel={pct(r.margin)}
              detail={plnFull(r.profit)}
              onClick={() => navigate(`/objects?contractorId=${r.id}`)}
            />
          ))}
        </div>
      </ChartCard>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <SortHeader
                  label="Kontrahent"
                  sortKey="name"
                  active={sort === "name"}
                  dir={dir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label="Handlowiec"
                  sortKey="salesperson"
                  active={sort === "salesperson"}
                  dir={dir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label="Obiekty"
                  sortKey="objects"
                  align="right"
                  active={sort === "objects"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Wszystkie obiekty / z uzupełnionym kosztem"
                />
                <SortHeader
                  label="Przychód"
                  sortKey="revenue"
                  align="right"
                  active={sort === "revenue"}
                  dir={dir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label="Koszt"
                  sortKey="cost"
                  align="right"
                  active={sort === "cost"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Suma kosztów miesięcznych obiektów; „—” gdy żaden nie ma kosztu"
                />
                <SortHeader
                  label="Zysk"
                  sortKey="profit"
                  align="right"
                  active={sort === "profit"}
                  dir={dir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label="Marża"
                  sortKey="margin"
                  active={sort === "margin"}
                  dir={dir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label="Udział"
                  sortKey="share"
                  align="right"
                  active={sort === "share"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Udział kontrahenta w miesięcznym przychodzie"
                />
                <SortHeader
                  label="Nakład"
                  sortKey="setup"
                  align="right"
                  active={sort === "setup"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Jednorazowy koszt instalacji"
                />
                <SortHeader
                  label="Zwrot"
                  sortKey="payback"
                  align="right"
                  active={sort === "payback"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Po ilu miesiącach zysk pokryje nakład"
                />
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <ContractorRow
                  key={r.id}
                  row={r}
                  share={shareOf(r.revenue)}
                  onClick={() => navigate(`/objects?contractorId=${r.id}`)}
                />
              ))}
              {tableRows.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    Brak kontrahentów spełniających kryteria.
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

function ContractorRow({
  row,
  share,
  onClick,
}: {
  row: AnalyticsContractorRow;
  share: number;
  onClick: () => void;
}) {
  const known = row.objectsWithCost > 0;
  // Zysk <= 0 przy poniesionym nakładzie nigdy się nie zwróci — backend daje
  // wtedy null, ale „—” czytałoby się jak „nie policzyliśmy”.
  const never = known && row.setupCost > 0 && row.profit <= 0;

  return (
    <tr
      onClick={onClick}
      className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
    >
      <td className="px-2 py-2">
        <div className="font-medium text-slate-800">{row.name}</div>
        {row.city && <div className="text-xs text-muted-foreground">{row.city}</div>}
      </td>
      <td className="px-2 py-2 text-muted-foreground">
        {spLabel(row.salesperson) ?? DASH}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {row.objectsCount}
        <span className="text-muted-foreground"> / {row.objectsWithCost}</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{plnFull(row.revenue)}</td>
      <td className="px-2 py-2 text-right tabular-nums">
        {known ? plnFull(row.cost) : <span className="text-slate-400">{DASH}</span>}
      </td>
      <td
        className={cn(
          "px-2 py-2 text-right font-medium tabular-nums",
          known && row.profit < 0 && "text-red-600"
        )}
      >
        {known ? plnFull(row.profit) : <span className="text-slate-400">{DASH}</span>}
      </td>
      <td className="px-2 py-2">
        <MarginGauge value={row.margin} size="sm" />
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{pct(share)}</td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {row.setupCost > 0 ? plnFull(row.setupCost) : DASH}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {never ? (
          <span style={{ color: COLOR_LOSS }}>nigdy</span>
        ) : (
          monthsLabel(row.payback)
        )}
      </td>
    </tr>
  );
}
