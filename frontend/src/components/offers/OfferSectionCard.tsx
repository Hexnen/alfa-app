/**
 * Jedna sekcja oferty: nagłówek z przełącznikami (opcja / wariant / parametr
 * pakietu) i tabela pozycji z edycją w miejscu.
 *
 * Układ trzyma się tego samego języka co dialog wydarzenia w kalendarzu i
 * edytor pakietu: kolorowa krawędź kategorii, pigułki stanu przy tytule, jeden
 * pasek narzędzi zamiast trzech osobnych rzędów. Wcześniej sekcja miała trzy
 * paski nad tabelą (tytuł, parametr, przełączniki) i na trzech sekcjach
 * zjadały pół ekranu, zanim pokazała się pierwsza pozycja.
 *
 * Pola kosztowe pokazujemy tylko wtedy, gdy backend je przysłał — użytkownik
 * bez uprawnienia `technical/oferty-koszty` w ogóle ich nie dostaje, więc
 * `showCosts` nie jest tu ukrywaniem, tylko reakcją na to, co przyszło.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, PackageCheck, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { OfferItem, OfferSection, Service, WarehouseItem } from "@/lib/api";
import { pillClass } from "@/lib/calendar-labels";
import {
  PRICE_STALE_MONTHS,
  isPriceStale,
  priceAgeLabel,
  type PriceSourceKind,
} from "@/lib/price-age";
import { OfferItemPicker, type PickedItem } from "./OfferItemPicker";
import {
  OFFER_BILLING_LABEL,
  OFFER_CATEGORY_META,
  OFFER_CATEGORY_UI,
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
  /** Etykiety parametrów pakietu, z którego powstała sekcja („cameras" → „Liczba kamer"). */
  paramLabels?: Record<string, string>;
  onUpdateSection: (patch: {
    title?: string;
    isOptional?: boolean;
    variantGroup?: string | null;
    variantSelected?: boolean;
  }) => Promise<void>;
  /** Ponowne rozwinięcie sekcji z pakietu dla nowych wartości parametrów. */
  onReexpand: (params: Record<string, number>) => Promise<void>;
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

/**
 * Katalog, z którego pochodzi cena pozycji — decyduje o progu (towary 6 mies.,
 * usługi 12). `null` dla pozycji wpisanych ręcznie: nie mają kartoteki, w
 * której ktoś mógłby cenę potwierdzić, więc nie ma czego pilnować.
 */
function priceAgeKind(item: OfferItem): PriceSourceKind | null {
  if (item.source === "manual") return null;
  return item.source === "service" ? "service" : "warehouse";
}

/**
 * Ostrzeżenie o wieku ceny: krótko na pigułkę, pełnym zdaniem do dymka.
 * W wierszu stoi obok siebie kilka pigułek, więc data i skala wieku mieszczą
 * się tylko w dymku. Liczbę miesięcy wyjmujemy z `priceAgeLabel` zamiast
 * liczyć drugi raz — reguła wieku ma zostać w `lib/price-age.ts`.
 */
function priceAgeWarning(
  priceUpdatedAt: string | null | undefined,
  kind: PriceSourceKind
): { pill: string; tip: string } {
  const label = priceAgeLabel(priceUpdatedAt, kind);
  const scope = kind === "service" ? "usług" : "towarów";
  if (!priceUpdatedAt) {
    // Etykieta sama mówi już o progu, więc dymek go nie powtarza.
    return {
      pill: "cena bez daty",
      tip: `Kartoteka nie pamięta, kiedy ostatnio zmieniono tę cenę — ${label}. Potwierdź ją przed wysłaniem oferty.`,
    };
  }
  const months = /(\d+)\s*mies\./.exec(label)?.[1];
  return {
    pill: months ? `cena sprzed ${months} mies.` : "cena nieaktualna",
    tip:
      `${label[0].toUpperCase()}${label.slice(1)} — dla ${scope} pilnujemy ` +
      `${PRICE_STALE_MONTHS[kind]} mies. Potwierdź cenę w kartotece przed wysłaniem oferty.`,
  };
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
  paramLabels,
  onUpdateSection,
  onReexpand,
  onRemoveSection,
  onSaveAsPackage,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
}: OfferSectionCardProps) {
  const [title, setTitle] = useState(section.title);
  const [busy, setBusy] = useState(false);

  /**
   * Parametry, którymi rozwinięto sekcję z pakietu ({"cameras": 8}). Do tej pory
   * leżały w bazie martwe — teraz dają się zmienić i przeliczyć, bo przy slotach
   * z liczby kamer wynika nie tylko ILOŚĆ pozycji, ale i MODEL rejestratora.
   */
  const savedParams = useMemo<Record<string, number>>(() => {
    try {
      const v = JSON.parse(section.params);
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      const out: Record<string, number> = {};
      for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
        const num = Number(n);
        if (Number.isFinite(num)) out[k] = num;
      }
      return out;
    } catch {
      return {};
    }
  }, [section.params]);
  const [paramDraft, setParamDraft] = useState<Record<string, number>>(savedParams);
  // Po przeliczeniu (albo przełączeniu oferty) wracamy do tego, co naprawdę
  // stoi na sekcji — inaczej pole pokazywałoby wartość, której nikt nie zapisał.
  useEffect(() => setParamDraft(savedParams), [savedParams]);
  const paramKeys = Object.keys(savedParams);

  const counted = !section.isOptional && (!section.variantGroup || section.variantSelected);
  const meta = OFFER_CATEGORY_META[section.category];
  const ui = OFFER_CATEGORY_UI[section.category];
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
    /*
     * BEZ `overflow-hidden`: kolorowa krawędź kategorii dostała własne
     * zaokrąglenie, bo obcinanie zawartości karty ucinało też listę podpowiedzi
     * wyszukiwarki pozycji — otwierała się i znikała na krawędzi kafelka.
     */
    <Card className={cn(!counted && "opacity-75")}>
      {/* Kolorowa krawędź kategorii — ten sam zabieg co pasek typu w dialogu
          wydarzenia: pozwala rozpoznać sekcję, zanim przeczyta się jej tytuł. */}
      <div className="flex">
        <div className={cn("w-1 shrink-0 rounded-l-lg", ui.bar)} aria-hidden />
        <CardContent className="min-w-0 flex-1 space-y-2.5 p-3">
          {/* --- Nagłówek --- */}
          <div className="flex flex-wrap items-center gap-2">
            <span className={pillClass(meta.tone)}>{meta.label}</span>
            {editable ? (
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title !== section.title && run(() => onUpdateSection({ title }))}
                className="h-8 max-w-xs font-medium"
                aria-label="Tytuł sekcji"
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
              <span className="text-xs text-muted-foreground">Razem</span>
              <strong className="tabular-nums">{fmtPln(sectionSum)}</strong>
              {!counted && <span className="text-xs text-muted-foreground">(poza kwotą)</span>}
            </div>
          </div>

          {/* --- Pasek narzędzi: parametr pakietu + przełączniki sekcji --- */}
          {editable && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
              {section.packageId !== null && paramKeys.length > 0 && (
                <>
                  <PackageCheck className="h-3.5 w-3.5 text-muted-foreground" />
                  {paramKeys.map((k) => (
                    <label key={k} className="flex items-center gap-1.5">
                      {paramLabels?.[k] ?? k}:
                      <Input
                        type="number"
                        min="0"
                        className="h-7 w-16 text-right tabular-nums"
                        value={paramDraft[k] ?? 0}
                        disabled={busy}
                        onChange={(e) =>
                          setParamDraft((p) => ({ ...p, [k]: Number(e.target.value) }))
                        }
                      />
                    </label>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Przeliczyć sekcję „${section.title}”? Pozycje powstaną od nowa z pakietu — ` +
                            "ręczne zmiany w tej sekcji przepadną."
                        )
                      )
                        return;
                      run(() => onReexpand(paramDraft));
                    }}
                    {...tip("Pozycje wrócą z pakietu, z wariantami dobranymi do tej liczby")}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" /> Przelicz
                  </Button>
                  <span className="h-4 w-px bg-border" aria-hidden />
                </>
              )}

              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={section.isOptional}
                  disabled={busy}
                  onChange={(e) => run(() => onUpdateSection({ isOptional: e.target.checked }))}
                />
                Opcja dodatkowa
              </label>

              <label className="flex items-center gap-1.5">
                Wariant:
                <Input
                  className="h-7 w-28"
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
                  title="Sekcje w jednej grupie to alternatywy — do sumy wchodzi jedna"
                />
              </label>
              {section.variantGroup && !section.variantSelected && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy}
                  onClick={() => run(() => onUpdateSection({ variantSelected: true }))}
                >
                  Wybierz ten wariant
                </Button>
              )}

              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy || items.length === 0}
                  onClick={() => run(onSaveAsPackage)}
                  {...tip("Zapisz tę sekcję jako pakiet wielokrotnego użytku")}
                >
                  <Save className="mr-1 h-3.5 w-3.5" /> Zapisz jako pakiet
                </Button>
                {/* Z PODPISEM, nie samą ikoną: to jedyna operacja w sekcji,
                    której nie da się cofnąć, a stoi obok „Zapisz jako pakiet".
                    Ikona bez etykiety zbyt łatwo łapie przypadkowy klik. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Usunąć sekcję „${section.title}” razem z ${items.length} pozycjami? ` +
                          "Tej operacji nie da się cofnąć."
                      )
                    ) {
                      run(onRemoveSection);
                    }
                  }}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Usuń sekcję
                </Button>
              </div>
            </div>
          )}

          {/* --- Pozycje --- */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground [&_th]:whitespace-nowrap">
                <tr>
                  <th className="w-full py-1 pr-2 font-medium">Pozycja</th>
                  <th className="px-2 py-1 font-medium">Rodzaj</th>
                  <th className="px-2 py-1 text-right font-medium">Ilość</th>
                  <th className="px-2 py-1 font-medium">J.m.</th>
                  {showCosts && <th className="px-2 py-1 text-right font-medium">Koszt jedn.</th>}
                  <th className="px-2 py-1 text-right font-medium">Cena jedn.</th>
                  {showCosts && <th className="px-2 py-1 text-right font-medium">Marża</th>}
                  <th className="px-2 py-1 text-right font-medium">Wartość</th>
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
                    const lowStock = item.stock !== null && item.stock < item.qty;
                    const ageKind = priceAgeKind(item);
                    const staleAge =
                      ageKind && isPriceStale(item.priceUpdatedAt, ageKind)
                        ? priceAgeWarning(item.priceUpdatedAt, ageKind)
                        : null;
                    return (
                      <tr key={item.id} className="border-b last:border-0 hover:bg-muted/30">
                        {/* Nazwa i jej metryczki w JEDNEJ linii — druga linia pod
                            każdą pozycją podwajała wysokość sekcji, a „na stanie 72"
                            to informacja poboczna. */}
                        <td className="max-w-0 py-1 pr-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "truncate",
                                item.isOptional && "italic text-muted-foreground"
                              )}
                              title={item.name}
                            >
                              {item.name}
                            </span>
                            {item.isOptional && (
                              <span className={pillClass("amber", { compact: true })}>opcja</span>
                            )}
                            {item.billing === "monthly" && (
                              <span className={pillClass("emerald", { compact: true })}>
                                {OFFER_BILLING_LABEL[item.billing]}
                              </span>
                            )}
                            {lowStock && (
                              <span
                                className={pillClass("amber", { compact: true })}
                                {...tip(`Na stanie ${fmtQty(item.stock ?? 0)} — mniej niż w ofercie`)}
                              >
                                stan {fmtQty(item.stock ?? 0)}
                              </span>
                            )}
                            {item.priceDrift !== null && (
                              <span
                                className={pillClass("amber", { compact: true })}
                                {...tip("Cena w kartotece różni się od tej na ofercie")}
                              >
                                kartoteka {fmtPln(item.priceDrift)}
                              </span>
                            )}
                            {/* Obok „kartoteka …", nie zamiast: tamta mówi, że cena
                                w kartotece ZMIENIŁA się względem oferty, ta — że nikt
                                jej od dawna nie potwierdzał. Obie naraz to sensowny
                                stan (stara cena, która właśnie drgnęła), więc żadna
                                drugiej nie wycisza. */}
                            {staleAge && (
                              <span
                                className={pillClass("red", { compact: true })}
                                {...tip(staleAge.tip)}
                              >
                                {staleAge.pill}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">
                          {OFFER_ITEM_KIND_LABEL[item.kind]}
                        </td>
                        <td className="px-2 py-1 text-right">
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
                              aria-label={`Ilość: ${item.name}`}
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
                        <td className="px-2 py-1 text-xs text-muted-foreground">{item.unit}</td>
                        {showCosts && (
                          <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                            {fmtPlnOrDash(item.unitCost)}
                          </td>
                        )}
                        <td className="px-2 py-1 text-right">
                          {editable ? (
                            <Input
                              key={`price-${item.id}-${item.unitPrice}`}
                              type="number"
                              min="0"
                              step="0.01"
                              className="h-7 w-24 text-right tabular-nums"
                              defaultValue={item.unitPrice}
                              aria-label={`Cena jednostkowa: ${item.name}`}
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
                            className={cn(
                              "px-2 py-1 text-right tabular-nums",
                              low ? "font-semibold text-red-600" : "text-muted-foreground"
                            )}
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
                        <td className="px-2 py-1 text-right font-medium tabular-nums">
                          {fmtPln(item.lineTotal)}
                        </td>
                        {editable && (
                          <td className="px-1 py-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              disabled={busy}
                              onClick={() => run(() => onRemoveItem(item.id))}
                              {...tip("Usuń pozycję")}
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

          {section.packageId !== null && (
            <p className="text-[11px] text-muted-foreground">
              Sekcja powstała z zapisanego pakietu.
            </p>
          )}
        </CardContent>
      </div>
    </Card>
  );
}
