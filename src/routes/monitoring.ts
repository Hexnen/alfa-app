import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc, asc, sql } from "drizzle-orm";
import type {
  MonitoringProject,
  NewMonitoringProject,
  NewMonitoringPhoto,
  NewMonitoringOverlay,
} from "../db/schema.js";
import { renderOffer } from "../lib/monitoring-offer.js";
import {
  cancelDwgJob,
  createDwgJob,
  getDwgJob,
} from "../services/dwg-import.js";
import { readFile } from "node:fs/promises";

const app = new Hono();

// Podsumowanie stanu projektu do listy (bez odsyłania pełnego JSON-a)
function withCounts(p: MonitoringProject) {
  let cameras = 0,
    points = 0,
    zones = 0,
    cables = 0,
    pinAddress = "";
  try {
    const d = JSON.parse(p.data);
    cameras = Array.isArray(d.cameras) ? d.cameras.length : 0;
    points = Array.isArray(d.points) ? d.points.length : 0;
    zones = Array.isArray(d.zones) ? d.zones.length : 0;
    cables = Array.isArray(d.cables) ? d.cables.length : 0;
    pinAddress = d.objPin && typeof d.objPin.address === "string" ? d.objPin.address : "";
  } catch {
    /* pusty/uszkodzony stan — zostają zera */
  }
  const { data: _data, offer: _offer, ...rest } = p;
  return { ...rest, cameras, points, zones, cables, pinAddress };
}

// Lista projektów
app.get("/", async (c) => {
  const projects = await db
    .select()
    .from(schema.monitoringProjects)
    .orderBy(desc(schema.monitoringProjects.updatedAt));
  return c.json({ success: true, data: projects.map(withCounts) });
});

// Nowy projekt
app.post("/", async (c) => {
  const body = await c.req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ success: false, error: "Nazwa jest wymagana" }, 400);
  }
  const [project] = await db
    .insert(schema.monitoringProjects)
    .values({
      name,
      address: typeof body.address === "string" ? body.address.trim() : "",
      notes: typeof body.notes === "string" ? body.notes : "",
    })
    .returning();
  return c.json({ success: true, data: withCounts(project) }, 201);
});

// Pojedynczy projekt (z pełnym stanem — dla designera)
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [project] = await db
    .select()
    .from(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, id));
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  return c.json({ success: true, data: project });
});

// Edycja metadanych (nazwa / adres / notatki)
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json();
  const updates: Partial<NewMonitoringProject> = {};
  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }
  if (typeof body.address === "string") updates.address = body.address.trim();
  if (typeof body.notes === "string") updates.notes = body.notes;
  if (typeof body.offer === "object" && body.offer !== null) {
    updates.offer = JSON.stringify(body.offer);
  }
  const [project] = await db
    .update(schema.monitoringProjects)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(schema.monitoringProjects.id, id))
    .returning();
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  return c.json({ success: true, data: withCounts(project) });
});

// Autozapis stanu z designera — body to pełny obiekt stanu (JSON)
app.put("/:id/data", async (c) => {
  const id = parseInt(c.req.param("id"));
  let state: unknown;
  try {
    state = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Nieprawidłowy JSON" }, 400);
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return c.json({ success: false, error: "Nieprawidłowy stan projektu" }, 400);
  }
  const [project] = await db
    .update(schema.monitoringProjects)
    .set({ data: JSON.stringify(state), updatedAt: new Date().toISOString() })
    .where(eq(schema.monitoringProjects.id, id))
    .returning({ id: schema.monitoringProjects.id });
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  return c.json({ success: true });
});

// Gotowa oferta HTML — otwierana w nowej karcie; ?download=1 wymusza pobranie
app.get("/:id/offer", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [project] = await db
    .select()
    .from(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, id));
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  const photos = await db
    .select()
    .from(schema.monitoringPhotos)
    .where(eq(schema.monitoringPhotos.projectId, id))
    .orderBy(
      asc(schema.monitoringPhotos.sortOrder),
      asc(schema.monitoringPhotos.id)
    );
  const html = renderOffer(project, photos);
  if (c.req.query("download")) {
    const slug =
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9ąćęłńóśźż]+/gi, "-")
        .replace(/^-|-$/g, "") || "projekt";
    c.header(
      "Content-Disposition",
      `attachment; filename="oferta-${encodeURIComponent(slug)}.html"`
    );
  }
  return c.html(html);
});

// --- Zdjęcia z wizji (do galerii w ofercie) ---

app.get("/:id/photos", async (c) => {
  const id = parseInt(c.req.param("id"));
  const photos = await db
    .select()
    .from(schema.monitoringPhotos)
    .where(eq(schema.monitoringPhotos.projectId, id))
    .orderBy(
      asc(schema.monitoringPhotos.sortOrder),
      asc(schema.monitoringPhotos.id)
    );
  return c.json({ success: true, data: photos });
});

app.post("/:id/photos", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [project] = await db
    .select({ id: schema.monitoringProjects.id })
    .from(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, id));
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  const body = await c.req.json();
  const data = typeof body.data === "string" ? body.data : "";
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
    return c.json({ success: false, error: "Nieprawidłowe zdjęcie" }, 400);
  }
  if (data.length > 4_000_000) {
    return c.json(
      { success: false, error: "Zdjęcie za duże (max ~3 MB po kompresji)" },
      400
    );
  }
  // Compute the next sort_order inside the INSERT so the read-modify-write
  // is a single atomic statement — concurrent uploads can't collide on it.
  const [photo] = await db
    .insert(schema.monitoringPhotos)
    .values({
      projectId: id,
      caption: typeof body.caption === "string" ? body.caption.trim() : "",
      attention: body.attention === true,
      sortOrder: sql<number>`(SELECT COALESCE(max(sort_order), 0) + 1 FROM monitoring_photos WHERE project_id = ${id})`,
      data,
    })
    .returning();
  return c.json({ success: true, data: photo }, 201);
});

app.put("/photos/:photoId", async (c) => {
  const photoId = parseInt(c.req.param("photoId"));
  const body = await c.req.json();
  const updates: Partial<NewMonitoringPhoto> = {};
  if (typeof body.caption === "string") updates.caption = body.caption.trim();
  if (typeof body.attention === "boolean") updates.attention = body.attention;
  if (typeof body.sortOrder === "number") updates.sortOrder = body.sortOrder;
  const [photo] = await db
    .update(schema.monitoringPhotos)
    .set(updates)
    .where(eq(schema.monitoringPhotos.id, photoId))
    .returning();
  if (!photo) {
    return c.json({ success: false, error: "Zdjęcie nie istnieje" }, 404);
  }
  return c.json({ success: true, data: photo });
});

app.delete("/photos/:photoId", async (c) => {
  const photoId = parseInt(c.req.param("photoId"));
  const [photo] = await db
    .delete(schema.monitoringPhotos)
    .where(eq(schema.monitoringPhotos.id, photoId))
    .returning({ id: schema.monitoringPhotos.id });
  if (!photo) {
    return c.json({ success: false, error: "Zdjęcie nie istnieje" }, 404);
  }
  return c.json({ success: true, data: null });
});

app.get("/:id/overlays", async (c) => {
  const id = parseInt(c.req.param("id"));
  const overlays = await db
    .select()
    .from(schema.monitoringOverlays)
    .where(eq(schema.monitoringOverlays.projectId, id))
    .orderBy(
      asc(schema.monitoringOverlays.sortOrder),
      asc(schema.monitoringOverlays.id)
    );
  return c.json({ success: true, data: overlays });
});

app.post("/:id/overlays", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [project] = await db
    .select({ id: schema.monitoringProjects.id })
    .from(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, id));
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  const body = await c.req.json();
  const data = typeof body.data === "string" ? body.data : "";
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
    return c.json({ success: false, error: "Nieprawidłowy plan" }, 400);
  }
  if (data.length > 8_000_000) {
    return c.json({ success: false, error: "Plan za duży (max ~6 MB)" }, 400);
  }
  const swLat = body.swLat;
  const swLng = body.swLng;
  const neLat = body.neLat;
  const neLng = body.neLng;
  if (
    !Number.isFinite(swLat) ||
    !Number.isFinite(swLng) ||
    !Number.isFinite(neLat) ||
    !Number.isFinite(neLng)
  ) {
    return c.json({ success: false, error: "Brak współrzędnych planu" }, 400);
  }
  // Compute the next sort_order inside the INSERT so the read-modify-write
  // is a single atomic statement — concurrent uploads can't collide on it.
  const [overlay] = await db
    .insert(schema.monitoringOverlays)
    .values({
      projectId: id,
      name: typeof body.name === "string" ? body.name.trim() : "",
      data,
      swLat,
      swLng,
      neLat,
      neLng,
      rotation: typeof body.rotation === "number" ? body.rotation : 0,
      opacity: typeof body.opacity === "number" ? body.opacity : 0.7,
      meta:
        typeof body.meta === "string" && body.meta.length <= 2000
          ? body.meta
          : null,
      visible: true,
      locked: body.locked === true,
      sortOrder: sql<number>`(SELECT COALESCE(max(sort_order), 0) + 1 FROM monitoring_overlays WHERE project_id = ${id})`,
    })
    .returning();
  return c.json({ success: true, data: overlay }, 201);
});

app.put("/overlays/:overlayId", async (c) => {
  const overlayId = parseInt(c.req.param("overlayId"));
  const body = await c.req.json();
  const updates: Partial<NewMonitoringOverlay> = {};
  if (typeof body.name === "string") updates.name = body.name.trim();
  if (Number.isFinite(body.swLat)) updates.swLat = body.swLat;
  if (Number.isFinite(body.swLng)) updates.swLng = body.swLng;
  if (Number.isFinite(body.neLat)) updates.neLat = body.neLat;
  if (Number.isFinite(body.neLng)) updates.neLng = body.neLng;
  if (typeof body.rotation === "number") updates.rotation = body.rotation;
  if (typeof body.opacity === "number")
    updates.opacity = Math.min(1, Math.max(0, body.opacity));
  if (typeof body.visible === "boolean") updates.visible = body.visible;
  if (typeof body.locked === "boolean") updates.locked = body.locked;
  if (typeof body.sortOrder === "number") updates.sortOrder = body.sortOrder;
  if (body.meta === null) updates.meta = null;
  else if (typeof body.meta === "string" && body.meta.length <= 2000)
    updates.meta = body.meta;
  const [overlay] = await db
    .update(schema.monitoringOverlays)
    .set(updates)
    .where(eq(schema.monitoringOverlays.id, overlayId))
    .returning();
  if (!overlay) {
    return c.json({ success: false, error: "Plan nie istnieje" }, 404);
  }
  return c.json({ success: true, data: overlay });
});

// --- Import DWG: asynchroniczny job konwersji (LibreDWG + ezdxf + resvg) ---

const DWG_MAX_BYTES = 30 * 1024 * 1024;

app.post("/:id/dwg-import", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [project] = await db
    .select({ id: schema.monitoringProjects.id })
    .from(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, id));
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  const len = parseInt(c.req.header("content-length") || "0");
  if (len > DWG_MAX_BYTES + 64 * 1024) {
    return c.json({ success: false, error: "Plik za duży (max 30 MB)" }, 413);
  }
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File) || !/\.dwg$/i.test(file.name)) {
    return c.json({ success: false, error: "Prześlij plik .dwg (pole 'file')" }, 400);
  }
  if (file.size > DWG_MAX_BYTES) {
    return c.json({ success: false, error: "Plik za duży (max 30 MB)" }, 413);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  // sygnatura DWG: "AC10xx"
  if (!buf.subarray(0, 2).equals(Buffer.from("AC"))) {
    return c.json({ success: false, error: "To nie wygląda na plik DWG" }, 400);
  }
  const job = createDwgJob(id, file.name, buf);
  return c.json({ success: true, data: { jobId: job.id } }, 201);
});

app.get("/dwg-import/:jobId", (c) => {
  const job = getDwgJob(c.req.param("jobId"));
  if (!job) return c.json({ success: false, error: "Zadanie nie istnieje" }, 404);
  return c.json({
    success: true,
    data: {
      stage: job.stage,
      stageLabel: job.stageLabel,
      progress: job.progress,
      error: job.error ?? null,
      result: job.result
        ? { meta: job.result.meta, pngBytes: job.result.pngBytes }
        : null,
    },
  });
});

app.get("/dwg-import/:jobId/image", async (c) => {
  const job = getDwgJob(c.req.param("jobId"));
  if (!job || !job.result) {
    return c.json({ success: false, error: "Obraz nie jest gotowy" }, 404);
  }
  try {
    const png = await readFile(job.result.pngPath);
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "no-store");
    return c.body(new Uint8Array(png)); // PNG ~1-4 MB — bufor zamiast streamu (prostota)
  } catch {
    return c.json({ success: false, error: "Obraz wygasł" }, 410);
  }
});

app.delete("/dwg-import/:jobId", (c) => {
  cancelDwgJob(c.req.param("jobId"));
  return c.json({ success: true, data: null });
});

app.delete("/overlays/:overlayId", async (c) => {
  const overlayId = parseInt(c.req.param("overlayId"));
  const [overlay] = await db
    .delete(schema.monitoringOverlays)
    .where(eq(schema.monitoringOverlays.id, overlayId))
    .returning({ id: schema.monitoringOverlays.id });
  if (!overlay) {
    return c.json({ success: false, error: "Plan nie istnieje" }, 404);
  }
  return c.json({ success: true, data: null });
});

// --- Nazwane wersje (snapshoty) stanu projektu ---

const MAX_SNAPSHOTS_PER_PROJECT = 30;

// Lekka lista — bez pola data (pełny stan bywa duży)
app.get("/:id/snapshots", async (c) => {
  const id = parseInt(c.req.param("id"));
  const snapshots = await db
    .select({
      id: schema.monitoringSnapshots.id,
      name: schema.monitoringSnapshots.name,
      createdAt: schema.monitoringSnapshots.createdAt,
    })
    .from(schema.monitoringSnapshots)
    .where(eq(schema.monitoringSnapshots.projectId, id))
    .orderBy(
      desc(schema.monitoringSnapshots.createdAt),
      desc(schema.monitoringSnapshots.id)
    );
  return c.json({ success: true, data: snapshots });
});

// Pełny rekord z data — do przywrócenia stanu w designerze
app.get("/snapshots/:snapshotId", async (c) => {
  const snapshotId = parseInt(c.req.param("snapshotId"));
  const [snapshot] = await db
    .select()
    .from(schema.monitoringSnapshots)
    .where(eq(schema.monitoringSnapshots.id, snapshotId));
  if (!snapshot) {
    return c.json({ success: false, error: "Wersja nie istnieje" }, 404);
  }
  return c.json({ success: true, data: snapshot });
});

app.post("/:id/snapshots", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [project] = await db
    .select({ id: schema.monitoringProjects.id })
    .from(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, id));
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  const body = await c.req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ success: false, error: "Nazwa wersji jest wymagana" }, 400);
  }
  // data: JSON stanu projektu — jako string albo obiekt (jak PUT /:id/data)
  let data = "";
  if (typeof body.data === "string" && body.data) {
    data = body.data;
  } else if (typeof body.data === "object" && body.data !== null) {
    data = JSON.stringify(body.data);
  }
  if (!data) {
    return c.json({ success: false, error: "Brak stanu projektu (data)" }, 400);
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.monitoringSnapshots)
    .where(eq(schema.monitoringSnapshots.projectId, id));
  if (count >= MAX_SNAPSHOTS_PER_PROJECT) {
    return c.json(
      {
        success: false,
        error: `Osiągnięto limit ${MAX_SNAPSHOTS_PER_PROJECT} wersji dla projektu — usuń starsze wersje, aby zapisać nową`,
      },
      400
    );
  }
  const [snapshot] = await db
    .insert(schema.monitoringSnapshots)
    .values({ projectId: id, name, data })
    .returning({
      id: schema.monitoringSnapshots.id,
      name: schema.monitoringSnapshots.name,
      createdAt: schema.monitoringSnapshots.createdAt,
    });
  return c.json({ success: true, data: snapshot }, 201);
});

// Zmiana nazwy wersji
app.put("/snapshots/:snapshotId", async (c) => {
  const snapshotId = parseInt(c.req.param("snapshotId"));
  const body = await c.req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ success: false, error: "Nazwa wersji jest wymagana" }, 400);
  }
  const [snapshot] = await db
    .update(schema.monitoringSnapshots)
    .set({ name })
    .where(eq(schema.monitoringSnapshots.id, snapshotId))
    .returning({
      id: schema.monitoringSnapshots.id,
      name: schema.monitoringSnapshots.name,
      createdAt: schema.monitoringSnapshots.createdAt,
    });
  if (!snapshot) {
    return c.json({ success: false, error: "Wersja nie istnieje" }, 404);
  }
  return c.json({ success: true, data: snapshot });
});

app.delete("/snapshots/:snapshotId", async (c) => {
  const snapshotId = parseInt(c.req.param("snapshotId"));
  const [snapshot] = await db
    .delete(schema.monitoringSnapshots)
    .where(eq(schema.monitoringSnapshots.id, snapshotId))
    .returning({ id: schema.monitoringSnapshots.id });
  if (!snapshot) {
    return c.json({ success: false, error: "Wersja nie istnieje" }, 404);
  }
  return c.json({ success: true, data: null });
});

app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [project] = await db
    .delete(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, id))
    .returning({ id: schema.monitoringProjects.id });
  if (!project) {
    return c.json({ success: false, error: "Projekt nie istnieje" }, 404);
  }
  return c.json({ success: true, data: null });
});

export default app;
