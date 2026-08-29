/**
 * Zmiany istniejących wydarzeń proponowane przez asystenta (narzędzie `propose_changes`)
 * + ich wykonanie po zatwierdzeniu (POST /assistant/apply-changes).
 *
 * Jedno źródło prawdy dla obu ścieżek:
 *  - `resolveChange` — waliduje Change na AKTUALNYM stanie bazy (event istnieje, patch przez
 *    parseInput na scalonym stanie, referencje, kolizje) i zwraca ResolvedChange (karta dla frontu:
 *    before/after/diff/warnings) + PlannedOp (co dokładnie wykonać). NIE zapisuje.
 *  - `executeOp` — wykonuje PlannedOp przez src/lib/calendar-mutations.ts w transakcji wołającego
 *    (activity_log z dopiskiem „(przez asystenta)” przez MutationCtx.summarySuffix).
 * Przy zatwierdzaniu zmiana jest rozwiązywana PONOWNIE (stan mógł się zmienić od podglądu).
 */
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { CALENDAR_BILLINGS, CALENDAR_EVENT_STATUSES, CALENDAR_EVENT_TYPES, type CalendarBilling, type CalendarEventStatus } from "../../db/schema.js";
import type { DbOrTx, Tx } from "../activity-log.js";
import { ApiError, BILLING_LABELS, STATUS_LABELS, TYPE_LABELS } from "../calendar-labels.js";
import {
  addNote,
  createEvent,
  deleteEvent,
  fmtDate,
  parseInput,
  restoreEvent,
  updateEvent,
  type MutationCtx,
  type ParsedInput,
} from "../calendar-mutations.js";
import { conflictEventIds, loadEvent, loadEvents, techName, type CalendarEventJson } from "../calendar-queries.js";
import { diffMinutes, shiftLocal } from "../calendar-recurrence.js";
import type { AssistantSettingsValues } from "./assistantConfig.js";
import { addDays, localNow } from "./freeSlots.js";

// ---------------------------------------------------------------------------
// Schematy (zod) — wspólne dla narzędzia i endpointu apply
// ---------------------------------------------------------------------------

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_OR_DT_RE = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_OR_DATETIME = "YYYY-MM-DD lub YYYY-MM-DDTHH:MM";

export const zDate = z.string().regex(DATE_RE, "oczekiwano YYYY-MM-DD");
export const zDateOrDt = z.string().regex(DATE_OR_DT_RE, `oczekiwano ${DATE_OR_DATETIME}`);
/** Godzina faktyczna: pełna data z godziną ALBO samo HH:MM (dzień wydarzenia). */
const zActualTime = z.string().regex(new RegExp(`^(${DATE_OR_DT_RE.source.slice(1, -1)}|${HHMM_RE.source.slice(1, -1)})$`), `oczekiwano ${DATE_OR_DATETIME} albo HH:MM`);
export const zId = z.number().int().positive();
export const zIds = z.array(zId).max(20);

/** Maks. długość tytułu propozycji (karta + kalendarz; parseInput dopuszcza 300). */
export const PROPOSAL_TITLE_MAX = 80;
/** Maks. długość notatki z propose_changes (kind: note). */
export const NOTE_TEXT_MAX = 2000;

/** Dane nowego wydarzenia (wspólne: propose_event i propose_changes/create). */
export const zEventInput = z.object({
  type: z.enum(CALENDAR_EVENT_TYPES),
  title: z.string().trim().max(PROPOSAL_TITLE_MAX).describe(`maks. ${PROPOSAL_TITLE_MAX} znaków; urlop: może być pusty`),
  startAt: zDateOrDt.describe(DATE_OR_DATETIME),
  endAt: zDateOrDt.optional().describe("exclusive; brak → domyślny czas trwania"),
  allDay: z.boolean().optional(),
  objectId: zId.optional(),
  objectName: z.string().trim().max(200).optional().describe("gdy brak objectId"),
  location: z.string().trim().max(200).optional().describe("tekst, gdy obiekt spoza bazy"),
  description: z.string().trim().max(2000).optional(),
  technicianIds: zIds.default([]),
  status: z.enum(CALENDAR_EVENT_STATUSES).optional(),
  billing: z.enum(CALENDAR_BILLINGS).nullable().optional().describe("rozliczenie: gwarancja → warranty, bezpłatnie/gratis → free, płatny/faktura → paid; nie zgaduj — brak w treści → pomiń"),
});
export type EventInput = z.infer<typeof zEventInput>;

export const zPatch = z
  .object({
    title: z.string().trim().min(1).max(PROPOSAL_TITLE_MAX).optional(),
    type: z.enum(CALENDAR_EVENT_TYPES).optional(),
    startAt: zDateOrDt.optional().describe("sam startAt = przesunięcie z zachowaniem długości"),
    endAt: zDateOrDt.optional(),
    allDay: z.boolean().optional(),
    objectId: zId.nullable().optional().describe("null = bez obiektu"),
    location: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional().describe("zastępuje opis (przebieg → kind note)"),
    technicianIds: zIds.optional().describe("pełna nowa lista"),
    status: z.enum(CALENDAR_EVENT_STATUSES).optional(),
    billing: z.enum(CALENDAR_BILLINGS).nullable().optional().describe("rozliczenie: warranty | free | paid | null (nie dotyczy); tylko gdy użytkownik podał"),
  })
  .describe("tylko zmieniane pola");

export const zChange = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("update"),
    eventId: zId,
    patch: zPatch,
    reason: z.string().trim().max(300).optional(),
  }),
  z.object({
    kind: z.literal("status"),
    eventId: zId,
    status: z.enum(["confirmed", "done", "cancelled"]),
    actualStartAt: zActualTime.optional().describe("done: data z godziną albo HH:MM"),
    actualEndAt: zActualTime.optional().describe("done: data z godziną albo HH:MM"),
    note: z.string().trim().max(1000).optional().describe("przebieg → notatka wydarzenia"),
    reason: z.string().trim().max(300).optional(),
  }),
  z.object({ kind: z.literal("cancel"), eventId: zId, reason: z.string().trim().max(300).optional() }),
  z.object({
    kind: z.literal("note"),
    eventId: zId,
    text: z.string().trim().min(1).max(NOTE_TEXT_MAX),
  }),
  z.object({ kind: z.literal("delete"), eventId: zId, reason: z.string().trim().max(300).optional() }),
  z.object({ kind: z.literal("restore"), eventId: zId }),
  z.object({
    kind: z.literal("create"),
    event: zEventInput.describe("nieplanowane, które się odbyło"),
    reason: z.string().trim().max(300).optional(),
  }),
]);
export type Change = z.infer<typeof zChange>;
export type ChangeKind = Change["kind"];

export const CHANGES_MAX = 20;

// ---------------------------------------------------------------------------
// Kształty wyniku (kontrakt z frontem: ChangeCard)
// ---------------------------------------------------------------------------

export interface BriefEvent {
  /** null tylko dla `create` (jeszcze nie istnieje). */
  id: number | null;
  type: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
  objectId: number | null;
  objectName: string | null;
  location: string | null;
  description: string | null;
  technicianIds: number[];
  technicians: { id: number; name: string }[];
  /** Rozliczenie (warranty | free | paid | null). */
  billing: CalendarBilling | null;
  /** Skrót protokołu (jawny albo z realizacji) — tylko informacyjnie, nie do edycji z czatu. */
  protocol: { id: number; number: string; status: "draft" | "final"; signedAt: string | null } | null;
  /** Skrót realizacji powstałej z wydarzenia — informacyjnie (kwot asystent nie dotyka). */
  realization: { id: number; invoiced: boolean } | null;
  seriesId: number | null;
  deleted: boolean;
}

export interface ChangeDiff {
  /** Etykieta PL pola („Termin”, „Status”, „Technicy”…). */
  field: string;
  from: string | null;
  to: string | null;
}

export interface ResolvedChange {
  index: number;
  kind: ChangeKind;
  eventId?: number;
  before?: BriefEvent;
  /** Scalony stan po zmianie (dla delete: before z deleted=true; restore: deleted=false). */
  after?: BriefEvent;
  diff: ChangeDiff[];
  /** Jedno zdanie do nagłówka pozycji. */
  summary: string;
  warnings: string[];
  /** Notatka, która zostanie dodana do dziennika wydarzenia przy zatwierdzeniu (kind note; status done z note; cancel z reason). */
  note?: string;
  /** Zmiana niewykonalna (event nie istnieje, walidacja) — karta bez przycisków. */
  error?: string;
}

/** Co dokładnie wykonać przy zatwierdzeniu (wszystko przez calendar-mutations). */
export type PlannedOp =
  | { kind: "update"; eventId: number; input: ParsedInput; note?: string }
  | { kind: "note"; eventId: number; text: string }
  | { kind: "delete"; eventId: number }
  | { kind: "restore"; eventId: number }
  | { kind: "create"; input: ParsedInput };

export type ChangesConfig = Pick<
  AssistantSettingsValues,
  "workStart" | "workEnd" | "defaultDurationHours" | "allDayTypes" | "defaultStatus" | "daySummaryDefaultStatus"
>;

// ---------------------------------------------------------------------------
// Helpery
// ---------------------------------------------------------------------------

const CLIP = 200;
function clip(s: string | null | undefined, max = CLIP): string | null {
  if (s == null) return null;
  // Newline zostaje (opis w karcie), tylko runy spacji/tabów do jednej spacji.
  const t = String(s).replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Dodaje godziny do lokalnego YYYY-MM-DDTHH:MM (bez stref — czas lokalny kalendarza). */
export function addHours(dt: string, hours: number): string {
  const [d, t] = dt.split("T");
  const [h, m] = t.split(":").map(Number);
  const total = h * 60 + m + Math.round(hours * 60);
  const dayShift = Math.floor(total / (24 * 60));
  const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${addDays(d, dayShift)}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

/**
 * Defaults z reguł kalendarza dla nowego wydarzenia: allDay wg typu, koniec = start + domyślny
 * czas trwania (albo koniec dnia pracy, gdy start = początek dnia pracy). Wspólne dla
 * propose_event i propose_changes/create.
 */
export function fillEventDefaults(input: EventInput, cfg: Pick<ChangesConfig, "workStart" | "workEnd" | "defaultDurationHours" | "allDayTypes">) {
  const allDay = input.allDay ?? cfg.allDayTypes.includes(input.type);
  let startAt = input.startAt;
  let endAt = input.endAt;
  if (!allDay && DATE_RE.test(startAt)) startAt = `${startAt}T${cfg.workStart}`;
  if (!endAt) {
    if (allDay) endAt = startAt.slice(0, 10);
    else if (startAt.slice(11) === cfg.workStart) endAt = `${startAt.slice(0, 10)}T${cfg.workEnd}`;
    else endAt = addHours(startAt, cfg.defaultDurationHours);
  }
  return { allDay, startAt, endAt };
}

export function briefOfEvent(e: CalendarEventJson): BriefEvent {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay,
    status: e.status,
    objectId: e.objectId,
    objectName: clip(e.objectName, 120),
    location: clip(e.location, 120),
    description: clip(e.description),
    technicianIds: e.technicians.map((t) => t.id),
    technicians: e.technicians.map((t) => ({ id: t.id, name: techName(t) })),
    billing: e.billing,
    protocol: e.protocol ? { id: e.protocol.id, number: e.protocol.number, status: e.protocol.status, signedAt: e.protocol.signedAt } : null,
    realization: e.realization ? { id: e.realization.id, invoiced: e.realization.invoiced } : null,
    seriesId: e.seriesId,
    deleted: e.deletedAt != null,
  };
}

/** Nazwy techników po id (kolejność wg ids). Brakujące → błąd. */
function technicianNames(dbx: DbOrTx, ids: number[]): { id: number; name: string }[] {
  if (ids.length === 0) return [];
  const rows = dbx
    .select({ id: schema.technicians.id, firstName: schema.technicians.firstName, lastName: schema.technicians.lastName })
    .from(schema.technicians)
    .where(inArray(schema.technicians.id, ids))
    .all();
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new ApiError(400, `Technik #${missing.join(", #")} nie istnieje — użyj id z listy techników w prompcie`);
  return ids.map((id) => ({ id, name: techName(rows.find((r) => r.id === id)!) }));
}

function objectNameOf(dbx: DbOrTx, id: number | null): string | null {
  if (id == null) return null;
  const o = dbx.select({ name: schema.objects.name }).from(schema.objects).where(eq(schema.objects.id, id)).get();
  if (!o) throw new ApiError(400, `Obiekt #${id} nie istnieje — użyj find_object`);
  return o.name;
}

/** Brief scalonego stanu (po parseInput) — bez zapisu. */
function briefOfInput(dbx: DbOrTx, input: ParsedInput, base: { id: number | null; seriesId: number | null; protocol?: BriefEvent["protocol"]; realization?: BriefEvent["realization"] }): BriefEvent {
  const techs = technicianNames(dbx, input.technicianIds);
  const objectName = objectNameOf(dbx, input.objectId);
  const title = input.title || (input.type === "urlop" ? `Urlop — ${techs.map((t) => t.name).join(", ")}` : input.title);
  return {
    id: base.id,
    type: input.type,
    title,
    startAt: input.startAt,
    endAt: input.endAt,
    allDay: input.allDay,
    status: input.status,
    objectId: input.objectId,
    objectName: clip(objectName, 120),
    location: clip(input.location, 120),
    description: clip(input.description),
    technicianIds: input.technicianIds,
    technicians: techs,
    billing: input.billing,
    protocol: base.protocol ?? null,
    realization: base.realization ?? null,
    seriesId: base.seriesId,
    deleted: false,
  };
}

/** "03.09.2026 09:00–13:00" / "03.09.2026 (cały dzień)" / "03.09–05.09.2026 (cały dzień)". */
export function fmtRange(startAt: string, endAt: string, allDay: boolean): string {
  if (allDay) {
    const lastDay = addDays(endAt.slice(0, 10), -1);
    return lastDay === startAt.slice(0, 10) ? `${fmtDate(startAt)} (cały dzień)` : `${fmtDate(startAt)}–${fmtDate(lastDay)} (cały dzień)`;
  }
  const sameDay = startAt.slice(0, 10) === endAt.slice(0, 10);
  return sameDay ? `${fmtDate(startAt)}–${endAt.slice(11, 16)}` : `${fmtDate(startAt)}–${fmtDate(endAt)}`;
}

/** Diff dwóch briefów z etykietami PL (tylko pola, które się zmieniły). */
export function diffBriefs(a: BriefEvent, b: BriefEvent): ChangeDiff[] {
  const out: ChangeDiff[] = [];
  const push = (field: string, from: string | null, to: string | null) => {
    if ((from ?? "") !== (to ?? "")) out.push({ field, from, to });
  };
  push("Termin", fmtRange(a.startAt, a.endAt, a.allDay), fmtRange(b.startAt, b.endAt, b.allDay));
  push("Status", STATUS_LABELS[a.status], STATUS_LABELS[b.status]);
  push("Tytuł", a.title, b.title);
  push("Typ", TYPE_LABELS[a.type as keyof typeof TYPE_LABELS] ?? a.type, TYPE_LABELS[b.type as keyof typeof TYPE_LABELS] ?? b.type);
  push("Obiekt", a.objectName ?? (a.objectId != null ? `#${a.objectId}` : null), b.objectName ?? (b.objectId != null ? `#${b.objectId}` : null));
  push("Lokalizacja", a.location, b.location);
  push("Opis", clip(a.description, 80), clip(b.description, 80));
  push("Rozliczenie", a.billing ? BILLING_LABELS[a.billing] : null, b.billing ? BILLING_LABELS[b.billing] : null);
  const names = (e: BriefEvent) => (e.technicians.length ? e.technicians.map((t) => t.name).join(", ") : null);
  if (a.technicianIds.slice().sort().join(",") !== b.technicianIds.slice().sort().join(",")) out.push({ field: "Technicy", from: names(a), to: names(b) });
  return out;
}

/** Kolizje techników z innymi wydarzeniami dla nowego stanu (bez samego eventu; nie dla anulowanych). */
function conflictWarnings(dbx: DbOrTx, input: ParsedInput, excludeId: number | null): string[] {
  if (input.status === "cancelled" || input.type === "urlop" || input.technicianIds.length === 0) return [];
  const ids = conflictEventIds(dbx, { technicianIds: input.technicianIds, startAt: input.startAt, endAt: input.endAt, excludeId });
  return loadEvents(dbx, ids.slice(0, 5)).map((e) => {
    const who = e.technicians.filter((t) => input.technicianIds.includes(t.id)).map((t) => techName(t)).join(", ");
    return `${e.type === "urlop" ? "Urlop" : "Kolizja"}: „${clip(e.title, 60)}” ${fmtRange(e.startAt, e.endAt, e.allDay)}${who ? ` — ${who}` : ""}`;
  });
}

/** "09:00–13:00" z dwóch dat tego samego dnia (inny dzień: pełne daty). */
function fmtTimes(startAt: string, endAt: string): string {
  return startAt.slice(0, 10) === endAt.slice(0, 10) ? `${startAt.slice(11, 16)}–${endAt.slice(11, 16)}` : `${fmtDate(startAt)}–${fmtDate(endAt)}`;
}

/** Pełna data faktycznego czasu: HH:MM → dzień wydarzenia. */
function actualToDt(raw: string, eventDay: string): string {
  return HHMM_RE.test(raw) ? `${eventDay}T${raw}` : raw;
}

/** "27.08" z YYYY-MM-DD. */
function ddmm(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/** ParsedInput → surowe body dla parseInput (ponowne scalanie z patchem). */
function inputBodyOf(e: CalendarEventJson): Record<string, unknown> {
  return {
    type: e.type,
    title: e.title,
    description: e.description,
    location: e.location,
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay,
    status: e.status,
    objectId: e.objectId,
    orderId: e.orderId,
    realizationId: e.realizationId,
    realizationOptout: e.realizationOptout,
    billing: e.billing,
    protocolId: e.protocolId,
    quoteId: e.quoteId,
    technicianIds: e.technicians.map((t) => t.id),
    recurrence: null,
  };
}

// ---------------------------------------------------------------------------
// resolveChange — walidacja i podgląd (bez zapisu)
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  cfg: ChangesConfig;
  /** Dziś (YYYY-MM-DD, strefa kalendarza) — reguła „nigdy done w przyszłości”, domyślny status create. */
  today?: string;
  /** Lokalne „teraz” YYYY-MM-DDTHH:MM — create: wydarzenie już rozpoczęte = zaistniałe (status podsumowania dnia). */
  now?: string;
}

export interface Resolved {
  resolved: ResolvedChange;
  /** Brak przy błędzie. */
  op?: PlannedOp;
}

function loadExisting(dbx: DbOrTx, eventId: number, kind: ChangeKind): CalendarEventJson {
  const ev = loadEvent(dbx, eventId);
  if (!ev) throw new ApiError(404, `Wydarzenie #${eventId} nie istnieje — użyj list_events/get_event`);
  if (ev.deletedAt && kind !== "restore") throw new ApiError(409, `Wydarzenie #${eventId} jest usunięte — możliwe tylko przywrócenie (restore)`);
  if (!ev.deletedAt && kind === "restore") throw new ApiError(409, `Wydarzenie #${eventId} nie jest usunięte`);
  return ev;
}

export function resolveChange(dbx: DbOrTx, change: Change, index: number, opts: ResolveOptions): Resolved {
  const now = opts.now ?? localNow();
  const today = opts.today ?? now.slice(0, 10);
  const base: ResolvedChange = { index, kind: change.kind, diff: [], summary: "", warnings: [] };
  try {
    switch (change.kind) {
      case "create": {
        const ev = change.event;
        const { allDay, startAt, endAt } = fillEventDefaults(ev, opts.cfg);
        // Zaistniałe = już się zaczęło (całodniowe: dzień minął lub trwa).
        const inPast = allDay ? startAt.slice(0, 10) <= today : startAt < now;
        const input = parseInput({
          ...ev,
          allDay,
          startAt,
          endAt,
          status: ev.status ?? (inPast ? opts.cfg.daySummaryDefaultStatus : opts.cfg.defaultStatus),
          objectId: ev.objectId ?? null,
          location: ev.location ?? null,
          description: ev.description ?? null,
          recurrence: null,
        });
        const after = briefOfInput(dbx, input, { id: null, seriesId: null });
        after.title = after.title.slice(0, PROPOSAL_TITLE_MAX);
        input.title = after.title;
        if (ev.objectName && after.objectId == null) after.objectName = clip(ev.objectName, 120);
        const warnings = conflictWarnings(dbx, input, null);
        return {
          resolved: {
            ...base,
            after,
            diff: [],
            summary: `Nowe wydarzenie: ${after.title} — ${fmtRange(after.startAt, after.endAt, after.allDay)} (${STATUS_LABELS[after.status]})`,
            warnings,
          },
          op: { kind: "create", input },
        };
      }
      case "delete": {
        const ev = loadExisting(dbx, change.eventId, "delete");
        const before = briefOfEvent(ev);
        const warnings = ev.seriesId != null ? ["Wydarzenie należy do serii — usunięte zostanie tylko to wystąpienie."] : [];
        return {
          resolved: { ...base, eventId: ev.id, before, after: { ...before, deleted: true }, diff: [], summary: `Usunięcie: ${before.title} (${fmtRange(before.startAt, before.endAt, before.allDay)})${change.reason ? ` — ${change.reason}` : ""}`, warnings },
          op: { kind: "delete", eventId: ev.id },
        };
      }
      case "restore": {
        const ev = loadExisting(dbx, change.eventId, "restore");
        const before = briefOfEvent(ev);
        return {
          resolved: { ...base, eventId: ev.id, before, after: { ...before, deleted: false }, diff: [], summary: `Przywrócenie: ${before.title} (${fmtRange(before.startAt, before.endAt, before.allDay)})`, warnings: [] },
          op: { kind: "restore", eventId: ev.id },
        };
      }
      case "note": {
        const ev = loadExisting(dbx, change.eventId, "note");
        const before = briefOfEvent(ev);
        const text = change.text.trim();
        return {
          resolved: {
            ...base,
            eventId: ev.id,
            before,
            after: before,
            diff: [{ field: "Notatka", from: "", to: text }],
            summary: clip(`Notatka: ${before.title} — ${text}`.replace(/\s+/g, " "), 300) ?? `Notatka: ${text}`,
            warnings: ev.seriesId != null ? ["Wydarzenie należy do serii — notatka trafi tylko do tego wystąpienia."] : [],
            note: text,
          },
          op: { kind: "note", eventId: ev.id, text },
        };
      }
      case "update":
      case "status":
      case "cancel": {
        const ev = loadExisting(dbx, change.eventId, change.kind);
        const before = briefOfEvent(ev);
        const body = inputBodyOf(ev);
        const day = ev.startAt.slice(0, 10);
        let headline = "";
        // Przebieg / powód anulowania → osobna notatka w dzienniku (description zostaje stałym opisem).
        let note: string | undefined;
        if (change.kind === "update") {
          const p = change.patch;
          if (p.title !== undefined) body.title = p.title;
          if (p.type !== undefined) body.type = p.type;
          if (p.allDay !== undefined) body.allDay = p.allDay;
          if (p.objectId !== undefined) body.objectId = p.objectId;
          if (p.location !== undefined) body.location = p.location;
          if (p.description !== undefined) body.description = p.description;
          if (p.technicianIds !== undefined) body.technicianIds = p.technicianIds;
          if (p.status !== undefined) body.status = p.status;
          if (p.billing !== undefined) body.billing = p.billing;
          if (p.startAt !== undefined) {
            body.startAt = p.startAt;
            // Sam startAt = przesunięcie z zachowaniem długości (jak PATCH /move).
            body.endAt = p.endAt ?? (p.allDay ?? ev.allDay ? shiftLocal(ev.endAt, diffMinutes(ev.startAt, p.startAt), true) : shiftLocal(ev.endAt, diffMinutes(ev.startAt, p.startAt), false));
          } else if (p.endAt !== undefined) {
            body.endAt = p.endAt;
          }
          headline = change.reason ? `Zmiana — ${change.reason}` : "Zmiana";
        } else if (change.kind === "cancel" || (change.kind === "status" && change.status === "cancelled")) {
          const reason = (change.kind === "cancel" ? change.reason : (change.note || change.reason)) ?? "";
          body.status = "cancelled";
          if (reason) note = `Anulowano: ${reason}`;
          headline = `Anulowanie${reason ? ` — ${reason}` : ""}`;
        } else {
          // status: confirmed | done (+ faktyczne godziny + notatka)
          body.status = change.status;
          if (change.status === "done" && day > today) {
            throw new ApiError(400, `Wydarzenie #${ev.id} jest w przyszłości (${fmtDate(ev.startAt)}) — nie można oznaczyć jako wykonane`);
          }
          let planChanged = false;
          if (change.actualStartAt || change.actualEndAt) {
            if (ev.allDay) throw new ApiError(400, `Wydarzenie #${ev.id} jest całodniowe — faktyczne godziny wymagają allDay=false (użyj kind: update)`);
            const s = change.actualStartAt ? actualToDt(change.actualStartAt, day) : ev.startAt;
            const e = change.actualEndAt ? actualToDt(change.actualEndAt, day) : ev.endAt;
            body.startAt = s;
            body.endAt = e;
            planChanged = s !== ev.startAt || e !== ev.endAt;
          }
          // Jedna notatka: „Przebieg 27.08: Wykonano 13:30–16:00 (plan 09:00–11:00). Wymieniono 2 kamery.”
          const done = planChanged ? `Wykonano ${fmtTimes(body.startAt as string, body.endAt as string)} (plan ${fmtTimes(ev.startAt, ev.endAt)}).` : "";
          const noteText = [done, change.note?.trim()].filter(Boolean).join(" ");
          if (noteText) note = `Przebieg ${ddmm(day)}: ${noteText}`;
          headline = change.status === "done" ? "Wykonane" : "Potwierdzone";
          if (change.reason) headline += ` — ${change.reason}`;
        }
        const input = parseInput(body);
        const after = briefOfInput(dbx, input, { id: ev.id, seriesId: ev.seriesId, protocol: before.protocol, realization: before.realization });
        const diff = diffBriefs(before, after);
        if (note) diff.push({ field: "Notatka", from: "", to: note });
        if (diff.length === 0) throw new ApiError(400, `Wydarzenie #${ev.id}: zmiana nie zmienia żadnego pola`);
        const warnings: string[] = [];
        const rangeChanged = before.startAt !== after.startAt || before.endAt !== after.endAt || before.technicianIds.join() !== after.technicianIds.join();
        if (rangeChanged && after.status !== "cancelled" && after.startAt.slice(0, 10) >= today) warnings.push(...conflictWarnings(dbx, input, ev.id));
        if (ev.seriesId != null) warnings.push("Wydarzenie należy do serii — zmiana dotyczy tylko tego wystąpienia.");
        const summary = `${headline}: ${before.title} — ${diff.map((d) => `${d.field.toLowerCase()} ${d.from ?? "—"} → ${d.to ?? "—"}`).join("; ")}`;
        return {
          resolved: { ...base, eventId: ev.id, before, after, diff, summary: clip(summary.replace(/\s+/g, " "), 300) ?? summary, warnings, ...(note ? { note } : {}) },
          op: { kind: "update", eventId: ev.id, input, ...(note ? { note } : {}) },
        };
      }
    }
  } catch (e) {
    const message = e instanceof ApiError ? e.message : String((e as Error)?.message || e);
    const eventId = "eventId" in change ? change.eventId : undefined;
    return { resolved: { ...base, ...(eventId != null ? { eventId } : {}), summary: `Błąd: ${message}`, error: message } };
  }
}

// ---------------------------------------------------------------------------
// executeOp — zapis (w transakcji wołającego)
// ---------------------------------------------------------------------------

export const ASSISTANT_LOG_SUFFIX = "(przez asystenta)";

/** Wykonuje zaplanowaną operację przez calendar-mutations; zwraca id wydarzenia. */
export function executeOp(tx: Tx, op: PlannedOp, ctx: MutationCtx): number {
  switch (op.kind) {
    case "create":
      return createEvent(tx, op.input, ctx).firstId;
    case "update":
      updateEvent(tx, op.eventId, op.input, "this", ctx);
      if (op.note) addNote(tx, { eventId: op.eventId, text: op.note, ctx, source: "assistant" });
      return op.eventId;
    case "note":
      addNote(tx, { eventId: op.eventId, text: op.text, ctx, source: "assistant" });
      return op.eventId;
    case "delete":
      deleteEvent(tx, op.eventId, "this", ctx);
      return op.eventId;
    case "restore":
      restoreEvent(tx, op.eventId, ctx);
      return op.eventId;
  }
}

/**
 * Zatwierdzenie jednej zmiany: ponowne rozwiązanie na aktualnym stanie + zapis w JEDNEJ transakcji.
 * Rzuca ApiError przy błędzie walidacji.
 */
export function applyChange(change: Change, index: number, opts: ResolveOptions, ctx: MutationCtx): { eventId: number; event: CalendarEventJson; resolved: ResolvedChange } {
  return db.transaction((tx) => {
    const r = resolveChange(tx, change, index, opts);
    if (!r.op || r.resolved.error) throw new ApiError(400, r.resolved.error ?? "Zmiana niewykonalna");
    const eventId = executeOp(tx, r.op, { ...ctx, summarySuffix: ctx.summarySuffix ?? ASSISTANT_LOG_SUFFIX });
    const event = loadEvent(tx, eventId);
    if (!event) throw new ApiError(404, `Wydarzenie #${eventId} nie istnieje`);
    return { eventId, event, resolved: r.resolved };
  });
}
