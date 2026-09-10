/**
 * „Markdown-lite" dla notatek — czysta funkcja `parseRichText(text, mode)`,
 * która zamienia wolny tekst na drzewo bloków. Renderowanie robi
 * `components/RichText.tsx`; tutaj nie ma ani Reacta, ani HTML-a, więc parser
 * testuje się przez `npx tsx` (scripts/test-richtext.ts).
 *
 * SKŁADNIA (świadomie wąska — to notatki, nie edytor):
 *   • akapit = blok linii; pusta linia rozdziela akapity, pojedynczy `\n`
 *     zostaje łamaniem linii;
 *   • `- `, `* `, `• ` → lista punktowana; `1. `, `1)` → numerowana;
 *     wcięcie o 2+ spacje zagnieżdża (maks. 2 poziomy);
 *   • `**pogrubienie**`, `*kursywa*`, `_kursywa_` — tylko na granicy słowa,
 *     więc `nazwa_pliku_x` i gwiazdki w adresach zostają jak są;
 *   • `>` na początku linii → cytat;
 *   • linia z samych `---` / `___` / `===` (≥3) → separator;
 *   • `Etykieta:` na początku linii → pogrubiona etykieta, reszta normalnie;
 *   • adresy, e-maile i telefony → linki (patrz `lib/linkify.ts`).
 *
 * TRYB `mail` dokłada to, co przychodzi z Outlooka:
 *   • cytowana historia korespondencji (od `-----Wiadomość oryginalna-----`,
 *     `Od:`+`Wysłano:`, `Dnia … napisał(a):`, `On … wrote:`) wycięta do
 *     osobnego bloku — front zwija ją domyślnie;
 *   • nagłówki Od/Do/DW/Wysłano/Temat w kompaktowym pudełku;
 *   • sygnatura (`-- ` albo „Pozdrawiam" i ≤8 linii do końca) przygaszona.
 */
import { linkifyText } from "./linkify";

export type RichInline =
  | { kind: "text"; value: string; bold?: boolean; italic?: boolean }
  | { kind: "url"; href: string; display: string }
  | { kind: "email"; href: string; display: string }
  | { kind: "phone"; href: string; display: string };

/** Jedna linia tekstu: opcjonalna etykieta („Zakres:") + reszta jako tokeny. */
export interface RichLine {
  label: string | null;
  nodes: RichInline[];
}

export interface RichListItem {
  /** 0 = poziom główny, 1 = wcięcie. */
  level: number;
  nodes: RichInline[];
}

export type RichBlock =
  | { kind: "paragraph"; lines: RichLine[] }
  | { kind: "list"; ordered: boolean; items: RichListItem[] }
  | { kind: "quote"; blocks: RichBlock[] }
  | { kind: "hr" }
  | { kind: "headers"; fields: { label: string; value: string }[] }
  | { kind: "signature"; lines: RichLine[] }
  | { kind: "history"; lineCount: number; blocks: RichBlock[] };

export type RichTextMode = "note" | "mail";

// ---------------------------------------------------------------------------
// Formatowanie w linii
// ---------------------------------------------------------------------------

/**
 * Pogrubienie i kursywa. Lookbehind/lookahead na granicę słowa jest tu istotą
 * rzeczy: bez nich `plik_2026_raport` stawał się kursywą, a `3 * 4 * 5`
 * rozjeżdżało akapit.
 */
const EMPHASIS =
  /\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu;

function parseEmphasis(text: string): RichInline[] {
  const out: RichInline[] = [];
  const push = (value: string, mark?: "bold" | "italic") => {
    if (!value) return;
    if (mark === "bold") out.push({ kind: "text", value, bold: true });
    else if (mark === "italic") out.push({ kind: "text", value, italic: true });
    else out.push({ kind: "text", value });
  };

  let last = 0;
  EMPHASIS.lastIndex = 0;
  for (let m = EMPHASIS.exec(text); m; m = EMPHASIS.exec(text)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) push(m[1], "bold");
    else push((m[2] ?? m[3]) as string, "italic");
  }
  push(text.slice(last));
  return out;
}

/** Linki najpierw, formatowanie tylko w tym, co zostało zwykłym tekstem. */
export function parseInline(text: string): RichInline[] {
  const out: RichInline[] = [];
  for (const token of linkifyText(text)) {
    if (token.kind === "text") out.push(...parseEmphasis(token.value));
    else out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rozpoznawanie linii
// ---------------------------------------------------------------------------

const RE_HR = /^\s*(?:-{3,}|_{3,}|={3,})\s*$/;
const RE_UL = /^(\s*)[-*•]\s+(.*)$/;
const RE_OL = /^(\s*)\d{1,3}[.)]\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
/** Etykieta na początku linii — krótka, maks. trzy słowa, z dwukropkiem i spacją. */
const RE_LABEL = /^([\p{L}][\p{L}\p{N} .,'’()/–-]{0,23}):(?:[ \t]+(.*))?$/u;

/** Nagłówki maila — po polsku i po angielsku, w kolejności z Outlooka. */
const HEADER_KEYS = [
  "od",
  "from",
  "do",
  "to",
  "dw",
  "cc",
  "kopia",
  "udw",
  "bcc",
  "wysłano",
  "wyslano",
  "sent",
  "data",
  "date",
  "temat",
  "subject",
  "nadawca",
  "odpowiedz do",
  "reply-to",
];
const RE_HEADER = /^\s*(?:\p{Emoji_Presentation}\s*)?([\p{L}-]{2,12}(?: do)?)\s*:\s*(.*)$/u;

function headerField(line: string): { label: string; value: string } | null {
  const m = line.match(RE_HEADER);
  if (!m) return null;
  const key = m[1].trim().toLowerCase();
  if (!HEADER_KEYS.includes(key)) return null;
  return { label: m[1].trim(), value: m[2].trim() };
}

/** Czy linia jest polem nagłówka maila (Od/Do/Temat/…). */
function isHeaderLine(line: string): boolean {
  return headerField(line) !== null;
}

/**
 * Czy blok nagłówków zaczynający się w linii `i` to WŁASNY nagłówek notatki,
 * a nie początek cytatu. Tak jest wtedy, gdy wszystko przed nim to też
 * nagłówki (albo pusto) — czyli notatka po prostu ZACZYNA się od „Od:/Temat:”,
 * jak kopia maila z Outlooka. Bez tego rozróżnienia cała treść takiej notatki
 * lądowała w zwiniętym bloku „Cytowana wiadomość”.
 */
function isOwnHeaderBlock(lines: string[], i: number): boolean {
  for (let j = 0; j < i; j++) {
    const before = lines[j].trim();
    if (!before) continue;
    if (!isHeaderLine(before)) return false;
  }
  return true;
}

/** Ostatnia linia ciągłego bloku nagłówków zaczynającego się w `i`. */
function endOfHeaderBlock(lines: string[], i: number): number {
  let j = i;
  while (j + 1 < lines.length && isHeaderLine(lines[j + 1].trim())) j++;
  return j;
}

/** Początek cytowanej historii korespondencji (indeks linii albo -1). */
export function findQuotedHistory(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^-{2,}\s*(original message|wiadomość oryginalna|wiadomosc oryginalna|forwarded message|wiadomość przekazana dalej|dalej przesłana wiadomość)\s*-{2,}$/i.test(line)) {
      return i;
    }
    if (/^(?:dnia|w dniu)\b.*napisał(?:\(a\)|a)?\s*:\s*$/i.test(line)) return i;
    if (/^on\b.*wrote\s*:\s*$/i.test(line)) return i;
    // `Od:` samo w sobie bywa zwykłą linią notatki — dopiero towarzystwo
    // kolejnych nagłówków (Wysłano/Do/Temat) znaczy, że zaczyna się cytat.
    if (/^(?:\p{Emoji_Presentation}\s*)?(od|from)\s*:/iu.test(line)) {
      const near = lines.slice(i + 1, i + 6);
      if (near.some((l) => /^\s*(wysłano|wyslano|sent|do|to|temat|subject|data|date)\s*:/i.test(l))) {
        if (isOwnHeaderBlock(lines, i)) {
          i = endOfHeaderBlock(lines, i);
          continue;
        }
        return i;
      }
    }
  }
  return -1;
}

/** Początek sygnatury (indeks linii albo -1) — `-- ` albo formuła grzecznościowa. */
export function findSignature(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^--\s*$/.test(lines[i])) return i;
  }
  const RE_SIGNOFF = /^\s*(pozdrawiam|pozdrowienia|z poważaniem|z powazaniem|z wyrazami szacunku|best regards|kind regards|regards|serdecznie pozdrawiam)\b[\s,.!–-]*$/i;
  // Formuła grzecznościowa liczy się tylko blisko końca — „Pozdrawiam" w środku
  // opisu rozmowy nie ma wyszarzać połowy notatki.
  for (let i = Math.max(0, lines.length - 9); i < lines.length; i++) {
    if (RE_SIGNOFF.test(lines[i])) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** `\r\n` → `\n`, koniec linii bez spacji, ciągi pustych linii do jednej. */
export function normalizeLines(text: string): string[] {
  const raw = (text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  const out: string[] = [];
  for (const line of raw) {
    if (!line.trim() && out.length > 0 && !out[out.length - 1].trim()) continue;
    out.push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function parseLine(line: string): RichLine {
  const trimmed = line.trim();
  const m = trimmed.match(RE_LABEL);
  if (m && !/https?:|@|\/\//.test(m[1]) && m[1].trim().split(/\s+/).length <= 3) {
    return { label: `${m[1].trim()}:`, nodes: parseInline(m[2] ?? "") };
  }
  return { label: null, nodes: parseInline(trimmed) };
}

function parseBlocks(lines: string[], mode: RichTextMode): RichBlock[] {
  const blocks: RichBlock[] = [];
  let paragraph: RichLine[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      flush();
      continue;
    }

    if (RE_HR.test(line)) {
      flush();
      blocks.push({ kind: "hr" });
      continue;
    }

    // Nagłówki maila — dopiero dwa z rzędu, żeby zwykłe „Temat: ...” w notatce
    // zostało etykietą akapitu, a nie pudełkiem.
    if (mode === "mail") {
      const first = headerField(line);
      if (first) {
        const fields = [first];
        let j = i + 1;
        while (j < lines.length) {
          const next = headerField(lines[j]);
          if (!next) break;
          fields.push(next);
          j++;
        }
        if (fields.length >= 2) {
          flush();
          blocks.push({ kind: "headers", fields });
          i = j - 1;
          continue;
        }
      }
    }

    const quote = line.match(RE_QUOTE);
    if (quote) {
      flush();
      const inner: string[] = [];
      let j = i;
      while (j < lines.length) {
        const q = lines[j].match(RE_QUOTE);
        if (!q) break;
        inner.push(q[1]);
        j++;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(normalizeLines(inner.join("\n")), mode) });
      i = j - 1;
      continue;
    }

    const ul = line.match(RE_UL);
    const ol = ul ? null : line.match(RE_OL);
    if (ul || ol) {
      flush();
      const ordered = !ul;
      const items: RichListItem[] = [];
      let j = i;
      while (j < lines.length) {
        const mu = lines[j].match(RE_UL);
        const mo = mu ? null : lines[j].match(RE_OL);
        const hit = ordered ? mo : mu;
        if (!hit) break;
        const indent = hit[1].replace(/\t/g, "  ").length;
        items.push({ level: Math.min(1, Math.floor(indent / 2)), nodes: parseInline(hit[2].trim()) });
        j++;
      }
      blocks.push({ kind: "list", ordered, items });
      i = j - 1;
      continue;
    }

    paragraph.push(parseLine(line));
  }

  flush();
  return blocks;
}

/**
 * Zamienia tekst notatki na bloki do wyrenderowania.
 * `mode="mail"` włącza wykrywanie cytowanej historii i sygnatury.
 */
export function parseRichText(text: string, mode: RichTextMode = "note"): RichBlock[] {
  const lines = normalizeLines(text);
  if (lines.length === 0) return [];
  if (mode !== "mail") return parseBlocks(lines, mode);

  const historyAt = findQuotedHistory(lines);
  const body = historyAt > 0 ? lines.slice(0, historyAt) : historyAt === 0 ? [] : lines;
  const history = historyAt >= 0 ? lines.slice(historyAt) : [];

  const blocks: RichBlock[] = [];
  if (body.length) {
    const sigAt = findSignature(body);
    if (sigAt >= 0) {
      blocks.push(...parseBlocks(normalizeLines(body.slice(0, sigAt).join("\n")), mode));
      const sigLines = normalizeLines(body.slice(sigAt).join("\n")).filter((l) => !/^--\s*$/.test(l));
      if (sigLines.length) blocks.push({ kind: "signature", lines: sigLines.map(parseLine) });
    } else {
      blocks.push(...parseBlocks(body, mode));
    }
  }

  if (history.length) {
    const inner = normalizeLines(history.join("\n"));
    blocks.push({ kind: "history", lineCount: inner.length, blocks: parseBlocks(inner, mode) });
  }

  return blocks;
}

/**
 * Czy notatka wygląda na skopiowaną z maila. Kopia notatki mailowej do
 * kartoteki obiektu zaczyna się nagłówkiem „📧 Temat: …”, a treść wklejona
 * ręcznie z Outlooka — kilkoma polami `Od:`/`Temat:` w pierwszych liniach.
 * Wtedy warto włączyć tryb `mail` (cytowana historia, sygnatura).
 */
export function looksLikeMailNote(text: string | null | undefined): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  if (value.startsWith("📧")) return true;
  const head = value.split("\n").slice(0, 4);
  const hasSubject = head.some((l) => /^\s*(temat|subject)\s*:/i.test(l));
  const hasFrom = head.some((l) => /^\s*(od|from|nadawca)\s*:/i.test(l));
  return hasSubject && hasFrom;
}
