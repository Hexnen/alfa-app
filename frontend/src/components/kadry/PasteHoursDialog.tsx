// „Wklej z arkusza" — godziny miesiąca z grafiku kierownika.
//
// Godziny powstają poza aplikacją: kierownik prowadzi grafik w Excelu i dopiero
// jego sumy trafiają do Kadr. Dotąd jedyną drogą było przepisanie kilkuset
// liczb komórka po komórce. Tutaj: wklejka TSV/CSV, dopasowanie po nazwisku
// (i po obiekcie/dziale, gdy ktoś ma w miesiącu kilka wpisów), PODGLĄD
// z licznikami PRZED zapisem i dopiero potem jeden zapis zbiorczy.
//
// Wzorzec i świadome decyzje jak w `PasteAmountsDialog` (kwoty od księgowości):
// wiersz, którego nie da się jednoznacznie dopasować, NIE jest zapisywany po
// cichu — albo człowiek wskazuje wpis z listy, albo wiersz wypada z zapisu
// i widać go w podsumowaniu.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check } from "lucide-react";
import { bulkSaveHrHours, type HrHoursEntry, type HrPortalKey } from "@/lib/api";
import { hrs, nameKey, normName, TABLE_SELECT_CLS } from "./shared";

/** Kolumny liczbowe wklejki — w tej kolejności stoją w arkuszu. */
const NUM_COLUMNS = ["workedHours", "uwHours", "l4Hours", "nightHours"] as const;
type NumColumn = (typeof NUM_COLUMNS)[number];

/**
 * Godziny z arkusza: „168", „168,5", „7.5" → liczba; „—", „" → null (pole
 * pominięte, czyli NIETKNIĘTE przy zapisie); wszystko inne → `undefined`
 * (nieliczbowe, wiersz do poprawy).
 *
 * `Number` przepuszcza „0x10" i „1e3" — w grafiku godzin to nie są godziny,
 * więc kształt sprawdzamy wyrażeniem regularnym, a nie samym `Number.isFinite`.
 */
function parseHoursCell(raw: string): number | null | undefined {
  const t = raw.replace(/[\s\u00a0\u202f]/g, "").replace(/h$/i, "").replace(",", ".");
  if (t === "" || t === "-" || t === "—") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Czy komórka w ogóle wygląda na liczbę (rozpoznanie kolumny „obiekt/dział"). */
const looksNumeric = (raw: string) => parseHoursCell(raw) !== undefined && raw.trim() !== "";

type Status = "ok" | "ambiguous" | "unknown" | "empty" | "nan" | "duplicate";

interface ParsedLine {
  index: number;
  name: string;
  /** Kolumna „obiekt / dział", gdy jest — zawęża wybór przy kilku wpisach osoby. */
  assignment: string | null;
  values: Partial<Record<NumColumn, number | null>>;
  status: Status;
  /** Kandydaci przy niejednoznaczności (kilka wpisów tej samej osoby w miesiącu). */
  candidates: HrHoursEntry[];
  /** Wskazany wpis — automatycznie albo ręcznie z listy. */
  rowId: number | null;
}

/** Etykieta wpisu na liście wyboru: po czym człowiek ma go poznać. */
const rowLabel = (r: HrHoursEntry) =>
  [r.objectName, r.departmentName].filter(Boolean).join(" · ") || "bez przypisania";

export function PasteHoursDialog({
  open,
  onClose,
  rows,
  year,
  month,
  portal = null,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Wpisy godzin miesiąca — do nich dopasowujemy wklejone wiersze. */
  rows: HrHoursEntry[];
  year: number;
  month: number;
  portal?: HrPortalKey | null;
  /** Zapisano — rodzic przeładowuje miesiąc. */
  onSaved: (saved: number) => void;
}) {
  const [text, setText] = useState("");
  const [manual, setManual] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byName = useMemo(() => {
    const m = new Map<string, HrHoursEntry[]>();
    for (const r of rows) {
      const k = nameKey(r.employeeName);
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
    return m;
  }, [rows]);

  const lines = useMemo<ParsedLine[]>(() => {
    const out: ParsedLine[] = [];
    const raws = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    raws.forEach((raw, index) => {
      // Tabulator to naturalny separator kopiowania z Excela; średnik ratuje
      // CSV z polskiego Excela. Przecinka NIE traktujemy jako separatora —
      // w godzinach („7,5") jest częścią liczby.
      const parts = raw.split(raw.includes("\t") ? "\t" : ";").map((s) => s.trim());
      const name = parts[0] ?? "";
      // Kolumna po nazwisku bywa obiektem albo działem, a bywa już godzinami —
      // rozstrzyga sam kształt komórki: tekst = przypisanie, liczba = godziny.
      // Zgadywanie po liczbie kolumn myliłoby się przy wklejce bez UW i L4.
      const hasAssignment = parts.length > 2 && !looksNumeric(parts[1] ?? "");
      const assignment = hasAssignment ? parts[1] : null;
      const nums = parts.slice(hasAssignment ? 2 : 1);

      const values: Partial<Record<NumColumn, number | null>> = {};
      let bad = false;
      NUM_COLUMNS.forEach((col, i) => {
        const cell = nums[i];
        if (cell === undefined) return; // kolumny nie było — pole zostaje nietknięte
        const v = parseHoursCell(cell);
        if (v === undefined) {
          bad = true;
          return;
        }
        // Pusta komórka też zostaje nietknięta: „nic nie wpisano" to nie „zeruj".
        if (v !== null) values[col] = v;
      });

      let status: Status = "ok";
      if (Object.keys(values).length === 0 && !bad) status = "empty";
      if (bad) status = "nan";

      let candidates = byName.get(nameKey(name)) ?? [];
      if (candidates.length > 1 && assignment) {
        const want = normName(assignment);
        const narrowed = candidates.filter(
          (r) =>
            normName(r.objectName) === want ||
            normName(r.departmentName) === want ||
            // Dział przychodzi z prefiksem firmy („ALFA GROUP:Handlowy") —
            // w grafiku nikt go tak nie pisze, więc porównujemy też sam ogon.
            normName(r.departmentName.split(":").pop() ?? "") === want,
        );
        if (narrowed.length > 0) candidates = narrowed;
      }
      if (status === "ok") {
        if (candidates.length === 0) status = "unknown";
        else if (candidates.length > 1) status = "ambiguous";
      }
      const picked = manual[index] ?? (candidates.length === 1 ? candidates[0].id : null);
      out.push({ index, name, assignment, values, status, candidates, rowId: picked });
    });
    // TEN SAM WPIS DWA RAZY — backend odbija wtedy CAŁĄ wklejkę 400-tką, bez
    // wskazania wiersza. Znajdujemy go tutaj: wygrywa PIERWSZE wystąpienie,
    // kolejne dostają status i wypadają z zapisu.
    const seen = new Set<number>();
    for (const l of out) {
      if (l.rowId == null || l.status === "nan" || l.status === "empty") continue;
      if (seen.has(l.rowId)) l.status = "duplicate";
      else seen.add(l.rowId);
    }
    return out;
  }, [text, byName, manual]);

  const ready = lines.filter(
    (l) =>
      l.rowId != null &&
      l.status !== "nan" &&
      l.status !== "empty" &&
      l.status !== "duplicate",
  );
  const counts = {
    matched: ready.length,
    ambiguous: lines.filter((l) => l.status === "ambiguous" && l.rowId == null).length,
    unknown: lines.filter((l) => l.status === "unknown").length,
    empty: lines.filter((l) => l.status === "empty").length,
    nan: lines.filter((l) => l.status === "nan").length,
    duplicate: lines.filter((l) => l.status === "duplicate").length,
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await bulkSaveHrHours(
        {
          year,
          month,
          rows: ready.map((l) => ({ id: l.rowId as number, ...l.values })),
          // Optymistyczna kontrola współbieżności na całą paczkę: jeżeli ktoś
          // ruszył któryś z tych wierszy od naszego odczytu, wklejka wraca
          // z 409 zamiast nadpisywać cudzą pracę.
          expected: Object.fromEntries(
            ready.map((l) => [l.rowId as number, rows.find((r) => r.id === l.rowId)?.updatedAt ?? ""]),
          ),
        },
        portal,
      );
      onSaved(res.data?.saved ?? 0);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu godzin");
    } finally {
      setSaving(false);
    }
  };

  const statusLabel: Record<Status, string> = {
    ok: "dopasowany",
    ambiguous: "kilka wpisów — wskaż",
    unknown: "brak takiego pracownika",
    empty: "brak godzin",
    nan: "wartość nieliczbowa",
    duplicate: "ten wpis już wyżej — wiersz pominięty",
  };

  const cell = (v: number | null | undefined) =>
    v == null ? <span className="text-muted-foreground">—</span> : hrs(v);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Wklej godziny z arkusza</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Wklej kolumny z grafiku: <strong>nazwisko i imię</strong>, opcjonalnie{" "}
            <strong>obiekt albo dział</strong> (potrzebny tylko wtedy, gdy ktoś ma
            w miesiącu kilka wpisów), dalej <strong>wypracowane</strong> i — jeśli
            są — <strong>urlop (UW)</strong>, <strong>chorobowe (L4)</strong>,{" "}
            <strong>godziny nocne</strong>. Jedna osoba w wierszu, kolumny
            rozdzielone tabulatorem (kopiuj wprost z Excela) albo średnikiem.
            Pusta komórka zostawia dotychczasową wartość — nie zeruje jej.
          </p>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setManual({});
            }}
            rows={6}
            placeholder={"Kowalski Jan\tGaleria Mokotów\t168\t8\t0\n Nowak Anna\t152,5"}
            className="font-mono text-xs"
            data-testid="kadry-paste-hours-input"
          />
        </div>

        {lines.length > 0 && (
          <>
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
              data-testid="kadry-paste-hours-summary"
            >
              <span className="font-medium text-emerald-700 dark:text-emerald-300">
                {counts.matched} dopasowane
              </span>
              {counts.ambiguous > 0 && (
                <span className="text-amber-600 dark:text-amber-300">
                  {counts.ambiguous} do wskazania
                </span>
              )}
              {counts.unknown > 0 && (
                <span className="text-destructive">{counts.unknown} bez pracownika</span>
              )}
              {counts.empty > 0 && (
                <span className="text-muted-foreground">{counts.empty} bez godzin</span>
              )}
              {counts.nan > 0 && (
                <span className="text-destructive">{counts.nan} nieliczbowe</span>
              )}
              {counts.duplicate > 0 && (
                <span className="text-destructive">
                  {counts.duplicate} powtórzone wpisy
                </span>
              )}
            </div>

            <div className="max-h-[40vh] overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Z arkusza</th>
                    <th className="px-3 py-2 text-right font-medium">Wypracowane</th>
                    <th className="px-3 py-2 text-right font-medium">Urlop (UW)</th>
                    <th className="px-3 py-2 text-right font-medium">Chorobowe (L4)</th>
                    <th className="px-3 py-2 text-right font-medium">Godziny nocne</th>
                    <th className="px-3 py-2 text-left font-medium">Wpis</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr
                      key={l.index}
                      className={cn(
                        "border-b last:border-0",
                        l.status === "unknown" || l.status === "nan"
                          ? "bg-destructive/5"
                          : l.rowId == null && l.status !== "ok"
                            ? "bg-amber-500/5"
                            : undefined,
                      )}
                    >
                      <td className="px-3 py-1.5">
                        {l.name || <span className="text-muted-foreground">—</span>}
                        {l.assignment && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {l.assignment}
                          </span>
                        )}
                      </td>
                      {NUM_COLUMNS.map((col) => (
                        <td key={col} className="px-3 py-1.5 text-right tabular-nums">
                          {cell(l.values[col])}
                        </td>
                      ))}
                      <td className="px-3 py-1.5">
                        {/* Duplikat ma WSKAZANY wpis, więc bez tej gałęzi
                            dostałby zielony ptaszek i zniknął z oczu. */}
                        {l.status === "duplicate" ? (
                          <span className="inline-flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {statusLabel.duplicate}
                          </span>
                        ) : l.candidates.length > 1 ? (
                          <select
                            className={TABLE_SELECT_CLS}
                            value={l.rowId ?? ""}
                            aria-label={`Wpis godzin dla wiersza ${l.name}`}
                            onChange={(e) =>
                              setManual((p) => ({ ...p, [l.index]: Number(e.target.value) }))
                            }
                          >
                            <option value="">— wskaż wpis —</option>
                            {l.candidates.map((cand) => (
                              <option key={cand.id} value={cand.id}>
                                {rowLabel(cand)}
                              </option>
                            ))}
                          </select>
                        ) : l.rowId != null ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                            <Check className="h-3.5 w-3.5" />
                            {rowLabel(l.candidates[0])}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                            {statusLabel[l.status]}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            type="button"
            disabled={saving || counts.matched === 0}
            onClick={() => void save()}
            data-testid="kadry-paste-hours-save"
          >
            {saving ? "Zapisywanie…" : `Zapisz godziny: ${counts.matched}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
