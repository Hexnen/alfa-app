/**
 * Wydarzenia kalendarza → Realizacje (+ protokoły) — automatyczna synchronizacja.
 *
 * Funkcje wołane WEWNĄTRZ transakcji z src/lib/calendar-mutations.ts (create/update/move/
 * delete/restore), więc obejmują też asystenta AI (POST /assistant/apply-changes) i backfill.
 * Logowanie wyłącznie przez `logActivity` z `ctx.summarySuffix` — zero duplikacji activity_log.
 *
 * Zasady (sterowane ustawieniami `calendar.*`, src/lib/calendar-config.ts):
 *  - realizacja powstaje tylko dla typów objętych (domyślnie serwis/montaż/wizja/demontaż/konserwacja),
 *  - kwot NIGDY nie dotykamy (amountHours, amountMaterial, amountKm, discount, hourlyCost,
 *    actualKm i caretaker należą do księgowości),
 *  - realizacja ZAFAKTUROWANA (`invoiced`) i protokół PODPISANY (`signedAt`) są nietykalne,
 *  - anulowanie/usunięcie wydarzenia kasuje realizację tylko wtedy, gdy jest „nietknięta”.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { CalendarEvent as CalendarEventRow, CalendarEventType, NewRealization, Realization } from "../db/schema.js";
import { logActivity, type ActivityUser, type DbOrTx, type Tx } from "./activity-log.js";
import { getCalendarConfig, isRealizationType, type CalendarSettingsValues } from "./calendar-config.js";
import { diffMinutes } from "./calendar-recurrence.js";
import { createProtocolForRealizationSync } from "../routes/protocols.js";

export const CALENDAR_ENTITY = "calendar_event";

/** Kto wykonuje zmianę (ten sam kształt co MutationCtx z calendar-mutations.ts). */
export interface RealizationCtx {
  user: ActivityUser & { id: number };
  summarySuffix?: string | null;
}

/** Rodzaj realizacji wg typu i rozliczenia wydarzenia. */
export type RealizationKind = "service" | "warranty" | "installation";

export interface MappedRealization {
  date: string;
  site: string;
  kind: RealizationKind;
  contractor1: string;
  contractor2: string;
  actualHours: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Mapowanie wydarzenie → realizacja
// ---------------------------------------------------------------------------

/** Nazwiska techników wydarzenia w kolejności przypisania (rowid tabeli N:M). */
function eventTechnicianNames(dbx: DbOrTx, eventId: number): string[] {
  const rows = dbx
    .select({ firstName: schema.technicians.firstName, lastName: schema.technicians.lastName })
    .from(schema.calendarEventAssignees)
    .innerJoin(schema.technicians, eq(schema.technicians.id, schema.calendarEventAssignees.technicianId))
    .where(eq(schema.calendarEventAssignees.eventId, eventId))
    .orderBy(asc(sql`calendar_event_assignees.rowid`))
    .all();
  return rows.map((t) => `${t.firstName} ${t.lastName}`.trim()).filter(Boolean);
}

function objectNameById(dbx: DbOrTx, id: number | null): string | null {
  if (id == null) return null;
  const o = dbx.select({ name: schema.objects.name }).from(schema.objects).where(eq(schema.objects.id, id)).get();
  return o?.name ?? null;
}

/** Rodzaj realizacji: gwarancja z rozliczenia, montaż z typu, w pozostałych serwis. */
export function realizationKindOf(ev: Pick<CalendarEventRow, "type" | "billing">): RealizationKind {
  if (ev.billing === "warranty") return "warranty";
  if (ev.type === "montaz") return "installation";
  return "service";
}

/** Długość wydarzenia w godzinach zaokrąglona do 0,25 (all-day → 0). */
export function eventHours(ev: Pick<CalendarEventRow, "startAt" | "endAt" | "allDay">): number {
  if (ev.allDay) return 0;
  const minutes = diffMinutes(ev.startAt, ev.endAt);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round((minutes / 60) * 4) / 4;
}

/** Adnotacja realizacji: „[Kalendarz #12] Tytuł — opis (do 200 zn.)”. */
export function realizationNote(ev: Pick<CalendarEventRow, "id" | "title" | "description">): string {
  const desc = (ev.description || "").replace(/\s+/g, " ").trim();
  const clipped = desc.length > 200 ? `${desc.slice(0, 199)}…` : desc;
  return `[Kalendarz #${ev.id}] ${ev.title}${clipped ? ` — ${clipped}` : ""}`;
}

/**
 * Pola realizacji wyliczone z wydarzenia. Kwoty (amount*, discount), `caretaker`,
 * `hourlyCost` i `actualKm` NIE są tu ustawiane — przy tworzeniu zostają domyślne (0/puste),
 * przy synchronizacji nigdy ich nie nadpisujemy.
 */
export function mapEventToRealization(dbx: DbOrTx, ev: CalendarEventRow): MappedRealization {
  const names = eventTechnicianNames(dbx, ev.id);
  const site = objectNameById(dbx, ev.objectId) || (ev.location || "").trim() || ev.title;
  return {
    date: ev.startAt.slice(0, 10),
    site,
    kind: realizationKindOf(ev),
    contractor1: names[0] ?? "",
    contractor2: names[1] ?? "",
    actualHours: eventHours(ev),
    note: realizationNote(ev),
  };
}

// ---------------------------------------------------------------------------
// Helpery
// ---------------------------------------------------------------------------

function realizationById(dbx: DbOrTx, id: number): Realization | undefined {
  return dbx.select().from(schema.realizations).where(eq(schema.realizations.id, id)).get();
}

/** Protokół realizacji (1:1, może nie istnieć przy danych z importu). */
function protocolOfRealization(dbx: DbOrTx, realizationId: number) {
  return dbx
    .select({ id: schema.protocols.id, number: schema.protocols.number, signedAt: schema.protocols.signedAt, status: schema.protocols.status })
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, realizationId))
    .get();
}

/** Realizacja „nietknięta”: bez kwot, niezafakturowana, protokół niepodpisany. */
export function isRealizationUntouched(dbx: DbOrTx, r: Realization): boolean {
  if (r.invoiced) return false;
  if (r.amountHours + r.amountMaterial + r.amountKm + r.discount !== 0) return false;
  const p = protocolOfRealization(dbx, r.id);
  return !p || (p.signedAt == null && p.status !== "final");
}

function logForEvent(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx, input: { action: "linked" | "unlinked" | "updated"; summary: string; field?: string; oldValue?: string | number | null; newValue?: string | number | null }) {
  logActivity(tx, {
    entityType: CALENDAR_ENTITY,
    entityId: ev.id,
    objectId: ev.objectId,
    user: ctx.user,
    summarySuffix: ctx.summarySuffix,
    action: input.action,
    field: input.field ?? "realization",
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    summary: input.summary,
  });
}

/** "2026-08-27" → "27.08" (dopisek w adnotacji realizacji). */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// ensure — utworzenie realizacji (+ protokołu) dla wydarzenia
// ---------------------------------------------------------------------------

export type EnsureResult =
  | { created: true; realizationId: number; protocolNumber: string | null }
  | { created: false; reason: string };

export interface EnsureOptions {
  /** Pomija bramkę `calendar.auto_realization` (ręczne „Uzupełnij zaległe” w panelu admina). */
  force?: boolean;
  /** Gotowa konfiguracja (żeby nie czytać ustawień w pętli backfillu). */
  config?: CalendarSettingsValues;
}

/** Powód, dla którego realizacja nie powstanie — bez zapisu do bazy (podgląd backfillu). */
export function ensureBlockedReason(ev: CalendarEventRow, opts: EnsureOptions = {}): string | null {
  const cfg = opts.config ?? getCalendarConfig().values;
  if (ev.deletedAt) return "wydarzenie usunięte";
  if (ev.realizationId != null) return "realizacja już podpięta";
  if (!isRealizationType(ev.type as CalendarEventType, cfg)) return "typ nieobjęty";
  if (ev.status === "cancelled") return "wydarzenie anulowane";
  // Ręczne „Odepnij” wygrywa nawet z backfillem (force) — użytkownik świadomie wyłączył automat.
  if (ev.realizationOptout) return "ręcznie odpięte";
  if (opts.force) return null;
  if (cfg.autoRealization === "off") return "ustawienie: nigdy (tylko ręczne podpięcie)";
  if (cfg.autoRealization === "on_done" && ev.status !== "done") return "ustawienie: dopiero po oznaczeniu jako wykonane";
  return null;
}

/**
 * Tworzy realizację + protokół (szkic) dla wydarzenia i podpina ją pod `calendar_events.realization_id`.
 * Idempotentne: gdy wydarzenie ma już realizację albo ustawienie nie pozwala — nic nie robi.
 */
export function ensureRealizationForEvent(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx, opts: EnsureOptions = {}): EnsureResult {
  const reason = ensureBlockedReason(ev, opts);
  if (reason) return { created: false, reason };

  const mapped = mapEventToRealization(tx, ev);
  const created = tx
    .insert(schema.realizations)
    .values(mapped as NewRealization)
    .returning()
    .get();
  const protocol = createProtocolForRealizationSync(tx, created);
  tx.update(schema.calendarEvents)
    .set({ realizationId: created.id, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEvents.id, ev.id))
    .run();
  ev.realizationId = created.id;

  logForEvent(tx, ev, ctx, {
    action: "linked",
    summary: `Utworzono realizację #${created.id}${protocol ? ` i protokół ${protocol.number}` : ""} (${mapped.site}, ${mapped.date})`,
    newValue: created.id,
  });
  return { created: true, realizationId: created.id, protocolNumber: protocol?.number ?? null };
}

// ---------------------------------------------------------------------------
// sync — aktualizacja realizacji po edycji wydarzenia
// ---------------------------------------------------------------------------

/**
 * Przenosi zmiany wydarzenia na powiązaną realizację (date/site/kind/wykonawcy/godziny/adnotacja)
 * oraz na jej NIEPODPISANY protokół (workDate/workType/contractor). Kwot nie dotyka.
 * Realizacja zafakturowana albo protokół podpisany → bez zmian, tylko ostrzeżenie w activity_log.
 */
export function syncRealizationFromEvent(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx, opts: EnsureOptions = {}): void {
  const cfg = opts.config ?? getCalendarConfig().values;
  if (!cfg.realizationSync || ev.realizationId == null) return;
  const r = realizationById(tx, ev.realizationId);
  if (!r) return;

  const mapped = mapEventToRealization(tx, ev);
  const changed =
    r.date !== mapped.date ||
    r.site !== mapped.site ||
    r.kind !== mapped.kind ||
    (r.contractor1 ?? "") !== mapped.contractor1 ||
    (r.contractor2 ?? "") !== mapped.contractor2 ||
    r.actualHours !== mapped.actualHours ||
    (r.note ?? "") !== mapped.note;
  if (!changed) return;

  const protocol = protocolOfRealization(tx, r.id);
  const protocolSigned = !!protocol && (protocol.signedAt != null || protocol.status === "final");
  if (r.invoiced || protocolSigned) {
    logForEvent(tx, ev, ctx, {
      action: "updated",
      summary: r.invoiced
        ? `Realizacja #${r.id} jest zafakturowana — nie zsynchronizowano zmian wydarzenia`
        : `Protokół ${protocol!.number} jest podpisany — nie zsynchronizowano realizacji #${r.id}`,
      oldValue: r.id,
      newValue: r.id,
    });
    return;
  }

  tx.update(schema.realizations)
    .set({
      date: mapped.date,
      site: mapped.site,
      kind: mapped.kind,
      contractor1: mapped.contractor1,
      contractor2: mapped.contractor2,
      actualHours: mapped.actualHours,
      note: mapped.note,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(schema.realizations.id, r.id))
    .run();

  if (protocol) {
    tx.update(schema.protocols)
      .set({
        workDate: mapped.date,
        workType: mapped.kind === "installation" ? "montaz" : "serwis",
        contractor: [mapped.contractor1, mapped.contractor2].filter(Boolean).join(", "),
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(eq(schema.protocols.id, protocol.id), isNull(schema.protocols.signedAt)))
      .run();
  }

  const bits: string[] = [];
  if (r.date !== mapped.date) bits.push(`data ${r.date} → ${mapped.date}`);
  if (r.site !== mapped.site) bits.push(`obiekt ${r.site} → ${mapped.site}`);
  if (r.kind !== mapped.kind) bits.push(`rodzaj ${r.kind} → ${mapped.kind}`);
  if ((r.contractor1 ?? "") !== mapped.contractor1 || (r.contractor2 ?? "") !== mapped.contractor2) {
    bits.push(`wykonawcy → ${[mapped.contractor1, mapped.contractor2].filter(Boolean).join(", ") || "—"}`);
  }
  if (r.actualHours !== mapped.actualHours) bits.push(`godziny ${r.actualHours} → ${mapped.actualHours}`);
  logForEvent(tx, ev, ctx, {
    action: "updated",
    summary: `Zaktualizowano realizację #${r.id}${bits.length ? `: ${bits.join(", ")}` : ""}`,
    oldValue: r.id,
    newValue: r.id,
  });
}

// ---------------------------------------------------------------------------
// detach — anulowanie / usunięcie wydarzenia albo zmiana typu na nieobjęty
// ---------------------------------------------------------------------------

export type DetachResult = { action: "none" } | { action: "deleted"; realizationId: number } | { action: "kept"; realizationId: number };

/**
 * Odpina realizację od wydarzenia: „nietkniętą” (bez kwot, niezafakturowaną, z niepodpisanym
 * protokołem) usuwa razem z protokołem, w przeciwnym razie zostawia i dopisuje adnotację.
 */
export function detachRealizationForEvent(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx, reason: string): DetachResult {
  if (ev.realizationId == null) return { action: "none" };
  const r = realizationById(tx, ev.realizationId);
  if (!r) {
    tx.update(schema.calendarEvents).set({ realizationId: null }).where(eq(schema.calendarEvents.id, ev.id)).run();
    ev.realizationId = null;
    return { action: "none" };
  }

  const oldId = r.id;
  if (isRealizationUntouched(tx, r)) {
    // Kolejność: najpierw odpięcie (unikalny indeks), potem protokół i realizacja.
    tx.update(schema.calendarEvents)
      .set({ realizationId: null, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.calendarEvents.id, ev.id))
      .run();
    tx.delete(schema.protocols).where(eq(schema.protocols.realizationId, oldId)).run();
    tx.delete(schema.realizations).where(eq(schema.realizations.id, oldId)).run();
    ev.realizationId = null;
    logForEvent(tx, ev, ctx, { action: "unlinked", summary: `Usunięto realizację #${oldId} (${reason})`, oldValue: oldId });
    return { action: "deleted", realizationId: oldId };
  }

  const mark = `[Wydarzenie anulowane ${shortDate(new Date().toISOString())}]`;
  const note = (r.note ?? "").includes(mark) ? (r.note ?? "") : `${r.note ?? ""} ${mark}`.trim();
  tx.update(schema.realizations)
    .set({ note, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.realizations.id, oldId))
    .run();
  logForEvent(tx, ev, ctx, {
    action: "updated",
    summary: `Realizacja #${oldId} ma już kwoty lub podpis — zostawiono ją (${reason}); dopisano adnotację`,
    oldValue: oldId,
    newValue: oldId,
  });
  return { action: "kept", realizationId: oldId };
}

// ---------------------------------------------------------------------------
// Punkty wejścia dla calendar-mutations.ts
// ---------------------------------------------------------------------------

/** Po utworzeniu wydarzenia. */
export function onEventCreated(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx): void {
  ensureRealizationForEvent(tx, ev, ctx);
}

/**
 * Po edycji wydarzenia (PUT, move, zmiana statusu). Rozstrzyga: odpiąć (typ nieobjęty /
 * anulowane), utworzyć (brak realizacji, ustawienie pozwala) albo zsynchronizować.
 */
export function onEventUpdated(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx): void {
  const cfg = getCalendarConfig().values;
  if (ev.deletedAt) return;
  if (!isRealizationType(ev.type as CalendarEventType, cfg)) {
    detachRealizationForEvent(tx, ev, ctx, "typ wydarzenia poza realizacjami");
    return;
  }
  if (ev.status === "cancelled") {
    detachRealizationForEvent(tx, ev, ctx, "wydarzenie anulowane");
    return;
  }
  if (ev.realizationId == null) {
    ensureRealizationForEvent(tx, ev, ctx, { config: cfg });
    return;
  }
  syncRealizationFromEvent(tx, ev, ctx, { config: cfg });
}

/** Po soft-delete wydarzenia. */
export function onEventDeleted(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx): void {
  detachRealizationForEvent(tx, ev, ctx, "wydarzenie usunięte");
}

/** Po przywróceniu wydarzenia — realizacja powstaje na nowo, gdy poprzednia została usunięta. */
export function onEventRestored(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx): void {
  ensureRealizationForEvent(tx, ev, ctx);
}

// ---------------------------------------------------------------------------
// Backfill — uzupełnienie realizacji dla istniejących wydarzeń
// (panel admina: POST /admin/calendar/backfill-realizations, CLI: scripts/backfill-realizations.ts)
// ---------------------------------------------------------------------------

export interface BackfillCandidate {
  eventId: number;
  title: string;
  startAt: string;
  type: CalendarEventType;
  /** Obiekt realizacji wyliczony z wydarzenia (objectName → location → tytuł). */
  site: string;
}

export interface BackfillCreated {
  eventId: number;
  realizationId: number;
  protocolNumber: string | null;
}

export interface BackfillSkipped {
  eventId: number;
  reason: string;
}

export interface BackfillResult {
  candidates: BackfillCandidate[];
  created?: BackfillCreated[];
  skipped: BackfillSkipped[];
}

export interface BackfillOptions {
  /** Tylko wydarzenia od tej daty (YYYY-MM-DD). Brak = wszystkie. */
  from?: string | null;
  /** true = tylko podgląd (bez zapisu). */
  dryRun: boolean;
}

/** Wydarzenia bez realizacji, których typ jest objęty (nieusunięte, nieanulowane). */
function backfillRows(dbx: DbOrTx, types: CalendarEventType[], from?: string | null): CalendarEventRow[] {
  if (types.length === 0) return [];
  const conds = [
    isNull(schema.calendarEvents.deletedAt),
    isNull(schema.calendarEvents.realizationId),
    inArray(schema.calendarEvents.type, types),
  ];
  if (from) conds.push(sql`${schema.calendarEvents.startAt} >= ${from}`);
  return dbx
    .select()
    .from(schema.calendarEvents)
    .where(and(...conds))
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .limit(2000)
    .all();
}

/**
 * Uzupełnia realizacje dla zaległych wydarzeń. `dryRun` zwraca sam podgląd (bez zapisu);
 * tryb zapisu wymusza utworzenie niezależnie od `calendar.auto_realization` (świadoma akcja admina),
 * ale respektuje listę objętych typów. Wołający otwiera transakcję.
 */
export function runBackfill(tx: Tx, ctx: RealizationCtx, opts: BackfillOptions): BackfillResult {
  const cfg = getCalendarConfig().values;
  const types = cfg.realizationTypes.filter((t) => isRealizationType(t, cfg));
  const rows = backfillRows(tx, types, opts.from);

  const candidates: BackfillCandidate[] = [];
  const created: BackfillCreated[] = [];
  const skipped: BackfillSkipped[] = [];

  for (const ev of rows) {
    const mapped = mapEventToRealization(tx, ev);
    candidates.push({ eventId: ev.id, title: ev.title, startAt: ev.startAt, type: ev.type, site: mapped.site });
    const reason = ensureBlockedReason(ev, { force: true, config: cfg });
    if (reason) {
      skipped.push({ eventId: ev.id, reason });
      continue;
    }
    if (opts.dryRun) continue;
    const res = ensureRealizationForEvent(tx, ev, ctx, { force: true, config: cfg });
    if (res.created) created.push({ eventId: ev.id, realizationId: res.realizationId, protocolNumber: res.protocolNumber });
    else skipped.push({ eventId: ev.id, reason: res.reason });
  }

  return opts.dryRun ? { candidates, skipped } : { candidates, created, skipped };
}
