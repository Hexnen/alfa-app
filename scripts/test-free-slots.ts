/**
 * Test jednostkowy generatora wolnych terminów (bez bazy):
 *   npx tsx scripts/test-free-slots.ts
 * Scenariusz: horyzont od pon. 2026-08-31, technik 1 ma serwis wt. 09:00–11:00 i urlop śr.;
 * technik 2 ma spotkanie pon. 08:00–12:00. Oczekiwane sloty 2 h dla obu (08–16, pon–pt):
 * pon. 12:00–14:00 (po spotkaniu t2), wt. 08:00–10:00? NIE — t1 zajęty 09–11 → wt. 11:00–13:00,
 * śr. pominięta (urlop t1) → czw. 08:00–10:00.
 */
import { computeFreeSlots, type BusyInterval } from "../src/lib/ai/freeSlots.js";

let failures = 0;
function eq<T>(label: string, got: T, want: T) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

const busy: BusyInterval[] = [
  { startAt: "2026-09-01T09:00", endAt: "2026-09-01T11:00", technicianIds: [1] }, // wt. serwis t1
  { startAt: "2026-09-02", endAt: "2026-09-03", technicianIds: [1] }, // śr. urlop t1 (all-day, end exclusive)
  { startAt: "2026-08-31T08:00", endAt: "2026-08-31T12:00", technicianIds: [2] }, // pon. spotkanie t2
  { startAt: "2026-09-03T08:00", endAt: "2026-09-03T10:00", technicianIds: [99] }, // inny technik — bez znaczenia
];

const base = { durationHours: 2, from: "2026-08-31", horizonDays: 14, earliest: "08:00", latest: "16:00", workdaysOnly: true, limit: 3 };

eq(
  "obaj technicy: pon. po spotkaniu, wt. po serwisie, czw. (śr. urlop)",
  computeFreeSlots(busy, { ...base, technicianIds: [1, 2] }).map((s) => `${s.weekday} ${s.startAt}–${s.endAt.slice(11)}`),
  ["poniedziałek 2026-08-31T12:00–14:00", "wtorek 2026-09-01T11:00–13:00", "czwartek 2026-09-03T08:00–10:00"]
);

eq(
  "tylko technik 1: pon. 08:00 wolne, wt. dopiero po serwisie 09–11",
  computeFreeSlots(busy, { ...base, technicianIds: [1], limit: 2 }).map((s) => s.startAt),
  ["2026-08-31T08:00", "2026-09-01T11:00"]
);

eq(
  "8 h dla t1 we wtorek niemożliwe (serwis w środku) → pon., czw.",
  computeFreeSlots(busy, { ...base, technicianIds: [1], durationHours: 8, limit: 2 }).map((s) => s.startAt),
  ["2026-08-31T08:00", "2026-09-03T08:00"]
);

eq(
  "weekend pomijany (from = sobota)",
  computeFreeSlots([], { ...base, technicianIds: [1], from: "2026-09-05", limit: 1 }).map((s) => `${s.weekday} ${s.startAt}`),
  ["poniedziałek 2026-09-07T08:00"]
);

eq(
  "workdaysOnly=false → sobota",
  computeFreeSlots([], { ...base, technicianIds: [1], from: "2026-09-05", limit: 1, workdaysOnly: false }).map((s) => s.weekday),
  ["sobota"]
);

eq(
  "dziś: nie wcześniej niż teraz (zaokrąglone do 30 min)",
  computeFreeSlots([], { ...base, technicianIds: [1], from: "2026-08-31", limit: 1, now: "2026-08-31T10:10" }).map((s) => s.startAt),
  ["2026-08-31T10:30"]
);

eq(
  "dziś po godzinach pracy → jutro",
  computeFreeSlots([], { ...base, technicianIds: [1], from: "2026-08-31", limit: 1, now: "2026-08-31T15:00" }).map((s) => s.startAt),
  ["2026-09-01T08:00"]
);

eq(
  "okno earliest/latest (10–12) i czas 2 h: jedyny start 10:00",
  computeFreeSlots(busy, { ...base, technicianIds: [1], earliest: "10:00", latest: "12:00", limit: 2 }).map((s) => s.startAt),
  ["2026-08-31T10:00", "2026-09-03T10:00"]
);

eq("brak techników → pusto", computeFreeSlots(busy, { ...base, technicianIds: [] }).length, 0);
eq("czas dłuższy niż dzień pracy → pusto", computeFreeSlots([], { ...base, technicianIds: [1], durationHours: 9 }).length, 0);

// --- from = dzień kolizji (reguła 8: po check_conflicts szukamy od dnia kolizji, nie od dziś) ---
eq(
  "from = dzień kolizji (wt.): pierwszy slot t1 tego samego dnia po serwisie",
  computeFreeSlots(busy, { ...base, technicianIds: [1], from: "2026-09-01", limit: 2 }).map((s) => s.startAt),
  ["2026-09-01T11:00", "2026-09-03T08:00"]
);

// --- tryb any („dowolny technik”): slot gdy KTOKOLWIEK wolny; technicianIds = wolni ---
eq(
  "any: pon. 08:00 wolny t1 (t2 na spotkaniu) → technicianIds [1]; wt. t2; śr. t2 (urlop t1)",
  computeFreeSlots(busy, { ...base, technicianIds: [1, 2], mode: "any", limit: 3 }).map((s) => `${s.startAt}:${s.technicianIds.join(",")}`),
  ["2026-08-31T08:00:1", "2026-09-01T08:00:2", "2026-09-02T08:00:2"]
);
eq(
  "any: obaj zajęci od 08:00 → slot po najwcześniejszym końcu (10:00, wolny t2)",
  computeFreeSlots(
    [
      { startAt: "2026-08-31T08:00", endAt: "2026-08-31T12:00", technicianIds: [1] },
      { startAt: "2026-08-31T08:00", endAt: "2026-08-31T10:00", technicianIds: [2] },
    ],
    { ...base, technicianIds: [1, 2], mode: "any", limit: 1 }
  ).map((s) => `${s.startAt}:${s.technicianIds.join(",")}`),
  ["2026-08-31T10:00:2"]
);
eq(
  "any: urlop całodniowy jednego + drugi zajęty cały dzień → następny dzień, obaj wolni",
  computeFreeSlots(
    [
      { startAt: "2026-08-31", endAt: "2026-09-01", technicianIds: [1] },
      { startAt: "2026-08-31T08:00", endAt: "2026-08-31T16:00", technicianIds: [2] },
    ],
    { ...base, technicianIds: [1, 2], mode: "any", limit: 1 }
  ).map((s) => `${s.startAt}:${s.technicianIds.join(",")}`),
  ["2026-09-01T08:00:1,2"]
);
eq("any: brak techników → pusto", computeFreeSlots(busy, { ...base, technicianIds: [], mode: "any" }).length, 0);

console.log(failures ? `\n${failures} błędów` : "\nWszystkie testy OK");
process.exit(failures ? 1 : 0);
