/**
 * Grupy interwencyjne (/api/cma/intervention-groups) — firmy świadczące usługę
 * podjazdów na alarm, warunki tej usługi per obiekt i rejestr wykonanych podjazdów.
 *
 * Trzy panele zakładki `cma/grupy-interwencyjne` mają tu trzy rodziny tras:
 *   /companies      — słownik firm (miękkie archiwum `active`, umowy ramowe w załącznikach),
 *   /terms          — warunki obiektu w okresie (wiele wierszy = historia zmian firm),
 *   /interventions  — rejestr podjazdów z rozliczeniem liczonym PRZY ODCZYCIE.
 * Do tego picker obiektów, szablony maili i wysyłka (zapytanie o ofertę, wypowiedzenie).
 *
 * KOLEJNOŚĆ REJESTRACJI TRAS MA ZNACZENIE (Hono dopasowuje po kolei): `/pick/*`,
 * `/mail/*` i `/objects/:objectId/*` muszą stać przed trasami z gołym `/:id`.
 *
 * Picker `GET /pick/objects` jest TUTAJ, a nie w /objects, bo uprawnienia są
 * per-zakładka: ktoś z samym kluczem `cma/grupy-interwencyjne` dostałby 403 na
 * kartotece obiektów i nie mógłby dodać warunków. Zwraca wyłącznie nazwę, adres
 * i kontrahenta — bez kwot i statusów, więc nie otwiera kartoteki.
 *
 * Załączniki obsługuje wspólny moduł src/lib/calendar-attachments.ts (te same limity
 * 15 × 5 MB i konwersja obrazków do WebP), scope'y: `interventions/companies/<id>`,
 * `interventions/terms/<id>`, `interventions/interventions/<id>`.
 */
import { Hono, type Context } from "hono";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type {
  CalendarAttachmentKind,
  Intervention,
  InterventionAttachment,
  InterventionCompany,
  InterventionCompanyAttachment,
  InterventionTerm,
  InterventionTermAttachment,
} from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { logActivity, logFieldDiffs } from "../lib/activity-log.js";
import { ApiError } from "../lib/calendar-labels.js";
import {
  attachmentFilePath,
  contentDisposition,
  removeAttachmentDir,
  removeStoredFiles,
  storeUploads,
  ATTACHMENT_MAX_FILES,
  type IncomingFile,
  type StoredAttachment,
} from "../lib/calendar-attachments.js";
import {
  overlappingTerm,
  resolveTermFor,
  settleInterventions,
  summarize,
  type Settlement,
  type SettlementTerm,
} from "../lib/intervention-terms.js";
import {
  BODY_MAX,
  INTERVENTION_MAIL_FIELDS,
  PLACEHOLDERS,
  SUBJECT_MAX,
  deleteInterventionTemplate,
  getInterventionTemplate,
  getInterventionTemplates,
  isInterventionMailKind,
  renderInterventionMail,
  type InterventionMailKind,
} from "../lib/intervention-mail.js";
import { resolveBaseUrl } from "../lib/order-mail.js";
import { getMailConfig, isEmail, isMailSendingReady, normalizeAddresses } from "../lib/mail-config.js";
import { sendMail } from "../services/mail-sender.js";
import { setSetting } from "../lib/settings.js";
import { zonedToday } from "../lib/tz.js";

const app = new Hono();

/** Encje w activity_log. */
const ENTITY_COMPANY = "intervention_company";
const ENTITY_TERM = "intervention_term";
const ENTITY_INTERVENTION = "intervention";
const ENTITY_TEMPLATE = "intervention_template";

/** Encja w mail_log — jeden `entity_id` na wiersz, więc trzymamy tam firmę. */
const MAIL_ENTITY = "intervention_group";

/** Prefiks URL tras plikowych (router montowany pod /api/cma/intervention-groups). */
const API_PREFIX = "/api/cma/intervention-groups";

type OwnerGroup = "companies" | "terms" | "interventions";

const scopeOf = (group: OwnerGroup, id: number) => `interventions/${group}/${id}`;

// ---------------------------------------------------------------------------
// Kształt JSON (kontrakt z frontem — frontend/src/lib/api.ts, interventionsApi)
// ---------------------------------------------------------------------------

export interface AttachmentJson {
  id: number;
  fileName: string;
  mimeType: string;
  size: number;
  kind: CalendarAttachmentKind;
  width: number | null;
  height: number | null;
  /** Podgląd w przeglądarce (Content-Disposition: inline). */
  url: string;
  /** Pobranie pliku (Content-Disposition: attachment). */
  downloadUrl: string;
  createdAt: string;
}

export interface CompanyJson {
  id: number;
  name: string;
  area: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  /** Ile RÓŻNYCH obiektów miało kiedykolwiek warunki z tą firmą. */
  objectsCount: number;
  /** Ile wierszy warunków obowiązuje dziś. */
  activeTermsCount: number;
  attachments: AttachmentJson[];
  createdAt: string;
  updatedAt: string;
}

export interface TermJson {
  id: number;
  objectId: number;
  companyId: number;
  companyName: string;
  objectName: string;
  objectAddress: string | null;
  objectCity: string | null;
  contractorName: string | null;
  startDate: string;
  endDate: string | null;
  calloutFee: number | null;
  subscriptionFee: number | null;
  freeCallouts: number | null;
  hourlyStandbyFee: number | null;
  notes: string | null;
  isCurrent: boolean;
  attachments: AttachmentJson[];
  createdAt: string;
  updatedAt: string;
}

export interface InterventionJson {
  id: number;
  objectId: number;
  objectName: string;
  objectCity: string | null;
  companyId: number;
  companyName: string;
  termId: number;
  happenedAt: string;
  reason: string | null;
  reportedBy: string | null;
  standbyHours: number | null;
  notes: string | null;
  seqInMonth: number;
  isFree: boolean;
  calloutCost: number | null;
  standbyCost: number | null;
  totalCost: number | null;
  attachments: AttachmentJson[];
  createdAt: string;
  updatedAt: string;
}

/** Wspólny kształt wiersza załącznika we wszystkich trzech tabelach. */
type AttachmentRow = {
  id: number;
  fileName: string;
  mime: string;
  size: number;
  kind: CalendarAttachmentKind;
  width: number | null;
  height: number | null;
  createdAt: string;
};

function attachmentJson(group: OwnerGroup, ownerId: number, r: AttachmentRow): AttachmentJson {
  const base = `${API_PREFIX}/${group}/${ownerId}/attachments/${r.id}/download`;
  return {
    id: r.id,
    fileName: r.fileName,
    mimeType: r.mime,
    size: r.size,
    kind: r.kind,
    width: r.width,
    height: r.height,
    url: `${base}?inline=1`,
    downloadUrl: base,
    createdAt: r.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Odczyt załączników — zawsze wsadowo (wzorzec attachmentsByManual)
// ---------------------------------------------------------------------------

function groupAttachments(
  group: OwnerGroup,
  rows: (AttachmentRow & { ownerId: number })[]
): Map<number, AttachmentJson[]> {
  const out = new Map<number, AttachmentJson[]>();
  for (const r of rows) {
    const list = out.get(r.ownerId) ?? [];
    list.push(attachmentJson(group, r.ownerId, r));
    out.set(r.ownerId, list);
  }
  return out;
}

function attachmentsByCompany(ids: number[]): Map<number, AttachmentJson[]> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select()
    .from(schema.interventionCompanyAttachments)
    .where(inArray(schema.interventionCompanyAttachments.companyId, ids))
    .orderBy(asc(schema.interventionCompanyAttachments.id))
    .all();
  return groupAttachments(
    "companies",
    rows.map((r: InterventionCompanyAttachment) => ({ ...r, ownerId: r.companyId }))
  );
}

function attachmentsByTerm(ids: number[]): Map<number, AttachmentJson[]> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select()
    .from(schema.interventionTermAttachments)
    .where(inArray(schema.interventionTermAttachments.termId, ids))
    .orderBy(asc(schema.interventionTermAttachments.id))
    .all();
  return groupAttachments(
    "terms",
    rows.map((r: InterventionTermAttachment) => ({ ...r, ownerId: r.termId }))
  );
}

function attachmentsByIntervention(ids: number[]): Map<number, AttachmentJson[]> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select()
    .from(schema.interventionAttachments)
    .where(inArray(schema.interventionAttachments.interventionId, ids))
    .orderBy(asc(schema.interventionAttachments.id))
    .all();
  return groupAttachments(
    "interventions",
    rows.map((r: InterventionAttachment) => ({ ...r, ownerId: r.interventionId }))
  );
}

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Tekst z formularza: pusty → null (kolumna nieuzupełniona, a nie pusty napis). */
function textOrNull(v: unknown, label: string, maxLen = 500): string | null {
  const s = str(v);
  if (!s) return null;
  if (s.length > maxLen) throw new ApiError(400, `${label}: maks. ${maxLen} znaków`);
  return s;
}

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`Błąd ${what}:`, error);
  return c.json({ success: false, error: `Błąd ${what}` }, 500);
}

/** Id z parametru ścieżki albo ApiError 400. */
function idParam(c: Context, name: string): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Nieprawidłowe id");
  return id;
}

/** Wartownik dla kwoty, której nie da się sparsować (wzorzec src/routes/salespeople.ts). */
const INVALID = Symbol("invalid-amount");

/** Kwota z formularza: brak / pusty string → null (nieuzupełnione), śmieć → INVALID. */
function parseAmount(raw: unknown): number | null | typeof INVALID {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : INVALID;
  if (typeof raw !== "string") return INVALID;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(",", "."));
  return Number.isFinite(n) ? n : INVALID;
}

/** Kwota nieujemna albo 400 z polskim komunikatem. */
function amountField(raw: unknown, label: string): number | null {
  const v = parseAmount(raw);
  if (v === INVALID) throw new ApiError(400, `${label} musi być liczbą`);
  if (v !== null && v < 0) throw new ApiError(400, `${label} nie może być ujemna`);
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function parseDate(raw: unknown, label: string, required: boolean): string | null {
  const s = str(raw);
  if (!s) {
    if (required) throw new ApiError(400, `${label} jest wymagana`);
    return null;
  }
  if (!DATE_RE.test(s)) throw new ApiError(400, `Nieprawidłowa ${label.toLowerCase()} (format RRRR-MM-DD)`);
  return s;
}

/** Login/nazwa do podpisu maila i kolumn autorskich. */
function senderLabel(c: Context): string {
  const u = getUser(c);
  return (u.displayName || "").trim() || u.email || String(u.id);
}

/** Pliki z multipartu (pole `files`) — kopia z src/routes/manuals.ts. */
async function readFiles(c: Context): Promise<{ form: FormData; files: IncomingFile[] }> {
  const ct = c.req.header("content-type") ?? "";
  if (!/multipart\/form-data/i.test(ct)) throw new ApiError(400, "Wymagany formularz multipart/form-data");
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new ApiError(400, "Nieprawidłowe dane formularza");
  const files: IncomingFile[] = [];
  for (const entry of form.getAll("files")) {
    if (!(entry instanceof File)) continue;
    files.push({ name: entry.name, mime: entry.type, data: Buffer.from(await entry.arrayBuffer()) });
  }
  return { form, files };
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Nieprawidłowe dane");
  return body;
}

const NOW_DATE = sql`date('now')`;

// ---------------------------------------------------------------------------
// Firmy — odczyt
// ---------------------------------------------------------------------------

/**
 * Liczniki liczymy skorelowanymi podzapytaniami (wzorzec src/routes/companies.ts).
 * Odwołanie do kolumny nadrzędnej piszemy DOSŁOWNIE (`intervention_companies.id`):
 * drizzle wyrenderowałby `${schema...id}` jako niekwalifikowane „id”, które
 * wewnątrz podzapytania trafiłoby w kolumnę tabeli z podzapytania.
 */
function companyRows(where = undefined as ReturnType<typeof and> | undefined) {
  return db
    .select({
      company: schema.interventionCompanies,
      objectsCount: sql<number>`(
        select count(distinct object_id) from intervention_terms
        where intervention_terms.company_id = intervention_companies.id
      )`,
      activeTermsCount: sql<number>`(
        select count(*) from intervention_terms
        where intervention_terms.company_id = intervention_companies.id
          and (intervention_terms.end_date is null or intervention_terms.end_date >= date('now'))
      )`,
    })
    .from(schema.interventionCompanies)
    .where(where)
    .orderBy(desc(schema.interventionCompanies.active), asc(sql`lower(${schema.interventionCompanies.name})`))
    .all();
}

function serializeCompanies(
  rows: { company: InterventionCompany; objectsCount: number; activeTermsCount: number }[]
): CompanyJson[] {
  const atts = attachmentsByCompany(rows.map((r) => r.company.id));
  return rows.map((r) => ({
    id: r.company.id,
    name: r.company.name,
    area: r.company.area,
    contactPerson: r.company.contactPerson,
    phone: r.company.phone,
    email: r.company.email,
    notes: r.company.notes,
    active: r.company.active,
    objectsCount: r.objectsCount ?? 0,
    activeTermsCount: r.activeTermsCount ?? 0,
    attachments: atts.get(r.company.id) ?? [],
    createdAt: r.company.createdAt,
    updatedAt: r.company.updatedAt,
  }));
}

/** Pełny JSON jednej firmy albo null. */
function loadCompany(id: number): CompanyJson | null {
  const rows = companyRows(and(eq(schema.interventionCompanies.id, id)));
  return rows.length ? serializeCompanies(rows)[0] : null;
}

function companyRow(id: number): InterventionCompany | undefined {
  return db
    .select()
    .from(schema.interventionCompanies)
    .where(eq(schema.interventionCompanies.id, id))
    .get();
}

// ---------------------------------------------------------------------------
// Warunki — odczyt
// ---------------------------------------------------------------------------

type TermQueryRow = {
  term: InterventionTerm;
  companyName: string;
  objectName: string;
  objectAddress: string | null;
  objectCity: string | null;
  contractorName: string | null;
  isCurrent: number;
};

/** Warunki z nazwami obiektu, kontrahenta i firmy — jedno zapytanie na całą listę. */
function termsQuery(where: ReturnType<typeof and> | undefined, orderByObject: boolean): TermQueryRow[] {
  const q = db
    .select({
      term: schema.interventionTerms,
      companyName: schema.interventionCompanies.name,
      objectName: schema.objects.name,
      objectAddress: schema.objects.address,
      objectCity: schema.objects.city,
      contractorName: schema.contractors.name,
      isCurrent: sql<number>`case when ${schema.interventionTerms.endDate} is null
        or ${schema.interventionTerms.endDate} >= ${NOW_DATE} then 1 else 0 end`,
    })
    .from(schema.interventionTerms)
    .innerJoin(schema.interventionCompanies, eq(schema.interventionTerms.companyId, schema.interventionCompanies.id))
    .innerJoin(schema.objects, eq(schema.interventionTerms.objectId, schema.objects.id))
    .leftJoin(schema.contractors, eq(schema.objects.contractorId, schema.contractors.id))
    .where(where);
  const ordered = orderByObject
    ? q.orderBy(
        asc(sql`lower(${schema.objects.name})`),
        desc(schema.interventionTerms.startDate),
        desc(schema.interventionTerms.id)
      )
    : q.orderBy(desc(schema.interventionTerms.startDate), desc(schema.interventionTerms.id));
  return ordered.all();
}

function serializeTerms(rows: TermQueryRow[]): TermJson[] {
  const atts = attachmentsByTerm(rows.map((r) => r.term.id));
  return rows.map((r) => ({
    id: r.term.id,
    objectId: r.term.objectId,
    companyId: r.term.companyId,
    companyName: r.companyName,
    objectName: r.objectName,
    objectAddress: r.objectAddress,
    objectCity: r.objectCity,
    contractorName: r.contractorName,
    startDate: r.term.startDate,
    endDate: r.term.endDate,
    calloutFee: r.term.calloutFee,
    subscriptionFee: r.term.subscriptionFee,
    freeCallouts: r.term.freeCallouts,
    hourlyStandbyFee: r.term.hourlyStandbyFee,
    notes: r.term.notes,
    isCurrent: r.isCurrent === 1,
    attachments: atts.get(r.term.id) ?? [],
    createdAt: r.term.createdAt,
    updatedAt: r.term.updatedAt,
  }));
}

function loadTerm(id: number): TermJson | null {
  const rows = termsQuery(and(eq(schema.interventionTerms.id, id)), false);
  return rows.length ? serializeTerms(rows)[0] : null;
}

function termRow(id: number): InterventionTerm | undefined {
  return db.select().from(schema.interventionTerms).where(eq(schema.interventionTerms.id, id)).get();
}

// ---------------------------------------------------------------------------
// Interwencje — odczyt i rozliczenie
// ---------------------------------------------------------------------------

type InterventionQueryRow = {
  row: Intervention;
  objectName: string;
  objectCity: string | null;
  companyName: string;
};

function interventionsQuery(where: ReturnType<typeof and> | undefined): InterventionQueryRow[] {
  return db
    .select({
      row: schema.interventions,
      objectName: schema.objects.name,
      objectCity: schema.objects.city,
      companyName: schema.interventionCompanies.name,
    })
    .from(schema.interventions)
    .innerJoin(schema.objects, eq(schema.interventions.objectId, schema.objects.id))
    .innerJoin(schema.interventionCompanies, eq(schema.interventions.companyId, schema.interventionCompanies.id))
    .where(where)
    .orderBy(desc(schema.interventions.happenedAt), desc(schema.interventions.id))
    .all();
}

/** Warunki potrzebne do rozliczenia wskazanych interwencji (jedno zapytanie). */
function termsForSettlement(termIds: number[]): Map<number, SettlementTerm> {
  const out = new Map<number, SettlementTerm>();
  if (termIds.length === 0) return out;
  const rows = db
    .select({
      id: schema.interventionTerms.id,
      calloutFee: schema.interventionTerms.calloutFee,
      freeCallouts: schema.interventionTerms.freeCallouts,
      hourlyStandbyFee: schema.interventionTerms.hourlyStandbyFee,
    })
    .from(schema.interventionTerms)
    .where(inArray(schema.interventionTerms.id, [...new Set(termIds)]))
    .all();
  for (const r of rows) out.set(r.id, r);
  return out;
}

/**
 * Serializacja + rozliczenie. `rows` MUSI być pełnym zbiorem miesiąca dla obiektu —
 * filtry po firmie i szukajce nakładamy dopiero na wynik, inaczej filtr przesuwałby
 * numerację i zmieniał, który podjazd jest darmowy.
 */
function serializeInterventions(rows: InterventionQueryRow[]): InterventionJson[] {
  const terms = termsForSettlement(rows.map((r) => r.row.termId));
  const settlement = settleInterventions(
    rows.map((r) => r.row),
    terms
  );
  const atts = attachmentsByIntervention(rows.map((r) => r.row.id));
  const empty: Settlement = { seqInMonth: 1, isFree: false, calloutCost: null, standbyCost: null, totalCost: null };
  return rows.map((r) => {
    const s = settlement.get(r.row.id) ?? empty;
    return {
      id: r.row.id,
      objectId: r.row.objectId,
      objectName: r.objectName,
      objectCity: r.objectCity,
      companyId: r.row.companyId,
      companyName: r.companyName,
      termId: r.row.termId,
      happenedAt: r.row.happenedAt,
      reason: r.row.reason,
      reportedBy: r.row.reportedBy,
      standbyHours: r.row.standbyHours,
      notes: r.row.notes,
      seqInMonth: s.seqInMonth,
      isFree: s.isFree,
      calloutCost: s.calloutCost,
      standbyCost: s.standbyCost,
      totalCost: s.totalCost,
      attachments: atts.get(r.row.id) ?? [],
      createdAt: r.row.createdAt,
      updatedAt: r.row.updatedAt,
    };
  });
}

function loadIntervention(id: number): InterventionJson | null {
  const row = db.select().from(schema.interventions).where(eq(schema.interventions.id, id)).get();
  if (!row) return null;
  // Rozliczenie wymaga pełnego miesiąca dla pary (obiekt, warunki) — inaczej
  // pojedynczy odczyt pokazywałby numer 1 dla każdego podjazdu.
  const month = row.happenedAt.slice(0, 7);
  const rows = interventionsQuery(
    and(eq(schema.interventions.objectId, row.objectId), like(schema.interventions.happenedAt, `${month}%`))
  );
  return serializeInterventions(rows).find((i) => i.id === id) ?? null;
}

function interventionRow(id: number): Intervention | undefined {
  return db.select().from(schema.interventions).where(eq(schema.interventions.id, id)).get();
}

// ---------------------------------------------------------------------------
// Picker obiektów — PRZED trasami z /:id
// ---------------------------------------------------------------------------

const PICK_LIMIT = 30;

app.get("/pick/objects", (c) => {
  const q = str(c.req.query("q")).toLowerCase();
  const rows = db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      contractorName: schema.contractors.name,
    })
    .from(schema.objects)
    .leftJoin(schema.contractors, eq(schema.objects.contractorId, schema.contractors.id))
    .where(
      q
        ? or(
            sql`lower(${schema.objects.name}) like ${"%" + q + "%"}`,
            sql`lower(coalesce(${schema.objects.address}, '')) like ${"%" + q + "%"}`,
            sql`lower(coalesce(${schema.objects.city}, '')) like ${"%" + q + "%"}`,
            sql`lower(coalesce(${schema.contractors.name}, '')) like ${"%" + q + "%"}`
          )
        : undefined
    )
    .orderBy(asc(sql`lower(${schema.objects.name})`))
    .limit(PICK_LIMIT)
    .all();
  return c.json({ success: true, data: { items: rows } });
});

// ---------------------------------------------------------------------------
// Szablony maili i wysyłka — PRZED trasami z /:id
// ---------------------------------------------------------------------------

function kindParam(c: Context): InterventionMailKind {
  const kind = c.req.param("kind");
  if (!isInterventionMailKind(kind)) throw new ApiError(400, "Nieprawidłowy rodzaj wiadomości");
  return kind;
}

app.get("/mail/templates", (c) => {
  return c.json({ success: true, data: { items: getInterventionTemplates(), placeholders: PLACEHOLDERS } });
});

app.put("/mail/templates/:kind", async (c) => {
  try {
    const kind = kindParam(c);
    const body = await readJsonBody(c);
    const def = INTERVENTION_MAIL_FIELDS[kind];
    const subject = str(body.subject);
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!subject) throw new ApiError(400, "Temat wiadomości jest wymagany");
    if (subject.length > SUBJECT_MAX) throw new ApiError(400, `Temat wiadomości jest za długi (maks. ${SUBJECT_MAX} znaków)`);
    if (!text) throw new ApiError(400, "Treść wiadomości jest wymagana");
    if (text.length > BODY_MAX) throw new ApiError(400, `Treść wiadomości jest za długa (maks. ${BODY_MAX} znaków)`);

    const user = getUser(c);
    db.transaction((tx) => {
      setSetting(def.subject.dbKey, subject, user.id, tx);
      setSetting(def.body.dbKey, text, user.id, tx);
    });
    logActivity(db, {
      entityType: ENTITY_TEMPLATE,
      entityId: 0,
      user,
      action: "updated",
      field: kind,
      summary: `Zmieniono szablon wiadomości: ${def.label}`,
    });
    return c.json({ success: true, data: getInterventionTemplate(kind) });
  } catch (error) {
    return handleError(c, error, "zapisu szablonu wiadomości");
  }
});

app.delete("/mail/templates/:kind", (c) => {
  try {
    const kind = kindParam(c);
    deleteInterventionTemplate(kind);
    logActivity(db, {
      entityType: ENTITY_TEMPLATE,
      entityId: 0,
      user: getUser(c),
      action: "updated",
      field: kind,
      summary: `Przywrócono domyślny szablon wiadomości: ${INTERVENTION_MAIL_FIELDS[kind].label}`,
    });
    return c.json({ success: true, data: getInterventionTemplate(kind) });
  } catch (error) {
    return handleError(c, error, "przywracania szablonu wiadomości");
  }
});

/**
 * Dane do wyrenderowania wiadomości. `termination` MUSI mieć warunki — to z nich
 * biorą się obie daty i obiekt; `rfq` może iść z samym obiektem albo bez niego
 * (wtedy tokeny obiektu wracają w `missing`).
 */
function mailContext(body: Record<string, unknown>): {
  kind: InterventionMailKind;
  company: InterventionCompany;
  object: { id: number; name: string; address: string | null; city: string | null } | null;
  term: InterventionTerm | null;
} {
  const kind = body.kind;
  if (!isInterventionMailKind(kind)) throw new ApiError(400, "Nieprawidłowy rodzaj wiadomości");

  const companyId = Number(body.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new ApiError(400, "Nie wskazano firmy");
  const company = companyRow(companyId);
  if (!company) throw new ApiError(404, "Firma nie istnieje");

  let term: InterventionTerm | null = null;
  if (body.termId !== undefined && body.termId !== null && body.termId !== "") {
    const termId = Number(body.termId);
    if (!Number.isInteger(termId) || termId <= 0) throw new ApiError(400, "Nieprawidłowe warunki");
    term = termRow(termId) ?? null;
    if (!term) throw new ApiError(404, "Warunki nie istnieją");
  }
  if (kind === "termination" && !term) {
    throw new ApiError(400, "Wypowiedzenie wymaga wskazania warunków");
  }

  let objectId: number | null = term ? term.objectId : null;
  if (!objectId && body.objectId !== undefined && body.objectId !== null && body.objectId !== "") {
    const parsed = Number(body.objectId);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new ApiError(400, "Nieprawidłowy obiekt");
    objectId = parsed;
  }
  let object: { id: number; name: string; address: string | null; city: string | null } | null = null;
  if (objectId) {
    const row = db
      .select({
        id: schema.objects.id,
        name: schema.objects.name,
        address: schema.objects.address,
        city: schema.objects.city,
      })
      .from(schema.objects)
      .where(eq(schema.objects.id, objectId))
      .get();
    if (!row) throw new ApiError(404, "Obiekt nie istnieje");
    object = row;
  }
  return { kind, company, object, term };
}

app.post("/mail/preview", async (c) => {
  try {
    const body = await readJsonBody(c);
    const ctx = mailContext(body);
    const mail = renderInterventionMail({
      kind: ctx.kind,
      company: ctx.company,
      object: ctx.object,
      term: ctx.term,
      sender: senderLabel(c),
      baseUrl: resolveBaseUrl(c),
    });
    const { values } = getMailConfig();
    return c.json({
      success: true,
      data: {
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        to: (ctx.company.email || "").trim(),
        missing: mail.missing,
        sending: isMailSendingReady(values),
      },
    });
  } catch (error) {
    return handleError(c, error, "podglądu wiadomości");
  }
});

app.post("/mail/send", async (c) => {
  try {
    const body = await readJsonBody(c);
    const ctx = mailContext(body);

    const readList = (v: unknown): string[] =>
      Array.isArray(v) ? normalizeAddresses(v) : typeof v === "string" ? normalizeAddresses(v.split(/[,;\s]+/)) : [];
    const to = readList(body.to);
    const cc = readList(body.cc);
    const bcc = readList(body.bcc);
    const bad = [...to, ...cc, ...bcc].filter((a) => !isEmail(a));
    if (bad.length) throw new ApiError(400, `Nieprawidłowe adresy e-mail: ${bad.join(", ")}`);
    if (!to.length) throw new ApiError(400, "Podaj co najmniej jednego adresata");

    // Treść składamy TU, na serwerze, tym samym builderem co podgląd — front
    // przysyła wyłącznie rodzaj wiadomości i adresatów.
    const mail = renderInterventionMail({
      kind: ctx.kind,
      company: ctx.company,
      object: ctx.object,
      term: ctx.term,
      sender: senderLabel(c),
      baseUrl: resolveBaseUrl(c),
    });

    const user = getUser(c);
    const result = await sendMail({
      to,
      cc,
      bcc,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      entityType: MAIL_ENTITY,
      entityId: ctx.company.id,
      variant: ctx.kind,
      user,
    });

    const label = INTERVENTION_MAIL_FIELDS[ctx.kind].label;
    const summary = result.ok
      ? `Wysłano mail (${label}) do ${to.join(", ")}`
      : `Nieudana wysyłka maila (${label}) do ${to.join(", ")}: ${result.error}`;
    logActivity(db, {
      entityType: ENTITY_COMPANY,
      entityId: ctx.company.id,
      user,
      action: "note_added",
      field: "mail",
      newValue: result.ok ? "sent" : "failed",
      summary,
    });
    // Ślad przy obiekcie: mail_log ma jedno entity_id (firma), więc historia
    // obiektu dostaje wpis przez activity_log.objectId.
    if (ctx.term) {
      logActivity(db, {
        entityType: ENTITY_TERM,
        entityId: ctx.term.id,
        objectId: ctx.term.objectId,
        user,
        action: "note_added",
        field: "mail",
        newValue: result.ok ? "sent" : "failed",
        summary: `${summary} (firma ${ctx.company.name})`,
      });
    }

    if (!result.ok) {
      return c.json({ success: false, error: result.error, data: { logEntry: result.logEntry } }, 502);
    }
    return c.json({ success: true, data: { logEntry: result.logEntry } });
  } catch (error) {
    return handleError(c, error, "wysyłki wiadomości");
  }
});

app.get("/mail/log", (c) => {
  const companyIdRaw = c.req.query("companyId");
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const conds = [eq(schema.mailLog.entityType, MAIL_ENTITY)];
  if (companyIdRaw !== undefined && companyIdRaw !== "") {
    const companyId = Number(companyIdRaw);
    if (!Number.isInteger(companyId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
    conds.push(eq(schema.mailLog.entityId, companyId));
  }
  const items = db
    .select()
    .from(schema.mailLog)
    .where(and(...conds))
    .orderBy(desc(schema.mailLog.id))
    .limit(limit)
    .all();
  return c.json({ success: true, data: { items } });
});

// ---------------------------------------------------------------------------
// Warunki i interwencje z karty obiektu — PRZED trasami z /:id
// ---------------------------------------------------------------------------

app.get("/objects/:objectId/terms", (c) => {
  try {
    const objectId = idParam(c, "objectId");
    const rows = termsQuery(and(eq(schema.interventionTerms.objectId, objectId)), false);
    return c.json({ success: true, data: { items: serializeTerms(rows) } });
  } catch (error) {
    return handleError(c, error, "pobierania warunków obiektu");
  }
});

app.get("/objects/:objectId/interventions", (c) => {
  try {
    const objectId = idParam(c, "objectId");
    const month = str(c.req.query("month"));
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new ApiError(400, "Nieprawidłowy miesiąc (format RRRR-MM)");
    // Bez `month` wracamy CAŁĄ historię obiektu — karta obiektu pokazuje przebieg
    // współpracy, a nie bieżący miesiąc.
    const conds = [eq(schema.interventions.objectId, objectId)];
    if (month) conds.push(like(schema.interventions.happenedAt, `${month}%`));
    const items = serializeInterventions(interventionsQuery(and(...conds)));
    return c.json({ success: true, data: { items, summary: summarize(items) } });
  } catch (error) {
    return handleError(c, error, "pobierania interwencji obiektu");
  }
});

// ---------------------------------------------------------------------------
// Firmy — zapis
// ---------------------------------------------------------------------------

interface CompanyFields {
  name: string;
  area: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
}

function parseCompanyBody(body: Record<string, unknown>): CompanyFields {
  const name = str(body.name);
  if (!name) throw new ApiError(400, "Nazwa firmy jest wymagana");
  if (name.length > 200) throw new ApiError(400, "Nazwa firmy jest za długa (maks. 200 znaków)");
  const email = str(body.email);
  if (email && !isEmail(email)) throw new ApiError(400, `Nieprawidłowy adres e-mail: ${email}`);
  return {
    name,
    area: textOrNull(body.area, "Obszar działania", 200),
    contactPerson: textOrNull(body.contactPerson, "Osoba kontaktowa", 200),
    phone: textOrNull(body.phone, "Telefon", 100),
    email: email || null,
    notes: textOrNull(body.notes, "Notatki", 5000),
    active: body.active === undefined ? true : Boolean(body.active),
  };
}

/** Duplikat nazwy bez względu na wielkość liter (SQLite: LOWER na obu stronach). */
function duplicateCompany(name: string, excludeId?: number): InterventionCompany | undefined {
  const conds = [sql`lower(${schema.interventionCompanies.name}) = ${name.toLowerCase()}`];
  if (excludeId !== undefined) conds.push(sql`${schema.interventionCompanies.id} <> ${excludeId}`);
  return db
    .select()
    .from(schema.interventionCompanies)
    .where(and(...conds))
    .get();
}

app.get("/companies", (c) => {
  try {
    const q = str(c.req.query("q")).toLowerCase();
    const status = str(c.req.query("status")) || "all";
    if (!["all", "active", "archived"].includes(status)) throw new ApiError(400, "Nieprawidłowy status");
    const conds = [];
    if (status === "active") conds.push(eq(schema.interventionCompanies.active, true));
    if (status === "archived") conds.push(eq(schema.interventionCompanies.active, false));
    if (q) {
      conds.push(
        or(
          sql`lower(${schema.interventionCompanies.name}) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.interventionCompanies.area}, '')) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.interventionCompanies.contactPerson}, '')) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.interventionCompanies.email}, '')) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.interventionCompanies.phone}, '')) like ${"%" + q + "%"}`
        )!
      );
    }
    const rows = companyRows(conds.length ? and(...conds) : undefined);
    return c.json({ success: true, data: { items: serializeCompanies(rows) } });
  } catch (error) {
    return handleError(c, error, "pobierania firm interwencyjnych");
  }
});

app.post("/companies", async (c) => {
  try {
    const body = await readJsonBody(c);
    const data = parseCompanyBody(body);
    if (duplicateCompany(data.name)) throw new ApiError(409, "Firma o tej nazwie już istnieje");
    const created = db.insert(schema.interventionCompanies).values(data).returning().get();
    logActivity(db, {
      entityType: ENTITY_COMPANY,
      entityId: created.id,
      user: getUser(c),
      action: "created",
      summary: `Dodano firmę interwencyjną: ${created.name}`,
    });
    return c.json({ success: true, data: loadCompany(created.id) }, 201);
  } catch (error) {
    return handleError(c, error, "dodawania firmy interwencyjnej");
  }
});

app.put("/companies/:id", async (c) => {
  try {
    const id = idParam(c, "id");
    const before = companyRow(id);
    if (!before) throw new ApiError(404, "Firma nie istnieje");
    const body = await readJsonBody(c);
    const user = getUser(c);

    // Sam przełącznik archiwum (PUT { active }) nie musi nieść całego formularza
    // (wzorzec src/routes/salespeople.ts).
    if (Object.keys(body).length === 1 && typeof body.active === "boolean") {
      const after = db
        .update(schema.interventionCompanies)
        .set({ active: body.active, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.interventionCompanies.id, id))
        .returning()
        .get();
      logActivity(db, {
        entityType: ENTITY_COMPANY,
        entityId: id,
        user,
        action: "updated",
        field: "active",
        oldValue: before.active,
        newValue: after.active,
        summary: body.active
          ? `Przywrócono firmę interwencyjną: ${after.name}`
          : `Zarchiwizowano firmę interwencyjną: ${after.name}`,
      });
      return c.json({ success: true, data: loadCompany(id) });
    }

    const data = parseCompanyBody(body);
    if (duplicateCompany(data.name, id)) throw new ApiError(409, "Firma o tej nazwie już istnieje");
    const after = db
      .update(schema.interventionCompanies)
      .set({ ...data, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.interventionCompanies.id, id))
      .returning()
      .get();
    logFieldDiffs(db, {
      entityType: ENTITY_COMPANY,
      entityId: id,
      user,
      before,
      after,
      fields: [
        { key: "name", label: "nazwę firmy" },
        { key: "area", label: "obszar działania" },
        { key: "contactPerson", label: "osobę kontaktową" },
        { key: "phone", label: "telefon" },
        { key: "email", label: "e-mail" },
        { key: "notes", label: "notatki" },
        { key: "active", label: "status", format: (v) => (v ? "aktywna" : "zarchiwizowana") },
      ],
    });
    return c.json({ success: true, data: loadCompany(id) });
  } catch (error) {
    return handleError(c, error, "zapisu firmy interwencyjnej");
  }
});

app.delete("/companies/:id", (c) => {
  try {
    const id = idParam(c, "id");
    const row = companyRow(id);
    if (!row) throw new ApiError(404, "Firma nie istnieje");
    const used = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interventionTerms)
      .where(eq(schema.interventionTerms.companyId, id))
      .get();
    const n = used?.n ?? 0;
    if (n > 0) {
      throw new ApiError(409, `Firma ma przypisane warunki (${n}) — zarchiwizuj zamiast usuwać`);
    }
    db.delete(schema.interventionCompanies).where(eq(schema.interventionCompanies.id, id)).run();
    // Katalog kasujemy PO usunięciu wierszy — nieudane usunięcie nie zabiera plików.
    removeAttachmentDir(scopeOf("companies", id));
    logActivity(db, {
      entityType: ENTITY_COMPANY,
      entityId: id,
      user: getUser(c),
      action: "deleted",
      summary: `Usunięto firmę interwencyjną: ${row.name}`,
    });
    return c.json({ success: true, data: { id } });
  } catch (error) {
    return handleError(c, error, "usuwania firmy interwencyjnej");
  }
});

// ---------------------------------------------------------------------------
// Warunki — zapis
// ---------------------------------------------------------------------------

interface TermFields {
  companyId: number;
  startDate: string;
  endDate: string | null;
  calloutFee: number | null;
  subscriptionFee: number | null;
  freeCallouts: number | null;
  hourlyStandbyFee: number | null;
  notes: string | null;
}

function parseFreeCallouts(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(400, "Liczba darmowych podjazdów musi być liczbą całkowitą nie mniejszą niż 0");
  }
  return n;
}

/** Wspólna walidacja warunków; `isCreate` wymusza wybór AKTYWNEJ firmy. */
function parseTermBody(body: Record<string, unknown>, isCreate: boolean): TermFields {
  const companyId = Number(body.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new ApiError(400, "Nie wskazano firmy");
  const company = companyRow(companyId);
  if (!company) throw new ApiError(400, "Nie ma takiej firmy");
  if (isCreate && !company.active) {
    throw new ApiError(400, "Firma jest zarchiwizowana — wybierz aktywną firmę");
  }

  const startDate = parseDate(body.startDate, "Data rozpoczęcia", true)!;
  const endDate = parseDate(body.endDate, "Data zakończenia", false);
  if (endDate && endDate < startDate) {
    throw new ApiError(400, "Data zakończenia nie może być wcześniejsza niż data rozpoczęcia");
  }

  return {
    companyId,
    startDate,
    endDate,
    calloutFee: amountField(body.calloutFee, "Kwota podjazdu"),
    subscriptionFee: amountField(body.subscriptionFee, "Abonament miesięczny"),
    freeCallouts: parseFreeCallouts(body.freeCallouts),
    hourlyStandbyFee: amountField(body.hourlyStandbyFee, "Stawka za godzinę postoju"),
    notes: textOrNull(body.notes, "Notatki", 5000),
  };
}

/** 409, gdy okres zachodzi na inne warunki tego samego obiektu. */
function assertNoOverlap(objectId: number, startDate: string, endDate: string | null, excludeId?: number): void {
  const clash = overlappingTerm(objectId, startDate, endDate, excludeId);
  if (!clash) return;
  const company = companyRow(clash.companyId);
  throw new ApiError(
    409,
    `Obiekt ma już warunki obowiązujące w tym okresie (firma ${company?.name ?? "—"}, od ${clash.startDate})`
  );
}

app.get("/terms", (c) => {
  try {
    const q = str(c.req.query("q")).toLowerCase();
    const status = str(c.req.query("status")) || "all";
    if (!["all", "current", "ended"].includes(status)) throw new ApiError(400, "Nieprawidłowy status");
    const conds = [];
    const companyIdRaw = c.req.query("companyId");
    if (companyIdRaw !== undefined && companyIdRaw !== "") {
      const companyId = Number(companyIdRaw);
      if (!Number.isInteger(companyId)) throw new ApiError(400, "Nieprawidłowe companyId");
      conds.push(eq(schema.interventionTerms.companyId, companyId));
    }
    if (status === "current") {
      conds.push(sql`(${schema.interventionTerms.endDate} is null or ${schema.interventionTerms.endDate} >= ${NOW_DATE})`);
    }
    if (status === "ended") {
      conds.push(sql`(${schema.interventionTerms.endDate} is not null and ${schema.interventionTerms.endDate} < ${NOW_DATE})`);
    }
    if (q) {
      conds.push(
        or(
          sql`lower(${schema.objects.name}) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.objects.address}, '')) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.objects.city}, '')) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.contractors.name}, '')) like ${"%" + q + "%"}`,
          sql`lower(${schema.interventionCompanies.name}) like ${"%" + q + "%"}`
        )!
      );
    }
    const rows = termsQuery(conds.length ? and(...conds) : undefined, true);
    return c.json({ success: true, data: { items: serializeTerms(rows) } });
  } catch (error) {
    return handleError(c, error, "pobierania warunków");
  }
});

app.post("/terms", async (c) => {
  try {
    const body = await readJsonBody(c);
    const objectId = Number(body.objectId);
    if (!Number.isInteger(objectId) || objectId <= 0) throw new ApiError(400, "Nie wskazano obiektu");
    const object = db.select().from(schema.objects).where(eq(schema.objects.id, objectId)).get();
    if (!object) throw new ApiError(400, "Nie ma takiego obiektu");

    const data = parseTermBody(body, true);
    assertNoOverlap(objectId, data.startDate, data.endDate);

    const created = db
      .insert(schema.interventionTerms)
      .values({ objectId, ...data })
      .returning()
      .get();
    const company = companyRow(data.companyId);
    logActivity(db, {
      entityType: ENTITY_TERM,
      entityId: created.id,
      objectId,
      user: getUser(c),
      action: "created",
      summary: `Dodano warunki grupy interwencyjnej (firma ${company?.name ?? "—"}, od ${created.startDate})`,
    });
    return c.json({ success: true, data: loadTerm(created.id) }, 201);
  } catch (error) {
    return handleError(c, error, "dodawania warunków");
  }
});

app.put("/terms/:id", async (c) => {
  try {
    const id = idParam(c, "id");
    const before = termRow(id);
    if (!before) throw new ApiError(404, "Warunki nie istnieją");
    const body = await readJsonBody(c);
    // `objectId` jest celowo ignorowane: przeniesienie warunków na inny obiekt
    // osierociłoby zapisane interwencje. Zamiast tego zamyka się okres i zakłada nowy.
    const data = parseTermBody(body, false);
    assertNoOverlap(before.objectId, data.startDate, data.endDate, id);

    // Zmiana dat nie może odciąć już zarejestrowanych podjazdów tego wiersza —
    // inaczej interwencja zostałaby przy warunkach, które w jej dniu nie obowiązują.
    const outside = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interventions)
      .where(
        and(
          eq(schema.interventions.termId, id),
          sql`(substr(${schema.interventions.happenedAt}, 1, 10) < ${data.startDate}
            or substr(${schema.interventions.happenedAt}, 1, 10) > ${data.endDate ?? "9999-12-31"})`
        )
      )
      .get();
    const n = outside?.n ?? 0;
    if (n > 0) {
      throw new ApiError(409, `Nowy okres nie obejmuje zarejestrowanych interwencji (${n}) — popraw daty`);
    }

    const after = db
      .update(schema.interventionTerms)
      .set({ ...data, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.interventionTerms.id, id))
      .returning()
      .get();

    // Denormalizacja firmy w rejestrze podjazdów musi iść za zmianą warunków.
    if (after.companyId !== before.companyId) {
      db.update(schema.interventions)
        .set({ companyId: after.companyId, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.interventions.termId, id))
        .run();
    }

    logFieldDiffs(db, {
      entityType: ENTITY_TERM,
      entityId: id,
      objectId: before.objectId,
      user: getUser(c),
      before,
      after,
      fields: [
        { key: "companyId", label: "firmę", format: (v) => companyRow(Number(v))?.name ?? String(v ?? "—") },
        { key: "startDate", label: "datę rozpoczęcia" },
        { key: "endDate", label: "datę zakończenia" },
        { key: "calloutFee", label: "kwotę podjazdu" },
        { key: "subscriptionFee", label: "abonament miesięczny" },
        { key: "freeCallouts", label: "liczbę darmowych podjazdów" },
        { key: "hourlyStandbyFee", label: "stawkę za godzinę postoju" },
        { key: "notes", label: "notatki" },
      ],
    });
    return c.json({ success: true, data: loadTerm(id) });
  } catch (error) {
    return handleError(c, error, "zapisu warunków");
  }
});

app.delete("/terms/:id", (c) => {
  try {
    const id = idParam(c, "id");
    const row = termRow(id);
    if (!row) throw new ApiError(404, "Warunki nie istnieją");
    const used = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interventions)
      .where(eq(schema.interventions.termId, id))
      .get();
    const n = used?.n ?? 0;
    if (n > 0) throw new ApiError(409, `Warunki mają zarejestrowane interwencje (${n})`);
    db.delete(schema.interventionTerms).where(eq(schema.interventionTerms.id, id)).run();
    removeAttachmentDir(scopeOf("terms", id));
    logActivity(db, {
      entityType: ENTITY_TERM,
      entityId: id,
      objectId: row.objectId,
      user: getUser(c),
      action: "deleted",
      summary: `Usunięto warunki grupy interwencyjnej (od ${row.startDate})`,
    });
    return c.json({ success: true, data: { id } });
  } catch (error) {
    return handleError(c, error, "usuwania warunków");
  }
});

// ---------------------------------------------------------------------------
// Interwencje — zapis
// ---------------------------------------------------------------------------

interface InterventionFields {
  happenedAt: string;
  reason: string | null;
  reportedBy: string | null;
  standbyHours: number | null;
  notes: string | null;
}

function parseInterventionBody(body: Record<string, unknown>): InterventionFields {
  const happenedAt = str(body.happenedAt);
  if (!DATETIME_RE.test(happenedAt)) throw new ApiError(400, "Nieprawidłowa data i godzina");
  return {
    happenedAt,
    reason: textOrNull(body.reason, "Powód", 500),
    reportedBy: textOrNull(body.reportedBy, "Zgłaszający", 200),
    standbyHours: amountField(body.standbyHours, "Godziny postoju"),
    notes: textOrNull(body.notes, "Notatki", 5000),
  };
}

/** Warunki obowiązujące w dniu podjazdu albo 400 z podpowiedzią po polsku. */
function requireTermFor(objectId: number, happenedAt: string): InterventionTerm {
  const term = resolveTermFor(objectId, happenedAt.slice(0, 10));
  if (!term) {
    throw new ApiError(400, "Obiekt nie ma warunków grupy interwencyjnej obowiązujących w tym dniu");
  }
  return term;
}

app.get("/interventions", (c) => {
  try {
    const monthRaw = str(c.req.query("month"));
    // Brak parametru = bieżący miesiąc: rejestr podjazdów rozlicza się miesięcznie,
    // a pełna historia wszystkich obiektów nie jest widokiem, który ktokolwiek chce.
    const month = monthRaw || zonedToday().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError(400, "Nieprawidłowy miesiąc (format RRRR-MM)");

    const conds = [like(schema.interventions.happenedAt, `${month}%`)];
    const objectIdRaw = c.req.query("objectId");
    if (objectIdRaw !== undefined && objectIdRaw !== "") {
      const objectId = Number(objectIdRaw);
      if (!Number.isInteger(objectId)) throw new ApiError(400, "Nieprawidłowe objectId");
      // Filtr po obiekcie jest BEZPIECZNY dla numeracji (grupujemy po obiekcie),
      // w odróżnieniu od filtrów firmy i szukajki — te nakładamy po rozliczeniu.
      conds.push(eq(schema.interventions.objectId, objectId));
    }

    let items = serializeInterventions(interventionsQuery(and(...conds)));

    const companyIdRaw = c.req.query("companyId");
    if (companyIdRaw !== undefined && companyIdRaw !== "") {
      const companyId = Number(companyIdRaw);
      if (!Number.isInteger(companyId)) throw new ApiError(400, "Nieprawidłowe companyId");
      items = items.filter((i) => i.companyId === companyId);
    }
    const q = str(c.req.query("q")).toLowerCase();
    if (q) {
      items = items.filter((i) =>
        [i.objectName, i.objectCity ?? "", i.companyName, i.reason ?? "", i.reportedBy ?? "", i.notes ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }

    return c.json({ success: true, data: { items, summary: summarize(items) } });
  } catch (error) {
    return handleError(c, error, "pobierania interwencji");
  }
});

app.post("/interventions", async (c) => {
  try {
    const body = await readJsonBody(c);
    const objectId = Number(body.objectId);
    if (!Number.isInteger(objectId) || objectId <= 0) throw new ApiError(400, "Nie wskazano obiektu");
    const object = db.select().from(schema.objects).where(eq(schema.objects.id, objectId)).get();
    if (!object) throw new ApiError(400, "Nie ma takiego obiektu");

    const data = parseInterventionBody(body);
    const term = requireTermFor(objectId, data.happenedAt);

    const created = db
      .insert(schema.interventions)
      .values({ objectId, termId: term.id, companyId: term.companyId, ...data })
      .returning()
      .get();
    logActivity(db, {
      entityType: ENTITY_INTERVENTION,
      entityId: created.id,
      objectId,
      user: getUser(c),
      action: "created",
      summary: `Zarejestrowano interwencję (${created.happenedAt.replace("T", ", godz. ")})`,
    });
    return c.json({ success: true, data: loadIntervention(created.id) }, 201);
  } catch (error) {
    return handleError(c, error, "dodawania interwencji");
  }
});

app.put("/interventions/:id", async (c) => {
  try {
    const id = idParam(c, "id");
    const before = interventionRow(id);
    if (!before) throw new ApiError(404, "Interwencja nie istnieje");
    const body = await readJsonBody(c);

    let objectId = before.objectId;
    if (body.objectId !== undefined && body.objectId !== null && body.objectId !== "") {
      const parsed = Number(body.objectId);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new ApiError(400, "Nie wskazano obiektu");
      const object = db.select().from(schema.objects).where(eq(schema.objects.id, parsed)).get();
      if (!object) throw new ApiError(400, "Nie ma takiego obiektu");
      objectId = parsed;
    }

    const data = parseInterventionBody(body);
    // Zmiana daty albo obiektu ponownie rozwiązuje warunki — podjazd ma się
    // rozliczać stawkami obowiązującymi w SWOIM dniu, a nie w dniu wpisu.
    const term = requireTermFor(objectId, data.happenedAt);

    const after = db
      .update(schema.interventions)
      .set({ objectId, termId: term.id, companyId: term.companyId, ...data, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.interventions.id, id))
      .returning()
      .get();

    logFieldDiffs(db, {
      entityType: ENTITY_INTERVENTION,
      entityId: id,
      objectId,
      user: getUser(c),
      before,
      after,
      fields: [
        { key: "happenedAt", label: "datę i godzinę" },
        { key: "objectId", label: "obiekt" },
        { key: "termId", label: "warunki" },
        { key: "reason", label: "powód" },
        { key: "reportedBy", label: "zgłaszającego" },
        { key: "standbyHours", label: "godziny postoju" },
        { key: "notes", label: "notatki" },
      ],
    });
    return c.json({ success: true, data: loadIntervention(id) });
  } catch (error) {
    return handleError(c, error, "zapisu interwencji");
  }
});

app.delete("/interventions/:id", (c) => {
  try {
    const id = idParam(c, "id");
    const row = interventionRow(id);
    if (!row) throw new ApiError(404, "Interwencja nie istnieje");
    db.delete(schema.interventions).where(eq(schema.interventions.id, id)).run();
    removeAttachmentDir(scopeOf("interventions", id));
    logActivity(db, {
      entityType: ENTITY_INTERVENTION,
      entityId: id,
      objectId: row.objectId,
      user: getUser(c),
      action: "deleted",
      summary: `Usunięto interwencję (${row.happenedAt.replace("T", ", godz. ")})`,
    });
    return c.json({ success: true, data: { id } });
  } catch (error) {
    return handleError(c, error, "usuwania interwencji");
  }
});

// ---------------------------------------------------------------------------
// Załączniki — trzy identyczne komplety tras nad trzema tabelami
// ---------------------------------------------------------------------------

/**
 * Rejestruje `POST /:id/attachments`, `GET /:id/attachments/:attId/download`
 * i `DELETE /:id/attachments/:attId` dla jednego właściciela. Wszystko, co
 * zależy od tabeli (odczyt, wstawienie, skasowanie), przychodzi w domknięciach —
 * dzięki temu typy drizzle zostają przy swoich tabelach, a trasy są napisane raz.
 */
interface AttachmentRoutesConfig {
  group: OwnerGroup;
  /** Dopełniacz do komunikatu o limicie („…na firmę”). */
  limitLabel: string;
  /** Komunikat 404 dla nieistniejącego właściciela. */
  notFound: string;
  /** Nazwa pola właściciela w odpowiedzi DELETE. */
  ownerKey: "companyId" | "termId" | "interventionId";
  ownerExists: (id: number) => boolean;
  countAttachments: (ownerId: number) => number;
  insert: (ownerId: number, stored: StoredAttachment[]) => void;
  find: (attId: number) => (AttachmentRow & { ownerId: number; storedPath: string }) | undefined;
  remove: (attId: number) => void;
  /** Odświeżenie znacznika czasu właściciela po zmianie zestawu plików. */
  touch: (ownerId: number) => void;
  reload: (ownerId: number) => unknown;
}

function registerAttachmentRoutes(cfg: AttachmentRoutesConfig): void {
  const base = `/${cfg.group}`;

  app.post(`${base}/:id/attachments`, async (c) => {
    try {
      const id = idParam(c, "id");
      const { files } = await readFiles(c);
      if (!cfg.ownerExists(id)) throw new ApiError(404, cfg.notFound);
      if (files.length === 0) throw new ApiError(400, "Nie wybrano plików");
      const already = cfg.countAttachments(id);
      if (already + files.length > ATTACHMENT_MAX_FILES) {
        throw new ApiError(
          400,
          `Maksymalnie ${ATTACHMENT_MAX_FILES} plików na ${cfg.limitLabel} (jest już ${already})`
        );
      }
      const stored = await storeUploads(scopeOf(cfg.group, id), files);
      try {
        db.transaction(() => {
          cfg.insert(id, stored);
          cfg.touch(id);
        });
      } catch (error) {
        // Wiersze nie doszły — pliki na dysku byłyby sierotami.
        removeStoredFiles(stored);
        throw error;
      }
      return c.json({ success: true, data: cfg.reload(id) });
    } catch (error) {
      return handleError(c, error, "dodawania załączników");
    }
  });

  app.get(`${base}/:id/attachments/:attId/download`, (c) => {
    try {
      const id = idParam(c, "id");
      const attId = idParam(c, "attId");
      const att = cfg.find(attId);
      // Cudzy załącznik to dla tej trasy brak załącznika — inaczej id z innej
      // encji byłoby czytelne pod adresem, do którego ktoś ma dostęp.
      if (!att || att.ownerId !== id) throw new ApiError(404, "Załącznik nie istnieje");
      const abs = attachmentFilePath(att.storedPath);
      if (!abs) throw new ApiError(404, "Plik załącznika nie istnieje na dysku");
      const inline = c.req.query("inline") === "1";
      const size = statSync(abs).size;
      const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": att.mime,
          "Content-Length": String(size),
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", att.fileName),
        },
      });
    } catch (error) {
      return handleError(c, error, "pobierania załącznika");
    }
  });

  app.delete(`${base}/:id/attachments/:attId`, (c) => {
    try {
      const id = idParam(c, "id");
      const attId = idParam(c, "attId");
      const att = cfg.find(attId);
      if (!att || att.ownerId !== id) throw new ApiError(404, "Załącznik nie istnieje");
      db.transaction(() => {
        cfg.remove(attId);
        cfg.touch(id);
      });
      // Plik znika dopiero po commicie — nieudana transakcja nie zostawia wiersza bez pliku.
      removeStoredFiles([att]);
      return c.json({ success: true, data: { id: attId, [cfg.ownerKey]: id } });
    } catch (error) {
      return handleError(c, error, "usuwania załącznika");
    }
  });
}

registerAttachmentRoutes({
  group: "companies",
  limitLabel: "firmę",
  notFound: "Firma nie istnieje",
  ownerKey: "companyId",
  ownerExists: (id) => !!companyRow(id),
  countAttachments: (ownerId) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interventionCompanyAttachments)
      .where(eq(schema.interventionCompanyAttachments.companyId, ownerId))
      .get()?.n ?? 0,
  insert: (ownerId, stored) => {
    for (const s of stored) {
      db.insert(schema.interventionCompanyAttachments).values({ companyId: ownerId, ...s }).run();
    }
  },
  find: (attId) => {
    const r = db
      .select()
      .from(schema.interventionCompanyAttachments)
      .where(eq(schema.interventionCompanyAttachments.id, attId))
      .get();
    return r ? { ...r, ownerId: r.companyId } : undefined;
  },
  remove: (attId) => {
    db.delete(schema.interventionCompanyAttachments)
      .where(eq(schema.interventionCompanyAttachments.id, attId))
      .run();
  },
  touch: (ownerId) => {
    db.update(schema.interventionCompanies)
      .set({ updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.interventionCompanies.id, ownerId))
      .run();
  },
  reload: (ownerId) => loadCompany(ownerId),
});

registerAttachmentRoutes({
  group: "terms",
  limitLabel: "warunki",
  notFound: "Warunki nie istnieją",
  ownerKey: "termId",
  ownerExists: (id) => !!termRow(id),
  countAttachments: (ownerId) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interventionTermAttachments)
      .where(eq(schema.interventionTermAttachments.termId, ownerId))
      .get()?.n ?? 0,
  insert: (ownerId, stored) => {
    for (const s of stored) {
      db.insert(schema.interventionTermAttachments).values({ termId: ownerId, ...s }).run();
    }
  },
  find: (attId) => {
    const r = db
      .select()
      .from(schema.interventionTermAttachments)
      .where(eq(schema.interventionTermAttachments.id, attId))
      .get();
    return r ? { ...r, ownerId: r.termId } : undefined;
  },
  remove: (attId) => {
    db.delete(schema.interventionTermAttachments)
      .where(eq(schema.interventionTermAttachments.id, attId))
      .run();
  },
  touch: (ownerId) => {
    db.update(schema.interventionTerms)
      .set({ updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.interventionTerms.id, ownerId))
      .run();
  },
  reload: (ownerId) => loadTerm(ownerId),
});

registerAttachmentRoutes({
  group: "interventions",
  limitLabel: "interwencję",
  notFound: "Interwencja nie istnieje",
  ownerKey: "interventionId",
  ownerExists: (id) => !!interventionRow(id),
  countAttachments: (ownerId) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interventionAttachments)
      .where(eq(schema.interventionAttachments.interventionId, ownerId))
      .get()?.n ?? 0,
  insert: (ownerId, stored) => {
    for (const s of stored) {
      db.insert(schema.interventionAttachments).values({ interventionId: ownerId, ...s }).run();
    }
  },
  find: (attId) => {
    const r = db
      .select()
      .from(schema.interventionAttachments)
      .where(eq(schema.interventionAttachments.id, attId))
      .get();
    return r ? { ...r, ownerId: r.interventionId } : undefined;
  },
  remove: (attId) => {
    db.delete(schema.interventionAttachments).where(eq(schema.interventionAttachments.id, attId)).run();
  },
  touch: (ownerId) => {
    db.update(schema.interventions)
      .set({ updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.interventions.id, ownerId))
      .run();
  },
  reload: (ownerId) => loadIntervention(ownerId),
});

export default app;
