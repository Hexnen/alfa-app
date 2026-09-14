/**
 * WEB PUSH — powiadomienia o zleceniach dla panelu technika.
 *
 * PO CO. Zlecenie dorzucone na dziś po południu docierało do technika dopiero
 * wtedy, gdy sam otworzył panel. Push (VAPID, bez żadnego sklepu z aplikacjami)
 * dowozi je na zainstalowaną PWA: serwer pcha ładunek do push service
 * przeglądarki, service worker panelu (`frontend/public/technik-sw.js`) pokazuje
 * powiadomienie i po tapnięciu otwiera `/technik/zlecenie/<id>`.
 *
 * WYŁĄCZALNE Z DEFINICJI. Bez `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` moduł
 * jest no-opem: `pushConfig()` oddaje `enabled: false`, front chowa przełącznik,
 * a kolejka wysyłki po cichu się opróżnia. Świeżo postawione środowisko (i każdy
 * lokalny `npm run dev`) ma działać bez konfiguracji.
 *
 * NIGDY NIE BLOKUJE I NIGDY NIE RZUCA. Wysyłka idzie `queueTechnicianPush()` —
 * ładunek ląduje w kolejce, a faktyczne strzały lecą dopiero w `setImmediate`,
 * czyli PO zamknięciu synchronicznej transakcji better-sqlite3, z której mutacja
 * go zgłosiła. Gdyby ta transakcja się wycofała, wpis nie ma prawa wyjść w
 * świat — stąd `guard`: predykat sprawdzany przy opróżnianiu kolejki, już na
 * zatwierdzonych danych.
 *
 * SPRZĄTANIE. 404/410 z push service znaczy „ta subskrypcja nie istnieje" →
 * wiersz kasujemy od ręki. Każdy inny błąd (5xx, timeout) bywa chwilowy i tylko
 * podbija `failures`.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { PushSubscriptionRow } from "../db/schema.js";

/** Ładunek widziany przez service workera (`event.data.json()`). */
export interface PushPayload {
  title: string;
  body: string;
  /** Dokąd prowadzi tapnięcie — ścieżka w obrębie panelu, np. `/technik/zlecenie/12`. */
  url: string;
  /**
   * Klucz zwijania. Dwie zmiany terminu tego samego zlecenia mają zostawić
   * JEDNO powiadomienie, a nie dwa — inaczej tablet po weekendzie wygląda jak
   * skrzynka ze spamem.
   */
  tag?: string;
}

/** Co trafia do transportu: subskrypcja w kształcie oczekiwanym przez `web-push`. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Transport = „wyślij ten ładunek pod ten endpoint". Podmieniany w testach
 * (`setPushTransport`), bo prawdziwa wysyłka wymagałaby push service Google/
 * Mozilli i sieci. Rzucony błąd z polem `statusCode` jest interpretowany tak
 * samo jak odpowiedź `web-push`.
 */
export type PushTransport = (target: PushTarget, payload: PushPayload) => Promise<void>;

// ---------------------------------------------------------------------------
// Konfiguracja (env)
// ---------------------------------------------------------------------------

function envKey(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * Adres kontaktowy w nagłówku VAPID — push service ma dokąd napisać, gdy serwer
 * zaczyna się zachowywać nieładnie. Musi być `mailto:` albo `https:`.
 */
function vapidSubject(): string {
  const raw = envKey("VAPID_SUBJECT");
  if (/^(mailto:|https:\/\/)/i.test(raw)) return raw;
  return "mailto:biuro@alfagroup.pl";
}

/** Czy push jest w ogóle skonfigurowany. Bez pary kluczy — cały moduł to no-op. */
export function isPushEnabled(): boolean {
  return envKey("VAPID_PUBLIC_KEY").length > 0 && envKey("VAPID_PRIVATE_KEY").length > 0;
}

/** Co front dostaje z `GET /technik/push/config`. */
export function pushConfig(): { enabled: boolean; publicKey: string | null } {
  const enabled = isPushEnabled();
  return { enabled, publicKey: enabled ? envKey("VAPID_PUBLIC_KEY") : null };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let transport: PushTransport | null = null;

/**
 * Prawdziwy transport — `web-push` ładowany DYNAMICZNIE, przy pierwszej wysyłce.
 * Instalacja bez kluczy VAPID (i każdy skrypt testowy) nie ma powodu wciągać
 * tej biblioteki do pamięci procesu.
 */
async function defaultTransport(target: PushTarget, payload: PushPayload): Promise<void> {
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(vapidSubject(), envKey("VAPID_PUBLIC_KEY"), envKey("VAPID_PRIVATE_KEY"));
  await webpush.sendNotification(
    { endpoint: target.endpoint, keys: target.keys },
    JSON.stringify(payload),
    { TTL: 12 * 60 * 60 }
  );
}

/** Podmienia transport (testy). Zwraca funkcję przywracającą poprzedni. */
export function setPushTransport(fn: PushTransport | null): () => void {
  const previous = transport;
  transport = fn;
  return () => {
    transport = previous;
  };
}

function activeTransport(): PushTransport {
  return transport ?? defaultTransport;
}

// ---------------------------------------------------------------------------
// Subskrypcje
// ---------------------------------------------------------------------------

/** Upsert po `endpoint` — ponowne `subscribe()` na tym samym tablecie to ten sam wiersz. */
export function saveSubscription(input: {
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): PushSubscriptionRow {
  return db
    .insert(schema.pushSubscriptions)
    .values({
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: {
        // Endpoint może zmienić właściciela: jeden tablet, dwie zmiany, dwa
        // konta. Wygrywa ten, kto subskrybuje teraz — inaczej powiadomienia
        // szłyby do osoby, która już dawno się wylogowała.
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        failures: 0,
      },
    })
    .returning()
    .get();
}

/**
 * Wypisanie. Kasuje WYŁĄCZNIE własną subskrypcję — cudzy endpoint (nawet
 * poprawnie zgadnięty) nie jest niczyim kluczem do wyciszenia kolegi.
 */
export function deleteSubscription(userId: number, endpoint: string): boolean {
  const res = db
    .delete(schema.pushSubscriptions)
    .where(
      and(eq(schema.pushSubscriptions.endpoint, endpoint), eq(schema.pushSubscriptions.userId, userId))
    )
    .run();
  return res.changes > 0;
}

/** Czy dany endpoint należy do tego użytkownika (front pyta „czy jestem zapisany"). */
export function hasSubscription(userId: number, endpoint: string): boolean {
  return (
    db
      .select({ id: schema.pushSubscriptions.id })
      .from(schema.pushSubscriptions)
      .where(
        and(eq(schema.pushSubscriptions.endpoint, endpoint), eq(schema.pushSubscriptions.userId, userId))
      )
      .get() != null
  );
}

// ---------------------------------------------------------------------------
// Wysyłka
// ---------------------------------------------------------------------------

/** `technicians.id[]` → `users.id[]` (tylko powiązani i aktywni). */
export function userIdsForTechnicians(technicianIds: number[]): number[] {
  if (technicianIds.length === 0) return [];
  return db
    .select({ userId: schema.technicians.userId })
    .from(schema.technicians)
    .where(
      and(
        inArray(schema.technicians.id, technicianIds),
        isNotNull(schema.technicians.userId),
        eq(schema.technicians.active, true)
      )
    )
    .all()
    .map((r) => r.userId)
    .filter((id): id is number => id != null);
}

function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === "number" ? code : null;
}

/**
 * Wysyła ładunek do WSZYSTKICH subskrypcji podanych techników.
 * Zwraca liczbę udanych strzałów. Nigdy nie rzuca.
 *
 * `excludeUserId` — konto, które samo wywołało zmianę. Technik klikający
 * „Zakończ" w panelu nie ma dostawać powiadomienia o własnym kliknięciu.
 */
export async function notifyTechnicians(
  technicianIds: number[],
  payload: PushPayload,
  opts: { excludeUserId?: number | null } = {}
): Promise<number> {
  if (!isPushEnabled() && transport == null) return 0;
  const userIds = userIdsForTechnicians(technicianIds).filter((id) => id !== opts.excludeUserId);
  if (userIds.length === 0) return 0;

  const subs = db
    .select()
    .from(schema.pushSubscriptions)
    .where(inArray(schema.pushSubscriptions.userId, userIds))
    .all();
  if (subs.length === 0) return 0;

  const send = activeTransport();
  let sent = 0;
  for (const sub of subs) {
    try {
      await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      sent++;
      db.update(schema.pushSubscriptions)
        .set({ lastUsedAt: sql`(datetime('now'))`, failures: 0 })
        .where(eq(schema.pushSubscriptions.id, sub.id))
        .run();
    } catch (err) {
      const status = statusCodeOf(err);
      if (status === 404 || status === 410) {
        // Push service mówi wprost: tej subskrypcji już nie ma.
        db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id)).run();
      } else {
        db.update(schema.pushSubscriptions)
          .set({ failures: sql`${schema.pushSubscriptions.failures} + 1` })
          .where(eq(schema.pushSubscriptions.id, sub.id))
          .run();
        console.warn(`[push] wysyłka nieudana (sub #${sub.id}, status ${status ?? "?"})`);
      }
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Kolejka „po transakcji"
// ---------------------------------------------------------------------------

interface QueuedPush {
  technicianIds: number[];
  payload: PushPayload;
  excludeUserId: number | null;
  /**
   * Sprawdzane PRZY OPRÓŻNIANIU kolejki, czyli na danych już zatwierdzonych.
   * Zwrot `false` = mutacja się wycofała (albo stan zdążył się zmienić) i
   * powiadomienia nie wysyłamy.
   */
  guard?: () => boolean;
}

const queue: QueuedPush[] = [];
let scheduled = false;
/** Łańcuch obietnic — `flushPush()` w teście czeka na to, co już leci. */
let inflight: Promise<void> = Promise.resolve();

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      if (item.guard && !item.guard()) continue;
      await notifyTechnicians(item.technicianIds, item.payload, { excludeUserId: item.excludeUserId });
    } catch (err) {
      console.warn("[push] błąd przy opróżnianiu kolejki:", err);
    }
  }
}

/**
 * Zgłasza powiadomienie do wysłania PO bieżącej transakcji. Synchroniczne,
 * bez żadnego I/O — wolno je wołać wprost z mutacji kalendarza.
 */
export function queueTechnicianPush(
  technicianIds: number[],
  payload: PushPayload,
  opts: { excludeUserId?: number | null; guard?: () => boolean } = {}
): void {
  if (technicianIds.length === 0) return;
  if (!isPushEnabled() && transport == null) return;
  queue.push({
    technicianIds,
    payload,
    excludeUserId: opts.excludeUserId ?? null,
    guard: opts.guard,
  });
  if (scheduled) return;
  scheduled = true;
  // `setImmediate` wypada po zakończeniu bieżącego zadania makro, a transakcje
  // better-sqlite3 są w całości synchroniczne — czyli po COMMIT albo ROLLBACK.
  setImmediate(() => {
    scheduled = false;
    inflight = inflight.then(drain);
    void inflight;
  });
}

/** Opróżnia kolejkę natychmiast i czeka na wynik. Wyłącznie dla testów. */
export async function flushPush(): Promise<void> {
  scheduled = false;
  inflight = inflight.then(drain);
  await inflight;
}
