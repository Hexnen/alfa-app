/**
 * Liczby ze stron sklepów: ceny, VAT, stany magazynowe.
 *
 * Osobno od `src/lib/money.ts` — tam `parseMoney` CELOWO odrzuca „48,80 PLN”
 * i „1 234,56” (broni formularzy przed cichym „1 zł”). Tutaj jest odwrotne
 * zadanie: dane przychodzą ze cudzego HTML-a razem z waluta, spacjami
 * nierozdzielającymi i nawiasami, więc trzeba je najpierw znormalizować. Wynik
 * z tego pliku jest już „czystą” liczbą i dopiero on idzie do `parseMoney`
 * w trasach.
 */

export interface ParsedPrice {
  value: number;
  /** Waluta rozpoznana z tekstu (null = nie było jej w tekście). */
  currency: string | null;
}

const CURRENCIES: [RegExp, string][] = [
  [/\bPLN\b|zł|\bzl\b/i, "PLN"],
  [/\bEUR\b|€/i, "EUR"],
  [/\bUSD\b|\$/i, "USD"],
  [/\bGBP\b|£/i, "GBP"],
];

/** „48,80 PLN”, „1 234,56 zł”, „(49,20 PLN)”, „38.13” → liczba + waluta. */
export function parsePriceText(raw: string | null | undefined): ParsedPrice | null {
  if (!raw) return null;
  const s = raw.replace(/ /g, " ");
  const m = /-?\d[\d\s.,]*/.exec(s);
  if (!m) return null;
  const value = normalizeNumber(m[0]);
  if (value === null) return null;
  let currency: string | null = null;
  for (const [re, code] of CURRENCIES) {
    if (re.test(s)) {
      currency = code;
      break;
    }
  }
  return { value: Math.round(value * 100) / 100, currency };
}

/**
 * Separator dziesiętny poznajemy po tym, że po nim zostaje 1–2 cyfry
 * („1.234,56” → 1234.56, „1 234” → 1234, „48.80” → 48.8). Inaczej traktujemy
 * kropki i przecinki jako separatory tysięcy.
 */
function normalizeNumber(raw: string): number | null {
  let t = raw.replace(/\s/g, "");
  const sepIdx = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  if (sepIdx >= 0) {
    const decimals = t.length - sepIdx - 1;
    if (decimals >= 1 && decimals <= 2) {
      t = `${t.slice(0, sepIdx).replace(/[.,]/g, "")}.${t.slice(sepIdx + 1)}`;
    } else {
      t = t.replace(/[.,]/g, "");
    }
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** „23%”, „23,00”, „VAT 23 %” → 23. Poza 0–100 zwraca null. */
export function parsePercentText(raw: string | null | undefined): number | null {
  const p = parsePriceText(raw);
  if (!p) return null;
  if (p.value < 0 || p.value > 100) return null;
  return Math.round(p.value * 100) / 100;
}

/** Stawki, które realnie występują w PL — do „przyciągania” wyniku dzielenia. */
const STANDARD_VAT = [0, 5, 8, 23];

export interface ResolvedVat {
  vatRate: number | null;
  warnings: string[];
}

/**
 * VAT z etykiety (np. atrybut „Podatek VAT 23%”) skonfrontowany z ilorazem
 * brutto/netto. Iloraz jest sprawdzianem: jeśli sklep pokazuje „23%”, a z cen
 * wychodzi 8%, to znaczy, że jedna z tych liczb jest z innego produktu (bloki
 * „produkty podobne” to nasza codzienność) — wtedy ostrzegamy człowieka.
 */
export function resolveVat(
  net: number | null,
  gross: number | null,
  vatFromLabel: number | null
): ResolvedVat {
  const warnings: string[] = [];
  let computed: number | null = null;
  if (net !== null && gross !== null && net > 0 && gross > 0) {
    const raw = (gross / net - 1) * 100;
    const snapped = STANDARD_VAT.find((r) => Math.abs(raw - r) <= 0.6);
    computed = snapped ?? Math.round(raw * 100) / 100;
  }
  if (vatFromLabel !== null && computed !== null && Math.abs(vatFromLabel - computed) > 1) {
    warnings.push(
      `VAT ze strony (${vatFromLabel}%) nie zgadza się z ceną netto/brutto (${computed}%) — sprawdź, czy ceny są z tego samego produktu`
    );
  }
  return { vatRate: vatFromLabel ?? computed, warnings };
}

export interface ParsedStock {
  stock: number | null;
  unit: string | null;
  text: string | null;
  /** „Dostępny na zamówienie” — sklep nie podaje liczby, więc stan zostaje puste. */
  onRequest: boolean;
}

const UNIT_RE = /\d[\d\s.,]*\s*(szt|kpl|para|op|opak|rol|mb|m2|m3|m|kg|l)\b\.?/i;

/** „W magazynie: 17 szt.”, „Dostępny (17 szt)”, „Dostępny na zamówienie”. */
export function parseStockText(raw: string | null | undefined): ParsedStock {
  const text = raw ? raw.replace(/ /g, " ").replace(/\s+/g, " ").trim() : null;
  if (!text) return { stock: null, unit: null, text: null, onRequest: false };
  const onRequest = /na zamówienie|na zamowienie/i.test(text);
  const num = /(\d[\d\s.,]*)/.exec(text);
  const unitMatch = UNIT_RE.exec(text);
  const unit = unitMatch ? normalizeUnit(unitMatch[1]) : null;
  let stock: number | null = null;
  if (num && !onRequest) {
    const n = normalizeNumber(num[1]);
    if (n !== null && n >= 0 && n < 1_000_000) stock = Math.round(n);
  }
  return { stock, unit, text, onRequest };
}

/** „szt.” → „szt”, „opak” → „op” — jednostki trzymamy krótko, jak w kartotece. */
export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!t) return null;
  if (t === "sztuka" || t === "sztuk" || t === "szt") return "szt";
  if (t === "opak" || t === "opakowanie") return "op";
  if (t.length > 10) return null;
  return t;
}

/** Cena netto z brutto i VAT — używane, gdy sklep pokazuje tylko brutto. */
export function netFromGross(gross: number, vatRate: number): number {
  return Math.round((gross / (1 + vatRate / 100)) * 100) / 100;
}
