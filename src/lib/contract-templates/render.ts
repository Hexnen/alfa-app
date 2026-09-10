/**
 * Render umowy z otagowanego wzoru Worda (docxtemplater + PizZip).
 *
 * DLACZEGO DOCX Z ORYGINAŁU, A NIE WŁASNY GENERATOR. Wzór ma nagłówek z logo,
 * stopkę, numer koncesji, wcięcia i numerację paragrafów, na które firma patrzy
 * od lat. Odtwarzanie tego w generatorze PDF-ów kosztowałoby tygodnie i i tak
 * wyszłoby „prawie tak samo”. Podmieniamy wyłącznie tekst w `<w:t>`, więc reszta
 * dokumentu jest bit w bit ta sama.
 *
 * FORMATOWANIE WARTOŚCI ROBI SIĘ TUTAJ, nie w formularzu: `fields` trzyma dane
 * w postaci maszynowej (data `YYYY-MM-DD`, kwota `1900` / `1900.50`), a do
 * dokumentu idzie postać ludzka (`07.01.2026`, `1900`, `1900,50`). Dzięki temu
 * ta sama wartość daje ten sam dokument niezależnie od tego, kto ją wpisał.
 */
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../calendar-labels.js";
import { TEMPLATES_DIR, type ContractFieldDef, type ContractTemplateDef } from "./registry.js";

/** Kwota do dokumentu: bez separatorów tysięcy, przecinek dziesiętny. */
export function moneyToDocx(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return s;
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
}

/** Data do dokumentu: `2026-01-07` → `07.01.2026` (inne formaty przepuszczamy). */
export function dateToDocx(raw: string): string {
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

/**
 * Kropki do wypełnienia długopisem — tyle samo, ile ma w oryginale wzoru pusta
 * osoba kontaktowa. Wchodzą w KAŻDE pole bez własnego `emptyPlaceholder`, gdy
 * renderujemy pusty wzór do podglądu (panel „Wzory umów”).
 */
export const BLANK_PLACEHOLDER = "\u2026".repeat(5) + ".";

/** Wartość jednego pola w postaci, w jakiej ma wejść do DOCX. */
export function fieldToDocx(def: ContractFieldDef, value: string | undefined, fallback = ""): string {
  const raw = (value ?? "").trim();
  if (!raw) return def.emptyPlaceholder ?? fallback;
  if (def.type === "money") return moneyToDocx(raw);
  if (def.type === "date") return dateToDocx(raw);
  return raw;
}

/**
 * Skrót pól — po nim poznajemy, że wygenerowany plik jest już nieaktualny.
 * Klucze sortujemy, żeby kolejność wpisywania w formularzu nie zmieniała skrótu.
 */
export function contractFieldsHash(fields: Record<string, string>): string {
  const normalized = Object.keys(fields)
    .sort()
    .map((k) => [k, fields[k] ?? ""]);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function templateFilePath(def: ContractTemplateDef): string {
  return join(TEMPLATES_DIR, def.file);
}

// ---------------------------------------------------------------------------
// Kolorowanie pól — TYLKO DO PODGLĄDU
// ---------------------------------------------------------------------------

/**
 * KOLORY NIE WCHODZĄ DO PLIKU, KTÓRY IDZIE DO KLIENTA. Handlowiec patrzy na
 * podgląd i musi od razu widzieć, czego brakuje — żółte = do uzupełnienia,
 * zielone = wypełnione. Ta sama umowa pobrana przyciskiem „Pobierz” jest czysta,
 * bo tło wstrzykujemy do KOPII XML-a trzymanej w pamięci, tuż przed renderem,
 * i nigdy nie zapisujemy jej na dysk.
 *
 * CIENIOWANIE (`w:shd`), NIE ZAKREŚLACZ (`w:highlight`). `w:highlight` przyjmuje
 * wyłącznie nazwy z zamkniętej listy Worda, a docx-preview maluje z nich
 * CSS-owe kolory — „green” wychodzi jako #008000 i czarny tekst umowy jest na
 * nim nieczytelny. `w:shd` bierze dowolny fill w hexie, więc dostajemy pastele
 * i tekst zostaje czytelny. Podgląd i tak nie ma być wydrukiem.
 *
 * Wzór dostał od tagowania po jednym `<w:r>` na `{tag}` (scripts/umowy/
 * tag-docx-template.ts) — dzięki temu tło, które jest własnością całego runu,
 * obejmuje dokładnie pole, a nie pół akapitu.
 */
export type ContractHighlight = "yellow" | "green";

/** Pastele tła pól — te same wartości co kwadraciki legendy w `DocxPreview`. */
export const CONTRACT_FIELD_FILL: Record<ContractHighlight, string> = {
  yellow: "FFF3A3",
  green: "C6F0C2",
};

const SHD_EL_RE = /<w:shd\b[^>]*\/>|<w:shd\b[^>]*>[\s\S]*?<\/w:shd>/;
const RUN_EL_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const RUN_TEXT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const TAG_ONLY_RE = /^\{([A-Za-z0-9_]+)\}$/;

/**
 * Elementy `CT_RPr`, które wg schematu OOXML stoją PO `w:shd` (kolejność
 * w `EG_RPrBase` jest sekwencją, nie zbiorem — Word odrzuca dokument, w którym
 * `w:shd` wylądował za `w:lang`). Wstawiamy więc przed pierwszym z nich,
 * a gdy żadnego nie ma — na końcu `w:rPr`.
 */
const RPR_AFTER_SHD = [
  "fitText",
  "vertAlign",
  "rtl",
  "cs",
  "em",
  "lang",
  "eastAsianLayout",
  "specVanish",
  "oMath",
];

/** Najwcześniejsza pozycja któregokolwiek z elementów „po w:shd”. */
function firstAfterShd(rPrBody: string): number {
  let at = -1;
  for (const name of RPR_AFTER_SHD) {
    const m = new RegExp(`<w:${name}(?=[\\s/>])`).exec(rPrBody);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}

/**
 * Ten sam run z pastelowym tłem w `w:rPr` (tworzy `w:rPr`, gdy go nie było).
 * Run, który MA już własne `<w:shd>` (w oryginale wzoru są białe `FFFFFF`),
 * dostaje podmieniony ten element — drugi `w:shd` łamałby schemat.
 */
function withFieldShading(runXml: string, color: ContractHighlight): string {
  const openLen = runXml.indexOf(">") + 1;
  const open = runXml.slice(0, openLen);
  const inner = runXml.slice(openLen, runXml.length - "</w:r>".length);
  const el = `<w:shd w:val="clear" w:color="auto" w:fill="${CONTRACT_FIELD_FILL[color]}"/>`;

  const paired = /^(<w:rPr(?:\s[^>]*)?>)([\s\S]*?)(<\/w:rPr>)/.exec(inner);
  if (paired) {
    const body = paired[2];
    const merged = SHD_EL_RE.test(body)
      ? body.replace(SHD_EL_RE, el)
      : (() => {
          const at = firstAfterShd(body);
          return at < 0 ? body + el : body.slice(0, at) + el + body.slice(at);
        })();
    return `${open}${paired[1]}${merged}${paired[3]}${inner.slice(paired[0].length)}</w:r>`;
  }
  const empty = /^<w:rPr(?:\s[^>]*)?\/>/.exec(inner);
  const rest = empty ? inner.slice(empty[0].length) : inner;
  return `${open}<w:rPr>${el}</w:rPr>${rest}</w:r>`;
}

/**
 * Wstrzykuje tło do runów, których CAŁY tekst to `{klucz}`. Runy bez koloru
 * (`colorOf` zwraca null) zostają nietknięte.
 */
export function highlightTagRuns(xml: string, colorOf: (key: string) => ContractHighlight | null): string {
  return xml.replace(RUN_EL_RE, (runXml) => {
    let text = "";
    RUN_TEXT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RUN_TEXT_RE.exec(runXml)) !== null) text += m[1];
    const tag = TAG_ONLY_RE.exec(text);
    if (!tag) return runXml;
    const color = colorOf(tag[1]);
    return color ? withFieldShading(runXml, color) : runXml;
  });
}

/**
 * Czy pole jest „do uzupełnienia”. Poza pustką liczą się też kropkowane
 * placeholdery („…….”) — w dokumencie znaczą dokładnie to samo: miejsce do
 * wpisania długopisem.
 */
export function isBlankContractValue(raw: string | undefined): boolean {
  const s = (raw ?? "").trim();
  return s === "" || /^[.…\s]+$/.test(s);
}

/** Kolor każdego pola szablonu przy danych wartościach. */
export function contractHighlightColors(
  def: ContractTemplateDef,
  values: Record<string, string>
): Map<string, ContractHighlight> {
  const out = new Map<string, ContractHighlight>();
  for (const field of def.fields) {
    out.set(field.key, isBlankContractValue(values[field.key]) ? "yellow" : "green");
  }
  return out;
}

/** Ile pól zostało do uzupełnienia (nagłówek `X-Contract-Missing`). */
export function countMissingContractFields(def: ContractTemplateDef, values: Record<string, string>): number {
  return def.fields.filter((f) => isBlankContractValue(values[f.key])).length;
}

/**
 * Surowy wzór z `{tagami}` z pastelowym tłem na wszystkich polach (podgląd trybu
 * „z tagami”). Nie przechodzi przez docxtemplater — w tym trybie tagi mają
 * zostać widoczne.
 */
export function highlightTaggedTemplateDocx(def: ContractTemplateDef): Buffer {
  const path = templateFilePath(def);
  if (!existsSync(path)) {
    throw new ApiError(500, `Brak pliku szablonu umowy (${def.file}) — skontaktuj się z administratorem.`);
  }
  const keys = new Set(def.fields.map((f) => f.key));
  const zip = new PizZip(readFileSync(path));
  const xml = zip.file("word/document.xml");
  if (!xml) throw new ApiError(500, `Plik szablonu ${def.file} nie jest dokumentem Worda.`);
  zip.file("word/document.xml", highlightTagRuns(xml.asText(), (key) => (keys.has(key) ? "yellow" : null)));
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

/**
 * Renderuje DOCX. `nullGetter` wraca do `emptyPlaceholder` pola — tag, którego
 * nikt nie wypełnił, ma zostawić w dokumencie kropki, a nie napis „undefined”.
 *
 * `highlight` włącza kolorowanie pól (żółte/zielone) — wyłącznie dla podglądu
 * w aplikacji; plik zapisywany na dysk i pobierany przez użytkownika powstaje
 * BEZ tej opcji.
 */
export function renderContractDocx(
  def: ContractTemplateDef,
  values: Record<string, string>,
  options?: { emptyFallback?: string; highlight?: boolean }
): Buffer {
  const fallback = options?.emptyFallback ?? "";
  const path = templateFilePath(def);
  if (!existsSync(path)) {
    throw new ApiError(500, `Brak pliku szablonu umowy (${def.file}) — skontaktuj się z administratorem.`);
  }

  const byKey = new Map(def.fields.map((f) => [f.key, f]));
  const data: Record<string, string> = {};
  for (const field of def.fields) data[field.key] = fieldToDocx(field, values[field.key], fallback);

  const zip = new PizZip(readFileSync(path));
  if (options?.highlight) {
    // Tło wchodzi PRZED renderem, dopóki runy niosą jeszcze `{tag}` —
    // po podmianie wartości nie da się już poznać, który run był polem.
    const colors = contractHighlightColors(def, values);
    const xml = zip.file("word/document.xml");
    if (xml) zip.file("word/document.xml", highlightTagRuns(xml.asText(), (key) => colors.get(key) ?? null));
  }

  try {
    const doc = new Docxtemplater(zip, {
      paragraphLoop: false,
      linebreaks: false,
      // Bez własnego escapowania — docxtemplater sam koduje encje XML.
      nullGetter: (part: { value?: string }) => {
        const def2 = part?.value ? byKey.get(part.value) : undefined;
        return def2?.emptyPlaceholder ?? fallback;
      },
    });
    doc.render(data);
    return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  } catch (error) {
    // Błędy docxtemplater niosą listę `properties.errors` z angielskim opisem —
    // do logu tak, do użytkownika polskie zdanie z nazwą szablonu.
    console.error(`Błąd renderu szablonu ${def.key}:`, error);
    throw new ApiError(500, `Nie udało się wygenerować dokumentu z szablonu „${def.label}”.`);
  }
}
