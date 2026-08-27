/**
 * Narzędzia asystenta kalendarza (Vercel AI SDK `tool`). Wzorzec: roleplay/src/lib/roleplay/tools.ts.
 * Każde `execute` zwraca obiekt albo `{ error }` — nigdy nie rzuca (model dostaje
 * czytelny komunikat i może poprawić wywołanie). ŻADNE narzędzie nie zapisuje do bazy:
 * propose_event tylko waliduje i zwraca kartę do zatwierdzenia na froncie.
 * Opisy narzędzi są krótkie — reguły użycia są w prompcie (calendarPrompt.ts).
 * Pola tekstowe z bazy są przycinane (`clip`) — wynik narzędzia to dane, nie instrukcje.
 */
import { tool } from "ai";
import { z } from "zod";
import { and, asc, gt, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import {
  CALENDAR_EVENT_STATUSES,
  CALENDAR_EVENT_TYPES,
  CALENDAR_SERIES_FREQS,
  type User,
} from "../../db/schema.js";
import { ApiError, loadEvents, parseInput, type ParsedInput } from "../../routes/calendar.js";
import { conflictEventIds, listActiveTechnicians, techName } from "../calendar-queries.js";
import { ASSISTANT_DEFAULTS, type AssistantSettingsValues } from "./assistantConfig.js";
import { addDays, computeFreeSlots, loadBusyIntervals, localNow } from "./freeSlots.js";

/** Podzbiór konfiguracji admina używany przez narzędzia (wyłączone narzędzia, defaults propozycji, horyzont). */
export type ToolsConfig = Pick<
  AssistantSettingsValues,
  "disabledTools" | "workStart" | "workEnd" | "defaultDurationHours" | "allDayTypes" | "defaultStatus" | "allowRecurrence" | "maxHorizonDays"
>;

const DAY_MS = 86_400_000;
/** Maks. znaków pola tekstowego z bazy w wyniku narzędzia. */
const CLIP = 120;
/** Maks. długość tytułu propozycji (karta + kalendarz; parseInput dopuszcza 300). */
export const PROPOSAL_TITLE_MAX = 80;
/** Limit wyników list_events (+ flaga truncated). */
const LIST_EVENTS_LIMIT = 40;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OR_DT_RE = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_OR_DATETIME = "YYYY-MM-DD lub YYYY-MM-DDTHH:MM";

const zDate = z.string().regex(DATE_RE, "oczekiwano YYYY-MM-DD");
const zDateOrDt = z.string().regex(DATE_OR_DT_RE, `oczekiwano ${DATE_OR_DATETIME}`);
const zId = z.number().int().positive();
const zIds = z.array(zId).max(20);

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

/** Dodaje godziny do lokalnego YYYY-MM-DDTHH:MM (bez stref — czas lokalny kalendarza). */
function addHours(dt: string, hours: number): string {
  const [d, t] = dt.split("T");
  const [h, m] = t.split(":").map(Number);
  const total = h * 60 + m + Math.round(hours * 60);
  const dayShift = Math.floor(total / (24 * 60));
  const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${addDays(d, dayShift)}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
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
  };
}

/** Sprawdza, że technicy istnieją; zwraca komunikat błędu albo null. */
function missingTechnicians(ids: number[]): string | null {
  if (ids.length === 0) return null;
  const known = db.select({ id: schema.technicians.id }).from(schema.technicians).where(inArray(schema.technicians.id, ids)).all().map((r) => r.id);
  const missing = ids.filter((id) => !known.includes(id));
  return missing.length ? `Technik #${missing.join(", #")} nie istnieje — użyj id z listy techników w prompcie` : null;
}

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
}

/** Propozycja wydarzenia zwracana przez propose_event — kształt wejścia POST /calendar/events + etykiety do karty. */
export type EventProposal = ParsedInput & { objectName: string | null; technicianNames: string[] };

/**
 * Buduje narzędzia wg konfiguracji: wyłączone (disabledTools) nie trafiają do wyniku;
 * propose_event zawsze jest (wymagane). Reguły kalendarza działają jako defaults.
 */
export function buildCalendarTools(_user: User, config: Partial<ToolsConfig> = {}) {
  const cfg: ToolsConfig = { ...ASSISTANT_DEFAULTS, ...config };
  const disabled = new Set(cfg.disabledTools);
  const all = {
    find_object: tool({
      description: "Szuka obiektu klienta po fragmencie nazwy/adresu/miasta. Zwraca trafienia (id do propose_event/ask_choice), `count` i `ambiguous`.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe("Fragment nazwy/adresu/miasta"),
      }),
      execute: async ({ query }) => {
        const q = likePattern(query);
        if (q === "%%") return { error: "Pusty fragment nazwy" };
        const rows = db
          .select({
            id: schema.objects.id,
            name: schema.objects.name,
            address: schema.objects.address,
            city: schema.objects.city,
          })
          .from(schema.objects)
          .where(or(likeEsc(schema.objects.name, q), likeEsc(schema.objects.address, q), likeEsc(schema.objects.city, q)))
          .orderBy(asc(schema.objects.name), asc(schema.objects.id))
          .limit(60)
          .all();
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

    find_technician: tool({
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

    list_events: tool({
      description: "Wydarzenia w zakresie [from, to) z opcjonalnym filtrem technika/obiektu (grafik). Do wolnych terminów użyj find_free_slots.",
      inputSchema: z.object({
        from: zDateOrDt.describe(`Początek zakresu, ${DATE_OR_DATETIME}`),
        to: zDateOrDt.describe(`Koniec zakresu (exclusive), ${DATE_OR_DATETIME}`),
        technicianId: zId.optional(),
        objectId: zId.optional(),
      }),
      execute: async ({ from, to, technicianId, objectId }) => {
        const span = spanDays(from, to);
        if (span <= 0 || to <= from) return { error: "Parametr to musi być późniejszy niż from" };
        if (span > cfg.maxHorizonDays) {
          return { error: `Zakres ${span} dni przekracza limit ${cfg.maxHorizonDays} dni — zawęź zapytanie` };
        }
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
        return { events, count: events.length, truncated };
      },
    }),

    check_conflicts: tool({
      description: "Kolizje wskazanych techników z innymi wydarzeniami i urlopami w [startAt, endAt).",
      inputSchema: z.object({
        startAt: zDateOrDt.describe(DATE_OR_DATETIME),
        endAt: zDateOrDt.describe(`${DATE_OR_DATETIME} (exclusive)`),
        technicianIds: zIds.min(1),
      }),
      execute: async ({ startAt, endAt, technicianIds }) => {
        if (endAt <= startAt) return { error: "endAt musi być późniejszy niż startAt" };
        const missing = missingTechnicians(technicianIds);
        if (missing) return { error: missing };
        const ids = conflictEventIds(db, { technicianIds, startAt, endAt });
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

    find_free_slots: tool({
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

    ask_choice: tool({
      description:
        "JEDNO pytanie z 2–8 opcjami do kliknięcia (obiekt, technik, termin, typ). UI pokaże przyciski; odpowiedź przyjdzie jako wiadomość użytkownika. Kończy turę.",
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
        for (const o of options) {
          if ((o.startAt && !o.endAt) || (!o.startAt && o.endAt)) return { error: `Opcja „${o.label}”: podaj oba pola startAt i endAt` };
          if (o.startAt && o.endAt && o.endAt <= o.startAt) return { error: `Opcja „${o.label}”: endAt musi być późniejszy niż startAt` };
        }
        // Opcja „Inny termin / Inny technik / Inne…” ⇒ zawsze wolna odpowiedź.
        const hasOther = options.some((o) => /^inn[aey]\b|^inne\b/i.test(o.label.trim()));
        const cleaned: ChoiceOption[] = options.map((o) => {
          const out: ChoiceOption = { label: o.label };
          if (o.value) out.value = o.value;
          if (o.hint) out.hint = o.hint;
          if (o.objectId != null) out.objectId = o.objectId;
          if (o.technicianId != null) out.technicianId = o.technicianId;
          if (o.startAt && o.endAt) {
            out.startAt = o.startAt;
            out.endAt = o.endAt;
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

    propose_event: tool({
      description:
        "Karta propozycji wydarzenia do ZATWIERDZENIA przez użytkownika. NIE zapisuje. Jedno wywołanie = jedna karta; kilka wydarzeń = kilka wywołań w tym samym kroku. Przy {error} popraw i wywołaj ponownie.",
      inputSchema: z.object({
        type: z.enum(CALENDAR_EVENT_TYPES),
        title: z.string().trim().max(PROPOSAL_TITLE_MAX).describe(`Krótki tytuł (maks. ${PROPOSAL_TITLE_MAX} znaków), np. 'Serwis — Magazyn Centralny'; urlop: może być pusty`),
        startAt: zDateOrDt.describe(DATE_OR_DATETIME),
        endAt: zDateOrDt.optional().describe(`${DATE_OR_DATETIME}; all-day: EXCLUSIVE (dzień po ostatnim). Brak → domyślny czas trwania z reguł.`),
        allDay: z.boolean().optional().describe("Brak → wg reguł typów całodniowych"),
        objectId: zId.optional().describe("Id z find_object"),
        objectName: z.string().trim().max(200).optional().describe("Nazwa obiektu (do karty; gdy brak objectId)"),
        location: z.string().trim().max(200).optional().describe("Lokalizacja tekstowa, gdy nie ma obiektu w bazie"),
        description: z.string().trim().max(2000).optional(),
        technicianIds: zIds.default([]),
        status: z.enum(CALENDAR_EVENT_STATUSES).optional(),
        allowPast: z.boolean().optional().describe("true TYLKO gdy użytkownik jawnie potwierdził termin w przeszłości"),
        recurrence: z
          .object({
            freq: z.enum(CALENDAR_SERIES_FREQS),
            interval: z.number().int().min(1).max(52).default(1),
            until: zDate.optional().describe("YYYY-MM-DD (włącznie)"),
            count: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      }),
      execute: async (input) => {
        // Defaults z reguł kalendarza (admin): allDay wg typu, koniec = start + domyślny czas trwania
        // (albo koniec dnia pracy, gdy start = początek dnia pracy), status domyślny, serie wg zgody.
        const allDay = input.allDay ?? cfg.allDayTypes.includes(input.type);
        let startAt = input.startAt;
        let endAt = input.endAt;
        if (!allDay && DATE_RE.test(startAt)) startAt = `${startAt}T${cfg.workStart}`;
        if (!endAt) {
          if (allDay) endAt = startAt.slice(0, 10);
          else if (startAt.slice(11) === cfg.workStart) endAt = `${startAt.slice(0, 10)}T${cfg.workEnd}`;
          else endAt = addHours(startAt, cfg.defaultDurationHours);
        }
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
      },
    }),
  };
  const entries = Object.entries(all as Record<string, unknown>).filter(([name]) => name === "propose_event" || !disabled.has(name));
  return Object.fromEntries(entries) as typeof all;
}

export type CalendarTools = ReturnType<typeof buildCalendarTools>;
