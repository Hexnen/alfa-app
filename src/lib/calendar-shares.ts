/**
 * Udostępnianie wydarzeń kalendarza technicznego linkiem (tabela
 * `calendar_event_shares`, migracja 0117). Kontrakt: docs/UDOSTEPNIANIE-WYDARZEN.md.
 *
 * MODEL. Link jest „capability URL” (W3C Good Practices for Capability URLs):
 * sam w sobie jest uprawnieniem do odczytu JEDNEGO wydarzenia, niczego więcej.
 *  - token: 32 losowe bajty → base64url (43 znaki, 256 bitów),
 *  - w bazie wyłącznie sha256(token) w hex — wyciek bazy nie daje działających linków,
 *  - wyszukiwanie po hashu przez unikalny indeks (porównanie w zapytaniu, bez pętli),
 *  - link odwoływalny (`revoked_at`) i z terminem (`expires_at`),
 *  - każdy nieważny przypadek (zły format, brak, wygasły, odwołany, wydarzenie
 *    usunięte/notatka/spoza działu technicznego) wygląda NA ZEWNĄTRZ tak samo —
 *    `resolveShareToken` zwraca `null`, trasa odpowiada jednym 404.
 *
 * Znaczniki czasu: ISO UTC z `toISOString()` (z „Z”) — porównywalne tekstowo.
 * Trasy: src/routes/calendar-shares.ts.
 */
import "./tz.js"; // strefa procesu (Europe/Warsaw) — `new Date(y, m, d, hh, mm)` = czas lokalny kalendarza
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { CalendarEvent, CalendarEventShare, CalendarEventType, User } from "../db/schema.js";
import { logActivity, userLabelOf, type DbOrTx } from "./activity-log.js";
import { ApiError, TECHNIK_HIDDEN_TYPES } from "./calendar-labels.js";
import { CALENDAR_ENTITY, type MutationCtx } from "./calendar-mutations.js";
import { parseLocal } from "./calendar-recurrence.js";

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** 32 bajty w base64url bez paddingu = dokładnie 43 znaki z tego alfabetu. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateShareToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashShareToken(token) };
}

// ---------------------------------------------------------------------------
// Ważność
// ---------------------------------------------------------------------------

export const SHARE_EXPIRES_IN = ["24h", "event+7d", "30d"] as const;
export type ShareExpiresIn = (typeof SHARE_EXPIRES_IN)[number];

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Koniec wydarzenia jako chwila (end_at to czas LOKALNY kalendarza; całodniowe — data końca, wyłącznie). */
function eventEndInstant(ev: Pick<CalendarEvent, "endAt">): Date {
  const p = parseLocal(ev.endAt);
  return new Date(p.y, p.m - 1, p.d, p.hh, p.mm);
}

/**
 * Termin ważności (ISO UTC). „event+7d” = 7 dni po końcu wydarzenia; gdy to
 * już minęło (wydarzenie zakończyło się dawno), 400 — link byłby martwy od
 * urodzenia, a front ma wtedy zaproponować 24 h / 30 dni.
 */
export function computeExpiresAt(
  expiresIn: ShareExpiresIn,
  ev: Pick<CalendarEvent, "endAt">,
  now = new Date()
): string {
  let at: Date;
  if (expiresIn === "24h") at = new Date(now.getTime() + DAY_MS);
  else if (expiresIn === "30d") at = new Date(now.getTime() + 30 * DAY_MS);
  else at = new Date(eventEndInstant(ev).getTime() + 7 * DAY_MS);
  if (at.getTime() <= now.getTime()) {
    throw new ApiError(400, "Wydarzenie zakończyło się ponad 7 dni temu — wybierz ważność 24 h albo 30 dni");
  }
  return at.toISOString();
}

// ---------------------------------------------------------------------------
// ShareRow — kształt dla CRM (bez hasha i tokenu)
// ---------------------------------------------------------------------------

export type ShareStatus = "active" | "expired" | "revoked";

export interface ShareRow {
  id: number;
  eventId: number;
  technicianId: number | null;
  recipientName: string;
  createdByLabel: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  openCount: number;
  lastOpenedAt: string | null;
  status: ShareStatus;
  /** Etap 2: odbiorca może pisać swoje notatki i robić Rozpocznij/Zakończ. */
  canWork: boolean;
  /**
   * Migracja 0120: przy `canWork` odbiorca widzi WSZYSTKIE notatki wydarzenia
   * (zmienia tylko własne). Bez `canWork` bez znaczenia — notatek nie widać wcale.
   */
  seeAllNotes: boolean;
}

export function shareStatus(row: Pick<CalendarEventShare, "revokedAt" | "expiresAt">, now = new Date()): ShareStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now.toISOString()) return "expired";
  return "active";
}

export function toShareRow(row: CalendarEventShare, now = new Date()): ShareRow {
  return {
    id: row.id,
    eventId: row.eventId,
    technicianId: row.technicianId,
    recipientName: row.recipientName,
    createdByLabel: row.createdByLabel,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    openCount: row.openCount,
    lastOpenedAt: row.lastOpenedAt,
    status: shareStatus(row, now),
    canWork: row.canWork,
    seeAllNotes: row.seeAllNotes,
  };
}

/** Linki wydarzenia, najnowsze pierwsze. */
export function listShares(eventId: number, now = new Date()): ShareRow[] {
  return db
    .select()
    .from(schema.calendarEventShares)
    .where(eq(schema.calendarEventShares.eventId, eventId))
    .orderBy(desc(schema.calendarEventShares.createdAt), desc(schema.calendarEventShares.id))
    .all()
    .map((r) => toShareRow(r, now));
}

// ---------------------------------------------------------------------------
// Co wolno udostępnić
// ---------------------------------------------------------------------------

/** Wydarzenie nadaje się do udostępnienia/otwarcia: techniczne, żywe, nie kafelek notatki. */
export function isShareableEvent(ev: Pick<CalendarEvent, "department" | "type" | "deletedAt">): boolean {
  return (
    ev.department === "technical" &&
    ev.deletedAt == null &&
    !TECHNIK_HIDDEN_TYPES.includes(ev.type as CalendarEventType)
  );
}

/** Ten sam warunek przy tworzeniu linku, ale z polskim powodem odmowy. */
export function assertShareable(ev: Pick<CalendarEvent, "department" | "type" | "deletedAt">): void {
  if (ev.department !== "technical") {
    throw new ApiError(400, "Udostępniać można tylko wydarzenia kalendarza technicznego");
  }
  if (ev.deletedAt != null) throw new ApiError(409, "Wydarzenie jest usunięte");
  if (TECHNIK_HIDDEN_TYPES.includes(ev.type as CalendarEventType)) {
    throw new ApiError(400, "Notatki nie można udostępnić linkiem");
  }
}

// ---------------------------------------------------------------------------
// Walidacja wejścia POST
// ---------------------------------------------------------------------------

export const RECIPIENT_NAME_MAX = 80;

export interface ShareInput {
  technicianId: number | null;
  /** Dla gościa — wpisane (trim); dla technika — `null` (bierzemy nazwę z kartoteki). */
  recipientName: string | null;
  expiresIn: ShareExpiresIn;
  /** Brak w ciele = `false` (tylko podgląd) — domyślne „włączone” ustawia front. */
  canWork: boolean;
  /** Brak w ciele = `false` (tylko własne notatki) — domyślne „włączone” ustawia front. */
  seeAllNotes: boolean;
}

/** Flaga boolean z ciała żądania: brak → `fallback`, inaczej wyłącznie boolean. */
function parseBoolFlag(name: string, raw: unknown, fallback: boolean | null): boolean {
  if (raw === undefined && fallback !== null) return fallback;
  if (typeof raw !== "boolean") throw new ApiError(400, `Pole ${name}: oczekiwano true albo false`);
  return raw;
}

/** `canWork` z ciała żądania: brak → `fallback`, inaczej wyłącznie boolean. */
export function parseCanWork(raw: unknown, fallback: boolean | null): boolean {
  return parseBoolFlag("canWork", raw, fallback);
}

/** `seeAllNotes` z ciała żądania: brak → `fallback`, inaczej wyłącznie boolean. */
export function parseSeeAllNotes(raw: unknown, fallback: boolean | null): boolean {
  return parseBoolFlag("seeAllNotes", raw, fallback);
}

/** Uprawnienia linku zmieniane po fakcie (PATCH) — co najmniej jedno pole. */
export interface ShareFlagsPatch {
  canWork?: boolean;
  seeAllNotes?: boolean;
}

/** Ciało PATCH: `{canWork?, seeAllNotes?}`, co najmniej jedno, każde wyłącznie boolean. */
export function parseShareFlagsPatch(body: unknown): ShareFlagsPatch {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: ShareFlagsPatch = {};
  if (b.canWork !== undefined) out.canWork = parseCanWork(b.canWork, null);
  if (b.seeAllNotes !== undefined) out.seeAllNotes = parseSeeAllNotes(b.seeAllNotes, null);
  if (out.canWork === undefined && out.seeAllNotes === undefined) {
    throw new ApiError(400, "Podaj canWork albo seeAllNotes (true/false)");
  }
  return out;
}

export function parseShareInput(body: unknown): ShareInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const expiresIn = b.expiresIn ?? "event+7d";
  if (typeof expiresIn !== "string" || !(SHARE_EXPIRES_IN as readonly string[]).includes(expiresIn)) {
    throw new ApiError(400, "Nieprawidłowa ważność linku");
  }
  const canWork = parseCanWork(b.canWork, false);
  const seeAllNotes = parseSeeAllNotes(b.seeAllNotes, false);
  const rawTech = b.technicianId;
  if (rawTech !== undefined && rawTech !== null && rawTech !== "") {
    const technicianId = Number(rawTech);
    if (!Number.isInteger(technicianId) || technicianId <= 0) throw new ApiError(400, "Nieprawidłowy technik");
    return { technicianId, recipientName: null, expiresIn: expiresIn as ShareExpiresIn, canWork, seeAllNotes };
  }
  const name = typeof b.recipientName === "string" ? b.recipientName.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new ApiError(400, "Podaj imię lub nazwę odbiorcy linku");
  if (name.length > RECIPIENT_NAME_MAX) {
    throw new ApiError(400, `Nazwa odbiorcy może mieć najwyżej ${RECIPIENT_NAME_MAX} znaków`);
  }
  return { technicianId: null, recipientName: name, expiresIn: expiresIn as ShareExpiresIn, canWork, seeAllNotes };
}

// ---------------------------------------------------------------------------
// Mutacje (w transakcji — z wpisem do activity_log)
// ---------------------------------------------------------------------------

type ShareUser = Pick<User, "id" | "email" | "displayName">;

export function createShare(
  tx: DbOrTx,
  ev: CalendarEvent,
  input: ShareInput,
  user: ShareUser,
  now = new Date()
): { share: ShareRow; token: string } {
  assertShareable(ev);
  let recipientName = input.recipientName;
  if (input.technicianId != null) {
    const tech = tx
      .select({ firstName: schema.technicians.firstName, lastName: schema.technicians.lastName })
      .from(schema.technicians)
      .where(eq(schema.technicians.id, input.technicianId))
      .get();
    if (!tech) throw new ApiError(400, "Nie ma takiego technika");
    recipientName = `${tech.firstName} ${tech.lastName}`.replace(/\s+/g, " ").trim() || `Technik #${input.technicianId}`;
  }
  const expiresAt = computeExpiresAt(input.expiresIn, ev, now);
  const { token, hash } = generateShareToken();
  const row = tx
    .insert(schema.calendarEventShares)
    .values({
      eventId: ev.id,
      tokenHash: hash,
      technicianId: input.technicianId,
      recipientName: recipientName!,
      createdByUserId: user.id,
      createdByLabel: userLabelOf(user),
      createdAt: now.toISOString(),
      expiresAt,
      canWork: input.canWork,
      seeAllNotes: input.seeAllNotes,
    })
    .returning()
    .get();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY,
    entityId: ev.id,
    objectId: ev.objectId,
    user,
    action: "shared",
    field: "share",
    newValue: row.recipientName,
    summary: `Udostępniono link: ${row.recipientName}`,
  });
  return { share: toShareRow(row, now), token };
}

/**
 * Przełączniki „Może pracować” i „Widzi wszystkie notatki” na istniejącym linku.
 * Tylko link AKTYWNY (wygasły/odwołany → 409). Każda faktyczna zmiana = osobny
 * wpis w dzienniku (`share_can_work` / `share_see_all_notes`); brak zmiany = bez
 * zapisu i bez wpisu. Wyłączenie nie kasuje notatek odbiorcy — po ponownym
 * włączeniu znów je widzi.
 */
export function setShareFlags(
  tx: DbOrTx,
  ev: CalendarEvent,
  shareId: number,
  patch: ShareFlagsPatch,
  user: ShareUser,
  now = new Date()
): ShareRow {
  const row = tx
    .select()
    .from(schema.calendarEventShares)
    .where(and(eq(schema.calendarEventShares.id, shareId), eq(schema.calendarEventShares.eventId, ev.id)))
    .get();
  if (!row) throw new ApiError(404, "Nie znaleziono linku");
  if (shareStatus(row, now) !== "active") {
    throw new ApiError(409, "Link wygasł albo został unieważniony — uprawnień nie da się już zmienić");
  }
  const set: Partial<Pick<CalendarEventShare, "canWork" | "seeAllNotes">> = {};
  if (patch.canWork !== undefined && patch.canWork !== row.canWork) set.canWork = patch.canWork;
  if (patch.seeAllNotes !== undefined && patch.seeAllNotes !== row.seeAllNotes) set.seeAllNotes = patch.seeAllNotes;
  if (Object.keys(set).length === 0) return toShareRow(row, now);
  const updated = tx
    .update(schema.calendarEventShares)
    .set(set)
    .where(eq(schema.calendarEventShares.id, row.id))
    .returning()
    .get();
  if (set.canWork !== undefined) {
    logActivity(tx, {
      entityType: CALENDAR_ENTITY,
      entityId: ev.id,
      objectId: ev.objectId,
      user,
      action: "shared",
      field: "share_can_work",
      oldValue: row.canWork,
      newValue: set.canWork,
      summary: `${row.recipientName}: ${set.canWork ? "może pracować" : "tylko podgląd"}`,
    });
  }
  if (set.seeAllNotes !== undefined) {
    logActivity(tx, {
      entityType: CALENDAR_ENTITY,
      entityId: ev.id,
      objectId: ev.objectId,
      user,
      action: "shared",
      field: "share_see_all_notes",
      oldValue: row.seeAllNotes,
      newValue: set.seeAllNotes,
      summary: `${row.recipientName}: ${set.seeAllNotes ? "widzi wszystkie notatki" : "tylko własne notatki"}`,
    });
  }
  return toShareRow(updated, now);
}

/** Zgodność wstecz: sam przełącznik „Może pracować”. */
export function setShareCanWork(
  tx: DbOrTx,
  ev: CalendarEvent,
  shareId: number,
  canWork: boolean,
  user: ShareUser,
  now = new Date()
): ShareRow {
  return setShareFlags(tx, ev, shareId, { canWork }, user, now);
}

/** Unieważnia link (idempotentnie — drugie wywołanie nic nie zmienia i nie loguje). */
export function revokeShare(
  tx: DbOrTx,
  ev: CalendarEvent,
  shareId: number,
  user: ShareUser,
  now = new Date()
): ShareRow {
  const row = tx
    .select()
    .from(schema.calendarEventShares)
    .where(and(eq(schema.calendarEventShares.id, shareId), eq(schema.calendarEventShares.eventId, ev.id)))
    .get();
  if (!row) throw new ApiError(404, "Nie znaleziono linku");
  if (row.revokedAt) return toShareRow(row, now);
  const updated = tx
    .update(schema.calendarEventShares)
    .set({ revokedAt: now.toISOString() })
    .where(eq(schema.calendarEventShares.id, row.id))
    .returning()
    .get();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY,
    entityId: ev.id,
    objectId: ev.objectId,
    user,
    action: "unshared",
    field: "share",
    oldValue: row.recipientName,
    summary: `Unieważniono link: ${row.recipientName}`,
  });
  return toShareRow(updated, now);
}

// ---------------------------------------------------------------------------
// Publiczny odczyt
// ---------------------------------------------------------------------------

/**
 * Token → (link, wydarzenie) albo `null` dla KAŻDEGO nieważnego przypadku.
 * Bez efektów ubocznych (licznik otwarć liczy tylko `resolveShareToken`).
 */
export function lookupShareToken(
  token: string,
  now = new Date()
): { share: CalendarEventShare; event: CalendarEvent } | null {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  const share = db
    .select()
    .from(schema.calendarEventShares)
    .where(eq(schema.calendarEventShares.tokenHash, hashShareToken(token)))
    .get();
  if (!share || shareStatus(share, now) !== "active") return null;
  const event = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, share.eventId)).get();
  if (!event || !isShareableEvent(event)) return null;
  return { share, event };
}

/**
 * Jak `lookupShareToken`, ale ważny link dostaje +1 do licznika otwarć
 * i `last_opened_at` (publiczny GET widoku).
 */
export function resolveShareToken(
  token: string,
  now = new Date()
): { share: CalendarEventShare; event: CalendarEvent } | null {
  const found = lookupShareToken(token, now);
  if (!found) return null;
  const { share, event } = found;
  const nowIso = now.toISOString();
  db.update(schema.calendarEventShares)
    .set({ openCount: sql`${schema.calendarEventShares.openCount} + 1`, lastOpenedAt: nowIso })
    .where(eq(schema.calendarEventShares.id, share.id))
    .run();
  return { share: { ...share, openCount: share.openCount + 1, lastOpenedAt: nowIso }, event };
}

// ---------------------------------------------------------------------------
// Etap 2: link „do pracy”
// ---------------------------------------------------------------------------

/**
 * Link uprawnia do zapisu: aktywny, wydarzenie żywe, `can_work = 1` i twórca
 * linku nadal istnieje (jego `id` niesie FK `user_id`/`updated_by` — patrz
 * `shareMutationCtx`). Każde „nie” = `null`, czyli to samo 404 co przy odczycie.
 * Sprawdzane PRZY KAŻDEJ mutacji — odwołanie/wyłączenie działa natychmiast.
 */
export function resolveWorkShare(
  token: string,
  now = new Date()
): { share: CalendarEventShare & { createdByUserId: number }; event: CalendarEvent } | null {
  const found = lookupShareToken(token, now);
  if (!found || !found.share.canWork || found.share.createdByUserId == null) return null;
  return found as { share: CalendarEventShare & { createdByUserId: number }; event: CalendarEvent };
}

/** Etykieta autora wpisów spod linku — NIGDY twórca linku. */
export function shareAuthorLabel(share: Pick<CalendarEventShare, "recipientName">): string {
  return `${share.recipientName} (link)`;
}

/**
 * Kontekst mutacji dla odbiorcy linku. `id` = twórca linku (kolumny wymagające
 * użytkownika: `calendar_event_notes.user_id`, `calendar_events.updated_by`,
 * `activity_log.user_id`), ale `displayName` = „<odbiorca> (link)”, więc
 * snapshot `user_label` notatki i wpisu dziennika pokazuje odbiorcę, a `actorLabel`
 * trafia do `calendar_events.updated_by_label` (migracja 0119). `role: null`
 * — żadnych uprawnień admina z `canManageNote`.
 */
export function shareMutationCtx(share: Pick<CalendarEventShare, "recipientName"> & { createdByUserId: number }): MutationCtx {
  return {
    user: { id: share.createdByUserId, email: "", displayName: shareAuthorLabel(share), role: null },
    summarySuffix: null,
    // `calendar_events.updated_by_label` — stopka „Zmienił …” w CRM pokazuje odbiorcę, nie twórcę.
    actorLabel: shareAuthorLabel(share),
  };
}
