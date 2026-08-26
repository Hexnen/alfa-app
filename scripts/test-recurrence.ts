/**
 * Szybki test generatora wystąpień serii kalendarza.
 * Uruchomienie: npx tsx scripts/test-recurrence.ts
 */
import {
  expandOccurrences,
  MAX_OCCURRENCES,
} from "../src/lib/calendar-recurrence.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

// 1. Miesięczny z 31. dnia — clamp do końca miesiąca, powrót do 31 gdy istnieje
{
  const occ = expandOccurrences("2026-01-31T08:00", "2026-01-31T10:00", false, {
    freq: "monthly",
    count: 5,
  });
  const starts = occ.map((o) => o.startAt);
  check("monthly z 31.: liczba = 5", occ.length === 5, starts);
  check(
    "monthly z 31.: 31.01, 28.02, 31.03, 30.04, 31.05",
    JSON.stringify(starts) ===
      JSON.stringify([
        "2026-01-31T08:00",
        "2026-02-28T08:00",
        "2026-03-31T08:00",
        "2026-04-30T08:00",
        "2026-05-31T08:00",
      ]),
    starts
  );
  check("monthly: koniec = start + 2h", occ[1].endAt === "2026-02-28T10:00", occ[1]);
}

// 2. Kwartalny z until (włącznie)
{
  const occ = expandOccurrences("2026-03-15T09:00", "2026-03-15T12:00", false, {
    freq: "quarterly",
    until: "2027-03-15",
  });
  const starts = occ.map((o) => o.startAt);
  check(
    "quarterly until 2027-03-15 (włącznie): 5 wystąpień",
    JSON.stringify(starts) ===
      JSON.stringify([
        "2026-03-15T09:00",
        "2026-06-15T09:00",
        "2026-09-15T09:00",
        "2026-12-15T09:00",
        "2027-03-15T09:00",
      ]),
    starts
  );
}

// 3. count + interval (co 2 tygodnie, 3 razy), all-day, end exclusive
{
  const occ = expandOccurrences("2026-09-07", "2026-09-09", true, {
    freq: "weekly",
    interval: 2,
    count: 3,
  });
  check("weekly interval=2 count=3: 3 wystąpienia", occ.length === 3, occ);
  check(
    "weekly all-day: daty bez czasu, end = start + 2 dni",
    occ[2].startAt === "2026-10-05" && occ[2].endAt === "2026-10-07",
    occ[2]
  );
}

// 4. Brak until/count → 24 miesiące do przodu
{
  const occ = expandOccurrences("2026-01-10T08:00", "2026-01-10T09:00", false, {
    freq: "monthly",
  });
  check("monthly bez końca: 24 wystąpienia (horyzont 24 mies.)", occ.length === 24, occ.length);
  check("ostatnie = 2027-12-10", occ[occ.length - 1].startAt === "2027-12-10T08:00");
}

// 5. Twardy limit 200
{
  const occ = expandOccurrences("2026-01-05T08:00", "2026-01-05T09:00", false, {
    freq: "weekly",
    count: 1000,
  });
  check(`weekly count=1000 → limit ${MAX_OCCURRENCES}`, occ.length === MAX_OCCURRENCES, occ.length);
  const occ2 = expandOccurrences("2026-01-05T08:00", "2026-01-05T09:00", false, {
    freq: "weekly",
    until: "2040-01-01",
  });
  check(`weekly until 2040 → limit ${MAX_OCCURRENCES}`, occ2.length === MAX_OCCURRENCES, occ2.length);
}

// 6. Roczny z 29 lutego
{
  const occ = expandOccurrences("2028-02-29T10:00", "2028-02-29T11:00", false, {
    freq: "yearly",
    count: 3,
  });
  const starts = occ.map((o) => o.startAt);
  check(
    "yearly z 29.02: 2028-02-29, 2029-02-28, 2030-02-28",
    JSON.stringify(starts) ===
      JSON.stringify(["2028-02-29T10:00", "2029-02-28T10:00", "2030-02-28T10:00"]),
    starts
  );
}

console.log(failed === 0 ? "\nWszystkie testy OK" : `\n${failed} test(ów) nie przeszło`);
process.exit(failed === 0 ? 0 : 1);
