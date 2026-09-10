/**
 * Notatki kartoteki obiektu (`object_notes`) + „Zapisz też w obiekcie" z kalendarza —
 * trasy Hono przez `app.request`, z podstawionym userem w kontekście i PRAWDZIWYM
 * `tabPermissionGuard`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-object-notes.ts   # na kopii bazy
 *   npx tsx scripts/test-object-notes.ts                           # na data/alfa.db (sprząta po sobie)
 *
 * Sprawdza:
 *   • CRUD notatek obiektu (najnowsze pierwsze, walidacja treści, soft delete),
 *   • uprawnienia: bez `objects: edit` zapis 403, cudza notatka 403, admin OK,
 *   • `copyToObject` przy dodawaniu notatki kalendarza — wiersz w `object_notes`
 *     ze ŹRÓDŁEM, wpis w `activity_log` po `object_id` (historia karty obiektu)
 *     i `objectNoteId` w odpowiedzi oraz w GET-ach notatek,
 *   • POST /calendar/notes/:id/copy-to-object jest IDEMPOTENTNY (drugie wywołanie
 *     zwraca tę samą kopię, bez drugiego wiersza i drugiego wpisu w dzienniku),
 *   • wydarzenie bez obiektu → 400, brak `objects: edit` → 403,
 *   • soft delete kopii ZWALNIA partial unique index — można skopiować ponownie.
 *
 * Sprząta po sobie HARD (notatki obiektu, wydarzenia + ich notatki, dziennik,
 * obiekt, kontrahent, konta), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import objectsRoutes from "../src/routes/objects.js";
import calendarRoutes from "../src/routes/calendar.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__OBJ_NOTES_TEST__";
const DAY = "2026-10-21";

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): void {
  const objectIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const eventIds = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (objectIds.length) {
    db.delete(schema.objectNotes).where(inArray(schema.objectNotes.objectId, objectIds)).run();
    db.delete(schema.activityLog).where(inArray(schema.activityLog.objectId, objectIds)).run();
  }
  if (eventIds.length) {
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, eventIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  if (objectIds.length) {
    db.delete(schema.objectServices).where(inArray(schema.objectServices.objectId, objectIds)).run();
    db.delete(schema.objectHistory).where(inArray(schema.objectHistory.objectId, objectIds)).run();
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

function makeUser(suffix: string, permissions: PermissionMap, role: "user" | "admin" = "user"): User {
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

/** Klient HTTP dla usera: kontekst jak po requireAuth + prawdziwy strażnik zakładek. */
function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/api/objects", objectsRoutes);
  app.route("/api/calendar", calendarRoutes);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: any; error?: string } | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

const editor = makeUser("editor", { objects: "edit", "technical/kalendarz": "edit" });
const viewer = makeUser("viewer", { objects: "view", "technical/kalendarz": "edit" });
const other = makeUser("other", { objects: "edit", "technical/kalendarz": "edit" });
const admin = makeUser("admin", {}, "admin");

const E = clientFor(editor);
const V = clientFor(viewer);
const O = clientFor(other);
const A = clientFor(admin);

const contractor = db
  .insert(schema.contractors)
  .values({ name: `${PREFIX} Kontrahent`, nip: `${Date.now()}`.slice(-10) })
  .returning()
  .get();

const object = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt`,
    type: "monitoring",
    installationType: "new",
  })
  .returning()
  .get();

function insertEvent(title: string, objectId: number | null) {
  return db
    .insert(schema.calendarEvents)
    .values({
      type: "serwis",
      title: `${PREFIX} ${title}`,
      startAt: `${DAY}T09:00`,
      endAt: `${DAY}T11:00`,
      department: "technical",
      objectId,
      createdBy: editor.id,
    })
    .returning()
    .get();
}

const evWithObject = insertEvent("Serwis", object.id);
const evNoObject = insertEvent("Bez obiektu", null);

const objectNoteRows = () =>
  db.select().from(schema.objectNotes).where(eq(schema.objectNotes.objectId, object.id)).all();
const objectActivity = () =>
  db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "object"), eq(schema.activityLog.objectId, object.id)))
    .all();

try {
  // -------------------------------------------------------------------------
  // 1. CRUD notatek obiektu
  // -------------------------------------------------------------------------
  const created = await E("POST", `/objects/${object.id}/notes`, { text: "  Brama od podwórza, kod 1234  " });
  ok("POST /objects/:id/notes → 201", created.status === 201, created);
  ok("notatka: trim treści", created.data?.text === "Brama od podwórza, kod 1234", created.data);
  ok("notatka: autor + etykieta", created.data?.userId === editor.id && created.data?.userLabel === `${PREFIX}editor`, created.data);
  ok("notatka pisana wprost: source = null", created.data?.source === null, created.data);
  const noteId = created.data.id as number;

  const empty = await E("POST", `/objects/${object.id}/notes`, { text: "   " });
  ok("pusta treść → 400", empty.status === 400, empty);

  const tooLong = await E("POST", `/objects/${object.id}/notes`, { text: "x".repeat(4001) });
  ok("treść > 4000 znaków → 400", tooLong.status === 400, tooLong);

  const missingObject = await E("POST", `/objects/999999999/notes`, { text: "sierota" });
  ok("nieistniejący obiekt → 404", missingObject.status === 404, missingObject);

  const second = await E("POST", `/objects/${object.id}/notes`, { text: "Druga notatka" });
  const listed = await E("GET", `/objects/${object.id}/notes`);
  ok("GET zwraca obie notatki", listed.data?.length === 2, listed.data);
  ok("GET: najnowsze pierwsze", listed.data?.[0]?.id === second.data.id, listed.data);

  const updated = await E("PUT", `/objects/notes/${noteId}`, { text: "Brama od podwórza, kod 4321" });
  ok("PUT autor → 200", updated.status === 200 && updated.data?.text === "Brama od podwórza, kod 4321", updated);

  const del = await E("DELETE", `/objects/notes/${second.data.id}`);
  ok("DELETE autor → 200", del.status === 200, del);
  const afterDelete = await E("GET", `/objects/${object.id}/notes`);
  ok("usunięta notatka znika z listy", afterDelete.data?.length === 1, afterDelete.data);
  ok(
    "soft delete: wiersz zostaje z deleted_at",
    objectNoteRows().find((r) => r.id === second.data.id)?.deletedAt != null,
    objectNoteRows()
  );
  const delAgain = await E("DELETE", `/objects/notes/${second.data.id}`);
  ok("powtórny DELETE → 404", delAgain.status === 404, delAgain);

  // -------------------------------------------------------------------------
  // 2. Uprawnienia
  // -------------------------------------------------------------------------
  const viewerList = await V("GET", `/objects/${object.id}/notes`);
  ok("viewer: GET → 200", viewerList.status === 200, viewerList);
  const viewerAdd = await V("POST", `/objects/${object.id}/notes`, { text: "nie wolno" });
  ok("viewer: POST → 403", viewerAdd.status === 403, viewerAdd);
  const viewerEdit = await V("PUT", `/objects/notes/${noteId}`, { text: "nie wolno" });
  ok("viewer: PUT → 403", viewerEdit.status === 403, viewerEdit);

  const otherEdit = await O("PUT", `/objects/notes/${noteId}`, { text: "cudza notatka" });
  ok("cudza notatka: PUT → 403", otherEdit.status === 403, otherEdit);
  const otherDelete = await O("DELETE", `/objects/notes/${noteId}`);
  ok("cudza notatka: DELETE → 403", otherDelete.status === 403, otherDelete);

  const adminEdit = await A("PUT", `/objects/notes/${noteId}`, { text: "poprawione przez admina" });
  ok("admin: PUT cudzej notatki → 200", adminEdit.status === 200 && adminEdit.data?.text === "poprawione przez admina", adminEdit);

  // -------------------------------------------------------------------------
  // 3. copyToObject przy dodawaniu notatki kalendarza
  // -------------------------------------------------------------------------
  const activityBefore = objectActivity().length;
  const withCopy = await E("POST", `/calendar/events/${evWithObject.id}/notes`, {
    text: "Klient prosi o dodatkową kamerę przy bramie",
    copyToObject: true,
  });
  ok("POST notatki kalendarza z copyToObject → 201", withCopy.status === 201, withCopy);
  ok("odpowiedź niesie objectNoteId", typeof withCopy.data?.objectNoteId === "number", withCopy.data);

  const copyRow = objectNoteRows().find((r) => r.id === withCopy.data.objectNoteId);
  ok("kopia w object_notes ma źródło", copyRow?.sourceEventId === evWithObject.id && copyRow?.sourceNoteId === withCopy.data.id, copyRow);
  ok("kopia ma tę samą treść", copyRow?.text === "Klient prosi o dodatkową kamerę przy bramie", copyRow);

  const objectNotes = await E("GET", `/objects/${object.id}/notes`);
  const copyJson = objectNotes.data?.find((n: any) => n.id === withCopy.data.objectNoteId);
  ok(
    "JSON kopii: source z danymi wydarzenia",
    copyJson?.source?.eventId === evWithObject.id &&
      copyJson?.source?.noteId === withCopy.data.id &&
      copyJson?.source?.eventTitle === evWithObject.title &&
      copyJson?.source?.eventType === "serwis" &&
      copyJson?.source?.eventStartAt === `${DAY}T09:00` &&
      copyJson?.source?.eventDepartment === "technical",
    copyJson
  );

  const added = objectActivity().slice(activityBefore);
  ok(
    "activity_log obiektu: wpis „z kalendarza”",
    added.length === 1 && added[0].action === "note_added" && (added[0].summary ?? "").includes("(z kalendarza)"),
    added
  );

  const eventNotes = await E("GET", `/calendar/events/${evWithObject.id}/notes`);
  const copied = eventNotes.data?.find((n: any) => n.id === withCopy.data.id);
  ok("GET notatek wydarzenia: objectNoteId ustawione", copied?.objectNoteId === withCopy.data.objectNoteId, copied);
  const evDetails = await E("GET", `/calendar/events/${evWithObject.id}`);
  ok(
    "GET wydarzenia: objectNoteId w notatkach",
    evDetails.data?.notes?.find((n: any) => n.id === withCopy.data.id)?.objectNoteId === withCopy.data.objectNoteId,
    evDetails.data?.notes
  );

  // -------------------------------------------------------------------------
  // 4. copy-to-object istniejącej notatki + idempotencja
  // -------------------------------------------------------------------------
  const plain = await E("POST", `/calendar/events/${evWithObject.id}/notes`, { text: "Kod do szlabanu: 9911" });
  ok("notatka bez kopii: objectNoteId = null", plain.data?.objectNoteId === null, plain.data);

  const beforeCopy = objectActivity().length;
  const copy1 = await E("POST", `/calendar/notes/${plain.data.id}/copy-to-object`);
  ok("copy-to-object → 200", copy1.status === 200, copy1);
  ok("kopia wskazuje obiekt wydarzenia", copy1.data?.objectId === object.id && copy1.data?.source?.noteId === plain.data.id, copy1.data);

  const copy2 = await E("POST", `/calendar/notes/${plain.data.id}/copy-to-object`);
  ok("copy-to-object idempotentne (ten sam id)", copy2.status === 200 && copy2.data?.id === copy1.data.id, copy2);
  ok(
    "idempotencja: jeden wiersz i jeden wpis w dzienniku",
    objectNoteRows().filter((r) => r.sourceNoteId === plain.data.id && r.deletedAt == null).length === 1 &&
      objectActivity().length - beforeCopy === 1,
    { rows: objectNoteRows().length, activity: objectActivity().length - beforeCopy }
  );

  // -------------------------------------------------------------------------
  // 5. Warunki brzegowe kopiowania
  // -------------------------------------------------------------------------
  const noteNoObject = await E("POST", `/calendar/events/${evNoObject.id}/notes`, { text: "Notatka bez obiektu" });
  const copyNoObject = await E("POST", `/calendar/notes/${noteNoObject.data.id}/copy-to-object`);
  ok("wydarzenie bez obiektu → 400", copyNoObject.status === 400, copyNoObject);
  ok("komunikat 400 o braku obiektu", (copyNoObject.error ?? "").includes("nie ma przypisanego obiektu"), copyNoObject);

  const addNoObject = await E("POST", `/calendar/events/${evNoObject.id}/notes`, {
    text: "Też bez obiektu",
    copyToObject: true,
  });
  ok("copyToObject na wydarzeniu bez obiektu → 400", addNoObject.status === 400, addNoObject);
  ok(
    "400 nie zostawia notatki kalendarza",
    db
      .select()
      .from(schema.calendarEventNotes)
      .where(eq(schema.calendarEventNotes.eventId, evNoObject.id))
      .all()
      .every((n) => n.text !== "Też bez obiektu"),
    "notatka mimo 400"
  );

  const viewerCopy = await V("POST", `/calendar/events/${evWithObject.id}/notes`, {
    text: "Bez prawa do kartoteki",
    copyToObject: true,
  });
  ok("brak `objects: edit` → 403", viewerCopy.status === 403, viewerCopy);
  ok(
    "403 nie zostawia notatki kalendarza",
    db
      .select()
      .from(schema.calendarEventNotes)
      .where(eq(schema.calendarEventNotes.eventId, evWithObject.id))
      .all()
      .every((n) => n.text !== "Bez prawa do kartoteki"),
    "notatka mimo 403"
  );

  // -------------------------------------------------------------------------
  // 6. Soft delete kopii zwalnia partial unique index
  // -------------------------------------------------------------------------
  const removeCopy = await E("DELETE", `/objects/notes/${copy1.data.id}`);
  ok("usunięcie kopii → 200", removeCopy.status === 200, removeCopy);
  const afterRemove = await E("GET", `/calendar/events/${evWithObject.id}/notes`);
  ok(
    "po usunięciu kopii objectNoteId znów null",
    afterRemove.data?.find((n: any) => n.id === plain.data.id)?.objectNoteId === null,
    afterRemove.data
  );
  const copy3 = await E("POST", `/calendar/notes/${plain.data.id}/copy-to-object`);
  ok("można skopiować ponownie (nowy wiersz)", copy3.status === 200 && copy3.data?.id !== copy1.data.id, copy3);
} finally {
  cleanup();
  console.log(failures === 0 ? "\nWszystkie testy przeszły." : `\n${failures} test(ów) nie przeszło.`);
  process.exit(failures === 0 ? 0 : 1);
}
