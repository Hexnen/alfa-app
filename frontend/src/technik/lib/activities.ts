/**
 * Słownik czynności w polu „Wykonane czynności” — operacje na TEKŚCIE, nie na
 * stanie Reacta, żeby dało się je przetestować bez renderowania protokołu.
 *
 * Jedna czynność = jedna LINIA. W bazie zostaje JEDEN tekst (`protocols.
 * activities`), ale technik widzi go rozbity na dwie części: czynności ze
 * słownika (chipy + lista z numeracją) i wszystko inne (pole „Uwagi / inne
 * czynności”). Podział jest czysto widokowy i liczony za każdym razem od nowa,
 * więc gdy słownik jeszcze się nie wczytał, całość ląduje w uwagach i nic nie
 * ginie; po wczytaniu linie ze słownika same wskakują na listę.
 *
 * Porównujemy po PRZYCIĘTEJ treści linii, z wielkością liter — to treść
 * dokumentu, nie identyfikator.
 */

/** Niepuste linie tekstu czynności. */
export function activityLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Czy tekst zawiera już linię dokładnie z tą czynnością? */
export function hasActivityLine(text: string, activity: string): boolean {
  const needle = activity.trim();
  return !!needle && activityLines(text).includes(needle);
}

/** Rozbicie pola na czynności ze słownika (w kolejności z tekstu) i resztę. */
export function splitActivities(
  text: string,
  dictionary: string[],
): { picked: string[]; notes: string } {
  const dict = new Set(dictionary.map((d) => d.trim()).filter(Boolean));
  const picked: string[] = [];
  const notes: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && dict.has(t)) picked.push(t);
    else notes.push(line);
  }
  return { picked, notes: notes.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/**
 * Sklejenie z powrotem: najpierw czynności ze słownika (w kolejności wybierania),
 * potem uwagi. Kolejność jest stała i przewidywalna — protokół czytany w biurze
 * wygląda tak samo niezależnie od tego, kiedy technik dopisał zdanie od siebie.
 */
export function composeActivities(picked: string[], notes: string): string {
  return [...picked, notes.trim()].filter(Boolean).join("\n");
}

/** Chip: tap dopisuje czynność na koniec listy, ponowny tap ją usuwa. */
export function toggleActivity(text: string, dictionary: string[], activity: string): string {
  const needle = activity.trim();
  if (!needle) return text;
  const { picked, notes } = splitActivities(text, dictionary);
  const next = picked.includes(needle) ? picked.filter((p) => p !== needle) : [...picked, needle];
  return composeActivities(next, notes);
}

/** Krzyżyk przy pozycji listy — usunięcie n-tej wybranej czynności. */
export function removeActivityAt(text: string, dictionary: string[], index: number): string {
  const { picked, notes } = splitActivities(text, dictionary);
  return composeActivities(
    picked.filter((_, i) => i !== index),
    notes,
  );
}

/** Podmiana samych uwag, z zachowaniem wybranych czynności. */
export function setActivityNotes(text: string, dictionary: string[], notes: string): string {
  return composeActivities(splitActivities(text, dictionary).picked, notes);
}
