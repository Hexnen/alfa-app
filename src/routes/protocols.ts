import { Hono } from "hono";
import { createHash } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, like, asc, desc, notInArray, and } from "drizzle-orm";
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

// Typ transakcji drizzle/better-sqlite3 — pozwala współdzielić helpery między db i tx.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Kolejny numer protokołu w miesiącu: P/RRRR/MM/NNN — synchronicznie, w obrębie
 * transakcji. Wywoływać tylko wewnątrz db.transaction, aby alokacja numeru i
 * insert były atomowe (bez wyścigu na UNIQUE(number) przy równoległych żądaniach).
 */
export function nextProtocolNumberSync(tx: Tx, workDate: string): string {
  const year = workDate.slice(0, 4);
  const month = workDate.slice(5, 7);
  const prefix = `P/${year}/${month}/`;
  const existing = tx
    .select({ number: schema.protocols.number })
    .from(schema.protocols)
    .where(like(schema.protocols.number, `${prefix}%`))
    .all();
  const maxSeq = existing.reduce((max, r) => {
    const n = parseInt(r.number.slice(prefix.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
}

/**
 * Buduje protokół (prefill) z realizacji — używane też przy tworzeniu realizacji.
 * Alokacja numeru i insert w jednej transakcji (przekazany tx), więc kolejne
 * numery i ograniczenia UNIQUE(number/realizationId) nie kolidują przy
 * równoległych żądaniach. Idempotentne po realizationId (ON CONFLICT DO NOTHING).
 */
export function createProtocolForRealizationSync(tx: Tx, r: Realization) {
  const contractor = [r.contractor1, r.contractor2].filter(Boolean).join(", ");
  return tx
    .insert(schema.protocols)
    .values({
      realizationId: r.id,
      number: nextProtocolNumberSync(tx, r.date),
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
    .onConflictDoNothing({ target: schema.protocols.realizationId })
    .returning()
    .get();
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

  let rows = await query.orderBy(
    desc(schema.protocols.workDate),
    desc(schema.protocols.id)
  );

  // ?q= — szukajka (numer / zleceniodawca / obiekt / miejscowość / data), ?limit= — np. lista w dialogu kalendarza
  const q = (c.req.query("q") || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((row) =>
      [row.protocol.number, row.protocol.clientName, row.site, row.protocol.clientCity, row.protocol.workDate, row.protocol.installationAddress]
        .some((v) => v != null && String(v).toLowerCase().includes(q))
    );
  }
  const limit = Number(c.req.query("limit"));
  if (Number.isInteger(limit) && limit > 0) rows = rows.slice(0, limit);

  return c.json({
    success: true,
    data: rows.map((row) =>
      withParsedItems({ ...row.protocol, site: row.site, kind: row.kind } as never)
    ),
  });
});

// Wygeneruj brakujące protokoły dla istniejących realizacji.
// Cały sync w jednej synchronicznej transakcji: selekcja pokrytych id, obliczenie
// braków i wstawianie są atomowe (żądania nie przeplatają się), a
// ON CONFLICT(realization_id) DO NOTHING czyni operację idempotentną.
app.post("/sync", (c) => {
  const created = db.transaction((tx) => {
    const withProtocol = tx
      .select({ realizationId: schema.protocols.realizationId })
      .from(schema.protocols)
      .all();
    const coveredIds = withProtocol.map((p) => p.realizationId);

    const missing = coveredIds.length
      ? tx
          .select()
          .from(schema.realizations)
          .where(notInArray(schema.realizations.id, coveredIds))
          .orderBy(asc(schema.realizations.date), asc(schema.realizations.id))
          .all()
      : tx
          .select()
          .from(schema.realizations)
          .orderBy(asc(schema.realizations.date), asc(schema.realizations.id))
          .all();

    let count = 0;
    for (const r of missing) {
      if (createProtocolForRealizationSync(tx, r)) count++;
    }
    return count;
  });

  return c.json({
    success: true,
    data: { created },
    message: created
      ? `Wygenerowano ${created} protokołów`
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

  // Optimistic-concurrency: gdy klient poda expectedUpdatedAt, zapis przechodzi
  // tylko jeśli wiersz nie zmienił się od odczytu (inaczej 409).
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;

  // Odczyt + zapis w jednej synchronicznej transakcji — brak przeplotu między
  // SELECT a UPDATE, a równoległe edycje serializują się (bez zgubionych zmian).
  const outcome = db.transaction((tx) => {
    const rows = tx
      .select()
      .from(schema.protocols)
      .where(eq(schema.protocols.id, id))
      .limit(1)
      .all();
    if (rows.length === 0) return { status: 404 as const };
    const existing = rows[0];

    // Podpisanego protokołu nie wolno edytować — zmieniłoby to treść pod
    // istniejącym contentHash (dowód integralności przestałby pasować).
    if (existing.signaturePng || existing.contentHash) {
      return { status: 409 as const, signed: true };
    }
    if (expectedUpdatedAt !== null && existing.updatedAt !== expectedUpdatedAt) {
      return { status: 409 as const };
    }

    const workType = ["serwis", "montaz", "wizja", "inne"].includes(
      body.workType as string
    )
      ? (body.workType as "serwis" | "montaz" | "wizja" | "inne")
      : existing.workType;

    const updated = tx
      .update(schema.protocols)
      .set({
        workDate: workDate || existing.workDate,
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
      .where(
        expectedUpdatedAt !== null
          ? and(
              eq(schema.protocols.id, id),
              eq(schema.protocols.updatedAt, expectedUpdatedAt)
            )
          : eq(schema.protocols.id, id)
      )
      .returning()
      .all();
    if (updated.length === 0) return { status: 409 as const };
    return { status: 200 as const, data: updated[0] };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: outcome.signed
          ? "Protokół jest podpisany — usuń podpis przed edycją."
          : "Protokół został w międzyczasie zmieniony. Odśwież i spróbuj ponownie.",
      },
      409
    );
  }

  return c.json({
    success: true,
    data: withParsedItems(outcome.data),
    message: "Protokół zapisany",
  });
});

// Podpisanie protokołu — zapisuje PNG podpisu, imię i nazwisko, czas serwera
// oraz SHA-256 z treści protokołu + podpisu (dowód integralności).
app.post("/:id/sign", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();
  const signaturePng =
    typeof body.signaturePng === "string" ? body.signaturePng : "";
  const signerName =
    typeof body.signerName === "string" ? body.signerName.trim() : "";
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;

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

  // Odczyt treści, wyliczenie contentHash i zapis w jednej synchronicznej
  // transakcji — hash liczony jest z treści aktualnie zapisanej w bazie, więc
  // równoległa edycja nie może rozjechać podpisu z treścią protokołu.
  const outcome = db.transaction((tx) => {
    const rows = tx
      .select()
      .from(schema.protocols)
      .where(eq(schema.protocols.id, id))
      .limit(1)
      .all();
    if (rows.length === 0) return { status: 404 as const };
    const p = rows[0];
    if (expectedUpdatedAt !== null && p.updatedAt !== expectedUpdatedAt) {
      return { status: 409 as const };
    }

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

    const updated = tx
      .update(schema.protocols)
      .set({
        signaturePng,
        signerName,
        signedAt,
        contentHash,
        status: "final",
        updatedAt: signedAt,
      })
      .where(
        expectedUpdatedAt !== null
          ? and(
              eq(schema.protocols.id, id),
              eq(schema.protocols.updatedAt, expectedUpdatedAt)
            )
          : eq(schema.protocols.id, id)
      )
      .returning()
      .all();
    if (updated.length === 0) return { status: 409 as const };
    return { status: 200 as const, data: updated[0] };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          "Protokół został w międzyczasie zmieniony. Odśwież i spróbuj ponownie.",
      },
      409
    );
  }

  return c.json({
    success: true,
    data: withParsedItems(outcome.data),
    message: "Protokół podpisany",
  });
});

// Usunięcie podpisu (np. pomyłka przy podpisywaniu)
app.post("/:id/unsign", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const expectedUpdatedAt =
    typeof (body as Record<string, unknown>).expectedUpdatedAt === "string"
      ? ((body as Record<string, unknown>).expectedUpdatedAt as string)
      : null;

  const outcome = db.transaction((tx) => {
    const rows = tx
      .select()
      .from(schema.protocols)
      .where(eq(schema.protocols.id, id))
      .limit(1)
      .all();
    if (rows.length === 0) return { status: 404 as const };
    if (expectedUpdatedAt !== null && rows[0].updatedAt !== expectedUpdatedAt) {
      return { status: 409 as const };
    }

    const updated = tx
      .update(schema.protocols)
      .set({
        signaturePng: null,
        signerName: null,
        signedAt: null,
        contentHash: null,
        status: "draft",
        updatedAt: new Date().toISOString(),
      })
      .where(
        expectedUpdatedAt !== null
          ? and(
              eq(schema.protocols.id, id),
              eq(schema.protocols.updatedAt, expectedUpdatedAt)
            )
          : eq(schema.protocols.id, id)
      )
      .returning()
      .all();
    if (updated.length === 0) return { status: 409 as const };
    return { status: 200 as const, data: updated[0] };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono protokołu" },
      404
    );
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          "Protokół został w międzyczasie zmieniony. Odśwież i spróbuj ponownie.",
      },
      409
    );
  }

  return c.json({
    success: true,
    data: withParsedItems(outcome.data),
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
