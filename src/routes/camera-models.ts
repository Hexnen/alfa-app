import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, asc } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { NewCameraModel } from "../db/schema.js";

const app = new Hono();

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const CAMERA_TYPES = ["bullet", "dome", "ptz", "pano"] as const;
type CameraType = (typeof CAMERA_TYPES)[number];

function parseBody(body: Record<string, unknown>): {
  data?: Partial<NewCameraModel>;
  error?: string;
} {
  const name = str(body.name);
  if (!name) return { error: "Nazwa / model kamery jest wymagany" };

  const position = Number.isFinite(Number(body.position))
    ? Number(body.position)
    : 0;
  const type: CameraType = CAMERA_TYPES.includes(body.type as CameraType)
    ? (body.type as CameraType)
    : "bullet";
  const color = str(body.color) || "#38bdf8";

  return {
    data: {
      name,
      manufacturer: str(body.manufacturer),
      type,
      resolution: str(body.resolution),
      lens: str(body.lens),
      irRange: str(body.irRange),
      power: str(body.power),
      interface: str(body.interface),
      protocol: str(body.protocol),
      fov: Math.round(num(body.fov, 90)),
      range: Math.round(num(body.range, 20)),
      height: num(body.height, 3),
      color,
      notes: str(body.notes),
      position,
      active: body.active === undefined ? true : Boolean(body.active),
    },
  };
}

// Lista szablonów kamer
app.get("/", async (c) => {
  const rows = await db
    .select()
    .from(schema.cameraModels)
    .orderBy(asc(schema.cameraModels.position), asc(schema.cameraModels.id));
  return c.json({ success: true, data: rows });
});

// Nowy szablon
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  if (!data.position) {
    const rows = await db.select().from(schema.cameraModels);
    data.position = rows.length + 1;
  }

  const result = await db
    .insert(schema.cameraModels)
    .values(data as NewCameraModel)
    .returning();

  return c.json(
    { success: true, data: result[0], message: "Szablon kamery dodany" },
    201
  );
});

// Edycja szablonu
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.cameraModels)
    .where(eq(schema.cameraModels.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono szablonu kamery" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const result = await db
    .update(schema.cameraModels)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(schema.cameraModels.id, id))
    .returning();

  return c.json({
    success: true,
    data: result[0],
    message: "Szablon kamery zaktualizowany",
  });
});

// Usunięcie szablonu
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.cameraModels)
    .where(eq(schema.cameraModels.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono szablonu kamery" },
      404
    );
  }

  await db.delete(schema.cameraModels).where(eq(schema.cameraModels.id, id));

  return c.json<ApiResponse<null>>({ success: true, message: "Szablon usunięty" });
});

export default app;
