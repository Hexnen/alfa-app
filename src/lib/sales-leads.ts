/**
 * Helpery domenowe lejka handlowego (tabela `leads`).
 *
 * Reguła przewodnia modułu (activity-based selling): KAŻDA otwarta szansa ma zaplanowaną
 * następną aktywność. Brak takiej aktywności albo cisza dłuższa niż `SALES_ROT_DAYS`
 * = szansa „gnijąca” — i to backend o tym decyduje (`rotReason`), front tylko maluje.
 *
 * `leads.last_activity_at` jest DENORMALIZACJĄ: ustawia ją wyłącznie `touchLead`, wołane
 * z mutacji kalendarza (wydarzenie z `lead_id`), z notatek, ze zmiany etapu i z edycji
 * szansy. `recomputeLastActivity` odtwarza tę wartość z danych źródłowych — służy do
 * asercji w testach, nic nie zapisuje.
 *
 * better-sqlite3 jest synchroniczny — wszystkie funkcje są synchroniczne.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";
import { LEAD_OPEN_STAGES, type LeadStage } from "../db/schema.js";
import type { CalendarEventStatus, CalendarEventType } from "../db/schema.js";
import { zonedNow } from "./tz.js";
import { ApiError } from "./calendar-labels.js";

/** Ile dni ciszy wystarczy, żeby uznać otwartą szansę za gnijącą. */
export const SALES_ROT_DAYS = 7;

/** Skrót następnej (najbliższej przyszłej) aktywności szansy. */
export interface NextActivity {
  id: number;
  type: CalendarEventType;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
}

/** Powód „gnicia”: brak zaplanowanej aktywności albo cisza dłuższa niż próg. */
export type RotReason = "no_activity" | "idle" | null;

/**
 * Odbija znacznik ostatniego ruchu na szansie. `at` w formacie kolumn czasowych
 * bazy ("YYYY-MM-DD HH:MM:SS", UTC) — domyślnie `datetime('now')`.
 * Nieistniejąca / usunięta szansa jest po cichu pomijana: to znacznik pomocniczy,
 * a nie operacja, przez którą ma się wywrócić zapis wydarzenia.
 */
export function touchLead(tx: DbOrTx, leadId: number | null | undefined, at?: string): void {
  if (leadId == null) return;
  tx.update(schema.leads)
    .set({ lastActivityAt: at ?? sql`(datetime('now'))`, updatedAt: sql`(datetime('now'))` })
    .where(and(eq(schema.leads.id, leadId), isNull(schema.leads.deletedAt)))
    .run();
}

/**
 * Najbliższa PRZYSZŁA aktywność każdej szansy — jedno zapytanie dla całej listy.
 * Liczą się wydarzenia nieusunięte, nieanulowane i niewykonane; „przyszła” znaczy
 * kończąca się nie wcześniej niż teraz (czas lokalny aplikacji, jak `startAt` w bazie).
 */
export function nextActivityByLead(dbx: DbOrTx, ids: number[], now: string = zonedNow()): Map<number, NextActivity> {
  const out = new Map<number, NextActivity>();
  if (ids.length === 0) return out;
  const rows = dbx
    .select({
      leadId: schema.calendarEvents.leadId,
      id: schema.calendarEvents.id,
      type: schema.calendarEvents.type,
      title: schema.calendarEvents.title,
      startAt: schema.calendarEvents.startAt,
      endAt: schema.calendarEvents.endAt,
      allDay: schema.calendarEvents.allDay,
      status: schema.calendarEvents.status,
    })
    .from(schema.calendarEvents)
    .where(
      and(
        inArray(schema.calendarEvents.leadId, ids),
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled"),
        ne(schema.calendarEvents.status, "done"),
        sql`${schema.calendarEvents.endAt} >= ${now}`
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .all();
  for (const r of rows) {
    if (r.leadId == null || out.has(r.leadId)) continue; // pierwszy wiersz = najwcześniejszy
    out.set(r.leadId, { id: r.id, type: r.type, title: r.title, startAt: r.startAt, endAt: r.endAt, allDay: r.allDay, status: r.status });
  }
  return out;
}

/**
 * Ile aktywności szansy jest ZALEGŁYCH: termin minął, a nikt ich nie zamknął
 * (status inny niż „wykonane” i „anulowane”).
 */
export function overdueCountByLead(dbx: DbOrTx, ids: number[], now: string = zonedNow()): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const rows = dbx
    .select({ leadId: schema.calendarEvents.leadId, n: sql<number>`count(*)` })
    .from(schema.calendarEvents)
    .where(
      and(
        inArray(schema.calendarEvents.leadId, ids),
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled"),
        ne(schema.calendarEvents.status, "done"),
        sql`${schema.calendarEvents.endAt} < ${now}`
      )
    )
    .groupBy(schema.calendarEvents.leadId)
    .all();
  for (const r of rows) if (r.leadId != null) out.set(r.leadId, Number(r.n));
  return out;
}

/** Czy `iso` (UTC "YYYY-MM-DD HH:MM:SS" albo ISO) jest starsze niż `days` dni. */
function olderThanDays(iso: string | null | undefined, days: number, now: Date): boolean {
  if (!iso) return true;
  const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > days * 24 * 3600 * 1000;
}

/**
 * Czy szansa gnije. Zamknięte etapy (wygrany/przegrany) nie gniją NIGDY —
 * lejek pilnuje wyłącznie tego, co jeszcze da się dowieźć.
 */
export function rottingOf(
  lead: { stage: LeadStage; lastActivityAt: string | null; createdAt?: string },
  next: NextActivity | null | undefined,
  now: Date = new Date()
): { rotting: boolean; rotReason: RotReason } {
  if (!LEAD_OPEN_STAGES.includes(lead.stage)) return { rotting: false, rotReason: null };
  if (!next) return { rotting: true, rotReason: "no_activity" };
  if (olderThanDays(lead.lastActivityAt ?? lead.createdAt ?? null, SALES_ROT_DAYS, now)) {
    return { rotting: true, rotReason: "idle" };
  }
  return { rotting: false, rotReason: null };
}

/**
 * Odtwarza `last_activity_at` z danych źródłowych: najpóźniejszy ze znaczników
 * `leads.created_at`, `calendar_events.updated_at` (wydarzenia szansy) i
 * `calendar_event_notes.created_at` (notatki przy tych wydarzeniach).
 *
 * NIC NIE ZAPISUJE — służy do asercji w testach, że `touchLead` jest wołane
 * ze wszystkich mutacji, które powinny odbijać znacznik.
 */
export function recomputeLastActivity(dbx: DbOrTx, ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  for (const r of dbx
    .select({ id: schema.leads.id, createdAt: schema.leads.createdAt })
    .from(schema.leads)
    .where(inArray(schema.leads.id, ids))
    .all()) {
    out.set(r.id, r.createdAt);
  }
  const bump = (leadId: number | null, ts: string | null) => {
    if (leadId == null || !ts) return;
    const cur = out.get(leadId);
    if (cur == null || ts > cur) out.set(leadId, ts);
  };
  for (const r of dbx
    .select({ leadId: schema.calendarEvents.leadId, ts: sql<string>`max(${schema.calendarEvents.updatedAt})` })
    .from(schema.calendarEvents)
    .where(inArray(schema.calendarEvents.leadId, ids))
    .groupBy(schema.calendarEvents.leadId)
    .all()) {
    bump(r.leadId, r.ts);
  }
  for (const r of dbx
    .select({ leadId: schema.calendarEvents.leadId, ts: sql<string>`max(${schema.calendarEventNotes.createdAt})` })
    .from(schema.calendarEventNotes)
    .innerJoin(schema.calendarEvents, eq(schema.calendarEventNotes.eventId, schema.calendarEvents.id))
    .where(inArray(schema.calendarEvents.leadId, ids))
    .groupBy(schema.calendarEvents.leadId)
    .all()) {
    bump(r.leadId, r.ts);
  }
  return out;
}

/** Tytuł szansy do wpisów w dzienniku i komunikatów — odczyt PO ID, nigdy odwrotnie. */
export function leadTitleById(dbx: DbOrTx, id: number | null): string {
  if (id == null) return "—";
  // identity-ok: id → tytuł (migawka na opis zmiany), nie tytuł → id.
  const l = dbx.select({ title: schema.leads.title }).from(schema.leads).where(eq(schema.leads.id, id)).get(); // identity-ok
  return l ? l.title : `#${id}`;
}

/** Ostatnie szanse handlowca (pomocnicze; pełne `loadLeads` powstaje razem z /leads). */
export function recentLeadIds(dbx: DbOrTx, salespersonId: number, limit = 50): number[] {
  return dbx
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(and(eq(schema.leads.salespersonId, salespersonId), isNull(schema.leads.deletedAt)))
    .orderBy(desc(schema.leads.lastActivityAt), desc(schema.leads.id))
    .limit(limit)
    .all()
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// LeadJson — kontrakt z frontem (frontend/src/lib/api.ts, interfejs `Lead`)
// ---------------------------------------------------------------------------

/**
 * Szansa w postaci oddawanej przez API. Kolumny tabeli + pola DOKLEJANE na
 * backendzie: nazwy (kontrahent, handlowiec, obiekt, zlecenie), liczniki i —
 * najważniejsze — `nextActivity` / `rotting`, których front NIE liczy sam.
 */
export interface LeadJson {
  id: number;
  title: string;
  stage: LeadStage;
  source: string | null;
  contractorId: number | null;
  prospectName: string | null;
  prospectNip: string | null;
  prospectPhone: string | null;
  prospectEmail: string | null;
  objectKind: string | null;
  address: string | null;
  city: string | null;
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  services: string[];
  estimatedMonthly: number | null;
  estimatedSetup: number | null;
  probability: number | null;
  expectedCloseDate: string | null;
  salespersonId: number | null;
  objectId: number | null;
  orderId: number | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  lostNote: string | null;
  lastActivityAt: string | null;
  notes: string | null;
  createdBy: number | null;
  createdByLabel: string | null;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  contractorName: string | null;
  clientLabel: string;
  salespersonName: string | null;
  objectName: string | null;
  orderNumber: string | null;
  offersCount: number;
  contactsCount: number;
  nextActivity: NextActivity | null;
  overdueCount: number;
  rotting: boolean;
  rotReason: RotReason;
}

/** `services` z kolumny JSON: cokolwiek tam jest, na zewnątrz wychodzi tablica stringów. */
function serviceList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Batch po id (wzorzec `loadEvents` z calendar-queries.ts): jedno zapytanie na
 * wiersze + po jednym na każdy dokładany wymiar, nigdy N+1 na kartę. Wynik wraca
 * w KOLEJNOŚCI PODANYCH ID — sortowanie należy do wołającego, nie do helpera.
 */
export function loadLeads(dbx: DbOrTx, ids: number[], now: string = zonedNow()): LeadJson[] {
  if (ids.length === 0) return [];
  const rows = dbx
    .select({
      lead: schema.leads,
      contractorName: schema.contractors.name,
      spFirst: schema.salespeople.firstName,
      spLast: schema.salespeople.lastName,
      objectName: schema.objects.name,
      orderNumber: schema.orders.orderNumber,
      createdByLabel: sql<string | null>`coalesce(nullif(${schema.users.displayName}, ''), ${schema.users.email})`,
    })
    .from(schema.leads)
    .leftJoin(schema.contractors, eq(schema.contractors.id, schema.leads.contractorId))
    .leftJoin(schema.salespeople, eq(schema.salespeople.id, schema.leads.salespersonId))
    .leftJoin(schema.objects, eq(schema.objects.id, schema.leads.objectId))
    .leftJoin(schema.orders, eq(schema.orders.id, schema.leads.orderId))
    .leftJoin(schema.users, eq(schema.users.id, schema.leads.createdBy))
    .where(inArray(schema.leads.id, ids))
    .all();

  const next = nextActivityByLead(dbx, ids, now);
  const overdue = overdueCountByLead(dbx, ids, now);

  const offers = new Map<number, number>();
  for (const r of dbx
    .select({ leadId: schema.offers.leadId, n: sql<number>`count(*)` })
    .from(schema.offers)
    .where(inArray(schema.offers.leadId, ids))
    .groupBy(schema.offers.leadId)
    .all()) {
    if (r.leadId != null) offers.set(r.leadId, Number(r.n));
  }
  const contactsCount = new Map<number, number>();
  for (const r of dbx
    .select({ leadId: schema.contacts.leadId, n: sql<number>`count(*)` })
    .from(schema.contacts)
    .where(inArray(schema.contacts.leadId, ids))
    .groupBy(schema.contacts.leadId)
    .all()) {
    if (r.leadId != null) contactsCount.set(r.leadId, Number(r.n));
  }

  const nowDate = new Date();
  const byId = new Map<number, LeadJson>();
  for (const r of rows) {
    const l = r.lead;
    const na = next.get(l.id) ?? null;
    const rot = rottingOf({ stage: l.stage, lastActivityAt: l.lastActivityAt, createdAt: l.createdAt }, na, nowDate);
    const salespersonName =
      r.spFirst != null || r.spLast != null ? `${r.spFirst ?? ""} ${r.spLast ?? ""}`.trim() : null;
    byId.set(l.id, {
      id: l.id,
      title: l.title,
      stage: l.stage,
      source: l.source ?? null,
      contractorId: l.contractorId,
      prospectName: l.prospectName,
      prospectNip: l.prospectNip,
      prospectPhone: l.prospectPhone,
      prospectEmail: l.prospectEmail,
      objectKind: l.objectKind,
      address: l.address,
      city: l.city,
      mapsUrl: l.mapsUrl,
      lat: l.lat,
      lng: l.lng,
      services: serviceList(l.services),
      estimatedMonthly: l.estimatedMonthly,
      estimatedSetup: l.estimatedSetup,
      probability: l.probability,
      expectedCloseDate: l.expectedCloseDate,
      salespersonId: l.salespersonId,
      objectId: l.objectId,
      orderId: l.orderId,
      wonAt: l.wonAt,
      lostAt: l.lostAt,
      lostReason: l.lostReason ?? null,
      lostNote: l.lostNote,
      lastActivityAt: l.lastActivityAt,
      notes: l.notes,
      createdBy: l.createdBy,
      createdByLabel: r.createdByLabel ?? null,
      updatedBy: l.updatedBy,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      deletedAt: l.deletedAt,
      contractorName: r.contractorName ?? null,
      // Nazwa klienta na liście i kanbanie: kartoteka wygrywa z prospektem,
      // a gdy nie ma ani jednego — kreska (tytuł szansy stoi obok, nie dublujemy go).
      clientLabel: (r.contractorName ?? l.prospectName ?? "").trim() || "—",
      salespersonName,
      objectName: r.objectName ?? null,
      orderNumber: r.orderNumber ?? null,
      offersCount: offers.get(l.id) ?? 0,
      contactsCount: contactsCount.get(l.id) ?? 0,
      nextActivity: na,
      overdueCount: overdue.get(l.id) ?? 0,
      rotting: rot.rotting,
      rotReason: rot.rotReason,
    });
  }
  return ids.map((id) => byId.get(id)).filter((v): v is LeadJson => v !== undefined);
}

/** Jedna szansa albo `null` — cukier na `loadLeads` przy karcie. */
export function loadLead(dbx: DbOrTx, id: number, now?: string): LeadJson | null {
  return loadLeads(dbx, [id], now)[0] ?? null;
}

/**
 * Sprawdza, czy wskazane powiązania szansy istnieją. Rzuca `ApiError 400` —
 * nieistniejący kontrahent/handlowiec/obiekt to błąd żądania, nie „ciche null”,
 * bo szansa bez klienta zgubiłaby się w lejku bez śladu.
 */
export function assertLeadRefs(
  dbx: DbOrTx,
  refs: { contractorId?: number | null; salespersonId?: number | null; objectId?: number | null }
): void {
  if (refs.contractorId != null) {
    const row = dbx
      .select({ id: schema.contractors.id })
      .from(schema.contractors)
      .where(eq(schema.contractors.id, refs.contractorId))
      .get();
    if (!row) throw new ApiError(400, `Kontrahent #${refs.contractorId} nie istnieje`);
  }
  if (refs.salespersonId != null) {
    const row = dbx
      .select({ id: schema.salespeople.id })
      .from(schema.salespeople)
      .where(eq(schema.salespeople.id, refs.salespersonId))
      .get();
    if (!row) throw new ApiError(400, `Handlowiec #${refs.salespersonId} nie istnieje`);
  }
  if (refs.objectId != null) {
    const row = dbx
      .select({ id: schema.objects.id })
      .from(schema.objects)
      .where(eq(schema.objects.id, refs.objectId))
      .get();
    if (!row) throw new ApiError(400, `Obiekt #${refs.objectId} nie istnieje`);
  }
}

/**
 * Handlowiec przypisany do konta — jedyne źródło filtra „Moje" (`salespersonId=me`).
 * Bez dopasowania zwraca `null`, a router oddaje wtedy PUSTY zbiór: „moje szanse"
 * kogoś, kto nie jest handlowcem, to zero szans, a nie wszystkie.
 */
export function salespersonIdForUser(dbx: DbOrTx, userId: number | null | undefined): number | null {
  if (userId == null) return null;
  const row = dbx
    .select({ id: schema.salespeople.id })
    .from(schema.salespeople)
    .where(eq(schema.salespeople.userId, userId))
    .get();
  return row ? row.id : null;
}
