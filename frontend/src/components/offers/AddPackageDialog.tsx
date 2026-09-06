/**
 * Wybór pakietu do dodania na ofertę — w tym samym języku wizualnym co dialog
 * wydarzenia w kalendarzu i edytor pakietu: kolorowy pasek kategorii, kafel
 * ikony, sekcje z nagłówkami i przyklejona stopka.
 *
 * Otwierany z paska „+ CCTV / + SSWiN / …", więc lista jest już zawężona do
 * jednej kategorii. Pakiet parametryczny pyta o swoje parametry — od nich
 * zależy nie tylko ILE pozycji wjedzie, ale i KTÓRY sprzęt (progi slotów),
 * dlatego wartość ustawia się chipem albo z klawiatury, zanim klikniesz „Dodaj".
 */
import { useEffect, useMemo, useState } from "react";
import { Boxes, Check, Package, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { pillClass } from "@/lib/calendar-labels";
import { parsePackageParams, type OfferPackage, type OfferSectionCategory } from "@/lib/api";
import { OFFER_CATEGORY_META, OFFER_CATEGORY_UI } from "./offersShared";
import { Section, ValueChip } from "./offersUi";

interface AddPackageDialogProps {
  open: boolean;
  onClose: () => void;
  category: OfferSectionCategory;
  packages: OfferPackage[];
  onAdd: (packageId: number | null, params: Record<string, number>) => Promise<void>;
}

/** Wartości „na jedno kliknięcie" — typowe wielkości instalacji, przycięte do widełek. */
function chipValues(min: number, max: number | undefined, def: number): number[] {
  const base = [4, 8, 12, 16, 24, 32, 48, 64];
  const set = new Set<number>([def, ...base]);
  return [...set]
    .filter((v) => v >= min && (max === undefined || v <= max))
    .sort((a, b) => a - b)
    .slice(0, 8);
}

export function AddPackageDialog({
  open,
  onClose,
  category,
  packages,
  onAdd,
}: AddPackageDialogProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [params, setParams] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const available = useMemo(
    () => packages.filter((p) => p.active && p.category === category),
    [packages, category]
  );

  const selected = available.find((p) => p.id === selectedId) ?? null;
  const paramDefs = useMemo(
    () => (selected && selected.mode === "parametric" ? parsePackageParams(selected.params) : []),
    [selected]
  );

  // Przy zmianie pakietu wracamy do jego wartości domyślnych — przeniesienie
  // „8 kamer" na pakiet SSWiN nie miałoby sensu.
  useEffect(() => {
    const next: Record<string, number> = {};
    for (const d of paramDefs) next[d.key] = d.default ?? d.min ?? 1;
    setParams(next);
  }, [paramDefs]);

  const submit = async (packageId: number | null) => {
    setBusy(true);
    try {
      await onAdd(packageId, params);
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Nie udało się dodać sekcji");
    } finally {
      setBusy(false);
    }
  };

  const meta = OFFER_CATEGORY_META[category];
  const ui = OFFER_CATEGORY_UI[category];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && selectedId !== null) {
            e.preventDefault();
            void submit(selectedId);
          }
        }}
        className={cn(
          "flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 overflow-hidden p-0",
          "sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-lg",
          "motion-reduce:animate-none motion-reduce:transition-none"
        )}
      >
        <div className="relative shrink-0 border-b px-5 pb-3 pr-12 pt-4">
          <div className={cn("absolute inset-x-0 top-0 h-1", ui.bar)} aria-hidden />
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                ui.soft
              )}
              aria-hidden
            >
              <Boxes className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold leading-tight">
                <span className="truncate">Dodaj {meta.label}</span>
                <span className={pillClass(meta.tone)}>{available.length} w bibliotece</span>
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
                Pakiet rozwinie się na pozycje po aktualnych cenach z magazynu i usług.
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="space-y-4 px-5 py-4">
            <Section id="add-pkg-list" icon={Package} title="Pakiet">
              {available.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                  Nie ma jeszcze pakietów w tej kategorii. Dodaj pustą sekcję i złóż ją ręcznie,
                  a potem zapisz jako pakiet.
                </p>
              ) : (
                <div className="space-y-2">
                  {available.map((p) => {
                    const active = selectedId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelectedId(p.id)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                          active
                            ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                            : "hover:bg-muted/60"
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                            active ? "border-primary bg-primary text-primary-foreground" : "bg-background"
                          )}
                          aria-hidden
                        >
                          {active && <Check className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{p.name}</span>
                            {p.manufacturer && (
                              <span className={pillClass("muted", { compact: true })}>
                                {p.manufacturer}
                              </span>
                            )}
                            {p.mode === "fixed" && (
                              <span className={pillClass("neutral", { compact: true })}>
                                stały zestaw
                              </span>
                            )}
                          </span>
                          {p.description && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {p.description}
                            </span>
                          )}
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {p.itemCount ?? 0} poz. w przepisie
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Section>

            {paramDefs.length > 0 && (
              <Section id="add-pkg-params" icon={SlidersHorizontal} title="Wielkość instalacji">
                {paramDefs.map((d) => {
                  const value = params[d.key] ?? d.default ?? d.min ?? 1;
                  return (
                    <div key={d.key} className="space-y-1.5">
                      <Label htmlFor={`param-${d.key}`}>{d.label}</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          id={`param-${d.key}`}
                          type="number"
                          min={d.min ?? 0}
                          max={d.max}
                          className="h-8 w-24 text-right tabular-nums"
                          value={params[d.key] ?? ""}
                          onChange={(e) =>
                            setParams((p) => ({ ...p, [d.key]: Number(e.target.value) }))
                          }
                        />
                        <div className="flex flex-wrap items-center gap-1">
                          {chipValues(d.min ?? 1, d.max, d.default ?? 4).map((v) => (
                            <ValueChip
                              key={v}
                              active={value === v}
                              onClick={() => setParams((p) => ({ ...p, [d.key]: v }))}
                            >
                              {v}
                            </ValueChip>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <p className="text-[11px] text-muted-foreground">
                  Od tej liczby zależą ilości pozycji, a w pakietach ze slotem także model sprzętu
                  (np. rejestrator 8 / 16 / 32-kanałowy). Później zmienisz ją na sekcji przyciskiem
                  „Przelicz".
                </p>
              </Section>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-5 py-3">
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => submit(null)}
            >
              <Boxes className="mr-1 h-4 w-4" /> Pusta sekcja
            </Button>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
                Anuluj
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || selectedId === null}
                onClick={() => submit(selectedId)}
              >
                <Check className="mr-1 h-4 w-4" />
                {busy ? "Dodawanie…" : "Dodaj pakiet"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
