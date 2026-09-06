/**
 * Podzbiór markdownu na potrzeby „Opisów" w ofertach — JEDNA funkcja obsługuje
 * i podgląd w edytorze, i wydruk.
 *
 * Dlaczego nie `react-markdown` (jest w projekcie, korzysta z niego asystent):
 * `offerPrint.ts` skleja SUROWY string HTML i wrzuca go przez `document.write`
 * do osobnego okna — komponent Reacta tam nie zadziała. A skoro wydruk i tak
 * musi mieć własny renderer, to edytor używa tego samego, żeby podgląd
 * pokazywał dokładnie to, co wyjdzie na papierze.
 *
 * BEZPIECZEŃSTWO — to jedyna rzecz, która trzyma tę funkcję w ryzach:
 * NAJPIERW escapujemy `&`, `<`, `>` w całym wejściu, DOPIERO POTEM podmieniamy
 * markery markdownu na znaczniki. Kolejność jest krytyczna — dzięki niej treść
 * wklejona z maila czy z Worda nie wstrzyknie HTML-a ani do wydruku, ani do
 * `dangerouslySetInnerHTML` w podglądzie, i nie potrzebujemy sanitizera.
 * Każda przyszła zmiana MUSI zachować ten porządek: escape → parser.
 */

/** Escape wejścia. Cudzysłowów nie ruszamy — wynik nigdy nie trafia do atrybutu. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Formatowanie w linii. Pogrubienie IDZIE PIERWSZE, żeby `**tekst**` nie
 * rozpadło się na dwie kursywy; po jego zamianie w tekście nie ma już par `**`,
 * więc kursywa może bezpiecznie łapać pojedyncze gwiazdki.
 */
function inline(text: string): string {
  return text
    .replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(\S(?:[^*]*\S)?)\*/g, "<em>$1</em>");
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul" | "ol"; lines: string[] };

const RE_H3 = /^##\s+(.*)$/;
const RE_H4 = /^###\s+(.*)$/;
const RE_UL = /^[-*]\s+(.*)$/;
const RE_OL = /^\d+\.\s+(.*)$/;

export function mdToHtml(src: string): string {
  if (!src || !src.trim()) return "";

  const lines = esc(src).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let block: Block | null = null;

  /** Zamyka bieżący blok — wywoływane przy każdej zmianie rodzaju treści. */
  const flush = () => {
    if (!block) return;
    if (block.kind === "p") {
      // Pojedyncze łamanie WEWNĄTRZ akapitu zostaje łamaniem, nie nowym akapitem.
      out.push(`<p>${block.lines.map(inline).join("<br>")}</p>`);
    } else {
      const items = block.lines.map((l) => `<li>${inline(l)}</li>`).join("");
      out.push(`<${block.kind}>${items}</${block.kind}>`);
    }
    block = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      flush();
      continue;
    }

    // `###` sprawdzamy przed `##`, bo wzorzec `##` złapałby też trzeci hash.
    const h4 = RE_H4.exec(line);
    if (h4) {
      flush();
      out.push(`<h4>${inline(h4[1].trim())}</h4>`);
      continue;
    }
    const h3 = RE_H3.exec(line);
    if (h3) {
      flush();
      // h1/h2 są na wydruku oferty zajęte przez nagłówek dokumentu i sekcje.
      out.push(`<h3>${inline(h3[1].trim())}</h3>`);
      continue;
    }

    const ol = RE_OL.exec(line);
    const ul = ol ? null : RE_UL.exec(line);
    if (ol || ul) {
      const kind = ol ? "ol" : "ul";
      // Kolejne wiersze tego samego rodzaju listy scalają się w jeden <ul>/<ol>;
      // zmiana rodzaju zamyka poprzednią listę i otwiera nową.
      if (!block || block.kind !== kind) {
        flush();
        block = { kind, lines: [] };
      }
      block.lines.push((ol ? ol[1] : ul![1]).trim());
      continue;
    }

    if (!block || block.kind !== "p") {
      flush();
      block = { kind: "p", lines: [] };
    }
    block.lines.push(line);
  }
  flush();

  return out.join("");
}
