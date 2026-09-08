/**
 * Test typu wydarzenia „notatka” (kafelek wskazujący notatkę) i wzmianek dat w notatkach
 * na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-note-mentions.ts
 *
 * Sprawdza: parser wzmianek (src/lib/note-mentions.ts), synchronizację kafelków przy
 * addNote/updateNote/deleteNote, ręczne podpięcie notatki, walidacje 400 (bez noteId,
 * własne notatki na kafelku, zmiana typu), wyszukiwarkę notatek, JSON wydarzenia
 * (noteId/noteMention/sourceNote) i notatki (mentions/linkedEventIds), soft delete
 * i przywrócenie wydarzenia źródłowego oraz brak realizacji dla kafelków.
 *
 * Sprząta po sobie HARD (wydarzenia + kafelki + notatki + assignees + activity_log),
 * także przy błędzie.
 */
import { db, schema } from "../src/db/index.js";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  addNote,
  createEvent,
  deleteEvent,
  deleteNote,
  moveEvent,
  noteEventTitle,
  parseInput,
  restoreEvent,
  updateEvent,
  updateNote,
} from "../src/lib/calendar-mutations.js";
import { loadEvent, loadEvents, loadNotes, searchNotes } from "../src/lib/calendar-queries.js";
import { ApiError, BILLING_HIDDEN_TYPES, TYPE_LABELS } from "../src/lib/calendar-labels.js";
import { REALIZATION_FORBIDDEN_TYPES } from "../src/lib/calendar-config.js";
import { addDays, mentionKeys, mentionSuggestions, parseMentions } from "../src/lib/note-mentions.js";
import { zonedToday } from "../src/lib/tz.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__NOTE_MENTIONS_TEST__";
/** Kotwica parsera w testach czystych funkcji: wtorek 08.09.2026. */
const ANCHOR = "2026-09-08";
/** Kotwica synchronizacji — taka sama jak w addNote/updateNote (src/lib/tz.ts). */
const TODAY = zonedToday();

function cleanup() {
  const byTitle = db
    .select({ id: schema.calendarEvents.id, realizationId: schema.calendarEvents.realizationId })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `%${PREFIX}%`))
    .all();
  const ids = new Set(byTitle.map((r) => r.id));
  // Kafelki wskazujące notatki wydarzeń testowych (gdyby tytuł się rozjechał).
  const noteIds = ids.size
    ? db.select({ id: schema.calendarEventNotes.id }).from(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, [...ids])).all().map((r) => r.id)
    : [];
  if (noteIds.length) {
    for (const r of db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(inArray(schema.calendarEvents.noteId, noteIds)).all()) ids.add(r.id);
  }
  const all = [...ids];
  // Realizacje (+ protokoły, wyceny) powstałe automatycznie — jak w scripts/test-notes.ts.
  const realIds = byTitle.map((r) => r.realizationId).filter((x): x is number => x != null);
  for (const r of db.select({ id: schema.realizations.id }).from(schema.realizations).where(sql`${schema.realizations.note} LIKE ${`%${PREFIX}%`}`).all()) realIds.push(r.id);
  if (realIds.length) {
    db.delete(schema.protocols).where(inArray(schema.protocols.realizationId, realIds)).run();
    const quoteIds = db.select({ id: schema.quotes.id }).from(schema.quotes).where(inArray(schema.quotes.realizationId, realIds)).all().map((q) => q.id);
    if (quoteIds.length) {
      db.update(schema.calendarEvents).set({ quoteId: null }).where(inArray(schema.calendarEvents.quoteId, quoteIds)).run();
      db.delete(schema.quotes).where(inArray(schema.quotes.id, quoteIds)).run();
    }
    db.delete(schema.realizations).where(inArray(schema.realizations.id, realIds)).run();
  }
  if (all.length) {
    // Notatki przed wydarzeniami: kafelki wskazują je przez note_id (ON DELETE SET NULL).
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, all)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, all)).run();
    db.delete(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, all))).run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, all)).run();
  }
  return all.length;
}
cleanup();

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const other = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !other) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");
const objectId = db.select({ id: schema.objects.id }).from(schema.objects).limit(1).get()?.id ?? null;

function insertEvent(title: string, startAt: string, endAt: string) {
  return db
    .insert(schema.calendarEvents)
    .values({ type: "serwis", title: `${PREFIX} ${title}`, startAt, endAt, allDay: false, status: "planned", department: "technical", objectId, createdBy: admin.id, updatedBy: admin.id })
    .returning()
    .get();
}
const tiles = (noteId: number) =>
  db.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.noteId, noteId), eq(schema.calendarEvents.type, "notatka"))).orderBy(schema.calendarEvents.startAt).all();
const liveTiles = (noteId: number) => tiles(noteId).filter((t) => t.deletedAt == null);
const logs = (id: number) => db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, id))).all();
const catchErr = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
const is400 = (e: unknown, re?: RegExp) => e instanceof ApiError && e.status === 400 && (!re || re.test(e.message));

try {
  // =========================================================================
  // 1. Parser wzmianek (czysta funkcja, kotwica 08.09.2026 = wtorek)
  // =========================================================================
  const p = (t: string) => parseMentions(t, ANCHOR);
  ok("parser: @jutro → +1 dzień", p("@jutro")[0]?.date === "2026-09-09" && p("@jutro")[0].key === "jutro");
  ok("parser: @dziś → kotwica, key dzis", p("Zrobić @dziś")[0]?.date === ANCHOR && p("Zrobić @dziś")[0].key === "dzis");
  ok("parser: @pojutrze → +2", p("@pojutrze")[0]?.date === "2026-09-10");
  ok("parser: „@piątek w piątek” = 1 wzmianka (bez @ nie liczy się)", p("@piątek w piątek").length === 1 && p("@piątek w piątek")[0].date === "2026-09-11");
  ok("parser: @piatek == @piątek (klucz bez ogonków)", p("@piatek")[0]?.key === "piatek" && p("@piatek")[0].date === "2026-09-11");
  ok("parser: dzień tygodnia to NAJBLIŻSZY po kotwicy (wtorek @wtorek → za tydzień)", p("@wtorek")[0]?.date === "2026-09-15");
  ok("parser: @pon → poniedziałek, klucz pełny", p("@pon")[0]?.key === "poniedzialek" && p("@pon")[0].date === "2026-09-14");
  ok("parser: e-mail nie jest wzmianką", p("napisz na jan@example.com").length === 0, p("napisz na jan@example.com"));
  ok("parser: @Jan (nieznany token) pomijany", p("@Jan przyjedzie").length === 0);
  ok("parser: @31.02 (data nieistniejąca) pomijana", p("@31.02").length === 0);
  ok("parser: @2026-02-30 pomijana", p("@2026-02-30").length === 0);
  ok("parser: @15.09 → bieżący rok, klucz 15.09", p("@15.09")[0]?.date === "2026-09-15" && p("@15.09")[0].key === "15.09");
  ok("parser: @01.08 (>30 dni wstecz) → następny rok", p("@01.08")[0]?.date === "2027-08-01");
  ok("parser: @2026-09-15 / @15.09.2026 / @15.09.26 → ten sam klucz i data",
    ["@2026-09-15", "@15.09.2026", "@15.09.26"].every((s) => p(s)[0]?.key === "2026-09-15" && p(s)[0].date === "2026-09-15"));
  ok("parser: interpunkcja na końcu odcięta", p("Zadzwonić @piątek.")[0]?.raw === "@piątek");
  ok("parser: pozycje start/end wskazują token", (() => { const m = p("Zadzwonić @piątek."); return m[0]?.start === 10 && "Zadzwonić @piątek.".slice(m[0].start, m[0].end) === "@piątek"; })());
  ok("parser: etykieta „piątek 11.09”", p("@piątek")[0]?.label === "piątek 11.09");
  ok("parseMentions zwraca powtórki, mentionKeys deduplikuje", p("@piątek @piatek").length === 2 && mentionKeys("@piątek @piatek", ANCHOR).size === 1);
  ok("mentionSuggestions: prefiks „pi” → piątek z datą", mentionSuggestions("pi", ANCHOR).map((s) => s.token).join() === "piątek" && mentionSuggestions("pi", ANCHOR)[0].date === "2026-09-11");
  ok("addDays: arytmetyka kalendarzowa", addDays("2026-12-31", 1) === "2027-01-01");

  // =========================================================================
  // 2. Etykiety / wykluczenia typu
  // =========================================================================
  ok("TYPE_LABELS.notatka = „Notatka”", TYPE_LABELS.notatka === "Notatka");
  ok("BILLING_HIDDEN_TYPES zawiera notatka", BILLING_HIDDEN_TYPES.includes("notatka"));
  ok("REALIZATION_FORBIDDEN_TYPES zawiera notatka", REALIZATION_FORBIDDEN_TYPES.includes("notatka"));

  // =========================================================================
  // 3. Synchronizacja wzmianek: addNote
  // =========================================================================
  const src = insertEvent("Serwis źródłowy", `${TODAY}T09:00`, `${TODAY}T11:00`);
  const jutro = addDays(TODAY, 1);
  const pojutrze = addDays(TODAY, 2);
  const text1 = `${PREFIX} zadzwonić @jutro i dokończyć @pojutrze`;
  const n1 = db.transaction((tx) => addNote(tx, { eventId: src.id, text: text1, ctx: { user: admin } }));
  let t1 = liveTiles(n1.id);
  ok("addNote: 2 wzmianki → 2 kafelki", t1.length === 2, t1.map((t) => ({ id: t.id, s: t.startAt, m: t.noteMention })));
  ok("kafelek: typ/allDay/1 dzień/status/department", t1.every((t) => t.type === "notatka" && t.allDay && t.endAt === addDays(t.startAt, 1) && t.status === "planned" && t.department === "technical"), t1);
  ok("kafelek: daty ze wzmianek (jutro, pojutrze)", t1.map((t) => t.startAt).join() === [jutro, pojutrze].sort().join(), t1.map((t) => t.startAt));
  ok("kafelek: note_id + note_mention (klucz wzmianki)", t1.every((t) => t.noteId === n1.id) && t1.map((t) => t.noteMention).sort().join() === ["jutro", "pojutrze"].sort().join(), t1.map((t) => t.noteMention));
  ok("kafelek: objectId/orderId ze źródła, location/billing/seria/realizacja puste",
    t1.every((t) => t.objectId === src.objectId && t.orderId === src.orderId && t.location === null && t.billing === null && t.seriesId === null && t.realizationId === null), t1);
  ok("kafelek: tytuł „Notatka: <treść>”", t1.every((t) => t.title === noteEventTitle({ text: text1 }, src) && t.title.startsWith(`Notatka: ${PREFIX} zadzwonić`)), t1.map((t) => t.title));
  ok("kafelek: brak techników", db.select().from(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, t1.map((t) => t.id))).all().length === 0);
  ok("kafelek: wpis „created” w activity_log ze wzmianką", logs(t1[0].id).some((l) => l.action === "created" && /wzmianki/.test(l.summary ?? "")), logs(t1[0].id).map((l) => l.summary));
  ok("kafelek: bez realizacji (typ zabroniony)", loadEvent(db, t1[0].id)?.realization === null && loadEvent(db, t1[0].id)?.realizationId === null);

  // JSON notatki: mentions + linkedEventIds
  const notes1 = loadNotes(db, src.id);
  ok("Note JSON: mentions [{raw,key,date,label,eventId}] z żywymi kafelkami",
    notes1[0].mentions.length === 2 &&
      notes1[0].mentions.every((m) => typeof m.raw === "string" && typeof m.key === "string" && typeof m.date === "string" && typeof m.label === "string" && typeof m.eventId === "number") &&
      notes1[0].mentions.map((m) => m.eventId).sort().join() === t1.map((t) => t.id).sort().join(),
    notes1[0].mentions);
  ok("Note JSON: linkedEventIds = wszystkie żywe kafelki", notes1[0].linkedEventIds.slice().sort().join() === t1.map((t) => t.id).sort().join(), notes1[0].linkedEventIds);
  ok("addNote zwraca Note z mentions/linkedEventIds", n1.mentions.length === 2 && n1.linkedEventIds.length === 2, { m: n1.mentions.length, l: n1.linkedEventIds.length });

  // JSON wydarzenia: sourceNote
  const tileJson = loadEvent(db, t1[0].id)!;
  ok("Event JSON: noteId/noteMention", tileJson.noteId === n1.id && tileJson.noteMention === t1[0].noteMention, { noteId: tileJson.noteId, noteMention: tileJson.noteMention });
  ok("Event JSON: sourceNote {id,eventId,eventTitle,eventStartAt,eventType,text,userLabel,source,createdAt,attachmentsCount}",
    !!tileJson.sourceNote &&
      tileJson.sourceNote.id === n1.id &&
      tileJson.sourceNote.eventId === src.id &&
      tileJson.sourceNote.eventTitle === src.title &&
      tileJson.sourceNote.eventStartAt === src.startAt &&
      tileJson.sourceNote.eventType === "serwis" &&
      tileJson.sourceNote.text === text1 &&
      tileJson.sourceNote.userLabel === n1.userLabel &&
      tileJson.sourceNote.source === "user" &&
      typeof tileJson.sourceNote.createdAt === "string" &&
      tileJson.sourceNote.attachmentsCount === 0,
    tileJson.sourceNote);
  ok("Event JSON: zwykłe wydarzenie ma sourceNote = null i noteId = null", (() => { const e = loadEvent(db, src.id)!; return e.sourceNote === null && e.noteId === null && e.noteMention === null; })());

  // =========================================================================
  // 4. updateNote: klucz zostaje (nawet po przeciągnięciu), znika, dochodzi
  // =========================================================================
  const jutroTile = t1.find((t) => t.noteMention === "jutro")!;
  const pojutrzeTile = t1.find((t) => t.noteMention === "pojutrze")!;
  const draggedTo = addDays(TODAY, 5);
  db.transaction((tx) => moveEvent(tx, jutroTile.id, { startAt: draggedTo }, { user: admin }));
  const dragged = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, jutroTile.id)).get()!;
  ok("PATCH /move na kafelku: zmienia dzień, zostaje allDay i 1 dzień", dragged.startAt === draggedTo && dragged.endAt === addDays(draggedTo, 1) && dragged.allDay, dragged);

  const text2 = `${PREFIX} zadzwonić @jutro, a potem @15.09`;
  const n1b = db.transaction((tx) => updateNote(tx, n1.id, text2, { user: admin }));
  const t2 = liveTiles(n1.id);
  const key1509 = mentionKeys(text2, TODAY);
  ok("updateNote: kafelek z zachowanym kluczem ZOSTAJE (bez cofania przeciągnięcia)",
    t2.some((t) => t.id === jutroTile.id && t.startAt === draggedTo), t2.map((t) => ({ id: t.id, s: t.startAt, m: t.noteMention })));
  ok("updateNote: kafelek po skasowanej wzmiance → soft delete", tiles(n1.id).find((t) => t.id === pojutrzeTile.id)?.deletedAt != null);
  ok("updateNote: nowa wzmianka → nowy kafelek na jej dacie",
    t2.some((t) => t.noteMention === "15.09" && t.startAt === key1509.get("15.09")), t2.map((t) => ({ m: t.noteMention, s: t.startAt })));
  ok("updateNote: 2 żywe kafelki", t2.length === 2, t2.length);
  ok("updateNote: tytuły kafelków odświeżone", t2.every((t) => t.title === noteEventTitle({ text: text2 }, src)), t2.map((t) => t.title));
  ok("updateNote zwraca mentions z eventId i linkedEventIds", n1b.mentions.length === 2 && n1b.mentions.every((m) => m.eventId != null) && n1b.linkedEventIds.length === 2, n1b.mentions);
  ok("activity_log: usunięcie kafelka opisane wzmianką", logs(pojutrzeTile.id).some((l) => l.action === "deleted" && /wzmianka/.test(l.summary ?? "")), logs(pojutrzeTile.id).map((l) => l.summary));

  // Tytuł z długiej treści przycięty do ~60 znaków
  const longText = `${PREFIX} ${"a".repeat(120)} @jutro`;
  const nLong = db.transaction((tx) => addNote(tx, { eventId: src.id, text: longText, ctx: { user: admin } }));
  const longTile = liveTiles(nLong.id)[0];
  ok("tytuł kafelka z długiej notatki przycięty (60 znaków + …)", longTile.title === noteEventTitle({ text: longText }, src) && longTile.title.length <= 70 && longTile.title.endsWith("…"), longTile.title);
  db.transaction((tx) => deleteNote(tx, nLong.id, { user: admin }));

  // =========================================================================
  // 5. Ręczne podpięcie notatki (POST /events z type=notatka, noteId)
  // =========================================================================
  const manualDay = addDays(TODAY, 10);
  const manualInput = parseInput({ type: "notatka", noteId: n1.id, startAt: manualDay, title: "ignorowany", technicianIds: [1], billing: "paid", allDay: false, endAt: addDays(manualDay, 9), recurrence: { freq: "weekly" }, objectId: 999999, location: "ignorowana" });
  ok("parseInput notatka: wymusza allDay/1 dzień, zeruje techników, billing, serię, lokalizację",
    manualInput.allDay && manualInput.startAt === manualDay && manualInput.endAt === addDays(manualDay, 1) && manualInput.technicianIds.length === 0 && manualInput.billing === null && manualInput.recurrence === null && manualInput.location === null && manualInput.objectId === null && manualInput.noteId === n1.id,
    manualInput);
  const manual = db.transaction((tx) => createEvent(tx, manualInput, { user: admin }));
  const manualRow = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, manual.firstId)).get()!;
  ok("createEvent notatka: kafelek ręczny (note_mention = NULL), tytuł z notatki, obiekt ze źródła",
    manualRow.type === "notatka" && manualRow.noteMention === null && manualRow.noteId === n1.id && manualRow.title === noteEventTitle({ text: text2 }, src) && manualRow.objectId === src.objectId && manual.seriesId === null && manual.occurrencesCount === 1,
    manualRow);
  ok("createEvent notatka: linkedEventIds zawiera kafelek ręczny", loadNotes(db, src.id).find((n) => n.id === n1.id)!.linkedEventIds.includes(manualRow.id));

  // Synchronizacja nie rusza kafelków ręcznych
  const text3 = `${PREFIX} bez wzmianek`;
  db.transaction((tx) => updateNote(tx, n1.id, text3, { user: admin }));
  const t3 = liveTiles(n1.id);
  ok("sync: brak wzmianek → kafelki ze wzmianek znikają, ręczny zostaje", t3.length === 1 && t3[0].id === manualRow.id, t3.map((t) => ({ id: t.id, m: t.noteMention })));
  ok("sync: mentions puste, linkedEventIds nadal z ręcznym kafelkiem", (() => { const n = loadNotes(db, src.id).find((x) => x.id === n1.id)!; return n.mentions.length === 0 && n.linkedEventIds.join() === String(manualRow.id); })());

  // =========================================================================
  // 6. Walidacje 400
  // =========================================================================
  ok("parseInput: notatka bez noteId → 400", is400(catchErr(() => parseInput({ type: "notatka", startAt: TODAY })), /noteId/));
  ok("createEvent: noteId nieistniejącej notatki → 400",
    is400(catchErr(() => db.transaction((tx) => createEvent(tx, parseInput({ type: "notatka", noteId: 99999999, startAt: TODAY }), { user: admin }))), /nie istnieje/));
  ok("addNote na kafelku notatki → 400 „nie może mieć własnych notatek”",
    is400(catchErr(() => db.transaction((tx) => addNote(tx, { eventId: manualRow.id, text: "x", ctx: { user: admin } }))), /własnych notatek/));
  ok("updateEvent: zmiana typu notatka → serwis = 400",
    is400(catchErr(() => db.transaction((tx) => updateEvent(tx, manualRow.id, parseInput({ type: "serwis", title: `${PREFIX} podmiana`, startAt: `${TODAY}T09:00`, endAt: `${TODAY}T10:00` }), "this", { user: admin }))), /notatka/));
  ok("updateEvent: zmiana typu serwis → notatka = 400",
    is400(catchErr(() => db.transaction((tx) => updateEvent(tx, src.id, parseInput({ type: "notatka", noteId: n1.id, startAt: TODAY }), "this", { user: admin }))), /notatka/));

  // PUT na kafelku: dzień + status
  const putDay = addDays(TODAY, 12);
  db.transaction((tx) => updateEvent(tx, manualRow.id, parseInput({ type: "notatka", noteId: n1.id, startAt: putDay, status: "done" }), "this", { user: admin }));
  const afterPut = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, manualRow.id)).get()!;
  ok("PUT na kafelku: zmienia dzień i status, zachowuje notatkę i 1-dniowość",
    afterPut.startAt === putDay && afterPut.endAt === addDays(putDay, 1) && afterPut.status === "done" && afterPut.noteId === n1.id && afterPut.allDay,
    afterPut);
  ok("PUT na kafelku: nadal bez realizacji", afterPut.realizationId === null);

  // =========================================================================
  // 7. Wyszukiwarka notatek (GET /calendar/notes/search)
  // =========================================================================
  const other1 = db.transaction((tx) => addNote(tx, { eventId: src.id, text: `${PREFIX} druga notatka do wyszukania`, ctx: { user: other } }));
  const found = searchNotes(db, PREFIX, 50);
  ok("searchNotes: znajduje notatki testowe (od najnowszej)", found.length >= 2 && found[0].id === other1.id, found.map((f) => f.id));
  ok("searchNotes: kształt {id,eventId,eventTitle,eventStartAt,eventType,text,userLabel,createdAt,attachmentsCount}",
    (() => { const f = found[0]; return Object.keys(f).sort().join() === ["attachmentsCount", "createdAt", "eventId", "eventStartAt", "eventTitle", "eventType", "id", "text", "userLabel"].join() && f.eventId === src.id && f.eventTitle === src.title && f.eventType === "serwis" && f.attachmentsCount === 0; })(),
    found[0]);
  ok("searchNotes: szuka też po tytule wydarzenia", searchNotes(db, "Serwis źródłowy", 50).some((f) => f.id === n1.id));
  ok("searchNotes: bez rozróżniania wielkości liter", searchNotes(db, "serwis ŹRÓDŁOWY".toLowerCase(), 50).some((f) => f.id === n1.id));
  ok("searchNotes: limit", searchNotes(db, PREFIX, 1).length === 1);
  ok("searchNotes: nie zwraca notatek kafelków (kafelek notatek nie ma)", found.every((f) => f.eventType !== "notatka"));

  // =========================================================================
  // 8. Soft delete / restore wydarzenia źródłowego i notatki
  // =========================================================================
  const text4 = `${PREFIX} przypomnieć @jutro`;
  db.transaction((tx) => updateNote(tx, n1.id, text4, { user: admin }));
  const beforeDelete = liveTiles(n1.id).map((t) => t.id).sort();
  ok("przed usunięciem: 2 żywe kafelki (ręczny + ze wzmianki)", beforeDelete.length === 2, beforeDelete);
  db.transaction((tx) => deleteEvent(tx, src.id, "this", { user: admin }));
  ok("deleteEvent źródła: kafelki notatek też soft-deleted", liveTiles(n1.id).length === 0, tiles(n1.id).map((t) => ({ id: t.id, d: t.deletedAt })));
  ok("deleteEvent: wpis w dzienniku kafelka wskazuje źródło", logs(beforeDelete[0]).some((l) => l.action === "deleted" && /źródłowe/.test(l.summary ?? "")), logs(beforeDelete[0]).map((l) => l.summary));
  db.transaction((tx) => restoreEvent(tx, src.id, { user: admin }));
  ok("restoreEvent źródła: kafelki wracają", liveTiles(n1.id).map((t) => t.id).sort().join() === beforeDelete.join(), liveTiles(n1.id).map((t) => t.id));

  db.transaction((tx) => deleteNote(tx, n1.id, { user: admin }));
  ok("deleteNote: wszystkie kafelki (także ręczny) soft-deleted", liveTiles(n1.id).length === 0, tiles(n1.id).map((t) => ({ id: t.id, m: t.noteMention, d: t.deletedAt })));
  ok("deleteNote: notatka znika z wyszukiwarki", !searchNotes(db, PREFIX, 50).some((f) => f.id === n1.id));
  ok("deleteNote: kafelki znikają z listy wydarzeń (deleted_at)", loadEvents(db, tiles(n1.id).map((t) => t.id)).every((e) => e.deletedAt != null));

  // notatki usuniętego wydarzenia nie wchodzą do wyszukiwarki
  db.transaction((tx) => deleteEvent(tx, src.id, "this", { user: admin }));
  ok("searchNotes: pomija notatki usuniętych wydarzeń", !searchNotes(db, PREFIX, 50).some((f) => f.eventId === src.id), searchNotes(db, PREFIX, 50));
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}
console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
