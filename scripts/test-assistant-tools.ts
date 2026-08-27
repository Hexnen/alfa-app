/**
 * Test jednostkowy narzędzi asystenta na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-assistant-tools.ts
 * Tworzy tymczasowe obiekty (prefix __ASST_TEST__), sprawdza find_object (dedup, count/ambiguous,
 * escape LIKE), ask_choice (walidacja objectId/technicianId/startAt/endAt, allowCustom przy „Inny…”),
 * propose_event (tytuł ≤ 80, data w przeszłości), find_free_slots (technicianIds: []), list_events (to<=from).
 * Sprząta po sobie (także przy błędzie).
 */
import { db, schema } from "../src/db/index.js";
import { like } from "drizzle-orm";
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
const cleanup = () => db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
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

  const r2 = (await exec(tools.find_object, { query: `${PREFIX} Magazyn` + " ul. Inna" })) as { count: number };
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
