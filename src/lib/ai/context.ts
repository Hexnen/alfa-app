/**
 * Budżet kontekstu asystenta — estymacja tokenów i przycinanie historii.
 * Kopia roleplay/src/lib/roleplay/context.ts (bez granicy kroniki).
 */
import type { ModelMessage } from "ai";

/**
 * Zgrubna estymacja tokenów: ~2,5 znaku na token. Polski tokenizuje się gorzej niż angielski
 * (ogonki, fleksyjne końcówki, JSON narzędzi z polskimi nazwami) — 3,5 zaniżało o ~30 %.
 * Zawyża — celowo (lepiej przyciąć historię za wcześnie niż przekroczyć okno).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/** Estymacja tokenów jednej wiadomości modelu (+stały narzut roli/formatu). */
export function messageTokens(m: ModelMessage): number {
  const c: unknown = m.content;
  const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
  return estimateTokens(text) + 4;
}

/**
 * Przycina historię OD POCZĄTKU pełnymi chunkami (chunk = jedna wiadomość UI,
 * może obejmować asystenta + wyniki narzędzi — wypadają tylko razem), aż
 * fixed + historia zmieszczą się w limicie. Zawsze zostają ≥2 ostatnie chunki.
 */
export function trimHistoryToBudget(params: {
  history: ModelMessage[][];
  fixedTokens: number;
  limit: number;
}): { history: ModelMessage[]; dropped: number; totalTokens: number } {
  const { history, fixedTokens, limit } = params;
  const per = history.map((chunk) => chunk.reduce((a, m) => a + messageTokens(m), 0));
  let total = fixedTokens + per.reduce((a, b) => a + b, 0);
  let start = 0;
  while (total > limit && start < history.length - 2) {
    total -= per[start];
    start++;
  }
  return { history: history.slice(start).flat(), dropped: start, totalTokens: total };
}
