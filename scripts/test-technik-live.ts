/**
 * Panel technika „na żywo" (SSE `GET /api/technik/live`) — na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-technik-live.ts
 *   npx tsx scripts/test-technik-live.ts          # na data/alfa.db (sprząta po sobie)
 *
 * Co jest tu pilnowane:
 *   • strumień staje od razu (ramka `ready`) i mówi, czy konto jest powiązane
 *     z kartoteką techników,
 *   • każda zmiana zlecenia zrobiona z kalendarza BIURA dochodzi do przypisanego
 *     technika: opis (`updated`), przesunięcie terminu (`updated`), status
 *     `done`/`cancelled` (`updated`), notatka (`notes`), usunięcie (`deleted`),
 *   • odpięcie technika od zlecenia dociera do NIEGO jako `unassigned` (mimo że
 *     w chwili wysyłki nie ma już wiersza przypisania — patrz
 *     `rememberEventTechnicians` w src/lib/calendar-live.ts), a do reszty ekipy
 *     jako `updated`,
 *   • CUDZE zlecenia nie docierają: technik B nie widzi ani jednego sygnału
 *     o zleceniu technika A (sygnał kalendarza jest DZIAŁOWY — filtr własności
 *     jest po stronie serwera, src/lib/technik-live.ts),
 *   • własny zapis z tej samej karty jest pomijany (`?client=` = `X-Alfa-Client`),
 *     ale ta sama zmiana dochodzi do drugiego technika z ekipy,
 *   • konto bez powiązania z kartoteką dostaje otwarty, ale niemy strumień,
 *   • zamknięcie strumienia odpina subskrypcję (brak wycieku w brokerze).
 *
 * Sprząta po sobie HARD (wydarzenia, notatki, przypisania, realizacje z protokołami,
 * obiekt, kontrahent, technicy, konta, dziennik), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import technikRoutes from "../src/routes/technik.js";
import calendarRoutes from "../src/routes/calendar.js";
import { subscriberCount } from "../src/lib/calendar-live.js";
import { tabPermissionGuard, technikRoleGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__LIVE__";
const DAY = "2026-11-10";

// Push idzie inną drogą (src/lib/push.ts) i nie ma tu nic do roboty — skrypt
// uruchomiony lokalnie mógłby mieć klucze VAPID z `.env`.
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): void {
  const eventIds = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const realizationIds = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(or(like(schema.realizations.note, `%${PREFIX}%`), like(schema.realizations.site, `%${PREFIX}%`)))
    .all()
    .map((r) => r.id);

  if (eventIds.length) {
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, eventIds)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  if (realizationIds.length) {
    const protocolIds = db
      .select({ id: schema.protocols.id })
      .from(schema.protocols)
      .where(inArray(schema.protocols.realizationId, realizationIds))
      .all()
      .map((r) => r.id);
    if (protocolIds.length) {
      db.delete(schema.activityLog)
        .where(and(eq(schema.activityLog.entityType, "protocol"), inArray(schema.activityLog.entityId, protocolIds)))
        .run();
    }
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "realization"), inArray(schema.activityLog.entityId, realizationIds)))
      .run();
    db.delete(schema.realizations).where(inArray(schema.realizations.id, realizationIds)).run();
  }
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
  const objectIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (objectIds.length) {
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "object"), inArray(schema.activityLog.entityId, objectIds)))
      .run();
    db.delete(schema.objects).where(inArray(schema.objects.id, objectIds)).run();
  }
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
}
cleanup();

// ---------------------------------------------------------------------------
// Fikstury
// ---------------------------------------------------------------------------

function makeUser(suffix: string, role: string, permissions: PermissionMap = {}): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x", // konto nigdy się nie loguje — kontekst podstawiamy wprost
      displayName: `${PREFIX}${suffix}`,
      role,
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .get();
}

function makeTechnician(suffix: string, userId: number | null) {
  return db
    .insert(schema.technicians)
    .values({ firstName: suffix, lastName: `${PREFIX}${suffix}`, type: "internal", active: true, userId })
    .returning()
    .get();
}

/** Panel technika z prawdziwymi strażnikami (jak w src/routes/index.ts). */
function panelAppFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", technikRoleGuard);
  app.use("*", tabPermissionGuard);
  app.route("/api/technik", technikRoutes);
  return app;
}

/** Kalendarz biura — tą drogą idą zmiany, które technik ma zobaczyć na tablecie. */
function calendarFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.route("/api/calendar", calendarRoutes);
  return async (method: string, path: string, body?: unknown, client?: string) => {
    const res = await app.request(`/api/calendar${path}`, {
      method,
      ...(body !== undefined
        ? {
            body: JSON.stringify(body),
            headers: {
              "Content-Type": "application/json",
              ...(client ? { "X-Alfa-Client": client } : {}),
            },
          }
        : { headers: client ? { "X-Alfa-Client": client } : {} }),
    });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: unknown; error?: string }
      | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/** Mutacja z PANELU (start/zakończ) — z nagłówkiem karty, żeby dało się ją pominąć. */
function panelFor(user: User) {
  const app = panelAppFor(user);
  return async (method: string, path: string, body?: unknown, client?: string) => {
    const res = await app.request(`/api/technik${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(client ? { "X-Alfa-Client": client } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

// ---------------------------------------------------------------------------
// Klient SSE — parser „ile trzeba" (ramki rozdzielone pustą linią)
// ---------------------------------------------------------------------------

interface LiveChange {
  kind: "updated" | "deleted" | "unassigned" | "notes";
  ids: number[];
  at: string;
}

interface LiveStream {
  label: string;
  changes: LiveChange[];
  ready: Promise<{ linked: boolean }>;
  close: () => void;
}

async function openLive(user: User, client?: string): Promise<LiveStream> {
  const app = panelAppFor(user);
  const controller = new AbortController();
  const url = `/api/technik/live${client ? `?client=${encodeURIComponent(client)}` : ""}`;
  const res = await app.request(url, { signal: controller.signal });
  if (res.status !== 200 || !res.body) throw new Error(`SSE ${url}: HTTP ${res.status}`);
  const changes: LiveChange[] = [];
  let readyResolve: (d: { linked: boolean }) => void = () => {};
  const ready = new Promise<{ linked: boolean }>((res2) => {
    readyResolve = res2;
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) continue; // heartbeat
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (data.length === 0) continue;
          const payload = JSON.parse(data.join("\n"));
          if (event === "ready") readyResolve(payload as { linked: boolean });
          else if (event === "technik") changes.push(payload as LiveChange);
        }
      }
    } catch {
      /* zamknięcie strumienia w teście — nie jest błędem */
    }
  })();
  return {
    label: user.displayName ?? String(user.id),
    changes,
    ready,
    close: () => {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Czeka na pierwszą ramkę spełniającą warunek (albo `null` po timeoucie). */
async function waitFor(
  stream: LiveStream,
  pred: (c: LiveChange) => boolean,
  ms = 3000
): Promise<LiveChange | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = stream.changes.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await sleep(20);
  }
}

/** Ile ramek dotyczy danego id (do sprawdzenia „nic nie przyszło"). */
function framesFor(stream: LiveStream, id: number): LiveChange[] {
  return stream.changes.filter((c) => c.ids.includes(id));
}

// ---------------------------------------------------------------------------

const adminUser = makeUser("admin", "admin");
const techUserA = makeUser("techA", "technik");
const techUserB = makeUser("techB", "technik");
const unlinkedUser = makeUser("nolink", "technik");
const techA = makeTechnician("Adam", techUserA.id);
const techB = makeTechnician("Bogdan", techUserB.id);

const contractor = db
  .insert(schema.contractors)
  .values({ name: `${PREFIX} Kontrahent`, nip: `9${String(Date.now()).slice(-9)}`, city: "Poznań" })
  .returning()
  .get();

const object = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt`,
    address: "Testowa 1",
    city: "Poznań",
    type: "monitoring",
    installationType: "new",
  })
  .returning()
  .get();

function insertEvent(title: string, technicianIds: number[], hour = 9): number {
  const h = String(hour).padStart(2, "0");
  const ev = db
    .insert(schema.calendarEvents)
    .values({
      type: "serwis",
      title: `${PREFIX} ${title}`,
      description: "Wymiana kamery przy bramie",
      startAt: `${DAY}T${h}:00`,
      endAt: `${DAY}T${String(hour + 1).padStart(2, "0")}:00`,
      allDay: false,
      status: "planned",
      department: "technical",
      objectId: object.id,
      createdBy: adminUser.id,
      updatedBy: adminUser.id,
    })
    .returning()
    .get();
  for (const id of technicianIds) {
    db.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: id }).run();
  }
  return ev.id;
}

/** Pełne ciało PUT /calendar/events/:id — trasa wymaga kompletu pól. */
function putBody(title: string, technicianIds: number[], over: Record<string, unknown> = {}) {
  return {
    type: "serwis",
    department: "technical",
    title: `${PREFIX} ${title}`,
    startAt: `${DAY}T09:00`,
    endAt: `${DAY}T10:00`,
    allDay: false,
    status: "planned",
    objectId: object.id,
    technicianIds,
    ...over,
  };
}

const CLIENT_A = "karta-technika-A";
const office = calendarFor(adminUser);
const panelA = panelFor(techUserA);

const streams: LiveStream[] = [];

try {
  const jobA = insertEvent("Zlecenie A", [techA.id], 9);
  const jobShared = insertEvent("Zlecenie wspolne", [techA.id, techB.id], 11);
  const jobB = insertEvent("Zlecenie B", [techB.id], 13);

  const A = await openLive(techUserA, CLIENT_A);
  const B = await openLive(techUserB);
  const N = await openLive(unlinkedUser);
  streams.push(A, B, N);

  // =========================================================================
  // 1. Otwarcie strumienia
  // =========================================================================
  const readyA = await A.ready;
  const readyN = await N.ready;
  ok("live: ramka ready dla powiązanego konta", readyA.linked === true, readyA);
  ok("live: konto bez powiązania dostaje ready z linked=false", readyN.linked === false, readyN);

  // =========================================================================
  // 2. Zmiana opisu z kalendarza biura → `updated` u przypisanego
  // =========================================================================
  const put1 = await office("PUT", `/events/${jobA}`, putBody("Zlecenie A", [techA.id], { description: "Nowy opis z biura" }));
  ok("biuro: PUT opisu 200", put1.status === 200, put1);
  const upd = await waitFor(A, (c) => c.kind === "updated" && c.ids.includes(jobA));
  ok("live: zmiana opisu dociera jako updated", upd != null, A.changes);

  // =========================================================================
  // 3. Przesunięcie terminu (PATCH /move) → `updated`
  // =========================================================================
  A.changes.length = 0;
  const moved = await office("PATCH", `/events/${jobA}/move`, { startAt: `${DAY}T14:00`, endAt: `${DAY}T15:00`, allDay: false });
  ok("biuro: PATCH /move 200", moved.status === 200, moved);
  ok("live: przesunięcie terminu dociera", (await waitFor(A, (c) => c.kind === "updated" && c.ids.includes(jobA))) != null, A.changes);

  // =========================================================================
  // 4. Notatka biura → `notes`
  // =========================================================================
  A.changes.length = 0;
  const note = await office("POST", `/events/${jobA}/notes`, { text: `${PREFIX} notatka z biura` });
  ok("biuro: POST notatki 201", note.status === 201 || note.status === 200, note);
  ok("live: notatka dociera jako notes", (await waitFor(A, (c) => c.kind === "notes" && c.ids.includes(jobA))) != null, A.changes);

  // =========================================================================
  // 5. Cudze zlecenia NIE docierają
  // =========================================================================
  B.changes.length = 0;
  await office("PUT", `/events/${jobA}`, putBody("Zlecenie A", [techA.id], { description: "Jeszcze inny opis" }));
  await sleep(300);
  ok("live: technik B nie widzi zmian zlecenia A", framesFor(B, jobA).length === 0, B.changes);
  ok("live: konto bez powiązania nie dostaje nic", N.changes.length === 0, N.changes);

  // =========================================================================
  // 6. Odpięcie technika → `unassigned` u niego, `updated` u reszty ekipy
  // =========================================================================
  A.changes.length = 0;
  B.changes.length = 0;
  const unassign = await office("PUT", `/events/${jobShared}`, putBody("Zlecenie wspolne", [techB.id], {
    startAt: `${DAY}T11:00`,
    endAt: `${DAY}T12:00`,
  }));
  ok("biuro: PUT bez technika A 200", unassign.status === 200, unassign);
  const gone = await waitFor(A, (c) => c.kind === "unassigned" && c.ids.includes(jobShared));
  ok("live: odpięty technik dostaje unassigned", gone != null, A.changes);
  const stillB = await waitFor(B, (c) => c.kind === "updated" && c.ids.includes(jobShared));
  ok("live: reszta ekipy dostaje updated", stillB != null, B.changes);

  // =========================================================================
  // 7. Status done / cancelled
  // =========================================================================
  B.changes.length = 0;
  const done = await office("PUT", `/events/${jobB}`, putBody("Zlecenie B", [techB.id], {
    startAt: `${DAY}T13:00`,
    endAt: `${DAY}T14:00`,
    status: "done",
  }));
  ok("biuro: status done 200", done.status === 200, done);
  ok("live: status done dociera", (await waitFor(B, (c) => c.kind === "updated" && c.ids.includes(jobB))) != null, B.changes);

  B.changes.length = 0;
  const cancelled = await office("PUT", `/events/${jobB}`, putBody("Zlecenie B", [techB.id], {
    startAt: `${DAY}T13:00`,
    endAt: `${DAY}T14:00`,
    status: "cancelled",
  }));
  ok("biuro: status cancelled 200", cancelled.status === 200, cancelled);
  ok("live: odwołanie dociera", (await waitFor(B, (c) => c.kind === "updated" && c.ids.includes(jobB))) != null, B.changes);

  // =========================================================================
  // 8. Usunięcie wydarzenia → `deleted`
  // =========================================================================
  A.changes.length = 0;
  const del = await office("DELETE", `/events/${jobA}`);
  ok("biuro: DELETE 200", del.status === 200, del);
  ok("live: usunięcie dociera jako deleted", (await waitFor(A, (c) => c.kind === "deleted" && c.ids.includes(jobA))) != null, A.changes);

  // =========================================================================
  // 9. Własny zapis tej samej karty jest pomijany, cudzy — nie
  // =========================================================================
  const jobOwn = insertEvent("Zlecenie wlasne", [techA.id, techB.id], 15);
  A.changes.length = 0;
  B.changes.length = 0;
  const started = await panelA("POST", `/jobs/${jobOwn}/start`, {}, CLIENT_A);
  ok("panel: Rozpocznij 200", started.status === 200, started);
  const otherGot = await waitFor(B, (c) => c.ids.includes(jobOwn));
  ok("live: zmiana z panelu dociera do drugiego technika", otherGot != null, B.changes);
  ok("live: własna karta pomija swój zapis", framesFor(A, jobOwn).length === 0, A.changes);

  // =========================================================================
  // 10. Zamknięcie strumienia odpina subskrypcję
  // =========================================================================
  const before = subscriberCount();
  N.close();
  await sleep(200);
  ok("live: zamknięty strumień znika z brokera", subscriberCount() === before - 1, {
    before,
    after: subscriberCount(),
  });
} finally {
  for (const s of streams) s.close();
  await sleep(100);
  cleanup();
}

console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
