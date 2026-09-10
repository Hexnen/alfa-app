/**
 * Test parsera „markdown-lite" dla notatek (frontend/src/lib/richtext.ts):
 *   npx tsx scripts/test-richtext.ts
 *
 * Parser jest czystą funkcją bez Reacta — dlatego da się go sprawdzić tutaj,
 * bez budowania frontu i bez przeglądarki. Renderowanie (RichText.tsx) tylko
 * zamienia zwrócone bloki na elementy, więc to jest właściwe miejsce na
 * pilnowanie składni.
 */
import {
  findQuotedHistory,
  findSignature,
  normalizeLines,
  parseInline,
  parseRichText,
  type RichBlock,
  type RichInline,
} from "../frontend/src/lib/richtext.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra, null, 1)}`}`);
  if (!cond) failures++;
}

/** Płaski podgląd tokenów: „tekst”, „**pogrubione**”, „URL(href)”. */
function inlineSketch(nodes: RichInline[]): string {
  return nodes
    .map((n) => {
      if (n.kind === "text") return n.bold ? `**${n.value}**` : n.italic ? `_${n.value}_` : n.value;
      return `${n.kind.toUpperCase()}(${n.href})`;
    })
    .join("");
}

/** Podgląd struktury bloków — do porównań w jednej linii. */
function sketch(blocks: RichBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case "paragraph":
          return `P[${b.lines.map((l) => `${l.label ? `${l.label} ` : ""}${inlineSketch(l.nodes)}`).join("\\n")}]`;
        case "list":
          return `${b.ordered ? "OL" : "UL"}[${b.items.map((i) => `${"·".repeat(i.level)}${inlineSketch(i.nodes)}`).join("|")}]`;
        case "quote":
          return `Q{${sketch(b.blocks)}}`;
        case "hr":
          return "HR";
        case "headers":
          return `H[${b.fields.map((f) => `${f.label}=${f.value}`).join("|")}]`;
        case "signature":
          return `SIG[${b.lines.map((l) => `${l.label ? `${l.label} ` : ""}${inlineSketch(l.nodes)}`).join("\\n")}]`;
        case "history":
          return `HIST(${b.lineCount}){${sketch(b.blocks)}}`;
        default:
          return "?";
      }
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
console.log("\n=== Akapity i łamania ===");

ok(
  "pusta linia rozdziela akapity, pojedynczy \\n to łamanie",
  sketch(parseRichText("Pierwszy\ndrugi wiersz\n\nNowy akapit")) === "P[Pierwszy\\ndrugi wiersz] P[Nowy akapit]",
  sketch(parseRichText("Pierwszy\ndrugi wiersz\n\nNowy akapit"))
);

ok(
  "≥3 puste linie zwijają się do jednej przerwy",
  normalizeLines("A\n\n\n\n\nB").join("|") === "A||B",
  normalizeLines("A\n\n\n\n\nB")
);

ok("końcowe spacje usuwane", normalizeLines("A   \nB\t\t").join("|") === "A|B", normalizeLines("A   \nB\t\t"));

ok("pusty tekst → brak bloków", parseRichText("   \n\n  ").length === 0);

// ---------------------------------------------------------------------------
console.log("\n=== Listy ===");

ok(
  "punktory -, * i •",
  sketch(parseRichText("- jeden\n* dwa\n• trzy")) === "UL[jeden|dwa|trzy]",
  sketch(parseRichText("- jeden\n* dwa\n• trzy"))
);

ok(
  "lista numerowana 1. i 2)",
  sketch(parseRichText("1. pierwszy\n2) drugi")) === "OL[pierwszy|drugi]",
  sketch(parseRichText("1. pierwszy\n2) drugi"))
);

ok(
  "wcięcie zagnieżdża punkt",
  sketch(parseRichText("- kamery\n  - IP\n- czujki")) === "UL[kamery|·IP|czujki]",
  sketch(parseRichText("- kamery\n  - IP\n- czujki"))
);

ok(
  "lista po akapicie zamyka akapit",
  sketch(parseRichText("Zakres prac\n- montaż\n- konfiguracja")) === "P[Zakres prac] UL[montaż|konfiguracja]",
  sketch(parseRichText("Zakres prac\n- montaż\n- konfiguracja"))
);

// ---------------------------------------------------------------------------
console.log("\n=== Wyróżnienia ===");

ok(
  "**pogrubienie** i *kursywa*",
  inlineSketch(parseInline("To jest **ważne** i *mniej ważne*")) === "To jest **ważne** i _mniej ważne_",
  inlineSketch(parseInline("To jest **ważne** i *mniej ważne*"))
);

ok(
  "_kursywa_ na granicy słowa",
  inlineSketch(parseInline("plik _nowy_ gotowy")) === "plik _nowy_ gotowy",
  inlineSketch(parseInline("plik _nowy_ gotowy"))
);

ok(
  "podkreślenia w środku słowa NIE są kursywą",
  inlineSketch(parseInline("raport_2026_koncowy.pdf")) === "raport_2026_koncowy.pdf",
  inlineSketch(parseInline("raport_2026_koncowy.pdf"))
);

ok(
  "gwiazdka jako mnożenie nie robi kursywy",
  inlineSketch(parseInline("3 * 4 = 12")) === "3 * 4 = 12",
  inlineSketch(parseInline("3 * 4 = 12"))
);

// ---------------------------------------------------------------------------
console.log("\n=== Cytat, separator, etykiety ===");

ok(
  "> na początku linii → cytat",
  sketch(parseRichText("Klient pisze:\n> nie działa kamera 3\n> proszę o przyjazd")) ===
    "P[Klient pisze: ] Q{P[nie działa kamera 3\\nproszę o przyjazd]}",
  sketch(parseRichText("Klient pisze:\n> nie działa kamera 3\n> proszę o przyjazd"))
);

ok("--- → separator", sketch(parseRichText("A\n\n---\n\nB")) === "P[A] HR P[B]", sketch(parseRichText("A\n\n---\n\nB")));
ok("=== → separator", sketch(parseRichText("A\n\n====\n\nB")) === "P[A] HR P[B]");
ok("___ → separator", sketch(parseRichText("A\n\n___\n\nB")) === "P[A] HR P[B]");

ok(
  "etykieta „Zakres:” wydzielona",
  sketch(parseRichText("Zakres: montaż 4 kamer\nTermin: 12.09")) === "P[Zakres: montaż 4 kamer\\nTermin: 12.09]",
  parseRichText("Zakres: montaż 4 kamer\nTermin: 12.09")
);

{
  const blocks = parseRichText("Uwagi: brak\nGodzina 10:30 na miejscu");
  const p = blocks[0] as Extract<RichBlock, { kind: "paragraph" }>;
  ok("etykieta to osobne pole linii", p.lines[0].label === "Uwagi:", p.lines[0]);
  ok("godzina 10:30 nie jest etykietą", p.lines[1].label === null, p.lines[1]);
}

// ---------------------------------------------------------------------------
console.log("\n=== Linki, e-mail, telefon ===");

{
  const blocks = parseRichText("Szczegóły: https://example.pl/x\nKontakt: biuro@example.pl, tel. +48 601 234 567");
  const p = blocks[0] as Extract<RichBlock, { kind: "paragraph" }>;
  ok("URL jako token url", inlineSketch(p.lines[0].nodes).includes("URL(https://example.pl/x)"), p.lines[0]);
  ok("e-mail jako mailto:", inlineSketch(p.lines[1].nodes).includes("EMAIL(mailto:biuro@example.pl)"), p.lines[1]);
  ok("telefon jako tel:", inlineSketch(p.lines[1].nodes).includes("PHONE(tel:+48601234567)"), p.lines[1]);
}

// ---------------------------------------------------------------------------
console.log("\n=== Tryb mail ===");

const MAIL = [
  "Dzień dobry,",
  "",
  "w załączeniu oferta na monitoring. Zakres:",
  "- 6 kamer IP",
  "- rejestrator 8-kanałowy",
  "",
  "Pozdrawiam",
  "Jan Kowalski",
  "tel. 601 234 567",
  "",
  "-----Wiadomość oryginalna-----",
  "Od: klient@example.pl",
  "Wysłano: 10 września 2026 08:15",
  "Do: biuro@alfagroup.pl",
  "Temat: Zapytanie o monitoring",
  "",
  "Proszę o wycenę monitoringu hali.",
].join("\n");

{
  const blocks = parseRichText(MAIL, "mail");
  const kinds = blocks.map((b) => b.kind).join(",");
  ok("tryb mail: akapit, lista, sygnatura, historia", kinds === "paragraph,paragraph,list,signature,history", kinds);

  const sig = blocks.find((b) => b.kind === "signature");
  ok("sygnatura zaczyna się od „Pozdrawiam”", sig?.kind === "signature" && sig.lines.length === 3, sig);

  const hist = blocks.find((b) => b.kind === "history");
  ok("historia ma policzone linie", hist?.kind === "history" && hist.lineCount > 0, hist?.kind === "history" ? hist.lineCount : hist);
  const headers = hist?.kind === "history" ? hist.blocks.find((b) => b.kind === "headers") : undefined;
  ok(
    "nagłówki Od/Wysłano/Do/Temat w pudełku",
    headers?.kind === "headers" && headers.fields.length === 4 && headers.fields[0].label === "Od",
    headers
  );
}

ok(
  "tryb note NIE wycina historii",
  parseRichText(MAIL, "note").every((b) => b.kind !== "history" && b.kind !== "signature")
);

{
  const t = ["Krótko: potwierdzam.", "", "Od: a@example.pl", "Do: b@example.pl", "Temat: X", "", "Treść."].join("\n");
  ok("„Od:” + „Do:” + „Temat:” też otwierają cytat", findQuotedHistory(t.split("\n")) === 2, findQuotedHistory(t.split("\n")));
}

ok(
  "„Dnia … napisał(a):” otwiera cytat",
  findQuotedHistory(["Ok, robimy.", "", "Dnia 10 września 2026 klient napisał(a):", "> proszę o ofertę"]) === 2
);

ok("„On … wrote:” otwiera cytat", findQuotedHistory(["Fine.", "On Wed, Sep 10, 2026 at 8:15 AM Client wrote:", "> hi"]) === 1);

ok(
  "samo „Od: ktoś” w notatce nie otwiera cytatu",
  findQuotedHistory(["Od: kierownika dostałem zgodę", "Robimy w piątek."]) === -1
);

ok("sygnatura po „-- ”", findSignature(["Treść", "--", "Jan Kowalski"]) === 1);
ok("„Z poważaniem” blisko końca", findSignature(["Treść", "Z poważaniem,", "Jan"]) === 1);
ok(
  "„Pozdrawiam” w środku długiej notatki nie jest sygnaturą",
  findSignature(["Pozdrawiam", ...Array.from({ length: 12 }, (_, i) => `linia ${i}`)]) === -1
);

// ---------------------------------------------------------------------------
console.log("\n=== Notatka, która ZACZYNA się nagłówkiem maila ===");

const MAIL_HEAD = [
  "📧 Temat: Zapytanie o monitoring hali",
  "Od: klient@example.pl",
  "Do: biuro@alfagroup.pl",
  "",
  "Dzień dobry,",
  "proszę o wycenę wg strony https://www.ipm.mazowsze.pl/ — zakres:",
  "- 6 kamer IP",
  "",
  "Pozdrawiam",
  "Jan Kowalski",
  "",
  "-----Wiadomość oryginalna-----",
  "Od: biuro@alfagroup.pl",
  "Wysłano: 9 września 2026 10:00",
  "Temat: Oferta",
  "",
  "> W załączeniu wstępna oferta.",
].join("\n");

{
  const blocks = parseRichText(MAIL_HEAD, "mail");
  const kinds = blocks.map((b) => b.kind).join(",");
  ok(
    "własny nagłówek NIE jest cytatem — treść zostaje widoczna",
    kinds === "headers,paragraph,list,signature,history",
    kinds
  );
  const h = blocks.find((b) => b.kind === "headers");
  ok(
    "„📧 Temat:” wpada do pudełka nagłówków razem z Od/Do",
    h?.kind === "headers" && h.fields.length === 3 && h.fields[0].label === "Temat",
    h
  );
  const hist = blocks.find((b) => b.kind === "history");
  ok("zwinięta jest TYLKO wiadomość oryginalna", hist?.kind === "history" && hist.lineCount === 6, hist?.kind === "history" ? hist.lineCount : hist);
  const body = blocks.find((b) => b.kind === "paragraph");
  ok(
    "URL z treści zostaje klikalny w akapicie",
    body?.kind === "paragraph" && inlineSketch(body.lines[1].nodes).includes("URL(https://www.ipm.mazowsze.pl/)"),
    body
  );
}

console.log(failures === 0 ? "\nWszystko przeszło." : `\n${failures} testów nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
