/**
 * Panel przeglądu importu towaru z zapisanej strony sklepu dostawcy.
 *
 * Świadomie NIE jest osobnym `Dialog`-iem, tylko ekranem WEWNĄTRZ dialogu
 * formularza towaru: zagnieżdżony Radix Dialog przechwytuje focus i Escape,
 * a tu chodzi o jeden krok tego samego zadania („zobacz, co przyszło, i wypełnij
 * formularz”), a nie o osobne okno.
 *
 * Panel niczego nie zapisuje. Zwraca `onApply` z gotowymi wartościami pól
 * (już jako stringi, dokładnie w kształcie stanu formularza) — cały zapis idzie
 * potem zwykłym POST/PUT `/warehouse/items` razem ze źródłem.
 */
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  Lock,
  ShoppingCart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tip } from "@/components/ui/tooltip";
import { pillClass } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import type {
  ShopImportMatch,
  ShopImportParseResult,
  WarehouseItemSourceInput,
} from "@/lib/api";
import { fmtPln, fmtPlnOrDash, fmtQty, shopFromUrl } from "./warehouseShared";

/** Pola kartoteki, które import umie zaproponować (klucze stanu formularza). */
export type ShopImportFieldKey =
  | "name"
  | "category"
  | "manufacturer"
  | "manufacturerCode"
  | "barcode"
  | "unit"
  | "purchasePrice"
  | "description";

/** Wartości pól formularza jako stringi — panel porównuje i oddaje to samo. */
export type ShopImportSnapshot = Record<ShopImportFieldKey, string>;

export interface ShopImportApplied {
  /** TYLKO pola zaznaczone do nadpisania. */
  values: Partial<ShopImportSnapshot>;
  /** Cechy do dopisania na koniec opisu (przycisk „Dopisz do opisu”). */
  descriptionAppend: string | null;
  /** `undefined` = nie ruszaj zdjęcia w formularzu. */
  photoData?: string | null;
  /** Źródło (sklep dostawcy) do zapisania razem z towarem. */
  source: WarehouseItemSourceInput;
}

interface ShopImportPanelProps {
  result: ShopImportParseResult;
  /** „new” = zakładamy towar (wszystko zaznaczone), „edit” = uzupełniamy istniejący. */
  mode: "new" | "edit";
  /** Obecne wartości w formularzu — kolumna „Obecnie” (tylko w trybie edit). */
  current: ShopImportSnapshot;
  /** Czy towar ma już zdjęcie (w edycji domyślnie go nie podmieniamy). */
  hasPhoto?: boolean;
  onApply: (applied: ShopImportApplied) => void;
  onCancel: () => void;
  /** Klik w „Otwórz istniejący” z listy dopasowań. */
  onOpenExisting?: (id: number) => void;
}

const FIELD_LABEL: Record<ShopImportFieldKey, string> = {
  name: "Nazwa",
  category: "Kategoria",
  manufacturer: "Producent",
  manufacturerCode: "Symbol producenta",
  barcode: "Kod kreskowy (EAN)",
  unit: "Jednostka",
  purchasePrice: "Cena zakupu netto",
  description: "Opis",
};

const FIELD_ORDER: ShopImportFieldKey[] = [
  "name",
  "manufacturer",
  "manufacturerCode",
  "barcode",
  "category",
  "unit",
  "purchasePrice",
  "description",
];

/**
 * Parsery, których selektory sprawdzono na prawdziwej próbce. Eltrox i Grodno
 * są w rejestrze, ale bez kalibracji (brak zapisanej strony), więc ich wynik
 * trzeba czytać tak samo ostrożnie jak wynik generyka — i badge ma to mówić.
 */
const CALIBRATED_PARSERS = new Set(["samal", "janex"]);

const MATCH_REASON_LABEL: Record<ShopImportMatch["reason"], string> = {
  source: "ten sam sklep i kod dostawcy",
  ean: "ten sam kod EAN",
  manufacturerCode: "ten sam symbol producenta",
  sku: "to samo SKU",
  name: "podobna nazwa",
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Kwota z pola tekstowego formularza (te same reguły co w WarehouseItemForm). */
const moneyStr = (v: number | null): string => (v === null ? "" : String(v));

export function ShopImportPanel({
  result,
  mode,
  current,
  hasPhoto = false,
  onApply,
  onCancel,
  onOpenExisting,
}: ShopImportPanelProps) {
  const { parsed, suggestedItem, suggestedSource, matches, photoData, photoWarning } =
    result;
  const diag = parsed.diagnostics;

  /**
   * Adres produktu. Bywa, że parser go nie znajdzie (`shopDetectedBy: "none"`) —
   * wtedy PUSTY jest też `shop`, a bez sklepu źródła nie da się zapisać.
   * Dlatego adres jest tu polem do wpisania, a nie tylko linkiem.
   */
  const [url, setUrl] = useState(parsed.url ?? "");
  const shop = parsed.shop || shopFromUrl(url);
  const shopLabel = parsed.shopLabel || shop;

  // Cena bez etykiety: człowiek decyduje, czym ona jest. Parser trzyma taką
  // cenę w `priceGross` (tak najczęściej pokazują sklepy), ale to tylko domysł.
  const unknownPrice = parsed.priceKind === "unknown";
  const rawPrice = parsed.priceGross ?? parsed.priceNet;
  const [priceKind, setPriceKind] = useState<"net" | "gross">("gross");
  const [vatText, setVatText] = useState(
    parsed.vatRate !== null ? String(parsed.vatRate) : "23"
  );
  const vat = (() => {
    const n = Number(vatText.replace(",", "."));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 23;
  })();

  /** Cena zakupu (netto) po decyzji człowieka o netto/brutto. */
  const purchasePrice = useMemo(() => {
    if (!unknownPrice) return suggestedItem.purchasePrice;
    if (rawPrice === null) return null;
    return priceKind === "net" ? r2(rawPrice) : r2(rawPrice / (1 + vat / 100));
  }, [unknownPrice, rawPrice, priceKind, vat, suggestedItem.purchasePrice]);

  /** Co sklep proponuje w każdym polu — już jako string dla formularza. */
  const shopValues = useMemo<ShopImportSnapshot>(
    () => ({
      name: suggestedItem.name ?? "",
      category: suggestedItem.category ?? "",
      manufacturer: suggestedItem.manufacturer ?? "",
      manufacturerCode: suggestedItem.manufacturerCode ?? "",
      barcode: suggestedItem.barcode ?? "",
      unit: suggestedItem.unit ?? "",
      purchasePrice: moneyStr(purchasePrice),
      description: suggestedItem.description ?? "",
    }),
    [suggestedItem, purchasePrice]
  );

  /**
   * Zaznaczenia. Nowy towar = bierzemy wszystko, co przyszło. Edycja = tylko
   * pola PUSTE, bo import ma uzupełniać kartotekę, a nie po cichu podmieniać
   * nazwę i cenę, które ktoś wpisał ręcznie.
   */
  const [picked, setPicked] = useState<Record<ShopImportFieldKey, boolean>>(() => {
    const init = {} as Record<ShopImportFieldKey, boolean>;
    for (const key of FIELD_ORDER) {
      const incoming = key === "purchasePrice" ? moneyStr(purchasePrice) : shopValues[key];
      init[key] =
        incoming.trim() !== "" && (mode === "new" || current[key].trim() === "");
    }
    return init;
  });

  const [usePhoto, setUsePhoto] = useState(
    photoData !== null && (mode === "new" || !hasPhoto)
  );
  const [attrsOpen, setAttrsOpen] = useState(false);
  const [attrsAppended, setAttrsAppended] = useState(false);
  const [diagOpen, setDiagOpen] = useState(
    diag.parserUsed === "generic" || diag.missing.length > 3
  );
  const [matchesDismissed, setMatchesDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const attributeText = parsed.attributes
    .map((a) => `${a.name}: ${a.value}`)
    .join("\n");

  /** Ostrzeżenia parsera bez tego o logowaniu — ono ma własny, duży box. */
  const warnings = diag.warnings.filter((w) => !/logowani/i.test(w));

  /**
   * Pewne dopasowanie (kod dostawcy / EAN / symbol producenta) w trybie
   * zakładania nowego towaru blokuje przycisk: to jest właśnie ten moment,
   * w którym kartoteka zbiera duplikaty.
   */
  const blockingMatches =
    mode === "new" && !matchesDismissed
      ? matches.filter((m) => m.confidence === "exact")
      : [];

  const canApply = shop !== "" && blockingMatches.length === 0;

  const toggle = (key: ShopImportFieldKey) =>
    setPicked((p) => ({ ...p, [key]: !p[key] }));

  const copyReport = async () => {
    // Zrzut dla nas: bez `accountLabel` (e-mail konta w sklepie to dana osobowa,
    // która do kalibracji parsera jest zupełnie zbędna).
    const report = {
      generatedAt: new Date().toISOString(),
      parsed: { ...parsed, accountLabel: null },
      suggestedItem,
      matchIds: matches.map((m) => m.id),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      window.alert("Przeglądarka nie pozwoliła skopiować raportu do schowka.");
    }
  };

  const apply = () => {
    if (!shop) {
      window.alert(
        "Nie rozpoznano sklepu. Wklej adres strony produktu — z niego weźmiemy domenę sklepu."
      );
      return;
    }
    const values: Partial<ShopImportSnapshot> = {};
    for (const key of FIELD_ORDER) {
      if (picked[key]) values[key] = shopValues[key];
    }

    // Źródło zapisujemy zgodnie z decyzją o netto/brutto — inaczej w bazie
    // zostałaby cena „brutto” tylko dlatego, że parser tak zgadł.
    const source: WarehouseItemSourceInput = {
      ...suggestedSource,
      shop,
      shopLabel,
      productUrl: url.trim() || suggestedSource.productUrl || null,
    };
    if (unknownPrice && rawPrice !== null) {
      source.vatRate = vat;
      if (priceKind === "net") {
        source.lastPriceNet = r2(rawPrice);
        source.lastPriceGross = r2(rawPrice * (1 + vat / 100));
      } else {
        source.lastPriceGross = r2(rawPrice);
        source.lastPriceNet = r2(rawPrice / (1 + vat / 100));
      }
    }

    onApply({
      values,
      descriptionAppend: attrsAppended && attributeText ? attributeText : null,
      photoData: usePhoto && photoData ? photoData : undefined,
      source,
    });
  };

  const parserCalibrated = CALIBRATED_PARSERS.has(diag.parserUsed);
  const parserBadge = parserCalibrated
    ? `parser ${shopLabel || diag.parserUsed}`
    : diag.parserUsed === "generic"
      ? "parser ogólny"
      : `parser nieskalibrowany (${diag.parserUsed})`;
  const parserTip = parserCalibrated
    ? `Selektory sprawdzone na próbce tego sklepu (wersja ${diag.parserVersion}).`
    : "Dane wzięte z ogólnych znaczników strony (JSON-LD / og / microdata) — sprawdź je pole po polu.";

  return (
    <div className="space-y-4" data-testid="shop-import-panel">
      {/* --- Belka: sklep, adres, parser --- */}
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{shopLabel || "Nieznany sklep"}</span>
          <span
            className={pillClass(parserCalibrated ? "emerald" : "amber", {
              compact: true,
            })}
            {...tip(parserTip)}
          >
            {parserBadge}
          </span>
          {parsed.loggedIn ? (
            <span className={pillClass("emerald", { compact: true })}>
              zapisano po zalogowaniu
              {parsed.accountLabel ? ` (${parsed.accountLabel})` : ""}
            </span>
          ) : (
            <span className={pillClass("amber", { compact: true })}>
              <Lock className="h-3 w-3" /> bez logowania
            </span>
          )}
          {url.trim() && (
            <a
              href={url.trim()}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> Otwórz w sklepie
            </a>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="si-url" className="text-xs">
            Adres strony produktu {parsed.shop ? "" : "*"}
          </Label>
          <Input
            id="si-url"
            data-testid="shop-import-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://sklep.pl/produkt/…"
          />
          {!shop && (
            <p className="text-xs font-medium text-red-600">
              Nie udało się rozpoznać sklepu z zapisanej strony. Wklej adres
              produktu — domenę (bez „www.”) weźmiemy z niego.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {parsed.supplierCode && <span>Kod u dostawcy: {parsed.supplierCode}</span>}
          {parsed.stock !== null && (
            <span>
              Stan w sklepie: {fmtQty(parsed.stock)} {parsed.unit || "szt"}
            </span>
          )}
          {parsed.stock === null && parsed.stockText && (
            <span>Dostępność: {parsed.stockText}</span>
          )}
          {parsed.priceNet !== null && <span>Netto: {fmtPln(parsed.priceNet)}</span>}
          {parsed.priceGross !== null && (
            <span>Brutto: {fmtPln(parsed.priceGross)}</span>
          )}
          {parsed.vatRate !== null && <span>VAT: {parsed.vatRate}%</span>}
        </div>
      </div>

      {/* --- Strona zapisana bez logowania: ceny mogą być detaliczne --- */}
      {!parsed.loggedIn && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Strona wygląda na zapisaną bez logowania
          </p>
          <p>
            Ceny mogą być detaliczne albo w ogóle niewidoczne. Zaloguj się
            w sklepie i zapisz stronę ponownie:{" "}
            <strong>Ctrl+S → „Strona sieci Web, kompletna”</strong>.
          </p>
          {parsed.loginSignals.length > 0 && (
            <p className="text-amber-800 dark:text-amber-300">
              Przesłanki: {parsed.loginSignals.join("; ")}
            </p>
          )}
        </div>
      )}

      {/* --- Dopasowania: „taki towar już mamy” --- */}
      {matches.length > 0 && (
        <div
          className={cn(
            "space-y-2 rounded-md border p-3 text-xs",
            blockingMatches.length > 0
              ? "border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
              : "border-border bg-muted/40 text-muted-foreground"
          )}
          data-testid="shop-import-matches"
        >
          <p className="font-medium">
            {mode === "new"
              ? "Taki towar już istnieje w kartotece:"
              : "Ten produkt jest już powiązany z kartotekami:"}
          </p>
          <ul className="space-y-1">
            {matches.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                <span>
                  ({MATCH_REASON_LABEL[m.reason]}
                  {m.confidence === "likely" ? ", dopasowanie prawdopodobne" : ""})
                </span>
                {m.sku && <span>SKU {m.sku}</span>}
                <span>zakup {fmtPlnOrDash(m.purchasePrice)}</span>
                {m.isArchived && (
                  <span className={pillClass("muted", { compact: true })}>archiwum</span>
                )}
                {onOpenExisting && (
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => onOpenExisting(m.id)}
                  >
                    Otwórz istniejący
                  </button>
                )}
              </li>
            ))}
          </ul>
          {blockingMatches.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMatchesDismissed(true)}
              data-testid="shop-import-force-new"
            >
              Mimo to utwórz nowy
            </Button>
          )}
        </div>
      )}

      {/* --- Ostrzeżenia parsera --- */}
      {warnings.length > 0 && (
        <ul className="list-inside list-disc space-y-0.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {/* --- Cena bez etykiety: człowiek mówi, czym ona jest --- */}
      {unknownPrice && rawPrice !== null && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            Znaleziono jedną cenę bez etykiety: {fmtPln(rawPrice)}. Czym ona jest?
          </p>
          <div className="flex flex-wrap items-center gap-4 text-amber-900 dark:text-amber-200">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="si-price-kind"
                className="h-3.5 w-3.5 accent-primary"
                checked={priceKind === "net"}
                onChange={() => setPriceKind("net")}
              />
              netto
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="si-price-kind"
                className="h-3.5 w-3.5 accent-primary"
                checked={priceKind === "gross"}
                onChange={() => setPriceKind("gross")}
              />
              brutto
            </label>
            <label className="flex items-center gap-1">
              VAT
              <Input
                className="h-7 w-16 tabular-nums"
                value={vatText}
                onChange={(e) => setVatText(e.target.value)}
                inputMode="decimal"
              />
              %
            </label>
            <span>
              Cena zakupu netto:{" "}
              <strong className="tabular-nums">{fmtPlnOrDash(purchasePrice)}</strong>
            </span>
          </div>
        </div>
      )}

      {/* --- Tabela pól --- */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Pole</th>
              <th className="px-3 py-2 font-medium">Ze sklepu</th>
              {mode === "edit" && (
                <th className="px-3 py-2 font-medium">Obecnie</th>
              )}
              <th className="w-24 px-3 py-2 text-right font-medium">nadpisz</th>
            </tr>
          </thead>
          <tbody>
            {FIELD_ORDER.map((key) => {
              const incoming = shopValues[key];
              const currentValue = current[key];
              // Bursztyn = sklep chce ZMIENIĆ coś, co już jest wpisane. To jedyny
              // przypadek, w którym zaznaczenie kasuje czyjąś decyzję.
              const conflict =
                mode === "edit" &&
                incoming.trim() !== "" &&
                currentValue.trim() !== "" &&
                incoming.trim() !== currentValue.trim();
              return (
                <tr key={key} className="border-b last:border-0 align-top">
                  <td className="px-3 py-2 font-medium">{FIELD_LABEL[key]}</td>
                  <td
                    className={cn(
                      "px-3 py-2 whitespace-pre-wrap",
                      key === "description" && "max-w-md",
                      conflict && "text-amber-700 dark:text-amber-300"
                    )}
                  >
                    {incoming.trim() ? (
                      key === "purchasePrice" ? (
                        <span className="tabular-nums">
                          {fmtPlnOrDash(purchasePrice)}
                        </span>
                      ) : (
                        <span className="line-clamp-4 break-words">{incoming}</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  {mode === "edit" && (
                    <td className="px-3 py-2 text-muted-foreground">
                      {currentValue.trim() ? (
                        <span className="line-clamp-4 break-words">
                          {currentValue}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      data-testid={`shop-import-pick-${key}`}
                      checked={picked[key]}
                      disabled={incoming.trim() === ""}
                      onChange={() => toggle(key)}
                      aria-label={`Nadpisz pole ${FIELD_LABEL[key]}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* --- Zdjęcie --- */}
      {(photoData || photoWarning) && (
        <div className="flex items-start gap-3 rounded-md border p-3">
          {photoData ? (
            <img
              src={photoData}
              alt="Zdjęcie ze sklepu"
              className="h-20 w-20 rounded-md border object-cover"
            />
          ) : null}
          <div className="space-y-1 text-xs">
            {photoData ? (
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  data-testid="shop-import-use-photo"
                  checked={usePhoto}
                  onChange={(e) => setUsePhoto(e.target.checked)}
                />
                Użyj zdjęcia ze sklepu
              </label>
            ) : null}
            {mode === "edit" && hasPhoto && photoData && (
              <p className="text-muted-foreground">
                Towar ma już zdjęcie — zaznaczenie je podmieni.
              </p>
            )}
            {photoWarning && (
              <p className="text-amber-700 dark:text-amber-300">{photoWarning}</p>
            )}
          </div>
        </div>
      )}

      {/* --- Cechy --- */}
      {parsed.attributes.length > 0 && (
        <div className="rounded-md border">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-accent"
            onClick={() => setAttrsOpen((o) => !o)}
          >
            {attrsOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Atrybuty ({parsed.attributes.length})
          </button>
          {attrsOpen && (
            <div className="space-y-2 border-t p-3">
              <ul className="space-y-1 text-xs">
                {parsed.attributes.map((a, i) => (
                  <li key={`${a.name}-${i}`} className="flex gap-2">
                    <span className="w-48 shrink-0 text-muted-foreground">
                      {a.name}
                    </span>
                    <span className="break-words">{a.value}</span>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAttrsAppended((v) => !v)}
              >
                {attrsAppended ? (
                  <>
                    <Check className="mr-1 h-4 w-4" /> Zostaną dopisane do opisu
                  </>
                ) : (
                  "Dopisz do opisu"
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* --- Diagnostyka (dla nas: z niej powstaje parser sklepu) --- */}
      <div className="rounded-md border">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-accent"
          onClick={() => setDiagOpen((o) => !o)}
          data-testid="shop-import-diag-toggle"
        >
          {diagOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Diagnostyka
          {!parserCalibrated && (
            <span className={pillClass("amber", { compact: true })}>
              sprawdź dane
            </span>
          )}
        </button>
        {diagOpen && (
          <div className="space-y-2 border-t p-3 text-xs">
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              <span>
                Parser: <strong>{diag.parserUsed}</strong> (wersja {diag.parserVersion})
              </span>
              <span>
                Sklep rozpoznany przez: <strong>{diag.shopDetectedBy}</strong>
              </span>
              <span>
                Kodowanie: <strong>{diag.charset}</strong>
              </span>
              <span>
                Rozmiar strony:{" "}
                <strong>{Math.round(diag.htmlBytes / 1024)} kB</strong>
              </span>
            </div>
            <p>
              <span className="text-muted-foreground">Rozpoznano: </span>
              {diag.recognized.length ? diag.recognized.join(", ") : "nic"}
            </p>
            <p>
              <span className="text-muted-foreground">Nie rozpoznano: </span>
              {diag.missing.length ? diag.missing.join(", ") : "—"}
            </p>
            {diag.warnings.length > 0 && (
              <ul className="list-inside list-disc space-y-0.5 text-amber-700 dark:text-amber-300">
                {diag.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={copyReport}>
                {copied ? (
                  <>
                    <Check className="mr-1 h-4 w-4" /> Skopiowano
                  </>
                ) : (
                  <>
                    <ClipboardCopy className="mr-1 h-4 w-4" /> Kopiuj raport
                  </>
                )}
              </Button>
              <span className="text-muted-foreground">
                Wyślij ten raport razem z zapisaną stroną — dopiszemy parser dla
                tego sklepu.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* --- Stopka --- */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
        {!canApply && (
          <span className="mr-auto text-xs text-muted-foreground">
            {blockingMatches.length > 0
              ? "Najpierw zdecyduj: otworzyć istniejący towar czy utworzyć nowy."
              : "Wklej adres strony produktu — bez sklepu nie da się zapisać źródła."}
          </span>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Anuluj
        </Button>
        <Button
          type="button"
          onClick={apply}
          disabled={!canApply}
          data-testid="shop-import-apply"
        >
          Wypełnij formularz
        </Button>
      </div>
    </div>
  );
}
