import { Hono } from "hono";
import { createHash } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, like, asc, desc, notInArray } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { Protocol, Realization } from "../db/schema.js";

const app = new Hono();

export interface ProtocolItem {
  name: string;
  serial: string;
  unit: string;
  qty: string;
}

// Domyślne pozycje materiałowe z wzoru protokołu
export const DEFAULT_ITEMS: ProtocolItem[] = [
  { name: "KABEL UTP KAT 5E.", serial: "", unit: "mb", qty: "" },
  { name: "KABEL ZASILAJĄCY", serial: "", unit: "mb", qty: "" },
  { name: "PESZEL - RURA KARBOWANA", serial: "", unit: "mb", qty: "" },
];

/** Kolejny numer protokołu w miesiącu: P/RRRR/MM/NNN */
export async function nextProtocolNumber(workDate: string): Promise<string> {
  const year = workDate.slice(0, 4);
  const month = workDate.slice(5, 7);
  const prefix = `P/${year}/${month}/`;
  const existing = await db
    .select({ number: schema.protocols.number })
    .from(schema.protocols)
    .where(like(schema.protocols.number, `${prefix}%`));
  const maxSeq = existing.reduce((max, r) => {
    const n = parseInt(r.number.slice(prefix.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
}

/** Buduje protokół (prefill) z realizacji — używane też przy tworzeniu realizacji. */
export async function createProtocolForRealization(r: Realization) {
  const contractor = [r.contractor1, r.contractor2].filter(Boolean).join(", ");
  const result = await db
    .insert(schema.protocols)
    .values({
      realizationId: r.id,
      number: await nextProtocolNumber(r.date),
      workDate: r.date,
      workType: r.kind === "installation" ? "montaz" : "serwis",
      actualHours: r.actualHours,
      actualKm: r.actualKm,
      contractor,
      salesperson: r.caretaker || "",
      clientName: "",
      clientNip: "",
      clientCity: "",
      installationAddress: r.site,
      contact: "",
      activities: r.note || "",
      items: JSON.stringify(DEFAULT_ITEMS),
      status: "draft",
    })
    .returning();
  return result[0];
}

function withParsedItems(p: Protocol & { site?: string | null }) {
  let items: ProtocolItem[] = [];
  try {
    items = JSON.parse(p.items);
  } catch {
    items = [];
  }
  return { ...p, items };
}

// Lista protokołów (opcjonalnie filtrowana po roku/miesiącu daty wykonania)
app.get("/", async (c) => {
  const year = c.req.query("year");
  const month = c.req.query("month");

  let query = db
    .select({
      protocol: schema.protocols,
      site: schema.realizations.site,
      kind: schema.realizations.kind,
    })
    .from(schema.protocols)
    .leftJoin(
      schema.realizations,
      eq(schema.protocols.realizationId, schema.realizations.id)
    );

  if (year && month) {
    query = query.where(
      like(
        schema.protocols.workDate,
        `${year}-${String(parseInt(month)).padStart(2, "0")}-%`
      )
    ) as typeof query;
  } else if (year) {
    query = query.where(
      like(schema.protocols.workDate, `${year}-%`)
    ) as typeof query;
  }

  const rows = await query.orderBy(
    desc(schema.protocols.workDate),
    desc(schema.protocols.id)
  );

  return c.json({
    success: true,
    data: rows.map((row) =>
      withParsedItems({ ...row.protocol, site: row.site, kind: row.kind } as never)
    ),
  });
});

// Wygeneruj brakujące protokoły dla istniejących realizacji
app.post("/sync", async (c) => {
  const withProtocol = await db
    .select({ realizationId: schema.protocols.realizationId })
    .from(schema.protocols);
  const coveredIds = withProtocol.map((p) => p.realizationId);

  const missing = coveredIds.length
    ? await db
        .select()
        .from(schema.realizations)
        .where(notInArray(schema.realizations.id, coveredIds))
        .orderBy(asc(schema.realizations.date), asc(schema.realizations.id))
    : await db
        .select()
        .from(schema.realizations)
        .orderBy(asc(schema.realizations.date), asc(schema.realizations.id));

  const created = [];
  for (const r of missing) {
    created.push(await createProtocolForRealization(r));
  }

  return c.json({
    success: true,
    data: { created: created.length },
    message: created.length
      ? `Wygenerowano ${created.length} protokołów`
      : "Wszystkie realizacje mają już protokoły",
  });
});

// Pojedynczy protokół
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const rows = await db
    .select({
      protocol: schema.protocols,
      site: schema.realizations.site,
      kind: schema.realizations.kind,
    })
    .from(schema.protocols)
    .leftJoin(
      schema.realizations,
      eq(schema.protocols.realizationId, schema.realizations.id)
    )
    .where(eq(schema.protocols.id, id))
    .limit(1);

  if (rows.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }

  const row = rows[0];
  return c.json({
    success: true,
    data: withParsedItems({ ...row.protocol, site: row.site, kind: row.kind } as never),
  });
});

// Edycja protokołu
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const workDate = str(body.workDate);
  if (workDate && !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowa data wykonania" },
      400
    );
  }

  const workType = ["serwis", "montaz", "wizja", "inne"].includes(
    body.workType as string
  )
    ? (body.workType as "serwis" | "montaz" | "wizja" | "inne")
    : existing[0].workType;

  const items = Array.isArray(body.items)
    ? body.items
        .filter(
          (i): i is Record<string, unknown> => typeof i === "object" && i !== null
        )
        .map((i) => ({
          name: str(i.name),
          serial: str(i.serial),
          unit: str(i.unit),
          qty: str(i.qty),
        }))
    : undefined;

  const result = await db
    .update(schema.protocols)
    .set({
      workDate: workDate || existing[0].workDate,
      workType,
      actualHours: num(body.actualHours),
      actualKm: num(body.actualKm),
      contractor: str(body.contractor),
      salesperson: str(body.salesperson),
      clientName: str(body.clientName),
      clientNip: str(body.clientNip),
      clientCity: str(body.clientCity),
      installationAddress: str(body.installationAddress),
      contact: str(body.contact),
      activities: str(body.activities),
      ...(items !== undefined ? { items: JSON.stringify(items) } : {}),
      status: body.status === "final" ? "final" : "draft",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.protocols.id, id))
    .returning();

  return c.json({
    success: true,
    data: withParsedItems(result[0]),
    message: "Protokół zapisany",
  });
});

// Podpisanie protokołu — zapisuje PNG podpisu, imię i nazwisko, czas serwera
// oraz SHA-256 z treści protokołu + podpisu (dowód integralności).
app.post("/:id/sign", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const signaturePng =
    typeof body.signaturePng === "string" ? body.signaturePng : "";
  const signerName =
    typeof body.signerName === "string" ? body.signerName.trim() : "";

  if (!signaturePng.startsWith("data:image/png;base64,")) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Brak poprawnego podpisu (PNG)" },
      400
    );
  }
  if (signaturePng.length > 500_000) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Podpis jest zbyt duży" },
      400
    );
  }

  const p = existing[0];
  const signedAt = new Date().toISOString();
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        number: p.number,
        workDate: p.workDate,
        workType: p.workType,
        actualHours: p.actualHours,
        actualKm: p.actualKm,
        contractor: p.contractor,
        clientName: p.clientName,
        clientNip: p.clientNip,
        installationAddress: p.installationAddress,
        activities: p.activities,
        items: p.items,
        signerName,
        signedAt,
      })
    )
    .update(signaturePng)
    .digest("hex");

  const result = await db
    .update(schema.protocols)
    .set({
      signaturePng,
      signerName,
      signedAt,
      contentHash,
      status: "final",
      updatedAt: signedAt,
    })
    .where(eq(schema.protocols.id, id))
    .returning();

  return c.json({
    success: true,
    data: withParsedItems(result[0]),
    message: "Protokół podpisany",
  });
});

// Usunięcie podpisu (np. pomyłka przy podpisywaniu)
app.post("/:id/unsign", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }

  const result = await db
    .update(schema.protocols)
    .set({
      signaturePng: null,
      signerName: null,
      signedAt: null,
      contentHash: null,
      status: "draft",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.protocols.id, id))
    .returning();

  return c.json({
    success: true,
    data: withParsedItems(result[0]),
    message: "Podpis usunięty",
  });
});

// Usunięcie protokołu
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }

  await db.delete(schema.protocols).where(eq(schema.protocols.id, id));

  return c.json<ApiResponse<null>>({ success: true, message: "Protokół usunięty" });
});

export default app;
