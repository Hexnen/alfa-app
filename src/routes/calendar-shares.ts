/**
 * Udostępnianie wydarzeń linkiem — trasy (kontrakt: docs/UDOSTEPNIANIE-WYDARZEN.md,
 * logika: src/lib/calendar-shares.ts).
 *
 * Eksporty:
 *  - default: GET/POST /events/:id/shares, DELETE /events/:id/shares/:shareId —
 *    montowane pod /calendar PO requireAuth i strażniku zakładek (src/routes/index.ts).
 *    Strażnik wpuszcza GET z samym „view” — tu WYMAGAMY `edit` na technical/kalendarz
 *    dla wszystkich trzech (lista linków to też informacja, komu co wysłano).
 *    PATCH /events/:id/shares/:shareId { canWork } — przełącznik „Może pracować” (etap 2).
 *  - sharePublicRoutes: /:token/* — montowane pod /share PRZED requireAuth (bez
 *    cookie; rola `technik` i `technikRoleGuard` nie mają tu zastosowania).
 *
 * WIDOK PUBLICZNY. To `JobJson` z panelu technika (wąski, bez kwot/billingu/wycen),
 * BEZ cudzych notatek i protokołu: notatki biura/techników to wewnętrzna rozmowa,
 * a protokół — dokument klienta. Pola zostają w kształcie (zera/null), żeby front
 * mógł użyć komponentów panelu bez rozgałęzień.
 *
 * ETAP 2 — link „do pracy” (`can_work = 1`): odbiorca pisze/edytuje/usuwa WŁASNE
 * notatki (calendar_event_notes.share_id = id linku) i robi Rozpocznij/Zakończ
 * z semantyką panelu technika (`startProgress`/`finishProgress`). Każda mutacja
 * od nowa sprawdza token (`resolveWorkShare`) — inaczej to samo 404.
 */
import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { getUser } from "../middleware/auth.js";
import { canEdit } from "../lib/auth/permissions.js";
import { ApiError } from "../lib/calendar-labels.js";
import {
  deleteNote,
  getEventRow,
  getNoteRow,
  updateNote,
  addNote,
} from "../lib/calendar-mutations.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { CalendarEvent, CalendarEventShare, CalendarEventType } from "../db/schema.js";
import { technikCanProgress } from "../lib/calendar-labels.js";
import {
  attachmentFilePath,
  attachmentRows,
  attachmentsByNote,
  contentDisposition,
  removeStoredFiles,
  storeUploads,
  type NoteAttachmentJson,
} from "../lib/calendar-attachments.js";
import { clientIdOf, publishCalendarChange } from "../lib/calendar-live.js";
import { createRateLimiter, clientIp } from "../lib/rate-limit.js";
import {
  createShare,
  listShares,
  lookupShareToken,
  parseCanWork,
  parseShareInput,
  resolveShareToken,
  resolveWorkShare,
  revokeShare,
  setShareCanWork,
  shareMutationCtx,
} from "../lib/calendar-shares.js";
import {
  finishProgress,
  readJobNoteBody,
  startProgress,
  toJobs,
  JOB_CANCELLED_MESSAGE,
  type JobJson,
} from "./technik.js";

const app = new Hono();
export const sharePublicRoutes = new Hono();

const CALENDAR_KEY = "technical/kalendarz";

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`Error in calendar shares ${what}:`, error);
  return c.json({ success: false, error: `Błąd: ${what}` }, 500);
}

function idParam(c: Context, name: string): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Nieprawidłowe id");
  return id;
}

/** Wydarzenie + prawo edycji kalendarza technicznego (linki są tylko dla działu technicznego). */
function eventForShares(c: Context) {
  const user = getUser(c);
  if (!canEdit(user, CALENDAR_KEY)) {
    throw new ApiError(403, "Brak uprawnień do udostępniania wydarzeń");
  }
  const ev = getEventRow(db, idParam(c, "id"));
  if (!ev || ev.department !== "technical") throw new ApiError(404, "Wydarzenie nie istnieje");
  return { user, ev };
}

/**
 * Origin do pełnego URL-a. `PUBLIC_BASE_URL` (opcjonalne env) wygrywa; dalej
 * nagłówki proxy (Traefik dokłada X-Forwarded-Proto/Host), na końcu origin żądania
 * — jak feed ICS. Front i tak składa URL z `window.location.origin` + tokenu.
 */
function publicOrigin(c: Context): string {
  const env = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Zalogowane: /calendar/events/:id/shares
// ---------------------------------------------------------------------------

app.get("/events/:id/shares", (c) => {
  try {
    const { ev } = eventForShares(c);
    return c.json({ success: true, data: listShares(ev.id) });
  } catch (error) {
    return handleError(c, error, "pobierania linków");
  }
});

app.post("/events/:id/shares", async (c) => {
  try {
    const { user, ev } = eventForShares(c);
    const body = await c.req.json().catch(() => ({}));
    const input = parseShareInput(body);
    const { share, token } = db.transaction((tx) => createShare(tx, ev, input, user));
    return c.json({ success: true, data: { share, token, url: `${publicOrigin(c)}/u/${token}` } }, 201);
  } catch (error) {
    return handleError(c, error, "tworzenia linku");
  }
});

app.patch("/events/:id/shares/:shareId", async (c) => {
  try {
    const { user, ev } = eventForShares(c);
    const shareId = idParam(c, "shareId");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const canWork = parseCanWork(body?.canWork, null);
    const share = db.transaction((tx) => setShareCanWork(tx, ev, shareId, canWork, user));
    return c.json({ success: true, data: share });
  } catch (error) {
    return handleError(c, error, "zmiany uprawnień linku");
  }
});

app.delete("/events/:id/shares/:shareId", (c) => {
  try {
    const { user, ev } = eventForShares(c);
    const shareId = idParam(c, "shareId");
    const share = db.transaction((tx) => revokeShare(tx, ev, shareId, user));
    return c.json({ success: true, data: share });
  } catch (error) {
    return handleError(c, error, "unieważniania linku");
  }
});

// ---------------------------------------------------------------------------
// Publiczne: /share/:token/*
// ---------------------------------------------------------------------------

/** Notatka w kształcie panelu technika (`JobNote`); `mine` zawsze true — widać tylko własne. */
export interface SharedJobNote {
  id: number;
  text: string;
  userLabel: string | null;
  source: string;
  createdAt: string;
  mine: true;
  attachments: NoteAttachmentJson[];
}

/** Widok publiczny (GET /share/:token). */
export interface SharedJobView {
  job: JobJson;
  share: { recipientName: string; expiresAt: string };
  canProtocol: false;
  /** Etap 2: link „do pracy”. */
  canWork: boolean;
  /** = canWork (osobna flaga na przyszłość). */
  canNotes: boolean;
  /** canWork && typ pozwala na Rozpocznij/Zakończ (jak `canProgress` w panelu). */
  canProgress: boolean;
  /** Tylko notatki TEGO linku; `[]` gdy `canWork = false`. */
  notes: SharedJobNote[];
}

/**
 * Tylko per IP (jak link do oferty) — token ma 256 bitów, więc to higiena,
 * nie ochrona przed zgadywaniem. Bez sufitu globalnego (dźwignia DoS).
 * Eksport dla testów (`reset()`).
 */
export const sharePublicPerIp = createRateLimiter({ limit: 60, windowMs: 60_000 });
/** Zapisy spod linku: per IP i osobno per link (po 30/min). */
export const shareWritePerIp = createRateLimiter({ limit: 30, windowMs: 60_000 });
export const shareWritePerLink = createRateLimiter({ limit: 30, windowMs: 60_000 });
/** Pliki załączników (miniatury notatek) — luźniej, strona ładuje je hurtem. */
export const shareFilesPerIp = createRateLimiter({ limit: 240, windowMs: 60_000 });

const NOT_FOUND = { success: false as const, error: "Link nieaktywny" };
const TOO_MANY = { success: false as const, error: "Za dużo zapytań — spróbuj ponownie za chwilę" };

/** Nieważny token przy zapisie — trasa odpowiada jednolitym 404 (jak przy odczycie). */
class ShareGone extends Error {}
class ShareThrottled extends Error {}

sharePublicRoutes.use("*", async (c, next) => {
  await next();
  // Na KAŻDEJ odpowiedzi, także 404/429: token w adresie nie może wyjść w Refererze,
  // trafić do cache pośrednika ani do indeksu wyszukiwarki.
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
});

function tokenOf(c: Context): string {
  return (c.req.param("token") || "").trim();
}

function attachmentUrl(token: string, id: number): string {
  return `/api/share/${token}/attachments/${id}`;
}

/** Notatki TEGO linku (żywe), najnowsze pierwsze, z adresami plików spod linku. */
function shareNotes(share: Pick<CalendarEventShare, "id" | "eventId">, token: string): SharedJobNote[] {
  const rows = db
    .select({
      id: schema.calendarEventNotes.id,
      text: schema.calendarEventNotes.text,
      userLabel: schema.calendarEventNotes.userLabel,
      source: schema.calendarEventNotes.source,
      createdAt: schema.calendarEventNotes.createdAt,
    })
    .from(schema.calendarEventNotes)
    .where(
      and(
        eq(schema.calendarEventNotes.eventId, share.eventId),
        eq(schema.calendarEventNotes.shareId, share.id),
        isNull(schema.calendarEventNotes.deletedAt)
      )
    )
    .orderBy(desc(schema.calendarEventNotes.createdAt), desc(schema.calendarEventNotes.id))
    .limit(200)
    .all();
  const byNote = attachmentsByNote(db, rows.map((r) => r.id));
  return rows.map((n) => ({
    ...n,
    mine: true as const,
    attachments: (byNote.get(n.id) ?? []).map((a) => ({ ...a, url: attachmentUrl(token, a.id) })),
  }));
}

function shareNoteJson(share: Pick<CalendarEventShare, "id" | "eventId">, token: string, noteId: number): SharedJobNote {
  const note = shareNotes(share, token).find((n) => n.id === noteId);
  if (!note) throw new ApiError(404, "Notatka nie istnieje");
  return note;
}

/** JobJson dla odbiorcy linku: bez protokołu i cudzych notatek, flagi wg `can_work`. */
function sharedJob(event: CalendarEvent, share: CalendarEventShare, notesCount: number): JobJson {
  // technicianId odbiorcy: jego samego nie ma na liście „z kim jedzie”;
  // gość (-1) widzi wszystkich przypisanych. userId = null — brak „moich” notatek.
  const [base] = toJobs([event], share.technicianId ?? -1, null);
  return {
    ...base,
    notesCount,
    foreignNotesAt: [],
    protocol: null,
    canProtocol: false,
    canProgress: share.canWork && technikCanProgress(event.type as CalendarEventType),
  };
}

/** Sygnał dla otwartych kart CRM (po commicie). Aktora-użytkownika brak — odświeżają wszyscy. */
function publishShare(c: Context, kind: "updated" | "notes", eventId: number): void {
  publishCalendarChange({
    department: "technical",
    kind,
    eventIds: [eventId],
    actorUserId: null,
    actorClientId: clientIdOf(c),
  });
}

/**
 * Wejście KAŻDEJ mutacji spod linku: limit per IP → ważny link „do pracy”
 * (inaczej 404) → limit per link → zlecenie nie odwołane (409).
 */
function workTarget(c: Context) {
  if (!shareWritePerIp.check(clientIp(c))) throw new ShareThrottled();
  const token = tokenOf(c);
  const found = resolveWorkShare(token);
  if (!found) throw new ShareGone();
  if (!shareWritePerLink.check(String(found.share.id))) throw new ShareThrottled();
  if (found.event.status === "cancelled") throw new ApiError(409, JOB_CANCELLED_MESSAGE);
  return { ...found, token, ctx: shareMutationCtx(found.share) };
}

/** Notatka TEGO linku (żywa, z tego wydarzenia) albo 404 — cudzych nie zdradzamy. */
function myShareNote(share: Pick<CalendarEventShare, "id" | "eventId">, rawId: string | undefined) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, "Notatka nie istnieje");
  const note = getNoteRow(db, id);
  if (!note || note.deletedAt || note.eventId !== share.eventId || note.shareId !== share.id) {
    throw new ApiError(404, "Notatka nie istnieje");
  }
  return note;
}

function assertEditableNote(note: { source: string }): void {
  if (note.source === "system") throw new ApiError(409, "Wpisu systemowego nie można zmieniać");
}

/** Załącznik notatki TEGO linku albo 404. */
function myShareAttachment(share: Pick<CalendarEventShare, "id" | "eventId">, rawId: string | undefined) {
  const attId = Number(rawId);
  if (!Number.isInteger(attId) || attId <= 0) throw new ApiError(404, "Załącznik nie istnieje");
  const att = db
    .select()
    .from(schema.calendarNoteAttachments)
    .where(eq(schema.calendarNoteAttachments.id, attId))
    .get();
  if (!att) throw new ApiError(404, "Załącznik nie istnieje");
  const note = myShareNote(share, String(att.noteId));
  return { att, note };
}

function publicError(c: Context, error: unknown, what: string) {
  if (error instanceof ShareGone) return c.json(NOT_FOUND, 404);
  if (error instanceof ShareThrottled) return c.json(TOO_MANY, 429);
  if (error instanceof ApiError) return c.json({ success: false, error: error.message }, error.status);
  console.error(`Error in public share ${what}:`, error);
  return c.json({ success: false, error: `Błąd: ${what}` }, 500);
}

sharePublicRoutes.get("/:token", (c) => {
  if (!sharePublicPerIp.check(clientIp(c))) return c.json(TOO_MANY, 429);
  try {
    const token = tokenOf(c);
    const resolved = resolveShareToken(token);
    if (!resolved) return c.json(NOT_FOUND, 404);
    const { share, event } = resolved;
    // Notatki tylko dla linku „do pracy” — po wyłączeniu przełącznika znikają
    // z widoku (nie z bazy) i wracają po ponownym włączeniu.
    const notes = share.canWork ? shareNotes(share, token) : [];
    const job = sharedJob(event, share, notes.length);
    const data: SharedJobView = {
      job,
      share: { recipientName: share.recipientName, expiresAt: share.expiresAt },
      canProtocol: false,
      canWork: share.canWork,
      canNotes: share.canWork,
      canProgress: job.canProgress,
      notes,
    };
    return c.json({ success: true, data });
  } catch (error) {
    console.error("Error in public share:", error);
    return c.json(NOT_FOUND, 404);
  }
});

sharePublicRoutes.post("/:token/start", async (c) => {
  try {
    const { share, event, ctx } = workTarget(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = startProgress(event, ctx, `${share.recipientName} (link)`, body ?? {}, share.id);
    if (r.changed) publishShare(c, "updated", event.id);
    const notes = shareNotes(share, tokenOf(c));
    // `notes` obok `data`: notatki systemowe „Rozpoczęto/Zakończono …” trafiają na
    // stronę od razu, bez ponownego GET (ten podbija licznik otwarć linku).
    return c.json({ success: true, data: sharedJob(r.after, share, notes.length), notes, message: r.message });
  } catch (error) {
    return publicError(c, error, "rozpoczynania zlecenia");
  }
});

sharePublicRoutes.post("/:token/finish", async (c) => {
  try {
    const { share, event, ctx } = workTarget(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = finishProgress(event, ctx, `${share.recipientName} (link)`, body ?? {}, share.id);
    if (r.changed) publishShare(c, "updated", event.id);
    const notes = shareNotes(share, tokenOf(c));
    // `notes` obok `data`: notatki systemowe „Rozpoczęto/Zakończono …” trafiają na
    // stronę od razu, bez ponownego GET (ten podbija licznik otwarć linku).
    return c.json({ success: true, data: sharedJob(r.after, share, notes.length), notes, message: r.message });
  } catch (error) {
    return publicError(c, error, "kończenia zlecenia");
  }
});

sharePublicRoutes.post("/:token/notes", async (c) => {
  try {
    const { share, event, ctx, token } = workTarget(c);
    // Te same zasady co panel technika: JSON {text} albo multipart text/files/photoMeta,
    // limity treści (CALENDAR_NOTE_MAX) i plików (storeUploads: 15 × 5 MB, obrazki → WebP).
    const { text, files, photoMeta } = await readJobNoteBody(c);
    const attachments = files.length ? attachmentRows(await storeUploads(event.id, files), photoMeta) : [];
    let noteId: number;
    try {
      noteId = db.transaction((tx) => addNote(tx, { eventId: event.id, text, ctx, attachments, shareId: share.id })).id;
    } catch (error) {
      removeStoredFiles(attachments);
      throw error;
    }
    publishShare(c, "notes", event.id);
    return c.json({ success: true, data: shareNoteJson(share, token, noteId) }, 201);
  } catch (error) {
    return publicError(c, error, "dodawania notatki");
  }
});

sharePublicRoutes.put("/:token/notes/:noteId", async (c) => {
  try {
    const { share, event, ctx, token } = workTarget(c);
    const note = myShareNote(share, c.req.param("noteId"));
    assertEditableNote(note);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    db.transaction((tx) => updateNote(tx, note.id, body?.text, ctx));
    publishShare(c, "notes", event.id);
    return c.json({ success: true, data: shareNoteJson(share, token, note.id) });
  } catch (error) {
    return publicError(c, error, "edycji notatki");
  }
});

sharePublicRoutes.delete("/:token/notes/:noteId", (c) => {
  try {
    const { share, event, ctx } = workTarget(c);
    const note = myShareNote(share, c.req.param("noteId"));
    assertEditableNote(note);
    db.transaction((tx) => deleteNote(tx, note.id, ctx));
    publishShare(c, "notes", event.id);
    return c.json({ success: true });
  } catch (error) {
    return publicError(c, error, "usuwania notatki");
  }
});

sharePublicRoutes.get("/:token/attachments/:attachmentId", (c) => {
  try {
    if (!shareFilesPerIp.check(clientIp(c))) throw new ShareThrottled();
    // Odczyt pliku nie liczy się jako „otwarcie” i nie zużywa limitu zapisów,
    // ale wymaga linku „do pracy” — tylko wtedy odbiorca w ogóle widzi notatki.
    const found = lookupShareToken(tokenOf(c));
    if (!found || !found.share.canWork) throw new ShareGone();
    const { att } = myShareAttachment(found.share, c.req.param("attachmentId"));
    const abs = attachmentFilePath(att.storedPath);
    if (!abs) throw new ApiError(404, "Plik załącznika nie istnieje na dysku");
    const download = c.req.query("download") === "1";
    const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": att.mime,
        "Content-Length": String(statSync(abs).size),
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDisposition(download ? "attachment" : "inline", att.fileName),
      },
    });
  } catch (error) {
    return publicError(c, error, "pobierania załącznika");
  }
});

sharePublicRoutes.delete("/:token/attachments/:attachmentId", (c) => {
  try {
    const { share, event } = workTarget(c);
    const { att, note } = myShareAttachment(share, c.req.param("attachmentId"));
    assertEditableNote(note);
    db.delete(schema.calendarNoteAttachments).where(eq(schema.calendarNoteAttachments.id, att.id)).run();
    // Plik znika dopiero po skasowaniu wiersza (jak w panelu technika).
    removeStoredFiles([att]);
    publishShare(c, "notes", event.id);
    return c.json({ success: true, data: { id: att.id, noteId: att.noteId } });
  } catch (error) {
    return publicError(c, error, "usuwania załącznika");
  }
});

export default app;
