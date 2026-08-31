/**
 * Jedna sekcja oferty: nagłówek z przełącznikami (opcja / wariant) i tabela
 * pozycji z edycją w miejscu.
 *
 * Pola kosztowe pokazujemy tylko wtedy, gdy backend je przysłał — użytkownik
 * bez uprawnienia `technical/oferty-koszty` w ogóle ich nie dostaje, więc
 * `showCosts` nie jest tu ukrywaniem, tylko reakcją na to, co przyszło.
 */
import { useState } from "react";
import { AlertTriangle, PackageCheck, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { OfferItem, OfferSection, Service, WarehouseItem } from "@/lib/api";
import { pillClass } from "@/lib/calendar-labels";
import { OfferItemPicker, type PickedItem } from "./OfferItemPicker";
import {
  OFFER_BILLING_LABEL,
  OFFER_CATEGORY_META,
  OFFER_ITEM_KIND_LABEL,
  fmtPct,
  fmtPln,
  fmtPlnOrDash,
  fmtQty,
} from "./offersShared";

interface OfferSectionCardProps {
  section: OfferSection;
  items: OfferItem[];
  editable: boolean;
  showCosts: boolean;
  minMarginPct: number;
  warehouseItems: WarehouseItem[];
  services: Service[];
  stockByItem: Map<number, number>;
  onUpdateSection: (patch: {
    title?: string;
    isOptional?: boolean;
    variantGroup?: string | null;
    variantSelected?: boolean;
  }) => Promise<void>;
  onRemoveSection: () => Promise<void>;
  onSaveAsPackage: () => Promise<void>;
  onAddItem: (picked: PickedItem) => Promise<void>;
  onUpdateItem: (itemId: number, patch: Record<string, unknown>) => Promise<void>;
  onRemoveItem: (itemId: number) => Promise<void>;
}

/** Marża pozycji liczona lokalnie — ta sama definicja co na backendzie. */
function itemMargin(item: OfferItem): number | null {
  if (item.unitCost === null || item.unitCost === undefined) return null;
  if (item.unitCost <= 0 || item.unitPrice <= 0) return null;
  return ((item.unitPrice - item.unitCost) / item.unitPrice) * 100;
}

export function OfferSectionCard({
  section,
  items,
  editable,
  showCosts,
  minMarginPct,
  warehouseItems,
  services,
  stockByItem,
  onUpdateSection,
  onRemoveSection,
  onSaveAsPackage,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
}: OfferSectionCardProps) {
  const [title, setTitle] = useState(section.title);
  const [busy, setBusy] = useState(false);

  const counted = !section.isOptional && (!section.variantGroup || section.variantSelected);
  const meta = OFFER_CATEGORY_META[section.category];
  const sectionSum = items.reduce((a, i) => a + i.lineTotal, 0);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Operacja nie powiodła się");
    } finally {
      setBusy(false);
    }
  };

  // 6 kolumn stałych + koszt i marża + kolumna akcji tylko dla edytującego.
  const colSpan = 6 + (showCosts ? 2 : 0) + (editable ? 1 : 0);

  return (
    <Card className={counted ? "" : "opacity-75"}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={pillClass(meta.tone)}>{meta.label}</span>
          {editable ? (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title !== section.title && run(() => onUpdateSection({ title }))}
              className="h-8 max-w-xs font-medium"
            />
          ) : (
            <span className="font-medium">{section.title}</span>
          )}

          {section.isOptional && <span className={pillClass("amber")}>opcja dodatkowa</span>}
          {section.variantGroup && (
            <span className={pillClass(section.variantSelected ? "emerald" : "neutral")}>
              wariant „{section.variantGroup}”
              {section.variantSelected ? " — wybrany" : " — niewybrany"}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Razem</span>
            <strong className="tabular-nums">{fmtPln(sectionSum)}</strong>
            {!counted && (
              <span className="text-xs text-muted-foreground">(poza kwotą)</span>
            )}
          </div>
        </div>

        {editable && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={section.isOptional}
                disabled={busy}
                onChange={(e) => run(() => onUpdateSection({ isOptional: e.target.checked }))}
              />
              Opcja dodatkowa (poza kwotą)
            </label>
            <label className="flex items-center gap-1.5">
              Wariant:
              <Input
                className="h-7 w-32"
                key={`vg-${section.id}-${section.variantGroup ?? ""}`}
                placeholder="np. rejestrator"
                defaultValue={section.variantGroup ?? ""}
                disabled={busy}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (section.variantGroup ?? "")) {
                    run(() => onUpdateSection({ variantGroup: v || null }));
                  }
                }}
              />
            </label>
            {section.variantGroup && !section.variantSelected && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run(() => onUpdateSection({ variantSelected: true }))}
              >
                Wybierz ten wariant
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || items.length === 0}
              onClick={() => run(onSaveAsPackage)}
              title="Zapisz tę sekcję jako pakiet wielokrotnego użytku"
            >
              <Save className="mr-1 h-3.5 w-3.5" /> Zapisz jako pakiet
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Usunąć sekcję „${section.title}” razem z pozycjami?`)) {
                  run(onRemoveSection);
                }
              }}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Usuń sekcję
            </Button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Pozycja</th>
                <th className="px-2 py-1.5 font-medium">Rodzaj</th>
                <th className="px-2 py-1.5 text-right font-medium">Ilość</th>
                <th className="px-2 py-1.5 font-medium">J.m.</th>
                {showCosts && (
                  <th className="px-2 py-1.5 text-right font-medium">Koszt jedn.</th>
                )}
                <th className="px-2 py-1.5 text-right font-medium">Cena jedn.</th>
                {showCosts && <th className="px-2 py-1.5 text-right font-medium">Marża</th>}
                <th className="px-2 py-1.5 text-right font-medium">Wartość</th>
                {editable && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="py-4 text-center text-muted-foreground">
                    Sekcja jest pusta — dodaj pozycję poniżej.
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const margin = itemMargin(item);
                  const low = minMarginPct > 0 && margin !== null && margin < minMarginPct;
                  return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">
                        <div className={item.isOptional ? "italic text-muted-foreground" : ""}>
                          {item.name}
                          {item.isOptional && (
                            <span className={pillClass("amber", { className: "ml-1" })}>
                              opcja
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {item.stock !== null && (
                            <span
                              className={
                                item.stock < item.qty ? "text-amber-700 dark:text-amber-400" : ""
                              }
                            >
                              na stanie {fmtQty(item.stock)}
                            </span>
                          )}
                          {item.priceDrift !== null && (
                            <span className="text-amber-700 dark:text-amber-400">
                              w kartotece {fmtPln(item.priceDrift)}
                            </span>
                          )}
                          <span>{OFFER_BILLING_LABEL[item.billing]}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">
                        {OFFER_ITEM_KIND_LABEL[item.kind]}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {editable ? (
                          <Input
                            /* `key` z wartością serwerową: pole jest niekontrolowane
                               (defaultValue), więc bez remountu po „Przelicz ceny"
                               pokazywałoby starą liczbę, a jego onBlur zapisałby ją
                               z powrotem, kasując wynik przeliczenia. */
                            key={`qty-${item.id}-${item.qty}`}
                            type="number"
                            min="0"
                            step="any"
                            className="h-7 w-20 text-right tabular-nums"
                            defaultValue={item.qty}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v) && v !== item.qty) {
                                run(() => onUpdateItem(item.id, { qty: v }));
                              }
                            }}
                          />
                        ) : (
                          <span className="tabular-nums">{fmtQty(item.qty)}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{item.unit}</td>
                      {showCosts && (
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {fmtPlnOrDash(item.unitCost)}
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-right">
                        {editable ? (
                          <Input
                            key={`price-${item.id}-${item.unitPrice}`}
                            type="number"
                            min="0"
                            step="0.01"
                            className="h-7 w-24 text-right tabular-nums"
                            defaultValue={item.unitPrice}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v) && v !== item.unitPrice) {
                                run(() => onUpdateItem(item.id, { unitPrice: v }));
                              }
                            }}
                          />
                        ) : (
                          <span className="tabular-nums">{fmtPln(item.unitPrice)}</span>
                        )}
                      </td>
                      {showCosts && (
                        <td
                          className={`px-2 py-1.5 text-right tabular-nums ${
                            low ? "font-semibold text-red-600" : "text-muted-foreground"
                          }`}
                          title={
                            low
                              ? `Marża poniżej progu ${minMarginPct}%`
                              : margin === null
                                ? "Brak kosztu — marży nie da się policzyć"
                                : undefined
                          }
                        >
                          {low && <AlertTriangle className="mr-1 inline h-3 w-3" />}
                          {fmtPct(margin)}
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                        {fmtPln(item.lineTotal)}
                      </td>
                      {editable && (
                        <td className="px-1 py-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            disabled={busy}
                            onClick={() => run(() => onRemoveItem(item.id))}
                            title="Usuń pozycję"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {editable && (
          <OfferItemPicker
            items={warehouseItems}
            services={services}
            stockByItem={stockByItem}
            disabled={busy}
            onPick={(picked) => run(() => onAddItem(picked))}
          />
        )}

        {section.packageId && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <PackageCheck className="h-3 w-3" /> Sekcja powstała z zapisanego pakietu
          </p>
        )}
      </CardContent>
    </Card>
  );
}
