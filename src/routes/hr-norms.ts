/**
 * Normy godzin liczone z Kodeksu pracy + słownik dni ustawowo wolnych.
 *
 * Montowane w `src/routes/hr.ts` jedną linią (`app.route("/", hrNorms)`), bo to
 * osobna sprawa od reszty Kadr: pięć tras, jedna nowa tabela (`hr_holidays`,
 * migracja 0108) i jedna czysta funkcja (`src/lib/hr-norms.ts`), która jako
 * jedyna zna art. 130 k.p. Ścieżki (`/holidays`, `/norms/computed`,
 * `/norms/apply-computed`) nie kolidują z `GET|PUT /norms` z hr.ts — Hono
 * dopasowuje całe segmenty, a nie prefiksy.
 *
 * Podział ról:
 *  • `GET /hr/holidays?year` — słownik roku. Rok BEZ ŻADNEGO wpisu zasiewa się
 *    sam świętami z ustawy: inaczej pierwsze wejście w nowy rok pokazywałoby
 *    wymiar bez świąt (same 40 h × tygodnie) i wyglądałoby na błąd programu.
 *    Zasiew jest idempotentny (`INSERT` pod UNIQUE na dacie, po jednym wpisie
 *    w dzienniku na cały rok) i NIE dotyka roku, w którym ktoś już coś skasował
 *    albo dopisał — tam „brak Bożego Ciała” jest decyzją, a nie luką.
 *  • `POST /hr/holidays` — własny dzień wolny (nowela ustawy w trakcie roku,
 *    dzień wolny firmowy). Zawsze `source: 'custom'`.
 *  • `DELETE /hr/holidays/:id` — tylko wpisy własne. Usunięcie święta
 *    ustawowego nie jest decyzją kadrową, tylko pomyłką, po której wymiar
 *    miesiąca cicho rośnie o 8 h.
 *  • `GET /hr/norms/computed?year` — porównanie „wpisane vs wyliczone”, razem
 *    ze świętami użytymi do rachunku. Niczego nie zapisuje.
 *  • `POST /hr/norms/apply-computed` — przepisanie wyliczenia do
 *    `hr_month_norms`. Dotyka WYŁĄCZNIE `work_norm`: norma zlecenia (158) jest
 *    ustaleniem firmowym, nie wynikiem z ustawy.
 *
 * Zamknięty miesiąc (`hr_month_status`, migracja 0106) jest POMIJANY, a nie
 * blokuje całej operacji: „wylicz rok” z jednym zamkniętym styczniem ma zapisać
 * jedenaście pozostałych miesięcy i powiedzieć, czego nie ruszyło.
 */
import { Hono, type Context } from "hono";
import { and, asc, eq, like } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ApiResponse } from "../types/index.js";
import { getUser } from "../middleware/auth.js";
import { canEdit } from "../lib/auth/permissions.js";
import { logHrCreated, logHrDeleted, logHrEvent, logHrUpdated } from "../lib/hr-activity.js";
import { isMonthClosed, monthClosedMessage } from "../lib/hr-month.js";
import {
  DAY_NAMES_PL,
  computeWorkNorms,
  dayOfWeek,
  isValidIsoDate,
  statutoryHolidays,
} from "../lib/hr-norms.js";

const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const YEAR_ERROR = `Nieprawidłowy rok (${YEAR_MIN}–${YEAR_MAX})`;

/** Norma zlecenia przy zakładaniu wiersza — ta sama wartość domyślna, co w `getNorms()`. */
const DEFAULT_CONTRACT_NORM = 158;

const NO_RIGHTS = "Zmiana norm i świąt wymaga prawa edycji zakładki Normy";

const canEditNorms = (c: Context) => canEdit(getUser(c), "kadry/normy");

/** „1 miesiąc” / „3 miesiące” / „7 miesięcy” — komunikat czyta człowiek. */
function monthsWord(n: number): string {
  if (n === 1) return "miesiąc";
  const last = n % 10;
  const teen = n % 100 >= 12 && n % 100 <= 14;
  return !teen && last >= 2 && last <= 4 ? "miesiące" : "miesięcy";
}

/** Rok z zapytania albo bieżący; `null` = wartość nie do przyjęcia. */
function readYear(raw: unknown, fallbackToNow = false): number | null {
  if ((raw === undefined || raw === null || raw === "") && fallbackToNow) {
    return new Date().getFullYear();
  }
  const year = Number(raw);
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) return null;
  return year;
}

type HolidayRow = typeof schema.hrHolidays.$inferSelect;

/** Wszystkie święta roku, po dacie rosnąco. Rok bierzemy z prefiksu daty. */
function holidaysOfYear(dbx: typeof db, year: number) {
  return dbx
    .select()
    .from(schema.hrHolidays)
    .where(like(schema.hrHolidays.date, `${year}-%`))
    .orderBy(asc(schema.hrHolidays.date))
    .all();
}

/** Święto w postaci, jakiej potrzebuje front: z dniem tygodnia i informacją, czy obniża wymiar. */
function holidayPayload(row: HolidayRow) {
  const dow = dayOfWeek(row.date);
  return {
    id: row.id,
    date: row.date,
    name: row.name,
    source: row.source,
    dayOfWeek: dow,
    dayName: DAY_NAMES_PL[dow],
    // Niedziela i tak jest wolna — takie święto nie zmienia wymiaru (art. 130 § 2).
    reduces: dow !== 0,
  };
}

export type HrHolidayPayload = ReturnType<typeof holidayPayload>;

/**
 * Zasiew roku świętami z ustawy — TYLKO gdy rok jest zupełnie pusty.
 * Zwraca liczbę wstawionych wierszy (0 = nie było czego siać).
 */
function seedStatutoryYear(year: number, user: ReturnType<typeof getUser>): number {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: schema.hrHolidays.id })
      .from(schema.hrHolidays)
      .where(like(schema.hrHolidays.date, `${year}-%`))
      .all();
    // Drugi odczyt WEWNĄTRZ transakcji: dwa równoległe wejścia w zakładkę
    // Normy nie mają prawa zasiać roku dwa razy (UNIQUE i tak by je odbił,
    // ale w dzienniku zostałyby dwa wpisy „zasiano”).
    if (existing.length > 0) return 0;
    const rows = statutoryHolidays(year);
    for (const h of rows) {
      tx.insert(schema.hrHolidays).values({ ...h, source: "statutory" }).run();
    }
    // JEDEN wpis na cały rok, nie czternaście: to jest jedna czynność
    // („otwarto rok”), a nie czternaście decyzji kadrowych. entityId = rok.
    logHrEvent(tx, {
      entityType: "hr_holiday",
      entityId: year,
      user,
      action: "created",
      summary: `Zasiano święta ustawowe roku ${year} (${rows.length} dni wolnych)`,
    });
    return rows.length;
  });
}

const app = new Hono();

// ---------------------------------------------------------------------------
// Słownik świąt
// ---------------------------------------------------------------------------

app.get("/holidays", (c) => {
  const year = readYear(c.req.query("year"), true);
  if (year == null) {
    return c.json<ApiResponse<null>>({ success: false, error: YEAR_ERROR }, 400);
  }
  let rows = holidaysOfYear(db, year);
  let seeded = 0;
  if (rows.length === 0) {
    seeded = seedStatutoryYear(year, getUser(c));
    rows = holidaysOfYear(db, year);
  }
  return c.json({
    success: true,
    data: rows.map(holidayPayload),
    message: seeded > 0 ? `Zasiano ${seeded} świąt ustawowych roku ${year}` : undefined,
  });
});

app.post("/holidays", async (c) => {
  if (!canEditNorms(c)) {
    return c.json<ApiResponse<null>>({ success: false, error: NO_RIGHTS }, 403);
  }
  const body = await c.req.json<Record<string, unknown>>();
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!isValidIsoDate(date)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagana poprawna data w formacie RRRR-MM-DD" },
      400,
    );
  }
  if (name.length < 2) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagana nazwa święta (co najmniej 2 znaki)" },
      400,
    );
  }
  const user = getUser(c);
  // Sprawdzenie i wstawienie w JEDNEJ transakcji — dwa równoległe „Dodaj
  // święto" na ten sam dzień mają skończyć się konfliktem, a nie wyścigiem.
  const result = db.transaction((tx): HolidayRow | { conflict: HolidayRow } => {
    const existing = tx
      .select()
      .from(schema.hrHolidays)
      .where(eq(schema.hrHolidays.date, date))
      .get();
    if (existing) return { conflict: existing };
    const created = tx
      .insert(schema.hrHolidays)
      .values({ date, name, source: "custom" })
      .returning()
      .all();
    logHrCreated(tx, {
      entityType: "hr_holiday",
      entityId: created[0].id,
      user,
      after: created[0],
    });
    return created[0];
  });
  if ("conflict" in result) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `Ten dzień jest już w słowniku: ${result.conflict.name}`,
      },
      409,
    );
  }
  return c.json({
    success: true,
    data: holidayPayload(result),
    message: "Święto dodane",
  });
});

app.delete("/holidays/:id", (c) => {
  if (!canEditNorms(c)) {
    return c.json<ApiResponse<null>>({ success: false, error: NO_RIGHTS }, 403);
  }
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator" }, 400);
  }
  const user = getUser(c);
  type DeleteResult =
    | { kind: "missing" }
    | { kind: "statutory"; row: HolidayRow }
    | { kind: "deleted" };
  const result = db.transaction((tx): DeleteResult => {
    const row = tx
      .select()
      .from(schema.hrHolidays)
      .where(eq(schema.hrHolidays.id, id))
      .get();
    if (!row) return { kind: "missing" };
    if (row.source !== "custom") return { kind: "statutory", row };
    tx.delete(schema.hrHolidays).where(eq(schema.hrHolidays.id, id)).run();
    logHrDeleted(tx, { entityType: "hr_holiday", entityId: id, user, before: row });
    return { kind: "deleted" };
  });
  if (result.kind === "missing") {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono święta" }, 404);
  }
  if (result.kind === "statutory") {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `„${result.row.name}” to święto ustawowe — usuwać wolno tylko dni dodane ręcznie`,
      },
      409,
    );
  }
  return c.json({ success: true, data: null, message: "Święto usunięte" });
});

// ---------------------------------------------------------------------------
// Wyliczenie norm
// ---------------------------------------------------------------------------

/** Jeden miesiąc porównania „wpisane vs Kodeks pracy”. */
export interface ComputedNormRow {
  month: number;
  /** Wymiar z art. 130 k.p. */
  computed: number;
  /** Norma zapisana w `hr_month_norms` albo `null`, gdy miesiąc jej nie ma. */
  current: number | null;
  /** `computed − current`; `null`, gdy nie ma z czym porównywać. */
  diff: number | null;
  /** Jest co zapisać: inna wartość albo brak wiersza (miesiąc leci na domyślnych 160 h). */
  differs: boolean;
  /** Miesiąc zamknięty — zapisu nie będzie, a pole wyboru jest wyłączone. */
  closed: boolean;
  /** Rozbicie rachunku do dymka: 40 h × tygodnie + 8 h × dni wystające. */
  fullWeeks: number;
  extraWorkdays: number;
  baseHours: number;
  /** Daty świąt, które obniżyły wymiar tego miesiąca. */
  holidays: string[];
}

function buildComputed(year: number, user: ReturnType<typeof getUser>) {
  // Rok bez ani jednego wpisu zasiewamy TU TEŻ, nie tylko w `GET /holidays`:
  // wyliczenie bez świąt dałoby wymiar wyższy o kilkadziesiąt godzin i wyglądało
  // na błąd rachunku, a nie na pustą tabelę.
  let holidayRows = holidaysOfYear(db, year);
  if (holidayRows.length === 0) {
    seedStatutoryYear(year, user);
    holidayRows = holidaysOfYear(db, year);
  }
  const computed = computeWorkNorms(year, holidayRows);
  const saved = db
    .select()
    .from(schema.hrMonthNorms)
    .where(eq(schema.hrMonthNorms.year, year))
    .all();
  const months: ComputedNormRow[] = computed.map((m) => {
    const row = saved.find((n) => n.month === m.month) ?? null;
    const current = row?.workNorm ?? null;
    return {
      month: m.month,
      computed: m.hours,
      current,
      diff: current == null ? null : m.hours - current,
      differs: current == null || current !== m.hours,
      closed: isMonthClosed(year, m.month),
      fullWeeks: m.fullWeeks,
      extraWorkdays: m.extraWorkdays,
      baseHours: m.baseHours,
      holidays: m.reducingHolidays,
    };
  });
  return { year, months, holidays: holidayRows.map(holidayPayload) };
}

app.get("/norms/computed", (c) => {
  const year = readYear(c.req.query("year"), true);
  if (year == null) {
    return c.json<ApiResponse<null>>({ success: false, error: YEAR_ERROR }, 400);
  }
  return c.json({ success: true, data: buildComputed(year, getUser(c)) });
});

app.post("/norms/apply-computed", async (c) => {
  if (!canEditNorms(c)) {
    return c.json<ApiResponse<null>>({ success: false, error: NO_RIGHTS }, 403);
  }
  const body = await c.req.json<Record<string, unknown>>();
  const year = readYear(body.year);
  if (year == null) {
    return c.json<ApiResponse<null>>({ success: false, error: YEAR_ERROR }, 400);
  }
  // Brak listy miesięcy = „zapisz wszystko, co się różni”. Lista pusta znaczy
  // to samo co brak listy tylko z pozoru — front wysyła ją zawsze, więc pusta
  // jest błędem operatora (nic nie zaznaczył), nie żądaniem „zrób wszystko”.
  const rawMonths = body.months;
  let wanted: number[] | null = null;
  if (Array.isArray(rawMonths)) {
    const parsed = rawMonths.map(Number);
    if (parsed.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Miesiące muszą być liczbami od 1 do 12" },
        400,
      );
    }
    wanted = [...new Set(parsed)].sort((a, b) => a - b);
    if (wanted.length === 0) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie wskazano żadnego miesiąca do zapisania" },
        400,
      );
    }
  }

  const user = getUser(c);
  const snapshot = buildComputed(year, user);
  const target = snapshot.months.filter((m) =>
    wanted ? wanted.includes(m.month) : m.differs,
  );
  const savedMonths: number[] = [];
  const skippedClosed: number[] = [];
  const unchanged: number[] = [];

  for (const m of target) {
    if (m.closed) {
      skippedClosed.push(m.month);
      continue;
    }
    if (!m.differs) {
      unchanged.push(m.month);
      continue;
    }
    db.transaction((tx) => {
      const period = { year, month: m.month };
      const existing = tx
        .select()
        .from(schema.hrMonthNorms)
        .where(
          and(
            eq(schema.hrMonthNorms.year, year),
            eq(schema.hrMonthNorms.month, m.month),
          ),
        )
        .get();
      if (existing) {
        tx.update(schema.hrMonthNorms)
          .set({ workNorm: m.computed, updatedAt: new Date().toISOString() })
          .where(eq(schema.hrMonthNorms.id, existing.id))
          .run();
        // Norma zlecenia zostaje nietknięta — dlatego w `after` jest tylko
        // `workNorm` (logHrUpdated pomija pola nieobecne w `after`).
        logHrUpdated(tx, {
          entityType: "hr_norm",
          entityId: existing.id,
          user,
          period,
          before: existing,
          after: { workNorm: m.computed },
        });
        return;
      }
      const created = tx
        .insert(schema.hrMonthNorms)
        .values({
          year,
          month: m.month,
          workNorm: m.computed,
          contractNorm: DEFAULT_CONTRACT_NORM,
        })
        .returning()
        .all();
      logHrCreated(tx, {
        entityType: "hr_norm",
        entityId: created[0].id,
        user,
        period,
        after: created[0],
      });
    });
    savedMonths.push(m.month);
  }

  // Wpisu zbiorczego „przeliczono rok” NIE ma celowo: każdy miesiąc zostawił
  // własny wpis `hr_norm` ze starą i nową wartością, a dodatkowe zdanie bez
  // wiersza, do którego by należało, zaśmiecałoby oś czasu drugi raz tym samym.

  const message = (() => {
    if (savedMonths.length > 0) {
      return (
        `Zapisano normy: ${savedMonths.length} ${monthsWord(savedMonths.length)}` +
        (skippedClosed.length > 0
          ? `, pominięto zamknięte: ${skippedClosed.length}`
          : "")
      );
    }
    if (skippedClosed.length > 0) {
      return `Nie zapisano nic — ${monthClosedMessage(year, skippedClosed[0])}`;
    }
    return "Nie było czego zapisywać — normy już zgadzają się z wyliczeniem";
  })();

  return c.json({
    success: true,
    data: {
      ...buildComputed(year, user),
      saved: savedMonths,
      skippedClosed,
      unchanged,
    },
    message,
  });
});

export default app;
