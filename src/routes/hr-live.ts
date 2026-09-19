/**
 * Kadry „na żywo” — strumień SSE (`GET /hr/live`) i JEDNO miejsce publikacji
 * sygnałów o zmianach (middleware `hrLivePublisher`).
 *
 * DLACZEGO MIDDLEWARE, A NIE WYWOŁANIE W KAŻDYM HANDLERZE. Kadry mają ponad
 * trzydzieści tras zapisu w czterech plikach (hr.ts, hr-month.ts, hr-norms.ts
 * i ten). Sygnał dopisany ręcznie w każdej z nich byłby kopią tego samego
 * wywołania — a pominięcie go w jednej nie daje żadnego błędu, tylko cichy
 * brak odświeżenia u kogoś innego, czyli dokładnie tę usterkę, dla której cały
 * mechanizm powstał. Middleware stoi NAD całym routerem Kadr i publikuje po
 * każdej udanej mutacji, także w trasach dopisanych w przyszłości.
 *
 * PO ODPOWIEDZI, WIĘC PO COMMICIE. Publikacja dzieje się po `await next()`,
 * czyli gdy handler zdążył już zamknąć transakcję i złożyć odpowiedź —
 * odbiorca sygnału nie ma jak przeczytać bazy sprzed zapisu.
 *
 * TYLKO UDANE ZAPISY. 4xx/5xx niczego nie zmieniły (a 423 „miesiąc zamknięty”
 * albo „listę edytuje ktoś inny” tym bardziej), więc nie ma czego rozsyłać.
 */
import { Hono, type Context, type Next } from "hono";
import { getUser } from "../middleware/auth.js";
import { clientIdOf } from "../lib/calendar-live.js";
import { streamChangeFeed } from "../lib/sse-stream.js";
import {
  hrLiveSkipsPath,
  hrScopeFromPath,
  publishHrChange,
  subscribeHrChanges,
  type HrChange,
} from "../lib/hr-live.js";

const app = new Hono();

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Rok/miesiąc z ciała żądania albo z query — `null`, gdy się nie da. */
function periodOfRequest(
  body: unknown,
  c: Context,
): { year: number | null; month: number | null } {
  const pick = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isInteger(n) ? n : null;
  };
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    year: pick(rec.year) ?? pick(c.req.query("year")),
    month: pick(rec.month) ?? pick(c.req.query("month")),
  };
}

export async function hrLivePublisher(c: Context, next: Next): Promise<void> {
  await next();
  if (READ_METHODS.has(c.req.method.toUpperCase())) return;
  const status = c.res.status;
  if (status < 200 || status >= 300) return;
  const path = c.req.path;
  if (hrLiveSkipsPath(path)) return;

  // Ciało jest już sparsowane przez handler i siedzi w cache'u żądania
  // (`c.req.bodyCache`), więc to odczyt z pamięci, a nie drugie czytanie
  // strumienia. Gdy handler ciała nie czytał (DELETE) — po prostu go nie ma
  // i okres zostaje pusty: front przeładuje wtedy miesiąc, który ma otwarty.
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    /* brak ciała albo nie-JSON — okres wyjdzie z query albo zostanie pusty */
  }
  const { year, month } = periodOfRequest(body, c);
  let actorUserId: number | null = null;
  try {
    actorUserId = getUser(c)?.id ?? null;
  } catch {
    /* zapis spoza sesji (skrypt) — sygnał i tak ma sens, tylko bez autora */
  }
  publishHrChange({
    scope: hrScopeFromPath(path),
    year,
    month,
    actorUserId,
    actorClientId: clientIdOf(c),
  });
}

/**
 * Strumień zdarzeń dla JEDNEJ otwartej karty.
 *
 * EventSource nie wysyła własnych nagłówków, więc autoryzacja idzie wyłącznie
 * z cookie sesji (`requireAuth` + `tabPermissionGuard` na `/hr/*` już
 * rozstrzygnęły, że słuchający ma prawo oglądać Kadry). Identyfikator karty
 * przychodzi więc w query (`?client=`), nie w nagłówku — tak samo jak w panelu
 * technika.
 *
 * WŁASNE ZAPISY POMIJA SERWER: karta, która sama coś zapisała, odświeżyła się
 * po odpowiedzi API. Pomijamy TYLKO ją — drugie okno i telefon tej samej osoby
 * sygnał dostają (po użytkowniku filtrować nie wolno).
 *
 * Sama pętla (ramka `ready`, kolejka, heartbeat co 25 s, sprzątanie
 * subskrypcji) siedzi w `src/lib/sse-stream.ts` — dzieli ją z kalendarzem.
 */
app.get("/live", (c) => {
  const client = (c.req.query("client") || "").trim().slice(0, 64);
  return streamChangeFeed<HrChange>(c, {
    event: "hr",
    ready: { ts: Date.now() },
    idOf: (change) => String(change.ts),
    subscribe: (emit) =>
      subscribeHrChanges((change) => {
        if (client && change.actorClientId === client) return;
        emit(change);
      }),
  });
});

export default app;
