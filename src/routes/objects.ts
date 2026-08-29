import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, ne, like, or, and, sql, asc, desc, gte, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type {
  ObjectInput,
  WorkflowTransition,
  ApiResponse,
  ObjectStatus,
  Department,
} from "../types/index.js";

const app = new Hono();

// Handlowiec obiektu i handlowiec jego kontrahenta to ta sama tabela w dwóch rolach,
// więc druga rola wchodzi do zapytania pod aliasem.
const objectSalesperson = alias(schema.salespeople, "object_salesperson");
const contractorSalesperson = alias(schema.salespeople, "contractor_salesperson");

/**
 * Sortowanie listy obiektów. Klucze `type`, `status` i `department` układamy CASE-em,
 * bo alfabetyczne sortowanie wartości z bazy ("active", "in_progress"…) nie ma dla
 * użytkownika sensu: status ma naturalną kolejność procesu, a typ i dział sortujemy
 * w kolejności polskich etykiet z frontu (frontend/src/lib/utils.ts).
 *
 * `monthly_value`, `monthly_cost` i wyliczony z nich zysk bywają puste („brak abonamentu”,
 * „koszt nieuzupełniony”) — puste zawsze lądują na końcu, niezależnie od kierunku, żeby nie
 * zajmowały pierwszej strony przy sortowaniu rosnąco (patrz NULLS_LAST niżej).
 */
const SORT_COLUMNS = {
  name: sql`lower(${schema.objects.name})`,
  contractor: sql`lower(coalesce(${schema.contractors.name}, ''))`,
  city: sql`lower(coalesce(${schema.objects.city}, ''))`,
  type: sql`case ${schema.objects.type} when 'alarm' then 0 when 'mixed' then 1 when 'monitoring' then 2 when 'physical' then 3 else 4 end`,
  status: sql`case ${schema.objects.status} when 'pending' then 0 when 'in_progress' then 1 when 'active' then 2 when 'inactive' then 3 else 4 end`,
  department: sql`case ${schema.objects.department} when 'sales' then 0 when 'accounting' then 1 when 'technical' then 2 else 3 end`,
  company: sql`lower(coalesce(${schema.companies.name}, 'zzzz'))`,
  // Handlowiec obiektu, a gdy go nie ma — opiekun kontrahenta (tak samo pokazuje to lista).
  salesperson: sql`lower(coalesce(${objectSalesperson.lastName}, ${contractorSalesperson.lastName}, 'zzzz'))`,
  value: sql`${schema.objects.monthlyValue}`,
  cost: sql`${schema.objects.monthlyCost}`,
  // Nazwy kolumn piszemy DOSŁOWNIE, bo coalesce z dwóch kolumn tej samej tabeli
  // i tak nie skorzysta z aliasu drizzle — a zapis kwalifikowany jest jednoznaczny.
  profit: sql`coalesce(objects.monthly_value, 0) - coalesce(objects.monthly_cost, 0)`,
  created: sql`${schema.objects.createdAt}`,
} as const;

export type ObjectSortKey = keyof typeof SORT_COLUMNS;

function isSortKey(v: string): v is ObjectSortKey {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, v);
}

/** Liczba z query stringa; puste/śmieci → undefined (filtr się nie nakłada). */
function numberParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

// Get all objects with filtering
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const department = c.req.query("department");
  const type = c.req.query("type");
  const contractorId = c.req.query("contractorId");
  const minValue = numberParam(c.req.query("minValue"));
  const maxValue = numberParam(c.req.query("maxValue"));
  // "1" = tylko obiekty z abonamentem, "0" = tylko bez; brak parametru = wszystkie.
  const hasValue = c.req.query("hasValue");
  const minCost = numberParam(c.req.query("minCost"));
  const maxCost = numberParam(c.req.query("maxCost"));
  // "1" = tylko obiekty z uzupełnionym kosztem, "0" = tylko nieuzupełnione.
  const hasCost = c.req.query("hasCost");
  // Zakładki listy: "current" = wszystko poza statusem „nieaktywny", "archived" = tylko on.
  // Brak parametru (albo "all") = obie zakładki naraz, tak jak działało to wcześniej.
  // "none" = obiekty bez handlowca (ani własnego, ani z kontrahenta).
  const salespersonParam = c.req.query("salespersonId");
  // "none" = obiekty bez przypisanej spółki.
  const companyParam = c.req.query("companyId");
  const scope = c.req.query("scope") === "archived" ? "archived" : c.req.query("scope") === "current" ? "current" : "all";
  const sortRaw = c.req.query("sort") || "name";
  const sort: ObjectSortKey = isSortKey(sortRaw) ? sortRaw : "name";
  const dir = c.req.query("dir") === "desc" ? "desc" : "asc";
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        like(schema.objects.name, `%${search}%`),
        like(schema.objects.address, `%${search}%`),
        like(schema.objects.city, `%${search}%`)
      )
    );
  }

  if (status) {
    conditions.push(eq(schema.objects.status, status as ObjectStatus));
  }

  if (department) {
    conditions.push(eq(schema.objects.department, department as Department));
  }

  if (type) {
    conditions.push(
      eq(schema.objects.type, type as "monitoring" | "physical" | "alarm" | "mixed")
    );
  }

  if (contractorId) {
    conditions.push(eq(schema.objects.contractorId, parseInt(contractorId)));
  }

  // Wartość miesięczna: widełki i „ma / nie ma abonamentu”. Obiekt bez kwoty (NULL)
  // nigdy nie wpada w widełki — brak wartości to nie jest zero.
  if (minValue !== undefined) {
    conditions.push(gte(schema.objects.monthlyValue, minValue));
  }
  if (maxValue !== undefined) {
    conditions.push(lte(schema.objects.monthlyValue, maxValue));
  }
  if (hasValue === "1") {
    conditions.push(sql`${schema.objects.monthlyValue} is not null and ${schema.objects.monthlyValue} > 0`);
  } else if (hasValue === "0") {
    conditions.push(sql`${schema.objects.monthlyValue} is null or ${schema.objects.monthlyValue} = 0`);
  }

  // Koszt miesięczny: te same widełki, ale „ma koszt” to wyłącznie IS NOT NULL —
  // koszt 0 zł jest uzupełnioną informacją (obiekt nic nie kosztuje), a NULL znaczy
  // „nikt jeszcze nie wpisał” i nie może udawać stuprocentowej marży.
  if (minCost !== undefined) {
    conditions.push(gte(schema.objects.monthlyCost, minCost));
  }
  if (maxCost !== undefined) {
    conditions.push(lte(schema.objects.monthlyCost, maxCost));
  }
  if (hasCost === "1") {
    conditions.push(sql`${schema.objects.monthlyCost} is not null`);
  } else if (hasCost === "0") {
    conditions.push(sql`${schema.objects.monthlyCost} is null`);
  }

  if (salespersonParam === "none") {
    conditions.push(
      sql`${schema.objects.salespersonId} is null and ${schema.contractors.salespersonId} is null`
    );
  } else if (salespersonParam) {
    const sid = parseInt(salespersonParam);
    // Dopasowanie na tej samej zasadzie, co wyświetlanie: własny handlowiec obiektu,
    // a gdy go nie ma — opiekun kontrahenta.
    conditions.push(
      sql`coalesce(${schema.objects.salespersonId}, ${schema.contractors.salespersonId}) = ${sid}`
    );
  }

  if (companyParam === "none") {
    conditions.push(sql`${schema.objects.companyId} is null`);
  } else if (companyParam) {
    conditions.push(eq(schema.objects.companyId, parseInt(companyParam)));
  }

  // Warunki BEZ zakładki — z nich liczymy liczniki obu zakładek, żeby pokazywały,
  // ile jest pozycji przy aktualnych filtrach, a nie ile jest w ogóle.
  const baseClause = conditions.length > 0 ? and(...conditions) : undefined;
  const scopeCondition =
    scope === "archived"
      ? eq(schema.objects.status, "inactive")
      : scope === "current"
        ? ne(schema.objects.status, "inactive")
        : undefined;
  if (scopeCondition) conditions.push(scopeCondition);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Puste kwoty na koniec listy w OBU kierunkach — inaczej sortowanie rosnąco po wartości,
  // koszcie czy zysku pokazywałoby najpierw obiekty bez wpisanych kwot. Przy zysku „puste”
  // to dopiero brak OBU składników: sam brak kosztu wciąż mówi coś o przychodzie.
  const NULLS_LAST: Partial<Record<ObjectSortKey, SQL>> = {
    value: sql`case when objects.monthly_value is null then 1 else 0 end`,
    cost: sql`case when objects.monthly_cost is null then 1 else 0 end`,
    profit: sql`case when objects.monthly_value is null and objects.monthly_cost is null then 1 else 0 end`,
  };
  const column = SORT_COLUMNS[sort];
  const direction = dir === "desc" ? desc : asc;
  const orderBy = NULLS_LAST[sort]
    ? [NULLS_LAST[sort]!, direction(column), asc(schema.objects.name)]
    : [direction(column), asc(schema.objects.name)];

  const objects = await db
    .select({
      object: schema.objects,
      contractor: schema.contractors,
      company: {
        id: schema.companies.id,
        name: schema.companies.name,
        active: schema.companies.active,
      },
      objectSales: {
        id: objectSalesperson.id,
        firstName: objectSalesperson.firstName,
        lastName: objectSalesperson.lastName,
        active: objectSalesperson.active,
      },
      contractorSales: {
        id: contractorSalesperson.id,
        firstName: contractorSalesperson.firstName,
        lastName: contractorSalesperson.lastName,
        active: contractorSalesperson.active,
      },
    })
    .from(schema.objects)
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .leftJoin(schema.companies, eq(schema.companies.id, schema.objects.companyId))
    .leftJoin(objectSalesperson, eq(objectSalesperson.id, schema.objects.salespersonId))
    .leftJoin(contractorSalesperson, eq(contractorSalesperson.id, schema.contractors.salespersonId))
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  // Podsumowanie liczymy dla CAŁEGO wyniku filtrowania (nie tylko bieżącej strony) —
  // front pokazuje je pod tabelą jako „N obiektów · suma abonamentów”.
  const summaryRows = await db
    .select({
      count: sql<number>`count(*)`,
      sum: sql<number | null>`sum(${schema.objects.monthlyValue})`,
      withValue: sql<number>`sum(case when ${schema.objects.monthlyValue} is not null and ${schema.objects.monthlyValue} > 0 then 1 else 0 end)`,
      sumCost: sql<number | null>`sum(${schema.objects.monthlyCost})`,
      sumSetup: sql<number | null>`sum(${schema.objects.setupCost})`,
      // Licznik uzupełnionych kosztów — front musi wiedzieć, na ilu obiektach opiera się
      // suma kosztów, żeby nie pokazywać marży policzonej z połowy danych jako pewnej.
      withCost: sql<number>`sum(case when objects.monthly_cost is not null then 1 else 0 end)`,
    })
    .from(schema.objects)
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .where(whereClause);
  const summary = summaryRows[0];
  const total = summary.count;

  const scopeRows = await db
    .select({
      archived: sql<number>`sum(case when ${schema.objects.status} = 'inactive' then 1 else 0 end)`,
      current: sql<number>`sum(case when ${schema.objects.status} = 'inactive' then 0 else 1 end)`,
    })
    .from(schema.objects)
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .where(baseClause);

  return c.json({
    success: true,
    data: objects.map((o) => ({
      ...o.object,
      contractor: o.contractor,
      company: o.company?.id ? o.company : null,
      // `inherited` mówi UI, że handlowiec jest odziedziczony po kontrahencie,
      // a nie przypisany do samego obiektu.
      salesperson: o.objectSales?.id
        ? { ...o.objectSales, inherited: false }
        : o.contractorSales?.id
          ? { ...o.contractorSales, inherited: true }
          : null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    sort,
    dir,
    totalMonthlyValue: summary.sum ?? 0,
    withMonthlyValue: summary.withValue ?? 0,
    totalMonthlyCost: summary.sumCost ?? 0,
    totalSetupCost: summary.sumSetup ?? 0,
    withMonthlyCost: summary.withCost ?? 0,
    scope,
    currentCount: scopeRows[0].current ?? 0,
    archivedCount: scopeRows[0].archived ?? 0,
  });
});

// Get object by ID with contractor and contracts
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const result = await db
    .select({
      object: schema.objects,
      contractor: schema.contractors,
    })
    .from(schema.objects)
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .where(eq(schema.objects.id, id))
    .limit(1);

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

  const contracts = await db
    .select()
    .from(schema.contracts)
    .where(eq(schema.contracts.objectId, id));

  return c.json({
    success: true,
    data: {
      ...result[0].object,
      contractor: result[0].contractor,
      contracts,
    },
  });
});

// Create object
app.post("/", async (c) => {
  const body = await c.req.json<ObjectInput>();

  // Kontrola kontrahenta, wstawienie obiektu i wpis historii w jednej
  // synchronicznej transakcji — obiekt i jego wpis "created" powstają atomowo,
  // więc nie ma obiektu bez historii ani przeplotu między dwoma zapisami.
  const result = db.transaction((tx) => {
    const contractor = tx
      .select()
      .from(schema.contractors)
      .where(eq(schema.contractors.id, body.contractorId))
      .get();

    if (!contractor) return null;

    const inserted = tx
      .insert(schema.objects)
      .values({
        contractorId: body.contractorId,
        name: body.name,
        address: body.address,
        city: body.city,
        type: body.type,
        installationType: body.installationType,
        status: body.status || "pending",
        department: body.department || "sales",
        monthlyValue: body.monthlyValue,
        // Lista pól jest tu wypisana jawnie (bez spreadu body), więc każdy nowy
        // atrybut trzeba dopisać — inaczej edycja go zapisuje, a zakładanie gubi.
        monthlyCost: body.monthlyCost ?? null,
        setupCost: body.setupCost ?? null,
        notes: body.notes,
        companyId: body.companyId ?? null,
        salespersonId: body.salespersonId ?? null,
      })
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: inserted[0].id,
        action: "created",
        description: `Object created in ${body.department || "sales"} department`,
        newValue: JSON.stringify(inserted[0]),
      })
      .run();

    return inserted;
  });

  if (!result) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor not found" },
      400
    );
  }

  return c.json<ApiResponse<typeof result[0]>>(
    {
      success: true,
      data: result[0],
      message: "Object created successfully",
    },
    201
  );
});

// Update object
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<ObjectInput>>();

  // Odczyt, zapis i wpis historii w jednej synchronicznej transakcji —
  // serializuje równoległe edycje (drugi PUT widzi zapis pierwszego) i buduje
  // oldValue z tego samego odczytu, więc audyt nie kłamie o przejściu.
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.objects)
      .where(eq(schema.objects.id, id))
      .get();

    if (!existing) return null;

    const updated = tx
      .update(schema.objects)
      .set({
        ...body,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.objects.id, id))
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: id,
        action: "updated",
        description: "Object details updated",
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(updated[0]),
      })
      .run();

    return updated;
  });

  if (!result) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Object updated successfully",
  });
});

// Workflow transition - change status and department
app.post("/:id/transition", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<WorkflowTransition>();

  // Odczyt, zapis i wpis historii w jednej synchronicznej transakcji —
  // oldStatus/oldDepartment pochodzą z tego samego odczytu co zapis, więc
  // równoległe przejścia się serializują, a audyt jest spójny.
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.objects)
      .where(eq(schema.objects.id, id))
      .get();

    if (!existing) return null;

    const oldStatus = existing.status;
    const oldDepartment = existing.department;

    const updated = tx
      .update(schema.objects)
      .set({
        status: body.newStatus,
        department: body.newDepartment,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.objects.id, id))
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: id,
        action: "transition",
        description:
          body.description ||
          `Status: ${oldStatus} → ${body.newStatus}, Department: ${oldDepartment} → ${body.newDepartment}`,
        oldValue: JSON.stringify({ status: oldStatus, department: oldDepartment }),
        newValue: JSON.stringify({
          status: body.newStatus,
          department: body.newDepartment,
        }),
      })
      .run();

    return updated;
  });

  if (!result) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Object transitioned successfully",
  });
});

// Delete object
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Kontrola istnienia umów i usunięcie obiektu w jednej synchronicznej
  // transakcji — inaczej równoległy POST /contracts mógłby wstawić umowę między
  // sprawdzeniem a usunięciem, a kaskada (contracts.objectId onDelete:cascade)
  // po cichu skasowałaby świeżo dodaną umowę mimo guardu. Atomowo: albo delete
  // jest zablokowany, albo umowa nie mogła powstać.
  const blocked = db.transaction((tx) => {
    const child = tx
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.objectId, id))
      .limit(1)
      .all();

    if (child.length > 0) return true;

    tx.delete(schema.objects).where(eq(schema.objects.id, id)).run();
    return false;
  });

  if (blocked) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Cannot delete object with existing contracts",
      },
      400
    );
  }

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Object deleted successfully",
  });
});

export default app;
