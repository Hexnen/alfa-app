/**
 * Test modułu Manuale (/api/manuals) — przez trasy Hono (app.request) z podstawionym
 * userem i strażnikiem uprawnień w kontekście, na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-manuals.ts
 *
 * Sprawdza: POST multipart (obrazek → WebP, PDF bez zmian, powiązania z towarem i usługą),
 * GET / z filtrami q / itemId / serviceId i sortowaniem, GET /:id, PUT /:id, PUT /:id/links
 * (zastąpienie zbioru + walidacja istnienia towarów i usług), POST /:id/attachments z limitem
 * 15 plików na manual, GET /attachments/:id (nagłówki, ?download=1, treść), DELETE załącznika,
 * DELETE manuala (kaskada FK + rm -r katalogu), pickery /pick/items i /pick/services oraz
 * strażnika uprawnień (brak klucza → 403, "view" → GET 200 / POST 403).
 * Pliki lądują w <katalog bazy>/attachments/manuals/<id> — na kopii to katalog tymczasowy.
 * Sprząta po sobie HARD (manuale + fikstury magazynu/usług + activity_log + katalogi), także przy błędzie.
 */
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import manualsRoutes from "../src/routes/manuals.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import { ATTACHMENTS_DIR, removeAttachmentDir, resolveStoredPath } from "../src/lib/calendar-attachments.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const PREFIX = "__MANUAL_TEST__";

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const plain = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !plain) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");

/** Ten sam użytkownik z podmienioną mapą uprawnień (guard czyta tylko role + permissions). */
function withPerms(user: User, permissions: Record<string, "view" | "edit"> | null): User {
  return { ...user, role: "user", permissions: permissions ? JSON.stringify(permissions) : null };
}

function cleanup(): number {
  const ids = db
    .select({ id: schema.manuals.id })
    .from(schema.manuals)
    .where(like(schema.manuals.title, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  for (const id of ids) removeAttachmentDir(`manuals/${id}`);
  if (ids.length) {
    db.delete(schema.manuals).where(inArray(schema.manuals.id, ids)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "manual"), inArray(schema.activityLog.entityId, ids)))
      .run();
  }
  db.delete(schema.warehouseItems).where(like(schema.warehouseItems.name, `${PREFIX}%`)).run();
  db.delete(schema.services).where(like(schema.services.name, `${PREFIX}%`)).run();
  return ids.length;
}
cleanup();

/** Aplikacja testowa: strażnik zakładek + router manuali (jak w src/routes/index.ts). */
function appFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/manuals", manualsRoutes);
  return app;
}
const asAdmin = appFor(admin);
const asEditor = appFor(withPerms(plain, { "technical/manuale": "edit" }));
const asViewer = appFor(withPerms(plain, { "technical/manuale": "view" }));
const asStranger = appFor(withPerms(plain, { "technical/magazyn": "edit" }));

type AttJson = {
  id: number;
  fileName: string;
  mime: string;
  size: number;
  kind: string;
  width: number | null;
  height: number | null;
  url: string;
  downloadUrl: string;
  createdAt: string;
  sectionId: number | null;
  position: number;
};
type LinkJson = { id: number; kind: "item" | "service"; refId: number; name: string; meta: string | null };
type SectionJson = {
  id: number;
  parentId: number | null;
  position: number;
  title: string | null;
  body: string | null;
  attachments: AttJson[];
  children: SectionJson[];
};
type ManualJson = {
  id: number;
  title: string;
  description: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  attachmentsCount: number;
  attachments: AttJson[];
  links: LinkJson[];
  sections: SectionJson[];
  unassignedAttachments: AttJson[];
};
type SectionsResp = { manual: ManualJson; keyMap: Record<string, number> };
type Resp<T> = { success: boolean; data?: T; error?: string };

function multipart(fields: Record<string, string>, files: { name: string; type: string; data: Buffer }[]): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const f of files) fd.append("files", new File([new Uint8Array(f.data)], f.name, { type: f.type }));
  return fd;
}
async function post<T>(app: Hono, path: string, body: FormData): Promise<{ status: number; json: Resp<T> }> {
  const res = await app.request(path, { method: "POST", body });
  return { status: res.status, json: (await res.json()) as Resp<T> };
}
async function putJson<T>(app: Hono, path: string, body: unknown): Promise<{ status: number; json: Resp<T> }> {
  const res = await app.request(path, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return { status: res.status, json: (await res.json()) as Resp<T> };
}
async function get<T>(app: Hono, path: string): Promise<{ status: number; json: Resp<T> }> {
  const res = await app.request(path);
  return { status: res.status, json: (await res.json()) as Resp<T> };
}
const putSections = (app: Hono, manualId: number, body: unknown) =>
  putJson<SectionsResp>(app, `/manuals/${manualId}/sections`, body);
const storedPathOf = (attId: number) =>
  db.select().from(schema.manualAttachments).where(eq(schema.manualAttachments.id, attId)).get()?.storedPath ?? null;
const fileExists = (attId: number) => {
  const p = storedPathOf(attId);
  const abs = p ? resolveStoredPath(p) : null;
  return !!abs && existsSync(abs);
};

// --- fikstury: towar magazynowy (+ jeden zarchiwizowany) i usługa ---
const item = db
  .insert(schema.warehouseItems)
  .values({ name: `${PREFIX} Kamera IP 4MP`, sku: `${PREFIX}-SKU-1`, manufacturer: "Dahua", category: "Kamery", unit: "szt" })
  .returning()
  .get();
const itemArchived = db
  .insert(schema.warehouseItems)
  .values({ name: `${PREFIX} Kamera archiwalna`, sku: `${PREFIX}-SKU-2`, isArchived: true })
  .returning()
  .get();
const service = db
  .insert(schema.services)
  .values({ name: `${PREFIX} Montaż kamery`, category: "montaz", unit: "szt" })
  .returning()
  .get();
const serviceInactive = db
  .insert(schema.services)
  .values({ name: `${PREFIX} Usługa wycofana`, active: false })
  .returning()
  .get();

const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 10, g: 90, b: 200 } } })
  .png()
  .toBuffer();
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);

try {
  // ---------------------------------------------------------------- POST /
  const r1 = await post<ManualJson>(
    asEditor,
    "/manuals",
    multipart(
      {
        title: `${PREFIX} Instrukcja kamery`,
        description: "Konfiguracja i montaż",
        itemIds: JSON.stringify([item.id]),
        serviceIds: JSON.stringify([service.id]),
      },
      [
        { name: "schemat.PNG", type: "image/png", data: png },
        { name: "instrukcja.pdf", type: "application/octet-stream", data: pdf },
      ]
    )
  );
  const m1 = r1.json.data!;
  ok("POST / → 201, tytuł/opis/autor zapisane", r1.status === 201 && m1?.title === `${PREFIX} Instrukcja kamery` && m1.description === "Konfiguracja i montaż" && !!m1.createdBy, r1.json);
  const img = m1?.attachments?.find((a) => a.kind === "image");
  const doc = m1?.attachments?.find((a) => a.kind === "file");
  ok("POST /: obrazek → WebP 2560×1280, nazwa .webp", img?.mime === "image/webp" && img.fileName === "schemat.webp" && img.width === 2560 && img.height === 1280, img);
  ok("POST /: PDF bez zmian (mime z rozszerzenia, surowy rozmiar)", doc?.mime === "application/pdf" && doc.size === pdf.length && doc.fileName === "instrukcja.pdf", doc);
  ok("POST /: attachmentsCount = 2, url/downloadUrl pod /api/manuals/attachments", m1?.attachmentsCount === 2 && img?.url === `/api/manuals/attachments/${img.id}` && img.downloadUrl === `/api/manuals/attachments/${img.id}?download=1`, { count: m1?.attachmentsCount, url: img?.url });
  ok("POST /: pliki na dysku w katalogu manuals/<id>/", !!img && fileExists(img.id) && (storedPathOf(img.id) ?? "").startsWith(`manuals/${m1.id}/`), storedPathOf(img?.id ?? 0));
  const linkItem = m1?.links?.find((l) => l.kind === "item");
  const linkService = m1?.links?.find((l) => l.kind === "service");
  ok("POST /: powiązanie z towarem (nazwa + meta sku · producent)", linkItem?.refId === item.id && linkItem.name === item.name && linkItem.meta === `${PREFIX}-SKU-1 · Dahua`, linkItem);
  ok("POST /: powiązanie z usługą (nazwa + meta kategoria · jednostka)", linkService?.refId === service.id && linkService.name === service.name && linkService.meta === "montaz · szt", linkService);
  const log1 = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "manual"), eq(schema.activityLog.entityId, m1.id)))
    .all();
  ok("activity_log: wpis created", log1.some((l) => l.action === "created" && (l.summary ?? "").includes(PREFIX)), log1.map((l) => l.summary));

  // Drugi manual — bez plików i bez powiązań (do filtrów i sortowania).
  const r2 = await post<ManualJson>(asEditor, "/manuals", multipart({ title: `${PREFIX} Aaa notatka serwisowa` }, []));
  const m2 = r2.json.data!;
  ok("POST / bez plików i powiązań → 201, puste tablice", r2.status === 201 && m2?.attachments.length === 0 && m2.links.length === 0 && m2.description === null, r2.json);

  const rNoTitle = await post<ManualJson>(asEditor, "/manuals", multipart({ description: "bez tytułu" }, []));
  ok("POST / bez tytułu → 400", rNoTitle.status === 400 && rNoTitle.json.error === "Tytuł manuala jest wymagany", rNoTitle.json);
  const rBadItem = await post<ManualJson>(asEditor, "/manuals", multipart({ title: `${PREFIX} zły link`, itemIds: JSON.stringify([99999999]) }, []));
  ok("POST / z nieistniejącym towarem → 400, manual nie powstaje", rBadItem.status === 400 && /Nie ma takich towarów/.test(rBadItem.json.error ?? ""), rBadItem.json);
  const rBigFile = await post<ManualJson>(asEditor, "/manuals", multipart({ title: `${PREFIX} za duży` }, [{ name: "duzy.pdf", type: "application/pdf", data: big }]));
  ok(">5 MB → 400 i brak osieroconego manuala", rBigFile.status === 400 && rBigFile.json.error === "Plik duzy.pdf przekracza 5 MB" && !db.select().from(schema.manuals).where(eq(schema.manuals.title, `${PREFIX} za duży`)).get(), rBigFile.json);

  // ---------------------------------------------------------------- GET /
  const all = await get<ManualJson[]>(asEditor, `/manuals?q=${encodeURIComponent(PREFIX)}`);
  ok("GET /?q= → 2 manuale (domyślnie updatedAt desc)", all.status === 200 && all.json.data?.length === 2, all.json.data?.map((m) => m.title));
  const byTitle = await get<ManualJson[]>(asEditor, `/manuals?q=${encodeURIComponent(PREFIX)}&sort=title&dir=asc`);
  ok("GET /?sort=title&dir=asc → „Aaa…” pierwsze", byTitle.json.data?.[0]?.id === m2.id, byTitle.json.data?.map((m) => m.title));
  const byAtt = await get<ManualJson[]>(asEditor, `/manuals?q=${encodeURIComponent(PREFIX)}&sort=attachmentsCount&dir=desc`);
  ok("GET /?sort=attachmentsCount&dir=desc → manual z plikami pierwszy", byAtt.json.data?.[0]?.id === m1.id, byAtt.json.data?.map((m) => m.attachmentsCount));
  const qByItem = await get<ManualJson[]>(asEditor, `/manuals?q=${encodeURIComponent("Kamera IP 4MP")}`);
  ok("GET /?q= szuka też w nazwach powiązanych towarów", qByItem.json.data?.length === 1 && qByItem.json.data[0].id === m1.id, qByItem.json.data?.map((m) => m.title));
  const fItem = await get<ManualJson[]>(asEditor, `/manuals?itemId=${item.id}`);
  ok("GET /?itemId= → tylko manual powiązany z towarem", fItem.json.data?.length === 1 && fItem.json.data[0].id === m1.id, fItem.json.data?.map((m) => m.id));
  const fService = await get<ManualJson[]>(asEditor, `/manuals?serviceId=${service.id}`);
  ok("GET /?serviceId= → tylko manual powiązany z usługą", fService.json.data?.length === 1 && fService.json.data[0].id === m1.id, fService.json.data?.map((m) => m.id));
  const fNone = await get<ManualJson[]>(asEditor, `/manuals?itemId=${itemArchived.id}`);
  ok("GET /?itemId= bez powiązań → pusta lista", fNone.json.data?.length === 0, fNone.json.data);

  // ---------------------------------------------------------------- GET /:id
  const one = await get<ManualJson>(asEditor, `/manuals/${m1.id}`);
  ok("GET /:id → pełny manual", one.status === 200 && one.json.data?.id === m1.id && one.json.data.attachments.length === 2 && one.json.data.links.length === 2, one.json);
  const none = await get<ManualJson>(asEditor, "/manuals/99999999");
  ok("GET /:id nieistniejący → 404", none.status === 404, none.json);

  // ---------------------------------------------------------------- PUT /:id
  const upd = await putJson<ManualJson>(asEditor, `/manuals/${m1.id}`, { title: `${PREFIX} Instrukcja kamery v2`, description: "" });
  ok("PUT /:id → tytuł zmieniony, pusty opis → null, updatedBy ustawiony", upd.status === 200 && upd.json.data?.title === `${PREFIX} Instrukcja kamery v2` && upd.json.data.description === null && !!upd.json.data.updatedBy, upd.json);
  const updBad = await putJson<ManualJson>(asEditor, `/manuals/${m1.id}`, { title: "   " });
  ok("PUT /:id z pustym tytułem → 400", updBad.status === 400, updBad.json);
  const updMissing = await putJson<ManualJson>(asEditor, "/manuals/99999999", { title: "x" });
  ok("PUT /:id nieistniejący → 404", updMissing.status === 404, updMissing.json);

  // ---------------------------------------------------------------- PUT /:id/links
  const links1 = await putJson<ManualJson>(asEditor, `/manuals/${m1.id}/links`, { itemIds: [], serviceIds: [service.id, serviceInactive.id] });
  ok("PUT /links zastępuje cały zbiór (towar znika, dwie usługi)", links1.status === 200 && links1.json.data?.links.length === 2 && links1.json.data.links.every((l) => l.kind === "service"), links1.json.data?.links);
  const links2 = await putJson<ManualJson>(asEditor, `/manuals/${m1.id}/links`, { itemIds: [item.id, item.id], serviceIds: [] });
  ok("PUT /links: duplikaty scalane, zostaje jedno powiązanie z towarem", links2.json.data?.links.length === 1 && links2.json.data.links[0].kind === "item", links2.json.data?.links);
  const links3 = await putJson<ManualJson>(asEditor, `/manuals/${m1.id}/links`, { itemIds: [99999999], serviceIds: [] });
  ok("PUT /links z nieistniejącym towarem → 400, stary zbiór nietknięty", links3.status === 400 && (await get<ManualJson>(asEditor, `/manuals/${m1.id}`)).json.data?.links.length === 1, links3.json);
  const links4 = await putJson<ManualJson>(asEditor, `/manuals/${m1.id}/links`, { itemIds: [], serviceIds: [99999999] });
  ok("PUT /links z nieistniejącą usługą → 400", links4.status === 400 && /Nie ma takich usług/.test(links4.json.error ?? ""), links4.json);
  const links5 = await putJson<ManualJson>(asEditor, `/manuals/${m1.id}/links`, { itemIds: "nie-tablica", serviceIds: [] });
  ok("PUT /links z niepoprawną tablicą → 400", links5.status === 400, links5.json);

  // ---------------------------------------------------- POST /:id/attachments
  const add = await post<ManualJson>(asEditor, `/manuals/${m2.id}/attachments`, multipart({}, [{ name: "opis.txt", type: "text/plain", data: Buffer.from("abc") }]));
  ok("POST /:id/attachments → 200, manual z 1 załącznikiem", add.status === 200 && add.json.data?.attachmentsCount === 1 && add.json.data.attachments[0].fileName === "opis.txt", add.json);
  const addEmpty = await post<ManualJson>(asEditor, `/manuals/${m2.id}/attachments`, multipart({}, []));
  ok("POST /:id/attachments bez plików → 400", addEmpty.status === 400, addEmpty.json);
  const fill = await post<ManualJson>(
    asEditor,
    `/manuals/${m2.id}/attachments`,
    multipart({}, Array.from({ length: 14 }, (_, i) => ({ name: `p${i}.txt`, type: "text/plain", data: Buffer.from("a") })))
  );
  ok("POST /:id/attachments do 15 plików → 200", fill.status === 200 && fill.json.data?.attachmentsCount === 15, fill.json.data?.attachmentsCount);
  const over = await post<ManualJson>(asEditor, `/manuals/${m2.id}/attachments`, multipart({}, [{ name: "za-duzo.txt", type: "text/plain", data: Buffer.from("a") }]));
  ok("POST /:id/attachments ponad 15 → 400 i nic nie dochodzi", over.status === 400 && /Maksymalnie 15 plików na manual/.test(over.json.error ?? "") && (await get<ManualJson>(asEditor, `/manuals/${m2.id}`)).json.data?.attachmentsCount === 15, over.json);
  const addMissing = await post<ManualJson>(asEditor, "/manuals/99999999/attachments", multipart({}, [{ name: "x.txt", type: "text/plain", data: Buffer.from("a") }]));
  ok("POST /:id/attachments dla nieistniejącego manuala → 404 (bez katalogu na dysku)", addMissing.status === 404 && !existsSync(join(ATTACHMENTS_DIR, "manuals", "99999999")), addMissing.json);

  // ------------------------------------------------- GET/DELETE /attachments
  const fImg = await asEditor.request(`/manuals/attachments/${img!.id}`);
  const bodyImg = Buffer.from(await fImg.arrayBuffer());
  ok("GET /attachments/:id → 200, image/webp, nosniff, inline", fImg.status === 200 && fImg.headers.get("content-type") === "image/webp" && fImg.headers.get("x-content-type-options") === "nosniff" && /^inline;/.test(fImg.headers.get("content-disposition") ?? ""), Object.fromEntries(fImg.headers));
  ok("GET /attachments/:id → treść to WebP o rozmiarze = size", bodyImg.length === img!.size && bodyImg.subarray(8, 12).toString() === "WEBP", { len: bodyImg.length, size: img!.size });
  const fDoc = await asEditor.request(`/manuals/attachments/${doc!.id}?download=1`);
  ok("GET /attachments/:id?download=1 → attachment + bajty PDF bez zmian", fDoc.status === 200 && /^attachment;/.test(fDoc.headers.get("content-disposition") ?? "") && Buffer.from(await fDoc.arrayBuffer()).equals(pdf), fDoc.headers.get("content-disposition"));
  const fMissing = await asEditor.request("/manuals/attachments/99999999");
  ok("GET /attachments nieistniejący → 404", fMissing.status === 404);
  const fBad = await asEditor.request("/manuals/attachments/abc");
  ok("GET /attachments złe id → 400", fBad.status === 400);

  const del = await asEditor.request(`/manuals/attachments/${doc!.id}`, { method: "DELETE" });
  const delJson = (await del.json()) as Resp<{ id: number; manualId: number }>;
  ok("DELETE /attachments/:id → 200, wiersz i plik znikają", del.status === 200 && delJson.data?.manualId === m1.id && storedPathOf(doc!.id) === null && (await get<ManualJson>(asEditor, `/manuals/${m1.id}`)).json.data?.attachmentsCount === 1, delJson);
  const delAgain = await asEditor.request(`/manuals/attachments/${doc!.id}`, { method: "DELETE" });
  ok("DELETE /attachments już usuniętego → 404", delAgain.status === 404);

  // ---------------------------------------------------------------- pickery
  const pickItems = await get<{ id: number; name: string; sku: string | null; manufacturer: string | null; category: string | null }[]>(asEditor, `/manuals/pick/items?q=${encodeURIComponent("Kamera")}`);
  const pickedIds = pickItems.json.data?.map((i) => i.id) ?? [];
  ok("GET /pick/items?q= → towar znaleziony, zarchiwizowany pominięty", pickItems.status === 200 && pickedIds.includes(item.id) && !pickedIds.includes(itemArchived.id), pickItems.json.data);
  const pickShape = pickItems.json.data?.find((i) => i.id === item.id);
  ok("GET /pick/items: kształt { id, name, sku, manufacturer, category }", !!pickShape && Object.keys(pickShape).sort().join() === "category,id,manufacturer,name,sku", pickShape);
  const pickServices = await get<{ id: number; name: string; category: string; unit: string }[]>(asEditor, `/manuals/pick/services?q=${encodeURIComponent("Montaż kamery")}`);
  const pickedSvc = pickServices.json.data ?? [];
  ok("GET /pick/services?q= → aktywna usługa, nieaktywna pominięta", pickServices.status === 200 && pickedSvc.some((s) => s.id === service.id) && !pickedSvc.some((s) => s.id === serviceInactive.id), pickedSvc);
  ok("GET /pick/services: kształt { id, name, category, unit }", Object.keys(pickedSvc.find((s) => s.id === service.id) ?? {}).sort().join() === "category,id,name,unit", pickedSvc[0]);
  const pickLimit = await get<unknown[]>(asEditor, "/manuals/pick/items");
  ok("GET /pick/items bez q → maks. 30 pozycji", (pickLimit.json.data?.length ?? 0) <= 30, pickLimit.json.data?.length);

  // --------------------------------------------------- PUT /:id/sections
  // Osobny manual na testy struktury: 3 pliki „luzem", żeby było co przypisywać.
  const r3 = await post<ManualJson>(
    asEditor,
    "/manuals",
    multipart({ title: `${PREFIX} Zzz manual z punktami` }, [
      { name: "a.txt", type: "text/plain", data: Buffer.from("a") },
      { name: "b.txt", type: "text/plain", data: Buffer.from("b") },
      { name: "c.txt", type: "text/plain", data: Buffer.from("c") },
    ])
  );
  const m3 = r3.json.data!;
  const [a1, a2, a3] = m3.attachments;
  ok(
    "nowy manual: sections puste, wszystkie pliki w unassignedAttachments (sectionId null)",
    r3.status === 201 && m3.sections.length === 0 && m3.unassignedAttachments.length === 3 && m3.attachments.every((a) => a.sectionId === null),
    { sections: m3.sections, unassigned: m3.unassignedAttachments.length }
  );

  // 1) insert: dwa punkty, jeden z podpunktem, pliki przypisane w zadanej kolejności
  const s1 = await putSections(asEditor, m3.id, {
    sections: [
      {
        key: "k1",
        title: "Montaż",
        body: "Przykręcić uchwyt\ndo słupa",
        attachmentIds: [a2.id, a1.id],
        children: [{ key: "k1a", title: "Kotwy", body: "M10" }],
      },
      { key: "k2", title: "Konfiguracja" },
    ],
  });
  const km1 = s1.json.data?.keyMap ?? {};
  const idK1 = km1.k1, idK1a = km1.k1a, idK2 = km1.k2;
  ok(
    "PUT /sections insert → 200, keyMap ma wszystkie klucze (też podpunktu)",
    s1.status === 200 && Object.keys(km1).sort().join() === "k1,k1a,k2" && [idK1, idK1a, idK2].every((v) => Number.isInteger(v)),
    s1.json
  );
  const sec1 = s1.json.data?.manual.sections ?? [];
  ok(
    "PUT /sections: 2 punkty poziomu 1, position 0/1, parentId null",
    sec1.length === 2 && sec1[0].id === idK1 && sec1[0].position === 0 && sec1[0].parentId === null && sec1[1].id === idK2 && sec1[1].position === 1,
    sec1.map((s) => ({ id: s.id, pos: s.position, parent: s.parentId }))
  );
  ok(
    "PUT /sections: tytuł i wielolinijkowy tekst zapisane, podpunkt w children z parentId",
    sec1[0]?.title === "Montaż" && sec1[0]?.body === "Przykręcić uchwyt\ndo słupa" && sec1[0]?.children.length === 1 && sec1[0].children[0].id === idK1a && sec1[0].children[0].parentId === idK1 && sec1[0].children[0].title === "Kotwy",
    sec1[0]
  );
  ok(
    "PUT /sections: attachmentIds → sectionId + position wg kolejności wejścia",
    sec1[0]?.attachments.map((a) => a.id).join() === `${a2.id},${a1.id}` && sec1[0].attachments[0].position === 0 && sec1[0].attachments[1].position === 1 && sec1[0].attachments.every((a) => a.sectionId === idK1),
    sec1[0]?.attachments.map((a) => ({ id: a.id, pos: a.position, sec: a.sectionId }))
  );
  ok(
    "PUT /sections: nieprzypisany plik zostaje w unassignedAttachments, attachments dalej płaskie (3)",
    s1.json.data?.manual.unassignedAttachments.map((a) => a.id).join() === String(a3.id) && s1.json.data?.manual.attachments.length === 3 && s1.json.data.manual.attachmentsCount === 3,
    s1.json.data?.manual.unassignedAttachments.map((a) => a.id)
  );
  const secLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "manual"), eq(schema.activityLog.entityId, m3.id)))
    .all();
  ok("activity_log: wpis updated z field=„sections”", secLog.some((l) => l.action === "updated" && l.field === "sections"), secLog.map((l) => l.field));

  const listed = await get<ManualJson[]>(asEditor, `/manuals?q=${encodeURIComponent("Zzz manual z punktami")}`);
  ok("GET / (lista) też zwraca sections i unassignedAttachments", listed.json.data?.[0]?.sections.length === 2 && listed.json.data[0].unassignedAttachments.length === 1, listed.json.data?.[0]?.sections.length);

  // 2) update + reorder + reparent (podpunkt awansowany na punkt), zmiana przypisania plików
  const s2 = await putSections(asEditor, m3.id, {
    sections: [
      { id: idK2, title: "Konfiguracja v2", body: "IP statyczne" },
      { id: idK1a, title: "Kotwy" },
      { id: idK1, title: "Montaż", attachmentIds: [a1.id] },
    ],
  });
  const sec2 = s2.json.data?.manual.sections ?? [];
  ok(
    "PUT /sections update+reorder: nowa kolejność, tytuł/tekst zmienione",
    s2.status === 200 && sec2.map((s) => s.id).join() === `${idK2},${idK1a},${idK1}` && sec2[0].title === "Konfiguracja v2" && sec2[0].body === "IP statyczne" && sec2.map((s) => s.position).join() === "0,1,2",
    sec2.map((s) => ({ id: s.id, t: s.title, pos: s.position }))
  );
  ok(
    "PUT /sections reparent: podpunkt na poziom 1 (parentId null, brak w children)",
    sec2[1]?.parentId === null && sec2[1]?.children.length === 0 && sec2.every((s) => s.children.length === 0),
    sec2.map((s) => ({ id: s.id, parent: s.parentId, kids: s.children.length }))
  );
  ok(
    "PUT /sections: plik wyrzucony z punktu wraca do „pozostałych”, reszta trzyma przypisanie",
    sec2[2]?.attachments.map((a) => a.id).join() === String(a1.id) && s2.json.data?.manual.unassignedAttachments.map((a) => a.id).sort((x, y) => x - y).join() === [a2.id, a3.id].sort((x, y) => x - y).join(),
    { wPunkcie: sec2[2]?.attachments.map((a) => a.id), luzem: s2.json.data?.manual.unassignedAttachments.map((a) => a.id) }
  );

  // 3) delete: punkty spoza wejścia znikają, ich pliki tylko tracą przypisanie
  const s3 = await putSections(asEditor, m3.id, { sections: [{ id: idK2, title: "Konfiguracja v2" }] });
  ok(
    "PUT /sections: punkty nieobecne w wejściu skasowane (zostaje 1)",
    s3.status === 200 && s3.json.data?.manual.sections.length === 1 && s3.json.data.manual.sections[0].id === idK2 && db.select().from(schema.manualSections).where(eq(schema.manualSections.manualId, m3.id)).all().length === 1,
    s3.json.data?.manual.sections.map((s) => s.id)
  );
  ok(
    "PUT /sections: pliki skasowanego punktu → sectionId NULL, pliki NIE kasowane",
    s3.json.data?.manual.attachmentsCount === 3 && s3.json.data.manual.unassignedAttachments.length === 3 && [a1.id, a2.id, a3.id].every((id) => fileExists(id)),
    s3.json.data?.manual.unassignedAttachments.map((a) => a.id)
  );

  // 4) walidacja
  const sDeep = await putSections(asEditor, m3.id, {
    sections: [{ title: "A", children: [{ title: "A.1", children: [{ title: "A.1.1" }] }] }],
  });
  ok("PUT /sections głębokość 3 → 400", sDeep.status === 400 && /maks\. 2 poziomy/.test(sDeep.json.error ?? ""), sDeep.json);
  const sNotArray = await putSections(asEditor, m3.id, { sections: "nie-tablica" });
  ok("PUT /sections bez tablicy → 400", sNotArray.status === 400, sNotArray.json);
  const sForeignAtt = await putSections(asEditor, m3.id, { sections: [{ title: "X", attachmentIds: [img!.id] }] });
  ok(
    "PUT /sections z załącznikiem innego manuala → 400, struktura nietknięta",
    sForeignAtt.status === 400 && /nie należy do tego manuala/.test(sForeignAtt.json.error ?? "") && (await get<ManualJson>(asEditor, `/manuals/${m3.id}`)).json.data?.sections.length === 1,
    sForeignAtt.json
  );
  // punkt należący do INNEGO manuala (założony na m2) nie może wjechać do m3
  const sOther = await putSections(asEditor, m2.id, { sections: [{ key: "obcy", title: "Punkt m2" }] });
  const idObcy = sOther.json.data?.keyMap.obcy ?? 0;
  const sForeignSection = await putSections(asEditor, m3.id, { sections: [{ id: idObcy, title: "kradzież" }] });
  ok(
    "PUT /sections z punktem innego manuala → 400",
    sForeignSection.status === 400 && /nie należy do tego manuala/.test(sForeignSection.json.error ?? ""),
    sForeignSection.json
  );
  const sDupAtt = await putSections(asEditor, m3.id, {
    sections: [{ title: "A", attachmentIds: [a1.id] }, { title: "B", attachmentIds: [a1.id] }],
  });
  ok("PUT /sections: ten sam plik w dwóch punktach → 400", sDupAtt.status === 400 && /dwóch punktów/.test(sDupAtt.json.error ?? ""), sDupAtt.json);
  const sMissing = await putSections(asEditor, 99999999, { sections: [] });
  ok("PUT /sections nieistniejącego manuala → 404", sMissing.status === 404, sMissing.json);

  // 5) upload plików prosto do punktu
  const upSec = await post<ManualJson>(
    asEditor,
    `/manuals/${m3.id}/attachments`,
    multipart({ sectionId: String(idK2) }, [{ name: "d.txt", type: "text/plain", data: Buffer.from("d") }])
  );
  const newAtt = upSec.json.data?.attachments.find((a) => a.fileName === "d.txt");
  ok(
    "POST /:id/attachments z sectionId → plik w punkcie (position 0, bo punkt był pusty)",
    upSec.status === 200 && newAtt?.sectionId === idK2 && newAtt.position === 0 && upSec.json.data?.sections[0].attachments.map((a) => a.id).join() === String(newAtt?.id),
    { att: newAtt, wPunkcie: upSec.json.data?.sections[0].attachments.map((a) => a.id) }
  );
  const upSec2 = await post<ManualJson>(
    asEditor,
    `/manuals/${m3.id}/attachments`,
    multipart({ sectionId: String(idK2) }, [{ name: "e.txt", type: "text/plain", data: Buffer.from("e") }])
  );
  const newAtt2 = upSec2.json.data?.attachments.find((a) => a.fileName === "e.txt");
  ok(
    "POST /:id/attachments z sectionId: kolejny plik na koniec punktu (position = max+1)",
    newAtt2?.position === 1 && upSec2.json.data?.sections[0].attachments.map((a) => a.id).join() === `${newAtt?.id},${newAtt2?.id}`,
    upSec2.json.data?.sections[0].attachments.map((a) => ({ id: a.id, pos: a.position }))
  );
  const upNoSec = await post<ManualJson>(asEditor, `/manuals/${m3.id}/attachments`, multipart({}, [{ name: "f.txt", type: "text/plain", data: Buffer.from("f") }]));
  ok(
    "POST /:id/attachments bez sectionId → dalej „luzem” (sectionId null)",
    upNoSec.json.data?.attachments.find((a) => a.fileName === "f.txt")?.sectionId === null,
    upNoSec.json.data?.attachments.find((a) => a.fileName === "f.txt")
  );
  const upBadSec = await post<ManualJson>(asEditor, `/manuals/${m3.id}/attachments`, multipart({ sectionId: String(idObcy) }, [{ name: "g.txt", type: "text/plain", data: Buffer.from("g") }]));
  ok(
    "POST /:id/attachments z punktem innego manuala → 400, plik nie dochodzi",
    upBadSec.status === 400 && !(await get<ManualJson>(asEditor, `/manuals/${m3.id}`)).json.data?.attachments.some((a) => a.fileName === "g.txt"),
    upBadSec.json
  );
  const upNoSuchSec = await post<ManualJson>(asEditor, `/manuals/${m3.id}/attachments`, multipart({ sectionId: "99999999" }, [{ name: "h.txt", type: "text/plain", data: Buffer.from("h") }]));
  ok("POST /:id/attachments z nieistniejącym sectionId → 400", upNoSuchSec.status === 400, upNoSuchSec.json);

  // 6) kaskada przy DELETE manuala — punkty znikają razem z nim
  const m3Sections = db.select({ id: schema.manualSections.id }).from(schema.manualSections).where(eq(schema.manualSections.manualId, m3.id)).all().map((r) => r.id);
  const d3 = await asEditor.request(`/manuals/${m3.id}`, { method: "DELETE" });
  ok(
    "DELETE /:id: punkty manuala znikają kaskadą",
    d3.status === 200 && m3Sections.length > 0 && db.select().from(schema.manualSections).where(inArray(schema.manualSections.id, m3Sections)).all().length === 0,
    m3Sections
  );

  // ------------------------------------------------------------ uprawnienia
  const gStranger = await get<ManualJson[]>(asStranger, "/manuals");
  ok("bez klucza technical/manuale: GET → 403", gStranger.status === 403 && gStranger.json.error === "Brak dostępu do tej sekcji", gStranger.json);
  const pStranger = await post<ManualJson>(asStranger, "/manuals", multipart({ title: `${PREFIX} nie wolno` }, []));
  ok("bez klucza: POST → 403", pStranger.status === 403, pStranger.json);
  const gViewer = await get<ManualJson[]>(asViewer, "/manuals");
  ok("„view”: GET → 200", gViewer.status === 200 && Array.isArray(gViewer.json.data), gViewer.json);
  const gViewerFile = await asViewer.request(`/manuals/attachments/${img!.id}`);
  ok("„view”: GET załącznika → 200 (podgląd i pobieranie wolno)", gViewerFile.status === 200);
  const pViewer = await post<ManualJson>(asViewer, "/manuals", multipart({ title: `${PREFIX} nie wolno` }, []));
  ok("„view”: POST → 403 („tryb tylko do odczytu”)", pViewer.status === 403 && /tylko do odczytu/.test(pViewer.json.error ?? ""), pViewer.json);
  const uViewer = await putJson<ManualJson>(asViewer, `/manuals/${m1.id}`, { title: "x" });
  ok("„view”: PUT → 403", uViewer.status === 403, uViewer.json);
  const sViewer = await putSections(asViewer, m1.id, { sections: [] });
  ok("„view”: PUT /sections → 403", sViewer.status === 403, sViewer.json);
  const dViewer = await asViewer.request(`/manuals/${m1.id}`, { method: "DELETE" });
  ok("„view”: DELETE → 403", dViewer.status === 403);
  ok("„view”: manual nadal istnieje", !!db.select().from(schema.manuals).where(eq(schema.manuals.id, m1.id)).get());

  // ---------------------------------------------------------- DELETE /:id
  const attIds = db.select({ id: schema.manualAttachments.id }).from(schema.manualAttachments).where(eq(schema.manualAttachments.manualId, m1.id)).all().map((r) => r.id);
  const dir1 = join(ATTACHMENTS_DIR, "manuals", String(m1.id));
  ok("przed DELETE: katalog manuala istnieje", existsSync(dir1));
  const d1 = await asEditor.request(`/manuals/${m1.id}`, { method: "DELETE" });
  ok("DELETE /:id → 200", d1.status === 200, await d1.json());
  ok("DELETE /:id: wiersz, załączniki (kaskada FK) i powiązania znikają", !db.select().from(schema.manuals).where(eq(schema.manuals.id, m1.id)).get() && attIds.every((id) => storedPathOf(id) === null) && db.select().from(schema.manualLinks).where(eq(schema.manualLinks.manualId, m1.id)).all().length === 0);
  ok("DELETE /:id: katalog załączników skasowany (rm -r)", !existsSync(dir1));
  const d2 = await asEditor.request(`/manuals/${m1.id}`, { method: "DELETE" });
  ok("DELETE /:id już usuniętego → 404", d2.status === 404);
  ok("DELETE /:id: wpis „deleted” w activity_log", db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityType, "manual"), eq(schema.activityLog.entityId, m1.id))).all().some((l) => l.action === "deleted"));
  ok("resolveStoredPath: path traversal → null", resolveStoredPath("../alfa.db") === null && resolveStoredPath("/etc/passwd") === null && resolveStoredPath(`manuals/${m2.id}/x.webp`) !== null);
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} manuali testowych)`);
}
console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
