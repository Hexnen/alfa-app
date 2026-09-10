/**
 * HTML → czysty tekst opisu produktu.
 *
 * Nie używamy `html-to-text` (kolejna zależność) ani `.text()` z cheerio.
 * `.text()` jest bezużyteczne, bo opisy w tych sklepach są wklejone z Worda:
 * dziesiątki `<span style="font-family:Calibri">`, listy `<ul><li>` i tabele —
 * po `.text()` wychodzi jedna zbita linia. Chcemy tekst, który po wklejeniu do
 * kartoteki nadal się czyta: bloki oddzielone pustą linią, punkty jako „• ”,
 * komórki tabeli rozdzielone „ | ”.
 */
import type { Doc, Sel } from "./dom-types.js";

/** Znaczniki, po których leci przełamanie linii. */
const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "dl", "dt", "dd", "table", "tbody", "thead", "blockquote",
  "pre", "figure", "figcaption", "address", "form", "fieldset", "legend",
]);

export function htmlToText(doc: Doc, sel: Sel | null | undefined): string {
  if (!sel || sel.length === 0) return "";
  const out: string[] = [];
  sel.each((_i, el) => {
    walk(doc, el, 0, out);
    out.push("\n");
  });
  return tidy(out.join(""));
}

function walk(doc: Doc, node: any, listDepth: number, out: string[]): void {
  if (!node) return;
  if (node.type === "text") {
    // Białe znaki w źródle HTML są nieistotne — kolapsujemy je od razu, bo inaczej
    // wcięcia w kodzie strony robiłyby losowe łamania linii w opisie.
    const t = String(node.data ?? "").replace(/ /g, " ").replace(/\s+/g, " ");
    if (t) out.push(t);
    return;
  }
  if (node.type !== "tag") return;
  const tag = String(node.name ?? "").toLowerCase();
  const kids = (node.children ?? []) as any[];

  if (tag === "br" || tag === "hr") {
    out.push("\n");
    return;
  }
  if (tag === "li") {
    // Bez zamykającego "\n" — kolejny punkt zaczyna się własnym łamaniem, więc
    // punkty listy zostają w kolejnych liniach, a nie co drugą.
    out.push(`\n${"  ".repeat(Math.max(0, listDepth - 1))}• `);
    for (const k of kids) walk(doc, k, listDepth, out);
    return;
  }
  if (tag === "td" || tag === "th") {
    for (const k of kids) walk(doc, k, listDepth, out);
    out.push(" | ");
    return;
  }
  if (tag === "tr") {
    for (const k of kids) walk(doc, k, listDepth, out);
    out.push("\n");
    return;
  }
  const nextDepth = tag === "ul" || tag === "ol" ? listDepth + 1 : listDepth;
  if (BLOCK.has(tag)) {
    out.push("\n");
    for (const k of kids) walk(doc, k, nextDepth, out);
    out.push("\n");
    return;
  }
  for (const k of kids) walk(doc, k, nextDepth, out);
}

/** Wcięcie punktu listy zachowujemy, resztę spacji kolapsujemy. */
const BULLET_PREFIX = /^((?: {2})*• )?([\s\S]*)$/;

function tidy(raw: string): string {
  const lines = raw.split("\n").map((line) => {
    const m = BULLET_PREFIX.exec(line);
    const prefix = m?.[1] ?? "";
    const body = (m?.[2] ?? "")
      .replace(/ /g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s*\|\s*$/, "")
      .trim();
    return body ? `${prefix}${body}` : "";
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
