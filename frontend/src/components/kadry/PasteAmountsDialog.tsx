// „Wklej z arkusza" — kwoty główne miesiąca z zestawienia księgowości.
//
// Księgowość przysyła listę (arkusz albo wydruk z listy płac), a do tej pory
// jedyną drogą było przepisanie jej do tabeli liczba po liczbie. Tutaj: wklejka
// TSV/CSV, dopasowanie po nazwisku (i spółce, gdy jest w kolumnie), PODGLĄD
// z licznikami przed zapisem i dopiero potem jeden zapis zbiorczy.
//
// Świadomie bez zgadywania: wiersz, którego nie da się jednoznacznie dopasować,
// nie jest zapisywany po cichu — albo użytkownik wskazuje umowę z listy, albo
// wiersz zostaje pominięty i widać go w podsumowaniu.
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
import { bulkSaveHrPayroll, type HrPayrollRow } from "@/lib/api";
import { money, nameKey, normName, TABLE_SELECT_CLS } from "./shared";

/** Kwota z arkusza: „3 583,34 zł", „3583.34", „(200)" → liczba albo null. */
function parseMoney(raw: string): number | null {
  let t = raw
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(/zł|PLN/gi, "")
    .replace(",", ".");
  // Nawias to księgowy zapis liczby UJEMNEJ (Excel formatuje tak korekty na
  // minus). Komentarz wyżej obiecywał to od początku, ale `Number("(200)")`
  // zwracało NaN i wiersz lądował w statusie „kwota nieliczbowa”.
  let negative = false;
  const paren = /^\((.*)\)$/.exec(t);
  if (paren) {
    negative = true;
    t = paren[1];
  }
  if (t === "") return null;
  // `Number` przepuszcza „0x10" i „1e3" — w kwocie z arkusza to nie są kwoty.
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

type Status = "ok" | "ambiguous" | "unknown" | "empty" | "nan" | "duplicate";

interface ParsedLine {
  index: number;
  raw: string;
  name: string;
  company: string | null;
  amount: number | null;
  status: Status;
  /** Kandydaci przy niejednoznaczności (kilka umów tej samej osoby). */
  candidates: HrPayrollRow[];
  /** Wybrana umowa — automatycznie albo ręcznie z listy. */
  contractId: number | null;
}

export function PasteAmountsDialog({
  open,
  onClose,
  rows,
  year,
  month,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Umowy miesiąca — do nich dopasowujemy wklejone wiersze. */
  rows: HrPayrollRow[];
  year: number;
  month: number;
  /** Zapisano — rodzic podmienia przeliczony miesiąc. */
  onSaved: (saved: number, rows: HrPayrollRow[]) => void;
}) {
  const [text, setText] = useState("");
  const [manual, setManual] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byName = useMemo(() => {
    const m = new Map<string, HrPayrollRow[]>();
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
      // w kwotach jest częścią liczby.
      const parts = raw
        .split(raw.includes("\t") ? "\t" : ";")
        .map((s) => s.trim());
      const name = parts[0] ?? "";
      const amountRaw = parts.length > 1 ? parts[parts.length - 1] : "";
      const company = parts.length > 2 ? parts[1] : null;
      const amount = parseMoney(amountRaw);
      let status: Status = "ok";
      if (parts.length < 2 || amountRaw === "") status = "empty";
      else if (amount == null) status = "nan";

      let candidates = byName.get(nameKey(name)) ?? [];
      if (candidates.length > 1 && company) {
        const narrowed = candidates.filter(
          (r) => normName(r.company) === normName(company),
        );
        if (narrowed.length > 0) candidates = narrowed;
      }
      if (status === "ok") {
        if (candidates.length === 0) status = "unknown";
        else if (candidates.length > 1) status = "ambiguous";
      }
      const picked =
        manual[index] ??
        (candidates.length === 1 ? candidates[0].contractId : null);
      out.push({
        index,
        raw,
        name,
        company,
        amount,
        status,
        candidates,
        contractId: picked,
      });
    });
    // TA SAMA UMOWA DWA RAZY — backend odbija wtedy CAŁĄ wklejkę 400-tką („Ta
    // sama umowa dwa razy na liście”) bez wskazania wiersza, więc szukanie
    // duplikatu w stu liniach spadało na człowieka. Znajdujemy go tutaj: wygrywa
    // PIERWSZE wystąpienie, kolejne dostają status i wypadają z zapisu.
    const seen = new Set<number>();
    for (const l of out) {
      // Warunek ten sam, co w `ready` niżej — także wiersz „kilka umów”
      // z ręcznie wskazaną umową bierze udział w zapisie, więc i on może być
      // duplikatem.
      if (l.contractId == null || l.amount == null || l.status === "nan") continue;
      if (seen.has(l.contractId)) l.status = "duplicate";
      else seen.add(l.contractId);
    }
    return out;
  }, [text, byName, manual]);

  const ready = lines.filter(
    (l) =>
      l.contractId != null &&
      l.amount != null &&
      l.status !== "nan" &&
      l.status !== "duplicate",
  );
  const counts = {
    matched: ready.length,
    ambiguous: lines.filter((l) => l.status === "ambiguous" && l.contractId == null)
      .length,
    unknown: lines.filter((l) => l.status === "unknown").length,
    empty: lines.filter((l) => l.status === "empty").length,
    nan: lines.filter((l) => l.status === "nan").length,
    duplicate: lines.filter((l) => l.status === "duplicate").length,
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await bulkSaveHrPayroll({
        year,
        month,
        rows: ready.map((l) => ({
          contractId: l.contractId as number,
          mainAmount: l.amount,
        })),
      });
      onSaved(res.data?.saved ?? 0, res.data?.rows ?? []);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu kwot");
    } finally {
      setSaving(false);
    }
  };

  const statusLabel: Record<Status, string> = {
    ok: "dopasowany",
    ambiguous: "kilka umów — wskaż",
    unknown: "brak takiego pracownika",
    empty: "brak kwoty",
    nan: "kwota nieliczbowa",
    duplicate: "ta umowa już wyżej — wiersz pominięty",
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Wklej kwoty NETTO z arkusza</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Wklej kolumny z arkusza: <strong>nazwisko i imię</strong>, opcjonalnie{" "}
            <strong>spółka</strong>, na końcu <strong>kwota główna NETTO</strong>{" "}
            (kwota na rękę z zestawienia księgowości — Kadry nie operują kwotami
            brutto). Jedna osoba w wierszu, kolumny rozdzielone tabulatorem
            (kopiuj wprost z Excela) albo średnikiem. Zapis dotyczy tylko kwoty
            głównej.
          </p>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setManual({});
            }}
            rows={6}
            placeholder={"Kowalski Jan\tALFA\t3 583,34\nNowak Anna\t2 900"}
            className="font-mono text-xs"
            data-testid="kadry-paste-input"
          />
        </div>

        {lines.length > 0 && (
          <>
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
              data-testid="kadry-paste-summary"
            >
              <span className="font-medium text-emerald-700">
                {counts.matched} dopasowanych
              </span>
              {counts.ambiguous > 0 && (
                <span className="text-amber-600">
                  {counts.ambiguous} do wskazania
                </span>
              )}
              {counts.unknown > 0 && (
                <span className="text-destructive">
                  {counts.unknown} bez pracownika
                </span>
              )}
              {counts.empty > 0 && (
                <span className="text-muted-foreground">
                  {counts.empty} bez kwoty
                </span>
              )}
              {counts.nan > 0 && (
                <span className="text-destructive">
                  {counts.nan} nieliczbowych
                </span>
              )}
              {counts.duplicate > 0 && (
                <span className="text-destructive">
                  {counts.duplicate} powtórzonych umów
                </span>
              )}
            </div>

            <div className="max-h-[40vh] overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Z arkusza</th>
                    <th className="px-3 py-2 text-right font-medium">Kwota netto</th>
                    <th className="px-3 py-2 text-left font-medium">Umowa</th>
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
                          : l.contractId == null && l.status !== "ok"
                            ? "bg-amber-500/5"
                            : undefined,
                      )}
                    >
                      <td className="px-3 py-1.5">
                        {l.name || <span className="text-muted-foreground">—</span>}
                        {l.company && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {l.company}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {l.amount != null ? money(l.amount) : "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        {/* Duplikat ma WSKAZANĄ umowę, więc bez tej gałęzi
                            dostałby zielony ptaszek i zniknął z oczu. */}
                        {l.status === "duplicate" ? (
                          <span className="inline-flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {statusLabel.duplicate}
                          </span>
                        ) : l.candidates.length > 1 ? (
                          <select
                            className={TABLE_SELECT_CLS}
                            value={l.contractId ?? ""}
                            aria-label={`Umowa dla wiersza ${l.name}`}
                            onChange={(e) =>
                              setManual((p) => ({
                                ...p,
                                [l.index]: Number(e.target.value),
                              }))
                            }
                          >
                            <option value="">— wskaż umowę —</option>
                            {l.candidates.map((c) => (
                              <option key={c.contractId} value={c.contractId}>
                                {c.company} ·{" "}
                                {c.contractType === "praca" ? "Praca" : "Zlecenie"}
                                {c.registration ? ` · ${c.registration.toUpperCase()}` : ""}
                              </option>
                            ))}
                          </select>
                        ) : l.contractId != null ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                            <Check className="h-3.5 w-3.5" />
                            {l.candidates[0]?.company}
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
            data-testid="kadry-paste-save"
          >
            {saving ? "Zapisywanie…" : `Zapisz ${counts.matched} kwot netto`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
