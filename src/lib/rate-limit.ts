/**
 * Prosty limiter zapytań w oknie stałym — do trzymania w ryzach tras, które
 * wychodzą do zewnętrznych API (wykaz VAT MF, Nominatim, Google Maps).
 *
 * Stan trzymamy w pamięci procesu: aplikacja chodzi jako jeden serwis (Dokploy),
 * a limit ma chronić zewnętrzne API przed lawiną, nie być zabezpieczeniem
 * kryptograficznym. Restart procesu kasuje liczniki — i tak ma być.
 *
 * Limit GLOBALNY (jeden klucz dla całej trasy) ma sens tylko tam, gdzie za
 * trasą stoi cudze API z własnym limitem — u nas wykaz VAT MF w /public.
 * Na trasie, która czyta wyłącznie z własnej bazy, jest odwrotnie: to gotowa
 * dźwignia DoS, bo jedna maszyna wyczerpuje pulę wszystkim naraz.
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
 * Adres IP klienta — klucz limitów per IP na trasach publicznych.
 *
 * MODEL ZAUFANIA. Aplikacja stoi za jednym reverse proxy (Dokploy/Traefik),
 * które DOKŁADA adres nadawcy NA KONIEC `X-Forwarded-For`. Klient może wysłać
 * własny nagłówek z dowolną liczbą zmyślonych członów z przodu, ale tego
 * ostatniego, dopisanego przez proxy, nie ma jak usunąć ani podmienić — więc
 * to on jest adresem, któremu ufamy. Pierwszy człon (dawny wybór) był w pełni
 * pod kontrolą klienta: rotując go co żądanie, jedna maszyna mnożyła klucze
 * limitera bez końca, a sufit globalny, który miał to łatać, sam stawał się
 * dźwignią DoS na wszystkich.
 *
 * Bez proxy (dev, testy przez `app.request()`) nagłówka nie ma i zostaje
 * `X-Real-IP` albo adres z gniazda.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;

  // Fallback: adres gniazda (bez proxy albo przy testach przez app.request()).
  const conn = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return conn || "unknown";
}
