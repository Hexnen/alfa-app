/**
 * Słownik linii usługowej analityki — etykiety i dopisek do podpisów liczb.
 *
 * Osobno od `ServiceToggle.tsx`, bo plik z komponentem nie może eksportować nic
 * poza komponentami (fast refresh, reguła react-refresh/only-export-components),
 * a te dwie rzeczy są potrzebne wszędzie tam, gdzie liczba musi powiedzieć,
 * o jakiej części firmy mówi.
 */
import type { AnalyticsService } from "@/lib/api";

/** Etykiety linii — te same słowa, co w podpisach liczb (`serviceTag`). */
export const SERVICE_LABELS: Record<AnalyticsService, string> = {
  zdv: "ZDV",
  ofi: "OFI",
  all: "Oba",
};

/**
 * Dopisek do podpisu liczby: „ (OFI)". Przy „Oba" pusty — dopisywanie „(oba)"
 * do każdego kafelka byłoby szumem w domyślnym widoku.
 */
export function serviceTag(service: AnalyticsService): string {
  return service === "all" ? "" : ` (${SERVICE_LABELS[service]})`;
}
