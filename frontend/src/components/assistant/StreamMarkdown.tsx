/* eslint-disable react-refresh/only-export-components -- helpery markdownu eksportowane obok komponentu (jak w roleplay) */
import { Fragment, memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Stała tożsamość tablicy pluginów — memo Bloków nie widzi „nowych” propsów co render.
const REMARK_PLUGINS = [remarkGfm];

/**
 * Markdown dla streamowanych wiadomości czatu (kopia z roleplay, bez rehypeDialog).
 *
 * Dwa problemy zwykłego <ReactMarkdown> na rosnącym tekście:
 *  1. Niedomknięte znaczniki (`*akcja` bez zamykającej `*`) renderują się jako
 *     goły tekst i "przeskakują" w kursywę dopiero przy domknięciu.
 *  2. Każdy chunk re-parsuje CAŁĄ wiadomość — długie odpowiedzi jankują.
 *
 * Rozwiązanie: tekst dzielimy na bloki (puste linie), gotowe bloki są
 * zmemoizowane (re-parsuje się tylko ostatni), a w ostatnim domykamy
 * wiszące znaczniki, żeby formatowanie było widoczne od pierwszego znaku.
 */

const FENCE_RE = /^\s{0,3}(```|~~~)/gm;

/** Domyka niedokończony markdown na końcu streamowanego tekstu. */
export function closeIncompleteMarkdown(md: string): string {
  let out = md;

  if (((out.match(FENCE_RE) || []).length) % 2 === 1) {
    const hanging = /(^|\n)\s{0,3}(```|~~~)[^\n]*$/.exec(out);
    if (!hanging) return out + "\n```";
    out = out.slice(0, hanging.index);
  }

  out = out.replace(/(^|\s)(`{1,2}|\*{1,3}|_{1,2}|~{1,2})$/, "$1");

  const ticks = (out.match(/`/g) || []).length;
  if (ticks % 2 === 1) out += "`";

  const scan = out
    .split(/^\s{0,3}(?:```|~~~).*$/m)
    .filter((_, i) => i % 2 === 0)
    .join("\n")
    .replace(/`[^`]*`/g, "")
    .replace(/^(\s*)\*(?=\s)/gm, "$1")
    .replace(/^\s*\*{3,}\s*$/gm, "");
  let closers = "";
  const bold = (scan.match(/\*\*/g) || []).length;
  const italic = (scan.replace(/\*\*/g, "").match(/\*/g) || []).length;
  const boldUnder = (scan.match(/__/g) || []).length;
  const strike = (scan.match(/~~/g) || []).length;
  if (italic % 2 === 1) closers += "*";
  if (bold % 2 === 1) closers += "**";
  if (boldUnder % 2 === 1) closers += "__";
  if (strike % 2 === 1) closers += "~~";
  return out + closers;
}

/** Dzieli markdown na bloki po pustych liniach, nie rozcinając code fence'ów. */
export function splitMarkdownBlocks(md: string): string[] {
  const parts = md.split(/(\n{2,})/);
  const blocks: string[] = [];
  let current = "";
  let openFence = false;
  for (const part of parts) {
    if (/^\n{2,}$/.test(part)) {
      if (openFence) current += part;
      else if (current) {
        blocks.push(current);
        current = "";
      }
      continue;
    }
    current += part;
    if (((part.match(FENCE_RE) || []).length) % 2 === 1) openFence = !openFence;
  }
  if (current) blocks.push(current);
  return blocks;
}

const Block = memo(function Block({ md }: { md: string }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{md}</ReactMarkdown>;
});

export function StreamMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  /** Trwa stream tej wiadomości — ostatni blok dostaje domykanie znaczników. */
  streaming?: boolean;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <>
      {blocks.map((b, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <Block md={streaming && i === blocks.length - 1 ? closeIncompleteMarkdown(b) : b} />
        </Fragment>
      ))}
    </>
  );
}
