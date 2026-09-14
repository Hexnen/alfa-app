import type {
  ProtocolInput,
  ProtocolItem,
  ProtocolWorkType,
  TechnikProtocol,
} from "@/lib/api";
import { activityLines, normalizeActivities } from "./activities";
import { dayOf, todayIso } from "./dates";

/**
 * Model formularza protokołu i cała arytmetyka wokół niego — poza komponentami,
 * żeby dało się to czytać (i kiedyś przetestować) bez renderowania czterech
 * kroków.
 */

/** Kolejność kroków = kolejność pracy u klienta, nie kolejność pól w bazie. */
export const STEP_KEYS = ["dane", "czynnosci", "urzadzenia", "odbior"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_LABELS: Record<StepKey, string> = {
  dane: "Dane",
  czynnosci: "Czynności",
  urzadzenia: "Urządzenia",
  odbior: "Odbiór",
};

export const WORK_TYPES: ProtocolWorkType[] = ["serwis", "montaz", "wizja", "inne"];

/**
 * Jednostki pozycji protokołu. Wpisywane z palca bywały przypadkowe („sz”,
 * „SZT”, puste), a na papierze mają wyglądać jednakowo — stąd zamknięta lista
 * i natywny `<select>` (na tablecie otwiera systemowy picker; Select Radixa
 * zostaje dla desktopu, zgodnie z zasadami panelu).
 *
 * „mb” jest w liście, bo tak zapisane jednostki naprawdę siedzą w bazie
 * (protokoły: „MB”, cennik: „MB”, „RBH”, „KM”). Wartość spoza listy nigdy nie
 * znika — `unitOptions` dokleja ją jako dodatkową pozycję.
 */
export const UNITS = ["szt.", "kpl.", "m", "mb", "m²", "godz.", "rbh", "usł."] as const;
export const DEFAULT_UNIT = "szt.";

/** Lista opcji dla jednej pozycji — z wartością z bazy, nawet jeśli jest nietypowa. */
export function unitOptions(current: string): string[] {
  const v = current.trim();
  return !v || UNITS.includes(v as (typeof UNITS)[number]) ? [...UNITS] : [v, ...UNITS];
}

export const EMPTY_ITEM: ProtocolItem = { name: "", serial: "", unit: DEFAULT_UNIT, qty: "1" };

/** „23.4” → „23,4” — na protokole i w podpowiedziach liczby są po polsku. */
export function pl(n: number): string {
  return String(Math.round(n * 100) / 100).replace(".", ",");
}

/** „2,5” / „2.5” / „” → liczba (puste i śmieci dają 0, nigdy NaN). */
export function num(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Kontakt z prefillu bywa sklejką: „Jan Nowak (kierownik), +48 600…, jan@x.pl”.
 * W polu „Osoba odbierająca” — i pod podpisem klienta — ma stać samo nazwisko,
 * bo to ono trafia na dokument jako `signerName`. Całą sklejkę pokazujemy pod
 * polem jako podpowiedź; prefillu po stronie backendu NIE ruszamy, bo dzieli go
 * z nami moduł biurowy.
 */
export function shortContactName(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  // Nawiasy, maile i telefony lecą NIEZALEŻNIE OD POZYCJI. Wcześniej liczyło
  // się tylko to, co stoi przed pierwszym „(” albo przecinkiem, więc kontakt
  // zapisany jako „(recepcja) Anna Nowak” wracał w całości — razem z rolą,
  // numerem i mailem — i tyle lądowało pod podpisem klienta.
  const cleaned = trimmed
    .replace(/\([^)]*\)/g, " ")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, " ")
    .replace(/\+?\d[\d\s-]{6,}\d/g, " ")
    .split(",")[0]
    .replace(/\s+/g, " ")
    // Kropki na końcu NIE ucinamy — „Firma Sp. z o.o.” ma prawo tak wyglądać.
    .replace(/^[\s,;:.\-–—]+/, "")
    .replace(/[\s,;:\-–—]+$/, "")
    .trim();
  // Nic nie zostało (sam telefon, samo „(brak)”) — lepiej pokazać całość niż
  // puste pole; 60 znaków to tyle, ile mieści się w linijce pod podpisem.
  return cleaned || trimmed.slice(0, 60).trim();
}

/** Edytowalny stan formularza — reszta protokołu jest tylko do odczytu. */
export interface FormState {
  workDate: string;
  workType: ProtocolWorkType;
  actualHours: number;
  actualKm: number;
  activities: string;
  /**
   * Kontakt Z PROTOKOŁU, w całości: „Jan Nowak (kierownik), +48 600…, jan@x.pl”.
   * Nie pokazujemy go w polu i nie ruszamy przy zapisie — dopóki technik sam
   * nie poprawi „Osoby odbierającej”, wraca na serwer bajt w bajt taki, jaki
   * przyszedł.
   */
  contact: string;
  /** Co stoi w polu „Osoba odbierająca” — samo nazwisko, to ono idzie pod podpis. */
  signerName: string;
  /** Czy technik ruszył pole „Osoba odbierająca” (dopiero wtedy nadpisujemy `contact`). */
  contactEdited: boolean;
  items: ProtocolItem[];
}

export function toForm(p: TechnikProtocol): FormState {
  const contact = p.contact ?? "";
  return {
    workDate: dayOf(p.workDate || todayIso()),
    workType: p.workType,
    actualHours: num(p.actualHours),
    actualKm: num(p.actualKm),
    activities: p.activities ?? "",
    contact,
    signerName: shortContactName(contact),
    contactEdited: false,
    items: p.items?.length ? p.items.map((i) => ({ ...i })) : [],
  };
}

/**
 * Ciało PUT-a. Dane klienta idą nietknięte z protokołu — technik ich u klienta
 * nie poprawia, a backend i tak sprawdza tylko to, co przysłaliśmy.
 */
export function toPayload(protocol: TechnikProtocol, form: FormState): ProtocolInput {
  return {
    workDate: form.workDate,
    workType: form.workType,
    actualHours: form.actualHours,
    actualKm: form.actualKm,
    contractor: protocol.contractor ?? "",
    salesperson: protocol.salesperson ?? "",
    clientName: protocol.clientName ?? "",
    clientNip: protocol.clientNip ?? "",
    clientCity: protocol.clientCity ?? "",
    installationAddress: protocol.installationAddress ?? "",
    // Kontakt wraca NIETKNIĘTY, dopóki technik sam nie poprawi pola. Wcześniej
    // formularz pokazywał w polu samo nazwisko wycięte ze sklejki i to samo
    // nazwisko odsyłał — pierwszy autozapis kasował z protokołu telefon i mail
    // osoby odbierającej, a biuro nie miało już do kogo zadzwonić.
    contact: form.contactEdited ? form.signerName : (protocol.contact ?? ""),
    // Uwagi jadą na serwer wyprostowane (bez spacji na końcach linii i bez
    // pustych brzegów) — w stanie formularza zostają dokładnie takie, jakie
    // technik wpisał, żeby Enter i spacja nie znikały spod palca.
    activities: normalizeActivities(form.activities),
    // Puste wiersze (technik dodał i nie wypełnił) nie mają lądować na papierze.
    items: cleanItems(form.items),
    status: protocol.status,
  };
}

/** Pozycje warte zapisania — bez wierszy, w których nie ma ani nazwy, ani numeru. */
export function cleanItems(items: ProtocolItem[]): ProtocolItem[] {
  return items.filter((i) => i.name.trim() || i.serial.trim());
}

/* ------------------------------------------------------------------ *
 * Braki — informacja, nigdy blokada
 * ------------------------------------------------------------------ */

export interface ProtocolGap {
  step: StepKey;
  label: string;
}

/**
 * Czego brakuje w protokole. Lista jest INFORMACYJNA: podpis klienta nie jest
 * od niej zależny, bo u klienta bywa, że nie ma czego wpisać (wizja bez
 * urządzeń, serwis na gwarancji bez kilometrów), a zablokowany podpis
 * oznaczałby powrót na obiekt.
 */
export function gapsOf(form: FormState): ProtocolGap[] {
  const gaps: ProtocolGap[] = [];
  if (!form.workDate) gaps.push({ step: "dane", label: "Brak daty wykonania" });
  if (form.actualHours <= 0) gaps.push({ step: "dane", label: "Brak godzin" });
  if (activityLines(form.activities).length === 0)
    gaps.push({ step: "czynnosci", label: "Brak czynności" });
  if (!form.signerName.trim()) gaps.push({ step: "odbior", label: "Brak osoby odbierającej" });
  return gaps;
}

/**
 * Znacznik przy kroku na pasku: `warn` = w tym kroku czegoś brakuje, `ok` =
 * jest komplet i coś w nim faktycznie wpisano. Krok bez własnych braków
 * i bez treści (urządzenia w serwisie) nie dostaje nic — pusty nie znaczy zły.
 */
export function stepMarks(form: FormState): Partial<Record<StepKey, "ok" | "warn">> {
  const gaps = gapsOf(form);
  const marks: Partial<Record<StepKey, "ok" | "warn">> = {};
  for (const key of STEP_KEYS) {
    if (gaps.some((g) => g.step === key)) {
      marks[key] = "warn";
      continue;
    }
    const filled =
      key === "dane"
        ? !!form.workDate && form.actualHours > 0
        : key === "czynnosci"
          ? activityLines(form.activities).length > 0
          : key === "urzadzenia"
            ? cleanItems(form.items).length > 0
            : !!form.signerName.trim();
    if (filled) marks[key] = "ok";
  }
  return marks;
}

/* ------------------------------------------------------------------ *
 * Godziny ze znaczników zlecenia
 * ------------------------------------------------------------------ */

/** Liczba godzin między dwoma znacznikami, zaokrąglona do pół godziny. */
export function hoursBetween(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  const h = (to.getTime() - from.getTime()) / 3_600_000;
  if (!Number.isFinite(h) || h <= 0) return null;
  return Math.max(0.5, Math.round(h * 2) / 2);
}

/** Liczebnik: „1 czynność” / „3 czynności” / „7 czynności”. */
export function countLabel(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `${n} ${one}`;
  const last = n % 10;
  const teen = n % 100 >= 12 && n % 100 <= 14;
  return `${n} ${!teen && last >= 2 && last <= 4 ? few : many}`;
}
