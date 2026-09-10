import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, sql, and, ne, asc, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { ApiResponse, ContractStatus } from "../types/index.js";
import {
  asRecord,
  compact,
  isValidationError,
  parseDate,
  parseEnum,
  parseFk,
  parseNumber,
  parseString,
  rejectReadonlyFields,
  STR,
  ValidationError,
} from "../lib/validate.js";

const app = new Hono();

const CONTRACT_STATUSES = ["draft", "active", "expired", "terminated"] as const;

/** Typ transakcji drizzle/better-sqlite3 — helpery działają i na `db`, i na `tx`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Pola umowy z body — jawna lista, każde przez walidator. `undefined` = nie
 * ruszaj (PUT). Rzuca `ValidationError`.
 */
function parseContractFields(raw: unknown) {
  const b = asRecord(raw);
  // `draftId` nadaje wyłącznie „Przenieś do rejestru” (POST /contracts/drafts/:id/promote)
  // — ręczna edycja umowy nie może przypiąć sobie cudzego dokumentu.
  rejectReadonlyFields(b, ["draftId"]);
  return {
    objectId: parseFk(b.objectId, "objects", "Obiekt", { nullable: false }),
    contractNumber: parseString(b.contractNumber, { label: "Numer umowy", max: STR.SHORT }),
    startDate: parseDate(b.startDate, "Data rozpoczęcia"),
    endDate: parseDate(b.endDate, "Data zakończenia"),
    value: parseNumber(b.value, { label: "Wartość umowy", max: 1_000_000_000 }),
    filePath: parseString(b.filePath, { label: "Plik umowy", max: STR.URL }),
    status: parseEnum(b.status, CONTRACT_STATUSES, "Status"),
  };
}

/** `endDate` nie może wypadać przed `startDate`. */
function assertDateOrder(startDate: string, endDate: string | null | undefined): void {
  if (endDate && endDate < startDate) {
    throw new ValidationError("Data zakończenia nie może być wcześniejsza niż data rozpoczęcia");
  }
}

/**
 * Czy inny wiersz ma już ten numer umowy (numer identyfikuje dokument — musi być unikalny).
 *
 * Eksportowane, bo tej samej kontroli używa „Przenieś do rejestru”
 * (src/routes/contract-drafts.ts) — numer draftu musi być wolny w rejestrze.
 */
export function numberTaken(tx: Tx | typeof db, contractNumber: string, exceptId?: number): boolean {
  const conditions: SQL[] = [eq(schema.contracts.contractNumber, contractNumber)];
  if (exceptId !== undefined) conditions.push(ne(schema.contracts.id, exceptId));
  return (
    tx
      .select({ id: schema.contracts.id })
      .from(schema.contracts)
      .where(and(...conditions))
      .get() !== undefined
  );
}

/**
 * Umowy tego samego obiektu, których okres zachodzi na podany (bez umów
 * rozwiązanych/wygasłych i bez samej edytowanej). Nakładanie się NIE blokuje
 * zapisu — bywa celowe (aneks, umowa przejściowa) — wraca jako `warnings`.
 */
function overlapWarnings(
  tx: Tx | typeof db,
  objectId: number,
  startDate: string,
  endDate: string | null,
  exceptId?: number
): string[] {
  const rows = tx
    .select({
      id: schema.contracts.id,
      contractNumber: schema.contracts.contractNumber,
      startDate: schema.contracts.startDate,
      endDate: schema.contracts.endDate,
      status: schema.contracts.status,
    })
    .from(schema.contracts)
    .where(eq(schema.contracts.objectId, objectId))
    .all();
  const warnings: string[] = [];
  for (const r of rows) {
    if (r.id === exceptId) continue;
    if (r.status === "expired" || r.status === "terminated") continue;
    // Okresy otwarte (bez daty końca) trwają „do odwołania".
    const aEnd = endDate ?? "9999-12-31";
    const bEnd = r.endDate ?? "9999-12-31";
    if (startDate <= bEnd && r.startDate <= aEnd) {
      warnings.push(
        `Okres nakłada się na umowę ${r.contractNumber} (${r.startDate} – ${r.endDate ?? "bez końca"})`
      );
    }
  }
  return warnings;
}

/**
 * Sortowanie listy umów. `status` układamy CASE-em, bo alfabetyczne sortowanie
 * wartości z bazy ("draft", "expired"…) nie ma dla użytkownika sensu — status ma
 * naturalną kolejność życia dokumentu (szkic → aktywna → wygasła → rozwiązana).
 *
 * Kontrahent nie jest atrybutem umowy, tylko jej OBIEKTU — sortujemy więc po nazwie
 * kontrahenta z dołączonej tabeli, dokładnie tak, jak lista go pokazuje.
 *
 * `value` i `end` bywają puste (wartości nikt nie wpisał, umowa jest bezterminowa) —
 * puste zawsze lądują na końcu, niezależnie od kierunku (patrz NULLS_LAST niżej).
 */
const SORT_COLUMNS = {
  number: sql`lower(${schema.contracts.contractNumber})`,
  object: sql`lower(coalesce(${schema.objects.name}, ''))`,
  contractor: sql`lower(coalesce(${schema.contractors.name}, ''))`,
  start: sql`${schema.contracts.startDate}`,
  end: sql`${schema.contracts.endDate}`,
  value: sql`${schema.contracts.value}`,
  status: sql`case ${schema.contracts.status} when 'draft' then 0 when 'active' then 1 when 'expired' then 2 when 'terminated' then 3 else 4 end`,
  created: sql`${schema.contracts.createdAt}`,
} as const;

export type ContractSortKey = keyof typeof SORT_COLUMNS;

function isSortKey(v: string): v is ContractSortKey {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, v);
}

/** Liczba z query stringa; puste/śmieci → undefined (filtr się nie nakłada). */
function numberParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Data „YYYY-MM-DD" z query stringa; cokolwiek innego → undefined (filtr się nie nakłada). */
function dateParam(raw: string | undefined): string | undefined {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return undefined;
  return raw.trim();
}

/**
 * Adres DOCX-a przypiętego draftu — to, co panel rejestru pokazuje w podglądzie.
 *
 * `null` znaczy „nie ma czego pokazać”: albo umowa nie wyszła z draftu (wpis
 * ręczny), albo draft istnieje, ale dokumentu jeszcze nie wygenerowano. Front
 * nie musi więc znać wewnętrznej ścieżki plików ani jej składać sam.
 *
 * `inline=1`, bo to podgląd w przeglądarce, a nie pobieranie pliku.
 *
 * Eksportowane — tej samej postaci adresu używa odpowiedź „Przenieś do
 * rejestru” (src/routes/contract-drafts.ts).
 */
export function draftFileUrlOf(draftId: number | null, storedPath: string | null | undefined): string | null {
  if (draftId === null || !storedPath) return null;
  return `/api/contracts/drafts/${draftId}/file?inline=1`;
}

// Get all contracts
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const objectId = c.req.query("objectId");
  // Kontrahent umowy = kontrahent jej obiektu (umowa nie ma własnego pola).
  const contractorId = c.req.query("contractorId");
  const minValue = numberParam(c.req.query("minValue"));
  const maxValue = numberParam(c.req.query("maxValue"));
  // "1" = tylko umowy z wpisaną wartością, "0" = tylko bez; brak parametru = wszystkie.
  const hasValue = c.req.query("hasValue");
  // Zakres obowiązywania: umowy, których OKRES ZACHODZI na podany przedział
  // (`activeFrom` – `activeTo`). Jeden przedział zamiast dwóch osobnych filtrów na
  // datę początku i końca: „obowiązujące w dniu X" to po prostu from = to = X, a
  // „kończące się do X" wychodzi z samego `activeTo`. Umowa bez daty końca trwa
  // do odwołania, więc zawsze zachodzi na koniec przedziału.
  const activeFrom = dateParam(c.req.query("activeFrom"));
  const activeTo = dateParam(c.req.query("activeTo"));
  const sortRaw = c.req.query("sort") || "number";
  const sort: ContractSortKey = isSortKey(sortRaw) ? sortRaw : "number";
  const dir = c.req.query("dir") === "desc" ? "desc" : "asc";
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const offset = (page - 1) * pageSize;

  // Warunki do tablicy i jedno `and(...)`: kolejne `.where()` w drizzle nadpisuje
  // poprzednie, więc `search+status` filtrowało wyłącznie po ostatnim.
  const conditions: SQL[] = [];
  if (search) {
    conditions.push(
      or(
        // identity-ok: to SZUKAJKA użytkownika (filtr listy), a nie złączenie —
        // wynik trafia na ekran, nigdy do powiązania dokumentu z obiektem.
        like(schema.contracts.contractNumber, `%${search}%`), // identity-ok
        like(schema.objects.name, `%${search}%`),
        like(schema.contractors.name, `%${search}%`)
      )!
    );
  }
  if (status && (CONTRACT_STATUSES as readonly string[]).includes(status)) {
    conditions.push(eq(schema.contracts.status, status as ContractStatus));
  }
  if (objectId) {
    const oid = parseInt(objectId);
    if (Number.isInteger(oid)) conditions.push(eq(schema.contracts.objectId, oid));
  }
  if (contractorId) {
    const cid = parseInt(contractorId);
    if (Number.isInteger(cid)) conditions.push(eq(schema.objects.contractorId, cid));
  }

  // Wartość umowy: widełki i „ma / nie ma wpisanej kwoty". Pusta wartość to NIE zero —
  // umowa bez kwoty nie może wpadać w widełki „do 10 000 zł" (ta sama zasada, co przy
  // kosztach na liście obiektów).
  if (minValue !== undefined) {
    conditions.push(sql`${schema.contracts.value} is not null and ${schema.contracts.value} >= ${minValue}`);
  }
  if (maxValue !== undefined) {
    conditions.push(sql`${schema.contracts.value} is not null and ${schema.contracts.value} <= ${maxValue}`);
  }
  if (hasValue === "1") {
    conditions.push(sql`${schema.contracts.value} is not null`);
  } else if (hasValue === "0") {
    conditions.push(sql`${schema.contracts.value} is null`);
  }

  // Okresy otwarte (bez daty końca) traktujemy jak trwające „do odwołania" — tak samo
  // jak ostrzeżenia o nakładaniu się umów wyżej w tym pliku.
  if (activeFrom !== undefined) {
    conditions.push(
      sql`(${schema.contracts.endDate} is null or ${schema.contracts.endDate} >= ${activeFrom})`
    );
  }
  if (activeTo !== undefined) {
    conditions.push(sql`${schema.contracts.startDate} <= ${activeTo}`);
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Puste kwoty i bezterminowe umowy na koniec listy w OBU kierunkach — inaczej
  // sortowanie rosnąco po wartości albo po dacie zakończenia zaczynałoby się od
  // pozycji, o których nic nie wiadomo.
  const NULLS_LAST: Partial<Record<ContractSortKey, SQL>> = {
    value: sql`case when ${schema.contracts.value} is null then 1 else 0 end`,
    end: sql`case when ${schema.contracts.endDate} is null then 1 else 0 end`,
  };
  const column = SORT_COLUMNS[sort];
  const direction = dir === "desc" ? desc : asc;
  // Tie-break po numerze umowy (jest unikalny), żeby kolejność była powtarzalna
  // między stronami paginacji.
  const numberTieBreak = asc(sql`lower(${schema.contracts.contractNumber})`);
  const orderBy = NULLS_LAST[sort]
    ? [NULLS_LAST[sort]!, direction(column), numberTieBreak]
    : [direction(column), numberTieBreak];

  const contracts = await db
    .select({
      contract: schema.contracts,
      object: schema.objects,
      contractor: schema.contractors,
      // Sam fakt istnienia pliku draftu — bez tego front nie odróżni „umowa
      // z dokumentem" od „draft skasowany / jeszcze nie wygenerowany".
      draftStoredPath: schema.contractDrafts.generatedStoredPath,
    })
    .from(schema.contracts)
    .leftJoin(schema.objects, eq(schema.contracts.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .leftJoin(schema.contractDrafts, eq(schema.contracts.draftId, schema.contractDrafts.id))
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  // `total` i sumy z TYM SAMYM where I TYMI SAMYMI złączeniami — filtry sięgają teraz
  // obiektu i kontrahenta, więc licznik bez joinów wywracałby się na nieznanej kolumnie,
  // a paginacja pokazywałaby złą liczbę stron.
  const summaryRows = await db
    .select({
      count: sql<number>`count(*)`,
      sum: sql<number | null>`sum(${schema.contracts.value})`,
      // Ile umów ma UZUPEŁNIONĄ wartość — bez tego suma udaje pełną, choć liczy się
      // z części dokumentów (ta sama zasada, co przy kosztach obiektów).
      withValue: sql<number>`sum(case when ${schema.contracts.value} is not null then 1 else 0 end)`,
    })
    .from(schema.contracts)
    .leftJoin(schema.objects, eq(schema.contracts.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .where(whereClause);
  const total = summaryRows[0].count;

  return c.json({
    success: true,
    data: contracts.map((c) => ({
      ...c.contract,
      object: c.object,
      contractor: c.contractor,
      draftFileUrl: draftFileUrlOf(c.contract.draftId, c.draftStoredPath),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    sort,
    dir,
    totalValue: summaryRows[0].sum ?? 0,
    withValue: summaryRows[0].withValue ?? 0,
  });
});

// Get contract by ID
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const result = await db
    .select({
      contract: schema.contracts,
      object: schema.objects,
      contractor: schema.contractors,
      draftStoredPath: schema.contractDrafts.generatedStoredPath,
    })
    .from(schema.contracts)
    .leftJoin(schema.objects, eq(schema.contracts.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .leftJoin(schema.contractDrafts, eq(schema.contracts.draftId, schema.contractDrafts.id))
    .where(eq(schema.contracts.id, id))
    .limit(1);

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }

  return c.json({
    success: true,
    data: {
      ...result[0].contract,
      object: result[0].object,
      contractor: result[0].contractor,
      draftFileUrl: draftFileUrlOf(result[0].contract.draftId, result[0].draftStoredPath),
    },
  });
});

// Create contract
app.post("/", async (c) => {
  let f: ReturnType<typeof parseContractFields>;
  let objectId: number;
  let contractNumber: string;
  let startDate: string;
  try {
    f = parseContractFields(await c.req.json().catch(() => undefined));
    if (f.objectId == null) throw new ValidationError("Pole „Obiekt” jest wymagane");
    if (!f.contractNumber) throw new ValidationError("Pole „Numer umowy” jest wymagane");
    if (!f.startDate) throw new ValidationError("Pole „Data rozpoczęcia” jest wymagane");
    assertDateOrder(f.startDate, f.endDate);
    objectId = f.objectId;
    contractNumber = f.contractNumber;
    startDate = f.startDate;
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }

  // Wstawienie kontraktu i wpisu do objectHistory w jednej synchronicznej
  // transakcji — obie operacje zatwierdzają się razem (brak kontraktu bez
  // wpisu w historii, nawet przy błędzie/przeplocie między żądaniami).
  // Kontrola unikalności numeru też w środku — dwa równoległe POST-y z tym
  // samym numerem nie przecisną się między SELECT-em a INSERT-em.
  const outcome = db.transaction((tx) => {
    if (numberTaken(tx, contractNumber)) return { status: 409 as const };

    const warnings = overlapWarnings(tx, objectId, startDate, f.endDate ?? null);

    const inserted = tx
      .insert(schema.contracts)
      .values({
        objectId,
        contractNumber,
        startDate,
        endDate: f.endDate ?? null,
        value: f.value ?? null,
        filePath: f.filePath ?? null,
        status: f.status ?? "draft",
      })
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId,
        action: "contract_created",
        description: `Contract ${contractNumber} created`,
        newValue: JSON.stringify(inserted[0]),
      })
      .run();

    return { status: 201 as const, data: inserted[0], warnings };
  });

  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>(
      { success: false, error: `Umowa o numerze „${contractNumber}” już istnieje` },
      409
    );
  }

  return c.json(
    {
      success: true,
      data: outcome.data,
      warnings: outcome.warnings,
      message: "Contract created successfully",
    },
    201
  );
});

// Update contract
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  let f: ReturnType<typeof parseContractFields>;
  try {
    f = parseContractFields(await c.req.json().catch(() => undefined));
    // Pola NOT NULL nie mogą zostać wyczyszczone jawnym `null`.
    if (f.contractNumber === null) throw new ValidationError("Pole „Numer umowy” nie może być puste");
    if (f.startDate === null) throw new ValidationError("Pole „Data rozpoczęcia” nie może być pusta");
    if (f.status === undefined && "status" in asRecord(await c.req.json().catch(() => ({})))) {
      throw new ValidationError("Pole „Status” nie może być puste");
    }
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }

  // Read-modify-write + wpis do historii w jednej synchronicznej transakcji:
  // `existing` czytany jest wewnątrz transakcji, więc równoległe edycje tego
  // samego kontraktu serializują się (bez zgubionych aktualizacji), a oldValue
  // w audycie odzwierciedla stan bezpośrednio przed tą zmianą.
  const outcome = db.transaction((tx) => {
    const existingRows = tx
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.id, id))
      .limit(1)
      .all();
    if (existingRows.length === 0) return { status: 404 as const };
    const existing = existingRows[0];

    // Reguły między polami sprawdzamy na stanie PO scaleniu — inaczej samo
    // przesunięcie daty końca przed istniejący start przechodziłoby bez słowa.
    const merged = {
      objectId: f.objectId ?? existing.objectId,
      contractNumber: f.contractNumber ?? existing.contractNumber,
      startDate: f.startDate ?? existing.startDate,
      endDate: f.endDate === undefined ? existing.endDate : f.endDate,
    };
    if (merged.endDate && merged.endDate < merged.startDate) {
      return {
        status: 400 as const,
        error: "Data zakończenia nie może być wcześniejsza niż data rozpoczęcia",
      };
    }
    if (merged.contractNumber !== existing.contractNumber && numberTaken(tx, merged.contractNumber, id)) {
      return { status: 409 as const, error: `Umowa o numerze „${merged.contractNumber}” już istnieje` };
    }

    const patch = compact({
      objectId: f.objectId ?? undefined,
      contractNumber: f.contractNumber ?? undefined,
      startDate: f.startDate ?? undefined,
      endDate: f.endDate,
      value: f.value,
      filePath: f.filePath,
      status: f.status,
    });
    if (Object.keys(patch).length === 0) {
      return { status: 400 as const, error: "Brak pól do zmiany" };
    }

    const updated = tx
      .update(schema.contracts)
      .set(patch)
      .where(eq(schema.contracts.id, id))
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: existing.objectId,
        action: "contract_updated",
        description: `Contract ${existing.contractNumber} updated`,
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(updated[0]),
      })
      .run();

    const warnings = overlapWarnings(tx, merged.objectId, merged.startDate, merged.endDate, id);
    return { status: 200 as const, data: updated[0], warnings };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }
  if (outcome.status === 400 || outcome.status === 409) {
    return c.json<ApiResponse<null>>({ success: false, error: outcome.error }, outcome.status);
  }

  return c.json({
    success: true,
    data: outcome.data,
    warnings: outcome.warnings,
    message: "Contract updated successfully",
  });
});

// Delete contract
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Usunięcie kontraktu i wpis do historii razem w jednej transakcji.
  const outcome = db.transaction((tx) => {
    const existingRows = tx
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.id, id))
      .limit(1)
      .all();
    if (existingRows.length === 0) return { status: 404 as const };
    const existing = existingRows[0];

    tx.delete(schema.contracts).where(eq(schema.contracts.id, id)).run();

    tx.insert(schema.objectHistory)
      .values({
        objectId: existing.objectId,
        action: "contract_deleted",
        description: `Contract ${existing.contractNumber} deleted`,
        oldValue: JSON.stringify(existing),
      })
      .run();

    return { status: 200 as const };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Contract deleted successfully",
  });
});

export default app;
