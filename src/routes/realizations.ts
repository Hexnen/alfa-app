import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, asc, and, isNull, isNotNull } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { Realization, NewRealization } from "../db/schema.js";
import { createProtocolForRealizationSync } from "./protocols.js";

const app = new Hono();

type Kind = "service" | "warranty" | "installation";
const KINDS: Kind[] = ["service", "warranty", "installation"];

// Suma netto wiersza (godziny + materiały + km - rabat)
const totalOf = (r: Realization) =>
  r.amountHours + r.amountMaterial + r.amountKm - r.discount;

// Koszt roboczogodzin (strata przy serwisach bezpłatnych)
const labourCostOf = (r: Realization) => r.actualHours * r.hourlyCost;

const round2 = (n: number) => Math.round(n * 100) / 100;

const monthPrefix = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}-%`;

function withComputed(r: Realization, calendarEventId: number | null = null) {
  return {
    ...r,
    subtotal: round2(r.amountHours + r.amountMaterial + r.amountKm),
    total: round2(totalOf(r)),
    labourCost: round2(labourCostOf(r)),
    // Wydarzenie kalendarza, z którego powstała realizacja (null = wpis ręczny).
    calendarEventId,
  };
}

/** Waliduje i normalizuje body — zwraca payload albo komunikat błędu. */
function parseBody(body: Record<string, unknown>): { data?: Partial<NewRealization>; error?: string } {
  const date = typeof body.date === "string" ? body.date : "";
  const site = typeof body.site === "string" ? body.site.trim() : "";
  const kind = body.kind as Kind;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Nieprawidłowa data (wymagany format YYYY-MM-DD)" };
  if (!site) return { error: "Obiekt jest wymagany" };
  if (!KINDS.includes(kind)) return { error: "Nieprawidłowy typ realizacji" };

  const num = (v: unknown) => {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const invoiced = Boolean(body.invoiced);
  return {
    data: {
      date,
      site,
      kind,
      amountHours: num(body.amountHours),
      amountMaterial: num(body.amountMaterial),
      amountKm: num(body.amountKm),
      discount: num(body.discount),
      note: typeof body.note === "string" ? body.note : "",
      invoiced,
      invoicedAt: invoiced && typeof body.invoicedAt === "string" && body.invoicedAt ? body.invoicedAt : null,
      caretaker: typeof body.caretaker === "string" ? body.caretaker : "",
      contractor1: typeof body.contractor1 === "string" ? body.contractor1 : "",
      contractor2: typeof body.contractor2 === "string" ? body.contractor2 : "",
      actualHours: num(body.actualHours),
      actualKm: num(body.actualKm),
      hourlyCost: num(body.hourlyCost),
    },
  };
}

// Lista realizacji danego miesiąca (+ powiązane wydarzenie kalendarza; ?source=calendar|manual)
app.get("/", async (c) => {
  const year = parseInt(c.req.query("year") || "");
  const month = parseInt(c.req.query("month") || "");
  const source = c.req.query("source");

  if (!year || !month || month < 1 || month > 12) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagane parametry: year, month" },
      400
    );
  }
  if (source && source !== "calendar" && source !== "manual") {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Parametr source: dozwolone calendar, manual" },
      400
    );
  }

  const conds = [like(schema.realizations.date, monthPrefix(year, month))];
  if (source === "calendar") conds.push(isNotNull(schema.calendarEvents.id));
  if (source === "manual") conds.push(isNull(schema.calendarEvents.id));

  const rows = await db
    .select({ r: schema.realizations, calendarEventId: schema.calendarEvents.id })
    .from(schema.realizations)
    .leftJoin(schema.calendarEvents, eq(schema.calendarEvents.realizationId, schema.realizations.id))
    .where(and(...conds))
    .orderBy(asc(schema.realizations.date), asc(schema.realizations.id));

  return c.json({ success: true, data: rows.map((row) => withComputed(row.r, row.calendarEventId ?? null)) });
});

// Podsumowanie miesiąca + tabela roczna przychód/strata
// (odpowiednik bloków podsumowań z arkusza)
app.get("/summary", async (c) => {
  const year = parseInt(c.req.query("year") || "");
  const month = parseInt(c.req.query("month") || "");

  if (!year) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagany parametr: year" },
      400
    );
  }

  const yearRows = await db
    .select()
    .from(schema.realizations)
    .where(like(schema.realizations.date, `${year}-%`));

  const monthRows = month
    ? yearRows.filter((r) => parseInt(r.date.slice(5, 7)) === month)
    : yearRows;

  let paidServices = 0;
  let installations = 0;
  let freePotential = 0;
  let freeCost = 0;
  const counts = { service: 0, warranty: 0, installation: 0 };
  let uninvoiced = 0;

  for (const r of monthRows) {
    counts[r.kind as Kind] += 1;
    if (r.kind === "service") paidServices += totalOf(r);
    else if (r.kind === "installation") installations += totalOf(r);
    else {
      freePotential += totalOf(r);
      freeCost += labourCostOf(r);
    }
    if (!r.invoiced && r.kind !== "warranty") uninvoiced += 1;
  }

  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    let revenue = 0;
    let loss = 0;
    for (const r of yearRows) {
      if (parseInt(r.date.slice(5, 7)) !== m) continue;
      if (r.kind === "warranty") loss += labourCostOf(r);
      else revenue += totalOf(r);
    }
    return { month: m, revenue: round2(revenue), loss: round2(loss) };
  });

  return c.json({
    success: true,
    data: {
      paidServices: round2(paidServices),
      installations: round2(installations),
      revenue: round2(paidServices + installations),
      freePotential: round2(freePotential),
      freeCost: round2(freeCost),
      grandTotal: round2(paidServices + installations + freePotential),
      counts,
      uninvoicedCount: uninvoiced,
      months,
    },
  });
});

// Nowa realizacja
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  // Realizacja i jej protokół powstają w jednej synchronicznej transakcji —
  // albo oba, albo żadne. Numer protokołu alokowany atomowo (bez wyścigu na
  // UNIQUE), więc równoległy POST /protocols/sync nie zostawi realizacji bez
  // protokołu ani nie wywoła 500 z kolizji UNIQUE(realizationId/number).
  const realization = db.transaction((tx) => {
    const created = tx
      .insert(schema.realizations)
      .values(data as NewRealization)
      .returning()
      .get();
    createProtocolForRealizationSync(tx, created);
    return created;
  });

  return c.json(
    { success: true, data: withComputed(realization), message: "Realizacja dodana" },
    201
  );
});

// Edycja realizacji
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.realizations)
    .where(eq(schema.realizations.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono realizacji" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  // Optymistyczna kontrola współbieżności: klient MUSI odesłać updatedAt, który
  // odczytał. Zapisujemy tylko gdy wiersz się nie zmienił — inaczej 409. Brak
  // tokenu odrzucamy (428) zamiast degradować do eq(id): parseBody odtwarza cały
  // wiersz z body, więc ścieżka bez guardu to pełny lost update kasujący pola
  // finansowe (amountMaterial/amountHours) drugiego edytora.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;

  if (!expectedUpdatedAt) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Brak expectedUpdatedAt — odśwież realizację i spróbuj ponownie.",
      },
      428,
    );
  }

  const result = await db
    .update(schema.realizations)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.realizations.id, id),
        eq(schema.realizations.updatedAt, expectedUpdatedAt),
      ),
    )
    .returning();

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Realizacja została zmieniona przez kogoś innego. Odśwież i spróbuj ponownie.",
      },
      409,
    );
  }

  const link = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(eq(schema.calendarEvents.realizationId, id))
    .get();

  return c.json({
    success: true,
    data: withComputed(result[0], link?.id ?? null),
    message: "Realizacja zaktualizowana",
  });
});

// Usunięcie realizacji
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.realizations)
    .where(eq(schema.realizations.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono realizacji" },
      404
    );
  }

  await db.delete(schema.realizations).where(eq(schema.realizations.id, id));

  return c.json<ApiResponse<null>>({ success: true, message: "Realizacja usunięta" });
});

export default app;
