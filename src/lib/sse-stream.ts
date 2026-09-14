/**
 * Wspólna pętla strumienia SSE dla „na żywo” — kalendarz CRM i panel technika.
 *
 * PO CO OSOBNY PLIK. Obie trasy (`GET /calendar/live`, `GET /technik/live`)
 * potrzebują dokładnie tego samego: pierwszej ramki `ready` z `retry`, kolejki
 * sygnałów z brokera (src/lib/calendar-live.ts), heartbeatu co 25 s i pewnego
 * odsubskrybowania przy zerwaniu. Różnią się WYŁĄCZNIE filtrem i kształtem
 * ładunku, więc pętla mieszka tu, a trasy dostarczają `subscribe`.
 *
 * KONTRAKT `subscribe`: dostaje funkcję `emit`, którą wolno wołać SYNCHRONICZNIE
 * z wnętrza publikacji (better-sqlite3 jest synchroniczne), i zwraca funkcję
 * odsubskrybowania. Ta MUSI działać — bez niej zamknięte strumienie zostają
 * w Secie brokera na zawsze.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

/** Odstęp „pingów” (komentarz SSE) — trzyma połączenie przy życiu przez proxy. */
export const LIVE_HEARTBEAT_MS = 25_000;
/** Ile przeglądarka ma czekać przed ponownym połączeniem po zerwaniu. */
export const LIVE_RETRY_MS = 5_000;

export interface SseFeed<T> {
  /** Nazwa zdarzenia SSE, po której front zakłada `addEventListener`. */
  event: string;
  /** Ładunek pierwszej ramki (`event: ready`) — front wie, że stoi połączenie. */
  ready: unknown;
  /** Podpięcie do brokera; `emit` wrzuca ładunek do kolejki tego strumienia. */
  subscribe: (emit: (item: T) => void) => () => void;
  /** Id ramki SSE (Last-Event-ID); domyślnie znacznik czasu wysyłki. */
  idOf?: (item: T) => string | undefined;
}

/**
 * Strumień SSE dla JEDNEJ otwartej karty. EventSource nie wysyła własnych
 * nagłówków, więc autoryzacja idzie wyłącznie z cookie sesji (`requireAuth`
 * i bramki modułu są już nad tą trasą).
 */
export function streamChangeFeed<T>(c: Context, feed: SseFeed<T>): Response {
  return streamSSE(c, async (stream) => {
    // UWAGA na kolejność: `streamSSE` ustawia WŁASNE nagłówki (m.in. Cache-Control:
    // no-cache) TUŻ przed wywołaniem tego callbacku, a odpowiedź składa dopiero po
    // powrocie z jego synchronicznej części. Nagłówki dopisane wyżej (przed
    // `streamSSE`) zostałyby więc nadpisane — muszą lecieć TUTAJ i PRZED pierwszym
    // `await`.
    //  - no-transform: żaden pośrednik nie ma prawa przepakować/skompresować strumienia,
    //  - X-Accel-Buffering: wyłącza buforowanie w nginx (Dokploy stawia go przed aplikacją).
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    const queue: T[] = [];
    let closed = false;
    /** Budzik pętli — ustawiany na czas czekania, kasowany po obudzeniu. */
    let wake: (() => void) | null = null;
    const bump = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const unsubscribe = feed.subscribe((item) => {
      queue.push(item);
      bump();
    });
    const close = () => {
      closed = true;
      bump();
    };
    stream.onAbort(close);
    // Node server sygnalizuje zerwanie także przez AbortSignal żądania.
    c.req.raw.signal?.addEventListener("abort", close, { once: true });

    try {
      // Pierwsza ramka od razu — przeglądarka uznaje połączenie za otwarte,
      // a `retry` ustawia odstęp automatycznego wznawiania po zerwaniu.
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify(feed.ready),
        retry: LIVE_RETRY_MS,
      });
      while (!closed && !stream.aborted && !stream.closed) {
        const batch = queue.splice(0, queue.length);
        if (batch.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve();
            }, LIVE_HEARTBEAT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          // Obudzeni bez pracy (timeout albo zamknięcie) → heartbeat; komentarz SSE
          // jest ignorowany przez EventSource, ale przepycha bufory pośredników.
          if (!closed && queue.length === 0) await stream.write(": ping\n\n");
          continue;
        }
        for (const item of batch) {
          await stream.writeSSE({
            event: feed.event,
            data: JSON.stringify(item),
            id: feed.idOf ? feed.idOf(item) : String(Date.now()),
          });
        }
      }
    } finally {
      unsubscribe();
      c.req.raw.signal?.removeEventListener("abort", close);
    }
  });
}
