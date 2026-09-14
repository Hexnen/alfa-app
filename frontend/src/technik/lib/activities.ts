/**
 * Słownik czynności w polu „Wykonane czynności” — operacje na TEKŚCIE, nie na
 * stanie Reacta, żeby dało się je przetestować bez renderowania protokołu.
 *
 * Jedna czynność = jedna LINIA. Chip jest przełącznikiem: tap dopisuje linię,
 * ponowny tap tę samą linię usuwa. Porównujemy po przyciętej treści linii, więc
 * czynność dopisana ręcznie (albo wpisana z małej litery — nie, wielkość liter
 * ma znaczenie: to treść dokumentu) też liczy się jako „już jest”.
 */

/** Czy tekst zawiera już linię dokładnie z tą czynnością? */
export function hasActivityLine(text: string, activity: string): boolean {
  const needle = activity.trim();
  if (!needle) return false;
  return text.split("\n").some((line) => line.trim() === needle);
}

/**
 * Dopisuje czynność jako nową linię albo — gdy już jest — usuwa tę linię.
 * Puste linie po usunięciu znikają, żeby protokół nie zbierał dziur po chipach.
 */
export function toggleActivityLine(text: string, activity: string): string {
  const needle = activity.trim();
  if (!needle) return text;
  if (hasActivityLine(text, needle)) {
    const kept = text.split("\n").filter((line) => line.trim() !== needle);
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  const base = text.replace(/\s+$/, "");
  return base ? `${base}\n${needle}` : needle;
}
