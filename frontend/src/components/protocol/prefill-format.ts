/**
 * Formatowanie sugestii uzupełniania protokołu — osobny plik, żeby komponent
 * eksportował same komponenty (react-refresh), tak jak realization/autofill-format.ts.
 */
/** Kolory pigułki źródła — te same tony, co w automacie realizacji. */
export function prefillSourceTone(source: string): string {
  switch (source) {
    case "kalendarz":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
    case "obiekt":
      return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
    case "kontrahent":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "cennik":
      return "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/** „z kalendarza", „z obiektu", „z kontrahenta"… — dopełniacz do krótkiej adnotacji. */
export function prefillSourceGenitive(source: string): string {
  switch (source) {
    case "kalendarz":
      return "kalendarza";
    case "obiekt":
      return "obiektu";
    case "kontrahent":
      return "kontrahenta";
    case "cennik":
      return "cennika";
    case "realizacja":
      return "realizacji";
    default:
      return source;
  }
}

const WORK_TYPE_LABEL: Record<string, string> = {
  serwis: "Serwis",
  montaz: "Montaż",
  wizja: "Wizja",
  inne: "Inne",
};

export function fmtPrefillValue(field: string, value: string | number | null): string {
  if (value === null || value === "" || value === undefined) return "—";
  if (field === "workType") return WORK_TYPE_LABEL[String(value)] ?? String(value);
  if (field === "workDate" && typeof value === "string") {
    return new Date(value).toLocaleDateString("pl-PL");
  }
  if (typeof value === "number") {
    return field === "actualHours" ? `${value} godz.` : field === "actualKm" ? `${value} km` : String(value);
  }
  return String(value);
}
