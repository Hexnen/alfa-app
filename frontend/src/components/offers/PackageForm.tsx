/**
 * Edytor pakietu ofertowego.
 *
 * Pakiet to PRZEPIS, nie lista: pozycja może mieć ilość stałą („1 uruchomienie")
 * albo skalowaną parametrem („1 kamera na kamerę", „1 rejestrator na każde 8”).
 * Dlatego wiersz ma trzy pola ilościowe zamiast jednego — i dlatego przy każdym
 * pokazujemy wyliczoną ilość dla przykładowej wartości parametru.
 */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  OFFER_BILLING_LABEL,
  OFFER_CATEGORY_META,
  OFFER_ITEM_KIND_LABEL,
  fmtQty,
} from "./offersShared";

interface PackageFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: OfferPackageInput) => Promise<void>;
  pkg?: OfferPackageDetail | null;
  warehouseItems: WarehouseItem[];
  services: Service[];
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

interface Row extends OfferPackageItemInput {
  key: number;
  name: string;
  unit: string;
}

let rowSeq = 0;

export function PackageForm({
  open,
  onClose,
  onSubmit,
  pkg,
  warehouseItems,
  services,
}: PackageFormProps) {
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
    }))
  );
  const [busy, setBusy] = useState(false);

  /** Podgląd: ile pozycji wjedzie przy przykładowej wartości parametru. */
  const preview = useMemo(() => {
    const p = paramDefault || 0;
    return rows.map((r) => {
      if (form.mode === "fixed") return r.qtyBase ?? 0;
      const raw = (r.qtyBase ?? 0) + (r.qtyPerParam ?? 0) * p;
      return r.qtyRound === "up" ? Math.ceil(raw - 1e-9) : Math.round(raw * 1000) / 1000;
    });
  }, [rows, paramDefault, form.mode]);

  const patchRow = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (!form.name.trim()) {
      window.alert("Podaj nazwę pakietu.");
      return;
    }
    if (rows.length === 0) {
      window.alert("Pakiet bez pozycji nie ma czego dodać do oferty.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        name: form.name.trim(),
        category: form.category,
        manufacturer: form.manufacturer.trim() || undefined,
        description: form.description.trim() || undefined,
        mode: form.mode,
        params:
          form.mode === "parametric"
            ? [{ key: paramKey.trim() || "qty", label: paramLabel.trim() || "Ilość", default: paramDefault, min: 1 }]
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
        })),
      });
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Błąd zapisu pakietu");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{pkg ? "Edytuj pakiet" : "Nowy pakiet"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="pk-name">Nazwa *</Label>
              <Input
                id="pk-name"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="np. CCTV Dahua"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pk-category">Kategoria</Label>
              <select
                id="pk-category"
                className={selectClass}
                value={form.category}
                onChange={(e) =>
                  setForm((p) => ({ ...p, category: e.target.value as OfferSectionCategory }))
                }
              >
                {OFFER_SECTION_CATEGORIES.map((k) => (
                  <option key={k} value={k}>
                    {OFFER_CATEGORY_META[k].label}
                  </option>
                ))}
              </select>
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
              <Label htmlFor="pk-mode">Tryb</Label>
              <select
                id="pk-mode"
                className={selectClass}
                value={form.mode}
                onChange={(e) => {
                  const mode = e.target.value as OfferPackageMode;
                  setForm((p) => ({ ...p, mode }));
                  /*
                   * Przy przejściu na „stały zestaw" ilość bierze się już tylko
                   * z `qtyBase`, a wiersze dodane w trybie parametrycznym mają
                   * tam zero (cała ilość siedzi w mnożniku). Bez przeliczenia
                   * pakiet zapisywał się z zerowymi ilościami — czyli pusty.
                   * Przenosimy wyliczoną ilość do `qtyBase`.
                   */
                  if (mode === "fixed") {
                    const p = paramDefault || 0;
                    setRows((prev) =>
                      prev.map((r) => {
                        const raw = (r.qtyBase ?? 0) + (r.qtyPerParam ?? 0) * p;
                        const qty =
                          r.qtyRound === "up" ? Math.ceil(raw - 1e-9) : Math.round(raw * 1e6) / 1e6;
                        return { ...r, qtyBase: qty || 1, qtyPerParam: 0, paramKey: null };
                      })
                    );
                  }
                }}
              >
                <option value="parametric">Parametryczny (skalowany)</option>
                <option value="fixed">Stały zestaw</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pk-description">Opis</Label>
            <Textarea
              id="pk-description"
              rows={2}
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="Co obejmuje zestaw — widoczne przy wyborze pakietu"
            />
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

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Pozycja</th>
                  <th className="px-2 py-1.5 font-medium">Rodzaj</th>
                  <th className="px-2 py-1.5 font-medium">Rozliczenie</th>
                  <th className="px-2 py-1.5 text-right font-medium">Stała</th>
                  {form.mode === "parametric" && (
                    <>
                      <th className="px-2 py-1.5 text-right font-medium">× parametr</th>
                      <th className="px-2 py-1.5 font-medium">Zaokr.</th>
                    </>
                  )}
                  <th className="px-2 py-1.5 text-right font-medium">
                    Przy {form.mode === "fixed" ? "dodaniu" : `${paramDefault}`}
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={form.mode === "parametric" ? 8 : 6}
                      className="py-4 text-center text-muted-foreground"
                    >
                      Dodaj pozycje z magazynu i usług poniżej.
                    </td>
                  </tr>
                ) : (
                  rows.map((r, idx) => (
                    <tr key={r.key} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">{r.name}</td>
                      <td className="px-2 py-1.5">
                        <select
                          className={selectClass}
                          value={r.kind}
                          onChange={(e) =>
                            patchRow(r.key, { kind: e.target.value as OfferItemKind })
                          }
                        >
                          {OFFER_ITEM_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {OFFER_ITEM_KIND_LABEL[k]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          className={selectClass}
                          value={r.billing}
                          onChange={(e) =>
                            patchRow(r.key, { billing: e.target.value as OfferItemBilling })
                          }
                        >
                          {OFFER_ITEM_BILLINGS.map((b) => (
                            <option key={b} value={b}>
                              {OFFER_BILLING_LABEL[b]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          className="h-9 w-20 text-right tabular-nums"
                          value={r.qtyBase ?? 0}
                          onChange={(e) => patchRow(r.key, { qtyBase: Number(e.target.value) })}
                        />
                      </td>
                      {form.mode === "parametric" && (
                        <>
                          <td className="px-2 py-1.5 text-right">
                            <Input
                              type="number"
                              min="0"
                              step="any"
                              className="h-9 w-24 text-right tabular-nums"
                              value={r.qtyPerParam ?? 0}
                              onChange={(e) =>
                                patchRow(r.key, {
                                  qtyPerParam: Number(e.target.value),
                                  paramKey,
                                })
                              }
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <select
                              className={selectClass}
                              value={r.qtyRound ?? "none"}
                              onChange={(e) =>
                                patchRow(r.key, {
                                  qtyRound: e.target.value as "none" | "up",
                                })
                              }
                            >
                              <option value="none">bez</option>
                              <option value="up">w górę</option>
                            </select>
                          </td>
                        </>
                      )}
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                        {fmtQty(preview[idx])} {r.unit}
                      </td>
                      <td className="px-1 py-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <OfferItemPicker
            items={warehouseItems}
            services={services}
            stockByItem={new Map()}
            placeholder="Dodaj pozycję do pakietu — szukaj w magazynie i usługach…"
            onPick={(picked) =>
              setRows((p) => [
                ...p,
                {
                  key: ++rowSeq,
                  source: picked.source,
                  warehouseItemId: picked.warehouseItemId ?? null,
                  serviceId: picked.serviceId ?? null,
                  name: picked.name,
                  unit: picked.unit,
                  kind: picked.source === "warehouse" ? "material" : "labour",
                  billing: "one_time",
                  // Domyślnie „jedna sztuka na jednostkę parametru" — najczęstszy
                  // przypadek (kamera, montaż kamery). Rejestrator i dysk poprawia
                  // się ręcznie na 0,125 z zaokrągleniem w górę.
                  qtyBase: form.mode === "fixed" ? 1 : 0,
                  qtyPerParam: form.mode === "fixed" ? 0 : 1,
                  paramKey: form.mode === "fixed" ? null : paramKey,
                  qtyRound: "none",
                },
              ])
            }
          />
          <p className="text-xs text-muted-foreground">
            Ceny nie są zapisywane w pakiecie — przy dodawaniu do oferty biorą się
            z aktualnych kartotek magazynu i usług.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            {busy ? "Zapisywanie…" : pkg ? "Zapisz zmiany" : "Utwórz pakiet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Przycisk „nowy pakiet" — wydzielony, żeby strona nie znała szczegółów formularza. */
export function NewPackageButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick}>
      <Plus className="mr-1 h-4 w-4" /> Nowy pakiet
    </Button>
  );
}
