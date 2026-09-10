/**
 * Lejek handlowy (/api/leads) — szanse sprzedaży.
 *
 * Zasada modułu (activity-based selling): KAŻDA otwarta szansa ma zaplanowaną
 * następną aktywność. To backend rozstrzyga, czy szansa „gnije” (`rotting`,
 * `rotReason`) — front tylko maluje krawędź karty. Dzięki temu lista, kanban,
 * pulpit i filtr `?rotting=1` mówią zawsze to samo, bo liczy je jedno miejsce
 * (src/lib/sales-leads.ts + `ROTTING_SQL` niżej, ta sama definicja w dwóch
 * postaciach: JS dla pojedynczych wierszy, SQL dla filtrowania zbioru).
 *
 * Kształt JSON-a jest kontraktem z frontem (frontend/src/lib/api.ts: `Lead`,
 * `LeadDetail`, `LeadsResponse`, `LeadBoardColumn`, `LeadPipelineStats`,
 * `LeadOrderPrefill`) — klucze camelCase, kwoty NETTO.
 *
 * Kierunek jest jednostronny: szansa → zlecenie. Tu mieszka wyłącznie prefill
 * formularza (`GET /:id/order-prefill`); samo zlecenie zakłada `src/services/orders.ts`.
 */
import { Hono, type Context } from "hono";
import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  LEAD_LOST_REASONS,
  LEAD_OPEN_STAGES,
  LEAD_SERVICES,
  LEAD_SOURCES,
  LEAD_STAGES,
  type LeadLostReason,
  type LeadService,
  type LeadSource,
  type LeadStage,
  type User,
} from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { ApiError } from "../lib/calendar-labels.js";
import { logActivity, logFieldDiffs, type DbOrTx } from "../lib/activity-log.js";
import {
  SALES_ROT_DAYS,
  assertLeadRefs,
  loadLead,
  loadLeads,
  salespersonIdForUser,
  touchLead,
  type LeadJson,
} from "../lib/sales-leads.js";
import { legacyObjectType } from "../lib/object-services.js";
import { computeOffer } from "../lib/offer-calc.js";
import { getCompanyConfig } from "../lib/company-config.js";
import { OFFER_SECTION_CATEGORIES } from "../db/schema.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { zonedNow } from "../lib/tz.js";

const app = new Hono();

/** Encja w `activity_log` — po niej karta szansy zbiera swoją oś czasu. */
const ENTITY = "lead";

/** Domyślna i maksymalna strona listy (jak w pozostałych listach CRM). */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Ile kart wchodzi do jednej kolumny kanbanu. */
const BOARD_LIMIT = 200;

/** Ile dni wstecz pokazują zwinięte kolumny „Wygrane” i „Przegrane”. */
const BOARD_CLOSED_DAYS = 30;

// ---------------------------------------------------------------------------
// Drobne parsery (wzorzec: src/routes/objects.ts, src/routes/salespeople.ts)
// ---------------------------------------------------------------------------

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`Błąd ${what}:`, error);
  return c.json({ success: false, error: `Błąd ${what}` }, 500);
}

function idParam(c: Context, name = "id"): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Nieprawidłowe id");
  return id;
}

/** Lista liczb z parametru csv; śmieci są pomijane (literówka nie ma zwracać pustki). */
function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Tekst z body: pusty / same spacje → null (kolumny opisowe trzymają NULL, nie ""). */
function optText(v: unknown, label: string, max = 500): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiError(400, `Nieprawidłowe pole: ${label}`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw new ApiError(400, `Pole ${label} jest za długie (maks. ${max} znaków)`);
  return t;
}

function optNumber(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) throw new ApiError(400, `Nieprawidłowa liczba: ${label}`);
  return n;
}

function optInt(v: unknown, label: string): number | null {
  const n = optNumber(v, label);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw new ApiError(400, `Nieprawidłowa liczba całkowita: ${label}`);
  return n;
}

/** Data YYYY-MM-DD albo null. */
function optDate(v: unknown, label: string): string | null {
  const t = optText(v, label, 10);
  if (t === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ApiError(400, `Pole ${label}: format YYYY-MM-DD`);
  return t;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new ApiError(400, `Pole ${label}: dozwolone ${allowed.join(", ")}`);
  }
  return v as T;
}

/** Zakres usług szansy — nieznana wartość jest błędem, nie cichym pominięciem. */
function parseServices(v: unknown): LeadService[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new ApiError(400, "Nieprawidłowa lista usług");
  const out: LeadService[] = [];
  for (const raw of v) {
    if (typeof raw !== "string" || !(LEAD_SERVICES as readonly string[]).includes(raw)) {
      throw new ApiError(400, `Nieznana usługa: ${String(raw)}`);
    }
    if (!out.includes(raw as LeadService)) out.push(raw as LeadService);
  }
  return out;
}

/** Procent 0–100 albo null. */
function parseProbability(v: unknown): number | null {
  const n = optInt(v, "probability");
  if (n === null) return null;
  if (n < 0 || n > 100) throw new ApiError(400, "Prawdopodobieństwo musi mieścić się w 0–100");
  return n;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "Nieprawidłowe dane");
  return raw as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Definicja „gnicia” w SQL — bliźniak `rottingOf` z src/lib/sales-leads.ts
// ---------------------------------------------------------------------------

/** Znacznik „teraz − N dni” w formacie kolumn czasowych bazy (UTC). */
function agoStamp(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

/** Podzapytanie: początek najbliższej OTWARTEJ przyszłej aktywności szansy (NULL = brak). */
function nextActivitySql(now: string): SQL {
  return sql`(select min(ce.start_at) from calendar_events ce
    where ce.lead_id = leads.id and ce.deleted_at is null
      and ce.status not in ('cancelled','done') and ce.end_at >= ${now})`;
}

/**
 * Warunek „szansa gnije”: otwarty etap i albo BRAK zaplanowanej aktywności,
 * albo cisza dłuższa niż `SALES_ROT_DAYS`. Musi znaczyć dokładnie to samo,
 * co `rottingOf` — inaczej filtr `?rotting=1` pokazywałby inne karty niż
 * bursztynowa krawędź na kanbanie.
 */
function rottingSql(now: string): SQL {
  const openList = sql.join(
    LEAD_OPEN_STAGES.map((s) => sql`${s}`),
    sql`, `
  );
  return sql`(leads.stage in (${openList}) and (
    not exists (select 1 from calendar_events ce
      where ce.lead_id = leads.id and ce.deleted_at is null
        and ce.status not in ('cancelled','done') and ce.end_at >= ${now})
    or coalesce(leads.last_activity_at, leads.created_at) < ${agoStamp(SALES_ROT_DAYS)}
  ))`;
}

// ---------------------------------------------------------------------------
// Sortowanie listy
// ---------------------------------------------------------------------------

/**
 * Kolumny sortowania. `stage` układamy CASE-em w kolejności lejka (alfabetycznie
 * „negocjacje” stałyby przed „nowy”), a `nextActivityAt` jest podzapytaniem —
 * dlatego każda pozycja to funkcja od `now`, a nie gotowy `SQL`.
 */
const SORT_COLUMNS = {
  title: () => sql`lower(leads.title)`,
  stage: () =>
    sql`case leads.stage when 'nowy' then 0 when 'kontakt' then 1 when 'wizja' then 2 when 'oferta' then 3 when 'negocjacje' then 4 when 'wygrany' then 5 when 'przegrany' then 6 else 7 end`,
  estimatedMonthly: () => sql`leads.estimated_monthly`,
  expectedCloseDate: () => sql`leads.expected_close_date`,
  lastActivityAt: () => sql`coalesce(leads.last_activity_at, leads.created_at)`,
  nextActivityAt: (now: string) => nextActivitySql(now),
  createdAt: () => sql`leads.created_at`,
} as const;

export type LeadSortKey = keyof typeof SORT_COLUMNS;

function isSortKey(v: string): v is LeadSortKey {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, v);
}

/**
 * Puste wartości ZAWSZE na końcu, niezależnie od kierunku: „bez terminu”,
 * „bez kwoty” i „bez następnej aktywności” to brak informacji, a nie zero.
 */
const NULLS_LAST: Partial<Record<LeadSortKey, (now: string) => SQL>> = {
  estimatedMonthly: () => sql`case when leads.estimated_monthly is null then 1 else 0 end`,
  expectedCloseDate: () => sql`case when leads.expected_close_date is null then 1 else 0 end`,
  nextActivityAt: (now) => sql`case when ${nextActivitySql(now)} is null then 1 else 0 end`,
};

// ---------------------------------------------------------------------------
// Filtry listy — wspólne dla GET /, GET /board i GET /stats/pipeline
// ---------------------------------------------------------------------------

interface ListFilters {
  conditions: SQL[];
  /** `true` = filtr „Moje” nie trafił w żadnego handlowca → pusty wynik. */
  empty: boolean;
}

/**
 * Filtr po handlowcu: lista id, `me` (konto → `salespeople.user_id`) albo `none`.
 * BRAK dopasowania przy `me` daje PUSTY zbiór — „moje szanse” kogoś, kto nie jest
 * handlowcem, to zero szans, a nie wszystkie (§5.11 planu).
 */
function salespersonCondition(raw: string | undefined, user: User): { cond?: SQL; empty: boolean } {
  const v = (raw || "").trim();
  if (!v) return { empty: false };
  if (v === "none") return { cond: isNull(schema.leads.salespersonId), empty: false };
  if (v === "me") {
    const sid = salespersonIdForUser(db, user?.id);
    if (sid == null) return { empty: true };
    return { cond: eq(schema.leads.salespersonId, sid), empty: false };
  }
  const ids = parseIdList(v);
  if (ids.length === 0) return { empty: false };
  return { cond: inArray(schema.leads.salespersonId, ids), empty: false };
}

function listFilters(c: Context, user: User, now: string): ListFilters {
  const conditions: SQL[] = [];
  let empty = false;

  if (c.req.query("includeDeleted") !== "1") conditions.push(isNull(schema.leads.deletedAt));

  const q = (c.req.query("q") || "").trim();
  if (q) {
    // identity-ok: to SZUKAJKA użytkownika (filtr listy), nigdy złączenie encji.
    const pattern = `%${q}%`;
    const cond = or(
      like(schema.leads.title, pattern), // identity-ok
      like(schema.leads.prospectName, pattern),
      like(schema.leads.city, pattern),
      like(schema.leads.address, pattern),
      sql`exists (select 1 from contractors ct where ct.id = leads.contractor_id and ct.name like ${pattern})`
    );
    if (cond) conditions.push(cond);
  }

  const stages = (c.req.query("stage") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is LeadStage => (LEAD_STAGES as readonly string[]).includes(s));
  if (stages.length) {
    conditions.push(inArray(schema.leads.stage, stages));
  } else if (c.req.query("includeClosed") !== "1") {
    // Domyślnie lista pokazuje wyłącznie to, co jeszcze da się dowieźć.
    conditions.push(inArray(schema.leads.stage, [...LEAD_OPEN_STAGES]));
  }

  const sp = salespersonCondition(c.req.query("salespersonId"), user);
  if (sp.cond) conditions.push(sp.cond);
  if (sp.empty) empty = true;

  const source = c.req.query("source");
  if (source && (LEAD_SOURCES as readonly string[]).includes(source)) {
    conditions.push(eq(schema.leads.source, source as LeadSource));
  }

  // Usługi siedzą w kolumnie JSON — filtrujemy przez `json_each`, żeby „kamery”
  // nie łapało przypadkiem innej wartości zawierającej ten tekst.
  const service = c.req.query("service");
  if (service && (LEAD_SERVICES as readonly string[]).includes(service)) {
    conditions.push(
      sql`exists (select 1 from json_each(coalesce(leads.services, '[]')) je where je.value = ${service})`
    );
  }

  const contractorId = Number(c.req.query("contractorId"));
  if (Number.isInteger(contractorId) && contractorId > 0) {
    conditions.push(eq(schema.leads.contractorId, contractorId));
  }
  const objectId = Number(c.req.query("objectId"));
  if (Number.isInteger(objectId) && objectId > 0) {
    conditions.push(eq(schema.leads.objectId, objectId));
  }

  if (c.req.query("rotting") === "1") conditions.push(rottingSql(now));

  const closeFrom = c.req.query("closeFrom");
  const closeTo = c.req.query("closeTo");
  if (closeFrom) conditions.push(sql`leads.expected_close_date >= ${closeFrom}`);
  if (closeTo) conditions.push(sql`leads.expected_close_date <= ${closeTo}`);

  return { conditions, empty };
}

// ---------------------------------------------------------------------------
// GET /leads — lista z paginacją po stronie backendu
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  try {
    const user = getUser(c);
    const now = zonedNow();
    const { conditions, empty } = listFilters(c, user, now);
    const where = conditions.length ? and(...conditions) : undefined;

    const sortRaw = c.req.query("sort") || "lastActivityAt";
    const sort: LeadSortKey = isSortKey(sortRaw) ? sortRaw : "lastActivityAt";
    const dir = c.req.query("dir") === "asc" ? "asc" : "desc";
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(c.req.query("pageSize") || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
    );

    if (empty) {
      return c.json({
        success: true,
        data: {
          items: [],
          total: 0,
          page,
          pageSize,
          summary: { count: 0, monthly: 0, setup: 0, weightedMonthly: 0 },
        },
      });
    }

    const direction = dir === "desc" ? desc : asc;
    const nulls = NULLS_LAST[sort];
    const orderBy: SQL[] = [
      ...(nulls ? [nulls(now)] : []),
      direction(SORT_COLUMNS[sort](now)) as unknown as SQL,
      desc(schema.leads.id) as unknown as SQL,
    ];

    const ids = db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all()
      .map((r) => r.id);

    // Podsumowanie liczone na CAŁYM zbiorze po filtrach (nie tylko na stronie) —
    // pod listą stoi „N szans · MRR · ważony MRR”, a nie „N na tej stronie”.
    const sum = db
      .select({
        count: sql<number>`count(*)`,
        monthly: sql<number | null>`sum(coalesce(leads.estimated_monthly, 0))`,
        setup: sql<number | null>`sum(coalesce(leads.estimated_setup, 0))`,
        weighted: sql<number | null>`sum(coalesce(leads.estimated_monthly, 0) * coalesce(leads.probability, 0) / 100.0)`,
      })
      .from(schema.leads)
      .where(where)
      .get();

    return c.json({
      success: true,
      data: {
        items: loadLeads(db, ids, now),
        total: Number(sum?.count ?? 0),
        page,
        pageSize,
        summary: {
          count: Number(sum?.count ?? 0),
          monthly: Number(sum?.monthly ?? 0),
          setup: Number(sum?.setup ?? 0),
          weightedMonthly: Number(sum?.weighted ?? 0),
        },
      },
    });
  } catch (error) {
    return handleError(c, error, "listy szans");
  }
});

// ---------------------------------------------------------------------------
// GET /leads/board — kanban
// ---------------------------------------------------------------------------

/**
 * Kolumny lejka. Otwarte etapy pokazują wszystko, zamknięte (Wygrane/Przegrane)
 * tylko ostatnie 30 dni — kanban ma pokazywać bieżącą pracę, a nie archiwum.
 * Sortowanie w kolumnie: gnijące na górze, potem najbliższe zamknięcie.
 */
app.get("/board", async (c) => {
  try {
    const user = getUser(c);
    const now = zonedNow();
    const base: SQL[] = [isNull(schema.leads.deletedAt)];

    const sp = salespersonCondition(c.req.query("salespersonId"), user);
    if (sp.cond) base.push(sp.cond);
    const q = (c.req.query("q") || "").trim();
    if (q) {
      const pattern = `%${q}%`;
      const cond = or(
        like(schema.leads.title, pattern), // identity-ok: szukajka kanbanu
        like(schema.leads.prospectName, pattern),
        like(schema.leads.city, pattern),
        sql`exists (select 1 from contractors ct where ct.id = leads.contractor_id and ct.name like ${pattern})`
      );
      if (cond) base.push(cond);
    }
    const service = c.req.query("service");
    if (service && (LEAD_SERVICES as readonly string[]).includes(service)) {
      base.push(sql`exists (select 1 from json_each(coalesce(leads.services, '[]')) je where je.value = ${service})`);
    }

    const closedSince = agoStamp(BOARD_CLOSED_DAYS).slice(0, 10);
    const rot = rottingSql(now);
    const columns = LEAD_STAGES.map((stage) => {
      if (sp.empty) return { stage, count: 0, monthly: 0, setup: 0, items: [] as LeadJson[] };
      const conds: SQL[] = [...base, eq(schema.leads.stage, stage)];
      if (stage === "wygrany") conds.push(sql`coalesce(leads.won_at, leads.updated_at) >= ${closedSince}`);
      if (stage === "przegrany") conds.push(sql`coalesce(leads.lost_at, leads.updated_at) >= ${closedSince}`);
      const where = and(...conds);
      const agg = db
        .select({
          count: sql<number>`count(*)`,
          monthly: sql<number | null>`sum(coalesce(leads.estimated_monthly, 0))`,
          setup: sql<number | null>`sum(coalesce(leads.estimated_setup, 0))`,
        })
        .from(schema.leads)
        .where(where)
        .get();
      const ids = db
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(where)
        .orderBy(
          desc(rot) as unknown as SQL,
          sql`case when leads.expected_close_date is null then 1 else 0 end`,
          asc(schema.leads.expectedCloseDate) as unknown as SQL,
          desc(schema.leads.id) as unknown as SQL
        )
        .limit(BOARD_LIMIT)
        .all()
        .map((r) => r.id);
      return {
        stage,
        count: Number(agg?.count ?? 0),
        monthly: Number(agg?.monthly ?? 0),
        setup: Number(agg?.setup ?? 0),
        items: loadLeads(db, ids, now),
      };
    });

    return c.json({ success: true, data: { columns } });
  } catch (error) {
    return handleError(c, error, "tablicy szans");
  }
});

// ---------------------------------------------------------------------------
// GET /leads/stats/pipeline — dane pulpitu
// ---------------------------------------------------------------------------

app.get("/stats/pipeline", async (c) => {
  try {
    const user = getUser(c);
    const now = zonedNow();
    const conds: SQL[] = [isNull(schema.leads.deletedAt)];
    const sp = salespersonCondition(c.req.query("salespersonId"), user);
    if (sp.cond) conds.push(sp.cond);

    // `from`/`to` zawężają WYNIKI (wygrane i przegrane po dacie zamknięcia);
    // otwarty lejek jest z definicji „na teraz” i dat nie filtruje.
    const from = c.req.query("from");
    const to = c.req.query("to");

    const empty = {
      byStage: LEAD_STAGES.map((stage) => ({ stage, count: 0, monthly: 0, setup: 0 })),
      won: { count: 0, monthly: 0, setup: 0 },
      lost: { count: 0, byReason: [] as { reason: LeadLostReason; count: number }[] },
      rotting: 0,
      noNextActivity: 0,
    };
    if (sp.empty) return c.json({ success: true, data: empty });

    const rows = db
      .select({
        stage: schema.leads.stage,
        count: sql<number>`count(*)`,
        monthly: sql<number | null>`sum(coalesce(leads.estimated_monthly, 0))`,
        setup: sql<number | null>`sum(coalesce(leads.estimated_setup, 0))`,
      })
      .from(schema.leads)
      .where(and(...conds))
      .groupBy(schema.leads.stage)
      .all();
    const byStageMap = new Map(rows.map((r) => [r.stage, r]));
    const byStage = LEAD_STAGES.map((stage) => {
      const r = byStageMap.get(stage);
      return {
        stage,
        count: Number(r?.count ?? 0),
        monthly: Number(r?.monthly ?? 0),
        setup: Number(r?.setup ?? 0),
      };
    });

    const closedRange = (col: "won_at" | "lost_at"): SQL[] => {
      const out: SQL[] = [];
      if (from) out.push(sql`coalesce(leads.${sql.raw(col)}, leads.updated_at) >= ${from}`);
      if (to) out.push(sql`coalesce(leads.${sql.raw(col)}, leads.updated_at) <= ${to} || ' 23:59:59'`);
      return out;
    };

    const won = db
      .select({
        count: sql<number>`count(*)`,
        monthly: sql<number | null>`sum(coalesce(leads.estimated_monthly, 0))`,
        setup: sql<number | null>`sum(coalesce(leads.estimated_setup, 0))`,
      })
      .from(schema.leads)
      .where(and(...conds, eq(schema.leads.stage, "wygrany"), ...closedRange("won_at")))
      .get();

    const lostConds = and(...conds, eq(schema.leads.stage, "przegrany"), ...closedRange("lost_at"));
    const lostTotal = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.leads)
      .where(lostConds)
      .get();
    const byReason = db
      .select({ reason: schema.leads.lostReason, count: sql<number>`count(*)` })
      .from(schema.leads)
      .where(lostConds)
      .groupBy(schema.leads.lostReason)
      .all()
      .filter((r): r is { reason: LeadLostReason; count: number } => r.reason != null)
      .map((r) => ({ reason: r.reason, count: Number(r.count) }))
      .sort((a, b) => b.count - a.count);

    const rotting = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.leads)
      .where(and(...conds, rottingSql(now)))
      .get();
    const noNext = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.leads)
      .where(
        and(
          ...conds,
          inArray(schema.leads.stage, [...LEAD_OPEN_STAGES]),
          sql`${nextActivitySql(now)} is null`
        )
      )
      .get();

    return c.json({
      success: true,
      data: {
        byStage,
        won: {
          count: Number(won?.count ?? 0),
          monthly: Number(won?.monthly ?? 0),
          setup: Number(won?.setup ?? 0),
        },
        lost: { count: Number(lostTotal?.count ?? 0), byReason },
        rotting: Number(rotting?.count ?? 0),
        noNextActivity: Number(noNext?.count ?? 0),
      },
    });
  } catch (error) {
    return handleError(c, error, "statystyk lejka");
  }
});

// ---------------------------------------------------------------------------
// GET /leads/:id — karta szansy
// ---------------------------------------------------------------------------

/** Wiersz szansy albo 404. `includeDeleted` czyta też szanse z kosza (przywracanie). */
function leadRow(id: number, includeDeleted = false) {
  const row = db.select().from(schema.leads).where(eq(schema.leads.id, id)).get();
  if (!row || (!includeDeleted && row.deletedAt)) throw new ApiError(404, "Szansa nie istnieje");
  return row;
}

const ACTIVITY_FIELDS = {
  id: schema.calendarEvents.id,
  type: schema.calendarEvents.type,
  title: schema.calendarEvents.title,
  startAt: schema.calendarEvents.startAt,
  endAt: schema.calendarEvents.endAt,
  allDay: schema.calendarEvents.allDay,
  status: schema.calendarEvents.status,
} as const;

app.get("/:id{[0-9]+}", async (c) => {
  try {
    const id = idParam(c);
    const now = zonedNow();
    // `leadRow` odsiewa szanse z kosza (404) — `loadLeads` czyta po id i o soft
    // delete nic nie wie, bo obsługuje też listę z `includeDeleted=1`.
    leadRow(id);
    const lead = loadLead(db, id, now);
    if (!lead) throw new ApiError(404, "Szansa nie istnieje");

    const contacts = db
      .select({ contact: schema.contacts, contractorName: schema.contractors.name })
      .from(schema.contacts)
      .leftJoin(schema.contractors, eq(schema.contractors.id, schema.contacts.contractorId))
      .where(
        lead.contractorId != null
          ? or(eq(schema.contacts.leadId, id), eq(schema.contacts.contractorId, lead.contractorId))
          : eq(schema.contacts.leadId, id)
      )
      .orderBy(desc(schema.contacts.isPrimary), asc(schema.contacts.lastName), asc(schema.contacts.firstName))
      .all()
      .map((r) => contactJson(r.contact, { contractorName: r.contractorName ?? null, leadTitle: lead.title }));

    // Oferty i zlecenia szansy: pełne wiersze (na karcie jest ich kilka, nie tysiące).
    const offers = offerRows(id);
    const orders = db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.leadId, id))
      .orderBy(desc(schema.orders.id))
      .all()
      .map((o) => ({
        ...o,
        objectServices: typeof o.objectServices === "string" ? safeJson(o.objectServices) : (o.objectServices ?? null),
      }));

    const events = db
      .select(ACTIVITY_FIELDS)
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.leadId, id), isNull(schema.calendarEvents.deletedAt)))
      .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
      .all();
    const open = events.filter((e) => e.status !== "done" && e.status !== "cancelled");
    const activities = {
      overdue: open.filter((e) => e.endAt < now),
      upcoming: open.filter((e) => e.endAt >= now),
      done: events.filter((e) => e.status === "done").reverse().slice(0, 50),
    };

    // Oś czasu: dziennik samej szansy + dziennik JEJ wydarzeń kalendarza —
    // „zadzwoniono, przełożono, dopisano notatkę” to historia szansy, nie kalendarza.
    const eventIds = db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.leadId, id))
      .all()
      .map((r) => r.id);
    const historyWhere = eventIds.length
      ? or(
          and(eq(schema.activityLog.entityType, ENTITY), eq(schema.activityLog.entityId, id)),
          and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds))
        )
      : and(eq(schema.activityLog.entityType, ENTITY), eq(schema.activityLog.entityId, id));
    const history = db
      .select()
      .from(schema.activityLog)
      .where(historyWhere)
      .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
      .limit(500)
      .all();

    return c.json({ success: true, data: { ...lead, contacts, offers, orders, activities, history } });
  } catch (error) {
    return handleError(c, error, "karty szansy");
  }
});

/**
 * Oferty szansy w kształcie `OfferListRow` (frontend/src/lib/api.ts) — z sumami
 * i zakresem, bo karta szansy pokazuje je tą samą kolumną, co lista Ofert.
 * Liczymy tu, a nie w /offers, bo szansa bywa widoczna dla kogoś bez klucza Ofert.
 */
function offerRows(leadId: number) {
  const rows = db
    .select()
    .from(schema.offers)
    .where(eq(schema.offers.leadId, leadId))
    .orderBy(desc(schema.offers.date), desc(schema.offers.id))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const allSections = db.select().from(schema.offerSections).where(inArray(schema.offerSections.offerId, ids)).all();
  const allItems = db.select().from(schema.offerItems).where(inArray(schema.offerItems.offerId, ids)).all();
  const { values } = getCompanyConfig();
  const salesById = new Map(
    db
      .select({ id: schema.salespeople.id, firstName: schema.salespeople.firstName, lastName: schema.salespeople.lastName })
      .from(schema.salespeople)
      .all()
      .map((sp) => [sp.id, `${sp.firstName} ${sp.lastName}`.trim()])
  );
  return rows.map((r) => {
    const sections = allSections.filter((s) => s.offerId === r.id);
    const items = allItems.filter((i) => i.offerId === r.id);
    const withItems = new Set(items.map((i) => i.sectionId));
    const tags = new Set(sections.filter((s) => withItems.has(s.id)).map((s) => s.category));
    if (items.some((i) => i.billing === "monthly")) tags.add("abonament");
    const scope: string[] = OFFER_SECTION_CATEGORIES.filter((cat) => tags.has(cat));
    // Dzierżawa na końcu — to sposób rozliczenia, nie system (jak w /offers).
    if (r.leaseMode !== "none" && (r.leaseAnnualRate ?? 0) > 0) scope.push("dzierzawa");
    return {
      ...r,
      scope,
      salespersonName: r.salespersonId == null ? null : (salesById.get(r.salespersonId) ?? null),
      createdByLabel: r.createdBy,
      totals: computeOffer(r, sections, items, values.minMarginPct),
    };
  });
}

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /leads, PUT /leads/:id
// ---------------------------------------------------------------------------

interface LeadPatch {
  title?: string;
  stage?: LeadStage;
  source?: LeadSource | null;
  contractorId?: number | null;
  prospectName?: string | null;
  prospectNip?: string | null;
  prospectPhone?: string | null;
  prospectEmail?: string | null;
  objectKind?: string | null;
  address?: string | null;
  city?: string | null;
  mapsUrl?: string | null;
  lat?: number | null;
  lng?: number | null;
  services?: LeadService[];
  estimatedMonthly?: number | null;
  estimatedSetup?: number | null;
  probability?: number | null;
  expectedCloseDate?: string | null;
  salespersonId?: number | null;
  objectId?: number | null;
  notes?: string | null;
}

/** Body → patch. `partial` (PUT) przepisuje wyłącznie klucze, które przyszły. */
function parseLeadInput(b: Record<string, unknown>, partial: boolean): LeadPatch {
  const out: LeadPatch = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);

  if (!partial || has("title")) {
    const title = optText(b.title, "title", 200);
    if (!title) throw new ApiError(400, "Tytuł szansy jest wymagany");
    out.title = title;
  }
  if (has("stage")) {
    const stage = oneOf(b.stage, LEAD_STAGES, "stage");
    if (stage) out.stage = stage;
  }
  if (has("source")) out.source = oneOf(b.source, LEAD_SOURCES, "source");
  if (has("contractorId")) out.contractorId = optInt(b.contractorId, "contractorId");
  if (has("prospectName")) out.prospectName = optText(b.prospectName, "prospectName", 200);
  if (has("prospectNip")) {
    const nip = optText(b.prospectNip, "prospectNip", 20);
    out.prospectNip = nip ? normalizeNIP(nip) : null;
  }
  if (has("prospectPhone")) out.prospectPhone = optText(b.prospectPhone, "prospectPhone", 60);
  if (has("prospectEmail")) out.prospectEmail = optText(b.prospectEmail, "prospectEmail", 200);
  if (has("objectKind")) out.objectKind = optText(b.objectKind, "objectKind", 100);
  if (has("address")) out.address = optText(b.address, "address", 300);
  if (has("city")) out.city = optText(b.city, "city", 120);
  if (has("mapsUrl")) out.mapsUrl = optText(b.mapsUrl, "mapsUrl", 2000);
  if (has("lat")) out.lat = optNumber(b.lat, "lat");
  if (has("lng")) out.lng = optNumber(b.lng, "lng");
  if (has("services")) out.services = parseServices(b.services) ?? [];
  if (has("estimatedMonthly")) out.estimatedMonthly = optNumber(b.estimatedMonthly, "estimatedMonthly");
  if (has("estimatedSetup")) out.estimatedSetup = optNumber(b.estimatedSetup, "estimatedSetup");
  if (has("probability")) out.probability = parseProbability(b.probability);
  if (has("expectedCloseDate")) out.expectedCloseDate = optDate(b.expectedCloseDate, "expectedCloseDate");
  if (has("salespersonId")) out.salespersonId = optInt(b.salespersonId, "salespersonId");
  if (has("objectId")) out.objectId = optInt(b.objectId, "objectId");
  if (has("notes")) out.notes = optText(b.notes, "notes", 20000);
  return out;
}

/** Pola śledzone w dzienniku przy edycji (§3.1 planu). */
const DIFF_FIELDS = [
  { key: "title" as const, label: "tytuł" },
  { key: "stage" as const, label: "etap", action: "stage_changed" as const },
  { key: "source" as const, label: "źródło" },
  { key: "salespersonId" as const, label: "handlowca" },
  { key: "estimatedMonthly" as const, label: "abonament" },
  { key: "estimatedSetup" as const, label: "wdrożenie" },
  { key: "probability" as const, label: "prawdopodobieństwo" },
  { key: "expectedCloseDate" as const, label: "przewidywane zamknięcie" },
  { key: "contractorId" as const, label: "kontrahenta" },
  { key: "city" as const, label: "miasto" },
  { key: "services" as const, label: "usługi" },
];

/** Rekord do porównania w `logFieldDiffs` (JSON usług jako tekst). */
function diffSnapshot(row: typeof schema.leads.$inferSelect): Record<string, unknown> {
  return {
    title: row.title,
    stage: row.stage,
    source: row.source,
    salespersonId: row.salespersonId,
    estimatedMonthly: row.estimatedMonthly,
    estimatedSetup: row.estimatedSetup,
    probability: row.probability,
    expectedCloseDate: row.expectedCloseDate,
    contractorId: row.contractorId,
    city: row.city,
    services: Array.isArray(row.services) ? (row.services as string[]).join(", ") : null,
  };
}

app.post("/", async (c) => {
  try {
    const user = getUser(c);
    const b = await body(c);
    const patch = parseLeadInput(b, false);
    assertLeadRefs(db, patch);

    const id = db.transaction((tx) => {
      const row = tx
        .insert(schema.leads)
        .values({
          title: patch.title!,
          stage: patch.stage ?? "nowy",
          source: patch.source ?? null,
          contractorId: patch.contractorId ?? null,
          prospectName: patch.prospectName ?? null,
          prospectNip: patch.prospectNip ?? null,
          prospectPhone: patch.prospectPhone ?? null,
          prospectEmail: patch.prospectEmail ?? null,
          objectKind: patch.objectKind ?? null,
          address: patch.address ?? null,
          city: patch.city ?? null,
          mapsUrl: patch.mapsUrl ?? null,
          lat: patch.lat ?? null,
          lng: patch.lng ?? null,
          services: patch.services ?? [],
          estimatedMonthly: patch.estimatedMonthly ?? null,
          estimatedSetup: patch.estimatedSetup ?? null,
          probability: patch.probability ?? null,
          expectedCloseDate: patch.expectedCloseDate ?? null,
          salespersonId: patch.salespersonId ?? null,
          objectId: patch.objectId ?? null,
          // Świeża szansa nie gnije od pierwszej sekundy — znacznik startuje „teraz”.
          lastActivityAt: sql`(datetime('now'))`,
          notes: patch.notes ?? null,
          createdBy: user?.id ?? null,
          updatedBy: user?.id ?? null,
        })
        .returning({ id: schema.leads.id })
        .get();
      logActivity(tx, {
        entityType: ENTITY,
        entityId: row.id,
        user,
        action: "created",
        summary: `Utworzono szansę „${patch.title}”`,
      });
      return row.id;
    });

    return c.json({ success: true, data: loadLead(db, id) }, 201);
  } catch (error) {
    return handleError(c, error, "zapisu szansy");
  }
});

app.put("/:id{[0-9]+}", async (c) => {
  try {
    const user = getUser(c);
    const id = idParam(c);
    const before = leadRow(id);
    const b = await body(c);
    const patch = parseLeadInput(b, true);
    assertLeadRefs(db, patch);

    db.transaction((tx) => {
      tx.update(schema.leads)
        .set({ ...patch, updatedBy: user?.id ?? null, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.leads.id, id))
        .run();
      const after = leadRow(id);
      logFieldDiffs(tx, {
        entityType: ENTITY,
        entityId: id,
        user,
        before: diffSnapshot(before),
        after: diffSnapshot(after),
        fields: DIFF_FIELDS,
      });
      // Edycja szansy to też ruch na szansie — inaczej „cisza > 7 dni” liczyłaby
      // się mimo tego, że handlowiec właśnie przy niej pracował.
      touchLead(tx, id);
    });

    return c.json({ success: true, data: loadLead(db, id) });
  } catch (error) {
    return handleError(c, error, "zapisu szansy");
  }
});

// ---------------------------------------------------------------------------
// PATCH /leads/:id/stage — stepper na karcie i drag&drop kanbanu
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<LeadStage, string> = {
  nowy: "Nowy",
  kontakt: "Kontakt",
  wizja: "Wizja lokalna",
  oferta: "Oferta",
  negocjacje: "Negocjacje",
  wygrany: "Wygrany",
  przegrany: "Przegrany",
};

app.patch("/:id{[0-9]+}/stage", async (c) => {
  try {
    const user = getUser(c);
    const id = idParam(c);
    const before = leadRow(id);
    const b = await body(c);
    const stage = oneOf(b.stage, LEAD_STAGES, "stage");
    if (!stage) throw new ApiError(400, "Etap jest wymagany");
    const lostReason = oneOf(b.lostReason, LEAD_LOST_REASONS, "lostReason");
    const lostNote = optText(b.lostNote, "lostNote", 2000);
    // Przegrana bez powodu jest bezużyteczna w statystykach — i tylko tu można
    // ją jeszcze wyegzekwować, bo potem nikt do tej szansy nie wróci.
    if (stage === "przegrany" && !lostReason) {
      throw new ApiError(400, "Etap „przegrany” wymaga podania powodu");
    }

    db.transaction((tx) => {
      tx.update(schema.leads)
        .set({
          stage,
          // Znaczniki zamknięcia stawia i CZYŚCI backend — cofnięcie szansy do
          // otwartego etapu musi ją znów wpuścić do lejka.
          wonAt: stage === "wygrany" ? (before.wonAt ?? sql`(datetime('now'))`) : null,
          lostAt: stage === "przegrany" ? (before.lostAt ?? sql`(datetime('now'))`) : null,
          lostReason: stage === "przegrany" ? lostReason : null,
          lostNote: stage === "przegrany" ? lostNote : null,
          updatedBy: user?.id ?? null,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(eq(schema.leads.id, id))
        .run();

      if (before.stage !== stage) {
        logActivity(tx, {
          entityType: ENTITY,
          entityId: id,
          user,
          action: "stage_changed",
          field: "stage",
          oldValue: before.stage,
          newValue: stage,
          summary: `Etap: ${STAGE_LABELS[before.stage]} → ${STAGE_LABELS[stage]}`,
        });
        if (stage === "wygrany") {
          logActivity(tx, {
            entityType: ENTITY,
            entityId: id,
            user,
            action: "won",
            summary: `Szansa wygrana: „${before.title}”`,
          });
        }
        if (stage === "przegrany") {
          logActivity(tx, {
            entityType: ENTITY,
            entityId: id,
            user,
            action: "lost",
            field: "lost_reason",
            newValue: lostReason,
            summary: `Szansa przegrana (${lostReason})${lostNote ? `: ${lostNote}` : ""}`,
          });
        }
      }
      touchLead(tx, id);
    });

    return c.json({ success: true, data: loadLead(db, id) });
  } catch (error) {
    return handleError(c, error, "zmiany etapu szansy");
  }
});

// ---------------------------------------------------------------------------
// POST /leads/:id/convert — szansa → kontrahent + obiekt (jedna transakcja)
// ---------------------------------------------------------------------------

app.post("/:id{[0-9]+}/convert", async (c) => {
  try {
    const user = getUser(c);
    const id = idParam(c);
    const lead = leadRow(id);
    const b = await body(c);

    const objRaw = b.object;
    if (!objRaw || typeof objRaw !== "object" || Array.isArray(objRaw)) {
      throw new ApiError(400, "Dane obiektu są wymagane");
    }
    const o = objRaw as Record<string, unknown>;
    const objectName = optText(o.name, "object.name", 200);
    if (!objectName) throw new ApiError(400, "Nazwa obiektu jest wymagana");

    const contractorId = optInt(b.contractorId, "contractorId") ?? lead.contractorId;
    const cRaw = b.contractor;
    const markWon = b.markWon !== false;

    let resolvedContractorId: number;
    if (contractorId != null) {
      const row = db.select({ id: schema.contractors.id }).from(schema.contractors).where(eq(schema.contractors.id, contractorId)).get();
      if (!row) throw new ApiError(400, `Kontrahent #${contractorId} nie istnieje`);
      resolvedContractorId = row.id;
    } else {
      if (!cRaw || typeof cRaw !== "object" || Array.isArray(cRaw)) {
        throw new ApiError(400, "Wskaż kontrahenta albo podaj dane nowego");
      }
      const cb = cRaw as Record<string, unknown>;
      const name = optText(cb.name, "contractor.name", 200) ?? lead.prospectName;
      if (!name) throw new ApiError(400, "Nazwa kontrahenta jest wymagana");
      const nip = normalizeNIP(String(optText(cb.nip, "contractor.nip", 20) ?? lead.prospectNip ?? ""));
      // Ta sama walidacja, co przy zleceniu (src/services/orders.ts): kartoteka
      // stoi na NIP-ie, więc suma kontrolna jest warunkiem założenia kontrahenta.
      if (!validateNIP(nip)) throw new ApiError(400, "Nieprawidłowy NIP (błędna suma kontrolna)");
      const existing = db.select({ id: schema.contractors.id }).from(schema.contractors).where(eq(schema.contractors.nip, nip)).get();
      if (existing) {
        // Kontrahent z tym NIP-em już jest w kartotece — używamy go zamiast
        // zakładać duplikat (unikalny indeks i tak by na to nie pozwolił).
        resolvedContractorId = existing.id;
      } else {
        const row = db
          .insert(schema.contractors)
          .values({
            name,
            nip,
            address: optText(cb.address, "contractor.address", 300) ?? lead.address,
            city: optText(cb.city, "contractor.city", 120) ?? lead.city,
            postalCode: optText(cb.postalCode, "contractor.postalCode", 20),
            phone: optText(cb.phone, "contractor.phone", 60) ?? lead.prospectPhone,
            email: optText(cb.email, "contractor.email", 200) ?? lead.prospectEmail,
            salespersonId: lead.salespersonId,
          })
          .returning({ id: schema.contractors.id })
          .get();
        resolvedContractorId = row.id;
      }
    }

    const services = {
      hasCameras: o.hasCameras === true,
      hasSswin: o.hasSswin === true,
      hasVideoreception: o.hasVideoReception === true,
      hasOfi: o.hasOfi === true,
    };
    const installationType = o.installationType === "takeover" ? "takeover" : "new";

    const objectId = db.transaction((tx) => {
      const obj = tx
        .insert(schema.objects)
        .values({
          contractorId: resolvedContractorId,
          name: objectName,
          address: optText(o.address, "object.address", 300) ?? lead.address,
          city: optText(o.city, "object.city", 120) ?? lead.city,
          mapsUrl: optText(o.mapsUrl, "object.mapsUrl", 2000) ?? lead.mapsUrl,
          type: legacyObjectType(services),
          hasCameras: services.hasCameras,
          hasSswin: services.hasSswin,
          hasVideoreception: services.hasVideoreception,
          hasOfi: services.hasOfi,
          cameraCount: optInt(o.cameraCount, "object.cameraCount"),
          installationType,
          // Obiekt z wygranej szansy trafia do DZIAŁU HANDLOWEGO i czeka na
          // uzupełnienie — technicy dostają go dopiero po weryfikacji.
          status: "pending",
          department: "sales",
          monthlyZdw: optNumber(o.monthlyZdw, "object.monthlyZdw") ?? lead.estimatedMonthly,
          monthlyOfi: optNumber(o.monthlyOfi, "object.monthlyOfi"),
          setupCost: lead.estimatedSetup,
          salespersonId: lead.salespersonId,
        })
        .returning({ id: schema.objects.id })
        .get();

      tx.insert(schema.objectHistory)
        .values({
          objectId: obj.id,
          action: "created",
          description: `Utworzono z wygranej szansy „${lead.title}”`,
          newValue: JSON.stringify({ leadId: lead.id, contractorId: resolvedContractorId, status: "pending", department: "sales" }),
          changedBy: user?.email ?? null,
        })
        .run();

      // Osoby kontaktowe szansy przechodzą do kartoteki klienta — inaczej
      // po konwersji zostałyby przy szansie i nikt by ich nie znalazł.
      tx.update(schema.contacts)
        .set({ contractorId: resolvedContractorId, objectId: obj.id, updatedAt: sql`(datetime('now'))` })
        .where(and(eq(schema.contacts.leadId, lead.id), isNull(schema.contacts.contractorId)))
        .run();

      tx.update(schema.leads)
        .set({
          contractorId: resolvedContractorId,
          objectId: obj.id,
          ...(markWon
            ? { stage: "wygrany" as LeadStage, wonAt: lead.wonAt ?? sql`(datetime('now'))`, lostAt: null, lostReason: null, lostNote: null }
            : {}),
          updatedBy: user?.id ?? null,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(eq(schema.leads.id, lead.id))
        .run();

      logActivity(tx, {
        entityType: ENTITY,
        entityId: lead.id,
        objectId: obj.id,
        user,
        action: "converted",
        summary: `Szansa skonwertowana: obiekt „${objectName}” u kontrahenta #${resolvedContractorId}`,
      });
      if (markWon && lead.stage !== "wygrany") {
        logActivity(tx, {
          entityType: ENTITY,
          entityId: lead.id,
          user,
          action: "stage_changed",
          field: "stage",
          oldValue: lead.stage,
          newValue: "wygrany",
          summary: `Etap: ${STAGE_LABELS[lead.stage]} → ${STAGE_LABELS.wygrany}`,
        });
        logActivity(tx, {
          entityType: ENTITY,
          entityId: lead.id,
          user,
          action: "won",
          summary: `Szansa wygrana: „${lead.title}”`,
        });
      }
      touchLead(tx, lead.id);
      return obj.id;
    });

    return c.json({
      success: true,
      data: { lead: loadLead(db, lead.id), contractorId: resolvedContractorId, objectId },
    });
  } catch (error) {
    return handleError(c, error, "konwersji szansy");
  }
});

// ---------------------------------------------------------------------------
// GET /leads/:id/order-prefill — stan formularza zlecenia (§3.4)
// ---------------------------------------------------------------------------

/** `LEAD_SERVICES` → usługi obiektu; „ochrona” to na obiekcie ta sama linia, co OFI. */
const SERVICE_TO_OBJECT: Record<LeadService, "kamery" | "sswin" | "wideorecepcja" | "ofi"> = {
  kamery: "kamery",
  sswin: "sswin",
  wideorecepcja: "wideorecepcja",
  ofi: "ofi",
  ochrona: "ofi",
};

app.get("/:id{[0-9]+}/order-prefill", async (c) => {
  try {
    const id = idParam(c);
    const lead = leadRow(id);

    // Osoba kontaktowa: główna u kontrahenta, a gdy jej nie ma — pierwsza szansy.
    const contact = db
      .select()
      .from(schema.contacts)
      .where(
        lead.contractorId != null
          ? or(eq(schema.contacts.leadId, id), eq(schema.contacts.contractorId, lead.contractorId))
          : eq(schema.contacts.leadId, id)
      )
      .orderBy(desc(schema.contacts.isPrimary), asc(schema.contacts.id))
      .get();
    const contractor = lead.contractorId
      ? db.select().from(schema.contractors).where(eq(schema.contractors.id, lead.contractorId)).get()
      : undefined;
    // Szansa po konwersji (albo podpięta ręcznie) ma już obiekt w kartotece —
    // pinezka z niego jest DOKŁADNIEJSZA niż to, co handlowiec wpisał w lejku.
    const object = lead.objectId
      ? db.select().from(schema.objects).where(eq(schema.objects.id, lead.objectId)).get()
      : undefined;

    /*
     * NAZWISKO DO FORMULARZA. Pierwsza jest osoba kontaktowa (encja `contacts`),
     * potem jednotekstowa `contractors.contact_person` z kartoteki, a na końcu
     * nazwa prospekta. Bez tej drabinki szansa na istniejącego kontrahenta bez
     * osobnego kontaktu dawała formularz z pustym „Osoba zlecająca” — polem
     * wymaganym, którego handlowiec i tak musiałby szukać w kartotece.
     */
    const contactName = contact
      ? `${contact.firstName} ${contact.lastName}`.trim()
      : contractor?.contactPerson || lead.prospectName || "";
    const services = Array.isArray(lead.services) ? (lead.services as LeadService[]) : [];
    const uniq = [...new Set(services.map((s) => SERVICE_TO_OBJECT[s]).filter(Boolean))];
    const today = zonedNow().slice(0, 10);

    /*
     * LINK DO LOKALIZACJI. Pierwszy jest link z samej szansy (handlowiec wkleił
     * pinezkę, którą chce w zleceniu), potem `objects.maps_url` powiązanego
     * obiektu, a na końcu współrzędne obiektu złożone w link do Map. Bez tego
     * zlecenie z już skonwertowanej szansy szło do techników bez lokalizacji,
     * mimo że kartoteka obiektu ją miała.
     */
    const objectMapsUrl =
      object?.mapsUrl ||
      (object?.latitude != null && object?.longitude != null
        ? `https://www.google.com/maps?q=${object.latitude},${object.longitude}`
        : "");
    const locationUrl = lead.mapsUrl || objectMapsUrl || "";

    return c.json({
      success: true,
      data: {
        leadId: lead.id,
        leadTitle: lead.title,
        // Szansa z już założonym zleceniem: formularz ma o tym powiedzieć ZANIM
        // ktoś wypełni siedem kroków — backend i tak odrzuci zapis (409).
        leadOrderId: lead.orderId,
        salespersonId: lead.salespersonId,
        payerContractorId: lead.contractorId,
        objectId: lead.objectId,
        requesterName: contactName,
        requesterPhone: contact?.phone ?? lead.prospectPhone ?? "",
        requesterEmail: contact?.email ?? lead.prospectEmail ?? "",
        payerName: contractor?.name ?? lead.prospectName ?? "",
        payerNip: contractor?.nip ?? lead.prospectNip ?? "",
        payerInvoiceEmail: contractor?.email ?? lead.prospectEmail ?? "",
        objectName: lead.title,
        objectKind: lead.objectKind ?? "",
        objectAddress: lead.address ?? "",
        objectCity: lead.city ?? "",
        objectLocationUrl: locationUrl,
        contactPerson: contactName,
        contactPhone: contact?.phone ?? lead.prospectPhone ?? "",
        contactEmail: contact?.email ?? lead.prospectEmail ?? "",
        isCameraInstallation: services.includes("kamery"),
        videoReception: services.includes("wideorecepcja"),
        interventionGroup: services.includes("ochrona") || services.includes("ofi"),
        monthlyAmount: lead.estimatedMonthly != null ? String(lead.estimatedMonthly) : "",
        objectServices: uniq.map((service) => ({ service, startDate: today, startEstimated: true })),
      },
    });
  } catch (error) {
    return handleError(c, error, "prefillu zlecenia");
  }
});

// ---------------------------------------------------------------------------
// DELETE /leads/:id (soft) + POST /leads/:id/restore
// ---------------------------------------------------------------------------

app.delete("/:id{[0-9]+}", async (c) => {
  try {
    const user = getUser(c);
    const id = idParam(c);
    const lead = leadRow(id);
    db.transaction((tx) => {
      tx.update(schema.leads)
        .set({ deletedAt: sql`(datetime('now'))`, updatedBy: user?.id ?? null, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.leads.id, id))
        .run();
      logActivity(tx, {
        entityType: ENTITY,
        entityId: id,
        user,
        action: "deleted",
        summary: `Usunięto szansę „${lead.title}”`,
      });
    });
    return c.json({ success: true, data: null });
  } catch (error) {
    return handleError(c, error, "usuwania szansy");
  }
});

app.post("/:id{[0-9]+}/restore", async (c) => {
  try {
    const user = getUser(c);
    const id = idParam(c);
    const lead = leadRow(id, true);
    if (!lead.deletedAt) throw new ApiError(409, "Szansa nie jest usunięta");
    db.transaction((tx) => {
      tx.update(schema.leads)
        .set({ deletedAt: null, updatedBy: user?.id ?? null, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.leads.id, id))
        .run();
      logActivity(tx, {
        entityType: ENTITY,
        entityId: id,
        user,
        action: "restored",
        summary: `Przywrócono szansę „${lead.title}”`,
      });
    });
    return c.json({ success: true, data: loadLead(db, id) });
  } catch (error) {
    return handleError(c, error, "przywracania szansy");
  }
});

// ---------------------------------------------------------------------------
// JSON osoby kontaktowej — współdzielony z /contacts (jeden kształt, jedno miejsce)
// ---------------------------------------------------------------------------

export interface ContactJson {
  id: number;
  contractorId: number | null;
  leadId: number | null;
  objectId: number | null;
  firstName: string;
  lastName: string;
  role: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  notes: string | null;
  active: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  contractorName: string | null;
  leadTitle: string | null;
  objectName: string | null;
  fullName: string;
}

export function contactJson(
  row: typeof schema.contacts.$inferSelect,
  extra: { contractorName?: string | null; leadTitle?: string | null; objectName?: string | null } = {}
): ContactJson {
  return {
    id: row.id,
    contractorId: row.contractorId,
    leadId: row.leadId,
    objectId: row.objectId,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    phone: row.phone,
    email: row.email,
    isPrimary: row.isPrimary,
    notes: row.notes,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contractorName: extra.contractorName ?? null,
    leadTitle: extra.leadTitle ?? null,
    objectName: extra.objectName ?? null,
    // Składane na backendzie, bo lista i pickery pokazują jedną etykietę,
    // a kolejność „Nazwisko Imię” bywa różna w różnych widokach.
    fullName: `${row.firstName} ${row.lastName}`.trim(),
  };
}

/** Re-eksport dla testów i routera kontaktów. */
export type { DbOrTx };

export default app;
