/**
 * Klasyfikacja błędów generacji (provider LLM) — wspólna dla tury asystenta
 * (src/routes/assistant.ts) i testu połączenia z panelu admina (src/routes/admin-assistant.ts).
 * Kopia z roleplay/src/routes/roleplay/turn.ts.
 */

/** Zwięzły opis błędu generacji (message + status HTTP + skrót body odpowiedzi API). */
export function describeError(e: unknown): string {
  const err = e as { message?: string; statusCode?: number; responseBody?: unknown };
  const parts = [String(err?.message || e || "nieznany błąd")];
  if (err?.statusCode) parts.push(`HTTP ${err.statusCode}`);
  const body = typeof err?.responseBody === "string" ? err.responseBody.trim() : "";
  if (body && !parts[0].includes(body)) parts.push(body.slice(0, 300));
  return parts.join(" · ").slice(0, 500);
}

/** Kody: no_key | insufficient | rate_limit | timeout | server | unknown (front mapuje na komunikat PL). */
export type TurnErrorInfo = { code: string; message: string };

export function classifyError(e: unknown): TurnErrorInfo {
  const err = e as { message?: string; statusCode?: number; responseBody?: unknown };
  const message = describeError(e);
  const status = err?.statusCode;
  const blob = `${err?.message ?? ""} ${typeof err?.responseBody === "string" ? err.responseBody : ""}`.toLowerCase();
  if (status === 401 || status === 403 || /\bapi[ _-]?key\b|unauthor|invalid.*key|missing.*key|no auth/.test(blob))
    return { code: "no_key", message: `Klucz OpenRouter odrzucony: ${message}` };
  if (status === 402 || /insufficient|not enough|\bbalance\b|\bcredit|payment required/.test(blob))
    return { code: "insufficient", message: `Brak środków na koncie OpenRouter: ${message}` };
  if (status === 429 || /rate[ _-]?limit|too many request|quota exceeded/.test(blob))
    return { code: "rate_limit", message: `Limit zapytań providera — spróbuj za chwilę: ${message}` };
  if (status === 408 || status === 504 || /timeout|timed out|etimedout|econnreset|socket hang up/.test(blob))
    return { code: "timeout", message: `Przekroczono czas odpowiedzi modelu: ${message}` };
  if ((typeof status === "number" && status >= 500) || /server error|bad gateway|unavailable|overloaded/.test(blob))
    return { code: "server", message: `Błąd po stronie providera: ${message}` };
  return { code: "unknown", message: `Błąd generacji: ${message}` };
}
