/**
 * Test narzędzia propose_changes / resolveChange / applyChange na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-assistant-changes.ts
 * Tworzy tymczasowe wydarzenia (prefix __ASST_CHG__) i sprawdza: update (przesunięcie z zachowaniem
 * długości, diff, kolizje), status done z faktycznymi godzinami + notatką, cancel, delete, restore,
 * create (przeszłość → status podsumowania dnia), błędy (nieistniejący event, technik, done w przyszłości,
 * usunięty event), seria (warning), apply (activity_log z dopiskiem „(przez asystenta)”), allowModifications=false.
 * Sprząta po sobie HARD (events + assignees + activity_log + series), także przy błędzie.
 */
import { db, schema } from "../src/db/index.js";
import { and, eq, inArray, like } from "drizzle-orm";
import { buildCalendarTools } from "../src/lib/ai/calendarTools.js";
import { applyChange, resolveChange, type ResolvedChange } from "../src/lib/ai/calendarChanges.js";
import { ASSISTANT_DEFAULTS } from "../src/lib/ai/assistantConfig.js";
import { assembleSystemPrompt } from "../src/lib/ai/calendarPrompt.js";
import { listActiveTechnicians } from "../src/lib/calendar-queries.js";
import { ApiError } from "../src/lib/calendar-labels.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const PREFIX = "__ASST_CHG__";
const TODAY = "2026-08-27";
const YESTERDAY = "2026-08-26";

/** Hard delete wydarzeń testowych (+ assignees, activity_log, serie). */
function cleanup() {
  const ids = db.select({ id: schema.calendarEvents.id, seriesId: schema.calendarEvents.seriesId }).from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).all();
  const eventIds = ids.map((r) => r.id);
  const seriesIds = [...new Set(ids.map((r) => r.seriesId).filter((x): x is number => x != null))];
  if (eventIds.length) {
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    db.delete(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds))).run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  if (seriesIds.length) db.delete(schema.calendarSeries).where(inArray(schema.calendarSeries.id, seriesIds)).run();
  return eventIds.length;
}
cleanup();

const user = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
if (!user) throw new Error("Brak admina w bazie");
const techs = listActiveTechnicians().filter((t) => t.active);
const [t1, t2] = techs.map((t) => t.id);
if (!t1 || !t2) throw new Error("Test wymaga 2 aktywnych techników");
const objectId = db.select({ id: schema.objects.id }).from(schema.objects).limit(1).get()?.id ?? null;

const opts = { toolCallId: "t", messages: [] as never[] };
type Exec = (input: unknown, o: typeof opts) => Promise<unknown>;
const exec = (t: unknown, input: unknown) => (t as { execute: Exec }).execute(input, opts);

function insertEvent(v: { title: string; startAt: string; endAt: string; allDay?: boolean; type?: "serwis" | "urlop" | "montaz"; status?: "planned" | "done"; techs?: number[]; seriesId?: number | null; description?: string | null; deleted?: boolean }) {
  const ev = db
    .insert(schema.calendarEvents)
    .values({
      type: v.type ?? "serwis",
      title: `${PREFIX} ${v.title}`,
      startAt: v.startAt,
      endAt: v.endAt,
      allDay: v.allDay ?? false,
      status: v.status ?? "planned",
      department: "technical",
      objectId: v.type === "urlop" ? null : objectId,
      seriesId: v.seriesId ?? null,
      description: v.description ?? null,
      createdBy: user.id,
      updatedBy: user.id,
      deletedAt: v.deleted ? "2026-08-01 10:00:00" : null,
    })
    .returning()
    .get();
  for (const tid of v.techs ?? [t1]) db.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: tid }).run();
  return ev.id;
}
const logs = (id: number) => db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, id))).all();

try {
  // Dane: serwis dziś 09–11 (t1), montaż dziś 13–15 (t2), kolizja jutro 10–12 (t1), usunięty, seria (2 wystąpienia), urlop
  const evServ = insertEvent({ title: "Serwis Magazyn", startAt: `${TODAY}T09:00`, endAt: `${TODAY}T11:00`, techs: [t1], description: "Plan serwisu" });
  const evMont = insertEvent({ title: "Montaż Testowy", startAt: `${TODAY}T13:00`, endAt: `${TODAY}T15:00`, type: "montaz", techs: [t2] });
  const evBusy = insertEvent({ title: "Zajęty jutro", startAt: "2026-08-28T10:00", endAt: "2026-08-28T12:00", techs: [t1] });
  const evDel = insertEvent({ title: "Usunięty", startAt: "2026-08-20T10:00", endAt: "2026-08-20T12:00", deleted: true });
  const series = db.insert(schema.calendarSeries).values({ freq: "monthly", interval: 1, createdBy: user.id }).returning().get();
  const evSer1 = insertEvent({ title: "Seria 1", startAt: "2026-09-10T08:00", endAt: "2026-09-10T10:00", seriesId: series.id, type: "montaz" });
  insertEvent({ title: "Seria 2", startAt: "2026-10-10T08:00", endAt: "2026-10-10T10:00", seriesId: series.id, type: "montaz" });
  const evUrlop = insertEvent({ title: "Urlop", startAt: "2026-09-14", endAt: "2026-09-19", allDay: true, type: "urlop", techs: [t1] });
  const evFuture = insertEvent({ title: "Przyszłość", startAt: "2026-09-20T10:00", endAt: "2026-09-20T12:00" });

  const cfg = { ...ASSISTANT_DEFAULTS };
  const tools = buildCalendarTools(user, cfg);
  ok("buildCalendarTools: propose_changes + get_event dostępne", "propose_changes" in tools && "get_event" in tools);
  const toolsOff = buildCalendarTools(user, { ...cfg, allowModifications: false });
  ok("allowModifications=false → brak propose_changes (get_event zostaje)", !("propose_changes" in toolsOff) && "get_event" in toolsOff);
  const promptOn = assembleSystemPrompt({ today: TODAY, weekday: "czwartek", user: { displayName: "T" }, technicians: techs, rules: cfg });
  const promptOff = assembleSystemPrompt({ today: TODAY, weekday: "czwartek", user: { displayName: "T" }, technicians: techs, rules: { ...cfg, allowModifications: false } });
  ok("prompt: sekcja Modyfikacje przy allowModifications", /## Modyfikacje/.test(promptOn) && /PODSUMOWANIE DNIA/.test(promptOn) && /propose_changes/.test(promptOn));
  ok("prompt: bez sekcji przy allowModifications=false", /## Modyfikacje istniejących wydarzeń \(wyłączone\)/.test(promptOff) && !/podsumowanie dnia/i.test(promptOff) && !/propose_changes/.test(promptOff));

  // get_event
  const g = (await exec(tools.get_event, { eventId: evServ })) as { event?: { id: number; description: string; technicianIds: number[] }; error?: string };
  ok("get_event: pełny event z opisem i technicianIds", g.event?.id === evServ && g.event?.description === "Plan serwisu" && g.event?.technicianIds[0] === t1, g);
  const g2 = (await exec(tools.get_event, { eventId: 99999999 })) as { error?: string };
  ok("get_event: nieistniejący → error", typeof g2.error === "string", g2);

  // ask_choice z eventId
  const ac = (await exec(tools.ask_choice, { question: "Które?", options: [{ label: "A", eventId: evServ }, { label: "B", eventId: evMont }] })) as { options: { eventId?: number }[] };
  ok("ask_choice: eventId w opcjach", ac.options[0].eventId === evServ && ac.options[1].eventId === evMont, ac);
  const ac2 = (await exec(tools.ask_choice, { question: "?", options: [{ label: "A", eventId: 99999999 }, { label: "B" }] })) as { error?: string };
  ok("ask_choice: nieistniejący eventId → error", typeof ac2.error === "string", ac2);

  // propose_changes — paczka (update/status/cancel/delete/restore/create + błędy)
  const out = (await exec(tools.propose_changes, {
    note: "test",
    changes: [
      { kind: "update", eventId: evServ, patch: { startAt: "2026-08-28T10:00" }, reason: "przełożone" }, // 0: przesunięcie, kolizja z evBusy (t1)
      { kind: "status", eventId: evMont, status: "done", actualEndAt: "16:00", note: "wymienił 2 kamery" }, // 1
      { kind: "cancel", eventId: evServ, reason: "klient nie wpuścił" }, // 2
      { kind: "delete", eventId: evMont }, // 3
      { kind: "restore", eventId: evDel }, // 4
      { kind: "create", event: { type: "wizja", title: "Wizja — Rondo", startAt: `${YESTERDAY}T15:00`, endAt: `${YESTERDAY}T16:00`, technicianIds: [t2] } }, // 5: przeszłość → done
      { kind: "update", eventId: 99999999, patch: { title: "X" } }, // 6: brak
      { kind: "update", eventId: evServ, patch: { technicianIds: [99999999] } }, // 7: zły technik
      { kind: "status", eventId: evFuture, status: "done" }, // 8: done w przyszłości
      { kind: "update", eventId: evSer1, patch: { startAt: "2026-09-11T08:00" } }, // 9: seria → warning
      { kind: "update", eventId: evDel, patch: { title: "Y" } }, // 10: usunięty
      { kind: "update", eventId: evServ, patch: { title: `${PREFIX} Serwis Magazyn` } }, // 11: bez zmian
      { kind: "update", eventId: evServ, patch: { technicianIds: [t1, t2], status: "confirmed" } }, // 12: technicy +t2 (kolizja z evMont dla t2? 09–11 vs 13–15 nie)
      { kind: "create", event: { type: "serwis", title: "Przyszły", startAt: "2026-09-21T10:00", technicianIds: [t1] } }, // 13: przyszłość → defaultStatus
    ],
  })) as { needsConfirmation: boolean; changes: ResolvedChange[]; count: number; errors: number; note?: string };
  ok("propose_changes: needsConfirmation + count + note", out.needsConfirmation === true && out.count === 14 && out.note === "test", { count: out.count });
  const c = out.changes;
  const diffOf = (r: ResolvedChange, f: string) => r.diff.find((d) => d.field === f);
  ok("[0] update startAt bez endAt → przesunięcie 2h z zachowaniem długości", c[0].after?.startAt === "2026-08-28T10:00" && c[0].after?.endAt === "2026-08-28T12:00", c[0].after);
  ok("[0] diff Termin PL", diffOf(c[0], "Termin")?.from === "27.08.2026 09:00–11:00" && diffOf(c[0], "Termin")?.to === "28.08.2026 10:00–12:00", c[0].diff);
  ok("[0] warning kolizja z evBusy", c[0].warnings.some((w) => /Kolizja/.test(w) && w.includes("Zajęty jutro")), c[0].warnings);
  ok("[0] summary zawiera powód", /przełożone/.test(c[0].summary), c[0].summary);
  ok("[1] done + actualEndAt HH:MM → endAt 16:00, status done", c[1].after?.endAt === `${TODAY}T16:00` && c[1].after?.status === "done" && c[1].after?.startAt === `${TODAY}T13:00`, c[1].after);
  ok("[1] opis bez zmian + note: „Przebieg 27.08: Wykonano 13:00–16:00 (plan 13:00–15:00). wymienił 2 kamery”", c[1].after?.description === c[1].before?.description && c[1].note === "Przebieg 27.08: Wykonano 13:00–16:00 (plan 13:00–15:00). wymienił 2 kamery" && diffOf(c[1], "Notatka")?.to === c[1].note, { note: c[1].note, description: c[1].after?.description });
  ok("[1] diff Status Zaplanowane → Wykonane", diffOf(c[1], "Status")?.from === "Zaplanowane" && diffOf(c[1], "Status")?.to === "Wykonane", c[1].diff);
  ok("[2] cancel → status cancelled + powód jako notatka (opis bez zmian)", c[2].after?.status === "cancelled" && c[2].after?.description === "Plan serwisu" && c[2].note === "Anulowano: klient nie wpuścił", c[2].after);
  ok("[3] delete → after.deleted", c[3].after?.deleted === true && c[3].before?.deleted === false && !c[3].error, c[3]);
  ok("[4] restore → after.deleted=false", c[4].after?.deleted === false && c[4].before?.deleted === true && !c[4].error, c[4]);
  ok("[5] create w przeszłości → status done (daySummaryDefaultStatus), before brak", c[5].after?.status === "done" && c[5].before === undefined && c[5].after?.id === null, c[5]);
  ok("[6] nieistniejący event → error", typeof c[6].error === "string" && /nie istnieje/.test(c[6].error), c[6]);
  ok("[7] zły technik → error", typeof c[7].error === "string" && /Technik #99999999/.test(c[7].error), c[7]);
  ok("[8] done w przyszłości → error", typeof c[8].error === "string" && /przyszłości/.test(c[8].error), c[8]);
  ok("[9] seria → warning o wystąpieniu", !c[9].error && c[9].warnings.some((w) => /serii/.test(w)), c[9]);
  ok("[10] usunięty event → error (tylko restore)", typeof c[10].error === "string" && /usunięte/.test(c[10].error), c[10]);
  ok("[11] patch bez zmian → error", typeof c[11].error === "string" && /nie zmienia/.test(c[11].error), c[11]);
  ok("[12] technicy: diff Technicy + Status", diffOf(c[12], "Technicy") != null && diffOf(c[12], "Status")?.to === "Potwierdzone" && c[12].after?.technicianIds.length === 2, c[12]);
  ok("[13] create w przyszłości → defaultStatus, endAt +2h", c[13].after?.status === cfg.defaultStatus && c[13].after?.endAt === "2026-09-21T12:00", c[13]);
  ok("errors = 5", out.errors === 5, out.errors);
  ok("każda pozycja ma index/kind/summary/warnings", c.every((r, i) => r.index === i && typeof r.kind === "string" && typeof r.summary === "string" && Array.isArray(r.warnings)));

  // urlop: cancel
  const u = resolveChange(db, { kind: "cancel", eventId: evUrlop, reason: "odwołany" }, 0, { cfg, today: TODAY });
  ok("cancel urlopu → cancelled, bez kolizji", u.resolved.after?.status === "cancelled" && u.resolved.warnings.length === 0 && u.op?.kind === "update", u.resolved);

  // apply: status done → activity_log z dopiskiem, description, godziny
  const a1 = applyChange({ kind: "status", eventId: evMont, status: "done", actualStartAt: "13:30", actualEndAt: "16:00", note: "wymienił 2 kamery" }, 1, { cfg, today: TODAY }, { user });
  ok("applyChange done: event po zapisie", a1.event.status === "done" && a1.event.startAt === `${TODAY}T13:30` && a1.event.endAt === `${TODAY}T16:00` && a1.event.description == null && a1.event.notesCount === 1, a1.event);
  const n1 = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.eventId, evMont)).all();
  ok("applyChange done: notatka source=assistant, „Asystent (…)”, Przebieg", n1.length === 1 && n1[0].source === "assistant" && /^Asystent \(/.test(n1[0].userLabel ?? "") && /^Przebieg 27\.08: Wykonano 13:30–16:00 \(plan 13:00–15:00\)\. wymienił 2 kamery$/.test(n1[0].text), n1);
  const l1 = logs(evMont);
  ok("activity_log: moved + status_changed + note_added, wszystkie z „(przez asystenta)”", l1.length >= 3 && l1.every((l) => /\(przez asystenta\)$/.test(l.summary ?? "")) && l1.some((l) => l.action === "status_changed") && l1.some((l) => l.action === "moved") && l1.some((l) => l.action === "note_added"), l1.map((l) => `${l.action}: ${l.summary}`));
  // apply: update przesunięcie + technicy
  const a2 = applyChange({ kind: "update", eventId: evServ, patch: { startAt: "2026-08-28T14:00", technicianIds: [t1, t2] } }, 0, { cfg, today: TODAY }, { user });
  ok("applyChange update: przesunięte + 2 techników", a2.event.startAt === "2026-08-28T14:00" && a2.event.endAt === "2026-08-28T16:00" && a2.event.technicians.length === 2, a2.event);
  ok("activity_log: assigned z dopiskiem", logs(evServ).some((l) => l.action === "assigned" && /\(przez asystenta\)$/.test(l.summary ?? "")), logs(evServ));
  // apply: delete → restore
  const a3 = applyChange({ kind: "delete", eventId: evServ }, 0, { cfg, today: TODAY }, { user });
  ok("applyChange delete: deletedAt ustawiony", a3.event.deletedAt != null, a3.event);
  let threw: string | null = null;
  try {
    applyChange({ kind: "delete", eventId: evServ }, 0, { cfg, today: TODAY }, { user });
  } catch (e) {
    threw = e instanceof ApiError ? e.message : String(e);
  }
  ok("applyChange delete usuniętego → ApiError", threw != null && /usunięte/.test(threw), threw);
  const a4 = applyChange({ kind: "restore", eventId: evServ }, 0, { cfg, today: TODAY }, { user });
  ok("applyChange restore: deletedAt null + log restored", a4.event.deletedAt == null && logs(evServ).some((l) => l.action === "restored" && /\(przez asystenta\)$/.test(l.summary ?? "")), a4.event);
  // apply: create → nowy event z prefixem (sprzątany)
  const a5 = applyChange({ kind: "create", event: { type: "wizja", title: `${PREFIX} Wizja Rondo`, startAt: `${YESTERDAY}T15:00`, endAt: `${YESTERDAY}T16:00`, technicianIds: [t2] } }, 5, { cfg, today: TODAY }, { user });
  ok("applyChange create: nowy event done z technikiem, log created z dopiskiem", a5.event.status === "done" && a5.event.technicians[0]?.id === t2 && logs(a5.eventId).some((l) => l.action === "created" && /\(przez asystenta\)$/.test(l.summary ?? "")), a5.event);
  // apply: seria → tylko to wystąpienie
  applyChange({ kind: "update", eventId: evSer1, patch: { startAt: "2026-09-11T08:00" } }, 0, { cfg, today: TODAY }, { user });
  const sib = db.select({ startAt: schema.calendarEvents.startAt }).from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX} Seria 2`)).get();
  ok("seria: sibling nietknięty (scope this)", sib?.startAt === "2026-10-10T08:00", sib);
  // Trasy kalendarza (bez asystenta) — bez dopisku
  const l0 = db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, evBusy))).all();
  ok("event bez mutacji asystenta: brak wpisów", l0.length === 0, l0);
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}
console.log(failures ? `\n${failures} błędów` : "\nWszystkie testy OK");
process.exit(failures ? 1 : 0);
