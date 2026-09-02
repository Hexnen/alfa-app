/**
 * Edytor pakietu ofertowego — PEŁNA STRONA, nie dialog.
 *
 * Przepis potrafi mieć kilkanaście pozycji, a każda ma sześć nastaw (rodzaj,
 * rozliczenie, ilość stała, mnożnik, zaokrąglenie, slot z zakresem). W oknie
 * modalnym mieściło się to tylko po rozbiciu wiersza na dwie linie — dwanaście
 * pozycji rosło wtedy do ekranu i pół. Na osobnym ekranie (tak samo jak edytor
 * oferty) wiersz mieści się w JEDNEJ linii, a kolumny dają się porównać wzrokiem
 * między pozycjami.
 *
 * Pakiet ma dwa mechanizmy i oba widać w wierszu:
 *  - ILOŚĆ skalowana parametrem („1 kamera na kamerę", „1 dysk na każde 8"),
 *  - SLOT, czyli jedno miejsce w zestawie, w którym pakiet WYBIERA wariant
 *    zależnie od zakresu parametru („do 8 → rejestrator 8ch, 9–16 → 16ch,
 *    17+ → 32ch").
 *
 * PODGLĄD JEST NARZĘDZIEM, NIE OZDOBĄ. Progi slotu widać dopiero przy konkretnej
 * liczbie kamer, więc chipy podglądu generują się z GRANIC zakresów (8, 9, 16,
 * 17…) — jedno kliknięcie pokazuje, co wejdzie tuż przed progiem i tuż za nim.
 *
 * Źródło prawdy dla wyboru wariantu: `pickSlotVariants` w
 * src/lib/offer-packages.ts. Tutejsze `covers()` to jego lustro.
 */
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Check,
  ChevronsUp,
  Eye,
  Layers,
  ListTree,
  Loader2,
  Package,
  Plus,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { pillClass } from "@/lib/calendar-labels";
import {
  OFFER_ITEM_BILLINGS,
  OFFER_ITEM_KINDS,
  OFFER_SECTION_CATEGORIES,
  parsePackageParams,
  type OfferItemBilling,
  type OfferItemKind,
  type OfferPackageDetail,
  type OfferPackageInput,
  type OfferPackageItemInput,
  type OfferPackageMode,
  type OfferSectionCategory,
  type Service,
  type WarehouseItem,
} from "@/lib/api";
import { OfferItemPicker } from "./OfferItemPicker";
import { ChoiceButton, ValueChip } from "./offersUi";
import {
  OFFER_BILLING_LABEL,
  OFFER_CATEGORY_META,
  OFFER_CATEGORY_UI,
  OFFER_ITEM_KIND_LABEL,
  fmtQty,
} from "./offersShared";

interface PackageEditorProps {
  /** Pakiet do edycji; null = nowy. */
  pkg: OfferPackageDetail | null;
  warehouseItems: WarehouseItem[];
  services: Service[];
  onSubmit: (data: OfferPackageInput) => Promise<void>;
  onBack: () => void;
}

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Siatka wiersza — jedna definicja dla nagłówka kolumn i dla wszystkich wierszy,
 * inaczej rozjadą się przy pierwszej zmianie. Poniżej `lg` wiersz zwija się do
 * zawijanego flexa: te same kontrolki, tylko w dwóch liniach.
 */
const ROW_GRID =
  "xl:grid xl:grid-cols-[minmax(140px,1fr)_6.5rem_7rem_8.75rem_2.25rem_7rem_7.5rem_4.5rem_2rem] xl:items-center xl:gap-1.5";

interface Row extends OfferPackageItemInput {
  key: number;
  name: string;
  unit: string;
  slot: string | null;
  paramMin: number | null;
  paramMax: number | null;
}

interface RowGroup {
  slot: string | null;
  rows: Row[];
}

let rowSeq = 0;

/** Pole liczbowe, które umie być puste — pusty zakres znaczy „strona otwarta". */
function numOrNull(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Lustro `variantCovers` z backendu — granice włącznie, epsilon na grosze. */
function covers(r: Row, value: number): boolean {
  const eps = 1e-9;
  if (r.paramMin !== null && value < r.paramMin - eps) return false;
  if (r.paramMax !== null && value > r.paramMax + eps) return false;
  return true;
}

/** „9–16", „17+", „≤ 8", „zawsze" — zakres w kilku znakach, bo stoi w wierszu. */
function rangeLabel(r: Row): string {
  if (r.paramMin === null && r.paramMax === null) return "zawsze";
  if (r.paramMin === null) return `≤ ${r.paramMax}`;
  if (r.paramMax === null) return `${r.paramMin}+`;
  return `${r.paramMin}–${r.paramMax}`;
}

/** Zbija listę niepokrytych liczb w czytelne przedziały: [17,18,19] → „17–19". */
function compressRanges(values: number[]): string {
  const out: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const v of values) {
    if (start === null) start = v;
    else if (prev !== null && v !== prev + 1) {
      out.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = v;
    }
    prev = v;
  }
  if (start !== null && prev !== null) out.push(start === prev ? `${start}` : `${start}–${prev}`);
  return out.join(", ");
}

export function PackageEditor({
  pkg,
  warehouseItems,
  services,
  onSubmit,
  onBack,
}: PackageEditorProps) {
  const initialParams = pkg ? parsePackageParams(pkg.params) : [];
  const [form, setForm] = useState({
    name: pkg?.name ?? "",
    category: (pkg?.category ?? "cctv") as OfferSectionCategory,
    manufacturer: pkg?.manufacturer ?? "",
    description: pkg?.description ?? "",
    mode: (pkg?.mode ?? "parametric") as OfferPackageMode,
  });
  const [paramKey, setParamKey] = useState(initialParams[0]?.key ?? "cameras");
  const [paramLabel, setParamLabel] = useState(initialParams[0]?.label ?? "Liczba kamer");
  const [paramDefault, setParamDefault] = useState(initialParams[0]?.default ?? 4);
  const [rows, setRows] = useState<Row[]>(
    (pkg?.items ?? []).map((i) => ({
      key: ++rowSeq,
      source: i.source,
      warehouseItemId: i.warehouseItemId,
      serviceId: i.serviceId,
      name: i.name,
      unit: i.unit,
      kind: i.kind,
      billing: i.billing,
      qtyBase: i.qtyBase,
      qtyPerParam: i.qtyPerParam,
      paramKey: i.paramKey,
      qtyRound: i.qtyRound,
      slot: i.slot,
      paramMin: i.paramMin,
      paramMax: i.paramMax,
    }))
  );
  const [previewAt, setPreviewAt] = useState(initialParams[0]?.default ?? 4);
  const [addTo, setAddTo] = useState<string | null>(null);
  const [slotDraftFor, setSlotDraftFor] = useState<number | null>(null);
  const [slotDraft, setSlotDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const slotNames = useMemo(
    () => [...new Set(rows.map((r) => r.slot).filter((s): s is string => !!s))],
    [rows]
  );

  /** Wiersze w kolejności zapisu, ale warianty jednego slotu trzymają się razem. */
  const groups = useMemo<RowGroup[]>(() => {
    const out: RowGroup[] = [];
    const bySlot = new Map<string, RowGroup>();
    for (const r of rows) {
      if (!r.slot) {
        out.push({ slot: null, rows: [r] });
        continue;
      }
      let g = bySlot.get(r.slot);
      if (!g) {
        g = { slot: r.slot, rows: [] };
        bySlot.set(r.slot, g);
        out.push(g);
      }
      g.rows.push(r);
    }
    return out;
  }, [rows]);

  /** Klucze wierszy, które przy `previewAt` wchodzą na ofertę. */
  const winners = useMemo(() => {
    const set = new Set<number>();
    for (const g of groups) {
      if (!g.slot) {
        g.rows.forEach((r) => set.add(r.key));
        continue;
      }
      // Pakiet sztywny nie ma parametru, więc zakresów nie da się rozstrzygnąć —
      // wchodzi pierwszy wariant, tak samo jak na backendzie.
      const win = form.mode === "fixed" ? g.rows[0] : g.rows.find((r) => covers(r, previewAt));
      if (win) set.add(win.key);
    }
    return set;
  }, [groups, previewAt, form.mode]);

  const previewQty = (r: Row): number | null => {
    if (!winners.has(r.key)) return null;
    if (form.mode === "fixed") return r.qtyBase ?? 0;
    const raw = (r.qtyBase ?? 0) + (r.qtyPerParam ?? 0) * (previewAt || 0);
    return r.qtyRound === "up" ? Math.ceil(raw - 1e-9) : Math.round(raw * 1000) / 1000;
  };

  /**
   * Wartości do sprawdzenia jednym kliknięciem: domyślna plus GRANICE każdego
   * zakresu i pierwsza liczba tuż za nim — „co się dzieje przy 33" jest wtedy
   * odległe o jedno kliknięcie, a nie o wpisywanie liczb.
   */
  const previewChips = useMemo(() => {
    const set = new Set<number>([paramDefault || 1]);
    for (const r of rows) {
      if (!r.slot) continue;
      if (r.paramMin !== null) set.add(r.paramMin);
      if (r.paramMax !== null) {
        set.add(r.paramMax);
        set.add(r.paramMax + 1);
      }
    }
    if (set.size <= 2) [4, 8, 16, 32].forEach((v) => set.add(v));
    return [...set].filter((v) => v > 0 && Number.isFinite(v)).sort((a, b) => a - b).slice(0, 12);
  }, [rows, paramDefault]);

  /**
   * Nachodzące zakresy BLOKUJĄ zapis (backend odrzuci je tak samo), dziury tylko
   * ostrzegają — „poniżej czterech kamer bez rejestratora" bywa zamierzone.
   */
  const slotIssues = useMemo(() => {
    const overlaps: string[] = [];
    const gaps = new Map<string, string>();
    if (form.mode === "fixed") return { overlaps, gaps };
    for (const g of groups) {
      if (!g.slot) continue;
      for (let a = 0; a < g.rows.length; a++) {
        for (let b = a + 1; b < g.rows.length; b++) {
          const x = g.rows[a];
          const y = g.rows[b];
          const disjoint =
            (x.paramMax !== null && y.paramMin !== null && x.paramMax < y.paramMin) ||
            (y.paramMax !== null && x.paramMin !== null && y.paramMax < x.paramMin);
          if (!disjoint)
            overlaps.push(
              `Slot „${g.slot}": zakresy „${x.name}" (${rangeLabel(x)}) i „${y.name}" (${rangeLabel(y)}) nachodzą na siebie`
            );
        }
      }
      const uncovered: number[] = [];
      for (let v = 1; v <= 64; v++) if (!g.rows.some((r) => covers(r, v))) uncovered.push(v);
      if (uncovered.length) gaps.set(g.slot, compressRanges(uncovered));
    }
    return { overlaps, gaps };
  }, [groups, form.mode]);

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!form.name.trim()) out.push("Pakiet musi mieć nazwę.");
    if (rows.length === 0) out.push("Pakiet bez pozycji nie ma czego dodać do oferty.");
    out.push(...slotIssues.overlaps);
    return out;
  }, [form.name, rows.length, slotIssues.overlaps]);

  /** Migawka do wykrywania niezapisanych zmian — tania, bo pozycji są dziesiątki. */
  const snapshot = () =>
    JSON.stringify([form, paramKey, paramLabel, paramDefault, rows.map(({ key: _k, ...r }) => r)]);
  const initialSnapshot = useRef<string | null>(null);
  if (initialSnapshot.current === null) initialSnapshot.current = snapshot();
  const dirty = snapshot() !== initialSnapshot.current;

  const patchRow = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** Kolejny wariant startuje tam, gdzie skończył się poprzedni (8 → od 9). */
  const nextMinFor = (slot: string, exceptKey?: number): number | null => {
    const siblings = rows.filter((r) => r.slot === slot && r.key !== exceptKey);
    let max: number | null = null;
    for (const s of siblings) {
      if (s.paramMax === null) return null;
      if (max === null || s.paramMax > max) max = s.paramMax;
    }
    return max === null ? null : max + 1;
  };

  const assignSlot = (key: number, slot: string | null) => {
    if (!slot) {
      patchRow(key, { slot: null, paramMin: null, paramMax: null });
      return;
    }
    patchRow(key, { slot, paramMin: nextMinFor(slot, key), paramMax: null });
  };

  const renameSlot = (from: string, to: string) => {
    const name = to.trim();
    if (!name || name === from) return;
    setRows((prev) => prev.map((r) => (r.slot === from ? { ...r, slot: name } : r)));
  };

  const addRow = (
    picked: {
      source: OfferPackageItemInput["source"];
      warehouseItemId?: number | null;
      serviceId?: number | null;
      name: string;
      unit: string;
    },
    slot: string | null
  ) => {
    // Wariant kopiuje ilości z poprzednika w slocie — kolejne rejestratory
    // różnią się modelem, nie sposobem liczenia.
    const sibling = slot ? [...rows].reverse().find((r) => r.slot === slot) : undefined;
    setRows((p) => [
      ...p,
      {
        key: ++rowSeq,
        source: picked.source,
        warehouseItemId: picked.warehouseItemId ?? null,
        serviceId: picked.serviceId ?? null,
        name: picked.name,
        unit: picked.unit,
        kind: sibling?.kind ?? (picked.source === "warehouse" ? "material" : "labour"),
        billing: sibling?.billing ?? "one_time",
        qtyBase: sibling?.qtyBase ?? (form.mode === "fixed" ? 1 : slot ? 1 : 0),
        qtyPerParam: sibling?.qtyPerParam ?? (form.mode === "fixed" || slot ? 0 : 1),
        paramKey: form.mode === "fixed" ? null : paramKey,
        qtyRound: sibling?.qtyRound ?? "none",
        slot,
        paramMin: slot ? nextMinFor(slot) : null,
        paramMax: null,
      },
    ]);
    setAddTo(null);
  };

  const save = async () => {
    setAttempted(true);
    if (problems.length) {
      requestAnimationFrame(() =>
        alertRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: form.name.trim(),
        category: form.category,
        manufacturer: form.manufacturer.trim() || undefined,
        description: form.description.trim() || undefined,
        mode: form.mode,
        params:
          form.mode === "parametric"
            ? [
                {
                  key: paramKey.trim() || "qty",
                  label: paramLabel.trim() || "Ilość",
                  default: paramDefault,
                  min: 1,
                },
              ]
            : [],
        items: rows.map((r) => ({
          source: r.source,
          warehouseItemId: r.warehouseItemId ?? null,
          serviceId: r.serviceId ?? null,
          name: r.name,
          unit: r.unit,
          kind: r.kind,
          billing: r.billing,
          qtyBase: r.qtyBase ?? 0,
          qtyPerParam: form.mode === "fixed" ? 0 : r.qtyPerParam ?? 0,
          paramKey: form.mode === "fixed" ? null : r.paramKey ?? paramKey,
          qtyRound: r.qtyRound ?? "none",
          slot: r.slot,
          // Zakres bez slotu backend odrzuca — nie miałby czego rozstrzygać.
          paramMin: r.slot ? r.paramMin : null,
          paramMax: r.slot ? r.paramMax : null,
        })),
      });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu pakietu");
    } finally {
      setBusy(false);
    }
  };

  const requestBack = () => {
    if (dirty && !busy) setDiscardOpen(true);
    else onBack();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  };

  const catMeta = OFFER_CATEGORY_META[form.category];
  const catUi = OFFER_CATEGORY_UI[form.category];
  const paramName = paramLabel.trim() || "parametr";
  const entering = rows.filter((r) => winners.has(r.key) && (previewQty(r) ?? 0) > 0).length;

  // -------------------------------------------------------------------------
  // Wiersz pozycji — jedna linia na szerokim ekranie
  // -------------------------------------------------------------------------
  const slotControl = (r: Row) =>
    slotDraftFor === r.key ? (
      <Input
        autoFocus
        className="h-8 w-full text-xs"
        placeholder="Nazwa slotu…"
        value={slotDraft}
        onChange={(e) => setSlotDraft(e.target.value)}
        onBlur={() => {
          if (slotDraft.trim()) assignSlot(r.key, slotDraft.trim());
          setSlotDraftFor(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setSlotDraftFor(null);
          }
        }}
      />
    ) : (
      <select
        className={selectClass}
        value={r.slot ?? ""}
        aria-label="Slot"
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new") {
            setSlotDraft("");
            setSlotDraftFor(r.key);
            return;
          }
          assignSlot(r.key, v || null);
        }}
      >
        <option value="">bez slotu</option>
        {slotNames.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value="__new">+ nowy slot…</option>
      </select>
    );

  const renderRow = (r: Row, inSlot: boolean) => {
    const qty = previewQty(r);
    const RowIcon = r.source === "service" ? Wrench : Package;
    const dimmed = qty === null;
    return (
      <div
        key={r.key}
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-1.5",
          ROW_GRID,
          "hover:bg-muted/40",
          inSlot && "border-primary/40",
          inSlot && !dimmed && "bg-primary/5",
          dimmed && "opacity-70"
        )}
      >
        {/* 1. pozycja */}
        <div className="flex min-w-0 items-center gap-1.5">
          <RowIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm" title={r.name}>
            {r.name}
          </span>
          {inSlot && (
            <span className={pillClass(dimmed ? "muted" : "emerald", { compact: true })}>
              {rangeLabel(r)}
            </span>
          )}
        </div>

        {/* 2. rodzaj */}
        <select
          className={selectClass}
          value={r.kind}
          aria-label="Rodzaj"
          onChange={(e) => patchRow(r.key, { kind: e.target.value as OfferItemKind })}
        >
          {OFFER_ITEM_KINDS.map((k) => (
            <option key={k} value={k}>
              {OFFER_ITEM_KIND_LABEL[k]}
            </option>
          ))}
        </select>

        {/* 3. rozliczenie */}
        <select
          className={selectClass}
          value={r.billing}
          aria-label="Rozliczenie"
          onChange={(e) => patchRow(r.key, { billing: e.target.value as OfferItemBilling })}
        >
          {OFFER_ITEM_BILLINGS.map((b) => (
            <option key={b} value={b}>
              {OFFER_BILLING_LABEL[b]}
            </option>
          ))}
        </select>

        {/* 4. ilość */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Input
            type="number"
            min="0"
            step="any"
            aria-label="Ilość stała"
            className="h-8 w-12 text-right text-xs tabular-nums"
            value={r.qtyBase ?? 0}
            onChange={(e) => patchRow(r.key, { qtyBase: Number(e.target.value) })}
            {...tip("Ilość stała, niezależna od parametru")}
          />
          {form.mode === "parametric" && (
            <>
              <span aria-hidden>+</span>
              <Input
                type="number"
                min="0"
                step="any"
                aria-label={`Na jednostkę: ${paramName}`}
                className="h-8 w-20 text-right text-xs tabular-nums"
                value={r.qtyPerParam ?? 0}
                onChange={(e) =>
                  patchRow(r.key, { qtyPerParam: Number(e.target.value), paramKey })
                }
                {...tip("Na jednostkę parametru: 1 = sztuka na każdą, 0,125 = jedna na osiem")}
              />
              <span aria-hidden>×</span>
            </>
          )}
        </div>

        {/* 5. zaokrąglenie */}
        {form.mode === "parametric" ? (
          <div className="flex items-center">
            <button
              type="button"
              aria-pressed={r.qtyRound === "up"}
              aria-label="Zaokrąglaj w górę"
              onClick={() => patchRow(r.key, { qtyRound: r.qtyRound === "up" ? "none" : "up" })}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                r.qtyRound === "up"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              )}
              {...tip("Zaokrąglaj w górę — „jeden rejestrator na każde osiem kamer”")}
            >
              <ChevronsUp className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <span className="hidden xl:block" />
        )}

        {/* 6. slot */}
        {form.mode === "parametric" ? slotControl(r) : <span className="hidden xl:block" />}

        {/* 7. zakres */}
        {form.mode === "parametric" && r.slot ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Input
              type="number"
              step="any"
              placeholder="od"
              aria-label="Zakres od"
              className="h-8 w-14 text-right text-xs tabular-nums"
              value={r.paramMin ?? ""}
              onChange={(e) => patchRow(r.key, { paramMin: numOrNull(e.target.value) })}
            />
            <span aria-hidden>–</span>
            <Input
              type="number"
              step="any"
              placeholder="do"
              aria-label="Zakres do"
              className="h-8 w-14 text-right text-xs tabular-nums"
              value={r.paramMax ?? ""}
              onChange={(e) => patchRow(r.key, { paramMax: numOrNull(e.target.value) })}
            />
          </div>
        ) : (
          <span className="hidden xl:block" />
        )}

        {/* 8. wynik podglądu */}
        <div className="ml-auto shrink-0 text-right xl:ml-0">
          {dimmed ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <span className="text-sm font-semibold tabular-nums">
              {fmtQty(qty)} <span className="text-[11px] font-normal text-muted-foreground">{r.unit}</span>
            </span>
          )}
        </div>

        {/* 9. usuwanie */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))}
          {...tip("Usuń pozycję z pakietu")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  };

  return (
    <div className="space-y-4" onKeyDown={onKeyDown}>
      {/* --- Pasek: powrót, tytuł, stan, akcje --- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={requestBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Biblioteka pakietów
        </Button>
        <span
          className={cn("flex h-7 w-7 items-center justify-center rounded-md", catUi.soft)}
          aria-hidden
        >
          <Boxes className="h-4 w-4" />
        </span>
        <h2 className="truncate text-xl font-semibold">
          {form.name.trim() || (pkg ? "Pakiet" : "Nowy pakiet")}
        </h2>
        <span className={pillClass(catMeta.tone)}>{catMeta.label}</span>
        {form.mode === "fixed" && <span className={pillClass("neutral")}>stały zestaw</span>}
        {slotNames.length > 0 && (
          <span className={pillClass("amber")}>
            <Layers className="h-3 w-3" />
            {slotNames.length === 1 ? "1 slot" : `${slotNames.length} sloty`}
          </span>
        )}
        {dirty && <span className={pillClass("muted")}>niezapisane zmiany</span>}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={requestBack} disabled={busy}>
            Anuluj
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={busy}
            {...tip(problems[0] ?? (pkg ? "Zapisz zmiany w pakiecie" : "Utwórz pakiet"), {
              shortcut: "Ctrl+Enter",
            })}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1 h-4 w-4" />
            )}
            {busy ? "Zapisywanie…" : pkg ? "Zapisz" : "Utwórz pakiet"}
          </Button>
        </div>
      </div>

      {attempted && problems.length > 0 && (
        <div
          ref={alertRef}
          role="alert"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {(error ? [error, ...problems] : problems).map((m) => (
            <div key={m} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{m}</span>
            </div>
          ))}
        </div>
      )}
      {error && !problems.length && (
        <div
          ref={alertRef}
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* --- Dane pakietu --- */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="pk-name">Nazwa *</Label>
              <Input
                id="pk-name"
                autoFocus
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="np. CCTV Dahua — instalacja podstawowa"
                aria-invalid={attempted && !form.name.trim()}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pk-manufacturer">Producent</Label>
              <Input
                id="pk-manufacturer"
                value={form.manufacturer}
                onChange={(e) => setForm((p) => ({ ...p, manufacturer: e.target.value }))}
                placeholder="np. Dahua"
              />
            </div>
            <div className="space-y-2">
              <Label>Kategoria</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {OFFER_SECTION_CATEGORIES.map((k) => (
                  <ChoiceButton
                    key={k}
                    active={form.category === k}
                    onClick={() => setForm((p) => ({ ...p, category: k }))}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        form.category === k ? "bg-primary-foreground" : OFFER_CATEGORY_UI[k].bar
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{OFFER_CATEGORY_META[k].label}</span>
                  </ChoiceButton>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-2">
              <Label htmlFor="pk-description">Opis</Label>
              <Textarea
                id="pk-description"
                rows={2}
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Co obejmuje zestaw — widoczne przy wyborze pakietu na ofercie"
              />
            </div>
            <div className="space-y-2">
              <Label>Tryb</Label>
              <div className="grid grid-cols-2 gap-1.5">
                <ChoiceButton
                  active={form.mode === "parametric"}
                  onClick={() => setForm((p) => ({ ...p, mode: "parametric" }))}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Parametryczny
                </ChoiceButton>
                <ChoiceButton
                  active={form.mode === "fixed"}
                  onClick={() => {
                    setForm((p) => ({ ...p, mode: "fixed" }));
                    /*
                     * Przy przejściu na „stały zestaw" ilość bierze się już tylko
                     * z `qtyBase`, a wiersze dodane w trybie parametrycznym mają
                     * tam zero (cała ilość siedzi w mnożniku). Bez przeliczenia
                     * pakiet zapisywał się z zerowymi ilościami — czyli pusty.
                     */
                    const v = paramDefault || 0;
                    setRows((prev) =>
                      prev.map((r) => {
                        const raw = (r.qtyBase ?? 0) + (r.qtyPerParam ?? 0) * v;
                        const qty =
                          r.qtyRound === "up" ? Math.ceil(raw - 1e-9) : Math.round(raw * 1e6) / 1e6;
                        return { ...r, qtyBase: qty || 1, qtyPerParam: 0, paramKey: null };
                      })
                    );
                  }}
                >
                  <Boxes className="h-3.5 w-3.5" /> Stały zestaw
                </ChoiceButton>
              </div>
            </div>
          </div>

          {form.mode === "parametric" && (
            <div className="grid gap-4 rounded-md border bg-muted/30 p-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="pk-param-label">Nazwa parametru</Label>
                <Input
                  id="pk-param-label"
                  value={paramLabel}
                  onChange={(e) => setParamLabel(e.target.value)}
                  placeholder="Liczba kamer"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pk-param-key">Klucz</Label>
                <Input
                  id="pk-param-key"
                  value={paramKey}
                  onChange={(e) => setParamKey(e.target.value)}
                  placeholder="cameras"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pk-param-default">Wartość domyślna</Label>
                <Input
                  id="pk-param-default"
                  type="number"
                  min="1"
                  className="tabular-nums"
                  value={paramDefault}
                  onChange={(e) => setParamDefault(Number(e.target.value))}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- Skład --- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ListTree className="h-3.5 w-3.5" /> Skład pakietu ({rows.length})
            </span>
            {form.mode === "parametric" && (
              <>
                <span className="ml-auto flex items-center gap-1.5 text-xs font-medium">
                  <Eye className="h-3.5 w-3.5 text-muted-foreground" /> Podgląd:
                </span>
                <Label
                  htmlFor="pk-preview-at"
                  className="text-xs font-normal text-muted-foreground"
                >
                  {paramName} =
                </Label>
                <Input
                  id="pk-preview-at"
                  type="number"
                  min="0"
                  className="h-7 w-20 text-right text-xs tabular-nums"
                  value={previewAt}
                  onChange={(e) => setPreviewAt(Number(e.target.value))}
                />
                <div className="flex flex-wrap items-center gap-1">
                  {previewChips.map((v) => (
                    <ValueChip key={v} active={previewAt === v} onClick={() => setPreviewAt(v)}>
                      {v}
                    </ValueChip>
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  wchodzi {entering} z {rows.length} poz.
                </span>
              </>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
              Pusto. Dodaj pozycje z magazynu i usług wyszukiwarką poniżej — ilości ustawisz
              przy każdej z osobna.
            </div>
          ) : (
            <div className="space-y-1">
              <div
                className={cn(
                  "hidden border-b px-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground",
                  ROW_GRID,
                  "xl:border-l-2 xl:border-l-transparent"
                )}
              >
                <span>Pozycja</span>
                <span>Rodzaj</span>
                <span>Rozliczenie</span>
                <span
                  className="truncate"
                  title={`Ilość = stała + mnożnik × ${paramName}`}
                >
                  Ilość {form.mode === "parametric" && `+ ×`}
                </span>
                <span title="Zaokrąglaj w górę" />
                <span>{form.mode === "parametric" ? "Slot" : ""}</span>
                <span>{form.mode === "parametric" ? "Zakres" : ""}</span>
                <span className="text-right">
                  {form.mode === "fixed" ? "Na ofercie" : `Przy ${previewAt}`}
                </span>
                <span />
              </div>

              {groups.map((g, gi) =>
                g.slot ? (
                  <div key={`slot-${g.slot}`} className="space-y-1 py-1">
                    <div className="flex flex-wrap items-center gap-2 px-2">
                      <Layers className="h-3.5 w-3.5 text-primary/70" />
                      <Input
                        className="h-7 w-44 text-xs font-medium"
                        defaultValue={g.slot}
                        key={`name-${g.slot}`}
                        onBlur={(e) => renameSlot(g.slot as string, e.target.value)}
                        aria-label={`Nazwa slotu ${g.slot}`}
                        title="Nazwa slotu — zmiana przenosi wszystkie warianty"
                      />
                      <span className="text-[11px] text-muted-foreground">
                        wchodzi jeden wariant — ten, w którego zakres wpada „{paramName}"
                      </span>
                      {slotIssues.gaps.has(g.slot) && (
                        <span className="text-[11px] text-amber-600 dark:text-amber-500">
                          · dla {slotIssues.gaps.get(g.slot)} nic nie wchodzi
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-7"
                        onClick={() => setAddTo(addTo === g.slot ? null : g.slot)}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" /> wariant
                      </Button>
                    </div>

                    {g.rows.map((r) => renderRow(r, true))}

                    {addTo === g.slot && (
                      <div className="px-2 pt-1">
                        <OfferItemPicker
                          items={warehouseItems}
                          services={services}
                          stockByItem={new Map()}
                          placeholder={`Wariant do slotu „${g.slot}" — szukaj w magazynie i usługach…`}
                          onPick={(picked) => addRow(picked, g.slot)}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={`row-${g.rows[0].key}-${gi}`}>{renderRow(g.rows[0], false)}</div>
                )
              )}
            </div>
          )}

          <OfferItemPicker
            items={warehouseItems}
            services={services}
            stockByItem={new Map()}
            placeholder="Dodaj pozycję do pakietu — szukaj w magazynie i usługach…"
            onPick={(picked) => addRow(picked, null)}
          />
          <p className="text-[11px] text-muted-foreground">
            {form.mode === "parametric" && (
              <>
                Ilość = <strong>stała</strong> + <strong>mnożnik</strong> ×{" "}
                {paramName.toLowerCase()}, a strzałka zaokrągla wynik w górę („jeden rejestrator
                na każde osiem kamer"). Slot podmienia sprzęt progami (rejestrator 8 / 16 / 32
                kanały), mnożnik zmienia ilość.{" "}
              </>
            )}
            Ceny nie są zapisywane w pakiecie — przy dodawaniu do oferty biorą się z aktualnych
            kartotek magazynu i usług.
          </p>
        </CardContent>
      </Card>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent className="motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Porzucić zmiany w pakiecie?</AlertDialogTitle>
            <AlertDialogDescription>
              Zmiany w składzie i progach nie zostaną zapisane.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Wróć do edycji</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscardOpen(false);
                onBack();
              }}
            >
              Porzuć
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
