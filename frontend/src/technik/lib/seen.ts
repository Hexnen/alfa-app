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

export function markSeen(tab: keyof typeof KEYS): void {
  try {
    localStorage.setItem(KEYS[tab], new Date().toISOString());
  } catch {
    /* tryb prywatny — plakietka po prostu nie będzie żółknąć */
  }
}
