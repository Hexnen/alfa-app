/**
 * OSTATNIO MONTOWANE URZĄDZENIA — prywatna ściągawka tego tabletu.
 *
 * Nazwy sprzętu powtarzają się w kółko („Kamera Hikvision DS-2CD2143G2”,
 * „Zasilacz 12V 5A”), a wystukiwanie ich palcem u klienta jest najdroższą
 * częścią protokołu. Zamiast dokładać słownik po stronie serwera (kolejna
 * tabela, kolejny panel admina, kolejne uprawnienie) pamiętamy osiem ostatnich
 * lokalnie: dane są prywatne dla urządzenia, nic nie synchronizujemy i nic nie
 * przecieka między technikami.
 *
 * `localStorage` bywa niedostępny (tryb prywatny Safari, zablokowane dane
 * witryny), więc KAŻDY dostęp jest w try/catch i pusta lista to poprawny wynik —
 * protokół ma się dać wypełnić bez podpowiedzi.
 */

const KEY = "technik.devices.recent";
const MAX = 8;

export function recentDeviceNames(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

/** Dopisanie nazw z zapisanego protokołu — najnowsze na początku, bez duplikatów. */
export function rememberDeviceNames(names: string[]): string[] {
  const fresh = names.map((n) => n.trim()).filter(Boolean);
  if (fresh.length === 0) return recentDeviceNames();
  const merged: string[] = [];
  for (const n of [...fresh.reverse(), ...recentDeviceNames()]) {
    if (!merged.some((m) => m.toLowerCase() === n.toLowerCase())) merged.push(n);
    if (merged.length >= MAX) break;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Brak miejsca albo zablokowane dane witryny — podpowiedzi to wygoda, nie treść.
  }
  return merged;
}
