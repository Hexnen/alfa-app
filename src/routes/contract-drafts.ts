/**
 * Drafty umów (/api/contracts/drafts) — panel „Drafty umów” w zakładce Umowy.
 *
 * Rejestr `contracts` opisuje UMOWĘ JAKO FAKT handlowy (numer, kwota, okres);
 * ten moduł robi coś innego — składa DOKUMENT z oryginalnego wzoru Worda,
 * wstępnie wypełniony z kartoteki (obiekt → kontrahent → spółka → kontakty),
 * nadaje mu numer z licznika spółki i pilnuje plików: wygenerowanego DOCX-a
 * i załączników (skan podpisanej umowy).
 *
 * KOLEJNOŚĆ REJESTRACJI TRAS MA ZNACZENIE (Hono dopasowuje po kolei):
 * `/pick/objects`, `/templates`, `/prefill` i `/objects/:objectId` muszą stać
 * PRZED trasami z gołym `/:id`. Sam router jest montowany przed `/contracts`
 * (src/routes/index.ts) — inaczej `/contracts/drafts` wpadłoby w `/contracts/:id`.
 *
 * UPRAWNIENIA: reużywamy klucz zakładki `contracts` (API_TAB_MAP ma prefiks
 * `/contracts`, który obejmuje i rejestr, i drafty) — bez nowego klucza.
 *
 * ZAPIS PLIKU JEST POZA TRANSAKCJĄ. Wiersz powstaje w transakcji (numer
 * z licznika + UNIQUE), render i zapis DOCX-a idą PO commicie, a błąd renderu
 * kasuje wiersz kompensacyjnie. Trzymanie IO w transakcji blokowałoby bazę
 * na czas pracy z plikiem, a rollback i tak nie cofnąłby zapisu na dysk.
 */
import { Hono, type Context } from "hono";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type {
  CalendarAttachmentKind,
  Company,
  ContractDraft,
  ContractDraftAttachment,
  ContractDraftStatus,
} from "../db/schema.js";
import { CONTRACT_DRAFT_STATUSES, CONTRACT_DRAFT_STATUS_LABELS } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { logActivity, logFieldDiffs } from "../lib/activity-log.js";
import { ApiError } from "../lib/calendar-labels.js";
import {
  attachmentFilePath,
  contentDisposition,
  removeStoredFiles,
  storeUploads,
  ATTACHMENT_MAX_FILES,
  type IncomingFile,
} from "../lib/calendar-attachments.js";
import {
  CONTRACT_TEMPLATES,
  getTemplate,
  templateJson,
  type ContractTemplateDef,
  type ContractTemplateJson,
} from "../lib/contract-templates/registry.js";
import {
  BLANK_PLACEHOLDER,
  contractFieldsHash,
  countMissingContractFields,
  highlightTaggedTemplateDocx,
  renderContractDocx,
  templateFilePath,
} from "../lib/contract-templates/render.js";
import {
  DOCX_MIME,
  draftScope,
  generatedFileName,
  generatedFilePath,
  removeDraftDir,
  writeGeneratedDocx,
} from "../lib/contract-templates/store.js";
import { nextContractNumberSync } from "../lib/contract-numbering.js";
// Rejestr umów: te same reguły numeru i adresu podglądu, co w /api/contracts.
import { draftFileUrlOf, numberTaken } from "./contracts.js";
import { kwotaSlownie } from "../lib/kwota-slownie.js";
import { zonedToday } from "../lib/tz.js";

const app = new Hono();

/** Encja w activity_log. */
const ENTITY = "contract_draft";

/** Prefiks URL tras plikowych (router montowany pod /api/contracts/drafts). */
const API_PREFIX = "/api/contracts/drafts";

// ---------------------------------------------------------------------------
// Kształt JSON (kontrakt z frontem — frontend/src/lib/api.ts, contractDraftsApi)
// ---------------------------------------------------------------------------

export interface ContractDraftAttachmentJson {
  id: number;
  fileName: string;
  mimeType: string;
  size: number;
  kind: CalendarAttachmentKind;
  url: string;
  downloadUrl: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface ContractDraftJson {
  id: number;
  objectId: number;
  objectName: string;
  objectAddress: string | null;
  objectCity: string | null;
  contractorId: number | null;
  contractorName: string | null;
  companyId: number;
  companyName: string;
  templateKey: string;
  templateLabel: string;
  contractNumber: string;
  seq: number;
  year: number;
  contractDate: string;
  status: ContractDraftStatus;
  statusLabel: string;
  fields: Record<string, string>;
  notes: string | null;
  generatedFileName: string | null;
  generatedAt: string | null;
  fileUrl: string | null;
  /** Pola zmieniono po ostatniej generacji — plik na dysku jest nieaktualny. */
  stale: boolean;
  /**
   * Id wiersza w rejestrze umów, jeśli draft już tam trafił („Przenieś do
   * rejestru”); `null` = jeszcze nie. Front nie proponuje wtedy przeniesienia
   * po raz drugi i ostrzega przed skasowaniem dokumentu.
   */
  registryContractId: number | null;
  attachments: ContractDraftAttachmentJson[];
  createdBy: number | null;
  createdByLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDraftPickObject {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  contractorName: string | null;
  companyId: number | null;
  companyName: string | null;
}

// ---------------------------------------------------------------------------
// Pomocnicze (wzorzec src/routes/intervention-groups.ts)
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`Błąd ${what}:`, error);
  return c.json({ success: false, error: `Błąd ${what}` }, 500);
}

function idParam(c: Context, name: string): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Nieprawidłowe id");
  return id;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(raw: unknown, label: string): string | null {
  const s = str(raw);
  if (!s) return null;
  if (!DATE_RE.test(s)) throw new ApiError(400, `Nieprawidłowa ${label.toLowerCase()} (format RRRR-MM-DD)`);
  return s;
}

function textOrNull(v: unknown, label: string, maxLen = 5000): string | null {
  const s = str(v);
  if (!s) return null;
  if (s.length > maxLen) throw new ApiError(400, `${label}: maks. ${maxLen} znaków`);
  return s;
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Nieprawidłowe dane");
  return body;
}

/** Pliki z multipartu (pole `files`) — kopia z src/routes/intervention-groups.ts. */
async function readFiles(c: Context): Promise<IncomingFile[]> {
  const ct = c.req.header("content-type") ?? "";
  if (!/multipart\/form-data/i.test(ct)) throw new ApiError(400, "Wymagany formularz multipart/form-data");
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new ApiError(400, "Nieprawidłowe dane formularza");
  const files: IncomingFile[] = [];
  for (const entry of form.getAll("files")) {
    if (!(entry instanceof File)) continue;
    files.push({ name: entry.name, mime: entry.type, data: Buffer.from(await entry.arrayBuffer()) });
  }
  return files;
}

function parseStatus(raw: unknown): ContractDraftStatus {
  const s = str(raw);
  if (!(CONTRACT_DRAFT_STATUSES as readonly string[]).includes(s)) {
    throw new ApiError(400, "Nieprawidłowy status umowy");
  }
  return s as ContractDraftStatus;
}

// ---------------------------------------------------------------------------
// Pola formularza
// ---------------------------------------------------------------------------

const FIELD_MAX_LEN = 2000;

/**
 * Sprawdza klucze i normalizuje wartości do napisów. NIEZNANY KLUCZ TO BŁĄD,
 * a nie cicho ignorowane pole: front i szablon muszą mówić tym samym słownikiem,
 * inaczej literówka w kluczu znikałaby bez śladu, a dokument wychodziłby z pustym
 * miejscem tam, gdzie ktoś był pewien, że coś wpisał.
 */
function parseFields(def: ContractTemplateDef, raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "Pola umowy muszą być obiektem");
  const known = new Set(def.fields.map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) throw new ApiError(400, `Nieznane pole formularza: ${key}`);
    const s = value === null || value === undefined ? "" : String(value);
    if (s.length > FIELD_MAX_LEN) throw new ApiError(400, `Pole ${key}: maks. ${FIELD_MAX_LEN} znaków`);
    out[key] = s.trim();
  }
  return out;
}

/**
 * Dolicza puste pola „słownie” z pola źródłowego. Robi to SERWER, a nie tylko
 * front: kwota i jej zapis słowny w umowie muszą się zgadzać, a przy zapisie
 * z API (albo przy wyłączonym JS) nikt by tego nie policzył.
 */
function fillDerived(def: ContractTemplateDef, fields: Record<string, string>): void {
  for (const field of def.fields) {
    if (!field.derivedFrom) continue;
    if (str(fields[field.key])) continue;
    const source = str(fields[field.derivedFrom]);
    if (!source) continue;
    const n = Number(source.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) continue;
    fields[field.key] = kwotaSlownie(n);
  }
}

/** Pełny komplet pól szablonu: brakujące klucze jako puste napisy. */
function completeFields(def: ContractTemplateDef, fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of def.fields) out[field.key] = fields[field.key] ?? "";
  return out;
}

// ---------------------------------------------------------------------------
// Odczyt
// ---------------------------------------------------------------------------

function attachmentJson(draftId: number, r: ContractDraftAttachment): ContractDraftAttachmentJson {
  const base = `${API_PREFIX}/${draftId}/attachments/${r.id}/download`;
  return {
    id: r.id,
    fileName: r.fileName,
    mimeType: r.mime,
    size: r.size,
    kind: r.kind,
    url: `${base}?inline=1`,
    downloadUrl: base,
    width: r.width,
    height: r.height,
    createdAt: r.createdAt,
  };
}

function attachmentsByDraft(ids: number[]): Map<number, ContractDraftAttachmentJson[]> {
  const out = new Map<number, ContractDraftAttachmentJson[]>();
  if (ids.length === 0) return out;
  const rows = db
    .select()
    .from(schema.contractDraftAttachments)
    .where(inArray(schema.contractDraftAttachments.draftId, ids))
    .orderBy(asc(schema.contractDraftAttachments.id))
    .all();
  for (const r of rows) {
    const list = out.get(r.draftId) ?? [];
    list.push(attachmentJson(r.draftId, r));
    out.set(r.draftId, list);
  }
  return out;
}

/**
 * Które drafty mają już swój wiersz w rejestrze umów („Przenieś do rejestru”).
 *
 * Front potrzebuje tego do dwóch rzeczy: żeby nie proponować przenoszenia po
 * raz drugi i żeby przed skasowaniem draftu uprzedzić, że umowa w rejestrze
 * straci dokument.
 */
function registryContractsByDraft(ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const rows = db
    .select({ id: schema.contracts.id, draftId: schema.contracts.draftId })
    .from(schema.contracts)
    .where(inArray(schema.contracts.draftId, ids))
    .all();
  for (const r of rows) if (r.draftId !== null) out.set(r.draftId, r.id);
  return out;
}

type DraftQueryRow = {
  draft: ContractDraft;
  objectName: string;
  objectAddress: string | null;
  objectCity: string | null;
  contractorName: string | null;
  companyName: string;
  createdByName: string | null;
  createdByEmail: string | null;
};

type SortKey = "number" | "date" | "object" | "contractor" | "status" | "created";

function draftsQuery(where: ReturnType<typeof and> | undefined, sort: SortKey, dir: "asc" | "desc"): DraftQueryRow[] {
  const q = db
    .select({
      draft: schema.contractDrafts,
      objectName: schema.objects.name,
      objectAddress: schema.objects.address,
      objectCity: schema.objects.city,
      contractorName: schema.contractors.name,
      companyName: schema.companies.name,
      createdByName: schema.users.displayName,
      createdByEmail: schema.users.email,
    })
    .from(schema.contractDrafts)
    .innerJoin(schema.objects, eq(schema.contractDrafts.objectId, schema.objects.id))
    .innerJoin(schema.companies, eq(schema.contractDrafts.companyId, schema.companies.id))
    .leftJoin(schema.contractors, eq(schema.contractDrafts.contractorId, schema.contractors.id))
    .leftJoin(schema.users, eq(schema.contractDrafts.createdBy, schema.users.id))
    .where(where);

  const d = dir === "asc" ? asc : desc;
  // Numer sortujemy po (rok, seq), a nie po napisie — „10/ZDW/2026” ma stać
  // za „9/ZDW/2026”, a leksykograficznie stanęłoby przed.
  const order =
    sort === "number"
      ? [d(schema.contractDrafts.year), d(schema.contractDrafts.seq)]
      : sort === "object"
        ? [d(sql`lower(${schema.objects.name})`), desc(schema.contractDrafts.id)]
        : sort === "contractor"
          ? [d(sql`lower(coalesce(${schema.contractors.name}, ''))`), desc(schema.contractDrafts.id)]
          : sort === "status"
            ? [d(schema.contractDrafts.status), desc(schema.contractDrafts.id)]
            : sort === "created"
              ? [d(schema.contractDrafts.createdAt), desc(schema.contractDrafts.id)]
              : [d(schema.contractDrafts.contractDate), desc(schema.contractDrafts.id)];
  return q.orderBy(...order).all();
}

function parseFieldsJson(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = v === null ? "" : String(v);
    return out;
  } catch {
    // Uszkodzony JSON w kolumnie nie ma prawa wywalić całej listy.
    return {};
  }
}

function serializeDrafts(rows: DraftQueryRow[]): ContractDraftJson[] {
  const ids = rows.map((r) => r.draft.id);
  const atts = attachmentsByDraft(ids);
  const registry = registryContractsByDraft(ids);
  return rows.map((r) => {
    const d = r.draft;
    const fields = parseFieldsJson(d.fields);
    const template = getTemplate(d.templateKey);
    return {
      id: d.id,
      objectId: d.objectId,
      objectName: r.objectName,
      objectAddress: r.objectAddress,
      objectCity: r.objectCity,
      contractorId: d.contractorId,
      contractorName: r.contractorName,
      companyId: d.companyId,
      companyName: r.companyName,
      templateKey: d.templateKey,
      // Szablon skasowany z rejestru nie może ukryć istniejącego dokumentu —
      // wtedy w etykiecie zostaje sam klucz.
      templateLabel: template?.label ?? d.templateKey,
      contractNumber: d.contractNumber,
      seq: d.seq,
      year: d.year,
      contractDate: d.contractDate,
      status: d.status,
      statusLabel: CONTRACT_DRAFT_STATUS_LABELS[d.status],
      fields,
      notes: d.notes,
      generatedFileName: d.generatedFileName,
      generatedAt: d.generatedAt,
      fileUrl: d.generatedStoredPath ? `${API_PREFIX}/${d.id}/file` : null,
      stale: d.generatedStoredPath !== null && d.generatedHash !== contractFieldsHash(fields),
      registryContractId: registry.get(d.id) ?? null,
      attachments: atts.get(d.id) ?? [],
      createdBy: d.createdBy,
      createdByLabel: (r.createdByName || "").trim() || r.createdByEmail || null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });
}

function loadDraft(id: number): ContractDraftJson | null {
  const rows = draftsQuery(and(eq(schema.contractDrafts.id, id)), "date", "desc");
  return rows.length ? serializeDrafts(rows)[0] : null;
}

function draftRow(id: number): ContractDraft | undefined {
  return db.select().from(schema.contractDrafts).where(eq(schema.contractDrafts.id, id)).get();
}

// ---------------------------------------------------------------------------
// Picker obiektów i szablony — PRZED trasami z /:id
// ---------------------------------------------------------------------------

const PICK_LIMIT = 30;

/**
 * Picker jest TUTAJ, a nie w /objects, bo uprawnienia są per-zakładka: ktoś
 * z samym kluczem `contracts` dostałby 403 na kartotece obiektów i nie mógłby
 * założyć draftu. Zwraca nazwę, adres, kontrahenta i spółkę — bez kwot i statusów.
 */
app.get("/pick/objects", (c) => {
  const q = str(c.req.query("q")).toLowerCase();
  const rows = db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      contractorName: schema.contractors.name,
      companyId: schema.objects.companyId,
      companyName: schema.companies.name,
    })
    .from(schema.objects)
    .leftJoin(schema.contractors, eq(schema.objects.contractorId, schema.contractors.id))
    .leftJoin(schema.companies, eq(schema.objects.companyId, schema.companies.id))
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
  return c.json({ success: true, data: { items: rows satisfies ContractDraftPickObject[] } });
});

/** Kontekst obiektu do sprawdzenia, czy szablon pasuje do jego spółki. */
function objectContext(objectId: number): { companyId: number | null; companyName: string | null } {
  const row = db
    .select({ companyId: schema.objects.companyId, companyName: schema.companies.name })
    .from(schema.objects)
    .leftJoin(schema.companies, eq(schema.objects.companyId, schema.companies.id))
    .where(eq(schema.objects.id, objectId))
    .get();
  if (!row) throw new ApiError(404, "Obiekt nie istnieje");
  return { companyId: row.companyId, companyName: row.companyName };
}

app.get("/templates", (c) => {
  try {
    const objectIdRaw = c.req.query("objectId");
    let ctx: { companyId: number | null; companyName: string | null } | null = null;
    if (objectIdRaw !== undefined && objectIdRaw !== "") {
      const objectId = Number(objectIdRaw);
      if (!Number.isInteger(objectId) || objectId <= 0) throw new ApiError(400, "Nieprawidłowe objectId");
      ctx = objectContext(objectId);
    }
    const items: ContractTemplateJson[] = CONTRACT_TEMPLATES.map((t) => templateJson(t, ctx));
    return c.json({ success: true, data: { items } });
  } catch (error) {
    return handleError(c, error, "pobierania szablonów umów");
  }
});

/**
 * Pusty wzór do podglądu i wydruku (Umowy → „Wzory umów”).
 *
 * `blank` (domyślny) przepuszcza szablon przez ten sam render co prawdziwą
 * umowę, tylko BEZ wartości — każdy tag wychodzi kropkami. Dzięki temu
 * handlowiec dostaje dokładnie ten dokument, który wyjdzie z generatora, a nie
 * osobny plik żyjący własnym życiem, i widzi z góry, czego zażąda formularz.
 *
 * `tagged` to surowy plik z `{tagami}` — dla administratora, do porównania
 * z oryginałem po podmianie wzoru; dla klienta nie ma z tego treści.
 *
 * `preview=1` dokłada kolorowanie pól (we wzorze — z definicji nic nie jest
 * wypełnione, więc WSZYSTKIE na żółto). Wariant liczony w pamięci, wyłącznie
 * dla podglądu w aplikacji; „Pobierz” idzie bez tego parametru i daje plik
 * czysty, taki jak dotąd.
 *
 * Trasa MUSI stać przed `/:id` (Hono dopasowuje po kolei).
 */
app.get("/templates/:key/file", (c) => {
  try {
    const def = getTemplate(c.req.param("key"));
    if (!def) throw new ApiError(404, "Nieznany szablon umowy");

    const mode = str(c.req.query("mode")) || "blank";
    if (mode !== "blank" && mode !== "tagged") {
      throw new ApiError(400, "Nieprawidłowy tryb pobrania wzoru (dozwolone: blank, tagged)");
    }
    const preview = c.req.query("preview") === "1";

    const path = templateFilePath(def);
    if (!existsSync(path)) {
      throw new ApiError(500, `Brak pliku szablonu umowy (${def.file}) — skontaktuj się z administratorem.`);
    }

    let body: Buffer;
    if (mode === "tagged") {
      body = preview ? highlightTaggedTemplateDocx(def) : readFileSync(path);
    } else {
      body = renderContractDocx(def, {}, { emptyFallback: BLANK_PLACEHOLDER, highlight: preview });
    }
    const fileName = mode === "tagged" ? `Wzór z tagami - ${def.fileLabel}.docx` : `Wzór - ${def.fileLabel}.docx`;

    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": DOCX_MIME,
        "Content-Length": String(body.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDisposition(preview ? "inline" : "attachment", fileName),
        ...(preview ? { "X-Contract-Missing": String(def.fields.length) } : {}),
      },
    });
  } catch (error) {
    return handleError(c, error, "pobierania wzoru umowy");
  }
});

app.get("/prefill", (c) => {
  try {
    const objectId = Number(c.req.query("objectId"));
    if (!Number.isInteger(objectId) || objectId <= 0) throw new ApiError(400, "Nie wskazano obiektu");
    const key = str(c.req.query("template"));
    const def = getTemplate(key);
    if (!def) throw new ApiError(400, "Nieznany szablon umowy");

    const ctx = objectContext(objectId);
    const result = def.prefill(objectId);
    const fields = completeFields(def, result.fields);

    // Podgląd numeru: to, co dostanie draft, jeżeli nikt nie zapisze wcześniej.
    // Ostateczny numer nadaje POST w transakcji — tu tylko pokazujemy człowiekowi,
    // czego się spodziewać.
    let numberPreview = "";
    if (result.companyId !== null) {
      const company = db.select().from(schema.companies).where(eq(schema.companies.id, result.companyId)).get();
      if (company?.contractCode) {
        const contractDate = fields.data_umowy || zonedToday();
        numberPreview = nextContractNumberSync(
          db,
          company.id,
          company.contractCode,
          Number(contractDate.slice(0, 4))
        ).contractNumber;
      }
    }
    fields.numer = numberPreview;

    return c.json({
      success: true,
      data: {
        template: templateJson(def, ctx),
        fields,
        sources: result.sources,
        warnings: result.warnings,
        numberPreview,
        companyId: result.companyId,
        companyName: result.companyName,
        contractorId: result.contractorId,
        contractorName: result.contractorName,
        objectName: result.objectName,
        contractDate: fields.data_umowy || zonedToday(),
      },
    });
  } catch (error) {
    return handleError(c, error, "przygotowania formularza umowy");
  }
});

app.get("/objects/:objectId", (c) => {
  try {
    const objectId = idParam(c, "objectId");
    const rows = draftsQuery(and(eq(schema.contractDrafts.objectId, objectId)), "date", "desc");
    return c.json({ success: true, data: { items: serializeDrafts(rows) } });
  } catch (error) {
    return handleError(c, error, "pobierania draftów umów obiektu");
  }
});

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

const SORT_KEYS: SortKey[] = ["number", "date", "object", "contractor", "status", "created"];

app.get("/", (c) => {
  try {
    const conds = [];
    const num = (name: string) => {
      const raw = c.req.query(name);
      if (raw === undefined || raw === "") return null;
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new ApiError(400, `Nieprawidłowe ${name}`);
      return n;
    };
    const objectId = num("objectId");
    if (objectId !== null) conds.push(eq(schema.contractDrafts.objectId, objectId));
    const companyId = num("companyId");
    if (companyId !== null) conds.push(eq(schema.contractDrafts.companyId, companyId));
    const status = str(c.req.query("status"));
    if (status) conds.push(eq(schema.contractDrafts.status, parseStatus(status)));
    const templateKey = str(c.req.query("templateKey"));
    if (templateKey) conds.push(eq(schema.contractDrafts.templateKey, templateKey));
    const q = str(c.req.query("q")).toLowerCase();
    if (q) {
      conds.push(
        or(
          sql`lower(${schema.contractDrafts.contractNumber}) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.contractDrafts.notes}, '')) like ${"%" + q + "%"}`,
          sql`lower(${schema.objects.name}) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.objects.address}, '')) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.objects.city}, '')) like ${"%" + q + "%"}`,
          sql`lower(coalesce(${schema.contractors.name}, '')) like ${"%" + q + "%"}`
        )!
      );
    }

    const sortRaw = str(c.req.query("sort")) || "date";
    if (!SORT_KEYS.includes(sortRaw as SortKey)) throw new ApiError(400, "Nieprawidłowe sortowanie");
    const dirRaw = str(c.req.query("dir")) || "desc";
    if (dirRaw !== "asc" && dirRaw !== "desc") throw new ApiError(400, "Nieprawidłowy kierunek sortowania");

    const rows = draftsQuery(conds.length ? and(...conds) : undefined, sortRaw as SortKey, dirRaw);
    return c.json({ success: true, data: { items: serializeDrafts(rows) } });
  } catch (error) {
    return handleError(c, error, "pobierania draftów umów");
  }
});

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------

/** Spółka obiektu wraz z kodem numeracji albo 400 z podpowiedzią po polsku. */
function requireNumberingCompany(companyId: number | null): Company & { contractCode: string } {
  if (companyId === null) {
    throw new ApiError(400, "Obiekt nie ma przypisanej spółki — uzupełnij ją w kartotece obiektu.");
  }
  const company = db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
  if (!company) throw new ApiError(400, "Spółka obiektu nie istnieje w słowniku");
  if (!company.contractCode) {
    throw new ApiError(400, `Spółka ${company.name} nie ma kodu do numeracji umów — uzupełnij kod do numeracji umów w Spółki → Dane do umów.`);
  }
  return company as Company & { contractCode: string };
}

/**
 * Generuje DOCX i zapisuje go na dysku, po czym uzupełnia kolumny `generated_*`.
 * Wołane PO commicie wiersza — patrz nagłówek pliku.
 */
function generateFile(draft: ContractDraft, def: ContractTemplateDef, userId: number): void {
  const fields = parseFieldsJson(draft.fields);
  const buffer = renderContractDocx(def, fields);
  const storedPath = writeGeneratedDocx(draft.id, buffer, draft.generatedStoredPath);
  db.update(schema.contractDrafts)
    .set({
      generatedFileName: generatedFileName(def.fileLabel, draft.contractNumber),
      generatedStoredPath: storedPath,
      generatedAt: sql`(datetime('now'))`,
      generatedHash: contractFieldsHash(fields),
      generatedBy: userId,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(schema.contractDrafts.id, draft.id))
    .run();
}

app.post("/", async (c) => {
  try {
    const body = await readJsonBody(c);
    const user = getUser(c);

    const objectId = Number(body.objectId);
    if (!Number.isInteger(objectId) || objectId <= 0) throw new ApiError(400, "Nie wskazano obiektu");
    const object = db.select().from(schema.objects).where(eq(schema.objects.id, objectId)).get();
    if (!object) throw new ApiError(400, "Nie ma takiego obiektu");

    const def = getTemplate(str(body.templateKey));
    if (!def) throw new ApiError(400, "Nieznany szablon umowy");

    const company = requireNumberingCompany(object.companyId);

    const fields = completeFields(def, parseFields(def, body.fields));
    const contractDate = parseDate(body.contractDate, "Data zawarcia") ?? parseDate(fields.data_umowy, "Data zawarcia") ?? zonedToday();
    fields.data_umowy = contractDate;
    fillDerived(def, fields);

    const status = body.status === undefined ? ("draft" as const) : parseStatus(body.status);
    const notes = textOrNull(body.notes, "Notatki");
    const year = Number(contractDate.slice(0, 4));

    const created = db.transaction((tx) => {
      const { seq, contractNumber } = nextContractNumberSync(tx, company.id, company.contractCode, year);
      // Numer NADAJE SERWER — wartość z formularza (podgląd) zawsze przegrywa.
      fields.numer = contractNumber;
      return tx
        .insert(schema.contractDrafts)
        .values({
          objectId,
          contractorId: object.contractorId,
          companyId: company.id,
          templateKey: def.key,
          contractNumber,
          seq,
          year,
          contractDate,
          status,
          fields: JSON.stringify(fields),
          notes,
          createdBy: user.id,
        })
        .returning()
        .get();
    });

    // Render POZA transakcją; błąd kasuje wiersz, żeby nie zostawić numeru
    // przypisanego dokumentowi, którego nie ma.
    try {
      generateFile(created, def, user.id);
    } catch (error) {
      db.delete(schema.contractDrafts).where(eq(schema.contractDrafts.id, created.id)).run();
      removeDraftDir(created.id);
      throw error;
    }

    logActivity(db, {
      entityType: ENTITY,
      entityId: created.id,
      objectId,
      user,
      action: "created",
      summary: `Utworzono draft umowy ${created.contractNumber} (${def.label})`,
    });
    return c.json({ success: true, data: loadDraft(created.id) }, 201);
  } catch (error) {
    return handleError(c, error, "tworzenia draftu umowy");
  }
});

app.get("/:id", (c) => {
  try {
    const id = idParam(c, "id");
    const draft = loadDraft(id);
    if (!draft) throw new ApiError(404, "Draft umowy nie istnieje");
    return c.json({ success: true, data: draft });
  } catch (error) {
    return handleError(c, error, "pobierania draftu umowy");
  }
});

app.put("/:id", async (c) => {
  try {
    const id = idParam(c, "id");
    const before = draftRow(id);
    if (!before) throw new ApiError(404, "Draft umowy nie istnieje");
    const body = await readJsonBody(c);

    // Obiekt, szablon i numer są ZAMROŻONE: zmiana obiektu osierociłaby numer
    // nadany przez spółkę tamtego obiektu, a zmiana szablonu — pola już zapisane.
    for (const forbidden of ["objectId", "templateKey", "contractNumber", "seq", "year"]) {
      if (body[forbidden] !== undefined) {
        throw new ApiError(400, `Pola „${forbidden}” nie da się zmienić po zapisaniu draftu — załóż nowy.`);
      }
    }

    const def = getTemplate(before.templateKey);
    if (!def) throw new ApiError(400, `Szablon „${before.templateKey}” nie istnieje już w rejestrze`);

    // Snapshot sprzed zmian — `fields` niżej jest mutowane (numer, data, pola
    // pochodne), a do dziennika potrzebujemy oryginału.
    const beforeFields = parseFieldsJson(before.fields);
    const fields = body.fields === undefined ? parseFieldsJson(before.fields) : completeFields(def, parseFields(def, body.fields));
    const contractDate =
      parseDate(body.contractDate, "Data zawarcia") ?? parseDate(fields.data_umowy, "Data zawarcia") ?? before.contractDate;
    fields.data_umowy = contractDate;
    // Numer zostaje ten, który nadał zapis — formularz nie ma jak go podmienić.
    fields.numer = before.contractNumber;
    fillDerived(def, fields);

    const status = body.status === undefined ? before.status : parseStatus(body.status);
    const notes = body.notes === undefined ? before.notes : textOrNull(body.notes, "Notatki");

    const after = db
      .update(schema.contractDrafts)
      .set({ fields: JSON.stringify(fields), contractDate, status, notes, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.contractDrafts.id, id))
      .returning()
      .get();

    logFieldDiffs(db, {
      entityType: ENTITY,
      entityId: id,
      objectId: before.objectId,
      user: getUser(c),
      before,
      after,
      fields: [
        { key: "contractDate", label: "datę zawarcia" },
        { key: "status", label: "status", format: (v) => CONTRACT_DRAFT_STATUS_LABELS[v as ContractDraftStatus] ?? String(v) },
        { key: "notes", label: "notatki" },
      ],
    });
    // Pola umowy to jeden JSON — generyczny differ wypisałby bezużyteczne
    // „(zmieniono) → (zmieniono)”. Logujemy osobno, z nazwami pól, które się
    // ruszyły; pełne wartości zostają w old_value/new_value.
    const changedLabels = def.fields
      .filter((f) => (beforeFields[f.key] ?? "") !== (fields[f.key] ?? ""))
      .map((f) => f.label);
    if (changedLabels.length) {
      logActivity(db, {
        entityType: ENTITY,
        entityId: id,
        objectId: before.objectId,
        user: getUser(c),
        action: "updated",
        field: "fields",
        oldValue: before.fields,
        newValue: after.fields,
        summary: `Zmieniono pola umowy: ${changedLabels.join(", ")}`,
      });
    }
    // PUT NIE REGENERUJE pliku — świeży DOCX kosztuje sekundy, a użytkownik może
    // poprawiać pola kilka razy. Nieaktualność widać po `stale`, a plik odświeża
    // jawne „Generuj ponownie”.
    return c.json({ success: true, data: loadDraft(id) });
  } catch (error) {
    return handleError(c, error, "zapisu draftu umowy");
  }
});

app.post("/:id/generate", (c) => {
  try {
    const id = idParam(c, "id");
    const row = draftRow(id);
    if (!row) throw new ApiError(404, "Draft umowy nie istnieje");
    const def = getTemplate(row.templateKey);
    if (!def) throw new ApiError(400, `Szablon „${row.templateKey}” nie istnieje już w rejestrze`);

    const user = getUser(c);
    generateFile(row, def, user.id);
    logActivity(db, {
      entityType: ENTITY,
      entityId: id,
      objectId: row.objectId,
      user,
      action: "updated",
      field: "generated",
      summary: `Wygenerowano dokument umowy ${row.contractNumber}`,
    });
    return c.json({ success: true, data: loadDraft(id) });
  } catch (error) {
    return handleError(c, error, "generowania dokumentu umowy");
  }
});

/**
 * „Przenieś do rejestru” — z DOKUMENTU robi FAKT handlowy (wiersz `contracts`).
 *
 * Rejestr i drafty opisują dwie różne rzeczy, więc przenosimy tylko to, co
 * w obu znaczy to samo: numer, obiekt, datę zawarcia jako początek okresu
 * i abonament jako wartość umowy. Reszty (data końca, aneksy) rejestr
 * dopisuje po swojemu — dlatego to jednorazowe PRZEPISANIE, a nie synchronizacja.
 *
 * Status: podpisany draft wchodzi jako umowa `active`, każdy inny jako `draft` —
 * dopóki klient nie podpisał, w rejestrze nie ma czego liczyć jako obowiązujące.
 * Status samego draftu ZOSTAJE bez zmian: to, że dokument trafił do rejestru,
 * nie znaczy, że ktoś go podpisał.
 *
 * Dwa 409: draft już ma swoją umowę (drugi wiersz byłby duplikatem tego samego
 * faktu) albo numer zajmuje inna umowa (numer jest w rejestrze unikalny).
 */
app.post("/:id/promote", (c) => {
  try {
    const id = idParam(c, "id");
    const row = draftRow(id);
    if (!row) throw new ApiError(404, "Draft umowy nie istnieje");

    const user = getUser(c);
    const fields = parseFieldsJson(row.fields);
    // Abonament miesięczny to jedyna kwota, którą draft zna; pusta wartość
    // zostaje pusta — brak kwoty to NIE zero złotych.
    const abonament = Number(str(fields.abonament).replace(",", ".").replace(/\s/g, ""));
    const value = Number.isFinite(abonament) && str(fields.abonament) !== "" ? abonament : null;

    const outcome = db.transaction((tx) => {
      const existing = tx
        .select({ id: schema.contracts.id, contractNumber: schema.contracts.contractNumber })
        .from(schema.contracts)
        .where(eq(schema.contracts.draftId, id))
        .get();
      if (existing) {
        return {
          kind: "conflict" as const,
          conflict: `Ten draft jest już w rejestrze jako umowa „${existing.contractNumber}”.`,
        } as const;
      }
      if (numberTaken(tx, row.contractNumber)) {
        return {
          kind: "conflict" as const,
          conflict: `W rejestrze jest już umowa o numerze „${row.contractNumber}”. Zmień numer w rejestrze albo usuń tamten wpis.`,
        } as const;
      }

      const inserted = tx
        .insert(schema.contracts)
        .values({
          objectId: row.objectId,
          contractNumber: row.contractNumber,
          startDate: row.contractDate,
          value,
          status: row.status === "signed" ? "active" : "draft",
          draftId: id,
        })
        .returning()
        .get();

      // Ten sam ślad, co przy ręcznym dodaniu umowy — historia obiektu ma
      // pokazywać wpis niezależnie od tego, którędy umowa weszła do rejestru.
      tx.insert(schema.objectHistory)
        .values({
          objectId: row.objectId,
          action: "contract_created",
          description: `Contract ${row.contractNumber} created from draft ${id}`,
          newValue: JSON.stringify(inserted),
        })
        .run();

      return { kind: "ok" as const, contract: inserted };
    });

    if (outcome.kind === "conflict") throw new ApiError(409, outcome.conflict);

    logActivity(db, {
      entityType: ENTITY,
      entityId: id,
      objectId: row.objectId,
      user,
      action: "updated",
      field: "promoted",
      summary: `Przeniesiono umowę ${row.contractNumber} do rejestru umów`,
    });

    return c.json({
      success: true,
      data: {
        contract: {
          ...outcome.contract,
          draftFileUrl: draftFileUrlOf(id, row.generatedStoredPath),
        },
        draft: loadDraft(id),
      },
    });
  } catch (error) {
    return handleError(c, error, "przenoszenia umowy do rejestru");
  }
});

/**
 * Wygenerowany dokument draftu.
 *
 * `preview=1` renderuje w PAMIĘCI wariant z kolorowaniem pól (żółte = do
 * uzupełnienia, zielone = wypełnione) z zapisanych `fields`. Plik na dysku i
 * kolumny `generated_*` zostają nietknięte — to tylko podgląd. Bez tego
 * parametru trasa działa jak dotąd: strumień pliku z dysku, bez kolorów.
 */
app.get("/:id/file", (c) => {
  try {
    const id = idParam(c, "id");
    const row = draftRow(id);
    if (!row) throw new ApiError(404, "Draft umowy nie istnieje");
    const abs = generatedFilePath(row.generatedStoredPath);
    if (!abs) throw new ApiError(404, "Dokument nie został jeszcze wygenerowany");

    const inline = c.req.query("inline") === "1";
    const fileName = row.generatedFileName ?? `umowa-${id}.docx`;

    if (c.req.query("preview") === "1") {
      const def = getTemplate(row.templateKey);
      if (!def) throw new ApiError(400, "Nieznany szablon umowy tego draftu");
      const fields = parseFieldsJson(row.fields);
      // Puste pole bez własnego `emptyPlaceholder` wychodzi z renderu jako pusty
      // `<w:t/>` — tło nie miałoby czego pokolorować i „do uzupełnienia”
      // byłoby w podglądzie niewidoczne. W SAMYM PODGLĄDZIE dokładamy więc
      // kropki; plik na dysku i pobranie zostają bez nich.
      const body = renderContractDocx(def, fields, { highlight: true, emptyFallback: BLANK_PLACEHOLDER });
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "Content-Type": DOCX_MIME,
          "Content-Length": String(body.length),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": contentDisposition("inline", fileName),
          "X-Contract-Missing": String(countMissingContractFields(def, fields)),
        },
      });
    }

    const size = statSync(abs).size;
    const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": DOCX_MIME,
        "Content-Length": String(size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", fileName),
      },
    });
  } catch (error) {
    return handleError(c, error, "pobierania dokumentu umowy");
  }
});

app.delete("/:id", (c) => {
  try {
    const id = idParam(c, "id");
    const row = draftRow(id);
    if (!row) throw new ApiError(404, "Draft umowy nie istnieje");
    db.delete(schema.contractDrafts).where(eq(schema.contractDrafts.id, id)).run();
    // Katalog (DOCX + załączniki) znika PO usunięciu wierszy — nieudane
    // kasowanie nie zabiera plików.
    removeDraftDir(id);
    logActivity(db, {
      entityType: ENTITY,
      entityId: id,
      objectId: row.objectId,
      user: getUser(c),
      action: "deleted",
      summary: `Usunięto draft umowy ${row.contractNumber}`,
    });
    return c.json({ success: true, data: { id } });
  } catch (error) {
    return handleError(c, error, "usuwania draftu umowy");
  }
});

// ---------------------------------------------------------------------------
// Załączniki (skan podpisanej umowy, aneksy) — ten sam moduł co w interwencjach
// ---------------------------------------------------------------------------

app.post("/:id/attachments", async (c) => {
  try {
    const id = idParam(c, "id");
    const files = await readFiles(c);
    if (!draftRow(id)) throw new ApiError(404, "Draft umowy nie istnieje");
    if (files.length === 0) throw new ApiError(400, "Nie wybrano plików");
    const already =
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.contractDraftAttachments)
        .where(eq(schema.contractDraftAttachments.draftId, id))
        .get()?.n ?? 0;
    if (already + files.length > ATTACHMENT_MAX_FILES) {
      throw new ApiError(400, `Maksymalnie ${ATTACHMENT_MAX_FILES} plików na umowę (jest już ${already})`);
    }
    const stored = await storeUploads(draftScope(id), files);
    try {
      db.transaction((tx) => {
        for (const s of stored) tx.insert(schema.contractDraftAttachments).values({ draftId: id, ...s }).run();
        tx.update(schema.contractDrafts)
          .set({ updatedAt: sql`(datetime('now'))` })
          .where(eq(schema.contractDrafts.id, id))
          .run();
      });
    } catch (error) {
      // Wiersze nie doszły — pliki na dysku byłyby sierotami.
      removeStoredFiles(stored);
      throw error;
    }
    return c.json({ success: true, data: loadDraft(id) });
  } catch (error) {
    return handleError(c, error, "dodawania załączników umowy");
  }
});

app.get("/:id/attachments/:attId/download", (c) => {
  try {
    const id = idParam(c, "id");
    const attId = idParam(c, "attId");
    const att = db
      .select()
      .from(schema.contractDraftAttachments)
      .where(eq(schema.contractDraftAttachments.id, attId))
      .get();
    // Cudzy załącznik to dla tej trasy brak załącznika.
    if (!att || att.draftId !== id) throw new ApiError(404, "Załącznik nie istnieje");
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
    return handleError(c, error, "pobierania załącznika umowy");
  }
});

app.delete("/:id/attachments/:attId", (c) => {
  try {
    const id = idParam(c, "id");
    const attId = idParam(c, "attId");
    const att = db
      .select()
      .from(schema.contractDraftAttachments)
      .where(eq(schema.contractDraftAttachments.id, attId))
      .get();
    if (!att || att.draftId !== id) throw new ApiError(404, "Załącznik nie istnieje");
    db.transaction((tx) => {
      tx.delete(schema.contractDraftAttachments).where(eq(schema.contractDraftAttachments.id, attId)).run();
      tx.update(schema.contractDrafts)
        .set({ updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.contractDrafts.id, id))
        .run();
    });
    // Plik znika dopiero po commicie — nieudana transakcja nie zostawia wiersza bez pliku.
    removeStoredFiles([att]);
    return c.json({ success: true, data: { id: attId, draftId: id } });
  } catch (error) {
    return handleError(c, error, "usuwania załącznika umowy");
  }
});

export default app;
