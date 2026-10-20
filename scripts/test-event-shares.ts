/**
 * Udostępnianie wydarzeń linkiem (calendar_event_shares, migracja 0117,
 * docs/UDOSTEPNIANIE-WYDARZEN.md):
 *   npx tsx scripts/test-on-copy.ts scripts/test-event-shares.ts   # na kopii bazy (zalecane)
 *
 * Zalogowane trasy idą przez `app.request` z podstawionym userem i PRAWDZIWYM
 * `tabPermissionGuard`; publiczna — przez CAŁY router API (src/routes/index.ts),
 * bez cookie, żeby złapać ewentualne zamontowanie za requireAuth.
 *
 * Sprawdza:
 *   • uprawnienia: `view` na kalendarzu → 403 (także GET listy), `edit` → OK, wydarzenie handlowe → 404,
 *   • link dla technika (nazwa z kartoteki) i dla gościa (walidacja imienia: brak/spacje/81 znaków),
 *   • walidację ważności (zła wartość, „event+7d” dla dawno zakończonego wydarzenia),
 *   • w DB tylko sha256(token) — token nie leży w żadnej kolumnie, lista bez hasha,
 *   • publiczny GET: kształt, nagłówki (no-referrer/no-store/noindex), brak notatek/kwot/protokołu,
 *     licznik otwarć, coTechnicians bez samego odbiorcy,
 *   • jednolite 404: zły format, nieznany, wygasły, odwołany, wydarzenie usunięte, typ notatka,
 *   • DELETE idempotentny (jeden wpis „unshared” w activity_log), wpisy „shared”,
 *   • limit per IP (429).
 *   ETAP 2 (link „do pracy”, migracja 0118):
 *   • canWork w POST/ShareRow, PATCH przełącznika (403/400/404/409, wpis „shared”, bez wpisu przy braku zmiany),
 *   • gość i technik: notatki JSON/multipart, edycja, usuwanie, załączniki spod linku,
 *   • cudze notatki (biuro, inny link) niewidoczne i nietykalne (404),
 *   • etykieta „<odbiorca> (link)” w notatce i dzienniku, brak wycieku twórcy,
 *   • Rozpocznij/Zakończ (idempotencja, status, notatki systemowe), odwołane zlecenie → 409,
 *   • wygasły / odwołany / canWork=0 → 404 przy zapisie, wyłączenie nie kasuje notatek,
 *   • limity zapisów per IP i per link.
 *   „Widzi wszystkie notatki” (see_all_notes, migracja 0120) — niezależne od canWork:
 *   • POST/PATCH seeAllNotes (400 na nie-boolean, wpisy share_see_all_notes),
 *   • 4 kombinacje: 0/0 brak notatek; 1/0 tylko własne; 0/1 wszystkie tylko do odczytu;
 *     1/1 wszystkie (z podpisami, systemowe, cudze załączniki), zmiany tylko własnych —
 *     cudza widoczna → 403, niewidoczna → 404, zapis bez canWork → 404 „Link nieaktywny”.
 *
 * Sprząta po sobie (prefiks fikstur), także przy błędzie.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { removeEventAttachmentDir } from "../src/lib/calendar-attachments.js";
import { Hono } from "hono";
import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import api from "../src/routes/index.js";
import calendarSharesRoutes, {
  sharePublicPerIp,
  shareWritePerIp,
  shareWritePerLink,
  shareFilesPerIp,
} from "../src/routes/calendar-shares.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";
import { moveEvent } from "../src/lib/calendar-mutations.js";
import { loadEvents } from "../src/lib/calendar-queries.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)?.slice(0, 600)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__EVENT_SHARES_TEST__";
const SECRET_NOTE = `${PREFIX} tajna notatka biura`;

function cleanup(): void {
  const eventIds = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  // Realizacje założone automatem przy „Zakończ” (status „wykonane”).
  const realizationIds = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(or(like(schema.realizations.note, `%${PREFIX}%`), like(schema.realizations.site, `%${PREFIX}%`)))
    .all()
    .map((r) => r.id);
  if (eventIds.length) {
    for (const id of eventIds) removeEventAttachmentDir(id);
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, eventIds)).run();
    db.delete(schema.calendarEventShares).where(inArray(schema.calendarEventShares.eventId, eventIds)).run();
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, eventIds)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  if (realizationIds.length) {
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "realization"), inArray(schema.activityLog.entityId, realizationIds)))
      .run();
    db.delete(schema.realizations).where(inArray(schema.realizations.id, realizationIds)).run();
  }
  const objectIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (objectIds.length) {
    db.delete(schema.activityLog).where(inArray(schema.activityLog.objectId, objectIds)).run();
    db.delete(schema.objectServices).where(inArray(schema.objectServices.objectId, objectIds)).run();
    db.delete(schema.objectHistory).where(inArray(schema.objectHistory.objectId, objectIds)).run();
    db.delete(schema.objects).where(inArray(schema.objects.id, objectIds)).run();
  }
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
}
cleanup();

// ---------------------------------------------------------------------------
// Fikstury
// ---------------------------------------------------------------------------

function makeUser(suffix: string, permissions: PermissionMap): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x",
      displayName: `${PREFIX}${suffix}`,
      role: "user",
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .get();
}

function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/api/calendar", calendarSharesRoutes);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: any; error?: string } | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/** Publiczny GET przez CAŁY router API, bez cookie. */
async function publicGet(token: string, ip = "198.51.100.7") {
  const res = await api.request(`/share/${token}`, { headers: { "x-real-ip": ip } });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* nie-JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const editor = makeUser("editor", { "technical/kalendarz": "edit" });
const viewer = makeUser("viewer", { "technical/kalendarz": "view" });
const E = clientFor(editor);
const V = clientFor(viewer);

const contractor = db
  .insert(schema.contractors)
  .values({ name: `${PREFIX} Kontrahent`, nip: `${Date.now()}`.slice(-10), contactPerson: "Pan Klient", phone: "600100200" })
  .returning()
  .get();
const object = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt`,
    type: "monitoring",
    installationType: "new",
    address: "Testowa 1",
    city: "Kraków",
    monthlyZdw: 987.65,
  })
  .returning()
  .get();

const techA = db
  .insert(schema.technicians)
  .values({ firstName: "Adam", lastName: `${PREFIX}Alfa` })
  .returning()
  .get();
const techB = db
  .insert(schema.technicians)
  .values({ firstName: "Bartek", lastName: `${PREFIX}Beta` })
  .returning()
  .get();

const future = new Date(Date.now() + 3 * 86400_000);
const day = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;

function insertEvent(title: string, extra: Partial<typeof schema.calendarEvents.$inferInsert> = {}) {
  return db
    .insert(schema.calendarEvents)
    .values({
      type: "serwis",
      title: `${PREFIX} ${title}`,
      description: "Wymiana dysku w rejestratorze",
      startAt: `${day}T09:00`,
      endAt: `${day}T11:00`,
      department: "technical",
      objectId: object.id,
      billing: "paid",
      createdBy: editor.id,
      ...extra,
    })
    .returning()
    .get();
}

const ev = insertEvent("Serwis");
db.insert(schema.calendarEventAssignees).values([
  { eventId: ev.id, technicianId: techA.id },
  { eventId: ev.id, technicianId: techB.id },
]).run();
db.insert(schema.calendarEventNotes).values({ eventId: ev.id, userId: editor.id, text: SECRET_NOTE }).run();

const oldEv = insertEvent("Dawny", { startAt: "2025-01-10T09:00", endAt: "2025-01-10T10:00" });
const noteEv = insertEvent("Notatka", { type: "notatka" });
const salesEv = insertEvent("Handlowe", { type: "spotkanie" as any, department: "handlowy" });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const shareRows = (eventId: number) =>
  db.select().from(schema.calendarEventShares).where(eq(schema.calendarEventShares.eventId, eventId)).all();
const shareActivity = (eventId: number) =>
  db
    .select()
    .from(schema.activityLog)
    .where(
      and(
        eq(schema.activityLog.entityType, "calendar_event"),
        eq(schema.activityLog.entityId, eventId),
        inArray(schema.activityLog.action, ["shared", "unshared"])
      )
    )
    .all();

try {
  sharePublicPerIp.reset();

  // -------------------------------------------------------------------------
  // 1. Uprawnienia
  // -------------------------------------------------------------------------
  const vList = await V("GET", `/calendar/events/${ev.id}/shares`);
  ok("view: GET listy → 403", vList.status === 403, vList);
  const vPost = await V("POST", `/calendar/events/${ev.id}/shares`, { recipientName: "X", expiresIn: "24h" });
  ok("view: POST → 403", vPost.status === 403, vPost);
  const sales = await E("POST", `/calendar/events/${salesEv.id}/shares`, { recipientName: "X", expiresIn: "24h" });
  ok("wydarzenie handlowe → 404", sales.status === 404, sales);
  const missing = await E("GET", `/calendar/events/999999999/shares`);
  ok("nieistniejące wydarzenie → 404", missing.status === 404, missing);

  // -------------------------------------------------------------------------
  // 2. Tworzenie: technik + gość, walidacja
  // -------------------------------------------------------------------------
  const forTech = await E("POST", `/calendar/events/${ev.id}/shares`, { technicianId: techA.id, expiresIn: "event+7d" });
  ok("POST technik → 201", forTech.status === 201, forTech);
  const techToken: string = forTech.data?.token;
  ok("token: 43 znaki base64url", /^[A-Za-z0-9_-]{43}$/.test(techToken ?? ""), techToken);
  ok("url kończy się /u/<token>", typeof forTech.data?.url === "string" && forTech.data.url.endsWith(`/u/${techToken}`), forTech.data?.url);
  ok("share: odbiorca = nazwa technika", forTech.data?.share?.recipientName === `Adam ${PREFIX}Alfa`, forTech.data?.share);
  ok("share: technicianId", forTech.data?.share?.technicianId === techA.id, forTech.data?.share);
  ok("share: status active, openCount 0", forTech.data?.share?.status === "active" && forTech.data?.share?.openCount === 0, forTech.data?.share);
  ok("share: createdByLabel", forTech.data?.share?.createdByLabel === `${PREFIX}editor`, forTech.data?.share);
  const expectedExp = new Date(new Date(`${day}T11:00`).getTime() + 7 * 86400_000).toISOString();
  ok("event+7d = koniec wydarzenia + 7 dni (UTC)", forTech.data?.share?.expiresAt === expectedExp, {
    got: forTech.data?.share?.expiresAt,
    expectedExp,
  });
  ok("share bez hasha/tokenu", !("tokenHash" in (forTech.data?.share ?? {})) && !("token" in (forTech.data?.share ?? {})), forTech.data?.share);

  const badTech = await E("POST", `/calendar/events/${ev.id}/shares`, { technicianId: 999999999, expiresIn: "24h" });
  ok("nieistniejący technik → 400", badTech.status === 400, badTech);
  const noName = await E("POST", `/calendar/events/${ev.id}/shares`, { expiresIn: "24h" });
  ok("gość bez imienia → 400", noName.status === 400, noName);
  const blank = await E("POST", `/calendar/events/${ev.id}/shares`, { recipientName: "   ", expiresIn: "24h" });
  ok("gość: same spacje → 400", blank.status === 400, blank);
  const tooLong = await E("POST", `/calendar/events/${ev.id}/shares`, { recipientName: "x".repeat(81), expiresIn: "24h" });
  ok("gość: 81 znaków → 400", tooLong.status === 400, tooLong);
  const badExp = await E("POST", `/calendar/events/${ev.id}/shares`, { recipientName: "Jan", expiresIn: "1y" });
  ok("zła ważność → 400", badExp.status === 400, badExp);
  const oldExp = await E("POST", `/calendar/events/${oldEv.id}/shares`, { recipientName: "Jan", expiresIn: "event+7d" });
  ok("event+7d dla dawnego wydarzenia → 400", oldExp.status === 400, oldExp);
  const old30 = await E("POST", `/calendar/events/${oldEv.id}/shares`, { recipientName: "Jan", expiresIn: "30d" });
  ok("30d dla dawnego wydarzenia → 201", old30.status === 201, old30);
  const notePost = await E("POST", `/calendar/events/${noteEv.id}/shares`, { recipientName: "Jan", expiresIn: "24h" });
  ok("typ notatka: POST → 400", notePost.status === 400, notePost);

  const forGuest = await E("POST", `/calendar/events/${ev.id}/shares`, { recipientName: "  Pan   Kowalski  ", expiresIn: "24h" });
  ok("POST gość → 201", forGuest.status === 201, forGuest);
  ok("gość: nazwa po trim/zwinięciu spacji", forGuest.data?.share?.recipientName === "Pan Kowalski", forGuest.data?.share);
  ok("gość: technicianId null", forGuest.data?.share?.technicianId === null, forGuest.data?.share);
  const guestToken: string = forGuest.data?.token;
  const exp24 = Date.parse(forGuest.data?.share?.expiresAt) - Date.now();
  ok("24h ≈ teraz + 24 h", exp24 > 23.9 * 3600_000 && exp24 <= 24 * 3600_000, forGuest.data?.share?.expiresAt);

  // -------------------------------------------------------------------------
  // 3. Hash w DB
  // -------------------------------------------------------------------------
  const rows = shareRows(ev.id);
  ok("w DB dwa linki", rows.length === 2, rows.length);
  ok("token_hash = sha256(token)", rows.some((r) => r.tokenHash === sha(techToken)) && rows.some((r) => r.tokenHash === sha(guestToken)), rows);
  ok(
    "tokenu nie ma w żadnej kolumnie",
    rows.every((r) => !Object.values(r).some((v) => typeof v === "string" && (v.includes(techToken) || v.includes(guestToken)))),
    rows
  );

  const list = await E("GET", `/calendar/events/${ev.id}/shares`);
  ok("GET listy → 200, 2 wiersze", list.status === 200 && list.data?.length === 2, list);
  ok("lista: najnowszy pierwszy", list.data?.[0]?.id === forGuest.data?.share?.id, list.data);
  ok("lista bez hasha", list.data?.every((r: any) => !("tokenHash" in r)), list.data);
  const keys = Object.keys(list.data?.[0] ?? {}).sort().join(",");
  ok(
    "ShareRow: dokładny zestaw kluczy",
    keys === "canWork,createdAt,createdByLabel,eventId,expiresAt,id,lastOpenedAt,openCount,recipientName,revokedAt,seeAllNotes,status,technicianId",
    keys
  );

  const acts = shareActivity(ev.id);
  ok(
    "activity_log: „Udostępniono link: …” ×2",
    acts.filter((a) => a.action === "shared").length === 2 &&
      acts.some((a) => a.summary === `Udostępniono link: Adam ${PREFIX}Alfa`) &&
      acts.some((a) => a.summary === "Udostępniono link: Pan Kowalski"),
    acts
  );

  // -------------------------------------------------------------------------
  // 4. Publiczny GET
  // -------------------------------------------------------------------------
  const pub = await publicGet(techToken);
  ok("public: 200 bez cookie (przed requireAuth)", pub.status === 200 && pub.json?.success === true, pub.text);
  ok("public: Referrer-Policy no-referrer", pub.headers.get("referrer-policy") === "no-referrer", pub.headers.get("referrer-policy"));
  ok("public: Cache-Control no-store", pub.headers.get("cache-control") === "no-store", pub.headers.get("cache-control"));
  ok("public: X-Robots-Tag noindex", (pub.headers.get("x-robots-tag") ?? "").includes("noindex"), pub.headers.get("x-robots-tag"));
  const d = pub.json?.data ?? {};
  ok("public: canProtocol/canProgress false", d.canProtocol === false && d.canProgress === false, d);
  ok("public: link bez canWork = tylko podgląd, notes []", d.canWork === false && d.canNotes === false && Array.isArray(d.notes) && d.notes.length === 0, d);
  ok("public: share = {recipientName, expiresAt}", d.share?.recipientName === `Adam ${PREFIX}Alfa` && d.share?.expiresAt === expectedExp && Object.keys(d.share).length === 2, d.share);
  ok("public: job.id i tytuł", d.job?.id === ev.id && d.job?.title === ev.title, d.job);
  ok("public: adres i kontakt", d.job?.address === "Testowa 1, Kraków" && d.job?.contactPerson === "Pan Klient", d.job);
  ok("public: notesCount 0, foreignNotesAt [], protocol null", d.job?.notesCount === 0 && d.job?.foreignNotesAt?.length === 0 && d.job?.protocol === null, d.job);
  ok("public: job.canProtocol/canProgress false", d.job?.canProtocol === false && d.job?.canProgress === false, d.job);
  ok("public: coTechnicians bez odbiorcy", JSON.stringify(d.job?.coTechnicians) === JSON.stringify([`Bartek ${PREFIX}Beta`]), d.job?.coTechnicians);
  ok("public: brak treści notatek", !pub.text.includes(SECRET_NOTE) && !("notes" in (d.job ?? {})), pub.text);
  ok(
    "public: brak kwot i billingu",
    !pub.text.includes("987.65") && !/billing|monthly|price|amount|quote/i.test(pub.text),
    pub.text
  );
  ok("public: brak hasha/tokenu w odpowiedzi", !pub.text.includes(sha(techToken)) && !pub.text.includes(techToken), pub.text);

  const pubGuest = await publicGet(guestToken);
  ok("public gość: wszyscy technicy w coTechnicians", pubGuest.json?.data?.job?.coTechnicians?.length === 2, pubGuest.json?.data?.job);

  await publicGet(techToken);
  const afterOpens = shareRows(ev.id).find((r) => r.tokenHash === sha(techToken));
  ok("licznik otwarć = 2 + last_opened_at", afterOpens?.openCount === 2 && !!afterOpens?.lastOpenedAt, afterOpens);

  // -------------------------------------------------------------------------
  // 5. Jednolite 404
  // -------------------------------------------------------------------------
  const notFoundBody = JSON.stringify({ success: false, error: "Link nieaktywny" });
  const expect404 = async (label: string, token: string) => {
    const r = await publicGet(token);
    ok(`404: ${label}`, r.status === 404 && r.text === notFoundBody, { status: r.status, text: r.text });
    ok(`404 ${label}: nagłówki no-store/no-referrer`, r.headers.get("cache-control") === "no-store" && r.headers.get("referrer-policy") === "no-referrer", null);
  };
  await expect404("zły format", "abc");
  await expect404("nieznany token", "A".repeat(43));

  // Wygasły: przestawiamy expires_at w przeszłość.
  const guestRow = shareRows(ev.id).find((r) => r.tokenHash === sha(guestToken))!;
  db.update(schema.calendarEventShares)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(schema.calendarEventShares.id, guestRow.id))
    .run();
  await expect404("wygasły", guestToken);
  const listExp = await E("GET", `/calendar/events/${ev.id}/shares`);
  ok("lista: status expired", listExp.data?.find((r: any) => r.id === guestRow.id)?.status === "expired", listExp.data);
  ok("wygasły: licznik nie rośnie", shareRows(ev.id).find((r) => r.id === guestRow.id)?.openCount === 1, null);

  // Odwołany.
  const techShareId = forTech.data.share.id as number;
  const del1 = await E("DELETE", `/calendar/events/${ev.id}/shares/${techShareId}`);
  ok("DELETE → 200, status revoked", del1.status === 200 && del1.data?.status === "revoked" && !!del1.data?.revokedAt, del1);
  const del2 = await E("DELETE", `/calendar/events/${ev.id}/shares/${techShareId}`);
  ok("DELETE idempotentny (ten sam revokedAt)", del2.status === 200 && del2.data?.revokedAt === del1.data?.revokedAt, del2);
  ok("activity_log: jeden „Unieważniono link”", shareActivity(ev.id).filter((a) => a.action === "unshared").length === 1, shareActivity(ev.id));
  const delOther = await E("DELETE", `/calendar/events/${oldEv.id}/shares/${techShareId}`);
  ok("DELETE linku z innego wydarzenia → 404", delOther.status === 404, delOther);
  const vDel = await V("DELETE", `/calendar/events/${ev.id}/shares/${techShareId}`);
  ok("view: DELETE → 403", vDel.status === 403, vDel);
  await expect404("odwołany", techToken);

  // Usunięte wydarzenie (soft delete) — świeży link, potem kasujemy wydarzenie.
  const fresh = await E("POST", `/calendar/events/${ev.id}/shares`, { recipientName: "Świeży", expiresIn: "30d" });
  ok("świeży link działa", (await publicGet(fresh.data?.token)).status === 200, fresh);
  db.update(schema.calendarEvents).set({ deletedAt: new Date().toISOString() }).where(eq(schema.calendarEvents.id, ev.id)).run();
  await expect404("wydarzenie usunięte", fresh.data?.token);
  const postDeleted = await E("POST", `/calendar/events/${ev.id}/shares`, { recipientName: "Jan", expiresIn: "24h" });
  ok("POST na usunięte wydarzenie → 409", postDeleted.status === 409, postDeleted);
  db.update(schema.calendarEvents).set({ deletedAt: null }).where(eq(schema.calendarEvents.id, ev.id)).run();

  // Typ notatka: link wstawiony z pominięciem walidacji i tak nie otwiera się.
  const noteToken = "N".repeat(43);
  db.insert(schema.calendarEventShares)
    .values({
      eventId: noteEv.id,
      tokenHash: sha(noteToken),
      recipientName: "Ręczny",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    })
    .run();
  await expect404("typ notatka", noteToken);

  // -------------------------------------------------------------------------
  // 6. Limit per IP
  // -------------------------------------------------------------------------
  sharePublicPerIp.reset();
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await publicGet("A".repeat(43), "203.0.113.9")).status;
  ok("61. żądanie z jednego IP → 429", last === 429, last);
  const otherIp = await publicGet("A".repeat(43), "203.0.113.10");
  ok("inny IP nadal 404", otherIp.status === 404, otherIp.status);
  sharePublicPerIp.reset();

  // =========================================================================
  // ETAP 2 — link „do pracy”
  // =========================================================================
  sharePublicPerIp.reset();
  shareWritePerIp.reset();
  shareWritePerLink.reset();
  shareFilesPerIp.reset();

  const workEv = insertEvent("Praca");
  db.insert(schema.calendarEventAssignees).values([
    { eventId: workEv.id, technicianId: techA.id },
    { eventId: workEv.id, technicianId: techB.id },
  ]).run();
  const OFFICE_NOTE = `${PREFIX} notatka biura do pracy`;
  const officeNote = db
    .insert(schema.calendarEventNotes)
    .values({ eventId: workEv.id, userId: editor.id, userLabel: `${PREFIX}editor`, text: OFFICE_NOTE })
    .returning()
    .get();

  let ipSeq = 0;
  /** Każde żądanie z innego IP — limit per IP testujemy osobno. */
  const freshIp = () => `198.18.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  async function wpub(method: string, path: string, body?: unknown, ip = freshIp()) {
    const headers: Record<string, string> = { "x-real-ip": ip };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const res = await api.request(`/share/${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plik */
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  const badCanWork = await E("POST", `/calendar/events/${workEv.id}/shares`, { recipientName: "X", expiresIn: "24h", canWork: "tak" });
  ok("E2: canWork nie-boolean → 400", badCanWork.status === 400, badCanWork);
  const gW = await E("POST", `/calendar/events/${workEv.id}/shares`, { recipientName: "Pan Gość", expiresIn: "30d", canWork: true });
  ok("E2: POST gość canWork → 201, share.canWork true", gW.status === 201 && gW.data?.share?.canWork === true, gW);
  const tW = await E("POST", `/calendar/events/${workEv.id}/shares`, { technicianId: techA.id, expiresIn: "30d", canWork: true });
  ok("E2: POST technik canWork → 201", tW.status === 201 && tW.data?.share?.canWork === true, tW);
  const rO = await E("POST", `/calendar/events/${workEv.id}/shares`, { recipientName: "Tylko Czyta", expiresIn: "30d" });
  ok("E2: POST bez canWork → canWork false", rO.status === 201 && rO.data?.share?.canWork === false, rO);
  const gTok: string = gW.data?.token;
  const tTok: string = tW.data?.token;
  const rTok: string = rO.data?.token;
  const gId: number = gW.data?.share?.id;

  // --- odczyt
  const g0 = await wpub("GET", gTok);
  const g0d = g0.json?.data ?? {};
  ok("E2: GET flagi canWork/canNotes/canProgress", g0d.canWork === true && g0d.canNotes === true && g0d.canProgress === true && g0d.job?.canProgress === true, g0d);
  ok("E2: GET notes [] i notesCount 0 (notatka biura niewidoczna)", Array.isArray(g0d.notes) && g0d.notes.length === 0 && g0d.job?.notesCount === 0 && !g0.text.includes(OFFICE_NOTE), g0.text);
  const r0 = await wpub("GET", rTok);
  ok("E2: link tylko-podgląd → canWork/canProgress false", r0.json?.data?.canWork === false && r0.json?.data?.canProgress === false && r0.json?.data?.job?.canProgress === false, r0.json?.data);

  // --- notatka JSON gościa
  const n1 = await wpub("POST", `${gTok}/notes`, { text: "Byłem, kamera wisi krzywo" });
  ok("E2: POST notatki → 201", n1.status === 201, n1.text);
  ok(
    "E2: JobNote — dokładny zestaw kluczy",
    Object.keys(n1.json?.data ?? {}).sort().join(",") === "attachments,createdAt,id,mine,source,text,userLabel",
    n1.json?.data
  );
  ok("E2: userLabel = „Pan Gość (link)”, mine true", n1.json?.data?.userLabel === "Pan Gość (link)" && n1.json?.data?.mine === true, n1.json?.data);
  ok("E2: nagłówki zapisu no-store/no-referrer/noindex", n1.headers.get("cache-control") === "no-store" && n1.headers.get("referrer-policy") === "no-referrer" && (n1.headers.get("x-robots-tag") ?? "").includes("noindex"), null);
  const n1Row = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, n1.json?.data?.id ?? -1)).get();
  ok("E2: w DB share_id = link, user_id = twórca", n1Row?.shareId === gId && n1Row?.userId === editor.id, n1Row);
  const addLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, workEv.id), eq(schema.activityLog.action, "note_added")))
    .all();
  ok("E2: activity_log note_added z etykietą „(link)”", addLog.length === 1 && addLog[0].userLabel === "Pan Gość (link)", addLog);

  const tooLongNote = await wpub("POST", `${gTok}/notes`, { text: "x".repeat(4001) });
  ok("E2: notatka > 4000 znaków → 400", tooLongNote.status === 400, tooLongNote.text);
  const emptyNote = await wpub("POST", `${gTok}/notes`, { text: "  " });
  ok("E2: pusta notatka → 400", emptyNote.status === 400, emptyNote.text);

  // --- multipart ze zdjęciem
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
  const fd = new FormData();
  fd.set("text", "Zdjęcie bramy");
  fd.append("files", new File([new Uint8Array(png)], "brama.png", { type: "image/png" }));
  const n2 = await wpub("POST", `${gTok}/notes`, fd);
  const att = n2.json?.data?.attachments?.[0];
  ok("E2: multipart → 201 z załącznikiem", n2.status === 201 && n2.json?.data?.attachments?.length === 1, n2.text);
  ok("E2: url załącznika spod linku", typeof att?.url === "string" && att.url === `/api/share/${gTok}/attachments/${att.id}`, att);
  const file = await api.request(`/share/${gTok}/attachments/${att?.id}`, { headers: { "x-real-ip": freshIp() } });
  ok("E2: GET załącznika → 200 + no-store", file.status === 200 && file.headers.get("cache-control") === "no-store" && (file.headers.get("content-type") ?? "").startsWith("image/"), file.status);
  const fileOther = await wpub("GET", `${tTok}/attachments/${att?.id}`);
  ok("E2: załącznik gościa spod linku technika → 404", fileOther.status === 404, fileOther.text);
  const fileRO = await wpub("GET", `${rTok}/attachments/${att?.id}`);
  ok("E2: załącznik spod linku tylko-podgląd → 404 Link nieaktywny", fileRO.status === 404 && fileRO.json?.error === "Link nieaktywny", fileRO.text);

  // --- technik: osobny link, osobne notatki
  const tn = await wpub("POST", `${tTok}/notes`, { text: "Notatka technika z linku" });
  ok("E2: technik-link: userLabel „Adam … (link)”", tn.status === 201 && tn.json?.data?.userLabel === `Adam ${PREFIX}Alfa (link)`, tn.json);
  const gList = await wpub("GET", gTok);
  ok(
    "E2: gość widzi tylko swoje 2 notatki (nie biura, nie technika)",
    gList.json?.data?.notes?.length === 2 && gList.json?.data?.job?.notesCount === 2 && !gList.text.includes("Notatka technika z linku") && !gList.text.includes(OFFICE_NOTE),
    gList.json?.data?.notes
  );
  const tList = await wpub("GET", tTok);
  ok("E2: technik-link widzi tylko swoją notatkę", tList.json?.data?.notes?.length === 1 && tList.json?.data?.notes?.[0]?.id === tn.json?.data?.id, tList.json?.data?.notes);

  // --- cudze notatki nietykalne
  const putOffice = await wpub("PUT", `${gTok}/notes/${officeNote.id}`, { text: "hack" });
  ok("E2: PUT notatki biura → 404", putOffice.status === 404, putOffice.text);
  const delOffice = await wpub("DELETE", `${gTok}/notes/${officeNote.id}`);
  ok("E2: DELETE notatki biura → 404", delOffice.status === 404, delOffice.text);
  const putTech = await wpub("PUT", `${gTok}/notes/${tn.json?.data?.id}`, { text: "hack" });
  ok("E2: PUT notatki innego linku → 404", putTech.status === 404, putTech.text);
  const delAttOther = await wpub("DELETE", `${tTok}/attachments/${att?.id}`);
  ok("E2: DELETE załącznika innego linku → 404", delAttOther.status === 404, delAttOther.text);
  const officeAfter = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, officeNote.id)).get();
  ok("E2: notatka biura nietknięta", officeAfter?.text === OFFICE_NOTE && officeAfter?.deletedAt == null, officeAfter);
  const otherEvNote = await wpub("PUT", `${gTok}/notes/999999999`, { text: "x" });
  ok("E2: PUT nieistniejącej notatki → 404", otherEvNote.status === 404, otherEvNote.text);

  // --- edycja / usuwanie własnych
  const put1 = await wpub("PUT", `${gTok}/notes/${n1.json?.data?.id}`, { text: "Kamera poprawiona" });
  ok("E2: PUT własnej → 200, nowy tekst", put1.status === 200 && put1.json?.data?.text === "Kamera poprawiona" && put1.json?.data?.mine === true, put1.text);
  const updLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, workEv.id), eq(schema.activityLog.action, "note_updated")))
    .all();
  ok("E2: note_updated z etykietą „(link)”", updLog.length === 1 && updLog[0].userLabel === "Pan Gość (link)", updLog);
  const delAtt = await wpub("DELETE", `${gTok}/attachments/${att?.id}`);
  ok("E2: DELETE własnego załącznika → 200", delAtt.status === 200 && delAtt.json?.data?.id === att?.id, delAtt.text);
  const wdel1 = await wpub("DELETE", `${gTok}/notes/${n1.json?.data?.id}`);
  ok("E2: DELETE własnej → {success:true}", wdel1.status === 200 && wdel1.json?.success === true, wdel1.text);
  const n1After = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, n1.json?.data?.id ?? -1)).get();
  ok("E2: soft delete (deleted_at)", !!n1After?.deletedAt, n1After);
  const wdel1b = await wpub("DELETE", `${gTok}/notes/${n1.json?.data?.id}`);
  ok("E2: DELETE usuniętej → 404", wdel1b.status === 404, wdel1b.text);

  // --- Rozpocznij / Zakończ
  const st = await wpub("POST", `${gTok}/start`, {});
  ok("E2: start → 200, startedAt, status confirmed", st.status === 200 && !!st.json?.data?.startedAt && st.json?.data?.status === "confirmed", st.text);
  ok("E2: start: job bez protokołu, canProgress true", st.json?.data?.protocol === null && st.json?.data?.canProgress === true && st.json?.data?.canProtocol === false, st.json?.data);
  ok(
    "E2: start zwraca `notes` z notatką systemową (front bez ponownego GET)",
    Array.isArray(st.json?.notes) && st.json.notes.some((n: any) => n.source === "system" && /^Rozpoczęto /.test(n.text)),
    st.json?.notes
  );
  const st2 = await wpub("POST", `${gTok}/start`, {});
  ok("E2: drugi start idempotentny", st2.status === 200 && st2.json?.data?.startedAt === st.json?.data?.startedAt && /już/.test(st2.json?.message ?? ""), st2.json);
  const afterStart = (await wpub("GET", gTok)).json?.data;
  const sysNote = afterStart?.notes?.find((n: any) => n.source === "system");
  ok("E2: notatka systemowa „Rozpoczęto … — Pan Gość (link)” w moich", !!sysNote && /^Rozpoczęto .* — Pan Gość \(link\)$/.test(sysNote.text), afterStart?.notes);
  const putSys = await wpub("PUT", `${gTok}/notes/${sysNote?.id}`, { text: "zmiana" });
  ok("E2: PUT wpisu systemowego → 409", putSys.status === 409, putSys.text);
  const fin = await wpub("POST", `${gTok}/finish`, { note: "Wszystko działa" });
  ok("E2: finish → done + finishedAt", fin.status === 200 && fin.json?.data?.status === "done" && !!fin.json?.data?.finishedAt, fin.text);
  const evAfter = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, workEv.id)).get();
  ok("E2: wydarzenie w DB: done, updated_by = twórca", evAfter?.status === "done" && evAfter?.updatedBy === editor.id, evAfter);
  // Stopka „Zmienił …” w CRM: snapshot updated_by_label (0119), nie join po twórcy.
  ok("E2: updated_by_label = „Pan Gość (link)”", evAfter?.updatedByLabel === "Pan Gość (link)", evAfter);
  const evJson = loadEvents(db, [workEv.id])[0];
  ok("E2: CRM updatedByLabel = odbiorca (link), nie twórca", evJson?.updatedByLabel === "Pan Gość (link)", evJson?.updatedByLabel);
  // Zwykła zmiana z CRM zeruje snapshot → etykieta znów z joinu po użytkowniku.
  db.transaction((tx) =>
    moveEvent(tx, workEv.id, {}, { user: { id: editor.id, email: editor.email, displayName: editor.displayName, role: editor.role } })
  );
  const evCrm = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, workEv.id)).get();
  const evCrmJson = loadEvents(db, [workEv.id])[0];
  ok(
    "E2: zmiana z CRM zeruje updated_by_label, etykieta = edytor",
    evCrm?.updatedByLabel === null && evCrmJson?.updatedByLabel === `${PREFIX}editor`,
    { snap: evCrm?.updatedByLabel, label: evCrmJson?.updatedByLabel }
  );
  const fin2 = await wpub("POST", `${gTok}/finish`, {});
  ok("E2: drugi finish idempotentny", fin2.status === 200 && fin2.json?.data?.finishedAt === fin.json?.data?.finishedAt, fin2.json);
  const progLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, workEv.id), eq(schema.activityLog.field, "status")))
    .all();
  ok("E2: zmiana statusu w dzienniku z etykietą „(link)”", progLog.length >= 1 && progLog.every((l) => l.userLabel === "Pan Gość (link)"), progLog);

  // --- brak wycieku twórcy
  const allLinkLogs = db
    .select()
    .from(schema.activityLog)
    .where(
      and(
        eq(schema.activityLog.entityType, "calendar_event"),
        eq(schema.activityLog.entityId, workEv.id),
        inArray(schema.activityLog.action, ["note_added", "note_updated", "note_deleted", "updated", "status_changed"])
      )
    )
    .all();
  ok("E2: wpisy dziennika spod linku bez etykiety twórcy", allLinkLogs.every((l) => l.userLabel !== `${PREFIX}editor`), allLinkLogs);
  const linkNotes = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.shareId, gId)).all();
  ok("E2: notatki linku bez etykiety twórcy", linkNotes.length > 0 && linkNotes.every((n) => n.userLabel !== `${PREFIX}editor`), linkNotes);
  const pubAll = (await wpub("GET", gTok)).text;
  ok("E2: odpowiedź publiczna bez nazwy/emaila twórcy", !pubAll.includes(`${PREFIX}editor`), pubAll);

  // --- tylko podgląd: zapis = 404
  const roNote = await wpub("POST", `${rTok}/notes`, { text: "x" });
  ok("E2: canWork=0: POST notatki → 404 Link nieaktywny", roNote.status === 404 && roNote.json?.error === "Link nieaktywny", roNote.text);
  const roStart = await wpub("POST", `${rTok}/start`, {});
  ok("E2: canWork=0: start → 404", roStart.status === 404, roStart.text);

  // --- PATCH przełącznika
  const vPatch = await V("PATCH", `/calendar/events/${workEv.id}/shares/${gId}`, { canWork: false });
  ok("E2: PATCH z view → 403", vPatch.status === 403, vPatch);
  const badPatch = await E("PATCH", `/calendar/events/${workEv.id}/shares/${gId}`, {});
  ok("E2: PATCH bez canWork → 400", badPatch.status === 400, badPatch);
  const missPatch = await E("PATCH", `/calendar/events/${workEv.id}/shares/999999999`, { canWork: false });
  ok("E2: PATCH nieistniejącego linku → 404", missPatch.status === 404, missPatch);
  const offPatch = await E("PATCH", `/calendar/events/${workEv.id}/shares/${gId}`, { canWork: false });
  ok("E2: PATCH canWork=false → ShareRow canWork false", offPatch.status === 200 && offPatch.data?.canWork === false && offPatch.data?.id === gId && offPatch.data?.status === "active", offPatch);
  const patchLogs = () =>
    db
      .select()
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, workEv.id), eq(schema.activityLog.field, "share_can_work")))
      .all();
  ok("E2: PATCH → wpis „shared” „Pan Gość: tylko podgląd”", patchLogs().length === 1 && patchLogs()[0].action === "shared" && patchLogs()[0].summary === "Pan Gość: tylko podgląd", patchLogs());
  const samePatch = await E("PATCH", `/calendar/events/${workEv.id}/shares/${gId}`, { canWork: false });
  ok("E2: PATCH bez zmiany → 200, bez nowego wpisu", samePatch.status === 200 && patchLogs().length === 1, patchLogs());
  const offNote = await wpub("POST", `${gTok}/notes`, { text: "po wyłączeniu" });
  ok("E2: po wyłączeniu zapis → 404", offNote.status === 404, offNote.text);
  const offGet = (await wpub("GET", gTok)).json?.data;
  ok("E2: po wyłączeniu GET: notes [], canWork false", offGet?.canWork === false && offGet?.notes?.length === 0 && offGet?.job?.notesCount === 0, offGet);
  const onPatch = await E("PATCH", `/calendar/events/${workEv.id}/shares/${gId}`, { canWork: true });
  ok("E2: PATCH canWork=true → wpis „może pracować”", onPatch.data?.canWork === true && patchLogs().some((l) => l.summary === "Pan Gość: może pracować"), patchLogs());
  const onGet = (await wpub("GET", gTok)).json?.data;
  const liveLinkNotes = db
    .select()
    .from(schema.calendarEventNotes)
    .where(and(eq(schema.calendarEventNotes.shareId, gId), isNull(schema.calendarEventNotes.deletedAt)))
    .all().length;
  ok("E2: po ponownym włączeniu notatki wracają (wyłączenie ich nie skasowało)", liveLinkNotes >= 3 && onGet?.notes?.length === liveLinkNotes, { liveLinkNotes, notes: onGet?.notes });
  const shareList = await E("GET", `/calendar/events/${workEv.id}/shares`);
  ok("E2: lista linków z canWork", shareList.data?.every((r: any) => typeof r.canWork === "boolean"), shareList.data);

  // --- odwołane zlecenie → 409
  db.update(schema.calendarEvents).set({ status: "cancelled" }).where(eq(schema.calendarEvents.id, workEv.id)).run();
  const cancNote = await wpub("POST", `${tTok}/notes`, { text: "x" });
  ok("E2: odwołane zlecenie: zapis → 409", cancNote.status === 409, cancNote.text);
  db.update(schema.calendarEvents).set({ status: "confirmed" }).where(eq(schema.calendarEvents.id, workEv.id)).run();

  // --- wygasły / odwołany link przy zapisie
  db.update(schema.calendarEventShares).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.calendarEventShares.id, tW.data?.share?.id)).run();
  const expNote = await wpub("POST", `${tTok}/notes`, { text: "x" });
  ok("E2: wygasły link: zapis → 404", expNote.status === 404 && expNote.json?.error === "Link nieaktywny", expNote.text);
  const expPatch = await E("PATCH", `/calendar/events/${workEv.id}/shares/${tW.data?.share?.id}`, { canWork: false });
  ok("E2: PATCH wygasłego → 409", expPatch.status === 409, expPatch);
  await E("DELETE", `/calendar/events/${workEv.id}/shares/${gId}`);
  const revNote = await wpub("PUT", `${gTok}/notes/${sysNote?.id}`, { text: "x" });
  ok("E2: odwołany link: zapis → 404", revNote.status === 404 && revNote.json?.error === "Link nieaktywny", revNote.text);
  const revPatch = await E("PATCH", `/calendar/events/${workEv.id}/shares/${gId}`, { canWork: true });
  ok("E2: PATCH odwołanego → 409", revPatch.status === 409, revPatch);

  // --- limity zapisów
  const lim = await E("POST", `/calendar/events/${workEv.id}/shares`, { recipientName: "Limit", expiresIn: "30d", canWork: true });
  const limTok: string = lim.data?.token;
  shareWritePerIp.reset();
  shareWritePerLink.reset();
  let lastLink = 0;
  for (let i = 0; i < 31; i++) lastLink = (await wpub("DELETE", `${limTok}/notes/999999999`)).status;
  ok("E2: 31. zapis na jeden link (różne IP) → 429", lastLink === 429, lastLink);
  shareWritePerLink.reset();
  let lastIp = 0;
  for (let i = 0; i < 31; i++) lastIp = (await wpub("DELETE", `${"B".repeat(43)}/notes/1`, undefined, "203.0.113.77")).status;
  ok("E2: 31. zapis z jednego IP → 429", lastIp === 429, lastIp);
  shareWritePerIp.reset();
  shareWritePerLink.reset();

  // =========================================================================
  // „Widzi wszystkie notatki” (see_all_notes, 0120) — niezależne od canWork
  // =========================================================================
  shareWritePerIp.reset();
  shareWritePerLink.reset();
  shareFilesPerIp.reset();
  const seeEv = insertEvent("Wszystkie notatki");
  const SEE_OFFICE = `${PREFIX} notatka biura dla wszystkich`;
  const seeOffice = db
    .insert(schema.calendarEventNotes)
    .values({ eventId: seeEv.id, userId: editor.id, userLabel: "Biuro Testowe", text: SEE_OFFICE })
    .returning()
    .get();
  const mk = async (name: string, canWork: boolean, seeAllNotes?: boolean) => {
    const body: Record<string, unknown> = { recipientName: name, expiresIn: "30d", canWork };
    if (seeAllNotes !== undefined) body.seeAllNotes = seeAllNotes;
    return E("POST", `/calendar/events/${seeEv.id}/shares`, body);
  };
  const badSee = await E("POST", `/calendar/events/${seeEv.id}/shares`, { recipientName: "X", expiresIn: "24h", seeAllNotes: "tak" });
  ok("SA: seeAllNotes nie-boolean → 400", badSee.status === 400, badSee);
  const s00 = await mk("Zero Zero", false, false);
  const s10 = await mk("Jeden Zero", true); // brak seeAllNotes = false
  const s01 = await mk("Zero Jeden", false, true);
  const s11 = await mk("Jeden Jeden", true, true);
  ok(
    "SA: POST — flagi w ShareRow (domyślnie seeAllNotes false)",
    s00.data?.share?.seeAllNotes === false && s10.data?.share?.seeAllNotes === false && s10.data?.share?.canWork === true &&
      s01.data?.share?.seeAllNotes === true && s01.data?.share?.canWork === false && s11.data?.share?.seeAllNotes === true,
    [s00, s10, s01, s11].map((r) => r.data?.share)
  );
  const [t00, t10, t01, t11] = [s00, s10, s01, s11].map((r) => r.data?.token as string);
  const id01: number = s01.data?.share?.id;

  // notatka 1/0 ze zdjęciem, notatka 1/1, wpis systemowy 1/1, „własna” notatka 0/1 (wstawiona w DB)
  const pngS = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 200, b: 10 } } }).png().toBuffer();
  const fdS = new FormData();
  fdS.set("text", "Notatka linku 1/0");
  fdS.append("files", new File([new Uint8Array(pngS)], "a.png", { type: "image/png" }));
  const n10 = await wpub("POST", `${t10}/notes`, fdS);
  const att10 = n10.json?.data?.attachments?.[0];
  ok("SA: 1/0 dodaje notatkę ze zdjęciem", n10.status === 201 && !!att10, n10.text);
  const n11 = await wpub("POST", `${t11}/notes`, { text: "Notatka linku 1/1" });
  ok("SA: 1/1 dodaje notatkę", n11.status === 201 && n11.json?.data?.mine === true, n11.text);
  const sys11 = db
    .insert(schema.calendarEventNotes)
    .values({ eventId: seeEv.id, userId: editor.id, userLabel: "Jeden Jeden (link)", text: "Rozpoczęto o 08:00 — Jeden Jeden (link)", source: "system", shareId: s11.data?.share?.id })
    .returning()
    .get();
  const own01 = db
    .insert(schema.calendarEventNotes)
    .values({ eventId: seeEv.id, userId: editor.id, userLabel: "Zero Jeden (link)", text: "Dawna notatka 0/1", shareId: id01 })
    .returning()
    .get();

  // 0/0 — brak notatek
  const g00 = (await wpub("GET", t00)).json?.data;
  ok("SA: 0/0 → notes [], seeAllNotes false, canNotes false", g00?.notes?.length === 0 && g00?.job?.notesCount === 0 && g00?.seeAllNotes === false && g00?.canNotes === false, g00);
  const f00 = await wpub("GET", `${t00}/attachments/${att10?.id}`);
  ok("SA: 0/0 → załącznik 404", f00.status === 404, f00.text);

  // 1/0 — tylko własne
  const g10 = await wpub("GET", t10);
  ok(
    "SA: 1/0 → tylko własna notatka",
    g10.json?.data?.notes?.length === 1 && g10.json?.data?.notes?.[0]?.id === n10.json?.data?.id && g10.json?.data?.seeAllNotes === false && !g10.text.includes(SEE_OFFICE),
    g10.json?.data?.notes
  );
  const put10Office = await wpub("PUT", `${t10}/notes/${seeOffice.id}`, { text: "x" });
  ok("SA: 1/0 → PUT niewidocznej notatki biura → 404", put10Office.status === 404 && put10Office.json?.error === "Notatka nie istnieje", put10Office.text);

  // 0/1 — wszystkie, tylko odczyt
  const g01 = await wpub("GET", t01);
  const d01 = g01.json?.data;
  const ids01 = new Set((d01?.notes ?? []).map((n: any) => n.id));
  ok(
    "SA: 0/1 → wszystkie notatki (biuro, 1/0, 1/1, systemowa, własna)",
    [seeOffice.id, n10.json?.data?.id, n11.json?.data?.id, sys11.id, own01.id].every((id) => ids01.has(id)) && d01?.job?.notesCount === d01?.notes?.length,
    d01?.notes
  );
  ok("SA: 0/1 → flagi: canWork/canNotes/canProgress false, seeAllNotes true", d01?.canWork === false && d01?.canNotes === false && d01?.canProgress === false && d01?.seeAllNotes === true, d01);
  const office01 = d01?.notes?.find((n: any) => n.id === seeOffice.id);
  ok("SA: 0/1 → notatka biura z podpisem, mine false", office01?.userLabel === "Biuro Testowe" && office01?.mine === false, office01);
  ok("SA: 0/1 → własna notatka linku mine true", d01?.notes?.find((n: any) => n.id === own01.id)?.mine === true, d01?.notes);
  const n10in01 = d01?.notes?.find((n: any) => n.id === n10.json?.data?.id);
  ok("SA: 0/1 → cudzy załącznik z url spod TEGO linku", n10in01?.attachments?.[0]?.url === `/api/share/${t01}/attachments/${att10?.id}`, n10in01);
  const f01 = await api.request(`/share/${t01}/attachments/${att10?.id}`, { headers: { "x-real-ip": freshIp() } });
  ok("SA: 0/1 → GET cudzego załącznika → 200", f01.status === 200, f01.status);
  const add01 = await wpub("POST", `${t01}/notes`, { text: "x" });
  ok("SA: 0/1 → POST notatki → 404 Link nieaktywny", add01.status === 404 && add01.json?.error === "Link nieaktywny", add01.text);
  const put01 = await wpub("PUT", `${t01}/notes/${own01.id}`, { text: "x" });
  ok("SA: 0/1 → PUT nawet własnej → 404 Link nieaktywny", put01.status === 404 && put01.json?.error === "Link nieaktywny", put01.text);
  const start01 = await wpub("POST", `${t01}/start`, {});
  ok("SA: 0/1 → start → 404", start01.status === 404, start01.text);

  // 1/1 — wszystkie, zmiany tylko własnych
  const d11 = (await wpub("GET", t11)).json?.data;
  ok("SA: 1/1 → wszystkie notatki, mine tylko własne", d11?.notes?.length === d01?.notes?.length && d11?.notes?.every((n: any) => n.mine === (n.id === n11.json?.data?.id || n.id === sys11.id)), d11?.notes);
  const put11Office = await wpub("PUT", `${t11}/notes/${seeOffice.id}`, { text: "hack" });
  ok("SA: 1/1 → PUT widocznej notatki biura → 403", put11Office.status === 403, put11Office.text);
  const del11Office = await wpub("DELETE", `${t11}/notes/${seeOffice.id}`);
  ok("SA: 1/1 → DELETE notatki biura → 403", del11Office.status === 403, del11Office.text);
  const put11Other = await wpub("PUT", `${t11}/notes/${n10.json?.data?.id}`, { text: "hack" });
  ok("SA: 1/1 → PUT notatki innego linku → 403", put11Other.status === 403, put11Other.text);
  const delAtt11 = await wpub("DELETE", `${t11}/attachments/${att10?.id}`);
  ok("SA: 1/1 → DELETE cudzego załącznika → 403", delAtt11.status === 403, delAtt11.text);
  const f11 = await api.request(`/share/${t11}/attachments/${att10?.id}`, { headers: { "x-real-ip": freshIp() } });
  ok("SA: 1/1 → GET cudzego załącznika → 200", f11.status === 200, f11.status);
  const put11Sys = await wpub("PUT", `${t11}/notes/${sys11.id}`, { text: "x" });
  ok("SA: 1/1 → PUT własnego wpisu systemowego → 409", put11Sys.status === 409, put11Sys.text);
  const put11Own = await wpub("PUT", `${t11}/notes/${n11.json?.data?.id}`, { text: "Poprawiona 1/1" });
  ok("SA: 1/1 → PUT własnej → 200", put11Own.status === 200 && put11Own.json?.data?.mine === true, put11Own.text);
  const officeSee = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, seeOffice.id)).get();
  const n10Row = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, n10.json?.data?.id ?? -1)).get();
  ok("SA: cudze notatki nietknięte", officeSee?.text === SEE_OFFICE && officeSee?.deletedAt == null && n10Row?.text === "Notatka linku 1/0" && n10Row?.deletedAt == null, { officeSee, n10Row });
  const missing11 = await wpub("PUT", `${t11}/notes/999999999`, { text: "x" });
  ok("SA: 1/1 → PUT nieistniejącej → 404", missing11.status === 404, missing11.text);
  ok("SA: odpowiedź publiczna bez nazwy twórcy", !JSON.stringify(d11).includes(`${PREFIX}editor`), null);

  // PATCH seeAllNotes — niezależnie od canWork
  const seeLogs = () =>
    db
      .select()
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, seeEv.id), eq(schema.activityLog.field, "share_see_all_notes")))
      .all();
  const id10: number = s10.data?.share?.id;
  const badSeePatch = await E("PATCH", `/calendar/events/${seeEv.id}/shares/${id10}`, { seeAllNotes: 1 });
  ok("SA: PATCH seeAllNotes nie-boolean → 400", badSeePatch.status === 400, badSeePatch);
  const onSee = await E("PATCH", `/calendar/events/${seeEv.id}/shares/${id10}`, { seeAllNotes: true });
  ok(
    "SA: PATCH seeAllNotes=true → ShareRow + wpis „widzi wszystkie notatki”, canWork bez zmian",
    onSee.status === 200 && onSee.data?.seeAllNotes === true && onSee.data?.canWork === true && seeLogs().length === 1 && seeLogs()[0].summary === "Jeden Zero: widzi wszystkie notatki",
    { onSee, logs: seeLogs() }
  );
  const g10b = (await wpub("GET", t10)).json?.data;
  ok("SA: po PATCH 1/0 → 1/1 widzi notatkę biura", g10b?.seeAllNotes === true && g10b?.notes?.some((n: any) => n.id === seeOffice.id && n.mine === false), g10b?.notes);
  const sameSee = await E("PATCH", `/calendar/events/${seeEv.id}/shares/${id10}`, { seeAllNotes: true });
  ok("SA: PATCH bez zmiany → bez wpisu", sameSee.status === 200 && seeLogs().length === 1, seeLogs());
  const both = await E("PATCH", `/calendar/events/${seeEv.id}/shares/${id10}`, { canWork: false, seeAllNotes: false });
  const cwLogs = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, seeEv.id), eq(schema.activityLog.field, "share_can_work")))
    .all();
  ok(
    "SA: PATCH obu pól naraz → dwa wpisy",
    both.status === 200 && both.data?.canWork === false && both.data?.seeAllNotes === false &&
      seeLogs().some((l) => l.summary === "Jeden Zero: tylko własne notatki") && cwLogs.some((l) => l.summary === "Jeden Zero: tylko podgląd"),
    { both, seeLogs: seeLogs(), cwLogs }
  );
  const g10c = (await wpub("GET", t10)).json?.data;
  ok("SA: po PATCH → 0/0: notes []", g10c?.notes?.length === 0, g10c);
  const onlySee = await E("PATCH", `/calendar/events/${seeEv.id}/shares/${id10}`, { seeAllNotes: true });
  const g10d = (await wpub("GET", t10)).json?.data;
  ok("SA: PATCH samego seeAllNotes przy canWork=0 → wszystkie, tylko odczyt", onlySee.data?.canWork === false && g10d?.seeAllNotes === true && g10d?.canNotes === false && g10d?.notes?.length >= 5, g10d);
  const vSee = await V("PATCH", `/calendar/events/${seeEv.id}/shares/${id10}`, { seeAllNotes: false });
  ok("SA: PATCH z view → 403", vSee.status === 403, vSee);
  shareWritePerIp.reset();
  shareWritePerLink.reset();
  shareFilesPerIp.reset();
} catch (error) {
  console.error(error);
  failures++;
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWSZYSTKO OK" : `\n${failures} BŁĘD(ÓW)`);
process.exit(failures === 0 ? 0 : 1);
