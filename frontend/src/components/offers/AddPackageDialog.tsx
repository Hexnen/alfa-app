/**
 * Wybór pakietu do dodania na ofertę.
 *
 * Otwierany z paska „+ CCTV / + SSWiN / …", więc lista jest już zawężona do
 * jednej kategorii. Pakiet parametryczny pokazuje swoje parametry (liczba kamer,
 * liczba czujek) — od nich zależy, ile pozycji wjedzie na dokument.
 */
import { useEffect, useMemo, useState } from "react";
import { Boxes, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  parsePackageParams,
  type OfferPackage,
  type OfferSectionCategory,
} from "@/lib/api";
import { OFFER_CATEGORY_META } from "./offersShared";
import { pillClass } from "@/lib/calendar-labels";

interface AddPackageDialogProps {
  open: boolean;
  onClose: () => void;
  category: OfferSectionCategory;
  packages: OfferPackage[];
  onAdd: (packageId: number | null, params: Record<string, number>) => Promise<void>;
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Dodaj {meta.label}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {available.length === 0 ? (
            <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              Nie ma jeszcze zapisanych pakietów w tej kategorii. Możesz dodać
              pustą sekcję i złożyć ją ręcznie, a potem zapisać jako pakiet.
            </p>
          ) : (
            <div className="space-y-2">
              {available.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={`flex w-full items-start gap-3 rounded-md border p-3 text-left transition ${
                    selectedId === p.id ? "border-primary bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      {p.manufacturer && (
                        <span className={pillClass("muted")}>{p.manufacturer}</span>
                      )}
                      {p.mode === "fixed" && (
                        <span className={pillClass("neutral")}>stały zestaw</span>
                      )}
                    </div>
                    {p.description && (
                      <p className="text-xs text-muted-foreground">{p.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {p.itemCount ?? 0} poz.
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {paramDefs.length > 0 && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              {paramDefs.map((d) => (
                <div key={d.key} className="space-y-1">
                  <Label htmlFor={`param-${d.key}`}>{d.label}</Label>
                  <Input
                    id={`param-${d.key}`}
                    type="number"
                    min={d.min ?? 0}
                    max={d.max}
                    className="tabular-nums"
                    value={params[d.key] ?? ""}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, [d.key]: Number(e.target.value) }))
                    }
                  />
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Ilości pozycji przeliczą się od tych wartości — np. jeden
                rejestrator na każde osiem kamer.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => submit(null)}
          >
            <Boxes className="mr-1 h-4 w-4" /> Pusta sekcja
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              type="button"
              disabled={busy || selectedId === null}
              onClick={() => submit(selectedId)}
            >
              {busy ? "Dodawanie…" : "Dodaj pakiet"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
