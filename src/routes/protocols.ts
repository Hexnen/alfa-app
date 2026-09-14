import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, asc, desc, notInArray, and } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { CalendarEvent, Protocol, Realization } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import {
  buildProtocolPrefill,
  isProtocolPrefillField,
  prefillInsertValues,
  prefillPatch,
  PROTOCOL_PREFILL_LABELS,
  protocolPrefillSuggestions,
  type ProtocolPrefillField,
} from "../lib/protocol-prefill.js";
import { logActivity } from "../lib/activity-log.js";
import {
  afterProtocolSigned,
  checkSignaturePng,
  parseSignerName,
  protocolConflictMessage,
  signProtocolSync,
  softDeleteProtocolNoteSync,
  syncProtocolNoteForOffice,
  updateProtocolSync,
  withParsedItems,
  SIGNER_NAME_REQUIRED,
} from "../lib/protocols.js";
import { getSetting, setSetting } from "../lib/settings.js";

const app = new Hono();

// Wzór pozycji i typ pozycji mieszkają w src/lib/protocol-prefill.ts (tam powstaje
// wstępne wypełnienie protokołu); tutaj tylko re-eksport dla dotychczasowych importów.
export {
  DEFAULT_ITEMS,
  type ProtocolItem,
} from "../lib/protocol-prefill.js";
import type { ProtocolItem } from "../lib/protocol-prefill.js";

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
  // Licznik „najwyższy numer, jaki KIEDYKOLWIEK padł w tym miesiącu”. Protokoły
  // usuwa się TWARDO (DELETE), więc samo max(number) po tabeli wydawało numer
  // skasowanego dokumentu drugi raz — a protokół z podpisem klienta bywa już
  // wtedy wydrukowany i wpięty do teczki. Wysoki stan zapisujemy obok, w
  // app_settings, i nigdy go nie cofamy.
  const key = protocolSeqKey(year, month);
  const stored = parseInt(getSetting(key, tx) ?? "");
  const seq = Math.max(maxSeq, Number.isFinite(stored) ? stored : 0) + 1;
  setSetting(key, String(seq), null, tx);
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

/** Klucz wysokiego stanu numeracji w app_settings (jeden na miesiąc). */
function protocolSeqKey(year: string, month: string): string {
  return `protocols.lastSeq.${year}-${month}`;
}

/**
 * Buduje protokół (prefill) z realizacji — używane też przy tworzeniu realizacji.
 * Wszystkie pola pochodzą z `buildProtocolPrefill` (wydarzenie → obiekt → kontrahent
 * → cennik; szczegóły w src/lib/protocol-prefill.ts), więc szkic protokołu jest od
 * razu wypełniony danymi klienta, adresem, wykonawcami i pozycjami z cennika.
 *
 * Alokacja numeru i insert w jednej transakcji (przekazany tx), więc kolejne
 * numery i ograniczenia UNIQUE(number/realizationId) nie kolidują przy
 * równoległych żądaniach. Idempotentne po realizationId (ON CONFLICT DO NOTHING).
 *
 * `event` przekazuje wołający, który tworzy realizację z wydarzenia — w tym momencie
 * `calendar_events.realization_id` jest jeszcze puste (podpięcie następuje po insercie
 * protokołu), więc bez tego argumentu wydarzenia nie dałoby się odnaleźć.
 */
export function createProtocolForRealizationSync(
  tx: Tx,
  r: Realization,
  event?: CalendarEvent | null
) {
  const prefill = buildProtocolPrefill(tx, r, { event });
  // Szacunki (godziny z normy dnia dla wydarzenia całodniowego) nie wchodzą do dokumentu —
  // czekają jako sugestia w „Uzupełnij z danych”.
  const values = prefillInsertValues(prefill);
  return tx
    .insert(schema.protocols)
    .values({
      realizationId: r.id,
      number: nextProtocolNumberSync(tx, values.workDate),
      workDate: values.workDate,
      workType: values.workType,
      actualHours: values.actualHours,
      actualKm: values.actualKm,
      contractor: values.contractor,
      salesperson: values.salesperson,
      clientName: values.clientName,
      clientNip: values.clientNip,
      clientCity: values.clientCity,
      installationAddress: values.installationAddress,
      contact: values.contact,
      activities: values.activities,
      items: JSON.stringify(values.items),
      status: "draft",
    })
    .onConflictDoNothing({ target: schema.protocols.realizationId })
    .returning()
    .get();
}

// Parsowanie pozycji, edycja i podpis mieszkają w src/lib/protocols.ts (dzieli je
// z panelem technika); tutaj re-eksport dla dotychczasowych importów.
export { withParsedItems } from "../lib/protocols.js";

// Lista protokołów (opcjonalnie filtrowana po roku/miesiącu daty wykonania)
app.get("/", async (c) => {
  const year = c.req.query("year");
  const month = c.req.query("month");

  let query = db
    .select({
      protocol: schema.protocols,
      // MIGAWKA nazwy obiektu na dokument, nie klucz — protokół pokazuje to, co
      // uzgodniono w chwili prac, nawet gdy obiekt później przemianowano. Tożsamość
      // obiektu idzie przez `realizations.object_id` (src/lib/object-identity.ts);
      // złączenie tutaj jest po `realization_id`, więc jest bezpieczne.
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
      // MIGAWKA nazwy obiektu na dokument, nie klucz — protokół pokazuje to, co
      // uzgodniono w chwili prac, nawet gdy obiekt później przemianowano. Tożsamość
      // obiektu idzie przez `realizations.object_id` (src/lib/object-identity.ts);
      // złączenie tutaj jest po `realization_id`, więc jest bezpieczne.
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

// ---------------------------------------------------------------------------
// Uzupełnianie istniejącego protokołu z danych, które system już zna
// (src/lib/protocol-prefill.ts). Podgląd nic nie zapisuje; zapis obejmuje
// WYŁĄCZNIE wskazane pola. Protokół podpisany jest nietykalny → 400.
// ---------------------------------------------------------------------------

/** Protokół + jego realizacja (obie potrzebne do policzenia prefillu). */
function protocolWithRealization(id: number) {
  const protocol = db.select().from(schema.protocols).where(eq(schema.protocols.id, id)).get();
  if (!protocol) return null;
  const realization = db
    .select()
    .from(schema.realizations)
    .where(eq(schema.realizations.id, protocol.realizationId))
    .get();
  return realization ? { protocol, realization } : { protocol, realization: null };
}

/** Protokół podpisany albo zatwierdzony — prefill go nie dotyka. */
function prefillLockReason(p: Protocol): string | null {
  if (p.signedAt || p.signaturePng || p.contentHash) {
    return "Protokół jest podpisany — usuń podpis, zanim uzupełnisz dane.";
  }
  if (p.status === "final") {
    return "Protokół jest zatwierdzony — cofnij zatwierdzenie, zanim uzupełnisz dane.";
  }
  return null;
}

/** Lista pól z body → tylko znane nazwy (wzorzec z realizations.ts). */
function parsePrefillFields(raw: unknown): { fields?: ProtocolPrefillField[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "Wskaż pola do uzupełnienia (fields: string[])" };
  }
  const out: ProtocolPrefillField[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !isProtocolPrefillField(v)) {
      return { error: `Nieznane pole protokołu: ${String(v)}` };
    }
    if (!out.includes(v)) out.push(v);
  }
  return { fields: out };
}

/** Podgląd — sugestie „obecnie → proponowane” wraz ze źródłem. Nic nie zapisuje. */
app.get("/:id/prefill", (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator" }, 400);
  }
  const found = protocolWithRealization(id);
  if (!found) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono protokołu" }, 404);
  }
  const locked = prefillLockReason(found.protocol);
  if (locked) return c.json<ApiResponse<null>>({ success: false, error: locked }, 400);
  if (!found.realization) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Protokół nie ma powiązanej realizacji — nie ma z czego uzupełniać" },
      404
    );
  }

  const prefill = buildProtocolPrefill(db, found.realization);
  return c.json({
    success: true,
    data: {
      suggestions: protocolPrefillSuggestions(found.protocol, prefill, { realization: found.realization }),
      context: prefill.context,
    },
  });
});

/** Zapis wskazanych pól. Nieznane pole → 400, protokół podpisany → 400. */
app.post("/:id/prefill", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator" }, 400);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const { fields, error } = parsePrefillFields(body.fields);
  if (error || !fields) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;

  const user = getUser(c);

  // Odczyt, wyliczenie i zapis w jednej synchronicznej transakcji — prefill jest
  // czysto odczytowy, więc nic nie wychodzi do sieci i nic się nie przeplata.
  const outcome = db.transaction((tx) => {
    const protocol = tx.select().from(schema.protocols).where(eq(schema.protocols.id, id)).get();
    if (!protocol) return { status: 404 as const, error: "Nie znaleziono protokołu" };
    const locked = prefillLockReason(protocol);
    if (locked) return { status: 400 as const, error: locked };
    if (expectedUpdatedAt !== null && protocol.updatedAt !== expectedUpdatedAt) {
      return { status: 409 as const, error: "Protokół został w międzyczasie zmieniony. Odśwież i spróbuj ponownie." };
    }
    const realization = tx
      .select()
      .from(schema.realizations)
      .where(eq(schema.realizations.id, protocol.realizationId))
      .get();
    if (!realization) {
      return {
        status: 404 as const,
        error: "Protokół nie ma powiązanej realizacji — nie ma z czego uzupełniać",
      };
    }

    const prefill = buildProtocolPrefill(tx, realization);
    const suggestions = protocolPrefillSuggestions(protocol, prefill, { realization });
    const applied = fields.filter((f) => suggestions.some((s) => s.field === f));
    const skipped = fields
      .filter((f) => !applied.includes(f))
      .map((f) => ({ field: f, reason: "brak sugestii dla tego pola" }));
    if (applied.length === 0) {
      return { status: 200 as const, protocol, applied, skipped, suggestions };
    }

    const updated = tx
      .update(schema.protocols)
      .set({ ...prefillPatch(applied, prefill), updatedAt: new Date().toISOString() })
      .where(eq(schema.protocols.id, id))
      .returning()
      .all();
    if (updated.length === 0) {
      return { status: 409 as const, error: "Protokół został w międzyczasie zmieniony. Odśwież i spróbuj ponownie." };
    }

    logActivity(tx, {
      entityType: "protocol",
      entityId: id,
      objectId: prefill.context.object?.id ?? null,
      user,
      action: "updated",
      field: "prefill",
      oldValue: null,
      newValue: JSON.stringify(applied),
      summary: `Uzupełniono protokół ${protocol.number} z danych systemu: ${applied
        .map((f) => PROTOCOL_PREFILL_LABELS[f].toLowerCase())
        .join(", ")}`,
      summarySuffix: "(przez automat)",
    });

    return { status: 200 as const, protocol: updated[0], applied, skipped, suggestions };
  });

  if (outcome.status !== 200) {
    return c.json<ApiResponse<null>>({ success: false, error: outcome.error }, outcome.status);
  }

  const saved = withParsedItems(outcome.protocol);
  return c.json({
    success: true,
    data: { ...saved, protocol: saved, applied: outcome.applied, skipped: outcome.skipped },
    message: outcome.applied.length > 0 ? "Protokół uzupełniony" : "Nie było czego uzupełnić",
  });
});

// Edycja protokołu — walidacja i zapis w src/lib/protocols.ts (dzielone z /technik).
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  // Nieparsowalne ciało to 400, a nie 500: `c.req.json()` bez `.catch` wywalało
  // się w środek `app.onError` i dialog protokołu dostawał „Internal Server Error”.
  const body = (await c.req.json<Record<string, unknown>>().catch(() => null)) as unknown;
  // Odczyt + zapis w jednej synchronicznej transakcji — brak przeplotu między
  // SELECT a UPDATE, a równoległe edycje serializują się (bez zgubionych zmian).
  const outcome = db.transaction((tx) => updateProtocolSync(tx, id, body));

  if (outcome.status === 400) {
    return c.json<ApiResponse<null>>({ success: false, error: outcome.error }, 400);
  }
  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono protokołu" }, 404);
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>(
      { success: false, error: protocolConflictMessage(outcome.signed) },
      409
    );
  }

  // Streszczenie w dzienniku wydarzenia idzie za treścią protokołu także wtedy,
  // gdy zapis zrobiło biuro — inaczej kalendarz pokazywał wersję sprzed edycji.
  syncProtocolNoteForOffice(outcome.data, { user: getUser(c) });

  return c.json({
    success: true,
    data: withParsedItems(outcome.data),
    message: "Protokół zapisany",
  });
});

// Podpisanie protokołu — PNG podpisu, imię i nazwisko, czas serwera oraz SHA-256
// z treści protokołu + podpisu (dowód integralności). Logika w src/lib/protocols.ts.
app.post("/:id/sign", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const signaturePng = typeof body.signaturePng === "string" ? body.signaturePng : "";
  // Wspólna walidacja z panelem technika: pusto → 400 (biuro potrafiło podpisać
  // protokół bez nazwiska odbierającego), za długo → przycięte do 120 znaków.
  const signerName = parseSignerName(body.signerName);
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;

  const check = checkSignaturePng(signaturePng);
  if (!check.ok) {
    return c.json<ApiResponse<null>>({ success: false, error: check.error }, 400);
  }
  if (!signerName) {
    return c.json<ApiResponse<null>>({ success: false, error: SIGNER_NAME_REQUIRED }, 400);
  }

  const outcome = db.transaction((tx) =>
    signProtocolSync(tx, id, { signaturePng, signerName, expectedUpdatedAt })
  );

  if (outcome.status === 400) {
    return c.json<ApiResponse<null>>({ success: false, error: outcome.error }, 400);
  }
  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono protokołu" }, 404);
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>({ success: false, error: protocolConflictMessage() }, 409);
  }

  // Dziennik wydarzenia dostaje stan „podpisany” i nazwisko odbierającego —
  // tak samo jak przy podpisie z tabletu.
  syncProtocolNoteForOffice(outcome.data, { user: getUser(c) });

  // Automat realizacji i przeliczenie wyceny — PO commicie (patrz komentarz w module).
  const effects = await afterProtocolSigned(outcome.data.realizationId, getUser(c));
  return c.json({
    success: true,
    data: { ...withParsedItems(outcome.data), autofill: effects.autofill, quote: effects.quote },
    message: effects.message,
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

  // Notatka w kalendarzu też musi przestać twierdzić, że protokół jest
  // podpisany — inaczej biuro widziało w dzienniku nazwisko odbierającego
  // przy dokumencie, z którego podpis właśnie zdjęto.
  syncProtocolNoteForOffice(outcome.data, { user: getUser(c) });

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

  // Notatka systemowa znika RAZEM z protokołem (soft delete, tak jak każde inne
  // usunięcie notatki) — inaczej w dzienniku zlecenia zostawał wpis z linkiem
  // prowadzącym donikąd. `calendar_events.protocol_id` zeruje sam klucz obcy
  // (ON DELETE SET NULL, patrz src/db/schema.ts), numeru protokołu nie zwalnia
  // licznik w app_settings (patrz nextProtocolNumberSync).
  db.transaction((tx) => {
    softDeleteProtocolNoteSync(tx, existing[0]);
    tx.delete(schema.protocols).where(eq(schema.protocols.id, id)).run();
  });

  return c.json<ApiResponse<null>>({ success: true, message: "Protokół usunięty" });
});

export default app;
