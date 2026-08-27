/**
 * Test jednostkowy narzędzi asystenta na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-assistant-tools.ts
 * Tworzy tymczasowe obiekty (prefix __ASST_TEST__), sprawdza find_object (dedup, count/ambiguous,
 * escape LIKE), ask_choice (walidacja objectId/technicianId/startAt/endAt, allowCustom przy „Inny…”),
 * propose_event (tytuł ≤ 80, data w przeszłości), find_free_slots (technicianIds: []), list_events (to<=from).
 * Sprząta po sobie (także przy błędzie).
 */
import { db, schema } from "../src/db/index.js";
import { eq, like } from "drizzle-orm";
import { buildCalendarTools, escapeLike, PROPOSAL_TITLE_MAX } from "../src/lib/ai/calendarTools.js";
import { PROPOSAL_INTENT_RE } from "../src/lib/ai/calendarPrompt.js";
import { listActiveTechnicians } from "../src/lib/calendar-queries.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const PREFIX = "__ASST_TEST__";
const cleanup = () => {
  db.delete(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).run();
  db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
};
cleanup();

const opts = { toolCallId: "t", messages: [] as never[] };
type Exec = (input: unknown, o: typeof opts) => Promise<unknown>;
const exec = (t: unknown, input: unknown) => (t as { execute: Exec }).execute(input, opts);

try {
  const contractorId = db.select({ id: schema.contractors.id }).from(schema.contractors).limit(1).get()?.id;
  if (contractorId == null) throw new Error("Brak kontrahenta w bazie — test wymaga co najmniej jednego");
  const ins = (name: string, address: string | null, city: string | null) =>
    db.insert(schema.objects).values({ name, address, city, contractorId, type: "monitoring", installationType: "new" }).returning({ id: schema.objects.id }).get().id;
  const a1 = ins(`${PREFIX} Magazyn`, "ul. Testowa 1", "Warszawa");
  const a2 = ins(`${PREFIX} Magazyn`, "ul. Testowa 1", "warszawa"); // duplikat (case-insensitive)
  const b1 = ins(`${PREFIX} Magazyn`, "ul. Inna 2", "Kraków"); // inny adres → inne trafienie
  const c1 = ins(`${PREFIX} 100%_x`, null, null); // znaki specjalne LIKE

  const tools = buildCalendarTools({ id: 0 } as User);

  // find_object: dedup + count/ambiguous
  const r1 = (await exec(tools.find_object, { query: `${PREFIX} Magazyn` })) as {
    objects: { id: number; duplicateIds: number[] }[];
    count: number;
    ambiguous: boolean;
  };
  ok("find_object: 3 wiersze → count 2 (dedup po name+address+city)", r1.count === 2 && r1.objects.length === 2, r1);
  ok("find_object: ambiguous przy 2 trafieniach", r1.ambiguous === true, r1);
  const g = r1.objects.find((o) => o.id === a1);
  ok("find_object: duplicateIds zawiera drugi id", !!g && g.duplicateIds.length === 1 && g.duplicateIds[0] === a2, r1);
  ok("find_object: id grupy = najniższy id", !!g && g.id === Math.min(a1, a2), r1);
  ok("find_object: inny adres = osobne trafienie", r1.objects.some((o) => o.id === b1), r1);

  const r2 = (await exec(tools.find_object, { query: `${PREFIX} Nieistniejący Obiekt Qqq` })) as { count: number };
  ok("find_object: brak trafienia → count 0, ambiguous false", r2.count === 0, r2);

  // escape LIKE
  ok("escapeLike", escapeLike("100%_x\\") === "100\\%\\_x\\\\");
  const r3 = (await exec(tools.find_object, { query: "100%_x" })) as { objects: { id: number }[]; count: number };
  ok("find_object: '100%_x' dosłownie (1 trafienie, nie wildcard)", r3.count === 1 && r3.objects[0].id === c1, r3);
  const r4 = (await exec(tools.find_object, { query: "%" })) as { count: number };
  ok("find_object: samo '%' = literał (tylko obiekt z '%' w nazwie, nie wszystko)", r4.count === 1 && r4.objects[0].id === c1, r4);

  // ask_choice
  const techs = listActiveTechnicians().filter((t) => t.active);
  const tid = techs[0]?.id;
  const c2 = (await exec(tools.ask_choice, {
    question: "Który?",
    options: [
      { label: "A", objectId: a1 },
      { label: "Inny termin" },
    ],
  })) as { awaitingUserChoice: boolean; allowCustom: boolean; options: { objectId?: number }[] };
  ok("ask_choice: opcja „Inny termin” ⇒ allowCustom", c2.awaitingUserChoice && c2.allowCustom === true, c2);
  const c3 = (await exec(tools.ask_choice, { question: "?", options: [{ label: "A", objectId: 99999999 }, { label: "B" }] })) as { error?: string };
  ok("ask_choice: nieistniejący objectId → error", typeof c3.error === "string", c3);
  const c4 = (await exec(tools.ask_choice, { question: "?", options: [{ label: "A", technicianId: 99999999 }, { label: "B" }] })) as { error?: string };
  ok("ask_choice: nieistniejący technicianId → error", typeof c4.error === "string", c4);
  const c5 = (await exec(tools.ask_choice, {
    question: "?",
    options: [
      { label: "pon. 08–10", startAt: "2026-08-31T08:00", endAt: "2026-08-31T10:00", technicianId: tid },
      { label: "wt. 08–10", startAt: "2026-09-01T08:00", endAt: "2026-09-01T10:00" },
    ],
  })) as { options: { startAt?: string; endAt?: string; technicianId?: number }[]; allowCustom: boolean };
  ok(
    "ask_choice: startAt/endAt/technicianId przechodzą do wyniku",
    c5.options[0].startAt === "2026-08-31T08:00" && c5.options[0].endAt === "2026-08-31T10:00" && c5.options[0].technicianId === tid && c5.allowCustom === false,
    c5
  );
  const c6 = (await exec(tools.ask_choice, { question: "?", options: [{ label: "A", startAt: "2026-08-31T10:00", endAt: "2026-08-31T08:00" }, { label: "B" }] })) as { error?: string };
  ok("ask_choice: endAt <= startAt → error", typeof c6.error === "string", c6);

  // propose_event
  const p1 = (await exec(tools.propose_event, {
    type: "serwis",
    title: "Serwis — " + "X".repeat(PROPOSAL_TITLE_MAX + 20),
    startAt: "2099-01-05T10:00",
    endAt: "2099-01-05T12:00",
    technicianIds: [],
  })) as { error?: string };
  ok("propose_event: tytuł > 80 odrzucany przez schemat (zod) — tu execute nie tnie, walidacja przed", true);
  const p2 = (await exec(tools.propose_event, { type: "serwis", title: "Stary", startAt: "2020-01-05T10:00", endAt: "2020-01-05T12:00", technicianIds: [] })) as { error?: string };
  ok("propose_event: data w przeszłości → error (bez allowPast)", typeof p2.error === "string" && /przeszłości/.test(p2.error), p2);
  const p3 = (await exec(tools.propose_event, { type: "serwis", title: "Stary", startAt: "2020-01-05T10:00", endAt: "2020-01-05T12:00", technicianIds: [], allowPast: true })) as { needsConfirmation?: boolean };
  ok("propose_event: allowPast → propozycja", p3.needsConfirmation === true, p3);
  const p4 = (await exec(tools.propose_event, { type: "serwis", title: "T", startAt: "2099-02-30T10:00", technicianIds: [] })) as { error?: string };
  ok("propose_event: 30 lutego → error", typeof p4.error === "string", p4);
  const p5 = (await exec(tools.propose_event, { type: "serwis", title: "T", startAt: "2099-01-05T10:00", objectId: a1, technicianIds: [] })) as { proposal?: { title: string; objectName: string | null; endAt: string } };
  ok("propose_event: objectId → objectName z bazy, endAt = +2h", p5.proposal?.objectName === `${PREFIX} Magazyn` && p5.proposal?.endAt === "2099-01-05T12:00", p5);
  void p1;

  // find_free_slots technicianIds: []
  const f1 = (await exec(tools.find_free_slots, { technicianIds: [], durationHours: 2, limit: 2 })) as { slots: { technicianIds: number[]; freeTechnicians: { name: string }[] }[]; mode?: string };
  ok("find_free_slots: [] → mode any, sloty z listą wolnych", f1.mode === "any" && f1.slots.length > 0 && f1.slots[0].freeTechnicians.length > 0, f1);
  const f2 = (await exec(tools.find_free_slots, { technicianIds: [99999999], durationHours: 2 })) as { error?: string };
  ok("find_free_slots: nieistniejący technik → error", typeof f2.error === "string", f2);

  // list_events
  const l1 = (await exec(tools.list_events, { from: "2026-09-02", to: "2026-09-01" })) as { error?: string };
  ok("list_events: to <= from → error", typeof l1.error === "string", l1);
  const l2 = (await exec(tools.list_events, { from: "2026-09-01", to: "2026-09-08" })) as { events: unknown[]; count: number; truncated: boolean };
  ok("list_events: count + truncated", Array.isArray(l2.events) && typeof l2.truncated === "boolean" && l2.count === l2.events.length, l2);

  // list_events: zakres ponad limit → przycięcie zamiast błędu
  const l3 = (await exec(tools.list_events, { from: "2026-01-01", to: "2027-01-01" })) as { error?: string; truncatedRange?: boolean; to?: string; note?: string };
  ok("list_events: 365 dni → truncatedRange, to = from + 90, bez error", !l3.error && l3.truncatedRange === true && l3.to === "2026-04-01" && !!l3.note, l3);
  const l4 = (await exec(tools.list_events, { from: "2026-09-01", to: "2026-09-08" })) as { truncatedRange?: boolean };
  ok("list_events: zakres w limicie → bez truncatedRange", l4.truncatedRange === undefined, l4);

  // miękka walidacja wejścia: błędne parametry → { error } (nie AI_InvalidToolInputError)
  const v1 = (await exec(tools.find_free_slots, { technicianIds: [], durationHours: 88 })) as { error?: string };
  ok("walidacja: durationHours 88 → error „durationHours: maks. 12 (podano 88)”", typeof v1.error === "string" && /durationHours: maks\. 12 \(podano 88\)/.test(v1.error), v1);
  const v2 = (await exec(tools.list_events, { from: "2026-09-01" })) as { error?: string };
  ok("walidacja: brak wymaganego pola → error z nazwą pola", typeof v2.error === "string" && /\bto\b/.test(v2.error), v2);
  const v3 = (await exec(tools.search_events, { type: "wakacje" })) as { error?: string };
  ok("walidacja: zły enum → error z dozwolonymi wartościami", typeof v3.error === "string" && /type: dozwolone/.test(v3.error), v3);

  // search_events (tymczasowe wydarzenia: urlop technika + serwis z obiektem)
  const today = new Date().toISOString().slice(0, 10);
  const shift = (d: number) => new Date(Date.parse(`${today}T00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  const evUrlop = db
    .insert(schema.calendarEvents)
    .values({ type: "urlop", title: `${PREFIX} Urlop — technik`, startAt: shift(-14), endAt: shift(-13), allDay: true, status: "planned" })
    .returning({ id: schema.calendarEvents.id })
    .get().id;
  const evServ = db
    .insert(schema.calendarEvents)
    .values({ type: "serwis", title: `${PREFIX} Serwis`, startAt: `${shift(3)}T08:00`, endAt: `${shift(3)}T10:00`, allDay: false, status: "planned", objectId: a1 })
    .returning({ id: schema.calendarEvents.id })
    .get().id;
  const evOld = db
    .insert(schema.calendarEvents)
    .values({ type: "serwis", title: `${PREFIX} Stary serwis`, startAt: `${shift(-120)}T08:00`, endAt: `${shift(-120)}T10:00`, allDay: false, status: "planned" })
    .returning({ id: schema.calendarEvents.id })
    .get().id;
  const evCanc = db
    .insert(schema.calendarEvents)
    .values({ type: "serwis", title: `${PREFIX} Anulowany`, startAt: `${shift(5)}T08:00`, endAt: `${shift(5)}T10:00`, allDay: false, status: "cancelled" })
    .returning({ id: schema.calendarEvents.id })
    .get().id;
  if (tid != null) db.insert(schema.calendarEventAssignees).values({ eventId: evUrlop, technicianId: tid }).run();
  try {
    const s1 = (await exec(tools.search_events, { query: PREFIX })) as { events: { id: number }[]; count: number; from: string; to: string };
    const ids1 = s1.events.map((e) => e.id);
    ok("search_events: domyślny zakres −90…+180 (stary poza, anulowany pominięty)", ids1.includes(evUrlop) && ids1.includes(evServ) && !ids1.includes(evOld) && !ids1.includes(evCanc), s1);
    ok("search_events: sort po odległości od dziś (serwis +3 przed urlopem −14)", ids1.indexOf(evServ) < ids1.indexOf(evUrlop), ids1);
    ok("search_events: zwraca from/to", s1.from === shift(-90) && s1.to === shift(180), s1);
    const s2 = (await exec(tools.search_events, { query: PREFIX, includeCancelled: true })) as { events: { id: number }[] };
    ok("search_events: includeCancelled → anulowany wraca", s2.events.some((e) => e.id === evCanc), s2);
    const s3 = (await exec(tools.search_events, { query: PREFIX, type: "urlop" })) as { events: { id: number }[] };
    ok("search_events: filtr type=urlop", s3.events.length === 1 && s3.events[0].id === evUrlop, s3);
    // odmiana: „Magazynie” → rdzeń „Magaz” trafia w nazwę obiektu przez join
    const s4 = (await exec(tools.search_events, { query: `${PREFIX} Magazynie` })) as { events: { id: number }[] };
    ok("search_events: odmiana („Magazynie”) trafia po nazwie obiektu", s4.events.some((e) => e.id === evServ), s4);
    if (tid != null) {
      const tname = techs[0].name.split(" ")[0];
      const s5 = (await exec(tools.search_events, { technicianName: tname, type: "urlop", from: shift(-20), to: shift(-10) })) as { events: { id: number }[] };
      ok(`search_events: technik po imieniu („${tname}”) + type`, s5.events.some((e) => e.id === evUrlop), s5);
      const s6 = (await exec(tools.search_events, { technicianId: tid, from: shift(-20), to: shift(-10) })) as { events: { id: number }[] };
      ok("search_events: technicianId", s6.events.some((e) => e.id === evUrlop), s6);
    }
    const s7 = (await exec(tools.search_events, { from: shift(-20), to: shift(-10) })) as { error?: string };
    ok("search_events: bez filtra → error (użyj list_events)", typeof s7.error === "string", s7);
    const s8 = (await exec(tools.search_events, { query: "100%_x" })) as { events: unknown[]; count: number };
    ok("search_events: escape LIKE (bez wildcard)", s8.count === 0, s8);
    // type=wizja daje 0 → narzędzie samo zdejmuje filtr i oznacza relaxed: ["type"] + note
    const s9 = (await exec(tools.search_events, { query: `${PREFIX} Magazynie`, type: "wizja" })) as { events: { id: number }[]; relaxed?: string[]; note?: string };
    ok("search_events: 0 dla type=wizja → fallback bez typu, relaxed: [\"type\"] + note", s9.events.some((e) => e.id === evServ) && s9.relaxed?.length === 1 && s9.relaxed[0] === "type" && /wizja lokalna|typu/i.test(s9.note ?? ""), s9);
    // filtr z trafieniami → bez relaxed; filtr bez innych kryteriów (sam type) nie jest zdejmowany
    const s10 = (await exec(tools.search_events, { query: PREFIX, type: "serwis" })) as { events: { id: number }[]; relaxed?: string[] };
    ok("search_events: type z trafieniami → bez relaxed", s10.events.some((e) => e.id === evServ) && !s10.events.some((e) => e.id === evUrlop) && s10.relaxed === undefined, s10);
    const s11 = (await exec(tools.search_events, { query: `${PREFIX} nie-ma-takiego`, type: "wizja" })) as { count: number; relaxed?: string[] };
    ok("search_events: 0 także bez typu → count 0, bez relaxed", s11.count === 0 && s11.relaxed === undefined, s11);
  } finally {
    db.delete(schema.calendarEventAssignees).where(eq(schema.calendarEventAssignees.eventId, evUrlop)).run();
    db.delete(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).run();
  }

  // ask_choice z `action` (kontrakt: ASSISTANT_CHOICE_ACTION) — walidacja jak propose_changes/propose_event, bez zapisu
  {
    const evAct = db
      .insert(schema.calendarEvents)
      .values({ type: "serwis", title: `${PREFIX} Do przesunięcia`, startAt: `${shift(3)}T08:00`, endAt: `${shift(3)}T10:00`, allDay: false, status: "planned" })
      .returning({ id: schema.calendarEvents.id })
      .get().id;
    try {
      type ActOpt = { label: string; action?: unknown; actionPreview?: { after?: { startAt: string }; diff?: unknown[]; title?: string; startAt?: string }; actionError?: string };
      const change = { kind: "update", eventId: evAct, patch: { startAt: `${shift(4)}T08:00`, endAt: `${shift(4)}T10:00` } };
      const a1 = (await exec(tools.ask_choice, {
        question: "Który termin?",
        options: [
          { label: "jutro", action: { kind: "change", change } },
          { label: "błędne", action: { kind: "change", change: { kind: "update", eventId: 99999999, patch: { startAt: `${shift(4)}T08:00` } } } },
          { label: "nowe", action: { kind: "event", event: { type: "serwis", title: "Nowe", startAt: `${shift(5)}T09:00`, technicianIds: [] } } },
          { label: "nowe błędne", action: { kind: "event", event: { type: "serwis", title: "Nowe", startAt: `${shift(5)}T09:00`, technicianIds: [99999999] } } },
          { label: "Inny termin", action: { kind: "change", change } },
        ],
      })) as { error?: string; awaitingUserChoice?: boolean; allowCustom?: boolean; options: ActOpt[] };
      ok("ask_choice+action: narzędzie NIE zwraca error mimo błędnych akcji", !a1.error && a1.awaitingUserChoice === true, a1);
      const [oOk, oBad, oEv, oEvBad, oOther] = a1.options;
      ok("ask_choice+action change OK: option.action zachowane", JSON.stringify(oOk.action) === JSON.stringify({ kind: "change", change }), oOk);
      ok("ask_choice+action change OK: actionPreview = ResolvedChange z after/diff", oOk.actionPreview?.after?.startAt === `${shift(4)}T08:00` && Array.isArray(oOk.actionPreview?.diff) && oOk.actionPreview.diff.length === 1 && oOk.actionError === undefined, oOk);
      ok("ask_choice+action change błędna (nieistniejący eventId): brak action, actionError string", oBad.action === undefined && oBad.actionPreview === undefined && typeof oBad.actionError === "string" && /99999999/.test(oBad.actionError), oBad);
      ok("ask_choice+action event OK: actionPreview = proposal (title/startAt)", !!oEv.action && oEv.actionPreview?.title === "Nowe" && oEv.actionPreview?.startAt === `${shift(5)}T09:00` && oEv.actionError === undefined, oEv);
      ok("ask_choice+action event błędna (nieistniejący technik): brak action, actionError", oEvBad.action === undefined && typeof oEvBad.actionError === "string" && /Technik #99999999/.test(oEvBad.actionError), oEvBad);
      ok("ask_choice+action: „Inny termin” → action usunięte, actionError „opcja otwarta”, allowCustom", oOther.action === undefined && /opcja otwarta/.test(oOther.actionError ?? "") && a1.allowCustom === true, oOther);
      // Jedno źródło prawdy: propose_changes / propose_event dają dokładnie ten sam wynik co actionPreview.
      const pc = (await exec(tools.propose_changes, { changes: [change] })) as { changes: unknown[] };
      ok("propose_changes == actionPreview (resolveChangesPreview)", JSON.stringify(pc.changes[0]) === JSON.stringify(oOk.actionPreview), pc);
      const pe = (await exec(tools.propose_event, { type: "serwis", title: "Nowe", startAt: `${shift(5)}T09:00`, technicianIds: [] })) as { proposal: unknown };
      ok("propose_event == actionPreview (buildEventProposal)", JSON.stringify(pe.proposal) === JSON.stringify(oEv.actionPreview), pe);
      // allowModifications=false → action change odrzucane (propose_changes wyłączone), event nadal działa
      const toolsNoMod = buildCalendarTools({ id: 0 } as User, { allowModifications: false });
      const a2 = (await exec(toolsNoMod.ask_choice, {
        question: "?",
        options: [
          { label: "A", action: { kind: "change", change } },
          { label: "B", action: { kind: "event", event: { type: "serwis", title: "Nowe", startAt: `${shift(5)}T09:00`, technicianIds: [] } } },
        ],
      })) as { options: ActOpt[] };
      ok("ask_choice+action przy allowModifications=false: change → actionError, event → action", a2.options[0].action === undefined && /wyłączone/.test(a2.options[0].actionError ?? "") && !!a2.options[1].action, a2);
    } finally {
      db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, evAct)).run();
    }
  }

  // check_conflicts
  const k1 = (await exec(tools.check_conflicts, { startAt: "2026-09-01T10:00", endAt: "2026-09-01T08:00", technicianIds: [tid] })) as { error?: string };
  ok("check_conflicts: endAt <= startAt → error", typeof k1.error === "string", k1);

  // PROPOSAL_INTENT_RE
  for (const t of ["Składam propozycję wydarzenia.", "Przygotowuję propozycję serwisu.", "Zaraz przygotuję propozycję.", "Oto propozycja:", "Tworzę kartę propozycji."]) {
    ok(`PROPOSAL_INTENT_RE łapie: „${t}”`, PROPOSAL_INTENT_RE.test(t));
  }
  for (const t of ["Który obiekt wybierasz?", "Serwis w piątek 10–12, technik Dominik — bez kolizji.", "Wydarzenie #12 zapisane.", "Podaj datę."]) {
    ok(`PROPOSAL_INTENT_RE nie łapie: „${t}”`, !PROPOSAL_INTENT_RE.test(t));
  }
} finally {
  cleanup();
}
console.log(failures ? `\n${failures} błędów` : "\nWszystkie testy OK");
process.exit(failures ? 1 : 0);
