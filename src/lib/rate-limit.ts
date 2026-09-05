/**
 * Prosty limiter zapytań w oknie stałym — do trzymania w ryzach tras, które
 * wychodzą do zewnętrznych API (wykaz VAT MF, Nominatim, Google Maps) albo
 * serwują dokumenty publicznie (link do oferty).
 *
 * Stan trzymamy w pamięci procesu: aplikacja chodzi jako jeden serwis (Dokploy),
 * a limit ma chronić zewnętrzne API przed lawiną, nie być zabezpieczeniem
 * kryptograficznym. Restart procesu kasuje liczniki — i tak ma być.
 *
 * Limit GLOBALNY (jeden klucz dla całej trasy) ma sens tylko tam, gdzie za
 * trasą stoi cudze API z własnym limitem — u nas wykaz VAT MF w /public.
 * Na trasie, która czyta wyłącznie z własnej bazy, jest odwrotnie: to gotowa
 * dźwignia DoS, bo jedna maszyna wyczerpuje pulę wszystkim naraz.
 *
 * CO CHRONI `maxKeys`, A CZEGO NIE. Klucz per IP bierze `clientIp()`. Za
 * Traefikiem (produkcja) proxy kasuje XFF od klienta i dopisuje własny, więc
 * klucza nie da się rotować. BEZ proxy — dev, bezpośredni port — klient sam
 * ustawia `X-Forwarded-For`/`X-Real-IP` i każde żądanie może przyjść z nowym
 * kluczem: limiter per IP jest wtedy omijalny i nie ma jak temu zaradzić po
 * stronie aplikacji. `maxKeys` chroni w tej sytuacji PAMIĘĆ (mapa ma twardy
 * sufit i najstarsze wpisy wypadają), a nie dostęp do trasy.
 */
import type { Context } from "hono";

export interface RateLimiterOptions {
  /** Ile zapytań mieści się w oknie. */
  limit: number;
  /** Długość okna w milisekundach. */
  windowMs: number;
  /**
   * Twardy sufit liczby kluczy w mapie. Chroni przed puchnięciem pamięci
   * przy publicznych trasach, gdzie kluczem jest adres IP.
   */
  maxKeys?: number;
  /**
   * Jak często (ms) wolno przeczesać całą mapę w poszukiwaniu zamkniętych
   * okien. Domyślnie co okno — wpisy i tak żyją co najmniej tyle.
   */
  sweepEveryMs?: number;
}

export interface RateLimiter {
  /** true = zapytanie mieści się w limicie (i zostało policzone). */
  check(key: string): boolean;
  /** Ile zapytań zostało w bieżącym oknie dla klucza. */
  remaining(key: string): number;
  /** Ile kluczy trzyma mapa (testy). */
  size(): number;
  /** Kasuje liczniki (testy). */
  reset(): void;
}

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 5000,
  sweepEveryMs = windowMs,
}: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, { count: number; windowStart: number }>();
  let lastSweep = 0;

  /**
   * Usuwa wpisy z zamkniętych już okien. O(n), więc NIE przy każdym żądaniu:
   * poprzednia wersja przeczesywała mapę na każdym `check()` powyżej
   * `maxKeys`, a że świeże klucze nigdy nie wypadały, przy napełnianiu
   * nowymi adresami koszt rósł kwadratowo (0,2 ms/żądanie przy 20k kluczy).
   */
  const sweep = (now: number) => {
    lastSweep = now;
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs) hits.delete(key);
    }
  };

  return {
    check(key: string): boolean {
      const now = Date.now();
      const entry = hits.get(key);
      if (entry && now - entry.windowStart <= windowMs) {
        entry.count += 1;
        return entry.count <= limit;
      }

      // Nowy klucz (albo klucz z zamkniętym oknem — kasujemy go, żeby wrócił
      // na koniec porządku wstawiania jako najświeższy).
      if (entry) hits.delete(key);
      if (hits.size >= maxKeys) {
        if (now - lastSweep >= sweepEveryMs) sweep(now);
        // Sweep mógł nic nie zwolnić (same żywe okna) — wtedy wypada
        // NAJSTARSZY wpis. Map iteruje w porządku wstawiania, więc to O(1)
        // i rozmiar jest twardo ograniczony do `maxKeys`.
        if (hits.size >= maxKeys) {
          const oldest = hits.keys().next();
          if (!oldest.done) hits.delete(oldest.value);
        }
      }
      hits.set(key, { count: 1, windowStart: now });
      return true;
    },

    remaining(key: string): number {
      const entry = hits.get(key);
      if (!entry || Date.now() - entry.windowStart > windowMs) return limit;
      return Math.max(0, limit - entry.count);
    },

    size(): number {
      return hits.size;
    },

    reset(): void {
      hits.clear();
      lastSweep = 0;
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
 * Bez proxy (dev, testy przez `app.request()`) nagłówka nikt nie czyści, więc
 * XFF/`X-Real-IP` od klienta trafia tu wprost — limiter per IP jest wtedy
 * omijalny (patrz nagłówek pliku). Bez obu nagłówków zostaje adres z gniazda.
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
