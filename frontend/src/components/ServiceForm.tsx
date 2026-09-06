import { useMemo, useState } from "react";
import { fmtRelative, fmtTimestamp } from "@/lib/calendar-labels";
import { tip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  SERVICE_CATEGORIES,
  SERVICE_SYSTEMS,
  type Service,
  type ServiceCategory,
  type ServiceInput,
  type ServiceSystem,
} from "@/lib/api";
import {
  fmtPct,
  fmtPln,
  marginOf,
} from "@/components/warehouse/warehouseShared";
import {
  SERVICE_CATEGORY_LABEL,
  SERVICE_SYSTEM_LABEL,
  SERVICE_UNITS,
} from "./servicesShared";

interface ServiceFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ServiceInput) => Promise<void>;
  service?: Service | null;
}

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

const parseMoney = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export function ServiceForm({
  open,
  onClose,
  onSubmit,
  service,
}: ServiceFormProps) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: service?.name || "",
    category: (service?.category || "montaz") as ServiceCategory,
    system: (service?.system || "") as ServiceSystem | "",
    unit: service?.unit || "szt",
    cost: service?.cost != null ? String(service.cost) : "",
    price: service?.price != null ? String(service.price) : "",
    description: service?.description || "",
    active: service?.active ?? true,
  });

  const margin = useMemo(
    () => marginOf(parseMoney(form.cost), parseMoney(form.price)),
    [form.cost, form.price]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      window.alert("Podaj nazwę usługi.");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({
        name: form.name.trim(),
        category: form.category,
        system: form.system,
        unit: form.unit.trim() || "szt",
        cost: form.cost.trim() || 0,
        price: form.price.trim() || 0,
        description: form.description.trim() || undefined,
        active: form.active,
      });
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Błąd zapisu usługi");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{service ? "Edytuj usługę" : "Nowa usługa"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sv-name">Nazwa *</Label>
            <Input
              id="sv-name"
              data-testid="sv-name"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="np. Montaż kamery IP"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sv-category">Kategoria</Label>
              <select
                id="sv-category"
                className={selectClass}
                value={form.category}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    category: e.target.value as ServiceCategory,
                  }))
                }
              >
                {SERVICE_CATEGORIES.map((k) => (
                  <option key={k} value={k}>
                    {SERVICE_CATEGORY_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sv-system">System</Label>
              <select
                id="sv-system"
                className={selectClass}
                value={form.system}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    system: e.target.value as ServiceSystem | "",
                  }))
                }
              >
                <option value="">— dowolny —</option>
                {SERVICE_SYSTEMS.map((k) => (
                  <option key={k} value={k}>
                    {SERVICE_SYSTEM_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sv-unit">Jednostka</Label>
            <Input
              id="sv-unit"
              list="sv-unit-list"
              value={form.unit}
              onChange={(e) => setForm((p) => ({ ...p, unit: e.target.value }))}
              placeholder="szt"
            />
            <datalist id="sv-unit-list">
              {SERVICE_UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>

          {/* Koszt i cena — netto, jak wszystkie kwoty w aplikacji. */}
          <div className="space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sv-cost">Koszt własny netto</Label>
                <Input
                  id="sv-cost"
                  data-testid="sv-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  className="tabular-nums"
                  value={form.cost}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, cost: e.target.value }))
                  }
                  placeholder="np. 60"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sv-price">Cena netto</Label>
                <Input
                  id="sv-price"
                  data-testid="sv-price"
                  type="number"
                  min="0"
                  step="0.01"
                  className="tabular-nums"
                  value={form.price}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, price: e.target.value }))
                  }
                  placeholder="np. 150"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                Marża:{" "}
                <strong className="text-foreground tabular-nums">
                  {fmtPct(margin?.marginPct)}
                </strong>
              </span>
              <span>
                Narzut:{" "}
                <strong className="text-foreground tabular-nums">
                  {fmtPct(margin?.markupPct)}
                </strong>
              </span>
              {margin && (
                <span>
                  Zysk:{" "}
                  <strong className="text-foreground tabular-nums">
                    {fmtPln(margin.amount)}
                  </strong>
                </span>
              )}
            </div>
            {!margin && (
              <p className="text-xs text-muted-foreground">
                Bez kosztu własnego i ceny marży nie da się policzyć — oferta
                pokaże „brak danych" zamiast zysku.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sv-description">Opis</Label>
            <Textarea
              id="sv-description"
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({ ...p, description: e.target.value }))
              }
              rows={2}
              placeholder="Co obejmuje usługa — trafia na ofertę jako doprecyzowanie"
            />
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) =>
                setForm((p) => ({ ...p, active: e.target.checked }))
              }
              className="h-4 w-4 accent-primary"
            />
            Aktywna (widoczna przy składaniu oferty)
          </label>

          {/* Ślad edycji przy przyciskach, nie w treści formularza: przy sporze
              o stawkę pierwsze pytanie brzmi „kto to zmienił i kiedy", a nie
              „ile wynosi" — i ma być pod ręką bez wchodzenia do dziennika. */}
          {service && (
            <p className="text-[11px] text-muted-foreground">
              Utworzył {service.createdByLabel || "—"},{" "}
              <span {...tip(fmtTimestamp(service.createdAt))}>
                {fmtRelative(service.createdAt)}
              </span>
              {service.updatedAt !== service.createdAt && (
                <>
                  {" · "}Zmienił {service.updatedByLabel || "—"},{" "}
                  <span {...tip(fmtTimestamp(service.updatedAt))}>
                    {fmtRelative(service.updatedAt)}
                  </span>
                </>
              )}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Zapisywanie…" : service ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
