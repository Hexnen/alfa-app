/**
 * Ustawienia panelu technika (tabela app_settings, klucze `technik.*`).
 *
 * Dziś jedno pole: SŁOWNIK CZYNNOŚCI podpowiadanych technikowi w protokole
 * (chipy nad polem „Wykonane czynności”). Precedencja: DB → wartość domyślna
 * (bez env, jak w src/lib/calendar-config.ts), a wartość czytamy przy KAŻDYM
 * żądaniu — zmiana w panelu admina działa bez restartu backendu.
 *
 * Panel admina: /admin/technik (src/routes/admin-technik.ts).
 * Odczyt dla techników: GET /api/technik/activities — rola `technik` nie ma
 * wstępu do /api/admin/*, więc musi mieć własną, wąską trasę.
 */
import { getSetting } from "./settings.js";

/** Klucz w app_settings. */
export const TECHNIK_ACTIVITIES_KEY = "technik.activities";
/** Limity: chip ma się zmieścić na tablecie, a lista — w głowie technika. */
export const TECHNIK_ACTIVITY_MAX_LEN = 120;
export const TECHNIK_ACTIVITIES_MAX = 60;

/**
 * Domyślny słownik — typowe czynności serwisu i montażu SSWiN / CCTV /
 * kontroli dostępu. Ma być gotowy do użycia „z pudełka”: bez tej listy rząd
 * chipów w protokole w ogóle się nie renderuje.
 */
export const DEFAULT_TECHNIK_ACTIVITIES: string[] = [
  "Przegląd okresowy systemu",
  "Diagnostyka zgłoszonej usterki",
  "Wymiana akumulatora centrali",
  "Wymiana uszkodzonej czujki",
  "Czyszczenie i regulacja kamer",
  "Test torów alarmowych",
  "Test łączności z centrum monitorowania",
  "Sprawdzenie zasilania awaryjnego",
  "Aktualizacja firmware rejestratora",
  "Konfiguracja aplikacji mobilnej",
  "Konfiguracja zdalnego podglądu",
  "Programowanie kart i pilotów",
  "Ustawienie stref i kodów użytkowników",
  "Szkolenie użytkownika z obsługi",
  "Uruchomienie systemu po montażu",
];

/**
 * Porządkowanie listy: przycięcie, wyrzucenie pustych i duplikatów
 * (bez zmiany kolejności — admin ustawia ją strzałkami), twardy limit.
 */
export function normalizeTechnikActivities(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = String(raw).trim().replace(/\s+/g, " ");
    if (!v) continue;
    const key = v.toLocaleLowerCase("pl");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= TECHNIK_ACTIVITIES_MAX) break;
  }
  return out;
}

/** Walidacja wartości z API; zwraca komunikat błędu albo null. */
export function validateTechnikActivities(v: unknown): string | null {
  if (!Array.isArray(v)) return "Czynności: oczekiwano tablicy tekstów";
  if (v.length > TECHNIK_ACTIVITIES_MAX) return `Czynności: maks. ${TECHNIK_ACTIVITIES_MAX} pozycji`;
  for (const it of v) {
    if (typeof it !== "string") return "Czynności: elementy muszą być tekstem";
    const t = it.trim();
    if (!t) return "Czynności: pusta pozycja na liście";
    if (t.length > TECHNIK_ACTIVITY_MAX_LEN) {
      return `Czynności: pozycja „${t.slice(0, 30)}…” jest dłuższa niż ${TECHNIK_ACTIVITY_MAX_LEN} znaków`;
    }
  }
  return null;
}

/** Tekst z DB → lista; undefined = uszkodzony wpis (lecimy dalej w precedencji). */
export function parseTechnikActivities(raw: string): string[] | undefined {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (validateTechnikActivities(arr) !== null) return undefined;
    return normalizeTechnikActivities(arr as string[]);
  } catch {
    return undefined;
  }
}

export function serializeTechnikActivities(list: readonly string[]): string {
  return JSON.stringify(normalizeTechnikActivities(list));
}

export type TechnikSettingSource = "db" | "default";

/**
 * Efektywny słownik czynności + źródło. PUSTA lista zapisana w bazie jest
 * świadomą decyzją admina („nie podpowiadaj nic”), a nie brakiem wpisu —
 * dlatego nie wracamy wtedy do wartości domyślnych.
 */
export function resolveTechnikActivities(): { value: string[]; source: TechnikSettingSource } {
  const raw = getSetting(TECHNIK_ACTIVITIES_KEY);
  if (raw !== null) {
    const parsed = parseTechnikActivities(raw);
    if (parsed !== undefined) return { value: parsed, source: "db" };
  }
  return { value: [...DEFAULT_TECHNIK_ACTIVITIES], source: "default" };
}

/** Czynności podpowiadane technikowi w protokole. */
export function getTechnikActivities(): string[] {
  return resolveTechnikActivities().value;
}

/** Formatowanie do summary w activity_log (krótko — lista bywa długa). */
export function formatTechnikActivities(list: readonly string[]): string {
  if (!list.length) return "(pusta lista)";
  const head = list.slice(0, 3).join(", ");
  return list.length > 3 ? `${list.length} pozycji (${head}…)` : head;
}
