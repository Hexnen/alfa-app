import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { eq, ne, like, or, and, sql, asc, desc, gte, lte, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { removeAttachmentDir } from "../lib/calendar-attachments.js";
import { alias } from "drizzle-orm/sqlite-core";
import type {
  ObjectInput,
  ObjectServiceInput,
  WorkflowTransition,
  ApiResponse,
  ObjectStatus,
  Department,
} from "../types/index.js";
import {
  applyServiceRows,
  ENDING_SOON_DEFAULT_DAYS,
  endingSoonSql,
  flagsFromServices,
  legacyObjectType,
  readObjectServices,
  syncObjectServiceFlags,
  todayIso,
  type ComputedObjectFlags,
} from "../lib/object-services.js";
import { parseObjectServices } from "../lib/object-services-validate.js";
import { parseMapsUrlInput } from "../lib/maps-url.js";
import { isValidationError, parseDate } from "../lib/validate.js";
import {
  HAS_ANY_REVENUE_SQL,
  MONTHLY_REVENUE_SQL,
  monthlyValueOf,
  splitAbonament,
} from "../lib/abonament-split.js";
import {
  addObjectNote,
  deleteObjectNote,
  listObjectNotes,
  updateObjectNote,
} from "../lib/object-notes.js";
import { ApiError } from "../lib/calendar-labels.js";
import { getUser } from "../middleware/auth.js";

const app = new Hono();

// Handlowiec obiektu i handlowiec jego kontrahenta to ta sama tabela w dwóch rolach,
// więc druga rola wchodzi do zapytania pod aliasem.
const objectSalesperson = alias(schema.salespeople, "object_salesperson");
const contractorSalesperson = alias(schema.salespeople, "contractor_salesperson");

/**
 * Filtr po USŁUDZE (`?service=`). Usługi nie są rozłączne — obiekt z kamerami
 * i SSWiN-em wpada do obu filtrów — więc filtr wybiera obiekty MAJĄCE daną usługę,
 * a nie „obiekty tego typu”. Klucze są te same, co etykiety na froncie
 * (frontend/src/lib/utils.ts → objectServiceLabels).
 */
const SERVICE_COLUMNS = {
  kamery: schema.objects.hasCameras,
  sswin: schema.objects.hasSswin,
  wideorecepcja: schema.objects.hasVideoreception,
  ofi: schema.objects.hasOfi,
} as const;

type ServiceKey = keyof typeof SERVICE_COLUMNS;

function isServiceKey(v: string): v is ServiceKey {
  return Object.prototype.hasOwnProperty.call(SERVICE_COLUMNS, v);
}

/**
 * Sortowanie listy obiektów. Klucze `status` i `department` układamy CASE-em,
 * bo alfabetyczne sortowanie wartości z bazy ("active", "in_progress"…) nie ma dla
 * użytkownika sensu: status ma naturalną kolejność procesu, a dział sortujemy
 * w kolejności polskich etykiet z frontu (frontend/src/lib/utils.ts).
 *
 * Nie ma klucza po usługach: usługi to zbiór, a nie jedna wartość — nie da się
 * ich ustawić w porządek, który cokolwiek znaczy. Kolumna „Usługi” na liście
 * jest więc nieklikalna.
 *
 * Abonamenty, `monthly_cost` i wyliczony z nich zysk bywają puste („brak abonamentu”,
 * „koszt nieuzupełniony”) — puste zawsze lądują na końcu, niezależnie od kierunku, żeby nie
 * zajmowały pierwszej strony przy sortowaniu rosnąco (patrz NULLS_LAST niżej).
 */
const SORT_COLUMNS = {
  name: sql`lower(${schema.objects.name})`,
  contractor: sql`lower(coalesce(${schema.contractors.name}, ''))`,
  city: sql`lower(coalesce(${schema.objects.city}, ''))`,
  status: sql`case ${schema.objects.status} when 'pending' then 0 when 'in_progress' then 1 when 'active' then 2 when 'inactive' then 3 else 4 end`,
  department: sql`case ${schema.objects.department} when 'sales' then 0 when 'accounting' then 1 when 'technical' then 2 else 3 end`,
  company: sql`lower(coalesce(${schema.companies.name}, 'zzzz'))`,
  // Handlowiec obiektu, a gdy go nie ma — opiekun kontrahenta (tak samo pokazuje to lista).
  salesperson: sql`lower(coalesce(${objectSalesperson.lastName}, ${contractorSalesperson.lastName}, 'zzzz'))`,
  // Przychód miesięczny = abonament ZDW + abonament OFI + dzierżawa sprzętu
  // (klient płaci wszystkie trzy pozycje).
  value: MONTHLY_REVENUE_SQL,
  cost: sql`${schema.objects.monthlyCost}`,
  // Nazwy kolumn w tych wyrażeniach są DOSŁOWNE (patrz src/lib/abonament-split.ts),
  // bo coalesce z kilku kolumn tej samej tabeli i tak nie skorzysta z aliasu drizzle.
  profit: sql`${MONTHLY_REVENUE_SQL} - coalesce(objects.monthly_cost, 0)`,
  // Przewidywane zakończenie obsługi obiektu; puste = „bezterminowo” i zawsze
  // ląduje na końcu listy (NULLS_LAST), niezależnie od kierunku sortowania.
  expectedEnd: sql`${schema.objects.expectedEndDate}`,
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

/**
 * Zapis abonamentu: źródłem prawdy są `monthlyZdw` i `monthlyOfi`, ale starsi
 * klienci API (i skrypty) wciąż przysyłają jedną kwotę `monthlyValue`. Taką
 * kwotę rozbijamy tą samą regułą, co migracja (src/lib/abonament-split.ts) —
 * po usługach obiektu — zamiast wpisywać ją do @deprecated kolumny, której już
 * nikt nie czyta. Gdy przyszło rozbicie, `monthlyValue` z body jest ignorowane:
 * jest polem WYLICZANYM i nie ma prawa nadpisać składników.
 */
function abonamentPatch(
  body: Partial<ObjectInput>,
  services: { hasOfi: boolean; hasCameras: boolean; hasSswin: boolean; hasVideoreception: boolean }
): { monthlyZdw?: number | null; monthlyOfi?: number | null } {
  if (body.monthlyZdw !== undefined || body.monthlyOfi !== undefined) {
    return {
      ...(body.monthlyZdw !== undefined ? { monthlyZdw: body.monthlyZdw ?? null } : {}),
      ...(body.monthlyOfi !== undefined ? { monthlyOfi: body.monthlyOfi ?? null } : {}),
    };
  }
  if (body.monthlyValue === undefined) return {};
  const split = splitAbonament({ monthlyValue: body.monthlyValue ?? null, ...services });
  return { monthlyZdw: split.monthlyZdw, monthlyOfi: split.monthlyOfi };
}

// Get all objects with filtering
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const department = c.req.query("department");
  const service = c.req.query("service");
  const contractorId = c.req.query("contractorId");
  const minValue = numberParam(c.req.query("minValue"));
  const maxValue = numberParam(c.req.query("maxValue"));
  // "1" = tylko obiekty z abonamentem, "0" = tylko bez; brak parametru = wszystkie.
  const hasValue = c.req.query("hasValue");
  const minCost = numberParam(c.req.query("minCost"));
  const maxCost = numberParam(c.req.query("maxCost"));
  // "1" = tylko obiekty z uzupełnionym kosztem, "0" = tylko nieuzupełnione.
  const hasCost = c.req.query("hasCost");
  // Filtr „kończące się w ciągu N dni” — z kafelka Analityki (/objects?endingIn=90).
  const endingIn = numberParam(c.req.query("endingIn"));
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
        // identity-ok: to SZUKAJKA użytkownika (filtr listy), a nie złączenie — wynik
        // trafia na ekran, nigdy do powiązania dokumentu z obiektem.
        like(schema.objects.name, `%${search}%`), // identity-ok
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

  // Nieznany klucz usługi po prostu nie nakłada filtru (tak samo jak nieznany
  // klucz sortowania) — literówka w URL-u nie może zwracać pustej listy.
  if (service && isServiceKey(service)) {
    conditions.push(eq(SERVICE_COLUMNS[service], true));
  }

  if (contractorId) {
    conditions.push(eq(schema.objects.contractorId, parseInt(contractorId)));
  }

  // Wartość miesięczna: widełki i „ma / nie ma przychodu”. Filtrujemy po SUMIE
  // obu abonamentów i dzierżawy — dla klienta to jedna kwota płacona co miesiąc,
  // a obiekt z samą dzierżawą też ma przychód i nie może wypaść z widełek.
  // Obiekt bez żadnej z kwot ma sumę 0 i nie trafia w widełki dodatnie.
  const monthlyRevenueSql = MONTHLY_REVENUE_SQL;
  // Obiekt bez ŻADNEJ z trzech kwot nie wpada w widełki — brak wartości to nie
  // jest zero. Sam `coalesce(...)` by go wpuszczał: „do 500 zł" łapałoby też
  // obiekty, którym nikt nic nie wpisał, i to był niezmiennik sprzed dzierżawy.
  const hasAnyRevenueSql = HAS_ANY_REVENUE_SQL;
  if (minValue !== undefined) {
    conditions.push(sql`${hasAnyRevenueSql} and ${monthlyRevenueSql} >= ${minValue}`);
  }
  if (maxValue !== undefined) {
    conditions.push(sql`${hasAnyRevenueSql} and ${monthlyRevenueSql} <= ${maxValue}`);
  }
  if (hasValue === "1") {
    conditions.push(sql`${monthlyRevenueSql} > 0`);
  } else if (hasValue === "0") {
    conditions.push(sql`${monthlyRevenueSql} = 0`);
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

  // Horyzont zestawienia: parametr filtra, a gdy go nie ma — te same 90 dni,
  // co kafelek w Analityce, żeby licznik pod listą znaczył zawsze to samo.
  const today = todayIso();
  const endingHorizonDays =
    endingIn !== undefined && endingIn >= 0 ? Math.floor(endingIn) : ENDING_SOON_DEFAULT_DAYS;
  // Predykat „kończy się” mieszka w src/lib/object-services.ts — TĘ SAMĄ definicję
  // liczy analityka (`endingSoon` w GET /analytics/obiekty), więc kafelek i lista,
  // do której linkuje, nie mają jak pokazać dwóch różnych liczb.
  const endingSoon = endingSoonSql(today, endingHorizonDays);
  if (endingIn !== undefined && endingIn >= 0) {
    conditions.push(endingSoon);
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
    // „Puste" przy przychodzie to brak WSZYSTKICH kwot — sama dzierżawa bez
    // abonamentu jest wypełnioną informacją i nie może lądować na końcu listy.
    value: sql`case when ${HAS_ANY_REVENUE_SQL} then 0 else 1 end`,
    cost: sql`case when objects.monthly_cost is null then 1 else 0 end`,
    profit: sql`case when ${HAS_ANY_REVENUE_SQL} or objects.monthly_cost is not null then 0 else 1 end`,
    // „Bezterminowo” to nie jest najwcześniejsza data — obiekty bez planowanego
    // końca idą na koniec także przy sortowaniu rosnąco.
    expectedEnd: sql`case when objects.expected_end_date is null then 1 else 0 end`,
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
      // Suma przychodu miesięcznego: oba abonamenty + dzierżawa sprzętu.
      sum: sql<number | null>`sum(${MONTHLY_REVENUE_SQL})`,
      // Rozbicie sumy na linie — front pokazuje je pod kwotą, żeby było widać,
      // ile z przychodu bierze się z dozoru, a ile z ochrony fizycznej.
      sumZdw: sql<number | null>`sum(coalesce(objects.monthly_zdw, 0))`,
      sumOfi: sql<number | null>`sum(coalesce(objects.monthly_ofi, 0))`,
      sumRental: sql<number | null>`sum(coalesce(objects.monthly_rental, 0))`,
      withValue: sql<number>`sum(case when ${MONTHLY_REVENUE_SQL} > 0 then 1 else 0 end)`,
      sumCost: sql<number | null>`sum(${schema.objects.monthlyCost})`,
      sumSetup: sql<number | null>`sum(${schema.objects.setupCost})`,
      // Licznik uzupełnionych kosztów — front musi wiedzieć, na ilu obiektach opiera się
      // suma kosztów, żeby nie pokazywać marży policzonej z połowy danych jako pewnej.
      withCost: sql<number>`sum(case when objects.monthly_cost is not null then 1 else 0 end)`,
      // „Kończące się” liczymy W ZAKRESIE BIEŻĄCYCH FILTRÓW, a nie po całej
      // kartotece — pod listą ma stać liczba pasująca do tego, co widać.
      endingSoonCount: sql<number>`sum(case when ${endingSoon} then 1 else 0 end)`,
      // Przychód zagrożony: ta sama suma, co `totalMonthlyValue`, ale tylko po
      // obiektach z predykatu — tyle firma przestaje fakturować, jeśli nic się
      // nie przedłuży.
      endingSoonRevenue: sql<
        number | null
      >`sum(case when ${endingSoon} then ${MONTHLY_REVENUE_SQL} else 0 end)`,
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

  // OKRESY USŁUG dla wierszy tej strony — jedno dodatkowe zapytanie zamiast
  // N+1. Formularz edycji dostaje obiekt wprost z wiersza listy, więc bez tego
  // otwarcie edycji z listy pokazywałoby pustą listę usług.
  const pageIds = objects.map((o) => o.object.id);
  const servicesByObject = new Map<number, (typeof schema.objectServices.$inferSelect)[]>();
  if (pageIds.length > 0) {
    const rows = await db
      .select()
      .from(schema.objectServices)
      .where(inArray(schema.objectServices.objectId, pageIds))
      .orderBy(asc(schema.objectServices.service), asc(schema.objectServices.startDate));
    for (const row of rows) {
      const list = servicesByObject.get(row.objectId);
      if (list) list.push(row);
      else servicesByObject.set(row.objectId, [row]);
    }
  }

  return c.json({
    success: true,
    data: objects.map((o) => ({
      ...o.object,
      services: servicesByObject.get(o.object.id) ?? [],
      // `monthlyValue` jest WYLICZANE z rozbicia (kolumna `monthly_value` jest
      // @deprecated i nie jest już źródłem prawdy) — czytający po staremu wciąż
      // dostają jedną kwotę abonamentu, tylko prawdziwą.
      monthlyValue: monthlyValueOf(o.object.monthlyZdw, o.object.monthlyOfi),
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
    totalMonthlyZdw: summary.sumZdw ?? 0,
    totalMonthlyOfi: summary.sumOfi ?? 0,
    totalMonthlyRental: summary.sumRental ?? 0,
    withMonthlyValue: summary.withValue ?? 0,
    totalMonthlyCost: summary.sumCost ?? 0,
    totalSetupCost: summary.sumSetup ?? 0,
    withMonthlyCost: summary.withCost ?? 0,
    scope,
    currentCount: scopeRows[0].current ?? 0,
    archivedCount: scopeRows[0].archived ?? 0,
    // Horyzont wraca w odpowiedzi, bo front pokazuje go w opisie („≤ 90 dni”),
    // a przy braku parametru nie zna wartości domyślnej.
    endingSoonDays: endingHorizonDays,
    endingSoonCount: summary.endingSoonCount ?? 0,
    endingSoonRevenue: summary.endingSoonRevenue ?? 0,
  });
});

// Get object by ID with contractor and contracts
// ---------------------------------------------------------------------------
// NOTATKI KARTOTEKI OBIEKTU — GET/POST /:id/notes, PUT/DELETE /notes/:noteId
//
// Uprawnienia modułu (`objects`: view do odczytu, edit do zapisu) egzekwuje
// `tabPermissionGuard` (src/middleware/auth.ts, wpis `{ prefix: "/objects" }`),
// więc trasy sprawdzają już tylko własność wiersza: edytować i kasować może
// AUTOR albo admin (`canManageObjectNote` w src/lib/object-notes.ts).
//
// KOLEJNOŚĆ: `/notes/:noteId` stoi PRZED `/:id`, żeby żaden router nie próbował
// czytać „notes" jako id obiektu.
// ---------------------------------------------------------------------------

function noteError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) return c.json({ success: false, error: error.message }, error.status);
  console.error(`Error in object notes ${what}:`, error);
  return c.json({ success: false, error: `Błąd: ${what}` }, 500);
}

app.put("/notes/:noteId", async (c) => {
  const noteId = Number(c.req.param("noteId"));
  if (!Number.isInteger(noteId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const note = db.transaction((tx) => updateObjectNote(tx, noteId, body?.text, { user: getUser(c) }));
    return c.json({ success: true, data: note });
  } catch (error) {
    return noteError(c, error, "edycji notatki obiektu");
  }
});

app.delete("/notes/:noteId", (c) => {
  const noteId = Number(c.req.param("noteId"));
  if (!Number.isInteger(noteId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    db.transaction((tx) => deleteObjectNote(tx, noteId, { user: getUser(c) }));
    return c.json({ success: true, data: { id: noteId } });
  } catch (error) {
    return noteError(c, error, "usuwania notatki obiektu");
  }
});

app.get("/:id/notes", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    return c.json({ success: true, data: listObjectNotes(db, id) });
  } catch (error) {
    return noteError(c, error, "pobierania notatek obiektu");
  }
});

app.post("/:id/notes", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const note = db.transaction((tx) =>
      addObjectNote(tx, { objectId: id, text: body?.text, ctx: { user: getUser(c) } })
    );
    return c.json({ success: true, data: note }, 201);
  } catch (error) {
    return noteError(c, error, "dodawania notatki obiektu");
  }
});

app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const result = await db
    .select({
      object: schema.objects,
      contractor: schema.contractors,
      // Opiekun handlowy — te same dwa źródła i ta sama kolejność, co na liście
      // (obiekt wygrywa z kontrahentem). Bez tego karta obiektu pokazywała
      // „Handlowiec —” nawet przy wypełnionym `objects.salesperson_id`.
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
    .leftJoin(objectSalesperson, eq(objectSalesperson.id, schema.objects.salespersonId))
    .leftJoin(contractorSalesperson, eq(contractorSalesperson.id, schema.contractors.salespersonId))
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
      // Wyliczane z rozbicia — patrz komentarz na liście obiektów.
      monthlyValue: monthlyValueOf(result[0].object.monthlyZdw, result[0].object.monthlyOfi),
      // Pełna historia usług, także okresy zakończone: karta obiektu pokazuje je
      // wyszarzone, bo „kiedyś mieliśmy tu kamery” jest informacją, a nie szumem.
      services: readObjectServices(db, id),
      contractor: result[0].contractor,
      // `inherited` = handlowiec przyszedł od kontrahenta, nie z samego obiektu
      // (identycznie jak na liście — front rysuje z tego dopisek „po kliencie”).
      salesperson: result[0].objectSales?.id
        ? { ...result[0].objectSales, inherited: false }
        : result[0].contractorSales?.id
          ? { ...result[0].contractorSales, inherited: true }
          : null,
      contracts,
    },
  });
});

/**
 * Nowe pola kartoteki, których nie da się wpuścić spreadem do `.set()`:
 * `services` nie jest kolumną, a `expectedEndDate`/`mapsUrl` wymagają walidacji
 * (data w kalendarzu, link tylko do Google). Rzuca `ValidationError`.
 */
function parseServiceFields(body: Partial<ObjectInput>) {
  return {
    services: parseObjectServices(body.services),
    expectedEndDate: parseDate(body.expectedEndDate, "Przewidywane zakończenie"),
    mapsUrl: parseMapsUrlInput(body.mapsUrl),
  };
}

/** Flagi do wyliczenia abonamentu i @deprecated `type`: z okresów, gdy są w body. */
function flagsFor(
  services: ObjectServiceInput[] | undefined,
  fallback: { hasCameras: boolean; hasSswin: boolean; hasVideoreception: boolean; hasOfi: boolean; cameraCount?: number | null }
): ComputedObjectFlags {
  if (services) return flagsFromServices(services);
  return { ...fallback, cameraCount: fallback.cameraCount ?? null };
}

/** Okresy w postaci, w jakiej lądują we wpisie historii (bez znaczników czasu). */
function historyServices(rows: (typeof schema.objectServices.$inferSelect)[]) {
  return rows.map((r) => ({
    service: r.service,
    startDate: r.startDate,
    endDate: r.endDate,
    cameraCount: r.cameraCount,
  }));
}

// Create object
app.post("/", async (c) => {
  const body = await c.req.json<ObjectInput>();

  let parsed: ReturnType<typeof parseServiceFields>;
  try {
    parsed = parseServiceFields(body);
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }
  const { services, expectedEndDate, mapsUrl } = parsed;

  // Gdy w body są okresy, flagi i liczba kamer są POLAMI WYLICZANYMI (jak
  // `monthlyValue` z rozbicia abonamentu) — przysłane `hasX` jest ignorowane.
  const flags = flagsFor(services, {
    hasCameras: body.hasCameras ?? false,
    hasSswin: body.hasSswin ?? false,
    hasVideoreception: body.hasVideoreception ?? false,
    hasOfi: body.hasOfi ?? false,
    cameraCount: body.hasCameras ? body.cameraCount ?? null : null,
  });

  // Kontrola kontrahenta, wstawienie obiektu i wpis historii w jednej
  // synchronicznej transakcji — obiekt i jego wpis "created" powstają atomowo,
  // więc nie ma obiektu bez historii ani przeplotu między dwoma zapisami.
  let result: ({ services: (typeof schema.objectServices.$inferSelect)[] } & typeof schema.objects.$inferSelect)[] | null;
  try {
    result = db.transaction((tx) => {
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
        // Kolumna `type` jest @deprecated i wciąż NOT NULL, więc wyliczamy ją
        // z usług; jawnie podana wartość (starsi klienci API) ma pierwszeństwo.
        type: body.type ?? legacyObjectType(flags),
        hasCameras: flags.hasCameras,
        // `?? null` zamiast `|| null`: 0 kamer to świadomy wpis, a null znaczy
        // „usługa jest, ale nikt ich nie policzył” i tak ma zostać zapisane.
        cameraCount: flags.cameraCount,
        hasSswin: flags.hasSswin,
        hasVideoreception: flags.hasVideoreception,
        hasOfi: flags.hasOfi,
        installationType: body.installationType,
        status: body.status || "pending",
        department: body.department || "sales",
        // Abonament trzyma się w rozbiciu na linie; @deprecated `monthly_value`
        // zostaje puste — od migracji 0082 nie jest już źródłem prawdy. Rozbicie
        // karmimy flagami Z OKRESÓW, a nie tym, co przysłał klient.
        ...abonamentPatch(body, flags),
        // Lista pól jest tu wypisana jawnie (bez spreadu body), więc każdy nowy
        // atrybut trzeba dopisać — inaczej edycja go zapisuje, a zakładanie gubi.
        monthlyRental: body.monthlyRental ?? null,
        monthlyCost: body.monthlyCost ?? null,
        setupCost: body.setupCost ?? null,
        expectedEndDate: expectedEndDate ?? null,
        mapsUrl: mapsUrl ?? null,
        // Współrzędne z formularza (ręczne, „Ustal z adresu” albo odczytane
        // z wklejonego linku Google Maps). PUT je zapisywał od zawsze
        // (`.set({...rest})`), a zakładanie gubiło — nowy obiekt z pinezki
        // wracał bez lat/lng i dystans liczył się dopiero po edycji.
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        notes: body.notes,
        companyId: body.companyId ?? null,
        salespersonId: body.salespersonId ?? null,
      })
      .returning()
      .all();

    const objectId = inserted[0].id;
    let periods: (typeof schema.objectServices.$inferSelect)[] = [];
    if (services) {
      applyServiceRows(tx, objectId, services);
      // Sync jest tu redundantny wobec flag policzonych wyżej, ale to JEDYNE
      // miejsce, które liczy cache — powtórzenie reguły w dwóch miejscach byłoby
      // pierwszym miejscem do rozjazdu.
      syncObjectServiceFlags(tx, objectId);
      periods = readObjectServices(tx, objectId);
    }

    // Ponowny odczyt: flagi i `type` pochodzą po synchronizacji z okresów, więc
    // wiersz z `returning()` jest już nieaktualny — i dla odpowiedzi, i dla audytu.
    const saved = tx.select().from(schema.objects).where(eq(schema.objects.id, objectId)).get()!;

    tx.insert(schema.objectHistory)
      .values({
        objectId,
        action: "created",
        description: `Object created in ${body.department || "sales"} department`,
        newValue: JSON.stringify({ ...saved, services: historyServices(periods) }),
      })
      .run();

    return [{ ...saved, services: periods }];
    });
  } catch (err) {
    // `ValidationError` z okresów leci z wnętrza transakcji (wycofuje ją) —
    // klient ma dostać 400 z polskim komunikatem, a nie 500.
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }

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

  let parsed: ReturnType<typeof parseServiceFields>;
  try {
    parsed = parseServiceFields(body);
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }
  const { services, expectedEndDate, mapsUrl } = parsed;

  // Odczyt, zapis i wpis historii w jednej synchronicznej transakcji —
  // serializuje równoległe edycje (drugi PUT widzi zapis pierwszego) i buduje
  // oldValue z tego samego odczytu, więc audyt nie kłamie o przejściu.
  let result: ({ services: (typeof schema.objectServices.$inferSelect)[] } & typeof schema.objects.$inferSelect)[] | null;
  try {
    result = db.transaction((tx) => {
      const existing = tx
        .select()
        .from(schema.objects)
        .where(eq(schema.objects.id, id))
        .get();

      if (!existing) return null;

      const before = services ? readObjectServices(tx, id) : [];

      // Gdy edycja rusza usługi, przeliczamy razem z nimi @deprecated `type` —
      // dopóki kolumna istnieje i ktoś ją czyta (analityka), nie może zostać
      // z wartością sprzed zmiany usług.
      const touchesFlags =
        body.hasCameras !== undefined ||
        body.hasSswin !== undefined ||
        body.hasVideoreception !== undefined ||
        body.hasOfi !== undefined;
      const flags = flagsFor(services, {
        hasCameras: body.hasCameras ?? existing.hasCameras,
        hasSswin: body.hasSswin ?? existing.hasSswin,
        hasVideoreception: body.hasVideoreception ?? existing.hasVideoreception,
        hasOfi: body.hasOfi ?? existing.hasOfi,
      });

      /*
       * DESTRUKTURYZACJA PRZED SPREADEM (D8). `.set({ ...body })` mapuje KAŻDY
       * klucz na kolumnę, więc `services` (osobna tabela) wywaliłoby SQL, a
       * `monthlyValue` / flagi wpisałyby się obok wartości wyliczonych. Pola
       * wyliczane i pola spoza tabeli muszą więc wypaść z rozsypki jawnie —
       * dokładają się niżej, już policzone.
       */
      const {
        monthlyValue: _legacyMonthlyValue,
        services: _services,
        expectedEndDate: _expectedEndDate,
        mapsUrl: _mapsUrl,
        hasCameras: _hasCameras,
        hasSswin: _hasSswin,
        hasVideoreception: _hasVideoreception,
        hasOfi: _hasOfi,
        cameraCount: _cameraCount,
        ...rest
      } = body;

      tx.update(schema.objects)
        .set({
          ...rest,
          ...abonamentPatch(body, flags),
          // Okresy w body = flagi WYLICZANE (sync niżej). Bez nich zostaje stara
          // ścieżka flagowa: skrypty i starsi klienci API dalej działają (D5).
          ...(services
            ? {}
            : {
                hasCameras: flags.hasCameras,
                hasSswin: flags.hasSswin,
                hasVideoreception: flags.hasVideoreception,
                hasOfi: flags.hasOfi,
                // Wyłączona usługa nie zostawia po sobie liczby kamer.
                ...(body.hasCameras === false
                  ? { cameraCount: null }
                  : body.cameraCount !== undefined
                    ? { cameraCount: body.cameraCount ?? null }
                    : {}),
                ...(touchesFlags ? { type: legacyObjectType(flags) } : {}),
              }),
          ...(expectedEndDate !== undefined ? { expectedEndDate } : {}),
          ...(mapsUrl !== undefined ? { mapsUrl } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.objects.id, id))
        .run();

      let periods: (typeof schema.objectServices.$inferSelect)[] = readObjectServices(tx, id);
      let servicesChanged = false;
      if (services) {
        servicesChanged = applyServiceRows(tx, id, services);
        syncObjectServiceFlags(tx, id);
        periods = readObjectServices(tx, id);
      }

      const saved = tx.select().from(schema.objects).where(eq(schema.objects.id, id)).get()!;

      tx.insert(schema.objectHistory)
        .values({
          objectId: id,
          action: "updated",
          description: "Object details updated",
          oldValue: JSON.stringify(existing),
          newValue: JSON.stringify(saved),
        })
        .run();

      // Osobny wpis dla okresów: zmiana daty usługi nie widać w rozsypce kolumn
      // obiektu, a to ona decyduje o flagach, filtrach i podziale kosztu CMA.
      if (servicesChanged) {
        tx.insert(schema.objectHistory)
          .values({
            objectId: id,
            action: "services_updated",
            description: "Zmieniono okresy usług",
            oldValue: JSON.stringify(historyServices(before)),
            newValue: JSON.stringify(historyServices(periods)),
          })
          .run();
      }

      return [{ ...saved, services: periods }];
    });
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }

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
  // Katalogi załączników grup interwencyjnych (warunki + podjazdy tego obiektu).
  // Kaskada FK czyści WIERSZE, ale nie pliki na dysku — ścieżki trzeba zebrać
  // PRZED usunięciem, a `rm -r` wykonać PO commicie.
  const attachmentDirs: string[] = [];

  const blocked = db.transaction((tx) => {
    const child = tx
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.objectId, id))
      .limit(1)
      .all();

    if (child.length > 0) return true;

    for (const t of tx
      .select({ id: schema.interventionTerms.id })
      .from(schema.interventionTerms)
      .where(eq(schema.interventionTerms.objectId, id))
      .all()) {
      attachmentDirs.push(`interventions/terms/${t.id}`);
    }
    for (const i of tx
      .select({ id: schema.interventions.id })
      .from(schema.interventions)
      .where(eq(schema.interventions.objectId, id))
      .all()) {
      attachmentDirs.push(`interventions/interventions/${i.id}`);
    }
    // Drafty umów: wygenerowany DOCX i załączniki leżą w jednym katalogu
    // `contract-drafts/<id>`. Draft NIE blokuje kasowania obiektu (w odróżnieniu
    // od umowy z rejestru) — to dopiero dokument roboczy, kaskada FK go zabiera.
    for (const d of tx
      .select({ id: schema.contractDrafts.id })
      .from(schema.contractDrafts)
      .where(eq(schema.contractDrafts.objectId, id))
      .all()) {
      attachmentDirs.push(`contract-drafts/${d.id}`);
    }

    tx.delete(schema.objects).where(eq(schema.objects.id, id)).run();
    return false;
  });

  if (!blocked) {
    for (const dir of attachmentDirs) removeAttachmentDir(dir);
  }

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
