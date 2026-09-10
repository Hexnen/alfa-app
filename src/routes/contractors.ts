import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, and, sql, desc, asc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { ContractorInput, ApiResponse } from "../types/index.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { monthlyValueOf } from "../lib/abonament-split.js";

const app = new Hono();

/** True when a better-sqlite3 error is a UNIQUE-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

// Check contractor by NIP
app.get("/by-nip/:nip", async (c) => {
  const nip = c.req.param("nip");
  const normalizedNip = normalizeNIP(nip);
  
  if (!validateNIP(normalizedNip)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Invalid NIP format" },
      400
    );
  }
  
  const contractor = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.nip, normalizedNip))
    .limit(1);
  
  if (contractor.length === 0) {
    return c.json<ApiResponse<{ exists: boolean; normalizedNip: string }>>({
      success: true,
      data: { exists: false, normalizedNip },
    });
  }
  
  return c.json<ApiResponse<typeof contractor[0] & { exists: boolean; normalizedNip: string }>>({
    success: true,
    data: {
      ...contractor[0],
      exists: true,
      normalizedNip,
    },
  });
});

/**
 * Sortowanie listy kontrahentów. Klucze `objects`, `value`, `cost` i `profit` liczą
 * się po GROUP BY — SQLite dopuszcza funkcje agregujące w ORDER BY grupowanego
 * zapytania, więc nie trzeba powtarzać ich jako aliasu ani opakowywać w podzapytanie.
 *
 * Nazwy kolumn w agregatach piszemy DOSŁOWNIE (`objects.monthly_zdw`), bo coalesce
 * z dwóch kolumn tej samej tabeli i tak nie skorzysta z aliasu drizzle — a zapis
 * kwalifikowany jest jednoznaczny (ten sam wzorzec co w routes/objects.ts).
 */
const SORT_COLUMNS = {
  name: sql`lower(${schema.contractors.name})`,
  city: sql`lower(coalesce(${schema.contractors.city}, ''))`,
  // Kontrahenci bez opiekuna zawsze na końcu alfabetu (tak jak na liście obiektów).
  salesperson: sql`lower(coalesce(${schema.salespeople.lastName}, 'zzzz'))`,
  objects: sql`count(${schema.objects.id})`,
  // Przychód miesięczny portfela = abonament + dzierżawa sprzętu ze wszystkich obiektów.
  value: sql`coalesce(sum(coalesce(objects.monthly_zdw, 0) + coalesce(objects.monthly_ofi, 0) + coalesce(objects.monthly_rental, 0)), 0)`,
  cost: sql`coalesce(sum(objects.monthly_cost), 0)`,
  profit: sql`coalesce(sum(coalesce(objects.monthly_zdw, 0) + coalesce(objects.monthly_ofi, 0) + coalesce(objects.monthly_rental, 0)), 0) - coalesce(sum(objects.monthly_cost), 0)`,
  created: sql`${schema.contractors.createdAt}`,
} as const;

export type ContractorSortKey = keyof typeof SORT_COLUMNS;

function isSortKey(v: string): v is ContractorSortKey {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, v);
}

/** Liczba z query stringa; puste/śmieci → undefined (filtr się nie nakłada). */
function numberParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Lista kontrahentów z podsumowaniem ich obiektów (liczba, ile aktywnych, suma abonamentów).
 * Agregaty liczy baza jednym LEFT JOIN-em — front pokazuje je przy każdym kontrahencie,
 * a w widoku rozwiniętym dociąga jeszcze same obiekty (GET /objects).
 */
app.get("/", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  // Zakładki: "1" = aktualni, "0" = archiwalni, brak parametru = wszyscy.
  const activeParam = c.req.query("active");
  const salespersonParam = c.req.query("salespersonId");
  const companyParam = c.req.query("companyId");
  // Widełki sumy abonamentów całego portfela kontrahenta.
  const minValue = numberParam(c.req.query("minValue"));
  const maxValue = numberParam(c.req.query("maxValue"));
  // "1" = tylko kontrahenci z abonamentem, "0" = tylko bez; brak parametru = wszyscy.
  const hasValue = c.req.query("hasValue");
  // "1" = ma choć jeden obiekt z uzupełnionym kosztem, "0" = nie ma żadnego.
  const hasCost = c.req.query("hasCost");
  const sortRaw = c.req.query("sort") || "name";
  const sort: ContractorSortKey = isSortKey(sortRaw) ? sortRaw : "name";
  const dir = c.req.query("dir") === "desc" ? "desc" : "asc";
  const searchClause = search
    ? or(
        like(schema.contractors.name, `%${search}%`),
        like(schema.contractors.nip, `%${search}%`),
        like(schema.contractors.city, `%${search}%`)
      )
    : undefined;
  const activeClause =
    activeParam === "1"
      ? eq(schema.contractors.active, true)
      : activeParam === "0"
        ? eq(schema.contractors.active, false)
        : undefined;
  // "none" = bez przypisanego handlowca (przydaje się do wyłapania zaniedbanych klientów).
  const salespersonClause =
    salespersonParam === "none"
      ? sql`${schema.contractors.salespersonId} is null`
      : salespersonParam
        ? eq(schema.contractors.salespersonId, parseInt(salespersonParam))
        : undefined;
  // Spółka nie jest atrybutem kontrahenta tylko jego obiektów, więc filtr znaczy
  // „ma PRZYNAJMNIEJ JEDEN obiekt w tej spółce" ("none" = obiekt bez przypisanej
  // spółki). EXISTS zamiast warunku na dołączonej tabeli, żeby nie okroić agregatów
  // liczonych po GROUP BY — kontrahent nadal pokazuje sumy z całego swojego portfela.
  const companyClause =
    companyParam === "none"
      ? sql`exists (select 1 from objects o_company where o_company.contractor_id = contractors.id and o_company.company_id is null)`
      : companyParam
        ? sql`exists (select 1 from objects o_company where o_company.contractor_id = contractors.id and o_company.company_id = ${parseInt(companyParam)})`
        : undefined;
  // Kwoty filtrujemy po SUMIE portfela kontrahenta, a nie po dołączonych wierszach.
  // Podzapytanie skorelowane (ten sam wzorzec, co filtr spółki wyżej) trzyma filtr
  // w WHERE, więc jeden `whereClause` obsługuje listę, licznik `total`, sumy i liczniki
  // zakładek naraz. Przez HAVING trzeba by powtórzyć grupowanie w każdej z tych czterech
  // kwerend i pilnować, żeby się nie rozjechały — a rozjazd widać od razu w paginacji.
  const portfolioValueSql = sql`(select coalesce(sum(coalesce(o_value.monthly_zdw, 0) + coalesce(o_value.monthly_ofi, 0) + coalesce(o_value.monthly_rental, 0)), 0) from objects o_value where o_value.contractor_id = contractors.id)`;
  // Kontrahent bez ANI JEDNEJ wpisanej kwoty nie wpada w widełki — brak wartości to nie
  // jest zero, więc „do 500 zł" nie może łapać portfela, któremu nikt nic nie wycenił
  // (ta sama zasada, co na liście obiektów).
  const hasAnyRevenueSql = sql`exists (select 1 from objects o_value where o_value.contractor_id = contractors.id and (o_value.monthly_zdw is not null or o_value.monthly_ofi is not null or o_value.monthly_rental is not null))`;
  const minValueClause =
    minValue !== undefined
      ? sql`${hasAnyRevenueSql} and ${portfolioValueSql} >= ${minValue}`
      : undefined;
  const maxValueClause =
    maxValue !== undefined
      ? sql`${hasAnyRevenueSql} and ${portfolioValueSql} <= ${maxValue}`
      : undefined;
  const hasValueClause =
    hasValue === "1"
      ? sql`${portfolioValueSql} > 0`
      : hasValue === "0"
        ? sql`${portfolioValueSql} = 0`
        : undefined;
  // Koszt: „z uzupełnionym" = kontrahent ma CHOĆ JEDEN obiekt z wpisanym kosztem,
  // „bez" = nie ma żadnego takiego obiektu. Liczy się IS NOT NULL, a nie suma — koszt
  // 0 zł jest uzupełnioną informacją, a NULL znaczy „nikt jeszcze nie wpisał" i nie może
  // udawać stuprocentowej marży (jak na liście obiektów). Kontrahent z częściowo
  // uzupełnionymi kosztami wpada więc do „z uzupełnionym" — bo jakiś koszt już zna.
  const hasCostClause =
    hasCost === "1"
      ? sql`exists (select 1 from objects o_cost where o_cost.contractor_id = contractors.id and o_cost.monthly_cost is not null)`
      : hasCost === "0"
        ? sql`not exists (select 1 from objects o_cost where o_cost.contractor_id = contractors.id and o_cost.monthly_cost is not null)`
        : undefined;

  // Warunki BEZ zakładki — z nich liczymy liczniki obu zakładek, żeby pokazywały, ile
  // jest pozycji przy aktualnych filtrach, a nie ile jest w ogóle (wzorzec `baseClause`
  // z listy obiektów).
  const baseParts = [
    searchClause,
    salespersonClause,
    companyClause,
    minValueClause,
    maxValueClause,
    hasValueClause,
    hasCostClause,
  ].filter(Boolean);
  const baseClause = baseParts.length > 1 ? and(...baseParts) : baseParts[0];
  const parts = activeClause ? [...baseParts, activeClause] : baseParts;
  const whereClause = parts.length > 1 ? and(...parts) : parts[0];

  // Puste kwoty na koniec listy w OBU kierunkach — inaczej sortowanie rosnąco po wartości,
  // koszcie czy zysku zaczynałoby się od kontrahentów, którym nikt jeszcze nic nie wpisał.
  // Agregat daje im 0 (coalesce), więc „puste" rozpoznajemy osobno: po tym, czy jest choć
  // jeden obiekt z uzupełnioną kwotą. Kontrahent bez obiektów też jest „pusty".
  const NULLS_LAST: Partial<Record<ContractorSortKey, SQL>> = {
    value: sql`case when sum(case when objects.monthly_zdw is not null or objects.monthly_ofi is not null or objects.monthly_rental is not null then 1 else 0 end) = 0 then 1 else 0 end`,
    cost: sql`case when sum(case when objects.monthly_cost is not null then 1 else 0 end) = 0 then 1 else 0 end`,
    profit: sql`case when sum(case when objects.monthly_zdw is not null or objects.monthly_ofi is not null or objects.monthly_rental is not null or objects.monthly_cost is not null then 1 else 0 end) = 0 then 1 else 0 end`,
  };
  const column = SORT_COLUMNS[sort];
  const direction = dir === "desc" ? desc : asc;
  // Tie-break po nazwie, żeby kolejność była powtarzalna między stronami paginacji.
  const nameTieBreak = asc(sql`lower(${schema.contractors.name})`);
  const orderBy = NULLS_LAST[sort]
    ? [NULLS_LAST[sort]!, direction(column), nameTieBreak]
    : [direction(column), nameTieBreak];

  const rows = await db
    .select({
      contractor: schema.contractors,
      salesperson: {
        id: schema.salespeople.id,
        firstName: schema.salespeople.firstName,
        lastName: schema.salespeople.lastName,
        active: schema.salespeople.active,
      },
      objectsCount: sql<number>`count(${schema.objects.id})`,
      activeObjectsCount: sql<number>`sum(case when ${schema.objects.status} = 'active' then 1 else 0 end)`,
      objectsMonthlyValue: sql<number>`coalesce(sum(coalesce(objects.monthly_zdw, 0) + coalesce(objects.monthly_ofi, 0) + coalesce(objects.monthly_rental, 0)), 0)`,
      objectsMonthlyCost: sql<number>`coalesce(sum(${schema.objects.monthlyCost}), 0)`,
      objectsSetupCost: sql<number>`coalesce(sum(${schema.objects.setupCost}), 0)`,
    })
    .from(schema.contractors)
    .leftJoin(schema.objects, eq(schema.objects.contractorId, schema.contractors.id))
    .leftJoin(schema.salespeople, eq(schema.salespeople.id, schema.contractors.salespersonId))
    .where(whereClause)
    .groupBy(schema.contractors.id)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  // Licznik MUSI respektować szukajkę — inaczej paginacja po filtrze pokazuje złe „total”.
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contractors)
    .where(whereClause);
  const total = countResult[0].count;

  // Podsumowanie całego wyniku filtrowania (nie tylko bieżącej strony).
  const totalsResult = await db
    .select({
      objects: sql<number>`count(${schema.objects.id})`,
      value: sql<number>`coalesce(sum(coalesce(objects.monthly_zdw, 0) + coalesce(objects.monthly_ofi, 0) + coalesce(objects.monthly_rental, 0)), 0)`,
      monthlyCost: sql<number>`coalesce(sum(${schema.objects.monthlyCost}), 0)`,
      setupCost: sql<number>`coalesce(sum(${schema.objects.setupCost}), 0)`,
    })
    .from(schema.contractors)
    .leftJoin(schema.objects, eq(schema.objects.contractorId, schema.contractors.id))
    .where(whereClause);

  // Liczniki obu zakładek liczymy ze WSZYSTKICH filtrów poza samą zakładką — mają
  // pokazywać, ile jest aktualnych i archiwalnych przy bieżącym zawężeniu listy.
  // Wcześniej brały pod uwagę wyłącznie szukajkę, więc po wybraniu handlowca albo
  // widełek kwot suma z zakładek nie zgadzała się z `total`.
  const tabsResult = await db
    .select({
      active: sql<number>`sum(case when ${schema.contractors.active} then 1 else 0 end)`,
      archived: sql<number>`sum(case when ${schema.contractors.active} then 0 else 1 end)`,
    })
    .from(schema.contractors)
    .where(baseClause);

  return c.json({
    success: true,
    data: rows.map((r) => ({
      ...r.contractor,
      salesperson: r.salesperson?.id ? r.salesperson : null,
      objectsCount: r.objectsCount ?? 0,
      activeObjectsCount: r.activeObjectsCount ?? 0,
      objectsMonthlyValue: r.objectsMonthlyValue ?? 0,
      objectsMonthlyCost: r.objectsMonthlyCost ?? 0,
      objectsSetupCost: r.objectsSetupCost ?? 0,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    sort,
    dir,
    totalObjects: totalsResult[0].objects ?? 0,
    totalMonthlyValue: totalsResult[0].value ?? 0,
    totalMonthlyCost: totalsResult[0].monthlyCost ?? 0,
    totalSetupCost: totalsResult[0].setupCost ?? 0,
    activeCount: tabsResult[0].active ?? 0,
    archivedCount: tabsResult[0].archived ?? 0,
  });
});

/**
 * Kartoteka kontrahentów w formie listy wyboru — bez paginacji i bez agregatów
 * po obiektach. Listy rozwijane (filtr na /objects, formularz obiektu) muszą
 * pokazywać KOMPLET kontrahentów, a `GET /` z `pageSize=500` gubił ogon
 * kartoteki (624 pozycje) i liczył przy okazji sumy, których select nie używa.
 * MUSI stać PRZED `GET /:id`, inaczej trasa parametryczna przechwyci tę nazwę
 * (ten sam wzorzec co `/monitored-objects/object-catalog`).
 */
app.get("/catalog", async (c) => {
  const rows = await db
    .select({
      id: schema.contractors.id,
      name: schema.contractors.name,
      nip: schema.contractors.nip,
      active: schema.contractors.active,
    })
    .from(schema.contractors)
    .orderBy(asc(sql`lower(${schema.contractors.name})`));

  return c.json({ success: true, data: rows });
});

// Get contractor by ID
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const contractor = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.id, id))
    .limit(1);

  if (contractor.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof contractor[0]>>({
    success: true,
    data: contractor[0],
  });
});

// Get contractor with their objects (with latest history action)
app.get("/:id/objects", async (c) => {
  const id = parseInt(c.req.param("id"));

  const objects = await db
    .select()
    .from(schema.objects)
    .where(eq(schema.objects.contractorId, id));

  // Get latest history action for each object
  const objectsWithHistory = await Promise.all(
    objects.map(async (obj) => {
      const history = await db
        .select()
        .from(schema.objectHistory)
        .where(eq(schema.objectHistory.objectId, obj.id))
        .orderBy(desc(schema.objectHistory.createdAt))
        .limit(1);
      
      return {
        ...obj,
        // Wyliczane z rozbicia — @deprecated `monthly_value` nie jest już
        // źródłem prawdy (patrz src/lib/abonament-split.ts).
        monthlyValue: monthlyValueOf(obj.monthlyZdw, obj.monthlyOfi),
        latestAction: history[0] || null,
      };
    })
  );

  return c.json({
    success: true,
    data: objectsWithHistory,
  });
});

// Create contractor
app.post("/", async (c) => {
  const body = await c.req.json<ContractorInput>();
  
  // Normalize NIP
  const normalizedNip = normalizeNIP(body.nip);
  
  // Validate NIP
  if (!validateNIP(normalizedNip)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Invalid NIP format or checksum" },
      400
    );
  }

  // Check if NIP already exists
  const existing = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.nip, normalizedNip))
    .limit(1);

  if (existing.length > 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor with this NIP already exists" },
      409
    );
  }

  let result;
  try {
    result = await db
      .insert(schema.contractors)
      .values({
        name: body.name,
        nip: normalizedNip,
        address: body.address,
        city: body.city,
        postalCode: body.postalCode,
        phone: body.phone,
        email: body.email,
        contactPerson: body.contactPerson,
        notes: body.notes,
        salespersonId: body.salespersonId ?? null,
        // Dane z wykazu MF, gdy formularz skorzystał z wyszukiwarki firm.
        regon: body.regon,
        krs: body.krs,
        vatStatus: body.vatStatus,
        vatCheckedAt: body.vatCheckedAt,
      })
      .returning();
  } catch (err) {
    // A concurrent request may have inserted the same NIP after the check
    // above but before this insert; the UNIQUE constraint enforces integrity,
    // translate it into the same friendly 409 instead of a raw 500.
    if (isUniqueViolation(err)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Contractor with this NIP already exists" },
        409
      );
    }
    throw err;
  }

  return c.json<ApiResponse<typeof result[0]>>(
    {
      success: true,
      data: result[0],
      message: "Contractor created successfully",
    },
    201
  );
});

// Update contractor
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<ContractorInput>>();

  // Check if contractor exists
  const existing = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor not found" },
      404
    );
  }

  // Check if NIP is being changed and already exists
  if (body.nip) {
    const normalizedNip = normalizeNIP(body.nip);
    
    if (!validateNIP(normalizedNip)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Invalid NIP format or checksum" },
        400
      );
    }
    
    if (normalizedNip !== existing[0].nip) {
      const nipExists = await db
        .select()
        .from(schema.contractors)
        .where(eq(schema.contractors.nip, normalizedNip))
        .limit(1);

      if (nipExists.length > 0) {
        return c.json<ApiResponse<null>>(
          { success: false, error: "Contractor with this NIP already exists" },
          409
        );
      }
    }
    
    body.nip = normalizedNip;
  }

  let result;
  try {
    result = await db
      .update(schema.contractors)
      .set({
        ...body,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.contractors.id, id))
      .returning();
  } catch (err) {
    // Same NIP UNIQUE race as on create: a concurrent write may claim the NIP
    // between the check above and this update.
    if (isUniqueViolation(err)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Contractor with this NIP already exists" },
        409
      );
    }
    throw err;
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Contractor updated successfully",
  });
});

// Delete contractor
app.delete("/:id", (c) => {
  const id = parseInt(c.req.param("id"));

  // Has-children check + delete w jednej synchronicznej transakcji — są atomowe
  // na połączeniu, więc równoległy POST /objects nie wciśnie insertu między
  // SELECT a DELETE (co przez onDelete:"cascade" cicho skasowałoby świeży obiekt).
  const blocked = db.transaction((tx) => {
    const child = tx
      .select()
      .from(schema.objects)
      .where(eq(schema.objects.contractorId, id))
      .limit(1)
      .all();
    if (child.length > 0) return true;
    tx.delete(schema.contractors).where(eq(schema.contractors.id, id)).run();
    return false;
  });

  if (blocked) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Cannot delete contractor with existing objects",
      },
      400
    );
  }

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Contractor deleted successfully",
  });
});

export default app;
