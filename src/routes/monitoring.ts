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

// --- Zdjęcia z wizji lokalnej (do galerii w ofercie) ---

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
  const [maxOrder] = await db
    .select({
      max: sql<number>`COALESCE(max(sort_order), 0)`,
    })
    .from(schema.monitoringPhotos)
    .where(eq(schema.monitoringPhotos.projectId, id));
  const [photo] = await db
    .insert(schema.monitoringPhotos)
    .values({
      projectId: id,
      caption: typeof body.caption === "string" ? body.caption.trim() : "",
      attention: body.attention === true,
      sortOrder: maxOrder.max + 1,
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
  const [maxOrder] = await db
    .select({
      max: sql<number>`COALESCE(max(sort_order), 0)`,
    })
    .from(schema.monitoringOverlays)
    .where(eq(schema.monitoringOverlays.projectId, id));
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
      visible: true,
      sortOrder: maxOrder.max + 1,
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
  if (typeof body.sortOrder === "number") updates.sortOrder = body.sortOrder;
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
