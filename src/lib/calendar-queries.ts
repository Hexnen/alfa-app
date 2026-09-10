/**
 * Wspólne zapytania kalendarza (kolizje, technicy, serializacja wydarzeń) — używane przez trasy
 * (src/routes/calendar.ts), mutacje (calendar-mutations.ts)
 * i narzędzia asystenta AI (src/lib/ai/calendarTools.ts). Zachowanie 1:1 z
 * dotychczasowym GET /calendar/conflicts.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db, schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";
import { attachmentsByNote, type NoteAttachmentJson } from "./calendar-attachments.js";
import { parseMentions } from "./note-mentions.js";
import { zonedToday } from "./tz.js";
import { asDepartment } from "./calendar-scope.js";
import type { CalendarBilling, CalendarDepartment, CalendarEventNote, CalendarEventStatus, CalendarEventType, CalendarNoteKind, CalendarNoteSource, CalendarSeriesFreq, LeadStage } from "../db/schema.js";

/**
 * Id wydarzeń kolidujących z zakresem [startAt, endAt) dla podanych techników
 * i/albo handlowców (bez usuniętych i anulowanych; opcjonalnie z pominięciem
 * edytowanego eventu). Porównanie leksykalne ISO działa też między "YYYY-MM-DD"
 * a "YYYY-MM-DDTHH:MM". Podanie obu list daje SUMĘ kolizji (każda z osób zajęta).
 */
export function conflictEventIds(
  dbx: DbOrTx,
  params: { technicianIds?: number[]; salespersonIds?: number[]; startAt: string; endAt: string; excludeId?: number | null }
): number[] {
  const { startAt, endAt, excludeId } = params;
  const technicianIds = params.technicianIds ?? [];
  const salespersonIds = params.salespersonIds ?? [];
  if ((technicianIds.length === 0 && salespersonIds.length === 0) || !startAt || !endAt) return [];
  const who = [];
  if (technicianIds.length) {
    who.push(sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id IN (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)}))`);
  }
  if (salespersonIds.length) {
    who.push(sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_salespeople WHERE salesperson_id IN (${sql.join(salespersonIds.map((id) => sql`${id}`), sql`, `)}))`);
  }
  const conds = [
    isNull(schema.calendarEvents.deletedAt),
    ne(schema.calendarEvents.status, "cancelled"),
    lt(schema.calendarEvents.startAt, endAt),
    gt(schema.calendarEvents.endAt, startAt),
    who.length === 1 ? who[0] : sql`(${who[0]} OR ${who[1]})`,
  ];
  if (excludeId != null && Number.isInteger(excludeId)) conds.push(ne(schema.calendarEvents.id, excludeId));
  return dbx
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(and(...conds))
    .orderBy(asc(schema.calendarEvents.startAt))
    .limit(200)
    .all()
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Technicy — wspólne dla promptu asystenta (calendarPrompt/calendarTools) i tras
// ---------------------------------------------------------------------------

export interface TechnicianBrief {
  id: number;
  name: string;
  active: boolean;
}

/** "Jan Kowalski" z wiersza technika (trim — puste nazwisko nie zostawia spacji). */
export function techName(t: { firstName: string; lastName: string }): string {
  return `${t.firstName} ${t.lastName}`.trim();
}

const foldName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Technik odpowiadający zalogowanemu użytkownikowi (asystent: „ja/mnie/jestem” = ten technik).
 * Dopasowanie po `users.displayName` ↔ „imię nazwisko” technika (bez rozróżniania wielkości liter,
 * także „nazwisko imię”). Gdy displayName to samo imię — jedyny AKTYWNY technik o tym imieniu.
 * Brak / niejednoznaczne → null.
 */
export function findTechnicianForUser(user: { displayName?: string | null }, dbx: DbOrTx = db): TechnicianBrief | null {
  const raw = foldName(user.displayName || "");
  if (!raw) return null;
  const techs = dbx
    .select({ id: schema.technicians.id, firstName: schema.technicians.firstName, lastName: schema.technicians.lastName, active: schema.technicians.active })
    .from(schema.technicians)
    .all();
  const brief = (t: (typeof techs)[number]): TechnicianBrief => ({ id: t.id, name: techName(t), active: t.active });
  const full = techs.filter((t) => {
    const f = foldName(t.firstName);
    const l = foldName(t.lastName);
    return raw === foldName(`${f} ${l}`) || (l !== "" && raw === foldName(`${l} ${f}`));
  });
  if (full.length === 1) return brief(full[0]);
  if (full.length > 1) {
    const active = full.filter((t) => t.active);
    return active.length === 1 ? brief(active[0]) : null;
  }
  if (raw.includes(" ")) return null;
  const byFirst = techs.filter((t) => t.active && foldName(t.firstName) === raw);
  return byFirst.length === 1 ? brief(byFirst[0]) : null;
}

/**
 * Wszyscy technicy (aktywni najpierw, potem po nazwisku) w kształcie dla promptu
 * i narzędzi asystenta. Nazwa historyczna: lista zawiera też nieaktywnych (flaga `active`),
 * bo model musi umieć powiedzieć „ten technik jest nieaktywny” zamiast „nie znam”.
 */
export function listActiveTechnicians(dbx: DbOrTx = db): TechnicianBrief[] {
  return dbx
    .select({
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
      active: schema.technicians.active,
    })
    .from(schema.technicians)
    .orderBy(desc(schema.technicians.active), asc(schema.technicians.lastName), asc(schema.technicians.firstName))
    .all()
    .map((t) => ({ id: t.id, name: techName(t), active: t.active }));
}

// ---------------------------------------------------------------------------
// Handlowcy — słownik dla kalendarza handlowego i filtru „Moje”
// ---------------------------------------------------------------------------

export interface SalespersonBrief {
  id: number;
  name: string;
  active: boolean;
}

/** Wszyscy handlowcy (aktywni najpierw, potem po nazwisku) — jak listActiveTechnicians. */
export function listActiveSalespeople(dbx: DbOrTx = db): SalespersonBrief[] {
  return dbx
    .select({
      id: schema.salespeople.id,
      firstName: schema.salespeople.firstName,
      lastName: schema.salespeople.lastName,
      active: schema.salespeople.active,
    })
    .from(schema.salespeople)
    .orderBy(desc(schema.salespeople.active), asc(schema.salespeople.lastName), asc(schema.salespeople.firstName))
    .all()
    .map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}`.trim(), active: s.active }));
}

/**
 * Handlowiec zalogowanego użytkownika — WYŁĄCZNIE po `salespeople.user_id`.
 * Świadomie bez heurystyki nazwiskowej (jaką ma `findTechnicianForUser`): filtr „Moje”
 * decyduje, czyj lejek widać, więc zgadywanie po `displayName` byłoby tu wyciekiem.
 */
export function findSalespersonForUser(user: { id: number }, dbx: DbOrTx = db): SalespersonBrief | null {
  const s = dbx
    .select({
      id: schema.salespeople.id,
      firstName: schema.salespeople.firstName,
      lastName: schema.salespeople.lastName,
      active: schema.salespeople.active,
    })
    .from(schema.salespeople)
    .where(eq(schema.salespeople.userId, user.id))
    .get();
  return s ? { id: s.id, name: `${s.firstName} ${s.lastName}`.trim(), active: s.active } : null;
}

// ---------------------------------------------------------------------------
// Serializacja wydarzeń: wiersze → CalendarEventJson (batch, 4 zapytania).
// Wspólne dla tras kalendarza, narzędzi asystenta i mutacji (calendar-mutations.ts).
// ---------------------------------------------------------------------------

export interface TechnicianRef {
  id: number;
  firstName: string;
  lastName: string;
}

/** Przypisany handlowiec (kształt równoległy do TechnicianRef). */
export interface SalespersonRef {
  id: number;
  firstName: string;
  lastName: string;
}

export interface SeriesRef {
  id: number;
  freq: CalendarSeriesFreq;
  interval: number;
  until: string | null;
  count: number | null;
}

/** Skrót realizacji powiązanej z wydarzeniem (`realizationId`). */
export interface RealizationRef {
  id: number;
  /** Data realizacji (YYYY-MM-DD). */
  date: string;
  /** Obiekt (nazwa tekstowa w realizacjach). */
  site: string;
  kind: "service" | "warranty" | "installation";
  invoiced: boolean;
  /** Suma netto: godziny + materiały + km − rabat. */
  total: number;
}

/** Skrót protokołu wydarzenia (jawnie przypięty `protocolId` albo protokół realizacji). */
export interface ProtocolRef {
  id: number;
  number: string;
  status: "draft" | "final";
  signedAt: string | null;
  workDate: string;
}

/** Skrót wyceny wydarzenia (jawnie przypięty `quoteId` albo wycena realizacji). */
export interface QuoteRef {
  id: number;
  number: string;
  /** Data wyceny (YYYY-MM-DD). */
  date: string;
  /** Suma netto pozycji (ilość × cena). */
  total: number;
  /** Liczba pozycji z wpisaną ilością — 0 = wycena pusta (szkic z cennika). */
  filledItems: number;
}

export interface CalendarEventJson {
  id: number;
  type: CalendarEventType;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
  /** Dział wiersza — decyduje o widoczności (src/lib/calendar-scope.ts). */
  department: CalendarDepartment;
  objectId: number | null;
  objectName: string | null;
  orderId: number | null;
  realizationId: number | null;
  /** Wyliczone: realizacja z `realizationId` (kwoty, status faktury) — null, gdy brak. */
  realization: RealizationRef | null;
  /** Użytkownik ręcznie odpiął realizację — automat jej nie utworzy (także backfill). */
  realizationOptout: boolean;
  /** Rozliczenie: warranty | free | paid | null (nie dotyczy). */
  billing: CalendarBilling | null;
  /** Jawnie przypięty protokół (NULL → protokół realizacji, jeśli jest). */
  protocolId: number | null;
  /** Wyliczone: protokół z `protocolId`, a gdy brak — protokół realizacji (`realizationId`). */
  protocol: ProtocolRef | null;
  /** Jawnie przypięta wycena (NULL → wycena realizacji, jeśli jest). */
  quoteId: number | null;
  /** Wyliczone: wycena z `quoteId`, a gdy brak — wycena realizacji (`realizationId`). */
  quote: QuoteRef | null;
  seriesId: number | null;
  series: SeriesRef | null;
  technicians: TechnicianRef[];
  /** Przypisani handlowcy (dział handlowy; techniczny ma zawsze pustą listę). */
  salespeople: SalespersonRef[];
  /** Szansa sprzedaży aktywności (dział handlowy) + migawka jej tytułu i etapu. */
  leadId: number | null;
  leadTitle: string | null;
  leadStage: LeadStage | null;
  /** Osoba kontaktowa aktywności + jej nazwa („Imię Nazwisko”). */
  contactId: number | null;
  contactName: string | null;
  /** Telefon osoby kontaktowej — lista aktywności robi z niego link `tel:`. */
  contactPhone: string | null;
  createdBy: number | null;
  createdByLabel: string | null;
  updatedBy: number | null;
  updatedByLabel: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Liczba nieusuniętych notatek (dziennik wydarzenia). */
  notesCount: number;
  /** Tylko dla type = "notatka": notatka, na którą wskazuje kafelek. */
  noteId: number | null;
  /** Klucz wzmianki, z której powstał kafelek (NULL = podpięty ręcznie). */
  noteMention: string | null;
  /** Wyliczone: notatka z `noteId` wraz z jej wydarzeniem źródłowym (tylko dla type = "notatka"). */
  sourceNote: SourceNoteRef | null;
}

/**
 * Notatka w skrócie razem z jej wydarzeniem źródłowym — wynik wyszukiwarki
 * (GET /calendar/notes/search) i podgląd w kafelku typu „notatka”.
 */
export interface NoteBrief {
  id: number;
  eventId: number;
  eventTitle: string;
  eventStartAt: string;
  eventType: CalendarEventType;
  /** Rodzaj wpisu — mail ma w `text` prefiks tematu (briefTextOf). */
  kind: CalendarNoteKind;
  text: string;
  userLabel: string | null;
  createdAt: string;
  attachmentsCount: number;
}

/** `NoteBrief` + źródło wpisu — pole `sourceNote` wydarzenia typu „notatka”. */
export interface SourceNoteRef extends NoteBrief {
  source: CalendarNoteSource;
}

/** Wzmianka daty w treści notatki + kafelek, który z niej powstał (jeśli żyje). */
export interface NoteMentionJson {
  /** Dokładny fragment tekstu, np. "@piątek". */
  raw: string;
  /** Klucz znormalizowany (NoteMention.key) — po nim synchronizujemy kafelki. */
  key: string;
  /** Rozstrzygnięta data YYYY-MM-DD. */
  date: string;
  /** Etykieta do wyświetlenia, np. „piątek 11.09”. */
  label: string;
  /** Id żywego kafelka „notatka” z tym `note_mention` (null = jeszcze/już go nie ma). */
  eventId: number | null;
}

/** Nagłówek maila w notatce `kind === "email"` (kolumny `mail_*`, migracja 0094). */
export interface NoteMailJson {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  /** ISO 8601 albo null. */
  sentAt: string | null;
  /** NAZWY załączników maila (kolumna `mail_attachments`, migracja 0096) — także tych niewypakowanych. */
  attachments: string[];
}

/** Notatka wydarzenia (kontrakt z frontem: CalendarNote). */
export interface Note {
  id: number;
  eventId: number;
  userId: number | null;
  userLabel: string | null;
  source: CalendarNoteSource;
  /** "text" = zwykły wpis; "email" = mail z Outlooka (nagłówek w `mail`). */
  kind: CalendarNoteKind;
  /**
   * Dla maila: SAMA treść (body). Nagłówek renderuje UI z pola `mail` — nie
   * doklejamy go tutaj, żeby edycja i wyszukiwanie działały na treści.
   */
  text: string;
  /** Nagłówek maila albo null dla zwykłej notatki. */
  mail: NoteMailJson | null;
  createdAt: string;
  updatedAt: string;
  /** Załączniki (pliki na dysku; url = GET /api/calendar/attachments/:id). */
  attachments: NoteAttachmentJson[];
  /** Wzmianki dat w treści (src/lib/note-mentions.ts) + ich kafelki w kalendarzu. */
  mentions: NoteMentionJson[];
  /** Wszystkie żywe kafelki „notatka” tej notatki — także podpięte ręcznie. */
  linkedEventIds: number[];
  /**
   * Id ŻYWEJ kopii tej notatki w kartotece obiektu (`object_notes.id`) albo null.
   * Wypełniają je TRASY (src/routes/calendar.ts → `withObjectNoteIds`), a nie ta
   * warstwa: `src/lib/object-notes.ts` importuje `parseNoteText`/`noteSummary`
   * z calendar-mutations, które importuje ten plik — sięgnięcie stąd po
   * `objectNoteIdsForCalendarNotes` zamknęłoby cykl importów. Domyślnie null.
   */
  objectNoteId: number | null;
}

/** Kafelki „notatka” wskazujące daną notatkę (żywe): id per klucz wzmianki + wszystkie id. */
export interface NoteEventLinks {
  byMention: Map<string, number>;
  ids: number[];
}

const EMPTY_LINKS: NoteEventLinks = { byMention: new Map(), ids: [] };

/** Żywe kafelki „notatka” dla podanych notatek — jedno zapytanie (bez N+1). */
export function noteEventLinks(dbx: DbOrTx, noteIds: number[]): Map<number, NoteEventLinks> {
  const out = new Map<number, NoteEventLinks>();
  if (noteIds.length === 0) return out;
  const rows = dbx
    .select({ id: schema.calendarEvents.id, noteId: schema.calendarEvents.noteId, noteMention: schema.calendarEvents.noteMention })
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.type, "notatka"),
        inArray(schema.calendarEvents.noteId, noteIds),
        isNull(schema.calendarEvents.deletedAt)
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .all();
  for (const r of rows) {
    if (r.noteId == null) continue;
    const entry = out.get(r.noteId) ?? { byMention: new Map<string, number>(), ids: [] };
    entry.ids.push(r.id);
    if (r.noteMention && !entry.byMention.has(r.noteMention)) entry.byMention.set(r.noteMention, r.id);
    out.set(r.noteId, entry);
  }
  return out;
}

/** Liczba załączników per notatka — jedno zapytanie zbiorcze. */
export function attachmentsCountByNote(dbx: DbOrTx, noteIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (noteIds.length === 0) return out;
  const rows = dbx
    .select({ noteId: schema.calendarNoteAttachments.noteId, n: sql<number>`count(*)` })
    .from(schema.calendarNoteAttachments)
    .where(inArray(schema.calendarNoteAttachments.noteId, noteIds))
    .groupBy(schema.calendarNoteAttachments.noteId)
    .all();
  for (const r of rows) out.set(r.noteId, Number(r.n));
  return out;
}

/** Notatki + ich wydarzenia źródłowe (skrót dla kafelków „notatka”) — jedno zapytanie + liczniki. */
export function loadSourceNotes(dbx: DbOrTx, noteIds: number[]): Map<number, SourceNoteRef> {
  const out = new Map<number, SourceNoteRef>();
  if (noteIds.length === 0) return out;
  const rows = dbx
    .select({
      id: schema.calendarEventNotes.id,
      eventId: schema.calendarEventNotes.eventId,
      text: schema.calendarEventNotes.text,
      kind: schema.calendarEventNotes.kind,
      mailSubject: schema.calendarEventNotes.mailSubject,
      userLabel: schema.calendarEventNotes.userLabel,
      source: schema.calendarEventNotes.source,
      createdAt: schema.calendarEventNotes.createdAt,
      eventTitle: schema.calendarEvents.title,
      eventStartAt: schema.calendarEvents.startAt,
      eventType: schema.calendarEvents.type,
    })
    .from(schema.calendarEventNotes)
    .innerJoin(schema.calendarEvents, eq(schema.calendarEventNotes.eventId, schema.calendarEvents.id))
    .where(inArray(schema.calendarEventNotes.id, noteIds))
    .all();
  const counts = attachmentsCountByNote(dbx, rows.map((r) => r.id));
  // Kafelek „notatka" pokazuje SAM tekst — mail dostaje więc prefiks tematu.
  for (const r of rows) {
    const { kind, mailSubject, ...rest } = r;
    out.set(r.id, { ...rest, text: briefTextOf(r), kind, attachmentsCount: counts.get(r.id) ?? 0 });
  }
  return out;
}

/**
 * Suma netto i liczba wypełnionych pozycji wyceny z JSON-a `quotes.items`
 * (`[{name, qty, unit, price}]`; ilość i cena bywają tekstem z przecinkiem).
 * Ta sama arytmetyka co `withComputed` w src/routes/quotes.ts.
 */
function quoteTotals(raw: string): { total: number; filledItems: number } {
  let items: { qty?: unknown; price?: unknown }[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    return { total: 0, filledItems: 0 };
  }
  const num = (v: unknown) => {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  let total = 0;
  let filledItems = 0;
  for (const i of items) {
    const qty = num(i.qty);
    if (qty > 0) filledItems++;
    total += qty * num(i.price);
  }
  return { total: Math.round(total * 100) / 100, filledItems };
}

/** Tablica JSON stringów z kolumny `mail_to`/`mail_cc`; śmieci → pusta lista. */
function jsonStrings(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Kolumny `mail_*` → nagłówek maila (null dla notatki tekstowej). */
export function mailOfRow(r: CalendarEventNote): NoteMailJson | null {
  if (r.kind !== "email") return null;
  return {
    subject: r.mailSubject ?? "",
    from: r.mailFrom ?? "",
    to: jsonStrings(r.mailTo),
    cc: jsonStrings(r.mailCc),
    sentAt: r.mailSentAt ?? null,
    attachments: jsonStrings(r.mailAttachments),
  };
}

/**
 * Notatka mailowa spłaszczona do jednej linijki — dla miejsc, które pokazują
 * SAM tekst (wyszukiwarka notatek, notatka źródłowa kafelka „notatka”).
 * Bez tego mail wyglądałby tam jak wpis bez kontekstu.
 */
export function briefTextOf(r: Pick<CalendarEventNote, "kind" | "text" | "mailSubject">): string {
  if (r.kind !== "email") return r.text;
  const subject = (r.mailSubject ?? "").trim() || "(bez tematu)";
  const body = r.text.trim();
  return body ? `📧 ${subject} — ${body}` : `📧 ${subject}`;
}

export function noteOfRow(
  r: CalendarEventNote,
  attachments: NoteAttachmentJson[] = [],
  links: NoteEventLinks = EMPTY_LINKS,
  today: string = zonedToday()
): Note {
  return {
    id: r.id,
    eventId: r.eventId,
    userId: r.userId,
    userLabel: r.userLabel,
    source: r.source,
    kind: r.kind,
    text: r.text,
    mail: mailOfRow(r),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    attachments,
    mentions: parseMentions(r.text, today).map((m) => ({
      raw: m.raw,
      key: m.key,
      date: m.date,
      label: m.label,
      eventId: links.byMention.get(m.key) ?? null,
    })),
    linkedEventIds: links.ids,
    // Uzupełniane przez trasy (withObjectNoteIds) — patrz komentarz przy polu.
    objectNoteId: null,
  };
}

/** Notatka z bazy + jej załączniki i kafelki w kalendarzu (po jednym zapytaniu na każde). */
export function noteWithAttachments(dbx: DbOrTx, r: CalendarEventNote): Note {
  return noteOfRow(r, attachmentsByNote(dbx, [r.id]).get(r.id) ?? [], noteEventLinks(dbx, [r.id]).get(r.id) ?? EMPTY_LINKS);
}

/** Nieusunięte notatki wydarzenia, od najstarszej (dziennik). */
export function loadNotes(dbx: DbOrTx, eventId: number, limit = 500): Note[] {
  const rows = dbx
    .select()
    .from(schema.calendarEventNotes)
    .where(and(eq(schema.calendarEventNotes.eventId, eventId), isNull(schema.calendarEventNotes.deletedAt)))
    .orderBy(asc(schema.calendarEventNotes.createdAt), asc(schema.calendarEventNotes.id))
    .limit(limit)
    .all();
  // Załączniki i kafelki jednym zapytaniem dla wszystkich notatek (bez N+1).
  const ids = rows.map((r) => r.id);
  const att = attachmentsByNote(dbx, ids);
  const links = noteEventLinks(dbx, ids);
  const today = zonedToday();
  return rows.map((r) => noteOfRow(r, att.get(r.id) ?? [], links.get(r.id) ?? EMPTY_LINKS, today));
}

/**
 * Wyszukiwarka notatek do przypięcia kafelka (GET /calendar/notes/search):
 * nieskasowane notatki nieskasowanych wydarzeń typu ≠ „notatka”, od najnowszych.
 * `q` szuka w treści notatki i w tytule wydarzenia (LIKE bez rozróżniania wielkości liter).
 *
 * `departments` ZAWĘŻA wynik do działów, które wolno oglądać wołającemu — bez tego
 * wyszukiwarka notatek byłaby najprostszą drogą do cudzych danych (treść notatki
 * i tytuł wydarzenia w jednym wierszu).
 */
export function searchNotes(dbx: DbOrTx, q: string, limit = 20, departments?: readonly CalendarDepartment[]): NoteBrief[] {
  const conds = [
    isNull(schema.calendarEventNotes.deletedAt),
    isNull(schema.calendarEvents.deletedAt),
    ne(schema.calendarEvents.type, "notatka"),
  ];
  if (departments) {
    if (departments.length === 0) return [];
    conds.push(inArray(schema.calendarEvents.department, [...departments]));
  }
  const needle = q.trim().toLowerCase();
  if (needle) {
    const pattern = `%${needle.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
    conds.push(
      sql`(lower(${schema.calendarEventNotes.text}) LIKE ${pattern} ESCAPE '\\' OR lower(coalesce(${schema.calendarEventNotes.mailSubject}, '')) LIKE ${pattern} ESCAPE '\\' OR lower(${schema.calendarEvents.title}) LIKE ${pattern} ESCAPE '\\')`
    );
  }
  const rows = dbx
    .select({
      id: schema.calendarEventNotes.id,
      eventId: schema.calendarEventNotes.eventId,
      text: schema.calendarEventNotes.text,
      kind: schema.calendarEventNotes.kind,
      mailSubject: schema.calendarEventNotes.mailSubject,
      userLabel: schema.calendarEventNotes.userLabel,
      createdAt: schema.calendarEventNotes.createdAt,
      eventTitle: schema.calendarEvents.title,
      eventStartAt: schema.calendarEvents.startAt,
      eventType: schema.calendarEvents.type,
    })
    .from(schema.calendarEventNotes)
    .innerJoin(schema.calendarEvents, eq(schema.calendarEventNotes.eventId, schema.calendarEvents.id))
    .where(and(...conds))
    .orderBy(desc(schema.calendarEventNotes.createdAt), desc(schema.calendarEventNotes.id))
    .limit(limit)
    .all();
  const counts = attachmentsCountByNote(dbx, rows.map((r) => r.id));
  // Lista wyników pokazuje SAM tekst — mail dostaje prefiks tematu (briefTextOf).
  return rows.map(({ kind, mailSubject, ...r }) => ({
    ...r,
    kind,
    text: briefTextOf({ kind, mailSubject, text: r.text }),
    attachmentsCount: counts.get(r.id) ?? 0,
  }));
}

/** Liczba nieusuniętych notatek per wydarzenie — jedno zapytanie zbiorcze. */
export function notesCountByEvent(dbx: DbOrTx, ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const rows = dbx
    .select({ eventId: schema.calendarEventNotes.eventId, n: sql<number>`count(*)` })
    .from(schema.calendarEventNotes)
    .where(and(inArray(schema.calendarEventNotes.eventId, ids), isNull(schema.calendarEventNotes.deletedAt)))
    .groupBy(schema.calendarEventNotes.eventId)
    .all();
  for (const r of rows) out.set(r.eventId, Number(r.n));
  return out;
}

const createdUsers = alias(schema.users, "cu");
const updatedUsers = alias(schema.users, "uu");

/** Pobiera i serializuje wydarzenia po id (kolejność wg `ids`; usunięte też — filtr robi wołający). */
export function loadEvents(dbx: DbOrTx, ids: number[]): CalendarEventJson[] {
  if (ids.length === 0) return [];
  const rows = dbx
    .select({
      ev: schema.calendarEvents,
      objectName: schema.objects.name,
      leadTitle: schema.leads.title,
      leadStage: schema.leads.stage,
      contactFirstName: schema.contacts.firstName,
      contactLastName: schema.contacts.lastName,
      contactPhone: schema.contacts.phone,
      createdByEmail: createdUsers.email,
      createdByName: createdUsers.displayName,
      updatedByEmail: updatedUsers.email,
      updatedByName: updatedUsers.displayName,
    })
    .from(schema.calendarEvents)
    .leftJoin(schema.objects, eq(schema.calendarEvents.objectId, schema.objects.id))
    .leftJoin(schema.leads, eq(schema.calendarEvents.leadId, schema.leads.id))
    .leftJoin(schema.contacts, eq(schema.calendarEvents.contactId, schema.contacts.id))
    .leftJoin(createdUsers, eq(schema.calendarEvents.createdBy, createdUsers.id))
    .leftJoin(updatedUsers, eq(schema.calendarEvents.updatedBy, updatedUsers.id))
    .where(inArray(schema.calendarEvents.id, ids))
    .all();

  const techRows = dbx
    .select({
      eventId: schema.calendarEventAssignees.eventId,
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
    })
    .from(schema.calendarEventAssignees)
    .innerJoin(schema.technicians, eq(schema.calendarEventAssignees.technicianId, schema.technicians.id))
    .where(inArray(schema.calendarEventAssignees.eventId, ids))
    .orderBy(asc(schema.technicians.lastName), asc(schema.technicians.firstName))
    .all();
  const techByEvent = new Map<number, TechnicianRef[]>();
  for (const t of techRows) {
    const list = techByEvent.get(t.eventId) ?? [];
    list.push({ id: t.id, firstName: t.firstName, lastName: t.lastName });
    techByEvent.set(t.eventId, list);
  }

  // Handlowcy — osobna tabela przypisań, ten sam batch (bez N+1).
  const salesRows = dbx
    .select({
      eventId: schema.calendarEventSalespeople.eventId,
      id: schema.salespeople.id,
      firstName: schema.salespeople.firstName,
      lastName: schema.salespeople.lastName,
    })
    .from(schema.calendarEventSalespeople)
    .innerJoin(schema.salespeople, eq(schema.calendarEventSalespeople.salespersonId, schema.salespeople.id))
    .where(inArray(schema.calendarEventSalespeople.eventId, ids))
    .orderBy(asc(schema.salespeople.lastName), asc(schema.salespeople.firstName))
    .all();
  const salesByEvent = new Map<number, SalespersonRef[]>();
  for (const s of salesRows) {
    const list = salesByEvent.get(s.eventId) ?? [];
    list.push({ id: s.id, firstName: s.firstName, lastName: s.lastName });
    salesByEvent.set(s.eventId, list);
  }

  const seriesIds = [...new Set(rows.map((r) => r.ev.seriesId).filter((x): x is number => x != null))];
  const seriesById = new Map<number, SeriesRef>();
  if (seriesIds.length > 0) {
    const sRows = dbx.select().from(schema.calendarSeries).where(inArray(schema.calendarSeries.id, seriesIds)).all();
    for (const s of sRows) {
      seriesById.set(s.id, { id: s.id, freq: s.freq, interval: s.interval, until: s.until, count: s.count });
    }
  }

  // Protokoły: jawne (protocol_id) + z realizacji (realization_id → protocols.realization_id), jedno zapytanie.
  const protoIds = [...new Set(rows.map((r) => r.ev.protocolId).filter((x): x is number => x != null))];
  const realIds = [...new Set(rows.map((r) => r.ev.realizationId).filter((x): x is number => x != null))];
  const protoById = new Map<number, ProtocolRef>();
  const protoByReal = new Map<number, ProtocolRef>();
  if (protoIds.length > 0 || realIds.length > 0) {
    const pConds = [];
    if (protoIds.length) pConds.push(inArray(schema.protocols.id, protoIds));
    if (realIds.length) pConds.push(inArray(schema.protocols.realizationId, realIds));
    const pRows = dbx
      .select({ id: schema.protocols.id, realizationId: schema.protocols.realizationId, number: schema.protocols.number, status: schema.protocols.status, signedAt: schema.protocols.signedAt, workDate: schema.protocols.workDate })
      .from(schema.protocols)
      .where(pConds.length === 1 ? pConds[0] : sql`${pConds[0]} OR ${pConds[1]}`)
      .all();
    for (const p of pRows) {
      const ref: ProtocolRef = { id: p.id, number: p.number, status: p.status, signedAt: p.signedAt, workDate: p.workDate };
      protoById.set(p.id, ref);
      protoByReal.set(p.realizationId, ref);
    }
  }

  // Realizacje wydarzeń (1:1 po realization_id) — jedno zapytanie zbiorcze.
  const realById = new Map<number, RealizationRef>();
  if (realIds.length > 0) {
    const rRows = dbx
      .select({
        id: schema.realizations.id,
        date: schema.realizations.date,
        site: schema.realizations.site,
        kind: schema.realizations.kind,
        invoiced: schema.realizations.invoiced,
        amountHours: schema.realizations.amountHours,
        amountMaterial: schema.realizations.amountMaterial,
        amountKm: schema.realizations.amountKm,
        discount: schema.realizations.discount,
      })
      .from(schema.realizations)
      .where(inArray(schema.realizations.id, realIds))
      .all();
    for (const r of rRows) {
      realById.set(r.id, {
        id: r.id,
        date: r.date,
        site: r.site,
        kind: r.kind,
        invoiced: r.invoiced,
        total: Math.round((r.amountHours + r.amountMaterial + r.amountKm - r.discount) * 100) / 100,
      });
    }
  }

  // Wyceny: jawne (quote_id) + z realizacji (realization_id → quotes.realization_id), jedno zapytanie.
  const quoteIds = [...new Set(rows.map((r) => r.ev.quoteId).filter((x): x is number => x != null))];
  const quoteById = new Map<number, QuoteRef>();
  const quoteByReal = new Map<number, QuoteRef>();
  if (quoteIds.length > 0 || realIds.length > 0) {
    const qConds = [];
    if (quoteIds.length) qConds.push(inArray(schema.quotes.id, quoteIds));
    if (realIds.length) qConds.push(inArray(schema.quotes.realizationId, realIds));
    const qRows = dbx
      .select({ id: schema.quotes.id, realizationId: schema.quotes.realizationId, number: schema.quotes.number, date: schema.quotes.date, items: schema.quotes.items })
      .from(schema.quotes)
      .where(qConds.length === 1 ? qConds[0] : sql`${qConds[0]} OR ${qConds[1]}`)
      .all();
    for (const q of qRows) {
      const ref: QuoteRef = { id: q.id, number: q.number, date: q.date, ...quoteTotals(q.items) };
      quoteById.set(q.id, ref);
      if (q.realizationId != null) quoteByReal.set(q.realizationId, ref);
    }
  }

  const notesCount = notesCountByEvent(dbx, ids);
  // Kafelki „notatka” → podgląd notatki źródłowej (tylko dla nich, więc zwykle 0 zapytań).
  const sourceNoteIds = [
    ...new Set(rows.filter((r) => r.ev.type === "notatka").map((r) => r.ev.noteId).filter((x): x is number => x != null)),
  ];
  const sourceNotes = loadSourceNotes(dbx, sourceNoteIds);
  const label = (email: string | null, name: string | null) => (email == null ? null : (name || "").trim() || email);

  const byId = new Map<number, CalendarEventJson>();
  for (const r of rows) {
    const e = r.ev;
    byId.set(e.id, {
      id: e.id,
      type: e.type,
      title: e.title,
      description: e.description,
      location: e.location,
      startAt: e.startAt,
      endAt: e.endAt,
      allDay: e.allDay,
      status: e.status,
      department: asDepartment(e.department),
      objectId: e.objectId,
      objectName: r.objectName ?? null,
      orderId: e.orderId,
      realizationId: e.realizationId,
      realization: (e.realizationId != null ? realById.get(e.realizationId) : null) ?? null,
      realizationOptout: e.realizationOptout,
      billing: e.billing,
      protocolId: e.protocolId,
      protocol: (e.protocolId != null ? protoById.get(e.protocolId) : null) ?? (e.realizationId != null ? protoByReal.get(e.realizationId) : null) ?? null,
      quoteId: e.quoteId,
      quote: (e.quoteId != null ? quoteById.get(e.quoteId) : null) ?? (e.realizationId != null ? quoteByReal.get(e.realizationId) : null) ?? null,
      seriesId: e.seriesId,
      series: e.seriesId != null ? (seriesById.get(e.seriesId) ?? null) : null,
      technicians: techByEvent.get(e.id) ?? [],
      salespeople: salesByEvent.get(e.id) ?? [],
      leadId: e.leadId,
      leadTitle: r.leadTitle ?? null,
      leadStage: r.leadStage ?? null,
      contactId: e.contactId,
      contactName: `${r.contactFirstName ?? ""} ${r.contactLastName ?? ""}`.trim() || null,
      contactPhone: r.contactPhone ?? null,
      createdBy: e.createdBy,
      createdByLabel: label(r.createdByEmail, r.createdByName),
      updatedBy: e.updatedBy,
      updatedByLabel: label(r.updatedByEmail, r.updatedByName),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      deletedAt: e.deletedAt,
      notesCount: notesCount.get(e.id) ?? 0,
      noteId: e.noteId,
      noteMention: e.noteMention,
      sourceNote: (e.type === "notatka" && e.noteId != null ? sourceNotes.get(e.noteId) : null) ?? null,
    });
  }
  return ids.map((id) => byId.get(id)).filter((x): x is CalendarEventJson => !!x);
}

export function loadEvent(dbx: DbOrTx, id: number): CalendarEventJson | null {
  return loadEvents(dbx, [id])[0] ?? null;
}
