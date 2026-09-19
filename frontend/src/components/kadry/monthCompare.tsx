/**
 * PORÓWNANIE MIESIĄC DO MIESIĄCA — różnica pod kaflem i lista „Największe zmiany".
 *
 * Kadrowa zamyka miesiąc porównując go z poprzednim: „czy wypłaty urosły
 * zgodnie z tym, co wiem o nadgodzinach", „kto doszedł", „komu nic nie
 * policzono". Dotąd trzeba było przełączyć miesiąc, zapisać liczby na kartce
 * i wrócić — a jedna pominięta osoba wychodzi dopiero przy przelewach.
 *
 * Porównujemy ZAWSZE do miesiąca bezpośrednio poprzedniego, nigdy do
 * „ostatniego, w którym coś jest": przeskok nad pustym lipcem robiłby
 * z różnicy sierpień–czerwiec coś, co wygląda jak różnica miesiąc do miesiąca.
 * Pusty poprzedni miesiąc mówimy wprost („brak danych za lipiec"), zamiast
 * pokazywać −100%.
 */
import { useMemo } from "react";
import { TrendingUp } from "lucide-react";
import { Section } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import { tip } from "@/components/ui/tooltip";
import type { HrPayrollRow, HrPrevPayrollRow } from "@/lib/api";
import { TEXT_TONE } from "./ui";
import { money } from "./shared";

/** Próg, powyżej którego różnica przestaje być szumem i dostaje kolor. */
const BIG_CHANGE_PCT = 10;

/**
 * „+3,1%" / „-12,0%" — znak zawsze, przecinek dziesiętny jak w kwotach.
 *
 * Minus jest ZWYKŁYM dywizem (U+002D), bo taki wstawia `Intl.NumberFormat`
 * przy kwotach — obok siebie („-52 407,41 zł (-92,2%)") dwa różne znaki minus
 * wyglądały jak literówka w jednym z nich.
 */
const pctLabel = (pct: number) =>
  `${pct > 0 ? "+" : pct < 0 ? "-" : ""}${Math.abs(pct)
    .toFixed(1)
    .replace(".", ",")}%`;

/** „+4 120,00 zł" — `money` samo daje minus, plus trzeba dopisać. */
const signedMoney = (v: number) => `${v > 0 ? "+" : ""}${money(v)}`;

/**
 * Różnica pod wartością kafla.
 *
 * `format` jest parametrem, bo ten sam klocek opisuje i kwoty, i godziny —
 * a „+18 h" sformatowane jako złotówki to inna informacja niż ta sama liczba.
 */
export function KpiDelta({
  value,
  prev,
  prevMonthLabel,
  prevHasData,
  prevNote,
  format = money,
  testId,
}: {
  value: number;
  /** Wartość z poprzedniego miesiąca; `undefined` = jeszcze nie wczytana. */
  prev: number | undefined;
  /** „sierpień 2026" — do dymka i do komunikatu o pustym miesiącu. */
  prevMonthLabel: string;
  /** Czy poprzedni miesiąc ma to rozliczenie (godziny / wypłaty / biuro). */
  prevHasData: boolean;
  /**
   * Zastrzeżenie do punktu odniesienia — dopisek w dymku, gdy poprzedni
   * miesiąc jest wprawdzie niepusty, ale niepełny (np. wypłaty bez ani jednej
   * kwoty od księgowości). Liczba zostaje prawdziwa, tylko wiadomo, z czego.
   */
  prevNote?: string;
  format?: (v: number) => string;
  testId?: string;
}) {
  if (prev === undefined) return null;

  // Miesiąc, w którym nic nie ma, nie jest spadkiem o 100% — jest brakiem
  // punktu odniesienia i tak się nazywa.
  if (!prevHasData) {
    return (
      <div
        className={cn("cursor-help text-[11px]", TEXT_TONE.muted)}
        data-testid={testId}
        {...tip(
          `Nie ma z czym porównać: ${prevMonthLabel} nie ma ani godzin, ani kwot. Porównujemy zawsze do miesiąca bezpośrednio poprzedniego.`,
        )}
      >
        brak danych za {prevMonthLabel}
      </div>
    );
  }

  const delta = value - prev;
  const hint = `${prevMonthLabel}: ${format(prev)}${prevNote ? ` — ${prevNote}` : ""}`;

  if (prev === 0) {
    return (
      <div
        className={cn("cursor-help text-[11px]", TEXT_TONE.muted)}
        data-testid={testId}
        {...tip(hint)}
      >
        {delta === 0
          ? `bez zmian (${prevMonthLabel}: 0)`
          : `z zera (${format(prev)})`}
      </div>
    );
  }

  if (delta === 0) {
    return (
      <div
        className={cn("cursor-help text-[11px]", TEXT_TONE.muted)}
        data-testid={testId}
        {...tip(hint)}
      >
        bez zmian
      </div>
    );
  }

  const pct = (delta / Math.abs(prev)) * 100;
  const big = Math.abs(pct) > BIG_CHANGE_PCT;
  return (
    <div
      className={cn(
        "cursor-help text-[11px] tabular-nums",
        big ? cn("font-medium", TEXT_TONE.warn) : TEXT_TONE.muted,
      )}
      data-testid={testId}
      {...tip(
        big
          ? `${hint} — zmiana ponad ${BIG_CHANGE_PCT}%, warto sprawdzić`
          : hint,
      )}
    >
      {`${delta > 0 ? "+" : ""}${format(delta)} (${pctLabel(pct)})`}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Największe zmiany
// ---------------------------------------------------------------------------

/** Ile pozycji w każdej z list — dłuższa lista przestaje być listą kontrolną. */
const TOP_N = 10;

export type PayrollChange = {
  contractId: number;
  employeeName: string;
  company: string;
  before: number;
  after: number;
  delta: number;
  /** `null` przy wejściu z zera — procent nie ma wtedy mianownika. */
  pct: number | null;
};

/**
 * Trzy listy z porównania wypłat: zmiany, nowi i zniknięci.
 *
 * Jednostką jest UMOWA (`contractId`), nie osoba: ktoś z ZUA w ALFIE i ZZA
 * w GUARD może mieć w jednym miesiącu wzrost, a w drugim spadek, i suma
 * ukryłaby obie zmiany. Nazwisko ze spółką w wierszu mówi, o którą umowę chodzi.
 */
function payrollChanges(
  rows: HrPayrollRow[],
  prev: HrPrevPayrollRow[],
): {
  changed: PayrollChange[];
  changedTotal: number;
  added: PayrollChange[];
  addedTotal: number;
  removed: PayrollChange[];
  removedTotal: number;
} {
  const prevByContract = new Map(prev.map((r) => [r.contractId, r]));
  const changed: PayrollChange[] = [];
  const added: PayrollChange[] = [];
  const removed: PayrollChange[] = [];

  for (const r of rows) {
    const before = prevByContract.get(r.contractId)?.wyplata ?? 0;
    const after = r.wyplata;
    const item: PayrollChange = {
      contractId: r.contractId,
      employeeName: r.employeeName,
      company: r.company,
      before,
      after,
      delta: Math.round((after - before) * 100) / 100,
      pct: before === 0 ? null : ((after - before) / Math.abs(before)) * 100,
    };
    if (before === 0 && after === 0) continue;
    if (before === 0) added.push(item);
    else if (after === 0) removed.push(item);
    else if (item.delta !== 0) changed.push(item);
  }

  // Umowa, która w tym miesiącu w ogóle nie weszła do tabeli (zakończona,
  // usunięta) — w poprzednim miała wypłatę, więc należy do „brak w tym miesiącu"
  // tak samo jak ta z zerem.
  const currentIds = new Set(rows.map((r) => r.contractId));
  for (const p of prev) {
    if (currentIds.has(p.contractId) || p.wyplata === 0) continue;
    removed.push({
      contractId: p.contractId,
      employeeName: p.employeeName,
      company: p.company,
      before: p.wyplata,
      after: 0,
      delta: -p.wyplata,
      pct: -100,
    });
  }

  const byAbsDelta = (a: PayrollChange, b: PayrollChange) =>
    Math.abs(b.delta) - Math.abs(a.delta);
  changed.sort(byAbsDelta);
  added.sort((a, b) => b.after - a.after);
  removed.sort((a, b) => b.before - a.before);
  // Obok listy idzie PEŁNA liczba pozycji: nagłówek „(10)" nad dziesięcioma
  // wierszami przy stu zmianach mówiłby, że zmian jest dziesięć.
  return {
    changed: changed.slice(0, TOP_N),
    changedTotal: changed.length,
    added: added.slice(0, TOP_N),
    addedTotal: added.length,
    removed: removed.slice(0, TOP_N),
    removedTotal: removed.length,
  };
}

/** „(10 z 47)" gdy lista jest przycięta, „(10)" gdy to całość. */
const groupCount = (shown: number, total: number) =>
  total > shown ? `${shown} z ${total}` : `${total}`;

function ChangeRow({
  item,
  kind,
  onPick,
}: {
  item: PayrollChange;
  kind: "changed" | "added" | "removed";
  onPick: (employeeName: string) => void;
}) {
  // Dwie linie, nie jedna: w kolumnie szerokiej na jedną trzecią ekranu
  // jednowierszowy układ ucinał NAZWISKA („Wach…", „Komore…"), czyli jedyną
  // rzecz, po której da się tę pozycję rozpoznać, a kwoty i tak wychodziły
  // poza kolumnę.
  return (
    <button
      type="button"
      onClick={() => onPick(item.employeeName)}
      data-testid="kadry-wynagrodzenia-zmiana"
      className="w-full rounded px-1 py-1 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      {...tip(`Pokaż w tabeli: ${item.employeeName}`)}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {item.employeeName}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {item.company}
        </span>
      </span>
      <span className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate tabular-nums text-muted-foreground">
          {money(item.before)} → {money(item.after)}
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap font-medium tabular-nums",
            kind === "removed" || item.delta < 0
              ? TEXT_TONE.bad
              : TEXT_TONE.good,
          )}
        >
          {signedMoney(item.delta)}
          {item.pct != null && (
            <span className="ml-1 font-normal text-muted-foreground">
              ({pctLabel(item.pct)})
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/**
 * Sekcja „Największe zmiany" — lista kontrolna przed zamknięciem miesiąca.
 *
 * Domyślnie zwinięta: przy normalnym miesiącu nie ma o czym czytać, a nad
 * tabelą wpisywania kwot każdy dodatkowy blok odsuwa pierwszy wiersz.
 */
export function PayrollChangesSection({
  rows,
  prev,
  prevMonthLabel,
  prevHasData,
  prevSettled,
  open,
  onToggle,
  onPick,
}: {
  rows: HrPayrollRow[];
  prev: HrPrevPayrollRow[];
  prevMonthLabel: string;
  prevHasData: boolean;
  /** Czy poprzedni miesiąc ma kwoty od księgowości, czy same premie z godzin. */
  prevSettled: boolean;
  open: boolean;
  onToggle: () => void;
  /** Klik w pozycję — szukajka tabeli dostaje nazwisko. */
  onPick: (employeeName: string) => void;
}) {
  const { changed, changedTotal, added, addedTotal, removed, removedTotal } =
    useMemo(() => payrollChanges(rows, prev), [rows, prev]);

  const summary = !prevHasData
    ? `${prevMonthLabel} — brak danych`
    : changedTotal + addedTotal + removedTotal === 0
      ? "bez zmian"
      : [
          changedTotal > 0 && `${changedTotal} zmian`,
          addedTotal > 0 && `${addedTotal} nowych`,
          removedTotal > 0 && `${removedTotal} bez wypłaty`,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <Section
      id="kadry-wynagrodzenia-zmiany"
      icon={TrendingUp}
      title={`Największe zmiany vs ${prevMonthLabel}`}
      summary={summary}
      open={open}
      onToggle={onToggle}
    >
      {!prevHasData ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="kadry-wynagrodzenia-zmiany-pusto"
        >
          {prevMonthLabel} nie ma ani godzin, ani kwot — nie ma z czym porównać.
          Porównujemy zawsze do miesiąca bezpośrednio poprzedniego, więc pusty
          poprzednik zostaje pusty zamiast przeskakiwać do wcześniejszego.
        </p>
      ) : changedTotal + addedTotal + removedTotal === 0 ? (
        <p className="text-sm text-muted-foreground">
          Żadna wypłata nie zmieniła się względem {prevMonthLabel}.
        </p>
      ) : (
        <>
          {!prevSettled && (
            // Nie chowamy listy — chowanie byłoby tą samą nieprawdą od drugiej
            // strony — tylko mówimy, na czym stoi: miesiąc bez kwot od
            // księgowości daje wzrosty rzędu tysięcy procent dla każdego.
            <p
              className={cn("mb-3 text-xs", TEXT_TONE.warn)}
              data-testid="kadry-wynagrodzenia-zmiany-nierozliczony"
            >
              {prevMonthLabel} nie ma ani jednej kwoty od księgowości — wypłaty
              tamtego miesiąca to same premie i wyrównania z godzin, więc każda
              różnica poniżej wygląda na skok. Punktem odniesienia jest stan
              tamtego miesiąca, nie prawdziwa lista płac.
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-3">
            <div data-testid="kadry-wynagrodzenia-zmiany-zmiany">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Zmiana wypłaty ({groupCount(changed.length, changedTotal)})
              </p>
              {changed.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">—</p>
              ) : (
                changed.map((it) => (
                  <ChangeRow
                    key={it.contractId}
                    item={it}
                    kind="changed"
                    onPick={onPick}
                  />
                ))
              )}
            </div>
            <div data-testid="kadry-wynagrodzenia-zmiany-nowi">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Nowi w tym miesiącu ({groupCount(added.length, addedTotal)})
              </p>
              {added.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">—</p>
              ) : (
                added.map((it) => (
                  <ChangeRow
                    key={it.contractId}
                    item={it}
                    kind="added"
                    onPick={onPick}
                  />
                ))
              )}
            </div>
            <div data-testid="kadry-wynagrodzenia-zmiany-brak">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Brak w tym miesiącu ({groupCount(removed.length, removedTotal)})
              </p>
              {removed.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">—</p>
              ) : (
                removed.map((it) => (
                  <ChangeRow
                    key={it.contractId}
                    item={it}
                    kind="removed"
                    onPick={onPick}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
