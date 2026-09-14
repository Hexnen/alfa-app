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

/**
 * Pozycja słownika, z której WYROSŁA ta linia — dokładne trafienie albo linia
 * DOPISANA ręcznie do pozycji ze słownika („Wymiana kamery - kanał 3”).
 *
 * Bez dopasowania po prefiksie chip przy takiej linii stał niewybrany, a jego
 * stuknięcie dokładało DRUGĄ, identyczną czynność do protokołu. Dopisek musi
 * zaczynać się od znaku, który nie jest literą ani cyfrą (spacja, myślnik,
 * dwukropek), żeby „Wymiana kamery” nie połknęło „Wymiana kamerynowej”.
 * Przy kilku pasujących pozycjach wygrywa NAJDŁUŻSZA — jest najbardziej
 * szczegółowa.
 */
export function matchedActivity(line: string, dictionary: string[]): string | null {
  const t = line.trim();
  if (!t) return null;
  let best: string | null = null;
  for (const raw of dictionary) {
    const d = raw.trim();
    if (!d || !t.startsWith(d)) continue;
    const rest = t.slice(d.length);
    if (rest && /^[\p{L}\p{N}]/u.test(rest)) continue;
    if (!best || d.length > best.length) best = d;
  }
  return best;
}

/** Czy wśród wybranych linii stoi już ta pozycja słownika (także z dopiskiem)? */
export function isActivityPicked(
  picked: string[],
  dictionary: string[],
  activity: string,
): boolean {
  const needle = activity.trim();
  return !!needle && picked.some((line) => matchedActivity(line, dictionary) === needle);
}

/**
 * Rozbicie pola na czynności ze słownika (w kolejności z tekstu) i resztę.
 *
 * `notes` wraca DOKŁADNIE tak, jak stoi w tekście — bez `trim()` i bez
 * sklejania pustych linii. Inaczej pole „Uwagi / inne czynności” jest
 * kontrolowane przez funkcję, która zjada świeżo wpisany Enter i spację:
 * technik naciskał Enter, a `value` wracało bez nowej linii. Normalizacja
 * należy do drogi NA SERWER (`normalizeActivities` w `toPayload`), nie do
 * drogi do stanu Reacta.
 */
export function splitActivities(
  text: string,
  dictionary: string[],
): { picked: string[]; notes: string } {
  const picked: string[] = [];
  const notes: string[] = [];
  for (const line of text.split("\n")) {
    if (matchedActivity(line, dictionary)) picked.push(line.trim());
    else notes.push(line);
  }
  return { picked, notes: notes.join("\n") };
}

/**
 * Sklejenie z powrotem: najpierw czynności ze słownika (w kolejności wybierania),
 * potem uwagi. Kolejność jest stała i przewidywalna — protokół czytany w biurze
 * wygląda tak samo niezależnie od tego, kiedy technik dopisał zdanie od siebie.
 *
 * Uwag NIE przycinamy (patrz `splitActivities`) — „  wcięcie”, spacja w trakcie
 * pisania i świeży Enter na końcu mają przeżyć drogę przez stan.
 */
export function composeActivities(picked: string[], notes: string): string {
  return [...picked, notes].filter(Boolean).join("\n");
}

/**
 * Porządki PRZED wysłaniem na serwer: bez spacji na końcach linii, bez trzech
 * pustych linii z rzędu, bez pustych brzegów. Wcięcie na POCZĄTKU linii zostaje
 * — technik składa nim listy.
 */
export function normalizeActivities(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Chip: tap dopisuje czynność na koniec listy, ponowny tap ją usuwa — także
 * wtedy, gdy linia została ręcznie rozwinięta o dopisek.
 */
export function toggleActivity(text: string, dictionary: string[], activity: string): string {
  const needle = activity.trim();
  if (!needle) return text;
  const { picked, notes } = splitActivities(text, dictionary);
  const next = isActivityPicked(picked, dictionary, needle)
    ? picked.filter((line) => matchedActivity(line, dictionary) !== needle)
    : [...picked, needle];
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
