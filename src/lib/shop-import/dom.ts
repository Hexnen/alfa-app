/**
 * Cienki adapter nad cheerio dla parserów sklepów.
 *
 * Parsery NIE importują cheerio bezpośrednio — całe „dotykanie DOM-u” idzie
 * przez ten plik. Powód jest praktyczny: zapisane strony sklepów są śmieciowe
 * (skrypty, ikony SVG rozwinięte przez Font Awesome, bloki „produkty podobne”),
 * więc każdy parser potrzebuje tych samych kilku rzeczy: wczytać i wyczyścić
 * dokument, zawęzić zakres, zrobić z etykiety wartość i zamienić względny adres
 * obrazka na absolutny. Gdyby kiedyś cheerio zamienić na coś innego, zmienia się
 * tylko ten plik.
 */
import * as cheerio from "cheerio";
import type { Doc, Sel } from "./dom-types.js";

export type { Doc, Sel } from "./dom-types.js";

/** Śmieci, które w każdym sklepie psują i tekst, i wyszukiwanie selektorami. */
const ALWAYS_DROP = "script, style, noscript, svg, iframe, template";

/**
 * Wczytuje HTML i od razu go odchudza. JSON-LD wyciągamy PRZED usunięciem
 * skryptów — inaczej albo zostawilibyśmy `<script>` w drzewie (i jego treść
 * wchodziłaby do `body.text()`, psując heurystykę logowania i szukanie cen),
 * albo stracilibyśmy jedyne porządne dane strukturalne, jakie mają te sklepy.
 */
export function load(html: string): Doc {
  const $ = cheerio.load(html);
  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      jsonLd.push(JSON.parse(raw) as unknown);
    } catch {
      // Sklepy potrafią wstawić niepoprawny JSON-LD (przecinek na końcu obiektu,
      // jak gs1:Offer w SAMAL-u) — wtedy po prostu go pomijamy.
    }
  });
  $(ALWAYS_DROP).remove();
  return { $, jsonLd, html };
}

/** Usuwa bloki „cudzych” produktów — po tym każdy selektor celuje w nasz towar. */
export function stripNoise(doc: Doc, selectors: string[]): void {
  for (const sel of selectors) {
    try {
      doc.$(sel).remove();
    } catch {
      // Zły selektor to błąd programisty, ale nie powód, żeby wywalić cały import.
    }
  }
}

/** Tekst elementu bez zdziczałych białych znaków (NBSP też). */
export function text(sel: Sel | null | undefined): string {
  if (!sel || sel.length === 0) return "";
  return collapse(sel.text());
}

/** Kolaps białych znaków + NBSP → zwykła spacja. */
export function collapse(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Host bez `www.`, małymi literami — to jest nasz klucz sklepu. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Naprawia adresy, jakie realnie wychodzą z tych stron:
 *  - `//host/…` (protocol-relative w JSON-LD SAMAL-a) → https,
 *  - `https://host//sciezka` (og:url SAMAL-a ma podwójny slash) → jeden slash.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith("//")) s = `https:${s}`;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Adres absolutny z (najczęściej względnego) atrybutu.
 *
 * Bazą jest ZAWSZE adres produktu, nigdy `<base>` z dokumentu: przeglądarka przy
 * „Zapisz stronę” wstawia `<base href=".">`, co jest bezużyteczne, a do tego
 * przepisuje `src` obrazków na lokalny katalog `./…_files/…`. Takie lokalne
 * ścieżki odrzucamy — nie ma czego pobrać z internetu.
 */
export function absUrl(base: string | null, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s === "." || s.startsWith("#")) return null;
  if (/^(data|javascript|blob|file):/i.test(s)) return null;
  // Ślad zapisanej strony: „./nazwa_files/obrazek.jpg”, „nazwa_files/obrazek.jpg”.
  if (/(^\.{1,2}\/)|(_files\/)/.test(s)) return null;
  if (/^\/\//.test(s) || /^https?:\/\//i.test(s)) return normalizeUrl(s);
  if (!base) return null;
  try {
    return normalizeUrl(new URL(s, base).toString());
  } catch {
    return null;
  }
}

const LABEL_VALUE_RE_CACHE = new Map<string, RegExp>();

/**
 * Wartość obok etykiety, np. „Kod: OUTLET FAS-ASD-AR” → „OUTLET FAS-ASD-AR”.
 *
 * Bierzemy NAJMNIEJSZY element, którego cały tekst wygląda jak „etykieta:
 * wartość” — dzięki temu trafiamy w `<p><span>EAN:</span> 2010…</p>`, a nie
 * w `<body>`, który też „zawiera” tę etykietę.
 */
export function labelValue(doc: Doc, label: RegExp, scope?: Sel): string | null {
  const root: Sel = scope && scope.length ? scope : doc.$("body");
  const key = label.source;
  let re = LABEL_VALUE_RE_CACHE.get(key);
  if (!re) {
    // Wartość nie może zaczynać się interpunkcją — inaczej sama etykieta
    // w osobnym elemencie („<span>EAN:</span>”) udawałaby wartość „:”.
    re = new RegExp(`^(?:${label.source})\\s*[:\\-–]?\\s*([^\\s:;,.\\-–].{0,200})$`, "i");
    LABEL_VALUE_RE_CACHE.set(key, re);
  }
  const pattern = re;
  let best: string | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  root.find("p, li, td, th, dd, dt, span, strong, b, div, h2, h3, h4").each((_i, el) => {
    const $el = doc.$(el);
    const t = collapse($el.text());
    if (!t || t.length > 240) return;
    const m = pattern.exec(t);
    if (!m) return;
    const size = $el.find("*").length;
    if (size < bestSize) {
      bestSize = size;
      best = m[1].trim();
    }
  });
  return best;
}

/** Pary „nagłówek → wartość” z tabel i list definicyjnych w zadanym zakresie. */
export function tablePairs(doc: Doc, scope: Sel): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const push = (name: string, value: string) => {
    const n = collapse(name).replace(/\s*:\s*$/, "");
    const v = collapse(value);
    if (n && v && n.length <= 80 && v.length <= 500) out.push({ name: n, value: v });
  };
  scope.find("tr").each((_i, tr) => {
    const $tr = doc.$(tr);
    const th = $tr.find("th").first();
    const tds = $tr.find("td");
    if (th.length && tds.length) push(th.text(), tds.first().text());
    else if (tds.length >= 2) push(tds.eq(0).text(), tds.eq(1).text());
  });
  scope.find("dt").each((_i, dt) => {
    const $dt = doc.$(dt);
    push($dt.text(), $dt.next("dd").text());
  });
  return out;
}

/**
 * Kandydaci na zdjęcie produktu, w kolejności zaufania. Zwracamy listę, bo
 * parsery sklepowe potrafią odrzucić „swoje” psujące się źródła (JSON-LD
 * `image` w SAMAL-u jest sklejony z adresem strony i nie istnieje).
 */
export function imageCandidates(doc: Doc, base: string | null): string[] {
  const { $ } = doc;
  const raw: (string | undefined)[] = [
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $('meta[property="twitter:image"]').attr("content"),
    $("[itemprop=image]").attr("content") ?? $("[itemprop=image]").attr("src"),
    $('link[rel="image_src"]').attr("href"),
  ];
  const out: string[] = [];
  for (const r of raw) {
    const u = absUrl(base, r);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Najmniejszy element w zakresie, którego cały tekst pasuje do wzorca.
 *
 * Potrzebne, gdy sklep nie daje żadnej klasy na interesującą nas informację
 * (Janex pokazuje stan jako goły „Dostępny (17 szt)” w `div`-ie z klasami
 * wyłącznie o wielkości czcionki). „Najmniejszy” = z najmniejszą liczbą
 * potomków, żeby nie trafić w kontener obejmujący pół strony.
 */
export function findSmallest(
  doc: Doc,
  scope: Sel,
  pattern: RegExp,
  maxLength = 160
): Sel | null {
  let best: Sel | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  scope.find("div, p, span, li, td, strong, b").each((_i, el) => {
    const $el = doc.$(el);
    const t = collapse($el.text());
    if (!t || t.length > maxLength) return;
    if (!pattern.test(t)) return;
    const size = $el.find("*").length;
    if (size < bestSize) {
      bestSize = size;
      best = $el;
    }
  });
  return best;
}
