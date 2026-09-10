/**
 * Manuale (/api/manuals) — biblioteka instrukcji i dokumentacji działu technicznego.
 *
 * Manual = tytuł + opis + załączniki (pliki na dysku, metadane w `manual_attachments`)
 * + powiązania z kartoteką magazynu i katalogiem usług (`manual_links`). Załączniki
 * obsługuje wspólny moduł src/lib/calendar-attachments.ts (scope = `manuals/<id>`),
 * ten sam, którego używają notatki kalendarza: te same limity (15 plików × 5 MB),
 * ta sama konwersja obrazków do WebP i ta sama ochrona przed path traversal.
 *
 * Pickery `GET /pick/items` i `GET /pick/services` są TUTAJ, a nie w /warehouse i /services,
 * bo uprawnienia są per-zakładka: ktoś z samym `technical/manuale` dostałby 403 na tamtych
 * trasach i nie mógłby powiązać manuala z niczym. Zwracają wyłącznie nazwy i oznaczenia
 * (bez cen i stanów), więc nie otwierają magazynu ani cennika.
 */
import { Hono, type Context } from "hono";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { db, schema } from "../db/index.js";
import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Manual, ManualAttachment, CalendarAttachmentKind } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { logActivity } from "../lib/activity-log.js";
import { ApiError } from "../lib/calendar-labels.js";
import {
  attachmentFilePath,
  contentDisposition,
  removeAttachmentDir,
  removeStoredFiles,
  storeUploads,
  ATTACHMENT_MAX_FILES,
  type IncomingFile,
} from "../lib/calendar-attachments.js";

const app = new Hono();

/** Encja w activity_log. */
const ENTITY = "manual";

/** Scope katalogu załączników manuala (podkatalog w data/attachments). */
const scopeOf = (manualId: number) => `manuals/${manualId}`;

/** Prefiks URL tras plikowych (router montowany pod /api/manuals). */
const ATT_URL_PREFIX = "/api/manuals/attachments";

// ---------------------------------------------------------------------------
// Kształt JSON (kontrakt z frontem — frontend/src/lib/api.ts, manualsApi)
// ---------------------------------------------------------------------------

export interface ManualAttachmentJson {
  id: number;
  fileName: string;
  mime: string;
  size: number;
  kind: CalendarAttachmentKind;
  width: number | null;
  height: number | null;
  url: string;
  downloadUrl: string;
  createdAt: string;
  /** Punkt, do którego plik należy; NULL = plik „luzem" („Pozostałe pliki" na froncie). */
  sectionId: number | null;
  /** Kolejność w obrębie punktu. */
  position: number;
}

/**
 * Punkt manuala („1.") albo podpunkt („1.1") — max dwa poziomy.
 * `children` wypełnione tylko dla punktów poziomu 1; wszystko posortowane po `position`.
 */
export interface ManualSectionJson {
  id: number;
  parentId: number | null;
  position: number;
  title: string | null;
  body: string | null;
  attachments: ManualAttachmentJson[];
  children: ManualSectionJson[];
}

export interface ManualLinkJson {
  id: number;
  kind: "item" | "service";
  refId: number;
  name: string;
  /** SKU/producent dla towaru, kategoria/jednostka dla usługi. NULL = nie ma czego pokazać. */
  meta: string | null;
}

export interface ManualJson {
  id: number;
  title: string;
  description: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  attachmentsCount: number;
  /** WSZYSTKIE załączniki manuala, płasko (jak dotąd) — również te przypisane do punktów. */
  attachments: ManualAttachmentJson[];
  links: ManualLinkJson[];
  /** Struktura treści: punkty poziomu 1 z podpunktami w `children`. */
  sections: ManualSectionJson[];
  /** Załączniki bez punktu (sectionId === null) — front pokazuje je jako „Pozostałe pliki". */
  unassignedAttachments: ManualAttachmentJson[];
}

function attachmentJson(r: ManualAttachment): ManualAttachmentJson {
  return {
    id: r.id,
    fileName: r.fileName,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    width: r.width,
    height: r.height,
    url: `${ATT_URL_PREFIX}/${r.id}`,
    downloadUrl: `${ATT_URL_PREFIX}/${r.id}?download=1`,
    createdAt: r.createdAt,
    sectionId: r.sectionId,
    position: r.position,
  };
}

// ---------------------------------------------------------------------------
// Odczyt z bazy — zawsze wsadowo (bez N+1), bo lista wraca w całości
// ---------------------------------------------------------------------------

/**
 * Załączniki wielu manuali jednym zapytaniem. Zwraca dwa widoki tych samych obiektów:
 * `byManual` (płasko, po id — kolejność jak przed punktami) i `bySection` (po position,
 * potem id — tak jak mają się wyświetlać wewnątrz punktu).
 */
function attachmentsByManual(ids: number[]): {
  byManual: Map<number, ManualAttachmentJson[]>;
  bySection: Map<number, ManualAttachmentJson[]>;
} {
  const byManual = new Map<number, ManualAttachmentJson[]>();
  const bySection = new Map<number, ManualAttachmentJson[]>();
  if (ids.length === 0) return { byManual, bySection };
  const rows = db
    .select()
    .from(schema.manualAttachments)
    .where(inArray(schema.manualAttachments.manualId, ids))
    .orderBy(asc(schema.manualAttachments.id))
    .all();
  for (const r of rows) {
    const json = attachmentJson(r);
    const list = byManual.get(r.manualId) ?? [];
    list.push(json);
    byManual.set(r.manualId, list);
    if (r.sectionId !== null) {
      const inSection = bySection.get(r.sectionId) ?? [];
      inSection.push(json);
      bySection.set(r.sectionId, inSection);
    }
  }
  for (const list of bySection.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);
  return { byManual, bySection };
}

/**
 * Punkty wielu manuali jednym zapytaniem, złożone w drzewo (max 2 poziomy).
 * Kolejność rodzeństwa = `position`, remis rozstrzyga id. Węzeł, którego rodzic
 * nie należy do tego samego manuala (nie powinno się zdarzyć — jest FK), ląduje
 * na najwyższym poziomie, żeby nigdy nie zniknąć z odpowiedzi.
 */
function sectionsByManual(
  ids: number[],
  attachmentsBySection: Map<number, ManualAttachmentJson[]>
): Map<number, ManualSectionJson[]> {
  const out = new Map<number, ManualSectionJson[]>();
  if (ids.length === 0) return out;
  const rows = db
    .select()
    .from(schema.manualSections)
    .where(inArray(schema.manualSections.manualId, ids))
    .orderBy(asc(schema.manualSections.position), asc(schema.manualSections.id))
    .all();
  const nodes = new Map<number, ManualSectionJson>();
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id,
      parentId: r.parentId,
      position: r.position,
      title: r.title,
      body: r.body,
      attachments: attachmentsBySection.get(r.id) ?? [],
      children: [],
    });
  }
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    const parent = r.parentId !== null ? nodes.get(r.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
      continue;
    }
    const list = out.get(r.manualId) ?? [];
    list.push(node);
    out.set(r.manualId, list);
  }
  return out;
}

/**
 * Powiązania wielu manuali jednym zapytaniem (LEFT JOIN po towarze i usłudze);
 * klucz = manualId. Wiersz, którego towar/usługa zniknęły, jest pomijany —
 * FK ma ON DELETE cascade, więc w praktyce nie powinien wystąpić.
 */
function linksByManual(ids: number[]): Map<number, ManualLinkJson[]> {
  const out = new Map<number, ManualLinkJson[]>();
  if (ids.length === 0) return out;
  const rows = db
    .select({
      id: schema.manualLinks.id,
      manualId: schema.manualLinks.manualId,
      warehouseItemId: schema.manualLinks.warehouseItemId,
      serviceId: schema.manualLinks.serviceId,
      itemName: schema.warehouseItems.name,
      itemSku: schema.warehouseItems.sku,
      itemManufacturer: schema.warehouseItems.manufacturer,
      serviceName: schema.services.name,
      serviceCategory: schema.services.category,
      serviceUnit: schema.services.unit,
    })
    .from(schema.manualLinks)
    .leftJoin(schema.warehouseItems, eq(schema.manualLinks.warehouseItemId, schema.warehouseItems.id))
    .leftJoin(schema.services, eq(schema.manualLinks.serviceId, schema.services.id))
    .where(inArray(schema.manualLinks.manualId, ids))
    .orderBy(asc(schema.manualLinks.id))
    .all();
  for (const r of rows) {
    let link: ManualLinkJson | null = null;
    if (r.warehouseItemId !== null && r.itemName !== null) {
      const meta = [r.itemSku, r.itemManufacturer].filter((v) => !!v && String(v).trim()).join(" · ");
      link = { id: r.id, kind: "item", refId: r.warehouseItemId, name: r.itemName, meta: meta || null };
    } else if (r.serviceId !== null && r.serviceName !== null) {
      const meta = [r.serviceCategory, r.serviceUnit].filter((v) => !!v && String(v).trim()).join(" · ");
      link = { id: r.id, kind: "service", refId: r.serviceId, name: r.serviceName, meta: meta || null };
    }
    if (!link) continue;
    const list = out.get(r.manualId) ?? [];
    list.push(link);
    out.set(r.manualId, list);
  }
  return out;
}

function serialize(rows: Manual[]): ManualJson[] {
  const ids = rows.map((r) => r.id);
  const { byManual, bySection } = attachmentsByManual(ids);
  const links = linksByManual(ids);
  const sections = sectionsByManual(ids, bySection);
  return rows.map((r) => {
    const a = byManual.get(r.id) ?? [];
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      createdBy: r.createdBy,
      updatedBy: r.updatedBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      attachmentsCount: a.length,
      attachments: a,
      links: links.get(r.id) ?? [],
      sections: sections.get(r.id) ?? [],
      unassignedAttachments: a.filter((att) => att.sectionId === null),
    };
  });
}

/** Pełny JSON jednego manuala albo null, gdy nie istnieje. */
function loadManual(id: number): ManualJson | null {
  const row = db.select().from(schema.manuals).where(eq(schema.manuals.id, id)).get();
  if (!row) return null;
  return serialize([row])[0];
}

function getManualRow(id: number): Manual | undefined {
  return db.select().from(schema.manuals).where(eq(schema.manuals.id, id)).get();
}

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Login do kolumn created_by / updated_by (jak w ofertach i magazynie). */
function loginOf(c: Context): string {
  const u = getUser(c);
  return u.email ?? String(u.id);
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

/** Tytuł manuala — wymagany, do 200 znaków (jak nazwy w pozostałych katalogach). */
function parseTitle(v: unknown): string {
  const title = str(v);
  if (!title) throw new ApiError(400, "Tytuł manuala jest wymagany");
  if (title.length > 200) throw new ApiError(400, "Tytuł manuala jest za długi (maks. 200 znaków)");
  return title;
}

/** Lista id z JSON-a albo ze stringa multipartu (`"[1,2]"`). Duplikaty scalane. */
function parseIdList(raw: unknown, label: string): number[] {
  if (raw === undefined || raw === null || raw === "") return [];
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ApiError(400, `Nieprawidłowa lista: ${label}`);
    }
  }
  if (!Array.isArray(value)) throw new ApiError(400, `Nieprawidłowa lista: ${label}`);
  const out: number[] = [];
  for (const v of value) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `Nieprawidłowa lista: ${label}`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Zastępuje CAŁY zbiór powiązań manuala (w otwartej transakcji). Wcześniej sprawdza,
 * że każdy towar i każda usługa faktycznie istnieją — inaczej front pokazywałby chip
 * bez nazwy, a wiersz i tak zniknąłby przy kaskadzie.
 */
function replaceLinks(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  manualId: number,
  itemIds: number[],
  serviceIds: number[]
): void {
  if (itemIds.length) {
    const found = tx
      .select({ id: schema.warehouseItems.id })
      .from(schema.warehouseItems)
      .where(inArray(schema.warehouseItems.id, itemIds))
      .all()
      .map((r) => r.id);
    const missing = itemIds.filter((id) => !found.includes(id));
    if (missing.length) throw new ApiError(400, `Nie ma takich towarów: ${missing.join(", ")}`);
  }
  if (serviceIds.length) {
    const found = tx
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(inArray(schema.services.id, serviceIds))
      .all()
      .map((r) => r.id);
    const missing = serviceIds.filter((id) => !found.includes(id));
    if (missing.length) throw new ApiError(400, `Nie ma takich usług: ${missing.join(", ")}`);
  }
  tx.delete(schema.manualLinks).where(eq(schema.manualLinks.manualId, manualId)).run();
  for (const itemId of itemIds) {
    tx.insert(schema.manualLinks).values({ manualId, warehouseItemId: itemId, serviceId: null }).run();
  }
  for (const serviceId of serviceIds) {
    tx.insert(schema.manualLinks).values({ manualId, warehouseItemId: null, serviceId }).run();
  }
}

// ---------------------------------------------------------------------------
// Punkty i podpunkty (PUT /:id/sections)
// ---------------------------------------------------------------------------

/** Maksymalna długość tytułu punktu — jak tytuł manuala. */
const SECTION_TITLE_MAX = 200;

/** Węzeł wejścia PUT /:id/sections (kontrakt z frontem). */
export interface SectionInput {
  /** Istniejący punkt → update; brak → insert. */
  id?: number;
  /** Klucz nadany przez front dla NOWEGO punktu — wraca w `keyMap` z nadanym id. */
  key?: string;
  title?: string | null;
  body?: string | null;
  /** Załączniki tego punktu, w kolejności wyświetlania. */
  attachmentIds?: number[];
  /** Podpunkty — tylko na pierwszym poziomie (głębiej → 400). */
  children?: SectionInput[];
}

/** Wejście spłaszczone do kolejności zapisu: rodzic zawsze przed dzieckiem. */
interface FlatSection {
  id: number | null;
  key: string | null;
  title: string | null;
  body: string | null;
  attachmentIds: number[];
  /** Kolejność wśród rodzeństwa. */
  position: number;
  /** Indeks rodzica w tablicy (zawsze mniejszy od własnego), null = poziom 1. */
  parentIndex: number | null;
}

/** Tekst pola punktu: brak/null/puste → null (punkt bez tytułu to sam numer). */
function sectionText(v: unknown, label: string, max?: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiError(400, `Nieprawidłowe pole punktu: ${label}`);
  const t = v.trim();
  if (!t) return null;
  if (max && t.length > max) throw new ApiError(400, `${label} punktu jest za długi (maks. ${max} znaków)`);
  return t;
}

/**
 * Waliduje i spłaszcza drzewo wejścia. Pilnuje dwóch poziomów, unikalności `key`
 * i unikalności `id` (ten sam punkt nie może wystąpić dwa razy).
 */
function parseSections(raw: unknown): FlatSection[] {
  if (!Array.isArray(raw)) throw new ApiError(400, "Nieprawidłowa lista punktów");
  const flat: FlatSection[] = [];
  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();

  const walk = (nodes: unknown[], parentIndex: number | null, depth: number): void => {
    if (depth > 2) throw new ApiError(400, "Za głębokie zagnieżdżenie punktów (maks. 2 poziomy)");
    nodes.forEach((raw, position) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "Nieprawidłowy punkt");
      const node = raw as Record<string, unknown>;

      let id: number | null = null;
      if (node.id !== undefined && node.id !== null) {
        const n = Number(node.id);
        if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, "Nieprawidłowe id punktu");
        if (seenIds.has(n)) throw new ApiError(400, `Punkt ${n} występuje w danych dwa razy`);
        seenIds.add(n);
        id = n;
      }

      let key: string | null = null;
      if (node.key !== undefined && node.key !== null) {
        if (typeof node.key !== "string" || !node.key.trim()) throw new ApiError(400, "Nieprawidłowy klucz punktu");
        key = node.key.trim();
        if (seenKeys.has(key)) throw new ApiError(400, `Klucz punktu „${key}" występuje dwa razy`);
        seenKeys.add(key);
      }

      const index = flat.length;
      flat.push({
        id,
        key,
        title: sectionText(node.title, "Tytuł", SECTION_TITLE_MAX),
        body: sectionText(node.body, "Tekst"),
        attachmentIds: parseIdList(node.attachmentIds, "attachmentIds"),
        position,
        parentIndex,
      });

      if (node.children !== undefined && node.children !== null) {
        if (!Array.isArray(node.children)) throw new ApiError(400, "Nieprawidłowa lista podpunktów");
        if (node.children.length) walk(node.children, index, depth + 1);
      }
    });
  };

  walk(raw, null, 1);
  return flat;
}

/**
 * Zastępuje CAŁĄ strukturę punktów manuala (w otwartej transakcji) i przypisuje
 * załączniki. Kolejność operacji jest istotna:
 *   1) update/insert punktów z wejścia (rodzice przed dziećmi — stąd spłaszczenie),
 *   2) DOPIERO potem kasowanie punktów spoza wejścia; punkt przeniesiony pod innego
 *      rodzica ma już nowy parent_id, więc kaskada po skasowanym rodzicu go nie tknie,
 *   3) na koniec załączniki: wymienione → section_id + position wg kolejności,
 *      wszystkie pozostałe → section_id NULL (pliki NIE są kasowane).
 * Zwraca keyMap: `key` z wejścia → id punktu w bazie.
 */
function replaceSections(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  manualId: number,
  flat: FlatSection[]
): Record<string, number> {
  const existing = tx
    .select({ id: schema.manualSections.id })
    .from(schema.manualSections)
    .where(eq(schema.manualSections.manualId, manualId))
    .all()
    .map((r) => r.id);
  const existingSet = new Set(existing);

  for (const node of flat) {
    if (node.id !== null && !existingSet.has(node.id)) {
      throw new ApiError(400, `Punkt ${node.id} nie należy do tego manuala`);
    }
  }

  const keyMap: Record<string, number> = {};
  const resolved: number[] = [];
  for (const node of flat) {
    const parentId = node.parentIndex === null ? null : resolved[node.parentIndex];
    let id: number;
    if (node.id !== null) {
      tx.update(schema.manualSections)
        .set({
          parentId,
          position: node.position,
          title: node.title,
          body: node.body,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(eq(schema.manualSections.id, node.id))
        .run();
      id = node.id;
    } else {
      id = tx
        .insert(schema.manualSections)
        .values({ manualId, parentId, position: node.position, title: node.title, body: node.body })
        .returning({ id: schema.manualSections.id })
        .get().id;
    }
    resolved.push(id);
    if (node.key) keyMap[node.key] = id;
  }

  const keep = new Set(resolved);
  const toDelete = existing.filter((id) => !keep.has(id));
  if (toDelete.length) {
    tx.delete(schema.manualSections).where(inArray(schema.manualSections.id, toDelete)).run();
  }

  // --- załączniki ---
  const owned = new Set(
    tx
      .select({ id: schema.manualAttachments.id })
      .from(schema.manualAttachments)
      .where(eq(schema.manualAttachments.manualId, manualId))
      .all()
      .map((r) => r.id)
  );
  const assigned = new Map<number, { sectionId: number; position: number }>();
  flat.forEach((node, i) => {
    node.attachmentIds.forEach((attId, position) => {
      if (!owned.has(attId)) throw new ApiError(400, `Załącznik ${attId} nie należy do tego manuala`);
      if (assigned.has(attId)) throw new ApiError(400, `Załącznik ${attId} przypisany do dwóch punktów`);
      assigned.set(attId, { sectionId: resolved[i], position });
    });
  });
  for (const [attId, at] of assigned) {
    tx.update(schema.manualAttachments)
      .set({ sectionId: at.sectionId, position: at.position })
      .where(eq(schema.manualAttachments.id, attId))
      .run();
  }
  const assignedIds = [...assigned.keys()];
  tx.update(schema.manualAttachments)
    .set({ sectionId: null, position: 0 })
    .where(
      assignedIds.length
        ? and(
            eq(schema.manualAttachments.manualId, manualId),
            notInArray(schema.manualAttachments.id, assignedIds)
          )
        : eq(schema.manualAttachments.manualId, manualId)
    )
    .run();

  return keyMap;
}

/** Pliki z multipartu (pole `files`), bez walidacji typu — tę robi storeUploads. */
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

// ---------------------------------------------------------------------------
// Pickery — MUSZĄ być zarejestrowane PRZED GET /:id (Hono dopasowuje po kolejności)
// ---------------------------------------------------------------------------

const PICK_LIMIT = 30;

app.get("/pick/items", (c) => {
  const q = str(c.req.query("q")).toLowerCase();
  const rows = db
    .select({
      id: schema.warehouseItems.id,
      name: schema.warehouseItems.name,
      sku: schema.warehouseItems.sku,
      manufacturer: schema.warehouseItems.manufacturer,
      category: schema.warehouseItems.category,
    })
    .from(schema.warehouseItems)
    .where(
      q
        ? and(
            eq(schema.warehouseItems.isArchived, false),
            or(
              sql`lower(${schema.warehouseItems.name}) like ${"%" + q + "%"}`,
              sql`lower(coalesce(${schema.warehouseItems.sku}, '')) like ${"%" + q + "%"}`,
              sql`lower(coalesce(${schema.warehouseItems.manufacturer}, '')) like ${"%" + q + "%"}`
            )
          )
        : eq(schema.warehouseItems.isArchived, false)
    )
    .orderBy(asc(schema.warehouseItems.name))
    .limit(PICK_LIMIT)
    .all();
  return c.json({ success: true, data: rows });
});

app.get("/pick/services", (c) => {
  const q = str(c.req.query("q")).toLowerCase();
  const rows = db
    .select({
      id: schema.services.id,
      name: schema.services.name,
      category: schema.services.category,
      unit: schema.services.unit,
    })
    .from(schema.services)
    .where(
      q
        ? and(
            eq(schema.services.active, true),
            sql`lower(${schema.services.name}) like ${"%" + q + "%"}`
          )
        : eq(schema.services.active, true)
    )
    .orderBy(asc(schema.services.position), asc(schema.services.name))
    .limit(PICK_LIMIT)
    .all();
  return c.json({ success: true, data: rows });
});

// ---------------------------------------------------------------------------
// Załączniki: GET /attachments/:id (?download=1) i DELETE — też przed GET /:id
// ---------------------------------------------------------------------------

app.get("/attachments/:attachmentId", (c) => {
  const attId = Number(c.req.param("attachmentId"));
  if (!Number.isInteger(attId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  const att = db.select().from(schema.manualAttachments).where(eq(schema.manualAttachments.id, attId)).get();
  if (!att) return c.json({ success: false, error: "Załącznik nie istnieje" }, 404);
  const abs = attachmentFilePath(att.storedPath);
  if (!abs) return c.json({ success: false, error: "Plik załącznika nie istnieje na dysku" }, 404);
  const download = c.req.query("download") === "1";
  const size = statSync(abs).size;
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": att.mime,
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": contentDisposition(download ? "attachment" : "inline", att.fileName),
    },
  });
});

/** Usuwa może każdy z uprawnieniem `edit` — manual to wspólna biblioteka, nie czyjaś notatka. */
app.delete("/attachments/:attachmentId", (c) => {
  try {
    const attId = idParam(c, "attachmentId");
    const removed = db.transaction((tx) => {
      const att = tx.select().from(schema.manualAttachments).where(eq(schema.manualAttachments.id, attId)).get();
      if (!att) throw new ApiError(404, "Załącznik nie istnieje");
      tx.delete(schema.manualAttachments).where(eq(schema.manualAttachments.id, attId)).run();
      tx.update(schema.manuals)
        .set({ updatedBy: loginOf(c), updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.manuals.id, att.manualId))
        .run();
      return att;
    });
    // Plik znika dopiero po commicie — nieudana transakcja nie zostawia wiersza bez pliku.
    removeStoredFiles([removed]);
    return c.json({ success: true, data: { id: attId, manualId: removed.manualId } });
  } catch (error) {
    return handleError(c, error, "usuwania załącznika");
  }
});

// ---------------------------------------------------------------------------
// Lista i szczegóły
// ---------------------------------------------------------------------------

const SORTS = ["title", "updatedAt", "createdAt", "attachmentsCount"] as const;
type Sort = (typeof SORTS)[number];

/**
 * GET / — cała lista (paginacja jest po stronie frontu). Filtrowanie po `q`
 * i sortowanie robimy w JS, bo `q` obejmuje też nazwy powiązanych towarów i usług,
 * a `attachmentsCount` wymagałby i tak agregatu — a biblioteka manuali to setki,
 * nie setki tysięcy wierszy.
 */
app.get("/", (c) => {
  try {
    const q = str(c.req.query("q")).toLowerCase();
    const itemIdRaw = c.req.query("itemId");
    const serviceIdRaw = c.req.query("serviceId");
    const sortRaw = str(c.req.query("sort"));
    const sort: Sort = (SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as Sort) : "updatedAt";
    const dir = str(c.req.query("dir")).toLowerCase() === "asc" ? "asc" : str(c.req.query("dir")).toLowerCase() === "desc" ? "desc" : sort === "title" ? "asc" : "desc";

    const rows = db.select().from(schema.manuals).all();
    let list = serialize(rows);

    if (itemIdRaw !== undefined && itemIdRaw !== "") {
      const itemId = Number(itemIdRaw);
      if (!Number.isInteger(itemId)) throw new ApiError(400, "Nieprawidłowe itemId");
      list = list.filter((m) => m.links.some((l) => l.kind === "item" && l.refId === itemId));
    }
    if (serviceIdRaw !== undefined && serviceIdRaw !== "") {
      const serviceId = Number(serviceIdRaw);
      if (!Number.isInteger(serviceId)) throw new ApiError(400, "Nieprawidłowe serviceId");
      list = list.filter((m) => m.links.some((l) => l.kind === "service" && l.refId === serviceId));
    }
    if (q) {
      list = list.filter((m) => {
        const hay = [m.title, m.description ?? "", ...m.links.map((l) => `${l.name} ${l.meta ?? ""}`)]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    const cmp = (a: ManualJson, b: ManualJson): number => {
      switch (sort) {
        case "title":
          return a.title.localeCompare(b.title, "pl");
        case "createdAt":
          return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
        case "attachmentsCount":
          return a.attachmentsCount - b.attachmentsCount || a.id - b.id;
        default:
          return a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id;
      }
    };
    list.sort((a, b) => (dir === "asc" ? cmp(a, b) : -cmp(a, b)));

    return c.json({ success: true, data: list });
  } catch (error) {
    return handleError(c, error, "pobierania manuali");
  }
});

app.get("/:id", (c) => {
  try {
    const id = idParam(c, "id");
    const manual = loadManual(id);
    if (!manual) throw new ApiError(404, "Manual nie istnieje");
    return c.json({ success: true, data: manual });
  } catch (error) {
    return handleError(c, error, "pobierania manuala");
  }
});

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------

/**
 * POST / — multipart/form-data: title, description, files (wiele), itemIds/serviceIds
 * (JSON-owe tablice w polach tekstowych). Wiersz manuala musi powstać PRZED zapisem
 * plików, bo katalog na dysku ma w nazwie jego id; przy błędzie zapisu plików manual
 * jest kasowany, żeby nie zostawić pustego wpisu po nieudanym dodaniu.
 */
app.post("/", async (c) => {
  try {
    const { form, files } = await readFiles(c);
    const title = parseTitle(form.get("title"));
    const descRaw = form.get("description");
    const description = typeof descRaw === "string" && descRaw.trim() ? descRaw.trim() : null;
    const itemIds = parseIdList(form.get("itemIds"), "itemIds");
    const serviceIds = parseIdList(form.get("serviceIds"), "serviceIds");
    if (files.length > ATTACHMENT_MAX_FILES) throw new ApiError(400, `Maksymalnie ${ATTACHMENT_MAX_FILES} plików`);
    const login = loginOf(c);

    const created = db.transaction((tx) => {
      const row = tx
        .insert(schema.manuals)
        .values({ title, description, createdBy: login, updatedBy: login })
        .returning()
        .get();
      replaceLinks(tx, row.id, itemIds, serviceIds);
      return row;
    });

    if (files.length) {
      let stored;
      try {
        stored = await storeUploads(scopeOf(created.id), files);
      } catch (error) {
        // Nieudany upload = nieudane dodanie manuala (front i tak pokaże błąd).
        db.delete(schema.manuals).where(eq(schema.manuals.id, created.id)).run();
        removeAttachmentDir(scopeOf(created.id));
        throw error;
      }
      try {
        db.transaction((tx) => {
          stored.forEach((s, position) =>
            tx.insert(schema.manualAttachments).values({ manualId: created.id, position, ...s }).run()
          );
        });
      } catch (error) {
        removeStoredFiles(stored);
        db.delete(schema.manuals).where(eq(schema.manuals.id, created.id)).run();
        removeAttachmentDir(scopeOf(created.id));
        throw error;
      }
    }

    logActivity(db, {
      entityType: ENTITY,
      entityId: created.id,
      user: getUser(c),
      action: "created",
      summary: `Dodano manual: ${title}`,
    });
    return c.json({ success: true, data: loadManual(created.id) }, 201);
  } catch (error) {
    return handleError(c, error, "dodawania manuala");
  }
});

app.put("/:id", async (c) => {
  try {
    const id = idParam(c, "id");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "Nieprawidłowe dane");
    const row = getManualRow(id);
    if (!row) throw new ApiError(404, "Manual nie istnieje");

    const patch: { title?: string; description?: string | null } = {};
    if (body.title !== undefined) patch.title = parseTitle(body.title);
    if (body.description !== undefined) {
      const d = str(body.description);
      patch.description = d || null;
    }

    db.update(schema.manuals)
      .set({ ...patch, updatedBy: loginOf(c), updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.manuals.id, id))
      .run();

    logActivity(db, {
      entityType: ENTITY,
      entityId: id,
      user: getUser(c),
      action: "updated",
      summary: `Zmieniono manual: ${patch.title ?? row.title}`,
    });
    return c.json({ success: true, data: loadManual(id) });
  } catch (error) {
    return handleError(c, error, "zapisu manuala");
  }
});

/** PUT /:id/links — zastępuje CAŁY zbiór powiązań (itemIds + serviceIds). */
app.put("/:id/links", async (c) => {
  try {
    const id = idParam(c, "id");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "Nieprawidłowe dane");
    if (!getManualRow(id)) throw new ApiError(404, "Manual nie istnieje");
    const itemIds = parseIdList(body.itemIds, "itemIds");
    const serviceIds = parseIdList(body.serviceIds, "serviceIds");
    db.transaction((tx) => {
      replaceLinks(tx, id, itemIds, serviceIds);
      tx.update(schema.manuals)
        .set({ updatedBy: loginOf(c), updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.manuals.id, id))
        .run();
    });
    return c.json({ success: true, data: loadManual(id) });
  } catch (error) {
    return handleError(c, error, "zapisu powiązań manuala");
  }
});

/**
 * PUT /:id/sections — zastępuje CAŁĄ strukturę punktów i przypisanie załączników.
 * Body: `{ sections: SectionInput[] }`. Odpowiedź: `{ manual, keyMap }`, gdzie keyMap
 * mapuje `key` z wejścia na nadane id — front potrzebuje go, żeby dograć pliki
 * do świeżo utworzonych punktów (POST /:id/attachments?sectionId=…).
 */
app.put("/:id/sections", async (c) => {
  try {
    const id = idParam(c, "id");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "Nieprawidłowe dane");
    const row = getManualRow(id);
    if (!row) throw new ApiError(404, "Manual nie istnieje");
    const flat = parseSections(body.sections);

    const keyMap = db.transaction((tx) => {
      const map = replaceSections(tx, id, flat);
      tx.update(schema.manuals)
        .set({ updatedBy: loginOf(c), updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.manuals.id, id))
        .run();
      return map;
    });

    logActivity(db, {
      entityType: ENTITY,
      entityId: id,
      user: getUser(c),
      action: "updated",
      field: "sections",
      newValue: true,
      summary: `Zmieniono punkty manuala: ${row.title}`,
    });
    return c.json({ success: true, data: { manual: loadManual(id), keyMap } });
  } catch (error) {
    return handleError(c, error, "zapisu punktów manuala");
  }
});

/** POST /:id/attachments — dokłada pliki; łącznie na manual nie więcej niż ATTACHMENT_MAX_FILES. */
app.post("/:id/attachments", async (c) => {
  try {
    const id = idParam(c, "id");
    const { form, files } = await readFiles(c);
    if (!getManualRow(id)) throw new ApiError(404, "Manual nie istnieje");
    if (files.length === 0) throw new ApiError(400, "Nie wybrano plików");

    // Opcjonalny punkt docelowy — musi należeć do TEGO manuala.
    const sectionRaw = form.get("sectionId");
    let sectionId: number | null = null;
    if (typeof sectionRaw === "string" && sectionRaw.trim()) {
      const n = Number(sectionRaw);
      if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, "Nieprawidłowe sectionId");
      const section = db
        .select({ id: schema.manualSections.id })
        .from(schema.manualSections)
        .where(and(eq(schema.manualSections.id, n), eq(schema.manualSections.manualId, id)))
        .get();
      if (!section) throw new ApiError(400, `Punkt ${n} nie należy do tego manuala`);
      sectionId = n;
    }

    const existing = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.manualAttachments)
      .where(eq(schema.manualAttachments.manualId, id))
      .get();
    const already = existing?.n ?? 0;
    if (already + files.length > ATTACHMENT_MAX_FILES) {
      throw new ApiError(400, `Maksymalnie ${ATTACHMENT_MAX_FILES} plików na manual (jest już ${already})`);
    }
    // Nowe pliki lądują na końcu punktu (albo na końcu „pozostałych" plików).
    const maxPos = db
      .select({ m: sql<number | null>`max(${schema.manualAttachments.position})` })
      .from(schema.manualAttachments)
      .where(
        and(
          eq(schema.manualAttachments.manualId, id),
          sectionId === null
            ? sql`${schema.manualAttachments.sectionId} is null`
            : eq(schema.manualAttachments.sectionId, sectionId)
        )
      )
      .get();
    let position = (maxPos?.m ?? -1) + 1;

    const stored = await storeUploads(scopeOf(id), files);
    try {
      db.transaction((tx) => {
        for (const s of stored)
          tx.insert(schema.manualAttachments).values({ manualId: id, sectionId, position: position++, ...s }).run();
        tx.update(schema.manuals)
          .set({ updatedBy: loginOf(c), updatedAt: sql`(datetime('now'))` })
          .where(eq(schema.manuals.id, id))
          .run();
      });
    } catch (error) {
      removeStoredFiles(stored);
      throw error;
    }
    return c.json({ success: true, data: loadManual(id) });
  } catch (error) {
    return handleError(c, error, "dodawania załączników");
  }
});

/** DELETE /:id — twarde usunięcie (wiersze kaskadą) + rm -r katalogu załączników. */
app.delete("/:id", (c) => {
  try {
    const id = idParam(c, "id");
    const row = getManualRow(id);
    if (!row) throw new ApiError(404, "Manual nie istnieje");
    db.delete(schema.manuals).where(eq(schema.manuals.id, id)).run();
    // Katalog kasujemy PO usunięciu wierszy — nieudane usunięcie nie zabiera plików.
    removeAttachmentDir(scopeOf(id));
    logActivity(db, {
      entityType: ENTITY,
      entityId: id,
      user: getUser(c),
      action: "deleted",
      summary: `Usunięto manual: ${row.title}`,
    });
    return c.json({ success: true, data: { id } });
  } catch (error) {
    return handleError(c, error, "usuwania manuala");
  }
});

export default app;
