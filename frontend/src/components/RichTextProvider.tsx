/**
 * Provider kontekstu notatek (`@/lib/richtext-context`).
 *
 * Osobny plik, bo eslintowa reguła react-refresh wymaga, żeby moduł eksportował
 * albo same komponenty, albo samą logikę — kontekst i hook zostały w `lib`.
 */
import { useMemo, type ReactNode } from "react";
import { RichTextContext, type RichTextContextValue } from "@/lib/richtext-context";

export function RichTextProvider({
  objectId = null,
  children,
}: RichTextContextValue & { children: ReactNode }) {
  // Stabilna referencja — inaczej każdy render rodzica przerysowywałby wszystkie karty.
  const value = useMemo<RichTextContextValue>(() => ({ objectId: objectId ?? null }), [objectId]);
  return <RichTextContext.Provider value={value}>{children}</RichTextContext.Provider>;
}

export default RichTextProvider;
