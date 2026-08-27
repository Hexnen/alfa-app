import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, asc, and, isNull, isNotNull } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { Protocol, Realization, NewRealization } from "../db/schema.js";
import { createProtocolForRealizationSync } from "./protocols.js";
import { getUser } from "../middleware/auth.js";
import {
  applySuggestions,
  computeAutofill,
  pruneAutofillMarks,
  type Suggestion,
} from "../lib/realization-autofill.js";
import { AUTOFILL_FIELDS, type AutofillField } from "../lib/company-config.js";
import {
  isRealizationBilling,
  isRealizationWorkType,
  realizationKindFrom,
  splitLegacyKind,
} from "../lib/realization-kind.js";
import {
  REALIZATION_BILLINGS,
  REALIZATION_WORK_TYPES,
  type RealizationBilling,
  type RealizationWorkType,
} from "../db/schema.js";

const app = new Hono();

type Kind = "service" | "warranty" | "installation";

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

/**
 * Obiekt powiązany z realizacją — pinezka na mapie miesiąca.
 * `lat`/`lng` mogą być null: obiekt znamy, ale nie ma jeszcze współrzędnych
 * (front pokazuje go wtedy w liczniku „bez lokalizacji”, nie na mapie).
 */
export interface RealizationLocation {
  objectId: number;
  name: string;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  /** "event" = obiekt z wydarzenia kalendarza, "name" = dopasowanie po `site`. */
  source: "event" | "name";
}

function withComputed(
  r: Realization,
  calendarEventId: number | null = null,
  protocol: ProtocolBrief | null = null,
  location: RealizationLocation | null = null,
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
    // Obiekt z współrzędnymi (mapa realizacji); null = nie udało się powiązać.
    location,
  };
}

/** Klucz porównania nazw obiektów: bez białych znaków po bokach, bez wielkości liter. */
const nameKey = (s: string) => s.trim().toLocaleLowerCase("pl-PL");

/**
 * Waliduje i normalizuje body — zwraca payload albo komunikat błędu.
 *
 * Realizację opisują dwa pola: `workType` (rodzaj prac) i `billing` (typ
 * rozliczenia). Starszy klient przysyła tylko `kind` — rozbijamy je wtedy przez
 * `splitLegacyKind`. `kind` NIGDY nie jest brane z body wprost: wyliczamy je z
 * pary, żeby pole zgodnościowe nie rozjechało się z rodzajem i typem.
 */
function parseBody(body: Record<string, unknown>): { data?: Partial<NewRealization>; error?: string } {
  const date = typeof body.date === "string" ? body.date : "";
  const site = typeof body.site === "string" ? body.site.trim() : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Nieprawidłowa data (wymagany format YYYY-MM-DD)" };
  if (!site) return { error: "Obiekt jest wymagany" };

  const legacy = splitLegacyKind(typeof body.kind === "string" ? body.kind : null);
  let workType: RealizationWorkType;
  let billing: RealizationBilling;

  if (body.workType === undefined || body.workType === null) {
    workType = legacy.workType;
  } else if (isRealizationWorkType(body.workType)) {
    workType = body.workType;
  } else {
    return { error: `Nieprawidłowy rodzaj realizacji (dozwolone: ${REALIZATION_WORK_TYPES.join(", ")})` };
  }

  if (body.billing === undefined || body.billing === null) {
    billing = legacy.billing;
  } else if (isRealizationBilling(body.billing)) {
    billing = body.billing;
  } else {
    return { error: `Nieprawidłowy typ rozliczenia (dozwolone: ${REALIZATION_BILLINGS.join(", ")})` };
  }

  // Klient przysłał samo `kind` — musi to być znana wartość, inaczej cicho
  // wpadlibyśmy na „serwis płatny” zamiast powiedzieć, że payload jest zły.
  if (body.workType === undefined && body.billing === undefined) {
    const kind = body.kind;
    if (kind !== "service" && kind !== "warranty" && kind !== "installation") {
      return { error: "Nieprawidłowy typ realizacji" };
    }
  }

  const kind: Kind = realizationKindFrom(workType, billing);

  const num = (v: unknown) => {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const invoiced = Boolean(body.invoiced);
  return {
    data: {
      date,
      site,
      workType,
      billing,
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
      // Obiekt wskazany przez wydarzenie kalendarza (mapa realizacji).
      objectId: schema.objects.id,
      objectName: schema.objects.name,
      objectAddress: schema.objects.address,
      objectCity: schema.objects.city,
      objectLat: schema.objects.latitude,
      objectLng: schema.objects.longitude,
    })
    .from(schema.realizations)
    .leftJoin(schema.calendarEvents, eq(schema.calendarEvents.realizationId, schema.realizations.id))
    .leftJoin(schema.protocols, eq(schema.protocols.realizationId, schema.realizations.id))
    .leftJoin(schema.objects, eq(schema.objects.id, schema.calendarEvents.objectId))
    .where(and(...conds))
    .orderBy(asc(schema.realizations.date), asc(schema.realizations.id));

  // Realizacje bez wydarzenia (wpisy ręczne, import z arkusza) próbujemy dopiąć
  // do obiektu po nazwie — dokładnej, bez wielkości liter. Szukamy tylko wśród
  // obiektów, które MAJĄ współrzędne: bez nich dopasowanie i tak nic nie wnosi,
  // a mniej kandydatów = mniej pomyłek przy powtarzających się nazwach.
  // Żadnego geokodowania na żądanie listy — wyłącznie to, co już jest w bazie.
  const byName = new Map<string, RealizationLocation>();
  if (rows.some((row) => row.objectId == null && row.r.site.trim())) {
    const geocoded = await db
      .select({
        id: schema.objects.id,
        name: schema.objects.name,
        address: schema.objects.address,
        city: schema.objects.city,
        lat: schema.objects.latitude,
        lng: schema.objects.longitude,
      })
      .from(schema.objects)
      .where(and(isNotNull(schema.objects.latitude), isNotNull(schema.objects.longitude)));
    for (const o of geocoded) {
      const key = nameKey(o.name);
      // Przy duplikatach nazw wygrywa pierwszy (najstarszy) obiekt.
      if (key && !byName.has(key)) {
        byName.set(key, {
          objectId: o.id,
          name: o.name,
          address: o.address ?? null,
          city: o.city ?? null,
          lat: o.lat ?? null,
          lng: o.lng ?? null,
          source: "name",
        });
      }
    }
  }

  return c.json({
    success: true,
    data: rows.map((row) => {
      const location: RealizationLocation | null =
        row.objectId != null
          ? {
              objectId: row.objectId,
              name: row.objectName ?? "",
              address: row.objectAddress ?? null,
              city: row.objectCity ?? null,
              lat: row.objectLat ?? null,
              lng: row.objectLng ?? null,
              source: "event",
            }
          : byName.get(nameKey(row.r.site)) ?? null;

      return withComputed(
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
        location,
      );
    }),
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

  // Liczone po NOWYCH polach (`billing` + `workType`), ale w dotychczasowym
  // kształcie odpowiedzi: „przychód” to realizacje płatne (montaże osobno),
  // „bezpłatne” to gwarancyjne RAZEM z darmowymi.
  const isFree = (r: Realization) => r.billing === "warranty" || r.billing === "free";
  const isInstallation = (r: Realization) => r.workType === "montaz";

  let paidServices = 0;
  let installations = 0;
  let freePotential = 0;
  let freeCost = 0;
  // Zachowany kształt: service = płatne prace inne niż montaż, installation =
  // płatne montaże, warranty = wszystko bezpłatne (gwarancja + darmowe).
  const counts = { service: 0, warranty: 0, installation: 0 };
  const byWorkType: Record<RealizationWorkType, number> = {
    serwis: 0,
    montaz: 0,
    wizja: 0,
    demontaz: 0,
    konserwacja: 0,
    inne: 0,
  };
  const byBilling: Record<RealizationBilling, number> = { paid: 0, warranty: 0, free: 0 };
  let uninvoiced = 0;

  for (const r of monthRows) {
    byWorkType[r.workType] += 1;
    byBilling[r.billing] += 1;
    if (isFree(r)) {
      counts.warranty += 1;
      freePotential += totalOf(r);
      freeCost += labourCostOf(r);
    } else if (isInstallation(r)) {
      counts.installation += 1;
      installations += totalOf(r);
    } else {
      counts.service += 1;
      paidServices += totalOf(r);
    }
    if (!r.invoiced && !isFree(r)) uninvoiced += 1;
  }

  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    let revenue = 0;
    let loss = 0;
    for (const r of yearRows) {
      if (parseInt(r.date.slice(5, 7)) !== m) continue;
      if (isFree(r)) loss += labourCostOf(r);
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
      // Rozbicia po nowych wymiarach — dokładka do `counts`, nic z niego nie znika.
      byWorkType,
      byBilling,
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

// ---------------------------------------------------------------------------
// Automatyczne uzupełnianie (src/lib/realization-autofill.ts)
// ---------------------------------------------------------------------------

/** Odpowiedź realizacji w kształcie znanym tabeli (computed + link do wydarzenia + protokół). */
function realizationPayload(r: Realization) {
  const link = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(eq(schema.calendarEvents.realizationId, r.id))
    .get();
  return withComputed(r, link?.id ?? null, protocolBriefFor(r.id));
}

/** Lista pól z body → tylko znane nazwy; zwraca błąd przy nieznanej wartości. */
function parseFields(raw: unknown): { fields?: AutofillField[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "Wskaż pola do uzupełnienia (fields: string[])" };
  }
  const known = new Set<string>(AUTOFILL_FIELDS);
  const out: AutofillField[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !known.has(v)) {
      return { error: `Nieznane pole automatu: ${String(v)}` };
    }
    if (!out.includes(v as AutofillField)) out.push(v as AutofillField);
  }
  return { fields: out };
}

/**
 * Podgląd automatu — nic nie zapisuje (poza leniwym uzupełnieniem współrzędnych
 * obiektu w geo.ts). Brak sieci nie jest błędem: kalkulacja km po prostu wypada
 * z sugestii i ląduje w `warnings` + `context.distanceError`.
 */
app.get("/:id/autofill", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator" }, 400);
  }

  const result = await computeAutofill(id);
  if (!result) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono realizacji" }, 404);
  }

  const r = db.select().from(schema.realizations).where(eq(schema.realizations.id, id)).get();
  return c.json({
    success: true,
    data: {
      suggestions: result.suggestions,
      warnings: result.warnings,
      context: result.context,
      realization: r ? realizationPayload(r) : null,
    },
  });
});

/**
 * Zapis wskazanych sugestii. Realizacja zafakturowana → 400 (nietykalna).
 * `expectedUpdatedAt` opcjonalne — gdy podane, zapis przechodzi tylko przy zgodnym znaczniku.
 */
app.post("/:id/autofill", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator" }, 400);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const { fields, error } = parseFields(body.fields);
  if (error || !fields) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const result = await computeAutofill(id);
  if (!result) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono realizacji" }, 404);
  }
  if (result.context.invoiced) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Realizacja jest zafakturowana — automat nie może jej zmienić" },
      400
    );
  }

  const outcome = applySuggestions(id, result.suggestions, {
    fields,
    user: getUser(c),
    expectedUpdatedAt: typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null,
    confidentOnly: body.confidentOnly === true,
  });

  if (outcome.status === "not_found") {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono realizacji" }, 404);
  }
  if (outcome.status === "invoiced") {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Realizacja jest zafakturowana — automat nie może jej zmienić" },
      400
    );
  }
  if (outcome.status === "conflict") {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Realizacja została zmieniona przez kogoś innego. Odśwież i spróbuj ponownie." },
      409
    );
  }

  // `data` to zaktualizowana realizacja (front czyta ją wprost, jak z PUT /realizations/:id)
  // wzbogacona o metadane zapisu; `data.realization` to ta sama realizacja pod jawnym kluczem,
  // żeby czytelne było, co jest czym, bez zgadywania po kształcie.
  const saved = realizationPayload(outcome.realization);
  return c.json({
    success: true,
    data: {
      ...saved,
      realization: saved,
      applied: outcome.applied,
      skipped: outcome.skipped,
      warnings: result.warnings,
    },
    message: outcome.applied.length > 0 ? "Realizacja uzupełniona automatycznie" : "Nie było czego uzupełnić",
  });
});

/**
 * Masowe uzupełnianie („Uzupełnij brakujące" dla widocznego miesiąca).
 * `apply: false` (domyślnie) = sam podgląd; `apply: true` = zapis. Domyślnie
 * zapisujemy WYŁĄCZNIE sugestie pewne (pola puste/zerowe) — sprzeczności
 * wymagają decyzji człowieka w dialogu pojedynczej realizacji.
 */
app.post("/autofill/bulk", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (ids.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Wskaż realizacje (ids: number[])" }, 400);
  }
  if (ids.length > 200) {
    return c.json<ApiResponse<null>>({ success: false, error: "Maks. 200 realizacji naraz" }, 400);
  }

  let fields: AutofillField[] | null = null;
  if (body.fields !== undefined) {
    const parsed = parseFields(body.fields);
    if (parsed.error || !parsed.fields) {
      return c.json<ApiResponse<null>>({ success: false, error: parsed.error }, 400);
    }
    fields = parsed.fields;
  }

  const apply = body.apply === true;
  const confidentOnly = body.confidentOnly !== false;
  const user = getUser(c);

  const items: {
    id: number;
    site: string;
    date: string;
    invoiced: boolean;
    suggestions: Suggestion[];
    warnings: string[];
    applied: AutofillField[];
    error: string | null;
  }[] = [];

  for (const id of ids) {
    const result = await computeAutofill(id);
    if (!result) {
      items.push({
        id,
        site: "",
        date: "",
        invoiced: false,
        suggestions: [],
        warnings: [],
        applied: [],
        error: "Nie znaleziono realizacji",
      });
      continue;
    }

    const usable = result.suggestions.filter(
      (s) => (!confidentOnly || s.confident) && (fields === null || fields.includes(s.field))
    );
    let applied: AutofillField[] = [];
    let error: string | null = null;

    if (result.context.invoiced) {
      error = "Realizacja zafakturowana — pominięta";
    } else if (apply && usable.length > 0) {
      const outcome = applySuggestions(id, result.suggestions, {
        fields: usable.map((s) => s.field),
        user,
        confidentOnly,
      });
      if (outcome.status === "ok") applied = outcome.applied;
      else error = outcome.status === "conflict" ? "Realizacja zmieniona w międzyczasie" : "Nie znaleziono realizacji";
    }

    items.push({
      id,
      site: result.context.site,
      date: result.context.date,
      invoiced: result.context.invoiced,
      suggestions: usable,
      warnings: result.warnings,
      applied,
      error,
    });
  }

  return c.json({
    success: true,
    data: {
      applied: apply,
      items,
      totals: {
        realizations: items.length,
        withSuggestions: items.filter((i) => i.suggestions.length > 0).length,
        appliedFields: items.reduce((n, i) => n + i.applied.length, 0),
        skipped: items.filter((i) => i.error !== null).length,
      },
    },
    message: apply
      ? `Uzupełniono ${items.reduce((n, i) => n + i.applied.length, 0)} pól w ${items.filter((i) => i.applied.length > 0).length} realizacjach`
      : `Podgląd dla ${items.length} realizacji`,
  });
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

  // Ręczna edycja kasuje ślad automatu dla pól, których wartość się zmieniła —
  // badge „auto" nigdy nie wisi nad liczbą wpisaną przez człowieka.
  const autofill = pruneAutofillMarks(existing[0].autofill, data as Record<string, unknown>);

  const result = await db
    .update(schema.realizations)
    .set({ ...data, autofill, updatedAt: new Date().toISOString() })
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
