/**
 * „Kiedy technik ostatnio zajrzał” na Dziś i Nadchodzące — per zakładka.
 *
 * Trzymane w localStorage urządzenia, nie na serwerze: to cecha TEJ karty na
 * TYM tablecie („czy od ostatniego spojrzenia coś się zmieniło”), a nie stan
 * konta. Backend dostaje znaczniki w `GET /technik/me` i liczy od nich zmiany
 * cudzą ręką — plakietka na tab barze robi się od tego żółta. Brak zapisu
 * (pierwsze uruchomienie, tryb prywatny) = nic nie jest „nowe”.
 */
import type { TechnikSeen } from "@/lib/api";

const KEYS = { seenToday: "technik.seen.dzis", seenUpcoming: "technik.seen.nadchodzace" } as const;

export function readSeen(): TechnikSeen {
  try {
    return {
      seenToday: localStorage.getItem(KEYS.seenToday),
      seenUpcoming: localStorage.getItem(KEYS.seenUpcoming),
    };
  } catch {
    return {};
  }
}

/**
 * Przesunięcie zegara tabletu względem serwera (ms). Znacznik „widziałem”
 * porównuje się z `updated_at` liczonym PRZEZ SERWER — tablet spieszący się
 * o 10 minut gubiłby wszystkie zmiany biura z tych 10 minut. `GET /technik/me`
 * oddaje `now`, z którego liczymy poprawkę przy każdym wczytaniu.
 */
let clockOffsetMs = 0;

export function noteServerNow(iso: string | null | undefined): void {
  if (!iso) return;
  const t = Date.parse(iso);
  if (Number.isFinite(t)) clockOffsetMs = t - Date.now();
}

export function markSeen(tab: keyof typeof KEYS): void {
  try {
    // −1 s: `updated_at` ma ziarnistość sekundową i backend porównuje `>`,
    // więc zmiana z tej samej sekundy, co spojrzenie, nie może przepaść.
    localStorage.setItem(KEYS[tab], new Date(Date.now() + clockOffsetMs - 1000).toISOString());
  } catch {
    /* tryb prywatny — plakietka po prostu nie będzie żółknąć */
  }
}
