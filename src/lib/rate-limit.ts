/**
 * Prosty limiter zapytań w oknie stałym — do trzymania w ryzach tras, które
 * wychodzą do zewnętrznych API (wykaz VAT MF, Nominatim, Google Maps).
 *
 * Stan trzymamy w pamięci procesu: aplikacja chodzi jako jeden serwis (Dokploy),
 * a limit ma chronić zewnętrzne API przed lawiną, nie być zabezpieczeniem
 * kryptograficznym. Restart procesu kasuje liczniki — i tak ma być.
 */
import type { Context } from "hono";

export interface RateLimiterOptions {
  /** Ile zapytań mieści się w oknie. */
  limit: number;
  /** Długość okna w milisekundach. */
  windowMs: number;
  /**
   * Po ilu kluczach robimy porządki. Chroni przed puchnięciem mapy przy
   * publicznych trasach, gdzie kluczem jest adres IP.
   */
  maxKeys?: number;
}

export interface RateLimiter {
  /** true = zapytanie mieści się w limicie (i zostało policzone). */
  check(key: string): boolean;
  /** Ile zapytań zostało w bieżącym oknie dla klucza. */
  remaining(key: string): number;
  /** Kasuje liczniki (testy). */
  reset(): void;
}

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 5000,
}: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, { count: number; windowStart: number }>();

  /** Usuwa wpisy z zamkniętych już okien. */
  const sweep = (now: number) => {
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs) hits.delete(key);
    }
  };

  return {
    check(key: string): boolean {
      const now = Date.now();
      if (hits.size >= maxKeys) sweep(now);

      const entry = hits.get(key);
      if (!entry || now - entry.windowStart > windowMs) {
        hits.set(key, { count: 1, windowStart: now });
        return true;
      }
      entry.count += 1;
      return entry.count <= limit;
    },

    remaining(key: string): number {
      const entry = hits.get(key);
      if (!entry || Date.now() - entry.windowStart > windowMs) return limit;
      return Math.max(0, limit - entry.count);
    },

    reset(): void {
      hits.clear();
    },
  };
}

/**
 * Adres IP klienta. Aplikacja stoi za proxy (Dokploy/Traefik), więc bierzemy
 * pierwszy wpis z `X-Forwarded-For`; bez proxy zostaje adres z gniazda.
 *
 * UWAGA: nagłówki da się podrobić, więc limit per IP sam z siebie nie zatrzyma
 * uporu — publiczne trasy dokładają do tego limit globalny.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;

  // Fallback: adres gniazda (bez proxy albo przy testach przez app.request()).
  const conn = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return conn || "unknown";
}
