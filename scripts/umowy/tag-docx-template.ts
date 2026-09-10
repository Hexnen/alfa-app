/**
 * Tagowanie oryginalnego wzoru umowy ZDW pod docxtemplater.
 *
 *   npx tsx scripts/umowy/tag-docx-template.ts \
 *     --in "obiekty/Aktualne Drafty 05.2023/ALFA G/Aktualna Umowa Draft Tylko ZDW.docx" \
 *     --out templates/umowy/zdw-alfa-group.docx --verify
 *
 * DLACZEGO SKRYPT, A NIE RĘCZNA EDYCJA W WORDZIE. Word tnie tekst na „runy”
 * (`<w:r>`) tam, gdzie zmieniał się rsid, sprawdzanie pisowni albo formatowanie —
 * „Nr 07/01/S.C./2026” siedzi w ośmiu runach, a docxtemplater szuka `{tag}`
 * W OBRĘBIE JEDNEGO `<w:t>`. Wpisanie `{numer}` ręcznie w Wordzie działa do
 * pierwszego zapisu, po którym Word znowu potrafi rozbić napis. Skrypt wstawia
 * cały `{tag}` w JEDEN `<w:t>` i jest powtarzalny: przy nowej wersji wzoru
 * wystarczy go uruchomić ponownie.
 *
 * ZASADA: SZABLONU NIE WOLNO OTWIERAĆ I ZAPISYWAĆ W WORDZIE. Zapis przenumeruje
 * rsidy i może rozbić tagi z powrotem na kawałki.
 *
 * FAIL-LOUD. Każda asercja (liczba akapitów, dokładny tekst akapitu, liczba
 * wystąpień frazy) zatrzymuje skrypt z polskim komunikatem. Cichy „brak
 * dopasowania" dałby szablon z dziurą, którą zauważyłby dopiero klient.
 */
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Mapa tagów
// ---------------------------------------------------------------------------

interface TagSpec {
  /** Indeks akapitu w `word/document.xml` (liczony od 0, akapity puste też się liczą). */
  paragraph: number;
  /** Fraza do zastąpienia — dosłowna albo wzorzec (dla kropkowanych placeholderów). */
  find: string | RegExp;
  /** Które wystąpienie frazy w akapicie (od 0). Domyślnie pierwsze. */
  occurrence?: number;
  /** Ile razy fraza MA wystąpić w akapicie. Domyślnie 1 — inaczej błąd. */
  expectedCount?: number;
  tag: string;
}

/** Ile akapitów ma oryginał. Inna liczba = inny dokument, mapa indeksów nieważna. */
const PARAGRAPH_COUNT = 251;

/** Kropkowany placeholder osoby kontaktowej: pięć wielokropków i kropka. */
const KROPKI = /…{3,}\.?/;

/**
 * Dokładny tekst akapitów, w które wchodzimy. To jest właściwa asercja: numer
 * akapitu bez treści zgodziłby się z przypadkowo podobnym wzorem.
 */
const EXPECTED_TEXT: Record<number, string> = {
  2: "Nr 07/01/S.C./2026",
  4: "zawarta w dniu 07.01.2026r. w Warszawie, dalej jako „Umowa”, pomiędzy:",
  6: "Alfa Group Sp. z o.o. z siedzibą w Warszawie (03-612) przy ul. Koniczynowa 2A, wpisaną do rejestru przedsiębiorców Krajowego Rejestru Sądowego prowadzonego przez Sąd Rejonowy dla m. st. Warszawy w Warszawie XIII Wydział Gospodarczy Krajowego Rejestru Sądowego pod numerem KRS: 0000119104, posiadającą nr NIP: 693-18-36-206, REGON: 390651040, kapitał zakładowy: 50 000,00 zł reprezentowaną przez: ",
  7: "- Sławomira Jaworskiego - Prezesa Zarządu",
  13: "Stacja Napraw Powypadkowych Michał Pawlak",
  //   = twarda spacja — Word wstawił ją po przecinkach; asercja musi o niej wiedzieć.
  14: "ul. Heroldów 7, 01-991 Warszawa,\u00a0NIP:\u00a01180090458,\u00a0",
  16: "- Michał Pawlak ",
  25: 'Usługi, o których mowa w ust. 1 powyżej będą świadczone wobec obiektu Heroldów 7 w Warszawie.  (dalej "Obiekt").',
  26: "Zleceniodawca oświadcza, że Obiekt jest / nie jest*  obiektem podlegającym obowiązkowej ochronie zgodnie z art. 5 ustawy z dnia 22 sierpnia 1997 roku o ochronie osób i mienia (Dz. U. z 2020 r. poz. 838) i zobowiązuje się do pisemnego poinformowania Zleceniobiorcy niezwłocznie po tym, gdy powyższy stan ulegnie zmianie.",
  54: "Zleceniodawca wskazuje \u00a0e-mail m.pawlak@autobielany.pl, na który otrzymuje od CMA informacje bieżące na temat działania / usterek systemu , widoczności na Obiekcie \u00a0itp.",
  67: "W przypadku kiedy Zleceniodawca nie będzie w stanie docierać na Obiekt w czasie do  30 minut istnieje możliwość wezwania grupy interwencyjnej, która zabezpieczy teren do czasu przyjazdu przedstawiciela Zleceniodawcy. Koszt godziny przebywania załogi interwencyjnej na Obiekcie będzie wynosił od 150 zł (słownie: sto pięćdziesiąt złotych) powiększone o podatek VAT w stawce obowiązującej w dniu wystawienia przez Zleceniobiorcę faktury za każdą rozpoczętą godzinę.",
  101: "Z tytułu świadczenia przez Zleceniobiorcę na rzecz Zleceniodawcy usług będących przedmiotem niniejszej umowy, Zleceniodawca zobowiązuje się płacić Zleceniobiorcy wynagrodzenie w formie miesięcznego abonamentu w kwocie 1900 zł (słownie: jeden tysiąc dziewięćset złotych) powiększone o podatek VAT w stawce obowiązującej w dniu wystawienia przez Zleceniobiorcę faktury VAT.",
  103: "Faktura VAT będzie dostarczona do Zleceniodawcy w formie: elektronicznej (e-faktura) wystawianej miesięcznie wysyłanej na wskazany adres e-mail: m.pawlak@autobielany.pl",
  119: "Zleceniodawca oświadcza, że jest/nie jest dużym przedsiębiorcą w rozumieniu ustawy z dnia 8 marca 2013 r. o przeciwdziałaniu nadmiernym opóźnieniom w transakcjach handlowych.",
  194: "……………., tel.: …………….,",
  195: "e-mail: …………….",
  196: "……………., tel.: …………….",
  197: "e-mail: …………….",
};

/**
 * Hiperłącza mailto do rozpakowania. `<w:hyperlink r:id="…">` odsyła do wpisu
 * w `document.xml.rels`; po podmianie tekstu na `{tag}` link prowadziłby pod
 * adres poprzedniego klienta — a taki e-mail w umowie to wyciek danych.
 * Znaczniki zamieniamy na zwykłe runy (wygląd zostaje: styl „Hipercze”),
 * a wpisy relacji kasujemy.
 */
const HYPERLINKS: { paragraph: number; relId: string }[] = [
  { paragraph: 54, relId: "rId8" },
  { paragraph: 103, relId: "rId11" },
];

const TAGS: TagSpec[] = [
  // --- Nagłówek umowy ---
  { paragraph: 2, find: "07/01/S.C./2026", tag: "numer" },
  { paragraph: 4, find: "07.01.2026", tag: "data_umowy" },
  { paragraph: 4, find: "Warszawie", tag: "miejsce" },
  // --- Zleceniobiorca (spółka) ---
  { paragraph: 6, find: "Alfa Group Sp. z o.o.", tag: "zleceniobiorca_nazwa" },
  { paragraph: 6, find: "Warszawie (03-612) przy ul. Koniczynowa 2A", tag: "zleceniobiorca_siedziba" },
  { paragraph: 6, find: "0000119104", tag: "zleceniobiorca_krs" },
  { paragraph: 6, find: "693-18-36-206", tag: "zleceniobiorca_nip" },
  { paragraph: 6, find: "390651040", tag: "zleceniobiorca_regon" },
  { paragraph: 6, find: "50 000,00 zł", tag: "zleceniobiorca_kapital" },
  { paragraph: 7, find: "Sławomira Jaworskiego - Prezesa Zarządu", tag: "zleceniobiorca_reprezentant" },
  // --- Zleceniodawca (kontrahent) ---
  { paragraph: 13, find: "Stacja Napraw Powypadkowych Michał Pawlak", tag: "kontrahent_nazwa" },
  { paragraph: 14, find: "ul. Heroldów 7, 01-991 Warszawa", tag: "kontrahent_adres" },
  { paragraph: 14, find: "1180090458", tag: "kontrahent_nip" },
  { paragraph: 16, find: "Michał Pawlak", tag: "kontrahent_reprezentant" },
  // --- Obiekt ---
  { paragraph: 25, find: "Heroldów 7 w Warszawie", tag: "obiekt_adres" },
  // Gwiazdka po wariancie ZOSTAJE — odsyła do przypisu „niepotrzebne skreślić”.
  { paragraph: 26, find: "jest / nie jest", tag: "ochrona_obowiazkowa" },
  { paragraph: 119, find: "jest/nie jest", tag: "duzy_przedsiebiorca" },
  // --- Rozliczenie ---
  { paragraph: 54, find: "m.pawlak@autobielany.pl", tag: "email_cma" },
  { paragraph: 67, find: "150", tag: "stawka_patrol" },
  { paragraph: 67, find: "sto pięćdziesiąt złotych", tag: "stawka_patrol_slownie" },
  { paragraph: 101, find: "1900", tag: "abonament" },
  { paragraph: 101, find: "jeden tysiąc dziewięćset złotych", tag: "abonament_slownie" },
  { paragraph: 103, find: "m.pawlak@autobielany.pl", tag: "email_faktura" },
  // --- Osoby kontaktowe Zleceniodawcy (akapity 194–197 mają identyczną treść,
  //     więc indeks akapitu jest jedynym rozróżnieniem) ---
  { paragraph: 194, find: KROPKI, occurrence: 0, expectedCount: 2, tag: "kontakt1_nazwa" },
  { paragraph: 194, find: KROPKI, occurrence: 1, expectedCount: 2, tag: "kontakt1_telefon" },
  { paragraph: 195, find: KROPKI, tag: "kontakt1_email" },
  { paragraph: 196, find: KROPKI, occurrence: 0, expectedCount: 2, tag: "kontakt2_nazwa" },
  { paragraph: 196, find: KROPKI, occurrence: 1, expectedCount: 2, tag: "kontakt2_telefon" },
  { paragraph: 197, find: KROPKI, tag: "kontakt2_email" },
];

// ---------------------------------------------------------------------------
// Praca na XML akapitu
// ---------------------------------------------------------------------------

/** Akapity: `<w:pPr>` nie łapie się w `<w:p[ >]`, a `</w:pPr>` nie jest `</w:p>`. */
const PARA_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
const T_RE = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const T_CLOSE = "</w:t>";

class TagError extends Error {}

function fail(message: string): never {
  throw new TagError(message);
}

function decodeEntity(entity: string): string {
  switch (entity) {
    case "&amp;":
      return "&";
    case "&lt;":
      return "<";
    case "&gt;":
      return ">";
    case "&quot;":
      return '"';
    case "&apos;":
      return "'";
    default: {
      const num = /^&#(x?)([0-9a-fA-F]+);$/.exec(entity);
      if (!num) fail(`Nieznana encja XML: ${entity}`);
      return String.fromCodePoint(parseInt(num[2], num[1] ? 16 : 10));
    }
  }
}

interface TextRun {
  /** Pozycja `<w:t` w XML akapitu. */
  openStart: number;
  /** Atrybuty otwierającego znacznika (z wiodącą spacją albo pusty napis). */
  attrs: string;
  contentStart: number;
  contentEnd: number;
  raw: string;
}

/** Znak tekstu akapitu wraz z miejscem, z którego pochodzi. */
interface CharRef {
  run: number;
  /** Offset w surowej treści runa (encja zajmuje `len` znaków). */
  off: number;
  len: number;
  ch: string;
}

function scanRuns(paraXml: string): TextRun[] {
  const runs: TextRun[] = [];
  T_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = T_RE.exec(paraXml)) !== null) {
    const openLen = m[0].indexOf(">") + 1;
    runs.push({
      openStart: m.index,
      attrs: m[1] ?? "",
      contentStart: m.index + openLen,
      contentEnd: m.index + m[0].length - T_CLOSE.length,
      raw: m[2],
    });
  }
  return runs;
}

function charRefs(runs: TextRun[]): CharRef[] {
  const out: CharRef[] = [];
  runs.forEach((run, ri) => {
    let i = 0;
    while (i < run.raw.length) {
      if (run.raw[i] === "&") {
        const semi = run.raw.indexOf(";", i);
        if (semi > i && semi - i <= 12) {
          const entity = run.raw.slice(i, semi + 1);
          out.push({ run: ri, off: i, len: entity.length, ch: decodeEntity(entity) });
          i = semi + 1;
          continue;
        }
      }
      out.push({ run: ri, off: i, len: 1, ch: run.raw[i] });
      i += 1;
    }
  });
  return out;
}

function paragraphText(paraXml: string): string {
  return charRefs(scanRuns(paraXml))
    .map((c) => c.ch)
    .join("");
}

/** `xml:space="preserve"` na runie, w którym wylądował tag (spacje wokół są znaczące). */
function preserveAttrs(attrs: string): string {
  if (/\bxml:space\s*=/.test(attrs)) return attrs.replace(/\bxml:space\s*=\s*"[^"]*"/, 'xml:space="preserve"');
  return `${attrs} xml:space="preserve"`;
}

interface CharRange {
  start: number;
  end: number;
  tag: string;
}

/** Wszystkie wystąpienia frazy w tekście akapitu — jako zakresy znaków. */
function occurrences(text: string, find: string | RegExp): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (typeof find === "string") {
    let from = 0;
    for (;;) {
      const at = text.indexOf(find, from);
      if (at < 0) break;
      out.push({ start: at, end: at + find.length });
      from = at + find.length;
    }
    return out;
  }
  const re = new RegExp(find.source, find.flags.includes("g") ? find.flags : `${find.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) break;
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Element `<w:r>` (run Worda) z podziałem na części, które przepisujemy. */
interface ElementRun {
  /** Pozycja `<w:r` w XML akapitu. */
  start: number;
  /** Pozycja tuż za `</w:r>`. */
  end: number;
  /** Otwierający znacznik razem z atrybutami. */
  open: string;
  innerStart: number;
  innerEnd: number;
  /** `<w:rPr>…</w:rPr>` runu albo pusty napis (run bez własnego formatowania). */
  rPr: string;
}

/**
 * Runy akapitu. `<w:rPr>` nie łapie się w `<w:r[\s>]`, a `</w:rPr>` nie jest
 * `</w:r>`, więc leniwe dopasowanie do pierwszego `</w:r>` jest poprawne.
 * Puste `<w:r/>` pomijamy — nie ma w nich `<w:t>`, więc nic do nich nie trafi.
 */
const R_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const R_CLOSE = "</w:r>";
const RPR_RE = /^(?:<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr(?:\s[^>]*)?\/>)/;

function scanElementRuns(paraXml: string): ElementRun[] {
  const out: ElementRun[] = [];
  R_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = R_RE.exec(paraXml)) !== null) {
    const openLen = m[0].indexOf(">") + 1;
    const innerStart = m.index + openLen;
    const innerEnd = m.index + m[0].length - R_CLOSE.length;
    // `w:rPr` MUSI być pierwszym dzieckiem runu — kotwica `^` pilnuje, żebyśmy
    // nie wzięli za formatowanie runu czegoś, co leży dalej w treści.
    const rPr = RPR_RE.exec(paraXml.slice(innerStart, innerEnd));
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      open: m[0].slice(0, openLen),
      innerStart,
      innerEnd,
      rPr: rPr ? rPr[0] : "",
    });
  }
  return out;
}

/** Run, wewnątrz którego leży `<w:t>` o podanej pozycji. */
function enclosingRun(runs: ElementRun[], tOpenStart: number): ElementRun | undefined {
  return runs.find((r) => r.start < tOpenStart && tOpenStart < r.end);
}

/** Kawałek przepisywanego runu: fragment tekstu albo sam `{tag}`. */
type RunSegment = { kind: "text"; raw: string } | { kind: "tag"; tag: string };

/**
 * Wstawia `{tag}` w miejsce wskazanych zakresów znaków.
 *
 * KAŻDY TAG DOSTAJE WŁASNY `<w:r>`. Podgląd w aplikacji koloruje pola wzoru
 * (żółte = do uzupełnienia, zielone = wypełnione), a `w:highlight` jest
 * własnością CAŁEGO runu — gdyby `{tag}` siedział w runie razem z sąsiednim
 * zdaniem, podświetliłoby się pół akapitu. Dlatego pierwszy dotknięty run
 * tniemy na [prefiks][{tag}][sufiks] z kopią `<w:rPr>` w każdej części (wygląd
 * dokumentu zostaje bit w bit ten sam). Kolejne dotknięte runy tylko tracą
 * pokrytą część tekstu (pustych runów NIE kasujemy — Word trzyma na nich
 * formatowanie).
 */
function applyRanges(paraXml: string, ranges: CharRange[]): string {
  const runs = scanRuns(paraXml);
  const chars = charRefs(runs);
  const elementRuns = scanElementRuns(paraXml);

  const covered = new Uint8Array(chars.length);
  const owner = new Map<number, string>();
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let prevEnd = -1;
  for (const r of sorted) {
    if (r.start < prevEnd) fail(`Zakresy tagów nachodzą na siebie (${r.tag})`);
    prevEnd = r.end;
    owner.set(r.start, r.tag);
    for (let i = r.start; i < r.end; i++) covered[i] = 1;
  }

  const touched = new Set<number>();
  for (const r of sorted) for (let i = r.start; i < r.end; i++) touched.add(chars[i].run);

  const edits: { start: number; end: number; text: string }[] = [];
  for (const ri of touched) {
    const run = runs[ri];
    const element = enclosingRun(elementRuns, run.openStart);
    if (!element) fail(`Znacznik <w:t> poza <w:r> — nie ma czego dzielić (offset ${run.openStart})`);
    // Podział zakłada, że `<w:t>` jest w runie jedyny; run z dwoma (rozdzielonymi
    // np. tabulatorem) trzeba by ciąć inaczej — wolimy stanąć niż zgadywać.
    const tCount = scanRuns(paraXml.slice(element.start, element.end)).length;
    if (tCount !== 1) {
      fail(`Run z ${tCount} znacznikami <w:t> — podział na [prefiks][tag][sufiks] jest niejednoznaczny`);
    }

    const segments: RunSegment[] = [];
    let acc = "";
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c.run !== ri) continue;
      const tag = owner.get(i);
      if (tag) {
        segments.push({ kind: "text", raw: acc });
        acc = "";
        segments.push({ kind: "tag", tag });
      }
      if (covered[i]) continue;
      acc += run.raw.slice(c.off, c.off + c.len);
    }
    segments.push({ kind: "text", raw: acc });

    const kept = segments.filter((s) => s.kind === "tag" || s.raw.length > 0);
    if (kept.length === 0) kept.push({ kind: "text", raw: "" });

    // Co w runie stało PRZED `<w:t>` (rPr, `<w:tab/>`) zostaje na pierwszym
    // kawałku, co PO nim — na ostatnim. Kolejność treści runu się nie zmienia.
    const innerBefore = paraXml.slice(element.innerStart, run.openStart);
    const innerAfter = paraXml.slice(run.contentEnd + T_CLOSE.length, element.innerEnd);
    const attrs = preserveAttrs(run.attrs);

    const rebuilt = kept
      .map((segment, idx) => {
        const before = idx === 0 ? innerBefore : element.rPr;
        const after = idx === kept.length - 1 ? innerAfter : "";
        const body = segment.kind === "tag" ? `{${segment.tag}}` : segment.raw;
        return `${element.open}${before}<w:t${attrs}>${body}</w:t>${after}${R_CLOSE}`;
      })
      .join("");

    edits.push({ start: element.start, end: element.end, text: rebuilt });
  }

  edits.sort((a, b) => b.start - a.start);
  let xml = paraXml;
  for (const e of edits) xml = xml.slice(0, e.start) + e.text + xml.slice(e.end);
  return xml;
}

/** `<w:hyperlink r:id="rIdN">…</w:hyperlink>` → same runy ze środka. */
function unwrapHyperlink(paraXml: string, relId: string): string {
  const re = new RegExp(`<w:hyperlink[^>]*\\br:id="${relId}"[^>]*>([\\s\\S]*?)</w:hyperlink>`);
  const m = re.exec(paraXml);
  if (!m) fail(`Nie znaleziono hiperłącza ${relId} w akapicie`);
  return paraXml.slice(0, m.index) + m[1] + paraXml.slice(m.index + m[0].length);
}

// ---------------------------------------------------------------------------
// Sprawdzanie poprawności XML (bez zależności — Node nie ma parsera XML)
// ---------------------------------------------------------------------------

/**
 * Minimalna kontrola dobrego uformowania: zbilansowane znaczniki, brak gołego
 * „<” w tekście, każde „&” jako encja. To nie jest walidacja schematu OOXML —
 * chodzi o wyłapanie sytuacji, w której podmiana tekstu rozjechała znaczniki.
 */
export function assertWellFormedXml(label: string, xmlRaw: string): void {
  const xml = xmlRaw
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "");

  const stack: string[] = [];
  // Grupa atrybutów LENIWA — zachłanna zjadałaby końcowy „/” pustego znacznika
  // (`<w:tab …/>`) i każdy taki znacznik wyglądałby na otwierający.
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const between = xml.slice(pos, m.index);
    if (between.includes("<")) fail(`${label}: gołe „<” w treści (offset ${pos})`);
    for (const amp of between.match(/&[^;]{0,12};?/g) ?? []) {
      if (!/^&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);$/.test(amp)) {
        fail(`${label}: nieprawidłowa encja ${JSON.stringify(amp)}`);
      }
    }
    pos = m.index + m[0].length;
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (open !== name) fail(`${label}: </${name}> zamyka <${open ?? "—"}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  if (xml.slice(pos).includes("<")) fail(`${label}: gołe „<” na końcu pliku`);
  if (stack.length) fail(`${label}: niedomknięte znaczniki: ${stack.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Tagowanie
// ---------------------------------------------------------------------------

/**
 * Zaznaczenia zakreślaczem z oryginału (`<w:highlight w:val="yellow"/>` i
 * „white”). W Wordzie ktoś ręcznie podświetlił miejsca do uzupełnienia — po
 * otagowaniu robi to aplikacja (kolorowanie pól w podglądzie), a żółte tło
 * wchodziłoby jej w drogę i szłoby do klienta w gotowej umowie. `<w:shd>`
 * ZOSTAWIAMY: to białe tło akapitu, nieszkodliwe i częściej z motywu stylu.
 */
const HIGHLIGHT_RE = /<w:highlight\b[^>]*\/>|<w:highlight\b[^>]*>[\s\S]*?<\/w:highlight>/g;

function tagDocument(inputBuffer: Buffer): Buffer {
  const zip = new PizZip(inputBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) fail("Archiwum nie zawiera word/document.xml — to nie jest plik .docx");
  // Zakreślacz leci PRZED skanowaniem akapitów: usuwa tylko elementy `w:rPr`,
  // więc tekst (a z nim asercje EXPECTED_TEXT) zostaje nietknięty.
  const removedHighlights = (docFile.asText().match(HIGHLIGHT_RE) ?? []).length;
  const xml = docFile.asText().replace(HIGHLIGHT_RE, "");
  console.log(`Usunięto zaznaczenia zakreślaczem: ${removedHighlights}`);

  // 1. Akapity z pozycjami w oryginalnym XML.
  PARA_RE.lastIndex = 0;
  const paragraphs: { start: number; end: number; xml: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = PARA_RE.exec(xml)) !== null) {
    paragraphs.push({ start: m.index, end: m.index + m[0].length, xml: m[0] });
  }
  if (paragraphs.length !== PARAGRAPH_COUNT) {
    fail(
      `Wzór ma ${paragraphs.length} akapitów zamiast ${PARAGRAPH_COUNT} — mapa indeksów nie pasuje do tego dokumentu`
    );
  }

  // 2. Asercja treści akapitów, w które wchodzimy.
  for (const [idx, expected] of Object.entries(EXPECTED_TEXT)) {
    const i = Number(idx);
    const actual = paragraphText(paragraphs[i].xml);
    if (actual !== expected) {
      fail(`Akapit ${i} ma inną treść niż wzór.\n  oczekiwano: ${JSON.stringify(expected)}\n  jest:       ${JSON.stringify(actual)}`);
    }
  }

  // 3. Rozpakowanie hiperłączy (nie zmienia tekstu, więc idzie przed tagami).
  for (const h of HYPERLINKS) {
    paragraphs[h.paragraph].xml = unwrapHyperlink(paragraphs[h.paragraph].xml, h.relId);
  }

  // 4. Zakresy znaków dla każdego tagu — liczone na tekście PO rozpakowaniu linków.
  const byParagraph = new Map<number, CharRange[]>();
  for (const spec of TAGS) {
    const para = paragraphs[spec.paragraph];
    if (!para) fail(`Tag {${spec.tag}}: nie ma akapitu ${spec.paragraph}`);
    const text = paragraphText(para.xml);
    const found = occurrences(text, spec.find);
    const expectedCount = spec.expectedCount ?? 1;
    if (found.length !== expectedCount) {
      fail(
        `Tag {${spec.tag}}: fraza ${String(spec.find)} występuje w akapicie ${spec.paragraph} ` +
          `${found.length} raz(y), oczekiwano ${expectedCount}`
      );
    }
    const hit = found[spec.occurrence ?? 0];
    if (!hit) fail(`Tag {${spec.tag}}: brak wystąpienia nr ${spec.occurrence ?? 0}`);
    const list = byParagraph.get(spec.paragraph) ?? [];
    list.push({ start: hit.start, end: hit.end, tag: spec.tag });
    byParagraph.set(spec.paragraph, list);
  }
  for (const [idx, ranges] of byParagraph) {
    paragraphs[idx].xml = applyRanges(paragraphs[idx].xml, ranges);
  }

  // 5. Sklejenie dokumentu z powrotem (od końca, żeby offsety zostały ważne).
  let outXml = xml;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i];
    outXml = outXml.slice(0, p.start) + p.xml + outXml.slice(p.end);
  }
  assertWellFormedXml("word/document.xml", outXml);

  // 6. Usunięcie relacji po rozpakowanych hiperłączach — bez tego w pliku
  //    zostaje mailto: poprzedniego klienta, choć nic już go nie pokazuje.
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (!relsFile) fail("Brak word/_rels/document.xml.rels");
  let rels = relsFile.asText();
  for (const h of HYPERLINKS) {
    const re = new RegExp(`<Relationship[^>]*\\bId="${h.relId}"[^>]*/>`);
    if (!re.test(rels)) fail(`Brak relacji ${h.relId} w document.xml.rels`);
    rels = rels.replace(re, "");
  }
  assertWellFormedXml("word/_rels/document.xml.rels", rels);

  zip.file("word/document.xml", outXml);
  zip.file("word/_rels/document.xml.rels", rels);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

// ---------------------------------------------------------------------------
// Weryfikacja: próbny render docxtemplaterem
// ---------------------------------------------------------------------------

function verify(templateBuffer: Buffer, originalBuffer: Buffer): void {
  // 1. Wzór bez zakreślacza — kolorowanie pól robi wyłącznie podgląd w aplikacji.
  const templateXml = new PizZip(templateBuffer).file("word/document.xml")!.asText();
  const leftovers = (templateXml.match(HIGHLIGHT_RE) ?? []).length;
  if (leftovers) fail(`W szablonie zostało ${leftovers} × <w:highlight> — oczekiwano 0`);

  // 2. Każdy `{tag}` w OSOBNYM runie, którego cały tekst to dokładnie `{tag}`.
  //    Bez tego podświetlenie w podglądzie objęłoby sąsiedni tekst.
  const tagRuns = new Map<string, number>();
  R_RE.lastIndex = 0;
  let rm: RegExpExecArray | null;
  while ((rm = R_RE.exec(templateXml)) !== null) {
    const text = charRefs(scanRuns(rm[0]))
      .map((c) => c.ch)
      .join("");
    const single = /^\{([A-Za-z0-9_]+)\}$/.exec(text);
    if (single) tagRuns.set(single[1], (tagRuns.get(single[1]) ?? 0) + 1);
    else if (text.includes("{") || text.includes("}")) {
      fail(`Run z tagiem niesie też inny tekst: ${JSON.stringify(text)}`);
    }
  }
  for (const spec of TAGS) {
    const n = tagRuns.get(spec.tag) ?? 0;
    if (n !== 1) fail(`Tag {${spec.tag}} siedzi w ${n} runach o treści dokładnie „{${spec.tag}}”, oczekiwano 1`);
  }

  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: false,
    linebreaks: false,
    nullGetter: () => "«BRAK»",
  });

  const values: Record<string, string> = {};
  for (const spec of TAGS) values[spec.tag] = `«${spec.tag}»`;
  doc.render(values);

  const rendered = doc.getZip();
  const renderedXml = rendered.file("word/document.xml")!.asText();

  const braces = renderedXml.match(/[{}]/g) ?? [];
  if (braces.length) fail(`Po renderze zostało ${braces.length} nawiasów klamrowych w document.xml`);

  for (const spec of TAGS) {
    const marker = `«${spec.tag}»`;
    const n = renderedXml.split(marker).length - 1;
    if (n !== 1) fail(`Znacznik ${marker} po renderze występuje ${n} raz(y), oczekiwano 1`);
  }
  if (renderedXml.includes("«BRAK»")) fail("Render zgłosił nieznany tag (nullGetter) — mapa tagów jest niepełna");

  // Każdy plik XML w wyniku musi być parsowalny…
  const renderedBuffer = rendered.generate({ type: "nodebuffer" }) as Buffer;
  const check = new PizZip(renderedBuffer);
  for (const name of Object.keys(check.files)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    assertWellFormedXml(name, check.file(name)!.asText());
  }

  // …a zestaw PLIKÓW w zipie identyczny z oryginałem (nic nie zgubiliśmy: nagłówek,
  // stopka, logo, numerowanie paragrafów). Wpisy katalogowe („word/”, „docProps/”)
  // pomijamy: dokłada je sam PizZip przy zapisie i Word ich nie rozróżnia.
  const names = (buf: Buffer) =>
    Object.values(new PizZip(buf).files)
      .filter((f) => !f.dir)
      .map((f) => f.name)
      .sort()
      .join("\n");
  const missing = names(originalBuffer)
    .split("\n")
    .filter((n) => !names(renderedBuffer).split("\n").includes(n));
  if (missing.length) fail(`Po renderze brakuje wpisów zip: ${missing.join(", ")}`);
  const extra = names(renderedBuffer)
    .split("\n")
    .filter((n) => !names(originalBuffer).split("\n").includes(n));
  if (extra.length) fail(`Po renderze doszły wpisy zip: ${extra.join(", ")}`);

  // Kontrola, że hiperłącza naprawdę zniknęły z relacji.
  const rels = check.file("word/_rels/document.xml.rels")!.asText();
  for (const h of HYPERLINKS) {
    if (rels.includes(`"${h.relId}"`)) fail(`Relacja ${h.relId} nadal jest w document.xml.rels`);
  }
  if (rels.includes("m.pawlak@autobielany.pl")) fail("W relacjach został mailto: poprzedniego klienta");

  console.log(
    `Weryfikacja OK: ${TAGS.length} tagów (każdy we własnym runie), 0 × w:highlight, ` +
      `render bez pozostałości, zestaw wpisów zip zgodny.`
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_IN = "obiekty/Aktualne Drafty 05.2023/ALFA G/Aktualna Umowa Draft Tylko ZDW.docx";
const DEFAULT_OUT = "templates/umowy/zdw-alfa-group.docx";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const input = resolve(arg("in") ?? DEFAULT_IN);
  const output = resolve(arg("out") ?? DEFAULT_OUT);
  const shouldVerify = process.argv.includes("--verify");

  const original = readFileSync(input);
  const tagged = tagDocument(original);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, tagged);
  console.log(`Zapisano szablon: ${output} (${tagged.length} B, ${TAGS.length} tagów)`);

  if (shouldVerify) verify(tagged, original);
}

try {
  main();
} catch (error) {
  if (error instanceof TagError) {
    console.error(`BŁĄD: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
