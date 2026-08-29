/**
 * Wydarzenia kalendarza → Realizacje (+ protokoły, + wyceny) — automatyczna synchronizacja.
 *
 * Funkcje wołane WEWNĄTRZ transakcji z src/lib/calendar-mutations.ts (create/update/move/
 * delete/restore), więc obejmują też asystenta AI (POST /assistant/apply-changes) i backfill.
 * Logowanie wyłącznie przez `logActivity` z `ctx.summarySuffix` — zero duplikacji activity_log.
 *
 * Zasady (sterowane ustawieniami `calendar.*`, src/lib/calendar-config.ts):
 *  - realizacja powstaje tylko dla typów objętych (domyślnie serwis/montaż/wizja/demontaż/konserwacja),
 *  - wycena powstaje TYLKO dla rozliczenia „płatne” (`calendar.auto_quote`); zmiana rozliczenia
 *    na gwarancyjne/darmowe kasuje wycenę, o ile nikt nie wpisał w niej ilości,
 *  - kwot NIGDY nie dotykamy (amountHours, amountMaterial, amountKm, discount, hourlyCost,
 *    actualKm i caretaker należą do księgowości),
 *  - realizacja ZAFAKTUROWANA (`invoiced`) i protokół PODPISANY (`signedAt`) są nietykalne,
 *  - anulowanie/usunięcie wydarzenia kasuje realizację tylko wtedy, gdy jest „nietknięta”,
 *  - oznaczenie wydarzenia jako „wykonane” WSTĘPNIE podlicza realizację (godziny, km, stawki)
 *    — bez czekania na podpis protokołu; sterowane `company.autofill_on_event_done`.
 */
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type {
  CalendarEvent as CalendarEventRow,
  CalendarEventType,
  NewRealization,
  Realization,
  RealizationBilling,
  RealizationWorkType,
} from "../db/schema.js";
import {
  realizationBillingOf,
  realizationKindFrom,
  realizationWorkTypeOf,
  REALIZATION_BILLING_LABELS,
  REALIZATION_WORK_TYPE_LABELS,
} from "./realization-kind.js";
import { logActivity, type ActivityUser, type DbOrTx, type Tx } from "./activity-log.js";
import { getCalendarConfig, isRealizationType, type CalendarSettingsValues } from "./calendar-config.js";
import { diffMinutes } from "./calendar-recurrence.js";
import { createProtocolForRealizationSync } from "../routes/protocols.js";
import { createQuoteForRealizationSync, isQuoteUntouched } from "../routes/quotes.js";
import { workTypeFromEventType, workTypeFromKind } from "./protocol-prefill.js";

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
  /**
   * Obiekt z kartoteki — KLUCZ, przepisany wprost z `calendar_events.object_id`.
   * Wydarzenie zna obiekt po id, więc realizacja dostaje go od razu; bez tego za
   * miesiąc znowu byłyby realizacje bez FK, a jedyną „tożsamością" zostałby tekst
   * (patrz src/lib/object-identity.ts — 29 z 289 błędnych trafień po nazwie).
   * NULL = wydarzenie bez obiektu (np. wpisane samym adresem w „Lokalizacja").
   */
  objectId: number | null;
  /** Nazwa obiektu w chwili prac — MIGAWKA na dokument, nie klucz. */
  site: string;
  /** Rodzaj prac — wprost z typu wydarzenia. */
  workType: RealizationWorkType;
  /** Typ rozliczenia — wprost z `calendar_events.billing` (NULL → płatny). */
  billing: RealizationBilling;
  /** Pole zgodnościowe, wyliczane z pary powyżej. */
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

/** Nazwa obiektu na MIGAWKĘ `realizations.site` — odczyt PO ID (klucz idzie osobno). */
function objectNameById(dbx: DbOrTx, id: number | null): string | null {
  if (id == null) return null;
  // identity-ok: id → nazwa. Nazwa nigdy nie wraca tu jako kryterium wyszukiwania.
  const o = dbx.select({ name: schema.objects.name }).from(schema.objects).where(eq(schema.objects.id, id)).get(); // identity-ok
  return o?.name ?? null;
}

/**
 * Pole zgodnościowe `kind` dla wydarzenia. Rodzaj i typ realizacji biorą się
 * teraz wprost z `type`/`billing` wydarzenia (patrz `mapEventToRealization`);
 * ta funkcja liczy już tylko stary, jednowymiarowy skrót.
 */
export function realizationKindOf(ev: Pick<CalendarEventRow, "type" | "billing">): RealizationKind {
  return realizationKindFrom(realizationWorkTypeOf(ev.type), realizationBillingOf(ev.billing));
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
  const workType = realizationWorkTypeOf(ev.type);
  const billing = realizationBillingOf(ev.billing);
  return {
    date: ev.startAt.slice(0, 10),
    objectId: ev.objectId ?? null,
    site,
    workType,
    billing,
    kind: realizationKindFrom(workType, billing),
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
    .select({
      id: schema.protocols.id,
      number: schema.protocols.number,
      signedAt: schema.protocols.signedAt,
      status: schema.protocols.status,
      actualHours: schema.protocols.actualHours,
    })
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, realizationId))
    .get();
}

/** Wycena realizacji (1:1, istnieje tylko dla prac płatnych). */
function quoteOfRealization(dbx: DbOrTx, realizationId: number) {
  return dbx
    .select({ id: schema.quotes.id, number: schema.quotes.number, date: schema.quotes.date, objectId: schema.quotes.objectId, site: schema.quotes.site, items: schema.quotes.items })
    .from(schema.quotes)
    .where(eq(schema.quotes.realizationId, realizationId))
    .get();
}

/**
 * Realizacja „nietknięta”: bez kwot, niezafakturowana, protokół niepodpisany
 * i wycena bez wpisanych ilości. Każdy z tych śladów to praca człowieka —
 * automat wtedy niczego nie kasuje.
 */
export function isRealizationUntouched(dbx: DbOrTx, r: Realization): boolean {
  if (r.invoiced) return false;
  if (r.amountHours + r.amountMaterial + r.amountKm + r.discount !== 0) return false;
  const p = protocolOfRealization(dbx, r.id);
  if (p && (p.signedAt != null || p.status === "final")) return false;
  const q = quoteOfRealization(dbx, r.id);
  return !q || isQuoteUntouched(q);
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

// ---------------------------------------------------------------------------
// Wstępne podliczenie realizacji po oznaczeniu wydarzenia jako „wykonane”
//
// `computeAutofill` jest ASYNCHRONICZNE (kalkulacja dystansu), a `applySuggestions` otwiera
// własną, krótką transakcję — nie da się (i nie wolno) tego zrobić wewnątrz synchronicznej
// transakcji zapisu wydarzenia. Dlatego hak trafia do kolejki, którą opróżniamy dopiero PO
// commicie (`setImmediate`; better-sqlite3 jest synchroniczny, więc transakcja jest już
// zamknięta, zanim event loop odda sterowanie). Konsekwencje:
//   - błąd kalkulacji / brak wpisu w `geo_cache` NIGDY nie wywróci zapisu wydarzenia,
//   - gdy transakcja się wycofa, realizacja nie będzie istnieć → hak po prostu nic nie zrobi.
// `flushEventDoneAutofill()` pozwala poczekać na wynik (testy, ścieżki, które chcą go pokazać).
// ---------------------------------------------------------------------------

interface PendingEventDoneAutofill {
  realizationId: number;
  eventId: number;
  user: ActivityUser;
}

const pendingEventDone: PendingEventDoneAutofill[] = [];
let flushScheduled = false;
let flushInFlight: Promise<void> | null = null;

/** Wynik jednego podliczenia — zwracany przez `flushEventDoneAutofill` (diagnostyka i testy). */
export interface EventDoneAutofillOutcome {
  realizationId: number;
  eventId: number;
  applied: string[];
  warnings: string[];
}

/** Wyniki ostatnich podliczeń — odczytywane (i czyszczone) przez `flushEventDoneAutofill`. */
const doneOutcomes: EventDoneAutofillOutcome[] = [];
const OUTCOMES_CAP = 50;

function queueEventDoneAutofill(entry: PendingEventDoneAutofill): void {
  // Ta sama realizacja w jednej transakcji (np. seria + sync) = jedno podliczenie.
  if (pendingEventDone.some((p) => p.realizationId === entry.realizationId)) return;
  pendingEventDone.push(entry);
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    void runFlush();
  });
}

async function drainEventDoneAutofill(): Promise<void> {
  // Import dynamiczny: realization-autofill.ts importuje `eventHours` z tego modułu,
  // statyczny import w drugą stronę zamknąłby cykl.
  const { autofillAfterEventDone } = await import("./realization-autofill.js");
  while (pendingEventDone.length > 0) {
    const entry = pendingEventDone.shift()!;
    try {
      // Dopisek zawsze „(przez automat)” — liczy automat, niezależnie od tego, kto (człowiek
      // czy asystent) oznaczył wydarzenie jako wykonane.
      const res = await autofillAfterEventDone(entry.realizationId, {
        user: entry.user,
        eventId: entry.eventId,
      });
      doneOutcomes.push({
        realizationId: entry.realizationId,
        eventId: entry.eventId,
        applied: res?.applied ?? [],
        warnings: res?.warnings ?? [],
      });
    } catch (err) {
      // Hak ma własny try/catch — to tylko ostatnia siatka bezpieczeństwa.
      console.error("Wstępne podliczenie realizacji nie powiodło się:", err);
    }
  }
  if (doneOutcomes.length > OUTCOMES_CAP) doneOutcomes.splice(0, doneOutcomes.length - OUTCOMES_CAP);
}

/** Czeka na trwające podliczenie i opróżnia kolejkę. Nigdy nie rzuca. */
async function runFlush(): Promise<void> {
  flushScheduled = false;
  while (flushInFlight) await flushInFlight;
  if (pendingEventDone.length === 0) return;
  flushInFlight = drainEventDoneAutofill().finally(() => {
    flushInFlight = null;
  });
  await flushInFlight;
}

/**
 * Opróżnia kolejkę wstępnych podliczeń i zwraca ich wyniki (od poprzedniego wywołania).
 * W produkcji kolejka opróżnia się sama z `setImmediate`; ta funkcja jest po to, żeby
 * testy (i ewentualne trasy) mogły na wynik POCZEKAĆ.
 */
export async function flushEventDoneAutofill(): Promise<EventDoneAutofillOutcome[]> {
  await runFlush();
  return doneOutcomes.splice(0, doneOutcomes.length);
}

/** "2026-08-27" → "27.08" (dopisek w adnotacji realizacji). */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Wyceny — dokument „za ile” dla prac PŁATNYCH
//
// Wycena wisi na realizacji (1:1, jak protokół), ale o jej istnieniu decyduje
// ROZLICZENIE wydarzenia: płatne → wycena jest, gwarancyjne/darmowe → jej nie ma.
// Automat nigdy nie dotyka pozycji ani cen — pilnuje tylko istnienia dokumentu
// oraz jego „metryczki” (data, obiekt).
// ---------------------------------------------------------------------------

export type QuoteSyncAction = "none" | "created" | "updated" | "deleted" | "kept";

export interface QuoteSyncResult {
  action: QuoteSyncAction;
  quoteId?: number;
  number?: string;
}

export interface QuoteSyncOptions extends EnsureOptions {
  /** Realizacja, jeśli wołający właśnie ją odczytał/utworzył (oszczędza zapytanie). */
  realization?: Realization;
  /** Nie loguj utworzenia — wołający dopisze wycenę do własnego wpisu w activity_log. */
  silent?: boolean;
  /**
   * Rozliczenie sprzed zapisu. Ostrzeżenie „zostawiono wycenę” ma sens tylko wtedy,
   * gdy rozliczenie właśnie się zmieniło — inaczej każda edycja gwarancyjnego
   * wydarzenia z wypełnioną wyceną dopisywałaby ten sam wpis do historii.
   */
  billingBefore?: CalendarEventRow["billing"];
}

/**
 * Uzgadnia wycenę realizacji ze stanem wydarzenia:
 *  - płatne bez wyceny → tworzy szkic z cennika (o ile `calendar.auto_quote` włączone),
 *  - płatne z wyceną   → dociąga datę i obiekt (pozycji, cen i ilości nie rusza),
 *  - niepłatne z wyceną→ kasuje ją, ale TYLKO gdy nikt nie wpisał w niej ilości.
 * Realizacja zafakturowana jest nietykalna. Zwraca to, co zrobił (dla wpisu wołającego).
 */
export function syncQuoteForEvent(
  tx: Tx,
  ev: CalendarEventRow,
  ctx: RealizationCtx,
  opts: QuoteSyncOptions = {}
): QuoteSyncResult {
  if (ev.realizationId == null) return { action: "none" };
  const cfg = opts.config ?? getCalendarConfig().values;
  const r = opts.realization ?? realizationById(tx, ev.realizationId);
  if (!r) return { action: "none" };

  const existing = quoteOfRealization(tx, r.id);
  const paid = realizationBillingOf(ev.billing) === "paid";

  // --- rozliczenie inne niż płatne: wycena nie ma racji bytu -----------------
  if (!paid) {
    if (!existing) return { action: "none" };
    if (r.invoiced || !isQuoteUntouched(existing)) {
      if (!("billingBefore" in opts) || opts.billingBefore !== ev.billing) {
        logForEvent(tx, ev, ctx, {
          action: "updated",
          field: "quote",
          summary:
            `Rozliczenie nie jest płatne, ale wycena ${existing.number} ` +
            (r.invoiced ? "wisi na zafakturowanej realizacji" : "ma już wpisane ilości") +
            " — zostawiono ją do ręcznej decyzji",
          oldValue: existing.id,
          newValue: existing.id,
        });
      }
      return { action: "kept", quoteId: existing.id, number: existing.number };
    }
    // Jawne przypięcia zdejmujemy sami: bazy sprzed migracji 0043 mają FK bez
    // ON DELETE SET NULL (drizzle-kit nie emituje tej klauzuli przy ADD COLUMN),
    // więc usunięcie wyceny wywróciłoby się na FOREIGN KEY constraint failed.
    tx.update(schema.calendarEvents)
      .set({ quoteId: null })
      .where(eq(schema.calendarEvents.quoteId, existing.id))
      .run();
    tx.delete(schema.quotes).where(eq(schema.quotes.id, existing.id)).run();
    logForEvent(tx, ev, ctx, {
      action: "unlinked",
      field: "quote",
      summary: `Usunięto pustą wycenę ${existing.number} (rozliczenie: ${REALIZATION_BILLING_LABELS[realizationBillingOf(ev.billing)]})`,
      oldValue: existing.id,
    });
    return { action: "deleted", quoteId: existing.id, number: existing.number };
  }

  // --- płatne bez wyceny: tworzymy szkic ------------------------------------
  if (!existing) {
    if (!cfg.autoQuote || r.invoiced) return { action: "none" };
    const created = createQuoteForRealizationSync(tx, r, ev);
    if (!created) return { action: "none" };
    if (!opts.silent) {
      logForEvent(tx, ev, ctx, {
        action: "linked",
        field: "quote",
        summary: `Utworzono wycenę ${created.number} (praca płatna, ${created.site || r.site})`,
        newValue: created.id,
      });
    }
    return { action: "created", quoteId: created.id, number: created.number };
  }

  // --- płatne z wyceną: sama metryczka --------------------------------------
  // Wycena dziedziczy tożsamość po realizacji: `objectId` to klucz (idzie za
  // przepięciem obiektu w kalendarzu), `site` to migawka nazwy na dokument.
  const date = r.date;
  const objectId = r.objectId ?? null;
  if (
    r.invoiced ||
    (existing.date === date && existing.site === r.site && (existing.objectId ?? null) === objectId)
  ) {
    return { action: "none" };
  }
  tx.update(schema.quotes)
    .set({ date, objectId, site: r.site, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.quotes.id, existing.id))
    .run();
  logForEvent(tx, ev, ctx, {
    action: "updated",
    field: "quote",
    summary: `Zaktualizowano wycenę ${existing.number} (${r.site}, ${date})`,
    oldValue: existing.id,
    newValue: existing.id,
  });
  return { action: "updated", quoteId: existing.id, number: existing.number };
}

// ---------------------------------------------------------------------------
// ensure — utworzenie realizacji (+ protokołu) dla wydarzenia
// ---------------------------------------------------------------------------

export type EnsureResult =
  | { created: true; realizationId: number; protocolNumber: string | null; quoteNumber: string | null }
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
  const cfg = opts.config ?? getCalendarConfig().values;
  const reason = ensureBlockedReason(ev, { ...opts, config: cfg });
  if (reason) return { created: false, reason };

  const mapped = mapEventToRealization(tx, ev);
  const created = tx
    .insert(schema.realizations)
    .values(mapped as NewRealization)
    .returning()
    .get();
  // `ev` przekazujemy jawnie: `calendar_events.realization_id` ustawiamy dopiero niżej,
  // więc prefill protokołu nie odnalazłby jeszcze wydarzenia (src/lib/protocol-prefill.ts).
  const protocol = createProtocolForRealizationSync(tx, created, ev);
  tx.update(schema.calendarEvents)
    .set({ realizationId: created.id, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEvents.id, ev.id))
    .run();
  ev.realizationId = created.id;
  // Wycena tylko dla prac płatnych — `silent`, bo dopisujemy ją do wpisu niżej.
  const quote = syncQuoteForEvent(tx, ev, ctx, { config: cfg, realization: created, silent: true });

  const docs = [protocol ? `protokół ${protocol.number}` : null, quote.number && quote.action === "created" ? `wycenę ${quote.number}` : null].filter(Boolean);
  logForEvent(tx, ev, ctx, {
    action: "linked",
    summary: `Utworzono realizację #${created.id}${docs.length ? ` i ${docs.join(" oraz ")}` : ""} (${mapped.site}, ${mapped.date})`,
    newValue: created.id,
  });
  return {
    created: true,
    realizationId: created.id,
    protocolNumber: protocol?.number ?? null,
    quoteNumber: quote.action === "created" ? (quote.number ?? null) : null,
  };
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
    // Przepięcie wydarzenia na inny obiekt musi przenieść KLUCZ, nie tylko nazwę —
    // inaczej realizacja zostałaby przy starym FK i cicho rozjechała się z kalendarzem.
    (r.objectId ?? null) !== mapped.objectId ||
    r.site !== mapped.site ||
    r.workType !== mapped.workType ||
    r.billing !== mapped.billing ||
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
      objectId: mapped.objectId,
      site: mapped.site,
      workType: mapped.workType,
      billing: mapped.billing,
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
    // Godziny z terminu wydarzenia idą do protokołu tylko wtedy, gdy nikt ich tam jeszcze
    // nie wpisał (protokół jest źródłem prawdy — kalendarz go nie poprawia).
    const protocolHours =
      protocol.actualHours === 0 && mapped.actualHours > 0 ? { actualHours: mapped.actualHours } : {};
    tx.update(schema.protocols)
      .set({
        workDate: mapped.date,
        // Typ prac wprost z typu wydarzenia (wizja i demontaż mają w protokole własne
        // wartości) — to samo mapowanie, co przy tworzeniu szkicu (protocol-prefill.ts).
        workType: workTypeFromEventType(ev.type) ?? workTypeFromKind(mapped.kind),
        contractor: [mapped.contractor1, mapped.contractor2].filter(Boolean).join(", "),
        ...protocolHours,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(eq(schema.protocols.id, protocol.id), isNull(schema.protocols.signedAt)))
      .run();
  }

  const bits: string[] = [];
  if (r.date !== mapped.date) bits.push(`data ${r.date} → ${mapped.date}`);
  if (r.site !== mapped.site) bits.push(`obiekt ${r.site} → ${mapped.site}`);
  // Przepięcie na inny obiekt O TEJ SAMEJ NAZWIE nie zmienia `site`, więc bez tego
  // wpisu zmiana klucza byłaby w dzienniku niewidoczna — a to właśnie duplikaty nazw
  // („Stacja paliw Bochnia" ×2) robiły dawniej ciche pomyłki.
  else if ((r.objectId ?? null) !== mapped.objectId) {
    bits.push(`obiekt #${r.objectId ?? "—"} → #${mapped.objectId ?? "—"} (ta sama nazwa)`);
  }
  if (r.workType !== mapped.workType) {
    bits.push(
      `rodzaj ${REALIZATION_WORK_TYPE_LABELS[r.workType]} → ${REALIZATION_WORK_TYPE_LABELS[mapped.workType]}`,
    );
  }
  if (r.billing !== mapped.billing) {
    bits.push(`typ ${REALIZATION_BILLING_LABELS[r.billing]} → ${REALIZATION_BILLING_LABELS[mapped.billing]}`);
  }
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
    // Wycenę kasujemy wprost (nie kaskadą): wpis w activity_log ma mówić całą prawdę
    // o tym, co zniknęło, a FK dodane przez ALTER TABLE nie wszędzie mają ON DELETE.
    const quote = quoteOfRealization(tx, oldId);
    if (quote) {
      tx.update(schema.calendarEvents).set({ quoteId: null }).where(eq(schema.calendarEvents.quoteId, quote.id)).run();
      tx.delete(schema.quotes).where(eq(schema.quotes.id, quote.id)).run();
    }
    tx.delete(schema.realizations).where(eq(schema.realizations.id, oldId)).run();
    ev.realizationId = null;
    logForEvent(tx, ev, ctx, {
      action: "unlinked",
      summary: `Usunięto realizację #${oldId}${quote ? ` i wycenę ${quote.number}` : ""} (${reason})`,
      oldValue: oldId,
    });
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

/**
 * Po utworzeniu wydarzenia. Wydarzenie zapisane od razu jako „wykonane” (wpis wstecz)
 * dostaje to samo wstępne podliczenie, co przy zmianie statusu na „wykonane”.
 */
export function onEventCreated(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx): void {
  ensureRealizationForEvent(tx, ev, ctx);
  if (ev.status !== "done" || ev.realizationOptout || ev.realizationId == null) return;
  queueEventDoneAutofill({
    realizationId: ev.realizationId,
    eventId: ev.id,
    user: ctx.user,
  });
}

/**
 * Po edycji wydarzenia (PUT, move, zmiana statusu). Rozstrzyga: odpiąć (typ nieobjęty /
 * anulowane), utworzyć (brak realizacji, ustawienie pozwala) albo zsynchronizować.
 *
 * `before` (stan sprzed zapisu) służy do wykrycia przejścia statusu:
 *  - „cokolwiek” → `done`  : po ensure/sync kolejkujemy WSTĘPNE podliczenie realizacji
 *    (`company.autofill_on_event_done`; w trybie `auto_realization = "on_done"` realizacja
 *    dopiero tu powstaje i od razu jest podliczana). `realization_optout` = pomijamy,
 *  - `done` → „cokolwiek”  : wyliczonych wartości NIE cofamy (człowiek może je poprawić) —
 *    zostaje tylko ostrzeżenie w activity_log.
 * Bez `before` (ścieżki, które nie znają stanu sprzed) hak się nie odpala — lepiej nic
 * nie zrobić niż podliczyć przy każdej edycji wykonanego wydarzenia.
 */
export function onEventUpdated(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx, before?: CalendarEventRow | null): void {
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
    // ensure sam zakłada wycenę dla prac płatnych (i dopisuje ją do swojego wpisu).
    ensureRealizationForEvent(tx, ev, ctx, { config: cfg });
  } else {
    syncRealizationFromEvent(tx, ev, ctx, { config: cfg });
    // Zmiana rozliczenia (płatne ↔ gwarancja/darmowe) tworzy albo kasuje wycenę.
    syncQuoteForEvent(tx, ev, ctx, { config: cfg, ...(before ? { billingBefore: before.billing } : {}) });
  }

  const wasDone = before?.status === "done";
  if (!wasDone && ev.status === "done") {
    if (ev.realizationOptout || ev.realizationId == null) return;
    queueEventDoneAutofill({
      realizationId: ev.realizationId,
      eventId: ev.id,
      user: ctx.user,
    });
    return;
  }
  if (wasDone && ev.status !== "done") warnAutofillKeptAfterUndone(tx, ev, ctx);
}

/**
 * Cofnięcie statusu „wykonane” nie kasuje tego, co automat już policzył — dopisujemy
 * ostrzeżenie do activity_log, żeby było widać, skąd wzięły się kwoty.
 */
function warnAutofillKeptAfterUndone(tx: Tx, ev: CalendarEventRow, ctx: RealizationCtx): void {
  if (ev.realizationId == null) return;
  const r = realizationById(tx, ev.realizationId);
  if (!r || !r.autofill || r.autofill === "{}") return;
  logForEvent(tx, ev, ctx, {
    action: "updated",
    summary:
      `Cofnięto status „wykonane”, ale wstępne wyliczenia realizacji #${r.id} zostają ` +
      "— popraw je ręcznie, jeśli praca się nie odbyła",
    oldValue: r.id,
    newValue: r.id,
  });
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
  /** Numer wyceny — tylko dla prac płatnych (null = wycena nie powstała). */
  quoteNumber: string | null;
}

export interface BackfillSkipped {
  eventId: number;
  reason: string;
}

export interface BackfillResult {
  candidates: BackfillCandidate[];
  created?: BackfillCreated[];
  skipped: BackfillSkipped[];
  /**
   * Wydarzenia PŁATNE, które mają już realizację, ale nie mają wyceny — te, którym
   * brakuje samego dokumentu „za ile” (np. powstały, zanim wyceny wpięto w kalendarz,
   * albo przy wyłączonym `calendar.auto_quote`).
   */
  quoteCandidates: number;
  /** Wyceny faktycznie utworzone (brak w trybie `dryRun`). */
  quotesCreated?: number;
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
 * Wydarzenia PŁATNE z realizacją, ale bez wyceny (nieusunięte, nieanulowane, objęty typ).
 * Rozliczenie czytamy z realizacji — to ona jest źródłem prawdy po synchronizacji.
 */
function quoteBackfillRows(dbx: DbOrTx, types: CalendarEventType[], from?: string | null): CalendarEventRow[] {
  if (types.length === 0) return [];
  const conds = [
    isNull(schema.calendarEvents.deletedAt),
    sql`${schema.calendarEvents.realizationId} IS NOT NULL`,
    ne(schema.calendarEvents.status, "cancelled"),
    inArray(schema.calendarEvents.type, types),
    sql`NOT EXISTS (SELECT 1 FROM quotes q WHERE q.realization_id = ${schema.calendarEvents.realizationId})`,
    sql`EXISTS (SELECT 1 FROM realizations r WHERE r.id = ${schema.calendarEvents.realizationId} AND r.billing = 'paid' AND r.invoiced = 0)`,
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
    if (res.created) {
      created.push({
        eventId: ev.id,
        realizationId: res.realizationId,
        protocolNumber: res.protocolNumber,
        quoteNumber: res.quoteNumber,
      });
    }
    else skipped.push({ eventId: ev.id, reason: res.reason });
  }

  // Wyceny dla wydarzeń, które realizację już mają — bez tego stare, płatne prace
  // zostałyby bez dokumentu „za ile”.
  const quoteRows = quoteBackfillRows(tx, types, opts.from);
  if (opts.dryRun) return { candidates, skipped, quoteCandidates: quoteRows.length };

  let quotesCreated = 0;
  for (const ev of quoteRows) {
    // force: backfill działa też przy wyłączonym `calendar.auto_quote` (świadoma akcja admina).
    const res = syncQuoteForEvent(tx, ev, ctx, { config: { ...cfg, autoQuote: true } });
    if (res.action === "created") quotesCreated++;
  }
  return { candidates, created, skipped, quoteCandidates: quoteRows.length, quotesCreated };
}
