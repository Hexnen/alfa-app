/**
 * Test notatek wydarzeń (calendar_event_notes) na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-notes.ts
 * Sprawdza: addNote/updateNote/deleteNote (+ activity_log note_added/note_updated/note_deleted),
 * uprawnienia (autor vs inny user vs admin), notesCount w loadEvents (lista) i loadEvent,
 * propose_changes kind note + status done z note + cancel → notatka zamiast description, apply
 * (source assistant, etykieta „Asystent (…)”, dopisek „(przez asystenta)”), get_event → notes/notesCount.
 * Sprząta po sobie HARD (events + assignees + notes + activity_log), także przy błędzie.
 */
import { db, schema } from "../src/db/index.js";
import { and, eq, inArray, like } from "drizzle-orm";
import { buildCalendarTools } from "../src/lib/ai/calendarTools.js";
import { applyChange, resolveChange, type ResolvedChange } from "../src/lib/ai/calendarChanges.js";
import { ASSISTANT_DEFAULTS } from "../src/lib/ai/assistantConfig.js";
import { addNote, deleteNote, updateNote } from "../src/lib/calendar-mutations.js";
import { loadEvent, loadEvents, loadNotes, listActiveTechnicians } from "../src/lib/calendar-queries.js";
import { ApiError } from "../src/lib/calendar-labels.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const PREFIX = "__NOTES_TEST__";
const TODAY = "2026-08-27";

function cleanup() {
  const ids = db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).all().map((r) => r.id);
  if (ids.length) {
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, ids)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, ids)).run();
    db.delete(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, ids))).run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, ids)).run();
  }
  return ids.length;
}
cleanup();

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const other = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !other) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");
const [t1] = listActiveTechnicians().filter((t) => t.active).map((t) => t.id);
if (!t1) throw new Error("Test wymaga aktywnego technika");
const objectId = db.select({ id: schema.objects.id }).from(schema.objects).limit(1).get()?.id ?? null;

function insertEvent(title: string, startAt: string, endAt: string, description: string | null = null) {
  const ev = db
    .insert(schema.calendarEvents)
    .values({ type: "serwis", title: `${PREFIX} ${title}`, startAt, endAt, allDay: false, status: "planned", department: "technical", objectId, description, createdBy: admin.id, updatedBy: admin.id })
    .returning()
    .get();
  db.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: t1 }).run();
  return ev.id;
}
const logs = (id: number) => db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, id))).all();
const opts = { toolCallId: "t", messages: [] as never[] };
const exec = (t: unknown, input: unknown) => (t as { execute: (i: unknown, o: typeof opts) => Promise<unknown> }).execute(input, opts);
const cfg = { ...ASSISTANT_DEFAULTS, allowModifications: true };

try {
  const evA = insertEvent("Serwis A", `${TODAY}T09:00`, `${TODAY}T11:00`, "Stały opis A");
  const evB = insertEvent("Serwis B", `${TODAY}T13:00`, `${TODAY}T15:00`);

  // --- add / update / delete + activity_log ---
  const n1 = db.transaction((tx) => addNote(tx, { eventId: evA, text: "  Pierwsza notatka\nz nową linią  ", ctx: { user: other } }));
  ok("addNote: kształt Note", n1.id > 0 && n1.eventId === evA && n1.userId === other.id && n1.source === "user" && n1.text === "Pierwsza notatka\nz nową linią" && typeof n1.createdAt === "string" && typeof n1.updatedAt === "string", n1);
  ok("addNote: userLabel = displayName||email", n1.userLabel === ((other.displayName || "").trim() || other.email), n1.userLabel);
  const n2 = db.transaction((tx) => addNote(tx, { eventId: evA, text: "Druga (admin)", ctx: { user: admin } }));
  ok("loadNotes: 2 notatki, od najstarszej", loadNotes(db, evA).map((n) => n.id).join() === `${n1.id},${n2.id}`);
  ok("activity_log note_added ×2 (summary „Dodano notatkę: …”)", logs(evA).filter((l) => l.action === "note_added" && /^Dodano notatkę: /.test(l.summary ?? "")).length === 2, logs(evA));

  let err: unknown = null;
  try { db.transaction((tx) => addNote(tx, { eventId: evA, text: "   ", ctx: { user: admin } })); } catch (e) { err = e; }
  ok("addNote: pusta treść → 400", err instanceof ApiError && err.status === 400, err);
  err = null;
  try { db.transaction((tx) => addNote(tx, { eventId: evA, text: "x".repeat(4001), ctx: { user: admin } })); } catch (e) { err = e; }
  ok("addNote: >4000 znaków → 400", err instanceof ApiError && err.status === 400, err);
  err = null;
  try { db.transaction((tx) => addNote(tx, { eventId: 99999999, text: "x", ctx: { user: admin } })); } catch (e) { err = e; }
  ok("addNote: nieistniejący event → 404", err instanceof ApiError && err.status === 404, err);

  // uprawnienia: autor OK, inny user (nie admin) 403, admin OK
  err = null;
  try { db.transaction((tx) => updateNote(tx, n2.id, "hack", { user: other })); } catch (e) { err = e; }
  ok("updateNote: inny user (nie autor) → 403", err instanceof ApiError && err.status === 403, err);
  const n1b = db.transaction((tx) => updateNote(tx, n1.id, "Pierwsza — poprawiona", { user: other }));
  ok("updateNote: autor edytuje", n1b.text === "Pierwsza — poprawiona" && n1b.id === n1.id, n1b);
  const n1c = db.transaction((tx) => updateNote(tx, n1.id, "Pierwsza — admin", { user: admin }));
  ok("updateNote: admin edytuje cudzą", n1c.text === "Pierwsza — admin", n1c);
  ok("activity_log note_updated ×2", logs(evA).filter((l) => l.action === "note_updated").length === 2, logs(evA).map((l) => l.action));
  err = null;
  try { db.transaction((tx) => deleteNote(tx, n2.id, { user: other })); } catch (e) { err = e; }
  ok("deleteNote: inny user → 403", err instanceof ApiError && err.status === 403, err);
  db.transaction((tx) => deleteNote(tx, n2.id, { user: admin }));
  ok("deleteNote: soft (deleted_at) + zniknęła z loadNotes", loadNotes(db, evA).length === 1 && db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, n2.id)).get()?.deletedAt != null);
  ok("activity_log note_deleted", logs(evA).some((l) => l.action === "note_deleted" && /^Usunięto notatkę: Druga/.test(l.summary ?? "")));
  err = null;
  try { db.transaction((tx) => updateNote(tx, n2.id, "x", { user: admin })); } catch (e) { err = e; }
  ok("updateNote: usunięta → 404", err instanceof ApiError && err.status === 404, err);
  err = null;
  try { db.transaction((tx) => deleteNote(tx, n2.id, { user: admin })); } catch (e) { err = e; }
  ok("deleteNote: już usunięta → 404", err instanceof ApiError && err.status === 404, err);

  // --- notesCount ---
  const list = loadEvents(db, [evA, evB]);
  ok("loadEvents: notesCount (A=1, B=0)", list[0].notesCount === 1 && list[1].notesCount === 0, list.map((e) => e.notesCount));
  ok("loadEvent: notesCount", loadEvent(db, evA)?.notesCount === 1);

  // --- asystent: propose_changes note / status done + note / cancel ---
  const tools = buildCalendarTools(admin, cfg);
  const out = (await exec(tools.propose_changes, {
    changes: [
      { kind: "note", eventId: evA, text: "Klient prosi o fakturę zbiorczą" },
      { kind: "status", eventId: evB, status: "done", actualEndAt: "16:00", note: "Wymieniono 2 kamery" },
      { kind: "cancel", eventId: evA, reason: "klient odwołał" },
      { kind: "note", eventId: 99999999, text: "x" },
      { kind: "status", eventId: evB, status: "confirmed" },
    ],
  })) as { changes: ResolvedChange[]; errors: number };
  const c = out.changes;
  ok("[0] note: kind/diff Notatka/summary/note, before=after, description nietknięty", c[0].kind === "note" && c[0].diff.length === 1 && c[0].diff[0].field === "Notatka" && c[0].diff[0].from === "" && c[0].diff[0].to === "Klient prosi o fakturę zbiorczą" && /^Notatka: /.test(c[0].summary) && c[0].note === "Klient prosi o fakturę zbiorczą" && c[0].after?.description === "Stały opis A" && !c[0].error, c[0]);
  ok("[1] done + note → notatka „Przebieg 27.08: Wykonano 13:00–16:00 (plan 13:00–15:00). Wymieniono 2 kamery”, opis bez zmian", c[1].note === "Przebieg 27.08: Wykonano 13:00–16:00 (plan 13:00–15:00). Wymieniono 2 kamery" && c[1].after?.description === null && c[1].diff.some((d) => d.field === "Notatka") && c[1].diff.some((d) => d.field === "Status"), c[1]);
  ok("[2] cancel → note „Anulowano: klient odwołał”, opis bez zmian", c[2].note === "Anulowano: klient odwołał" && c[2].after?.description === "Stały opis A" && c[2].after?.status === "cancelled", c[2]);
  ok("[3] note na nieistniejący → error", typeof c[3].error === "string" && /nie istnieje/.test(c[3].error), c[3]);
  ok("[4] status bez note → bez pola note", c[4].note === undefined && !c[4].error, c[4]);
  ok("errors = 1", out.errors === 1, out.errors);

  // apply note
  const a0 = applyChange({ kind: "note", eventId: evA, text: "Klient prosi o fakturę zbiorczą" }, 0, { cfg, today: TODAY }, { user: admin });
  const notesA = loadNotes(db, evA);
  ok("applyChange note: notatka source=assistant, „Asystent (Mikołaj)”, notesCount=2", a0.event.notesCount === 2 && notesA.length === 2 && notesA[1].source === "assistant" && notesA[1].userId === admin.id && notesA[1].userLabel === `Asystent (${(admin.displayName || "").trim() || admin.email})` && notesA[1].text === "Klient prosi o fakturę zbiorczą", notesA);
  ok("applyChange note: description bez zmian", a0.event.description === "Stały opis A");
  ok("activity_log note_added „(przez asystenta)”", logs(evA).some((l) => l.action === "note_added" && /Klient prosi o fakturę zbiorczą \(przez asystenta\)$/.test(l.summary ?? "")), logs(evA).map((l) => l.summary));
  // apply done + note
  const a1 = applyChange({ kind: "status", eventId: evB, status: "done", actualEndAt: "16:00", note: "Wymieniono 2 kamery" }, 1, { cfg, today: TODAY }, { user: admin });
  const notesB = loadNotes(db, evB);
  ok("applyChange done: status/endAt + 1 notatka Przebieg, description null", a1.event.status === "done" && a1.event.endAt === `${TODAY}T16:00` && a1.event.description === null && notesB.length === 1 && /^Przebieg 27\.08: Wykonano 13:00–16:00 \(plan 13:00–15:00\)\. Wymieniono 2 kamery$/.test(notesB[0].text) && notesB[0].source === "assistant", { event: a1.event, notesB });
  // done ponownie z samą notatką (status już done) → tylko notatka, bez błędu „nie zmienia”
  const r2 = resolveChange(db, { kind: "status", eventId: evB, status: "done", note: "Dodatkowo: sprawdzono zasilanie" }, 0, { cfg, today: TODAY });
  ok("done na już done + note → tylko diff Notatka (bez błędu)", !r2.resolved.error && r2.resolved.diff.length === 1 && r2.resolved.diff[0].field === "Notatka", r2.resolved);
  // apply cancel
  applyChange({ kind: "cancel", eventId: evA, reason: "klient odwołał" }, 2, { cfg, today: TODAY }, { user: admin });
  ok("applyChange cancel: notatka „Anulowano: …”, opis zachowany", loadNotes(db, evA).some((n) => n.text === "Anulowano: klient odwołał" && n.source === "assistant") && loadEvent(db, evA)?.description === "Stały opis A" && loadEvent(db, evA)?.status === "cancelled");

  // get_event → notes / notesCount; search/list brief → notesCount
  const g = (await exec(tools.get_event, { eventId: evA })) as { event: { notesCount: number; notes: { userLabel: string | null; createdAt: string; text: string | null }[]; description: string | null } };
  ok("get_event: notesCount=3 + notes[{userLabel,createdAt,text}]", g.event.notesCount === 3 && g.event.notes.length === 3 && g.event.notes.every((n) => typeof n.createdAt === "string" && "userLabel" in n && typeof n.text === "string") && g.event.notes[2].text === "Anulowano: klient odwołał", g.event);
  for (let i = 0; i < 12; i++) db.transaction((tx) => addNote(tx, { eventId: evB, text: `Notatka ${i} ${"y".repeat(400)}`, ctx: { user: admin } }));
  const g2 = (await exec(tools.get_event, { eventId: evB })) as { event: { notesCount: number; notes: { text: string | null }[] } };
  ok("get_event: max 10 ostatnich notatek, tekst ≤300, notesCount=13", g2.event.notesCount === 13 && g2.event.notes.length === 10 && g2.event.notes.every((n) => (n.text ?? "").length <= 300) && /^Notatka 11/.test(g2.event.notes[9].text ?? ""), { count: g2.event.notesCount, n: g2.event.notes.length });
  const s = (await exec(tools.search_events, { query: PREFIX, includeCancelled: true })) as { events: { id: number; notesCount: number }[] };
  ok("search_events brief: notesCount", s.events.find((e) => e.id === evB)?.notesCount === 13 && s.events.find((e) => e.id === evA)?.notesCount === 3, s.events);
  const l = (await exec(tools.list_events, { from: TODAY, to: "2026-08-28" })) as { events: { id: number; notesCount: number }[] };
  ok("list_events brief: notesCount", l.events.find((e) => e.id === evB)?.notesCount === 13, l.events.filter((e) => e.id === evB));

  // kaskada: hard delete eventu usuwa notatki (FK cascade)
  db.delete(schema.calendarEventAssignees).where(eq(schema.calendarEventAssignees.eventId, evB)).run();
  db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, evB)).run();
  ok("FK cascade: notatki usuniętego eventu znikają", db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.eventId, evB)).all().length === 0);
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}
console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
