/**
 * Analityka → Handlowcy: „czy handlowiec zarabia na swój portfel”.
 *
 * Formuła jest jedna i cała zakładka ją rysuje:
 *   przychód portfela − koszt obiektów − koszt własny handlowca − prowizja
 * Wodospad pokazuje ją dosłownie, słupki rozbijają ją na osoby, a ranking ROI
 * odpowiada na najkrótszą wersję pytania: ile złotych marży przynosi złotówka
 * wydana na handlowca.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  getAnalyticsSalespeople,
  type AnalyticsSalespeopleData,
  type AnalyticsSalespersonRow,
  type AnalyticsScope,
  type CostWindow,
} from "@/lib/api";
import {
  ChartCard,
  COLOR_COST,
  COLOR_LOSS,
  COLOR_PROFIT,
  COLOR_SETUP,
  CoverageNote,
  DASH,
  KpiRow,
  KpiTile,
  MarginGauge,
  RankBar,
  StackedBarChart,
  WaterfallChart,
  pct,
  plnFull,
} from "@/components/analytics";
import {
  cmpNullLast,
  cmpText,
  costSplitLabel,
  matches,
  tintOf,
  useAnalyticsResource,
  type AnalyticsViewProps,
} from "./shared";
import { PersonnelFootnote, ResourceNotice, SortHeader } from "./parts";

const load = (scope: AnalyticsScope, costWindow: CostWindow) =>
  getAnalyticsSalespeople({ scope, costWindow });

/**
 * Koszt własny handlowca to też koszt, więc dostaje odcień tej samej barwy co
 * koszt obiektów — pochodzenie różni je w legendzie, nie osobny kolor.
 */
const COLOR_OWN_COST = tintOf(COLOR_COST, 1, 3);

type SortKey =
  | "name"
  | "region"
  | "contractors"
  | "objects"
  | "revenue"
  | "objectsCost"
  | "ownCost"
  | "commission"
  | "profit"
  | "margin"
  | "roi";

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  region: "asc",
  contractors: "desc",
  objects: "desc",
  revenue: "desc",
  objectsCost: "desc",
  ownCost: "desc",
  commission: "desc",
  profit: "desc",
  margin: "asc",
  roi: "desc",
};

/** ROI jako mnożnik: „×8,4”. Poniżej ×1 handlowiec nie zarabia na siebie. */
function roiLabel(roi: number | null): string {
  if (roi === null || !Number.isFinite(roi)) return DASH;
  return `×${roi.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}`;
}

/**
 * Zwrot na handlowcu: ile złotych MARŻY JEGO PORTFELA przypada na złotówkę tego,
 * co firma na niego wydaje (koszt własny + prowizja).
 *
 * Świadomie NIE bierzemy `roi` z API. Backend liczy tam `revenue / (ownCost +
 * commission)` — PRZYCHÓD na złotówkę kosztu — a cały ten ekran (opis karty,
 * nagłówek „Zwrot”, przypis, bliźniacza tabela z kolumną „Marża portfela”) mówi
 * o marży. Przy definicji przychodowej próg ×1 nic nie znaczy: portfel za 220 tys.
 * zł „zwracał” ×11 na zielono, choć po odjęciu kosztu obiektów przynosił firmie
 * stratę, a bliźniacza tabela w tym samym wierszu pokazywała ujemną marżę.
 *
 * Wybraliśmy definicję marżową, a nie zmianę opisu, bo próg ×1 jest tu jedyną
 * liczbą z twardym znaczeniem: poniżej niego marża portfela nie pokrywa kosztu
 * handlowca. `contribution` (przychód − koszt obiektów) jest już w wierszu.
 */
function roiOf(r: AnalyticsSalespersonRow): number | null {
  const cost = r.ownCost + r.commission;
  // Bez znanego kosztu handlowca nie ma czego dzielić — „×0” byłoby kłamstwem.
  if (cost <= 0) return null;
  // Portfel BEZ ANI JEDNEGO uzupełnionego kosztu obiektu ma `contribution`
  // równe przychodowi wyłącznie dlatego, że koszty policzyliśmy jako zero.
  // Zwrot z takiej marży byłby dokładnie tym samym zawyżeniem, które ta funkcja
  // naprawia — więc mówimy „nie wiem”, a nie zgadujemy.
  if (r.objectsCount > 0 && r.objectsWithCost === 0) return null;
  return r.contribution / cost;
}

export function HandlowcyView({
  scope,
  costWindow,
  search,
  reloadKey,
}: AnalyticsViewProps) {
  const navigate = useNavigate();
  const { data, state } = useAnalyticsResource<AnalyticsSalespeopleData>(
    load,
    scope,
    costWindow,
    reloadKey
  );
  const [sort, setSort] = useState<SortKey>("profit");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  /** Kogo rysuje wodospad: cały zespół albo jedna osoba. */
  const [focus, setFocus] = useState<number | "team">("team");

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

  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter((r) =>
        matches(search, `${r.firstName} ${r.lastName}`, r.region)
      ),
    [data, search]
  );

  const searching = search.trim().length > 0;

  /**
   * Sumy zespołu. Bez szukajki bierzemy je z backendu — zawierają też portfel
   * bez opiekuna, który jest częścią wyniku firmy. Po wpisaniu czegoś w
   * szukajkę liczymy z widocznych osób, żeby kafelki zgadzały się z tabelą;
   * portfel bez opiekuna wypada wtedy z sum (nie należy do nikogo z filtra).
   */
  const team = useMemo(() => {
    const t = data?.totals;
    if (!searching && t) {
      return {
        revenue: t.revenue,
        objectsCost: t.cost,
        // Koszt obiektów rozbity na część osobową (Kadry) i pozostałą (ręczną) —
        // te dwie liczby SUMUJĄ SIĘ do `objectsCost`.
        objectsPersonnelCost: t.personnelCost,
        objectsOtherCost: t.otherCost,
        ownCost: t.salespeopleCost,
        commission: t.commission,
        netProfit: t.netProfit,
        objects: t.objects,
        objectsWithCost: t.objectsWithCost,
        withUnassigned: true,
      };
    }
    const acc = rows.reduce(
      (a, r) => ({
        revenue: a.revenue + r.revenue,
        objectsCost: a.objectsCost + r.objectsCost,
        objectsPersonnelCost: a.objectsPersonnelCost + r.objectsPersonnelCost,
        objectsOtherCost: a.objectsOtherCost + r.objectsOtherCost,
        ownCost: a.ownCost + r.ownCost,
        commission: a.commission + r.commission,
        netProfit: a.netProfit + r.profit,
        objects: a.objects + r.objectsCount,
        objectsWithCost: a.objectsWithCost + r.objectsWithCost,
      }),
      {
        revenue: 0,
        objectsCost: 0,
        objectsPersonnelCost: 0,
        objectsOtherCost: 0,
        ownCost: 0,
        commission: 0,
        netProfit: 0,
        objects: 0,
        objectsWithCost: 0,
      }
    );
    return { ...acc, withUnassigned: false };
  }, [data, rows, searching]);

  /**
   * Czy w ogóle znamy JAKIKOLWIEK koszt tego zespołu — koszt obiektu, koszt własny
   * handlowca albo prowizję. Bez tego "zysk netto" równa się przychodowi wyłącznie
   * dlatego, że wszystkie potrącenia policzyliśmy jako zero, a "marża netto 100%"
   * byłaby dokładnie tym kłamstwem, przed którym broni się reszta modułu.
   * Backend pilnuje tego samego przy swoich sumach (marginOf w analytics.ts).
   */
  const hasAnyCost = team.objectsWithCost > 0 || team.ownCost > 0 || team.commission > 0;
  const netMargin =
    hasAnyCost && team.revenue > 0 ? (team.netProfit / team.revenue) * 100 : null;
  const hasCostData = team.objectsWithCost > 0;
  const coverageProps = {
    known: team.objectsWithCost,
    total: team.objects,
    noun: "obiektów",
    href: "/objects?hasCost=0",
  };

  /** Osoba pod wodospadem — albo cały zespół. */
  const focused = useMemo(
    () => (focus === "team" ? null : rows.find((r) => r.id === focus) ?? null),
    [focus, rows]
  );

  const waterfall = useMemo(() => {
    const src = focused
      ? {
          revenue: focused.revenue,
          objectsCost: focused.objectsCost,
          ownCost: focused.ownCost,
          commission: focused.commission,
          profit: focused.profit,
        }
      : {
          revenue: team.revenue,
          objectsCost: team.objectsCost,
          ownCost: team.ownCost,
          commission: team.commission,
          profit: team.netProfit,
        };
    return {
      steps: [
        { key: "revenue", label: "Przychód portfela", value: src.revenue },
        { key: "objects", label: "Koszt obiektów", value: -src.objectsCost },
        { key: "own", label: "Koszt handlowca", value: -src.ownCost },
        {
          key: "commission",
          label: "Prowizja",
          value: -src.commission,
          color: COLOR_SETUP,
        },
      ],
      total: { label: "Zysk netto", value: src.profit },
      src,
    };
  }, [focused, team]);

  /** Słupki per handlowiec — cztery kawałki jednego przychodu. */
  const stackedRows = useMemo(
    () =>
      [...rows]
        .sort((a, b) => b.revenue - a.revenue)
        .map((r) => ({
          id: String(r.id),
          label: `${r.firstName} ${r.lastName}`,
          subLabel: r.region ?? undefined,
          segments: [
            {
              key: "objects",
              label: "Koszt obiektów",
              value: r.objectsCost,
              color: COLOR_COST,
            },
            {
              key: "own",
              label: "Koszt własny",
              value: r.ownCost,
              color: COLOR_OWN_COST,
            },
            {
              key: "commission",
              label: "Prowizja",
              value: r.commission,
              color: COLOR_SETUP,
            },
            {
              key: "profit",
              label: "Zysk",
              value: Math.max(r.profit, 0),
              color: COLOR_PROFIT,
            },
          ],
          total: r.revenue,
          note:
            r.objectsCount > 0 && r.objectsWithCost === 0
              ? "koszt obiektów nieuzupełniony"
              : undefined,
        })),
    [rows]
  );

  /**
   * Ranking zwrotu — ile marży przynosi złotówka wydana na handlowca.
   * Sortowanie idzie po TEJ SAMEJ definicji co słupki i tabela (`roiOf`),
   * inaczej kolejność przeczyłaby pokazanym liczbom.
   */
  const roiRows = useMemo(
    () =>
      [...rows]
        .map((r) => ({ row: r, roi: roiOf(r) }))
        .sort((a, b) => cmpNullLast(a.roi, b.roi, "desc")),
    [rows]
  );
  // Skala zaczyna się od ×1, żeby próg był widoczny nawet wtedy, gdy nikt go nie
  // przekracza. Marża bywa ujemna — taki pasek i tak zostaje przy lewej krawędzi.
  const roiMax = useMemo(
    () => Math.max(1, ...roiRows.map((r) => r.roi ?? 0)),
    [roiRows]
  );
  /** Czy w rankingu jest ktoś, komu marżę zaniża nieuzupełniony koszt obiektów. */
  const roiPartialCoverage = useMemo(
    () => rows.some((r) => r.objectsWithCost > 0 && r.objectsWithCost < r.objectsCount),
    [rows]
  );

  const tableRows = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      switch (sort) {
        case "name":
          return cmpText(
            `${a.lastName} ${a.firstName}`,
            `${b.lastName} ${b.firstName}`,
            dir
          );
        case "region":
          return cmpText(a.region ?? "￿", b.region ?? "￿", dir);
        case "contractors":
          return dir === "asc"
            ? a.contractorsCount - b.contractorsCount
            : b.contractorsCount - a.contractorsCount;
        case "objects":
          return dir === "asc"
            ? a.objectsCount - b.objectsCount
            : b.objectsCount - a.objectsCount;
        case "revenue":
          return dir === "asc" ? a.revenue - b.revenue : b.revenue - a.revenue;
        case "objectsCost":
          return cmpNullLast(
            a.objectsWithCost > 0 ? a.objectsCost : null,
            b.objectsWithCost > 0 ? b.objectsCost : null,
            dir
          );
        case "ownCost":
          return dir === "asc" ? a.ownCost - b.ownCost : b.ownCost - a.ownCost;
        case "commission":
          return dir === "asc"
            ? a.commission - b.commission
            : b.commission - a.commission;
        case "profit":
          return dir === "asc" ? a.profit - b.profit : b.profit - a.profit;
        case "margin":
          return cmpNullLast(a.margin, b.margin, dir);
        case "roi":
          return cmpNullLast(roiOf(a), roiOf(b), dir);
        default:
          return 0;
      }
    });
    return out;
  }, [rows, sort, dir]);

  if (state !== "ready" || !data) {
    return <ResourceNotice state={state === "ready" ? "error" : state} />;
  }

  const unassigned = data.unassigned;

  return (
    <div className="space-y-3">
      <KpiRow>
        <KpiTile
          label="Przychód portfeli"
          value={plnFull(team.revenue)}
          sub={`${rows.length} ${rows.length === 1 ? "handlowiec" : "handlowców"} · ${team.objects} obiektów`}
          tip="Suma abonamentów obiektów przypisanych do handlowców (wraz z portfelem bez opiekuna)"
        />
        <KpiTile
          label="Koszt obiektów"
          value={hasCostData ? plnFull(team.objectsCost) : DASH}
          sub={
            hasCostData
              ? costSplitLabel(team.objectsPersonnelCost, team.objectsOtherCost)
              : "koszty nieuzupełnione"
          }
          tip="Koszt osobowy z Kadr + koszt pozostały z kartotek obiektów w portfelach"
          coverage={coverageProps}
        />
        <KpiTile
          label="Koszt handlowców"
          value={plnFull(team.ownCost)}
          sub="wynagrodzenie, auto, telefon"
          tip="Koszt własny handlowców — niezależny od kosztu obiektów. Dla osób powiązanych z Kadrami liczony z ich wypłat powiększonych o narzut składek pracodawcy."
        />
        <KpiTile
          label="Prowizje"
          value={plnFull(team.commission)}
          sub="naliczone od przychodu portfela"
          tip="Prowizja policzona ze stawki handlowca i przychodu jego portfela"
        />
        <KpiTile
          label="Zysk netto"
          value={hasAnyCost ? plnFull(team.netProfit) : DASH}
          tone={hasAnyCost ? (team.netProfit >= 0 ? "good" : "bad") : "neutral"}
          sub={
            hasAnyCost
              ? "przychód − obiekty − handlowcy − prowizje"
              : "uzupełnij koszty, żeby policzyć"
          }
          // „Netto" znaczy tu „po potrąceniach", a nie „bez VAT" — po dołożeniu
          // oznaczeń netto/brutto w całej aplikacji ta dwuznaczność musi zniknąć
          // z dymka, inaczej ktoś odczyta to jako kwotę do opodatkowania.
          tip="Wynik po wszystkich czterech potrąceniach. „Netto” znaczy tu „po kosztach” — z VAT-em nie ma to nic wspólnego, wszystkie kwoty i tak są bez VAT."
          coverage={coverageProps}
        />
        <KpiTile
          label="Marża netto"
          value={<MarginGauge value={netMargin} size="lg" />}
          sub={hasAnyCost ? "zysk netto / przychód" : "nieznana bez kosztów"}
          tip="Zysk po wszystkich potrąceniach podzielony przez przychód portfeli"
          coverage={coverageProps}
        />
      </KpiRow>

      <PersonnelFootnote personnel={data.personnel} />

      <ChartCard
        title="Od przychodu do zysku"
        description={
          focused
            ? `${focused.firstName} ${focused.lastName} — cztery potrącenia od przychodu portfela do zysku netto.`
            : "Cały zespół — cztery potrącenia od przychodu portfeli do zysku netto."
        }
        tableData={{
          headers: ["Krok", "Kwota"],
          rows: [
            ["Przychód portfela", plnFull(waterfall.src.revenue)],
            ["Koszt obiektów", plnFull(-waterfall.src.objectsCost)],
            ["Koszt handlowca", plnFull(-waterfall.src.ownCost)],
            ["Prowizja", plnFull(-waterfall.src.commission)],
            ["Zysk netto", plnFull(waterfall.src.profit)],
          ],
        }}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FocusChip
              active={focus === "team"}
              label="Zespół"
              onClick={() => setFocus("team")}
            />
            {rows.map((r) => (
              <FocusChip
                key={r.id}
                active={focus === r.id}
                label={`${r.firstName} ${r.lastName}`}
                onClick={() => setFocus(r.id)}
              />
            ))}
          </div>
          <WaterfallChart
            steps={waterfall.steps}
            total={waterfall.total}
            ariaLabel="Wodospad: przychód portfela pomniejszony kolejno o koszt obiektów, koszt własny handlowca i prowizję, aż do zysku netto"
          />
          {/* Krok „koszt obiektów” stoi na tylu obiektach, ile ma uzupełniony
              koszt — bez tej noty zerowe potrącenie czytałoby się jak wynik. */}
          <CoverageNote {...coverageProps} withIcon />
        </div>
      </ChartCard>

      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard
          title="Struktura przychodu handlowca"
          description="Długość paska to przychód portfela, podział to cztery pozycje formuły."
          tableData={{
            headers: [
              "Handlowiec",
              "Przychód",
              "Obiekty",
              "Własny",
              "Prowizja",
              "Zysk",
            ],
            rows: rows.map((r) => [
              `${r.firstName} ${r.lastName}`,
              plnFull(r.revenue),
              r.objectsWithCost > 0 ? plnFull(r.objectsCost) : DASH,
              plnFull(r.ownCost),
              plnFull(r.commission),
              plnFull(r.profit),
            ]),
          }}
          empty={
            <p className="py-8 text-center text-sm text-slate-500">
              Brak handlowców w tym zakresie.
            </p>
          }
        >
          <StackedBarChart
            rows={stackedRows}
            formatValue={plnFull}
            ariaLabel="Przychód każdego handlowca rozbity na koszt obiektów, koszt własny, prowizję i zysk"
            onRowClick={(r) => navigate(`/objects?salespersonId=${r.id}`)}
          />
        </ChartCard>

        <ChartCard
          title="Zwrot na handlowcu"
          description="Ile złotych marży portfela przypada na złotówkę kosztu handlowca."
          tableData={{
            headers: ["Handlowiec", "Zwrot", "Marża portfela", "Koszt handlowca"],
            rows: roiRows.map(({ row: r, roi }) => [
              `${r.firstName} ${r.lastName}`,
              roiLabel(roi),
              plnFull(r.contribution),
              plnFull(r.ownCost + r.commission),
            ]),
          }}
          empty={
            <p className="py-8 text-center text-sm text-slate-500">
              Brak handlowców w tym zakresie.
            </p>
          }
        >
          <div className="space-y-3">
            <div className="space-y-1">
              {roiRows.map(({ row: r, roi }) => (
                <RankBar
                  key={r.id}
                  label={`${r.firstName} ${r.lastName}`}
                  subLabel={r.region ?? undefined}
                  value={roi}
                  max={roiMax}
                  valueLabel={roiLabel(roi)}
                  detail={`marża ${plnFull(r.contribution)}`}
                  // Poniżej ×1 marża portfela nie pokrywa nawet kosztu
                  // handlowca — to nie „słabszy wynik”, tylko strata.
                  color={roi !== null && roi < 1 ? COLOR_LOSS : COLOR_PROFIT}
                  onClick={() => navigate(`/objects?salespersonId=${r.id}`)}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Poniżej{" "}
              <span className="font-medium" style={{ color: COLOR_LOSS }}>
                ×1
              </span>{" "}
              handlowiec nie zarabia na siebie: marża jego portfela (przychód
              minus koszt obiektów) jest mniejsza niż jego koszt własny wraz z
              prowizją.
              {roiPartialCoverage && (
                <>
                  {" "}
                  Marża stoi na obiektach z uzupełnionym kosztem — dopóki
                  brakuje któregoś, zwrot jest zawyżony.
                </>
              )}
            </p>
            <CoverageNote {...coverageProps} withIcon />
          </div>
        </ChartCard>
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <SortHeader label="Handlowiec" sortKey="name" active={sort === "name"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Region" sortKey="region" active={sort === "region"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Kontrahenci" sortKey="contractors" align="right" active={sort === "contractors"} dir={dir} onToggle={toggleSort} />
                <SortHeader
                  label="Obiekty"
                  sortKey="objects"
                  align="right"
                  active={sort === "objects"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Wszystkie / z uzupełnionym kosztem"
                />
                <SortHeader label="Przychód" sortKey="revenue" align="right" active={sort === "revenue"} dir={dir} onToggle={toggleSort} />
                <SortHeader
                  label="Koszt obiektów"
                  sortKey="objectsCost"
                  align="right"
                  active={sort === "objectsCost"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Koszt osobowy (z Kadr) + pozostały (kartoteki obiektów); „—” = żaden obiekt portfela nie ma uzupełnionego kosztu"
                />
                <SortHeader
                  label="Koszt własny"
                  sortKey="ownCost"
                  align="right"
                  active={sort === "ownCost"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="„z Kadr” = liczone z wypłat powiązanego pracownika; bez dopisku = kwota wpisana ręcznie"
                />
                <SortHeader label="Prowizja" sortKey="commission" align="right" active={sort === "commission"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Zysk" sortKey="profit" align="right" active={sort === "profit"} dir={dir} onToggle={toggleSort} />
                <SortHeader label="Marża" sortKey="margin" active={sort === "margin"} dir={dir} onToggle={toggleSort} />
                <SortHeader
                  label="Zwrot"
                  sortKey="roi"
                  align="right"
                  active={sort === "roi"}
                  dir={dir}
                  onToggle={toggleSort}
                  tip="Marża portfela (przychód − koszt obiektów) / koszt handlowca z prowizją; poniżej ×1 nie zarabia na siebie"
                />
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <SalespersonRow
                  key={r.id}
                  row={r}
                  onClick={() => navigate(`/objects?salespersonId=${r.id}`)}
                />
              ))}
              {tableRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-sm text-muted-foreground">
                    Brak handlowców spełniających kryteria.
                  </td>
                </tr>
              )}

              {/* Portfel bez opiekuna — przychód, którego nikt nie prowadzi.
                  Nie wolno go doliczyć do żadnej osoby ani ukryć: to jedyne
                  miejsce, w którym w ogóle widać, że istnieje. */}
              {unassigned.objectsCount > 0 && !searching && (
                <tr
                  onClick={() => navigate("/objects?salespersonId=none")}
                  className="cursor-pointer border-t-2 bg-amber-50/60 transition-colors hover:bg-amber-50"
                >
                  <td className="px-2 py-2 font-medium text-amber-700">Bez handlowca</td>
                  <td className="px-2 py-2 text-muted-foreground">{DASH}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                    {DASH}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {unassigned.objectsCount}
                    <span className="text-muted-foreground">
                      {" "}
                      / {unassigned.objectsWithCost}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {plnFull(unassigned.revenue)}
                  </td>
                  <td
                    className="px-2 py-2 text-right tabular-nums"
                    title={
                      unassigned.objectsWithCost > 0
                        ? `Koszt osobowy (z Kadr): ${plnFull(unassigned.objectsPersonnelCost)} · koszt pozostały: ${plnFull(unassigned.objectsOtherCost)}`
                        : "Żaden obiekt bez opiekuna nie ma uzupełnionego kosztu"
                    }
                  >
                    {unassigned.objectsWithCost > 0 ? (
                      <>
                        {plnFull(unassigned.objectsCost)}
                        {unassigned.objectsPersonnelCost > 0 && (
                          <span className="block text-xs font-normal text-muted-foreground">
                            os. {plnFull(unassigned.objectsPersonnelCost)} · poz.{" "}
                            {plnFull(unassigned.objectsOtherCost)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-400">{DASH}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                    {DASH}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                    {DASH}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right font-medium tabular-nums",
                      unassigned.objectsWithCost > 0 &&
                        unassigned.profit < 0 &&
                        "text-red-600"
                    )}
                  >
                    {unassigned.objectsWithCost > 0 ? (
                      plnFull(unassigned.profit)
                    ) : (
                      <span className="text-slate-400">{DASH}</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <MarginGauge value={unassigned.margin} size="sm" />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                    {DASH}
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

function FocusChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-sm transition-colors",
        active
          ? "border-slate-800 bg-slate-800 text-white"
          : "border-slate-200 text-slate-600 hover:bg-slate-50"
      )}
    >
      {label}
    </button>
  );
}

function SalespersonRow({
  row,
  onClick,
}: {
  row: AnalyticsSalespersonRow;
  onClick: () => void;
}) {
  const knownCost = row.objectsWithCost > 0;
  const roi = roiOf(row);
  return (
    <tr
      onClick={onClick}
      className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
    >
      <td className="px-2 py-2">
        <div className="font-medium text-slate-800">
          {row.firstName} {row.lastName}
        </div>
        {!row.active && (
          <div className="text-xs text-muted-foreground">archiwalny</div>
        )}
      </td>
      <td className="px-2 py-2 text-muted-foreground">{row.region ?? DASH}</td>
      <td className="px-2 py-2 text-right tabular-nums">{row.contractorsCount}</td>
      <td className="px-2 py-2 text-right tabular-nums">
        {row.objectsCount}
        <span className="text-muted-foreground"> / {row.objectsWithCost}</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{plnFull(row.revenue)}</td>
      <td
        className="px-2 py-2 text-right tabular-nums"
        title={
          knownCost
            ? `Koszt osobowy (z Kadr): ${plnFull(row.objectsPersonnelCost)} · koszt pozostały (kartoteki obiektów): ${plnFull(row.objectsOtherCost)}`
            : "Żaden obiekt portfela nie ma uzupełnionego kosztu"
        }
      >
        {knownCost ? (
          <>
            {plnFull(row.objectsCost)}
            {row.objectsPersonnelCost > 0 && (
              <span className="block text-xs font-normal text-muted-foreground">
                os. {plnFull(row.objectsPersonnelCost)} · poz.{" "}
                {plnFull(row.objectsOtherCost)}
              </span>
            )}
          </>
        ) : (
          <span className="text-slate-400">{DASH}</span>
        )}
      </td>
      {/* Przy powiązaniu z Kadrami kwota pochodzi z WYPŁAT, a ręczne
          `monthly_cost` jest ignorowane (inaczej ta sama osoba kosztowałaby
          firmę dwa razy). Pokazywanie tu kwoty ręcznej byłoby więc podaniem
          liczby, która nie bierze udziału w żadnym wyniku na tym ekranie. */}
      <td
        className="px-2 py-2 text-right tabular-nums"
        title={
          row.ownCostSource === "kadry"
            ? `Liczone z wypłat w Kadrach, powiększonych o narzut składek pracodawcy${
                row.manualMonthlyCost !== null
                  ? `; pole ręczne (${plnFull(row.manualMonthlyCost)}) jest wtedy ignorowane`
                  : ""
              }`
            : "Kwota wpisana ręcznie w kartotece handlowca"
        }
      >
        {plnFull(row.ownCost)}
        {row.ownCostSource === "kadry" && (
          <span className="block text-xs font-normal text-muted-foreground">
            z Kadr
          </span>
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {plnFull(row.commission)}
        {row.commissionRate !== null && (
          <span className="text-muted-foreground"> ({pct(row.commissionRate)})</span>
        )}
      </td>
      <td
        className={cn(
          "px-2 py-2 text-right font-medium tabular-nums",
          row.profit < 0 && "text-red-600"
        )}
      >
        {plnFull(row.profit)}
      </td>
      <td className="px-2 py-2">
        <MarginGauge value={row.margin} size="sm" />
      </td>
      {/* Ta sama definicja co w rankingu obok — `roiOf`, nie `row.roi` z API. */}
      <td
        className={cn(
          "px-2 py-2 text-right font-medium tabular-nums",
          roi !== null && roi < 1 && "text-red-600"
        )}
        title={
          roi === null
            ? "Zwrotu nie da się policzyć: brak kosztu handlowca albo żaden obiekt portfela nie ma uzupełnionego kosztu"
            : `Marża portfela ${plnFull(row.contribution)} / koszt handlowca ${plnFull(row.ownCost + row.commission)}`
        }
      >
        {roiLabel(roi)}
      </td>
    </tr>
  );
}
