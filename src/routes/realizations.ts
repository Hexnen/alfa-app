import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, asc, and, isNull, isNotNull } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { Protocol, Realization, NewRealization } from "../db/schema.js";
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

/** Skrót protokołu dołączany do realizacji (badge + deep-link w tabeli). */
export interface ProtocolBrief {
  id: number;
  number: string;
  status: "draft" | "final";
  signedAt: string | null;
}

const briefOf = (p: Protocol): ProtocolBrief => ({
  id: p.id,
  number: p.number,
  status: p.status,
  signedAt: p.signedAt ?? null,
});

/** Protokół realizacji (albo null) — odczyt poza transakcją. */
function protocolBriefFor(realizationId: number): ProtocolBrief | null {
  const p = db
    .select({
      id: schema.protocols.id,
      number: schema.protocols.number,
      status: schema.protocols.status,
      signedAt: schema.protocols.signedAt,
    })
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, realizationId))
    .get();
  return p ? { ...p, signedAt: p.signedAt ?? null } : null;
}

function withComputed(
  r: Realization,
  calendarEventId: number | null = null,
  protocol: ProtocolBrief | null = null,
) {
  return {
    ...r,
    subtotal: round2(r.amountHours + r.amountMaterial + r.amountKm),
    total: round2(totalOf(r)),
    labourCost: round2(labourCostOf(r)),
    // Wydarzenie kalendarza, z którego powstała realizacja (null = wpis ręczny).
    calendarEventId,
    // Protokół realizacji (LEFT JOIN po protocols.realization_id); null = brak.
    protocol,
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

// Lista realizacji danego miesiąca (+ powiązane wydarzenie kalendarza i protokół;
// ?source=calendar|manual, ?protocol=with|without)
app.get("/", async (c) => {
  const year = parseInt(c.req.query("year") || "");
  const month = parseInt(c.req.query("month") || "");
  const source = c.req.query("source");
  const protocol = c.req.query("protocol");

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
  if (protocol && protocol !== "with" && protocol !== "without") {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Parametr protocol: dozwolone with, without" },
      400
    );
  }

  const conds = [like(schema.realizations.date, monthPrefix(year, month))];
  if (source === "calendar") conds.push(isNotNull(schema.calendarEvents.id));
  if (source === "manual") conds.push(isNull(schema.calendarEvents.id));
  if (protocol === "with") conds.push(isNotNull(schema.protocols.id));
  if (protocol === "without") conds.push(isNull(schema.protocols.id));

  const rows = await db
    .select({
      r: schema.realizations,
      calendarEventId: schema.calendarEvents.id,
      protocolId: schema.protocols.id,
      protocolNumber: schema.protocols.number,
      protocolStatus: schema.protocols.status,
      protocolSignedAt: schema.protocols.signedAt,
    })
    .from(schema.realizations)
    .leftJoin(schema.calendarEvents, eq(schema.calendarEvents.realizationId, schema.realizations.id))
    .leftJoin(schema.protocols, eq(schema.protocols.realizationId, schema.realizations.id))
    .where(and(...conds))
    .orderBy(asc(schema.realizations.date), asc(schema.realizations.id));

  return c.json({
    success: true,
    data: rows.map((row) =>
      withComputed(
        row.r,
        row.calendarEventId ?? null,
        row.protocolId != null
          ? {
              id: row.protocolId,
              number: row.protocolNumber ?? "",
              status: row.protocolStatus ?? "draft",
              signedAt: row.protocolSignedAt ?? null,
            }
          : null,
      ),
    ),
  });
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
  const { realization, protocol } = db.transaction((tx) => {
    const created = tx
      .insert(schema.realizations)
      .values(data as NewRealization)
      .returning()
      .get();
    const proto = createProtocolForRealizationSync(tx, created);
    return { realization: created, protocol: proto ? briefOf(proto) : null };
  });

  return c.json(
    {
      success: true,
      data: withComputed(realization, null, protocol),
      message: "Realizacja dodana",
    },
    201
  );
});

/**
 * Utworzenie protokołu dla pojedynczej realizacji (starsze/zaimportowane wpisy,
 * którym protokół nie powstał razem z realizacją). Sprawdzenie „czy już jest”
 * i insert w jednej synchronicznej transakcji — numer alokowany atomowo, a
 * ON CONFLICT(realization_id) DO NOTHING zabezpiecza równoległe żądanie
 * (drugie dostaje 409 z istniejącym protokołem, nigdy 500 z UNIQUE).
 */
app.post("/:id/protocol", (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator" }, 400);
  }

  const readProtocol = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
    tx.select().from(schema.protocols).where(eq(schema.protocols.realizationId, id)).limit(1).all()[0];

  const outcome = db.transaction((tx) => {
    const realization = tx
      .select()
      .from(schema.realizations)
      .where(eq(schema.realizations.id, id))
      .limit(1)
      .all()[0];
    if (!realization) return { status: 404 as const };

    const existing = readProtocol(tx);
    if (existing) return { status: 409 as const, protocol: briefOf(existing) };

    const created = createProtocolForRealizationSync(tx, realization);
    // ON CONFLICT DO NOTHING → brak zwrotki znaczy, że protokół powstał równolegle.
    if (!created) {
      const raced = readProtocol(tx);
      return raced
        ? { status: 409 as const, protocol: briefOf(raced) }
        : { status: 409 as const, protocol: null };
    }
    return { status: 201 as const, protocol: briefOf(created) };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono realizacji" }, 404);
  }
  if (outcome.status === 409) {
    return c.json(
      {
        success: false,
        error: "Realizacja ma już protokół",
        data: { protocol: outcome.protocol },
      },
      409
    );
  }

  return c.json(
    {
      success: true,
      data: { protocol: outcome.protocol },
      message: `Protokół ${outcome.protocol.number} utworzony`,
    },
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
    data: withComputed(result[0], link?.id ?? null, protocolBriefFor(id)),
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
