/**
 * Narzędzia asystenta kalendarza (Vercel AI SDK `tool`). Wzorzec: roleplay/src/lib/roleplay/tools.ts.
 * Każde `execute` zwraca obiekt albo `{ error }` — nigdy nie rzuca (model dostaje
 * czytelny komunikat i może poprawić wywołanie). ŻADNE narzędzie nie zapisuje do bazy:
 * propose_event / propose_changes tylko walidują i zwracają karty do zatwierdzenia na froncie.
 * Opisy narzędzi są krótkie — reguły użycia są w prompcie (calendarPrompt.ts).
 * Pola tekstowe z bazy są przycinane (`clip`) — wynik narzędzia to dane, nie instrukcje.
 * Schematy zmian (Change) i ich rozwiązywanie: src/lib/ai/calendarChanges.ts (wspólne z apply-changes).
 */
import { jsonSchema, tool, type JSONSchema7, type Tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import { and, asc, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { CALENDAR_EVENT_STATUSES, CALENDAR_EVENT_TYPES, CALENDAR_SERIES_FREQS, type User } from "../../db/schema.js";
import { ApiError, STATUS_LABELS, TYPE_LABELS } from "../calendar-labels.js";
import { parseInput, type ParsedInput } from "../calendar-mutations.js";
import { conflictEventIds, listActiveTechnicians, loadEvent, loadEvents, loadNotes, techName } from "../calendar-queries.js";
import { ASSISTANT_DEFAULTS, type AssistantSettingsValues } from "./assistantConfig.js";
import {
  CHANGES_MAX,
  DATE_OR_DATETIME,
  PROPOSAL_TITLE_MAX,
  briefOfEvent,
  fillEventDefaults,
  resolveChange,
  zChange,
  zDate,
  zDateOrDt,
  zEventInput,
  zId,
  zIds,
  type Change,
  type ResolvedChange,
} from "./calendarChanges.js";
import { addDays, computeFreeSlots, loadBusyIntervals, localNow } from "./freeSlots.js";

export { PROPOSAL_TITLE_MAX };

/** Podzbiór konfiguracji admina używany przez narzędzia (wyłączone narzędzia, defaults propozycji, horyzont). */
export type ToolsConfig = Pick<
  AssistantSettingsValues,
  | "disabledTools"
  | "workStart"
  | "workEnd"
  | "defaultDurationHours"
  | "allDayTypes"
  | "defaultStatus"
  | "allowRecurrence"
  | "maxHorizonDays"
  | "allowModifications"
  | "daySummaryDefaultStatus"
>;

const DAY_MS = 86_400_000;
/** Maks. znaków pola tekstowego z bazy w wyniku narzędzia. */
const CLIP = 120;
/** Limit wyników list_events (+ flaga truncated). */
const LIST_EVENTS_LIMIT = 40;
/** Limit wyników search_events (+ flaga truncated). */
const SEARCH_EVENTS_LIMIT = 20;
/** Domyślny zakres search_events względem dziś: [dziś − 90, dziś + 180). */
const SEARCH_PAST_DAYS = 90;
const SEARCH_FUTURE_DAYS = 180;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** get_event: ile ostatnich notatek i do ilu znaków każda. */
const GET_EVENT_NOTES = 10;
const NOTE_CLIP = 300;
/** Limit wydarzeń w jednej karcie show_events. */
const SHOW_EVENTS_MAX = 30;

/** Etykiety pól zod → czytelny komunikat dla modelu (PL, krótko, bez stacka). */
function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length ? issue.path.map(String).join(".") : "wejście";
  switch (issue.code) {
    case "too_big":
      return `${path}: maks. ${issue.maximum}${issue.origin === "array" ? " elementów" : issue.origin === "string" ? " znaków" : ""}`;
    case "too_small":
      return `${path}: min. ${issue.minimum}${issue.origin === "array" ? " elementów" : issue.origin === "string" ? " znaków" : ""}`;
    case "invalid_type":
      return `${path}: oczekiwano ${issue.expected}`;
    case "invalid_value":
      return `${path}: dozwolone ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "unrecognized_keys":
      return `nieznane pola: ${issue.keys.join(", ")}`;
    default:
      return `${path}: ${issue.message}`;
  }
}

/** `{ error }` z listy błędów walidacji (podane wartości w nawiasie, gdy proste). */
export function formatInputErrors(toolName: string, error: z.ZodError, input: unknown): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of error.issues) {
    let msg = formatIssue(issue);
    const key = issue.path.length === 1 ? String(issue.path[0]) : null;
    const given = key != null ? obj[key] : undefined;
    if (key != null && (typeof given === "number" || typeof given === "string")) msg += ` (podano ${JSON.stringify(given)})`;
    if (!seen.has(msg)) {
      seen.add(msg);
      parts.push(msg);
    }
  }
  return `Nieprawidłowe parametry ${toolName}: ${parts.slice(0, 6).join("; ")} — popraw wartości i wywołaj ponownie`;
}

/**
 * Narzędzie z „miękką” walidacją: model dostaje pełny JSON Schema (z zod), ale SDK nie odrzuca wywołania
 * z błędnymi parametrami (AI_InvalidToolInputError przerywał turę / pokazywał stack). Zamiast tego
 * `execute` waliduje zod-em i zwraca `{ error: "durationHours: maks. 12 …" }` — model poprawia się w kolejnym kroku.
 */
function lenientTool<S extends z.ZodType, R>(name: string, def: { description: string; inputSchema: S; execute: (input: z.output<S>) => Promise<R> }) {
  const schema = def.inputSchema;
  type In = z.output<S>;
  type Out = R | { error: string };
  const t = tool<In, unknown, Record<string, unknown>>({
    description: def.description,
    inputSchema: jsonSchema<In>(() => z.toJSONSchema(schema, { target: "draft-7", io: "input", reused: "inline" }) as unknown as JSONSchema7, {
      validate: (value) => ({ success: true, value: value as In }),
    }),
    execute: async (raw): Promise<Out> => {
      const r = schema.safeParse(raw);
      if (!r.success) return { error: formatInputErrors(name, r.error, raw) };
      return def.execute(r.data);
    },
  });
  // Typ wyjścia zawężony do R | { error } (generyczny R nie przechodzi przez NeverOptional w sygnaturze tool()).
  return t as unknown as Tool<In, Out> & { execute: (input: In, options: ToolExecutionOptions<Record<string, unknown>>) => Promise<Out> };
}

/** Przycina tekst z bazy do CLIP znaków (dane, nie instrukcje; oszczędność kontekstu). */
function clip(s: string | null | undefined, max = CLIP): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Escape znaków specjalnych LIKE (`%`, `_`, `\`) — używane z `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Wzorzec `%fragment%` z escape. */
function likePattern(query: string): string {
  return `%${escapeLike(query.trim())}%`;
}

/** LIKE z ESCAPE — drizzle `like()` nie obsługuje klauzuli ESCAPE. */
function likeEsc(col: unknown, pattern: string) {
  return sql`${col} LIKE ${pattern} ESCAPE '\\'`;
}

/** Liczba dni między dwiema datami (YYYY-MM-DD[THH:MM]) — do limitu horyzontu list_events. */
function spanDays(from: string, to: string): number {
  const a = Date.parse(from.length === 10 ? `${from}T00:00Z` : `${from}Z`);
  const b = Date.parse(to.length === 10 ? `${to}T00:00Z` : `${to}Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.ceil((b - a) / DAY_MS);
}

/** Skrócony event dla modelu (bez metadanych audytu — oszczędność kontekstu). */
function briefEvent(e: ReturnType<typeof loadEvents>[number]) {
  return {
    id: e.id,
    type: e.type,
    title: clip(e.title),
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay,
    status: e.status,
    objectId: e.objectId,
    objectName: clip(e.objectName),
    location: clip(e.location),
    technicians: e.technicians.map((t) => ({ id: t.id, name: techName(t) })),
    notesCount: e.notesCount,
    ...(e.seriesId != null ? { seriesId: e.seriesId } : {}),
  };
}

/** Sprawdza, że technicy istnieją; zwraca komunikat błędu albo null. */
function missingTechnicians(ids: number[]): string | null {
  if (ids.length === 0) return null;
  const known = db.select({ id: schema.technicians.id }).from(schema.technicians).where(inArray(schema.technicians.id, ids)).all().map((r) => r.id);
  const missing = ids.filter((id) => !known.includes(id));
  return missing.length ? `Technik #${missing.join(", #")} nie istnieje — użyj id z listy techników w prompcie` : null;
}

/**
 * Akcja dołączona do opcji ask_choice: klik opcji wystawia kartę zmiany / propozycji OD RAZU
 * (POST /assistant/chats/:id/choose), bez drugiej tury modelu.
 */
export const zChoiceAction = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("change"), change: zChange.describe("Gotowa pozycja jak w propose_changes (np. update {eventId, patch:{startAt,endAt}})") }),
    z.object({ kind: z.literal("event"), event: zEventInput.describe("Komplet danych nowego wydarzenia jak w propose_event (bez recurrence)") }),
  ])
  .describe(
    "Gotowy wynik wyboru tej opcji — UI wystawi kartę zmiany/propozycji od razu po kliknięciu, bez kolejnej tury. Dołącz TYLKO gdy po wyborze nie trzeba już nic sprawdzać ani dopytywać (np. wybór terminu dla znanego wydarzenia, slot dla nowego wydarzenia ze znanym obiektem i technikami). Opcje „Inny…/Inne…” bez action."
  );
export type ChoiceAction = z.infer<typeof zChoiceAction>;

/** Jedna opcja ask_choice po walidacji (kształt dla frontu: ChoiceCard). */
export interface ChoiceOption {
  label: string;
  value?: string;
  hint?: string;
  objectId?: number;
  technicianId?: number;
  /** Termin slotu (YYYY-MM-DD[THH:MM]) — front podświetla na siatce. */
  startAt?: string;
  endAt?: string;
  /** Opcja = istniejące wydarzenie (doprecyzowanie przy zmianach) — front pokaże podgląd. */
  eventId?: number;
  /** Akcja natychmiastowa (tylko gdy poprawna na aktualnym stanie bazy). */
  action?: ChoiceAction;
  /** Podgląd akcji: change → ResolvedChange (before/after/diff); event → EventProposal. */
  actionPreview?: ResolvedChange | EventProposal;
  /** Akcja odrzucona przy walidacji — opcja zostaje (bez action), model widzi powód. */
  actionError?: string;
}

/** Propozycja wydarzenia zwracana przez propose_event — kształt wejścia POST /calendar/events + etykiety do karty. */
export type EventProposal = ParsedInput & { objectName: string | null; technicianNames: string[] };

/** Wynik propose_changes (i podglądu akcji change w ask_choice / route /choose). */
export interface ChangesPreview {
  needsConfirmation: true;
  changes: ResolvedChange[];
  count: number;
  errors: number;
  note?: string;
}
/** Wynik propose_event (i podglądu akcji event w ask_choice / route /choose). */
export type EventProposalResult = { proposal: EventProposal; needsConfirmation: true } | { error: string };

/** Wejście propose_event: dane wydarzenia + allowPast + opcjonalna seria. */
export const zProposeEventInput = zEventInput.extend({
  allowPast: z.boolean().optional().describe("true TYLKO gdy użytkownik jawnie potwierdził termin w przeszłości"),
  recurrence: z
    .object({
      freq: z.enum(CALENDAR_SERIES_FREQS),
      interval: z.number().int().min(1).max(52).default(1),
      until: zDate.optional().describe("YYYY-MM-DD (włącznie)"),
      count: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
});
export type ProposeEventInput = z.output<typeof zProposeEventInput>;

/** Opcja otwarta („Inny termin / Inne… / Żadne z nich”) — zawsze wolna odpowiedź, nigdy action. */
export const OTHER_OPTION_RE = /^inn[aey]\b|^inne\b|^żadn/i;

/**
 * Wspólna logika „kart” (bez zapisu) dla propose_changes / propose_event / ask_choice(action) / POST /choose —
 * jedno źródło prawdy: te same funkcje z tą samą cfg dają dokładnie ten sam output narzędzia.
 */
export function buildCalendarActions(config: Partial<ToolsConfig> = {}) {
  const cfg: ToolsConfig = { ...ASSISTANT_DEFAULTS, ...config };

  /** Dokładnie wynik `propose_changes.execute`. */
  function resolveChangesPreview(changes: Change[], note?: string): ChangesPreview {
    const today = localNow().slice(0, 10);
    const resolved: ResolvedChange[] = changes.map((ch, index) => resolveChange(db, ch, index, { cfg, today }).resolved);
    const errors = resolved.filter((r) => r.error).length;
    return {
      needsConfirmation: true as const,
      changes: resolved,
      count: resolved.length,
      errors,
      ...(note ? { note } : {}),
    };
  }

  /** Dokładnie wynik `propose_event.execute`. */
  function buildEventProposal(input: ProposeEventInput): EventProposalResult {
    // Defaults z reguł kalendarza (admin): allDay wg typu, koniec = start + domyślny czas trwania, status domyślny, serie wg zgody.
    const { allDay, startAt, endAt } = fillEventDefaults(input, cfg);
    if (input.recurrence && !cfg.allowRecurrence) {
      return { error: "Serie cykliczne są wyłączone w konfiguracji asystenta — zaproponuj pojedyncze wydarzenie" };
    }
    let parsed: ParsedInput;
    try {
      parsed = parseInput({
        ...input,
        allDay,
        startAt,
        endAt,
        status: input.status ?? cfg.defaultStatus,
        objectId: input.objectId ?? null,
        location: input.location ?? null,
        description: input.description ?? null,
        recurrence: input.recurrence ?? null,
      });
    } catch (e) {
      return { error: e instanceof ApiError ? e.message : String((e as Error)?.message || e) };
    }
    const today = localNow().slice(0, 10);
    if (parsed.startAt.slice(0, 10) < today && !input.allowPast) {
      return { error: `Termin ${parsed.startAt} jest w przeszłości (dziś ${today}) — zapytaj użytkownika o właściwą datę; jeśli potwierdzi przeszłość, powtórz z allowPast: true` };
    }
    // Referencje: obiekt i technicy muszą istnieć (model mógł zmyślić id).
    let objectName: string | null = input.objectName?.trim() || null;
    if (parsed.objectId != null) {
      const o = db
        .select({ name: schema.objects.name })
        .from(schema.objects)
        .where(sql`${schema.objects.id} = ${parsed.objectId}`)
        .get();
      if (!o) return { error: `Obiekt #${parsed.objectId} nie istnieje — użyj find_object` };
      objectName = o.name;
    }
    let technicianNames: string[] = [];
    if (parsed.technicianIds.length > 0) {
      const rows = db
        .select({
          id: schema.technicians.id,
          firstName: schema.technicians.firstName,
          lastName: schema.technicians.lastName,
        })
        .from(schema.technicians)
        .where(inArray(schema.technicians.id, parsed.technicianIds))
        .all();
      const missing = parsed.technicianIds.filter((id) => !rows.some((r) => r.id === id));
      if (missing.length) return { error: `Technik #${missing.join(", #")} nie istnieje — użyj id z listy techników w prompcie` };
      technicianNames = parsed.technicianIds.map((id) => techName(rows.find((r) => r.id === id)!));
    }
    // Urlop bez tytułu: ten sam tytuł, który wygeneruje POST /calendar/events.
    const title = (
      parsed.title || (parsed.type === "urlop" ? `Urlop — ${technicianNames.join(", ")}` : parsed.title)
    ).slice(0, PROPOSAL_TITLE_MAX);
    const proposal: EventProposal = { ...parsed, title, objectName, technicianNames };
    return { proposal, needsConfirmation: true as const };
  }

  /**
   * Walidacja akcji opcji ask_choice (bez zapisu): poprawna → { action, actionPreview }; błędna → { actionError }.
   * Wspólna dla narzędzia i route /choose (tam actionError ⇒ fallback do zwykłej tury).
   */
  function previewChoiceAction(action: ChoiceAction): { action: ChoiceAction; actionPreview: ResolvedChange | EventProposal } | { actionError: string } {
    if (action.kind === "change") {
      if (!cfg.allowModifications) return { actionError: "modyfikacje wydarzeń są wyłączone w konfiguracji asystenta (propose_changes)" };
      const r = resolveChangesPreview([action.change]).changes[0];
      if (r.error) return { actionError: r.error };
      return { action, actionPreview: r };
    }
    const r = buildEventProposal(action.event);
    if ("error" in r) return { actionError: r.error };
    return { action, actionPreview: r.proposal };
  }

  return { cfg, resolveChangesPreview, buildEventProposal, previewChoiceAction };
}
export type CalendarActions = ReturnType<typeof buildCalendarActions>;

/**
 * Buduje narzędzia wg konfiguracji: wyłączone (disabledTools) nie trafiają do wyniku;
 * propose_event zawsze jest (wymagane); propose_changes tylko przy allowModifications.
 * Reguły kalendarza działają jako defaults.
 */
export function buildCalendarTools(_user: User, config: Partial<ToolsConfig> = {}) {
  const actions = buildCalendarActions(config);
  const { cfg } = actions;
  const disabled = new Set(cfg.disabledTools);
  const all = {
    find_object: lenientTool("find_object", {
      description: "Szuka obiektu klienta po fragmencie nazwy/adresu/miasta. Zwraca trafienia (id do propose_event/ask_choice), `count` i `ambiguous`.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe("Fragment nazwy/adresu/miasta"),
      }),
      execute: async ({ query }) => {
        const q = likePattern(query);
        if (q === "%%") return { error: "Pusty fragment nazwy" };
        const sel = () => db.select({ id: schema.objects.id, name: schema.objects.name, address: schema.objects.address, city: schema.objects.city }).from(schema.objects);
        let rows = sel()
          .where(or(likeEsc(schema.objects.name, q), likeEsc(schema.objects.address, q), likeEsc(schema.objects.city, q)))
          .orderBy(asc(schema.objects.name), asc(schema.objects.id))
          .limit(60)
          .all();
        // Fallback dla odmiany („u Testowego 42” vs „Obiekt Testowy 42”): każdy token po rdzeniu (bez końcówki ≤3 znaki) w nazwie+adresie+mieście.
        if (rows.length === 0) {
          const stems = query.trim().split(/\s+/).filter(Boolean).map((t) => (t.length >= 5 ? t.slice(0, Math.max(4, t.length - 3)) : t));
          const hay = sql`coalesce(${schema.objects.name}, '') || ' ' || coalesce(${schema.objects.address}, '') || ' ' || coalesce(${schema.objects.city}, '')`;
          if (stems.length) rows = sel().where(and(...stems.map((t) => likeEsc(hay, likePattern(t))))).orderBy(asc(schema.objects.name), asc(schema.objects.id)).limit(60).all();
        }
        // Dedup po (name, address, city): duplikaty w bazie to jeden wybór; id = najstarszy, reszta w duplicateIds.
        const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
        const groups = new Map<string, { id: number; name: string; address: string | null; city: string | null; duplicateIds: number[] }>();
        for (const r of rows) {
          const key = `${norm(r.name)}|${norm(r.address)}|${norm(r.city)}`;
          const g = groups.get(key);
          if (g) g.duplicateIds.push(r.id);
          else groups.set(key, { id: r.id, name: clip(r.name) ?? "", address: clip(r.address), city: clip(r.city), duplicateIds: [] });
        }
        const objects = [...groups.values()].slice(0, 8);
        const count = groups.size;
        return { objects, count, ambiguous: count > 1, truncated: count > objects.length };
      },
    }),

    find_technician: lenientTool("find_technician", {
      description: "Szuka technika po fragmencie imienia/nazwiska (lista techników jest też w prompcie). Zwraca id, nazwę, active.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe("Fragment imienia/nazwiska"),
      }),
      execute: async ({ query }) => {
        const q = likePattern(query);
        if (q === "%%") return { error: "Pusty fragment imienia/nazwiska" };
        const rows = db
          .select({
            id: schema.technicians.id,
            firstName: schema.technicians.firstName,
            lastName: schema.technicians.lastName,
            active: schema.technicians.active,
          })
          .from(schema.technicians)
          .where(
            or(
              likeEsc(schema.technicians.firstName, q),
              likeEsc(schema.technicians.lastName, q),
              likeEsc(sql`${schema.technicians.firstName} || ' ' || ${schema.technicians.lastName}`, q)
            )
          )
          .orderBy(asc(schema.technicians.lastName))
          .limit(8)
          .all();
        const technicians = rows.map((t) => ({ id: t.id, name: clip(techName(t)) ?? "", active: t.active }));
        return { technicians, count: technicians.length, ambiguous: technicians.length > 1 };
      },
    }),

    list_events: lenientTool("list_events", {
      description: "Wydarzenia w zakresie [from, to) z opcjonalnym filtrem technika/obiektu (grafik). Do wolnych terminów użyj find_free_slots.",
      inputSchema: z.object({
        from: zDateOrDt.describe(`Początek zakresu, ${DATE_OR_DATETIME}`),
        to: zDateOrDt.describe(`Koniec zakresu (exclusive), ${DATE_OR_DATETIME}`),
        technicianId: zId.optional(),
        objectId: zId.optional(),
      }),
      execute: async ({ from, to: toIn, technicianId, objectId }) => {
        const span = spanDays(from, toIn);
        if (span <= 0 || toIn <= from) return { error: "Parametr to musi być późniejszy niż from" };
        // Zakres ponad limit: przycinamy zamiast odrzucać (błąd kosztował 2–3 kroki na próby „365 → 91 → 90”).
        const truncatedRange = span > cfg.maxHorizonDays;
        const to = truncatedRange ? addDays(from.slice(0, 10), cfg.maxHorizonDays) : toIn;
        const conds = [
          isNull(schema.calendarEvents.deletedAt),
          gt(schema.calendarEvents.endAt, from),
          lt(schema.calendarEvents.startAt, to),
        ];
        if (objectId != null) conds.push(sql`${schema.calendarEvents.objectId} = ${objectId}`);
        if (technicianId != null) {
          conds.push(
            sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id = ${technicianId})`
          );
        }
        const ids = db
          .select({ id: schema.calendarEvents.id })
          .from(schema.calendarEvents)
          .where(and(...conds))
          .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
          .limit(LIST_EVENTS_LIMIT + 1)
          .all()
          .map((r) => r.id);
        const truncated = ids.length > LIST_EVENTS_LIMIT;
        const events = loadEvents(db, ids.slice(0, LIST_EVENTS_LIMIT)).map(briefEvent);
        return {
          events,
          count: events.length,
          truncated,
          from,
          to,
          ...(truncatedRange
            ? { truncatedRange: true as const, note: `Zakres ${span} dni przycięto do limitu ${cfg.maxHorizonDays} dni (do ${to}). Do szukania konkretnego wydarzenia użyj search_events.` }
            : {}),
        };
      },
    }),

    search_events: lenientTool("search_events", {
      description:
        "Szuka KONKRETNEGO wydarzenia (np. „urlop Dominika”, „serwis w Magazynie”) po fragmencie tytułu/obiektu/lokalizacji, techniku (id lub imię), typie, statusie. Bez from/to: dziś −90…+180 dni. Wyniki od najbliższych dzisiejszej dacie, maks. 20.",
      inputSchema: z.object({
        query: z.string().trim().max(200).optional().describe("Fragment tytułu / nazwy obiektu / lokalizacji (bez imienia technika — do tego technicianName)"),
        technicianId: zId.optional().describe("Id technika z listy w prompcie"),
        technicianName: z.string().trim().max(100).optional().describe("Fragment imienia/nazwiska technika, gdy nie znasz id"),
        type: z.enum(CALENDAR_EVENT_TYPES).optional().describe("Typ wydarzenia, np. urlop, serwis"),
        status: z.enum(CALENDAR_EVENT_STATUSES).optional(),
        from: zDateOrDt.optional().describe(`Początek zakresu, ${DATE_OR_DATETIME} (domyślnie dziś − ${SEARCH_PAST_DAYS} dni)`),
        to: zDateOrDt.optional().describe(`Koniec zakresu (exclusive), ${DATE_OR_DATETIME} (domyślnie dziś + ${SEARCH_FUTURE_DAYS} dni)`),
        includeCancelled: z.boolean().optional().describe("Uwzględnij anulowane (domyślnie false)"),
      }),
      execute: async (input) => {
        const today = localNow().slice(0, 10);
        const from = input.from ?? addDays(today, -SEARCH_PAST_DAYS);
        const to = input.to ?? addDays(today, SEARCH_FUTURE_DAYS);
        if (to <= from) return { error: "Parametr to musi być późniejszy niż from" };
        const hasFilter = Boolean(input.query?.trim() || input.technicianId != null || input.technicianName?.trim() || input.type || input.status);
        if (!hasFilter) return { error: "Podaj przynajmniej jeden filtr: query, technicianId/technicianName, type lub status (do grafiku w zakresie dat użyj list_events)" };
        // `strict` = false → bez filtrów type/status (fallback, gdy filtr daje 0 wyników).
        const base = (strict: boolean) => [
          isNull(schema.calendarEvents.deletedAt),
          gt(schema.calendarEvents.endAt, from),
          lt(schema.calendarEvents.startAt, to),
          ...(input.includeCancelled ? [] : [ne(schema.calendarEvents.status, "cancelled")]),
          ...(strict && input.type ? [sql`${schema.calendarEvents.type} = ${input.type}`] : []),
          ...(strict && input.status ? [sql`${schema.calendarEvents.status} = ${input.status}`] : []),
          ...(input.technicianId != null
            ? [sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id = ${input.technicianId})`]
            : []),
          ...(input.technicianName?.trim()
            ? [
                sql`${schema.calendarEvents.id} IN (SELECT a.event_id FROM calendar_event_assignees a JOIN technicians t ON t.id = a.technician_id WHERE (t.first_name || ' ' || t.last_name) LIKE ${likePattern(input.technicianName)} ESCAPE '\\')`,
              ]
            : []),
        ];
        // Odległość od dziś (dni) — najbliższe wydarzenia pierwsze; remis: wcześniejsze startAt.
        const distance = sql`abs(julianday(substr(${schema.calendarEvents.startAt}, 1, 10)) - julianday(${today}))`;
        const hay = sql`coalesce(${schema.calendarEvents.title}, '') || ' ' || coalesce(${schema.objects.name}, '') || ' ' || coalesce(${schema.calendarEvents.location}, '')`;
        const run = (textConds: unknown[], strict: boolean) =>
          db
            .select({ id: schema.calendarEvents.id })
            .from(schema.calendarEvents)
            .leftJoin(schema.objects, sql`${schema.objects.id} = ${schema.calendarEvents.objectId}`)
            .where(and(...base(strict), ...(textConds as ReturnType<typeof sql>[])))
            .orderBy(distance, asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
            .limit(SEARCH_EVENTS_LIMIT + 1)
            .all()
            .map((r) => r.id);
        const q = input.query?.trim() ?? "";
        // Fallback dla odmiany („Magazynie” vs „Magazyn”): każdy token po rdzeniu (jak find_object).
        const stems = q ? q.split(/\s+/).filter(Boolean).map((t) => (t.length >= 5 ? t.slice(0, Math.max(4, t.length - 3)) : t)) : [];
        const search = (strict: boolean) => {
          let ids = run(q ? [likeEsc(hay, likePattern(q))] : [], strict);
          if (ids.length === 0 && stems.length) ids = run(stems.map((t) => likeEsc(hay, likePattern(t))), strict);
          return ids;
        };
        let ids = search(true);
        // 0 wyników z filtrem type/status → powtórz bez tych filtrów (model zgaduje typ z potocznych słów: „wizyta” ≠ wizja).
        const relaxed: ("type" | "status")[] = [];
        const otherFilters = Boolean(q || input.technicianId != null || input.technicianName?.trim());
        if (ids.length === 0 && (input.type || input.status) && otherFilters) {
          ids = search(false);
          if (ids.length > 0) {
            if (input.type) relaxed.push("type");
            if (input.status) relaxed.push("status");
          }
        }
        const truncated = ids.length > SEARCH_EVENTS_LIMIT;
        const kept = ids.slice(0, SEARCH_EVENTS_LIMIT);
        const byId = new Map(loadEvents(db, kept).map((e) => [e.id, e]));
        const events = kept.map((id) => byId.get(id)).filter((e): e is NonNullable<typeof e> => !!e).map(briefEvent);
        const relaxedInfo = relaxed.length
          ? {
              relaxed,
              note: `Brak wydarzeń ${[input.type ? `typu ${TYPE_LABELS[input.type] ?? input.type}` : "", input.status ? `o statusie ${STATUS_LABELS[input.status] ?? input.status}` : ""].filter(Boolean).join(" i ")} — pokazano wydarzenia WSZYSTKICH ${relaxed.includes("type") ? "typów" : "statusów"} pasujące do pozostałych filtrów. Nie szukaj ponownie z innym typem — użyj tych wyników.`,
            }
          : {};
        return { events, count: events.length, truncated, from, to, today, ...relaxedInfo };
      },
    }),

    get_event: lenientTool("get_event", {
      description: "Pełne dane jednego wydarzenia po id (opis, technicy, seria, czy usunięte) + notatki (dziennik: co się działo, ustalenia; ostatnie 10) — do pytań o przebieg i przed propose_changes.",
      inputSchema: z.object({ eventId: zId.describe("Id z list_events") }),
      execute: async ({ eventId }) => {
        const e = loadEvent(db, eventId);
        if (!e) return { error: `Wydarzenie #${eventId} nie istnieje — użyj list_events` };
        const b = briefOfEvent(e);
        return {
          event: {
            ...b,
            description: clip(e.description, 600),
            objectName: clip(e.objectName),
            createdByLabel: e.createdByLabel,
            updatedAt: e.updatedAt,
            ...(e.series ? { series: { id: e.series.id, freq: e.series.freq, interval: e.series.interval } } : {}),
            notesCount: e.notesCount,
            // Dziennik: ostatnie 10 notatek (najstarsza pierwsza), tekst przycięty do 300 znaków.
            notes: loadNotes(db, eventId).slice(-GET_EVENT_NOTES).map((n) => ({ userLabel: n.userLabel, createdAt: n.createdAt, text: clip(n.text, NOTE_CLIP) })),
          },
        };
      },
    }),

    show_events: lenientTool("show_events", {
      description:
        "Pokazuje użytkownikowi interaktywną listę wydarzeń (karta z otwieraniem, podglądem w kalendarzu i szybkimi akcjami). Używaj ZAWSZE, gdy odpowiedź zawiera listę wydarzeń — zamiast wypisywać je tekstem. suggestActions=true dla zaległych/do rozliczenia.",
      inputSchema: z.object({
        eventIds: z
          .array(zId)
          .min(1)
          .max(SHOW_EVENTS_MAX)
          .refine((ids) => new Set(ids).size === ids.length, { message: "id wydarzeń muszą być unikalne" })
          .describe("Id wydarzeń z list_events/search_events (1–30, unikalne)"),
        title: z.string().trim().max(80).optional().describe("Nagłówek karty, np. „Zaległe wydarzenia”, „Wtorek 01.09”"),
        note: z.string().trim().max(300).optional().describe("Krótka uwaga pod nagłówkiem"),
        suggestActions: z.boolean().optional().describe("true → karta podpowiada szybkie akcje (wykonane/anuluj) — dla zaległych/do rozliczenia"),
      }),
      execute: async ({ eventIds, title, note, suggestActions }) => {
        // loadEvents zwraca też usunięte (soft-delete) — pokazujemy je z deleted:true.
        const loaded = loadEvents(db, eventIds);
        const found = new Set(loaded.map((e) => e.id));
        const missing = eventIds.filter((id) => !found.has(id));
        const events = [...loaded]
          .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.id - b.id))
          .map((e) => ({ ...briefEvent(e), deleted: e.deletedAt != null }));
        return {
          events,
          title: title || null,
          note: note || null,
          count: events.length,
          suggestActions: Boolean(suggestActions),
          ...(missing.length ? { missing } : {}),
        };
      },
    }),

    check_conflicts: lenientTool("check_conflicts", {
      description: "Kolizje wskazanych techników z innymi wydarzeniami i urlopami w [startAt, endAt).",
      inputSchema: z.object({
        startAt: zDateOrDt.describe(DATE_OR_DATETIME),
        endAt: zDateOrDt.describe(`${DATE_OR_DATETIME} (exclusive)`),
        technicianIds: zIds.min(1),
        excludeEventId: zId.optional().describe("Pomiń to wydarzenie (przy przesuwaniu istniejącego)"),
      }),
      execute: async ({ startAt, endAt, technicianIds, excludeEventId }) => {
        if (endAt <= startAt) return { error: "endAt musi być późniejszy niż startAt" };
        const missing = missingTechnicians(technicianIds);
        if (missing) return { error: missing };
        const ids = conflictEventIds(db, { technicianIds, startAt, endAt, excludeId: excludeEventId ?? null });
        const conflicts = loadEvents(db, ids).map((e) => ({
          id: e.id,
          title: clip(e.title),
          type: e.type,
          startAt: e.startAt,
          endAt: e.endAt,
          allDay: e.allDay,
          kind: e.type === "urlop" ? ("urlop" as const) : ("event" as const),
          technicians: e.technicians
            .filter((t) => technicianIds.includes(t.id))
            .map((t) => ({ id: t.id, name: techName(t) })),
        }));
        return { conflicts, count: conflicts.length };
      },
    }),

    find_free_slots: lenientTool("find_free_slots", {
      description:
        "Najbliższe wolne okna (godziny pracy, pon–pt, bez kolizji i urlopów). technicianIds = [] → wszyscy aktywni, każdy slot ma listę wolnych. Wynik przedstaw przez ask_choice.",
      inputSchema: z.object({
        technicianIds: zIds.describe("Id techników; pusta lista = wszyscy aktywni (dowolny technik / kto jest wolny)"),
        durationHours: z.number().min(0.25).max(12).describe("Czas trwania w godzinach, np. 2"),
        from: zDate.optional().describe("YYYY-MM-DD, domyślnie dziś (przy kolizji: dzień kolizji)"),
        horizonDays: z.number().int().min(1).max(90).optional().describe("Ile dni do przodu (domyślnie z reguł, maks. 90)"),
        earliest: z.string().regex(HHMM_RE).optional().describe("HH:MM — najwcześniejszy początek (domyślnie początek dnia pracy)"),
        latest: z.string().regex(HHMM_RE).optional().describe("HH:MM — najpóźniejszy koniec (domyślnie koniec dnia pracy)"),
        workdaysOnly: z.boolean().optional().describe("Tylko pon–pt (domyślnie true)"),
        limit: z.number().int().min(1).max(8).optional().describe("Ile slotów (domyślnie 3)"),
      }),
      execute: async (input) => {
        const now = localNow();
        const from = input.from ?? now.slice(0, 10);
        const earliest = input.earliest ?? cfg.workStart;
        const latest = input.latest ?? cfg.workEnd;
        if (earliest >= latest) return { error: "earliest musi być wcześniejsze niż latest" };
        const horizonDays = Math.min(input.horizonDays ?? cfg.maxHorizonDays, 90);
        const anyMode = input.technicianIds.length === 0;
        let technicianIds = input.technicianIds;
        if (anyMode) {
          technicianIds = listActiveTechnicians().filter((t) => t.active).map((t) => t.id);
          if (technicianIds.length === 0) return { error: "Brak aktywnych techników w bazie" };
        } else {
          const missing = missingTechnicians(technicianIds);
          if (missing) return { error: missing };
        }
        const busy = loadBusyIntervals(technicianIds, from, addDays(from, horizonDays));
        const slots = computeFreeSlots(busy, {
          technicianIds,
          durationHours: input.durationHours,
          from,
          horizonDays,
          earliest,
          latest,
          workdaysOnly: input.workdaysOnly ?? true,
          limit: input.limit ?? 3,
          now,
          mode: anyMode ? "any" : "all",
        });
        const names = new Map(listActiveTechnicians().map((t) => [t.id, t.name]));
        const out = slots.map((s) => ({
          ...s,
          freeTechnicians: s.technicianIds.map((id) => ({ id, name: names.get(id) ?? `#${id}` })),
        }));
        if (out.length === 0) {
          return { slots: out, note: `Brak wolnego okna ${input.durationHours} h w ciągu ${horizonDays} dni od ${from} (${earliest}–${latest})` };
        }
        return { slots: out, mode: anyMode ? ("any" as const) : ("all" as const) };
      },
    }),

    ask_choice: lenientTool("ask_choice", {
      description:
        "JEDNO pytanie z 2–8 opcjami do kliknięcia (obiekt, technik, termin, typ, wydarzenie). UI pokaże przyciski; odpowiedź przyjdzie jako wiadomość użytkownika. Opcja z `action` wystawia kartę zmiany/propozycji od razu po kliknięciu. Kończy turę.",
      inputSchema: z.object({
        question: z.string().trim().min(1).max(300).describe("Krótkie pytanie, np. 'Który obiekt wybierasz?'"),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(120).describe("Tekst przycisku (bez id z bazy)"),
              value: z.string().trim().max(200).optional().describe("Tekst wysyłany jako odpowiedź (domyślnie label); dla terminów pełna data z rokiem"),
              hint: z.string().trim().max(160).optional().describe("Drobny opis pod etykietą, np. adres i miasto obiektu, wolni technicy"),
              objectId: zId.optional().describe("Id obiektu z find_object — UI pokaże podgląd obiektu"),
              technicianId: zId.optional().describe("Id technika, gdy opcja = technik"),
              startAt: zDateOrDt.optional().describe("Początek slotu, gdy opcja = termin — UI podświetli na siatce"),
              endAt: zDateOrDt.optional().describe("Koniec slotu (exclusive), gdy opcja = termin"),
              eventId: zId.optional().describe("Id wydarzenia z list_events, gdy opcja = istniejące wydarzenie (doprecyzowanie zmian)"),
              action: zChoiceAction.optional(),
            })
          )
          .min(2)
          .max(8),
        allowCustom: z.boolean().optional().describe("Pozwól wpisać inną odpowiedź (przycisk „Inne…”)"),
        multi: z.boolean().optional().describe("Wielokrotny wybór (np. kilku techników)"),
      }),
      execute: async ({ question, options, allowCustom, multi }) => {
        // Referencje muszą istnieć (model mógł zmyślić id).
        const objectIds = [...new Set(options.map((o) => o.objectId).filter((x): x is number => x != null))];
        if (objectIds.length) {
          const known = db.select({ id: schema.objects.id }).from(schema.objects).where(inArray(schema.objects.id, objectIds)).all().map((r) => r.id);
          const missing = objectIds.filter((id) => !known.includes(id));
          if (missing.length) return { error: `Obiekt #${missing.join(", #")} nie istnieje — użyj id z wyniku find_object` };
        }
        const techIds = [...new Set(options.map((o) => o.technicianId).filter((x): x is number => x != null))];
        const missingTech = missingTechnicians(techIds);
        if (missingTech) return { error: missingTech };
        const eventIds = [...new Set(options.map((o) => o.eventId).filter((x): x is number => x != null))];
        if (eventIds.length) {
          const known = db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).all().map((r) => r.id);
          const missing = eventIds.filter((id) => !known.includes(id));
          if (missing.length) return { error: `Wydarzenie #${missing.join(", #")} nie istnieje — użyj id z wyniku list_events` };
        }
        for (const o of options) {
          if ((o.startAt && !o.endAt) || (!o.startAt && o.endAt)) return { error: `Opcja „${o.label}”: podaj oba pola startAt i endAt` };
          if (o.startAt && o.endAt && o.endAt <= o.startAt) return { error: `Opcja „${o.label}”: endAt musi być późniejszy niż startAt` };
        }
        // Opcja „Inny termin / Inny technik / Inne…” ⇒ zawsze wolna odpowiedź.
        const isOther = (o: { label: string }) => OTHER_OPTION_RE.test(o.label.trim());
        const hasOther = options.some(isOther);
        const cleaned: ChoiceOption[] = options.map((o) => {
          const out: ChoiceOption = { label: o.label };
          if (o.value) out.value = o.value;
          if (o.hint) out.hint = o.hint;
          if (o.objectId != null) out.objectId = o.objectId;
          if (o.technicianId != null) out.technicianId = o.technicianId;
          if (o.eventId != null) out.eventId = o.eventId;
          if (o.startAt && o.endAt) {
            out.startAt = o.startAt;
            out.endAt = o.endAt;
          }
          // Akcja natychmiastowa: walidacja jak propose_changes/propose_event (BEZ zapisu); błąd nie przerywa narzędzia.
          if (o.action) {
            if (isOther(o)) out.actionError = "opcja otwarta („Inny…/Inne…/Żadne”) nie może mieć action";
            else Object.assign(out, actions.previewChoiceAction(o.action));
          }
          return out;
        });
        return {
          awaitingUserChoice: true as const,
          question,
          options: cleaned,
          allowCustom: Boolean(allowCustom) || hasOther,
          multi: Boolean(multi),
        };
      },
    }),

    propose_event: lenientTool("propose_event", {
      description:
        "Karta propozycji NOWEGO wydarzenia do ZATWIERDZENIA przez użytkownika. NIE zapisuje. Jedno wywołanie = jedna karta; kilka wydarzeń = kilka wywołań w tym samym kroku. Przy {error} popraw i wywołaj ponownie.",
      inputSchema: zProposeEventInput,
      // Logika w buildCalendarActions.buildEventProposal (wspólna z ask_choice.action i POST /choose).
      execute: async (input) => actions.buildEventProposal(input),
    }),

    propose_changes: lenientTool("propose_changes", {
      description:
        "Paczka zmian ISTNIEJĄCYCH wydarzeń (update/status/cancel/delete/restore) i nieplanowanych, które się odbyły (create) — karty do ZATWIERDZENIA, NIE zapisuje. Jedno wywołanie = jedna paczka (1–20 pozycji). Pozycja z błędem nie blokuje pozostałych.",
      inputSchema: z.object({
        changes: z.array(zChange).min(1).max(CHANGES_MAX),
        note: z.string().trim().max(300).optional().describe("Krótki kontekst paczki (np. „Podsumowanie dnia 27.08”)"),
      }),
      // Logika w buildCalendarActions.resolveChangesPreview (wspólna z ask_choice.action i POST /choose).
      execute: async ({ changes, note }) => actions.resolveChangesPreview(changes, note),
    }),
  };
  const entries = Object.entries(all as Record<string, unknown>).filter(
    ([name]) => name === "propose_event" || (!disabled.has(name) && (cfg.allowModifications || name !== "propose_changes"))
  );
  return Object.fromEntries(entries) as typeof all;
}

export type CalendarTools = ReturnType<typeof buildCalendarTools>;
