/**
 * Metadane zdjęć przy załącznikach notatek (migracja 0113) — przez trasy Hono
 * (`app.request`) z podstawionym userem, na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-photo-meta.ts
 *   npx tsx scripts/test-photo-meta.ts          # na data/alfa.db (sprząta po sobie)
 *
 * Co jest tu pilnowane:
 *   • JPEG z EXIF-em BEZ pola `photoMeta` → kolumny wypełnia SERWER
 *     (`takenAtSource: "exif"`), a plik na dysku zostaje BEZ EXIF-u,
 *   • JPEG bez EXIF-u + `photoMeta` z frontu → kolumny z klienta (tak działa
 *     panel technika: canvas zjada EXIF jeszcze na telefonie),
 *   • oba źródła naraz → serwer wygrywa POLE PO POLU, ale `orig.*` bierzemy
 *     od klienta (serwer widzi już plik po zmniejszeniu),
 *   • śmieci od klienta (zły JSON, zła długość tablicy, data z przyszłości,
 *     lat 123, „Null Island”) → upload PRZECHODZI, wadliwe pola są NULL-em,
 *   • brak metadanych z obu stron → `meta: null` (tak wygląda każdy załącznik
 *     sprzed tej zmiany), tak samo dla PDF-a,
 *   • panel technika i kalendarz biurowy zwracają IDENTYCZNY obiekt `meta`,
 *   • `meta_json` nie przekracza 8 KB.
 *
 * Sprząta po sobie HARD (wydarzenia, notatki, katalogi załączników, technicy,
 * konta, dziennik), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import sharp from "sharp";
import { db, schema } from "../src/db/index.js";
import calendarRoutes from "../src/routes/calendar.js";
import technikRoutes from "../src/routes/technik.js";
import { ATTACHMENTS_DIR, removeEventAttachmentDir, resolveStoredPath } from "../src/lib/calendar-attachments.js";
import { PHOTO_META_JSON_MAX_BYTES } from "../src/lib/photo-meta.js";
import { tabPermissionGuard, technikRoleGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const eq2 = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const PREFIX = "__PHOTOMETA_TEST__";

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): number {
  const ids = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  for (const id of ids) removeEventAttachmentDir(id);
  if (ids.length) {
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, ids)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, ids)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, ids)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, ids)).run();
  }
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
  return ids.length;
}
cleanup();

// ---------------------------------------------------------------------------
// Fikstury: konta, technik, wydarzenie z przypisaniem
// ---------------------------------------------------------------------------

function makeUser(suffix: string, role: string, permissions: PermissionMap = {}): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x", // konto nigdy się nie loguje — kontekst podstawiamy wprost
      displayName: `${PREFIX}${suffix}`,
      role,
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .get();
}

const office = makeUser("biuro", "admin");
const techUser = makeUser("tech", "technik");
const technician = db
  .insert(schema.technicians)
  .values({ firstName: "Adam", lastName: `${PREFIX}Adam`, type: "internal", active: true, userId: techUser.id })
  .returning()
  .get();

/** Kalendarz biurowy — kontekst jak po requireAuth (rola admin przechodzi wszędzie). */
function calendarAppFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.route("/calendar", calendarRoutes);
  return app;
}
/** Panel technika — z PRAWDZIWYMI strażnikami, tak jak w src/routes/index.ts. */
function panelAppFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", technikRoleGuard);
  app.use("*", tabPermissionGuard);
  app.route("/api/technik", technikRoutes);
  return app;
}
const asOffice = calendarAppFor(office);
const asTech = panelAppFor(techUser);

const ev = db
  .insert(schema.calendarEvents)
  .values({
    type: "serwis",
    title: `${PREFIX} Serwis`,
    startAt: "2026-09-16T09:00",
    endAt: "2026-09-16T11:00",
    allDay: false,
    status: "planned",
    department: "technical",
    createdBy: office.id,
    updatedBy: office.id,
  })
  .returning()
  .get();
db.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: technician.id }).run();

// ---------------------------------------------------------------------------
// Fikstury plikowe
// ---------------------------------------------------------------------------

/** JPEG z pełnym EXIF-em: data + strefa, GPS, aparat, obiektyw, a do tego MakerNote. */
const jpegWithExif = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 120, b: 60 } } })
  .withExif({
    IFD0: { Make: "AlfaPhone", Model: "AP-9", Software: "AlfaCam 2.0", Orientation: "1" },
    IFD2: {
      DateTimeOriginal: "2026:09:15 14:32:10",
      OffsetTimeOriginal: "+02:00",
      LensModel: "AlfaLens 26mm",
      ISOSpeedRatings: "400",
      FNumber: "18/10",
      ExposureTime: "1/250",
      FocalLength: "26/1",
      Flash: "16",
      // Binarne pole producenta NIE ma prawa wylądować w `meta_json`.
      MakerNote: "SEKRET-PRODUCENTA",
    },
    IFD3: {
      GPSLatitudeRef: "N",
      GPSLatitude: "52/1 24/1 1800/100", // 52.405
      GPSLongitudeRef: "E",
      GPSLongitude: "16/1 55/1 3000/100", // 16.925
      GPSAltitudeRef: "0",
      GPSAltitude: "85/1",
      GPSHPositioningError: "12/1",
    },
  })
  .jpeg()
  .toBuffer();

/** JPEG bez żadnych metadanych — tak wygląda zdjęcie po canvasie w panelu technika. */
const jpegBare = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 30, b: 30 } } })
  .jpeg()
  .toBuffer();

const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

/** Metadane, które front dokleja do zdjęcia z aparatu (kontrakt: pole `photoMeta`). */
const clientMeta = {
  takenAt: "2026-09-14T08:05:00",
  takenAtOffset: "+02:00",
  takenAtSource: "file" as const,
  capturedVia: "camera" as const,
  gps: { lat: 52.1, lng: 21.0, accuracyM: 8.5, altitudeM: 110 },
  camera: { make: "Samsung", model: "SM-S911B", lens: "Wide 24 mm" },
  orig: { width: 4000, height: 3000, size: 5_000_000, mime: "image/jpeg", name: "IMG_0001.jpg" },
  exif: { ISOSpeedRatings: 200, Software: "OneUI" },
};

type AttJson = {
  id: number;
  fileName: string;
  kind: string;
  url: string;
  meta: null | {
    takenAt: string | null;
    takenAtOffset: string | null;
    takenAtSource: string;
    capturedVia: string | null;
    gps: { lat: number; lng: number; accuracyM: number | null; altitudeM: number | null } | null;
    camera: { make: string | null; model: string | null; lens: string | null } | null;
    orig: { width: number | null; height: number | null; size: number | null; mime: string | null } | null;
    extra: Record<string, string | number | number[]> | null;
  };
};
type NoteJson = { id: number; text: string; attachments: AttJson[] };

function multipart(text: string, files: { name: string; type: string; data: Buffer }[], photoMeta?: string): FormData {
  const fd = new FormData();
  fd.set("text", text);
  for (const f of files) fd.append("files", new File([new Uint8Array(f.data)], f.name, { type: f.type }));
  if (photoMeta !== undefined) fd.set("photoMeta", photoMeta);
  return fd;
}

/** POST notatki do kalendarza biurowego; zwraca status + załączniki notatki. */
async function postOffice(body: FormData): Promise<{ status: number; atts: AttJson[]; json: unknown }> {
  const res = await asOffice.request(`/calendar/events/${ev.id}/notes`, { method: "POST", body });
  const json = (await res.json()) as { success: boolean; data?: NoteJson };
  return { status: res.status, atts: json.data?.attachments ?? [], json };
}
/** POST notatki z panelu technika (ta sama tabela, inny router i inne URL-e plików). */
async function postTech(body: FormData): Promise<{ status: number; atts: AttJson[]; json: unknown }> {
  const res = await asTech.request(`/api/technik/jobs/${ev.id}/notes`, { method: "POST", body });
  const json = (await res.json()) as { success: boolean; data?: NoteJson };
  return { status: res.status, atts: json.data?.attachments ?? [], json };
}

const rowOf = (attId: number) =>
  db.select().from(schema.calendarNoteAttachments).where(eq(schema.calendarNoteAttachments.id, attId)).get();

try {
  // -------------------------------------------------------------------------
  // (a) EXIF z pliku — serwer czyta go sam, bez pomocy frontu
  // -------------------------------------------------------------------------
  const a = await postOffice(multipart("Zdjęcie z serwisu", [{ name: "kamera.jpg", type: "image/jpeg", data: jpegWithExif }]));
  const mA = a.atts[0]?.meta;
  ok("(a) upload BEZ photoMeta → 201 i meta z serwera", a.status === 201 && !!mA, a.json);
  ok(
    "(a) data i strefa z EXIF-u, takenAtSource=exif, capturedVia=upload",
    mA?.takenAt === "2026-09-15T14:32:10" && mA?.takenAtOffset === "+02:00" && mA?.takenAtSource === "exif" && mA?.capturedVia === "upload",
    mA
  );
  ok(
    "(a) GPS ze stopni/minut/sekund na dziesiętne + dokładność i wysokość",
    eq2(mA?.gps, { lat: 52.405, lng: 16.925, accuracyM: 12, altitudeM: 85 }),
    mA?.gps
  );
  ok("(a) aparat i obiektyw z EXIF-u", eq2(mA?.camera, { make: "AlfaPhone", model: "AP-9", lens: "AlfaLens 26mm" }), mA?.camera);
  ok(
    "(a) orig = oryginał sprzed konwersji (800×600, JPEG)",
    eq2(mA?.orig, { width: 800, height: 600, size: jpegWithExif.length, mime: "image/jpeg" }),
    mA?.orig
  );
  ok("(a) extra ma ISO i przysłonę", mA?.extra?.ISOSpeedRatings === 400 && mA?.extra?.FNumber === 1.8, mA?.extra);
  ok("(a) extra BEZ MakerNote i innych binariów", !!mA?.extra && !("MakerNote" in mA.extra) && !("UserComment" in mA.extra), mA?.extra);
  const rowA = rowOf(a.atts[0].id);
  ok(
    "(a) kolumny w bazie wypełnione (taken_at, gps_lat, camera_model, meta_json)",
    rowA?.takenAt === "2026-09-15T14:32:10" && rowA?.gpsLat === 52.405 && rowA?.cameraModel === "AP-9" && !!rowA?.metaJson,
    rowA
  );
  // Sedno całej zmiany: metadane są w BAZIE, a plik na dysku dalej bez EXIF-u.
  const diskPath = resolveStoredPath(rowA!.storedPath)!;
  const diskMeta = await sharp(diskPath).metadata();
  ok(
    "(a) plik na dysku to WebP BEZ EXIF-u (metadane zostały tylko w bazie)",
    diskMeta.format === "webp" && !diskMeta.exif,
    { format: diskMeta.format, exif: !!diskMeta.exif }
  );

  // -------------------------------------------------------------------------
  // (b) tylko klient — zdjęcie po canvasie nie niesie już nic
  // -------------------------------------------------------------------------
  const b = await postOffice(
    multipart("Po canvasie", [{ name: "canvas.jpg", type: "image/jpeg", data: jpegBare }], JSON.stringify([clientMeta]))
  );
  const mB = b.atts[0]?.meta;
  ok("(b) JPEG bez EXIF-u + photoMeta → 201 i meta od klienta", b.status === 201 && !!mB, b.json);
  ok(
    "(b) data, strefa, źródło i sposób zrobienia zdjęcia od klienta",
    mB?.takenAt === "2026-09-14T08:05:00" && mB?.takenAtOffset === "+02:00" && mB?.takenAtSource === "file" && mB?.capturedVia === "camera",
    mB
  );
  ok("(b) GPS od klienta", eq2(mB?.gps, { lat: 52.1, lng: 21.0, accuracyM: 8.5, altitudeM: 110 }), mB?.gps);
  ok("(b) aparat od klienta", eq2(mB?.camera, { make: "Samsung", model: "SM-S911B", lens: "Wide 24 mm" }), mB?.camera);
  ok(
    "(b) orig sprzed canvasu (4000×3000), nie 640×480 z dysku",
    eq2(mB?.orig, { width: 4000, height: 3000, size: 5_000_000, mime: "image/jpeg" }),
    mB?.orig
  );
  ok("(b) extra od klienta", mB?.extra?.ISOSpeedRatings === 200 && mB?.extra?.Software === "OneUI", mB?.extra);

  // -------------------------------------------------------------------------
  // (c) oba źródła — serwer wygrywa pole po polu, `orig` zostaje klienta
  // -------------------------------------------------------------------------
  const c = await postOffice(
    multipart("Oryginał z telefonu", [{ name: "pelne.jpg", type: "image/jpeg", data: jpegWithExif }], JSON.stringify([clientMeta]))
  );
  const mC = c.atts[0]?.meta;
  ok(
    "(c) data, GPS i aparat z EXIF-u wygrywają z klientem",
    mC?.takenAt === "2026-09-15T14:32:10" &&
      mC?.takenAtSource === "exif" &&
      mC?.gps?.lat === 52.405 &&
      mC?.camera?.model === "AP-9",
    mC
  );
  ok("(c) capturedVia nadal od klienta (serwer nie wie, czy to aparat)", mC?.capturedVia === "camera", mC?.capturedVia);
  ok(
    "(c) orig od KLIENTA — serwer widzi już plik po zmniejszeniu",
    eq2(mC?.orig, { width: 4000, height: 3000, size: 5_000_000, mime: "image/jpeg" }),
    mC?.orig
  );
  ok(
    "(c) extra scalone: pole serwera wygrywa, pole tylko-klienta zostaje",
    mC?.extra?.ISOSpeedRatings === 400 && mC?.extra?.Software === "AlfaCam 2.0",
    mC?.extra
  );

  // -------------------------------------------------------------------------
  // (d) śmieci od klienta — upload PRZECHODZI, wadliwe pola są NULL-em
  // -------------------------------------------------------------------------
  const d1 = await postOffice(multipart("Zły JSON", [{ name: "x1.jpg", type: "image/jpeg", data: jpegBare }], "{{{nie-json"));
  ok("(d) zły JSON → 201 i meta null (upload nie może się wywrócić)", d1.status === 201 && d1.atts[0]?.meta === null, d1.json);

  const d2 = await postOffice(
    multipart("Zła długość", [{ name: "x2.jpg", type: "image/jpeg", data: jpegBare }], JSON.stringify([clientMeta, clientMeta]))
  );
  ok("(d) tablica dłuższa niż lista plików → cała ignorowana, meta null", d2.status === 201 && d2.atts[0]?.meta === null, d2.json);

  const d3 = await postOffice(multipart("Nie tablica", [{ name: "x3.jpg", type: "image/jpeg", data: jpegBare }], JSON.stringify(clientMeta)));
  ok("(d) JSON, ale nie tablica → meta null", d3.status === 201 && d3.atts[0]?.meta === null, d3.json);

  // Trzy pliki naraz: data z przyszłości, współrzędne poza zakresem, „Null Island”.
  const future = new Date(Date.now() + 10 * 24 * 3600_000).toISOString().slice(0, 19);
  const d4 = await postOffice(
    multipart(
      "Wadliwe pola",
      [
        { name: "f1.jpg", type: "image/jpeg", data: jpegBare },
        { name: "f2.jpg", type: "image/jpeg", data: jpegBare },
        { name: "f3.jpg", type: "image/jpeg", data: jpegBare },
      ],
      JSON.stringify([
        { takenAt: future, takenAtSource: "file", capturedVia: "gallery", camera: { make: "Nokia" } },
        { takenAt: "2026-09-14T08:05:00", gps: { lat: 123, lng: 200 }, capturedVia: "camera" },
        { takenAt: "1998-01-01T10:00:00", gps: { lat: 0, lng: 0 }, capturedVia: "gallery", orig: { size: 1234, mime: "image/heic" } },
      ])
    )
  );
  const [m1, m2, m3] = d4.atts.map((x) => x.meta);
  ok("(d) 3 pliki z wadliwymi metadanymi → 201", d4.status === 201 && d4.atts.length === 3, d4.json);
  ok(
    "(d) data z przyszłości odpada, reszta elementu zostaje",
    m1?.takenAt === null && m1?.takenAtSource === "file" && m1?.capturedVia === "gallery" && m1?.camera?.make === "Nokia",
    m1
  );
  ok("(d) lat 123 / lng 200 → gps null, data zostaje", m2?.gps === null && m2?.takenAt === "2026-09-14T08:05:00", m2);
  ok("(d) rok 1998 odpada, (0,0) → gps null, orig zostaje", m3?.takenAt === null && m3?.gps === null && m3?.orig?.size === 1234, m3);
  ok(
    "(d) wadliwe pola są NULL-em także w bazie",
    rowOf(d4.atts[1].id)?.gpsLat === null && rowOf(d4.atts[0].id)?.takenAt === null,
    { g: rowOf(d4.atts[1].id)?.gpsLat, t: rowOf(d4.atts[0].id)?.takenAt }
  );

  // -------------------------------------------------------------------------
  // (e) nic z żadnej strony → meta null (tak wygląda każdy stary załącznik)
  // -------------------------------------------------------------------------
  const e = await postOffice(multipart("Bez metadanych", [{ name: "goly.jpg", type: "image/jpeg", data: jpegBare }]));
  ok("(e) brak EXIF-u i brak pola photoMeta → meta null", e.status === 201 && e.atts[0]?.meta === null, e.json);
  ok("(e) w bazie komplet NULL-i", rowOf(e.atts[0].id)?.capturedVia === null && rowOf(e.atts[0].id)?.origSize === null, rowOf(e.atts[0].id));

  // -------------------------------------------------------------------------
  // (h) nie-obraz — nie ma czego opisywać, nawet gdy klient coś przyśle
  // -------------------------------------------------------------------------
  const h = await postOffice(
    multipart("Protokół", [{ name: "protokol.pdf", type: "application/pdf", data: pdf }], JSON.stringify([clientMeta]))
  );
  ok("(h) PDF → kind file i meta null mimo photoMeta od klienta", h.status === 201 && h.atts[0]?.kind === "file" && h.atts[0]?.meta === null, h.json);

  // -------------------------------------------------------------------------
  // (g) sufit 8 KB na meta_json
  // -------------------------------------------------------------------------
  const fatExif: Record<string, string> = {};
  for (let i = 0; i < 400; i++) fatExif[`Tag${i}`] = "x".repeat(120);
  const g = await postOffice(
    multipart("Gruby EXIF", [{ name: "gruby.jpg", type: "image/jpeg", data: jpegBare }], JSON.stringify([{ ...clientMeta, exif: fatExif }]))
  );
  const gJson = rowOf(g.atts[0].id)?.metaJson ?? "";
  ok(
    `(g) meta_json przycięty do ${PHOTO_META_JSON_MAX_BYTES} B, ale niepusty`,
    g.status === 201 && Buffer.byteLength(gJson) <= PHOTO_META_JSON_MAX_BYTES && Object.keys(g.atts[0].meta?.extra ?? {}).length > 0,
    { bytes: Buffer.byteLength(gJson), keys: Object.keys(g.atts[0].meta?.extra ?? {}).length }
  );
  ok("(g) mimo przycięcia reszta metadanych zostaje", g.atts[0]?.meta?.takenAt === "2026-09-14T08:05:00", g.atts[0]?.meta);

  // -------------------------------------------------------------------------
  // (f) panel technika = kalendarz biurowy, co do znaku
  // -------------------------------------------------------------------------
  const tPost = await postTech(
    multipart("Zdjęcie z tabletu", [{ name: "tablet.jpg", type: "image/jpeg", data: jpegWithExif }], JSON.stringify([clientMeta]))
  );
  const tAtt = tPost.atts[0];
  ok("(f) POST z panelu technika → 201 z meta", tPost.status === 201 && !!tAtt?.meta, tPost.json);
  ok("(f) URL pliku zostaje adresem panelu", tAtt?.url === `/api/technik/attachments/${tAtt?.id}`, tAtt?.url);

  const tGet = await asTech.request(`/api/technik/jobs/${ev.id}`);
  const tGetJson = (await tGet.json()) as { data: { notes: NoteJson[] } };
  const tMeta = tGetJson.data.notes.flatMap((n) => n.attachments).find((x) => x.id === tAtt.id)?.meta;

  const oGet = await asOffice.request(`/calendar/events/${ev.id}/notes`);
  const oGetJson = (await oGet.json()) as { data: NoteJson[] };
  const oMeta = oGetJson.data.flatMap((n) => n.attachments).find((x) => x.id === tAtt.id)?.meta;

  ok("(f) GET z panelu i GET z kalendarza dają IDENTYCZNY obiekt meta", !!tMeta && eq2(tMeta, oMeta), { tMeta, oMeta });
  ok("(f) kształt meta: 8 umówionych kluczy", eq2(Object.keys(tMeta ?? {}).sort(), ["camera", "capturedVia", "extra", "gps", "orig", "takenAt", "takenAtOffset", "takenAtSource"]), Object.keys(tMeta ?? {}));
  ok(
    "(f) treść meta z tabletu: EXIF serwera + capturedVia i orig klienta",
    tMeta?.takenAtSource === "exif" && tMeta?.capturedVia === "camera" && tMeta?.orig?.width === 4000 && tMeta?.gps?.lat === 52.405,
    tMeta
  );

  // Załącznik bez metadanych ma mieć `meta: null` także w panelu — front nie
  // może dostać raz `null`, a raz obiektu z samymi NULL-ami.
  const tBare = await postTech(multipart("Bez meta z tabletu", [{ name: "goly2.jpg", type: "image/jpeg", data: jpegBare }]));
  ok("(f) panel technika: obrazek bez metadanych → meta null", tBare.status === 201 && tBare.atts[0]?.meta === null, tBare.json);

  // -------------------------------------------------------------------------
  // Prywatność: `meta` (w tym GPS) idzie tylko tam, gdzie i tak idzie załącznik
  // -------------------------------------------------------------------------
  const ics = await asOffice.request(`/calendar/events/${ev.id}`);
  const icsJson = (await ics.json()) as { data: { notes: NoteJson[] } };
  ok("(prywatność) GET /events/:id (wgląd w kalendarz) ma meta przy załącznikach", icsJson.data.notes.some((n) => n.attachments.some((x) => x.meta !== null)), null);
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}

console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
