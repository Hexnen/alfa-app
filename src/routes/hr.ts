// Moduł Kadry — pracownicy, obiekty, normy, godziny, umowy, wynagrodzenia.
// Kalkulacja płac: src/utils/hr-calc.ts (agregacja godzin + jeden przebieg).
import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { and, asc, eq, sql } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type {
  NewHrContract,
  NewHrEmployee,
  NewHrHours,
  NewHrObject,
  NewHrOfficePayroll,
} from "../db/schema.js";
import {
  buildHoursAggregates,
  computePayroll,
  type PayrollComputed,
} from "../utils/hr-calc.js";
import { fetchObjectCatalog } from "../lib/object-catalog.js";

const app = new Hono();

const round2 = (n: number) => Math.round(n * 100) / 100;

// Liczba lub null — akceptuje number i string z przecinkiem
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v.replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function yearMonth(c: {
  req: { query: (k: string) => string | undefined };
}): { year: number; month: number } {
  const now = new Date();
  const year = parseInt(c.req.query("year") ?? "") || now.getFullYear();
  const month = parseInt(c.req.query("month") ?? "") || now.getMonth() + 1;
  return { year, month };
}

// Normy godzin miesiąca; brak wpisu → wartości domyślne (jak w arkuszu Rok)
async function getNorms(year: number, month: number) {
  const [row] = await db
    .select()
    .from(schema.hrMonthNorms)
    .where(
      and(
        eq(schema.hrMonthNorms.year, year),
        eq(schema.hrMonthNorms.month, month),
      ),
    );
  return {
    workNorm: row?.workNorm ?? 160,
    contractNorm: row?.contractNorm ?? 158,
    fromDb: !!row,
  };
}

// ==================== PRACOWNICY ====================

app.get("/employees", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  let rows = await db
    .select()
    .from(schema.hrEmployees)
    .orderBy(asc(schema.hrEmployees.fullName));
  if (onlyActive) rows = rows.filter((e) => e.active);
  // Kartoteka jest niezależna od miesiąca, a spółka pracownika biura siedzi
  // w miesięcznych wierszach rozliczenia — doklejamy więc komplet spółek z
  // całej historii, żeby lista pokazywała je bez wybierania miesiąca.
  const officeRows = await db
    .selectDistinct({
      employeeId: schema.hrOfficePayroll.employeeId,
      company: schema.hrOfficePayroll.company,
    })
    .from(schema.hrOfficePayroll);
  const byEmployee = new Map<number, string[]>();
  for (const r of officeRows) {
    if (!r.company) continue;
    const list = byEmployee.get(r.employeeId);
    if (list) list.push(r.company);
    else byEmployee.set(r.employeeId, [r.company]);
  }
  const data = rows.map((e) => ({
    ...e,
    officeCompanies: (byEmployee.get(e.id) ?? []).sort(),
  }));
  return c.json({ success: true, data });
});

function parseEmployee(body: Record<string, unknown>): {
  data?: Partial<NewHrEmployee>;
  error?: string;
} {
  const fullName =
    typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (!fullName) return { error: "Nazwisko i imię są wymagane" };
  return {
    data: {
      fullName,
      code: typeof body.code === "string" ? body.code : "",
      // Rodzaj rozliczenia — decyduje, czy osoba trafia do tabeli ochrony
      // (umowy) czy do zestawienia biura w wynagrodzeniach.
      kind: body.kind === "biuro" ? "biuro" : "ochrona",
      notes: typeof body.notes === "string" ? body.notes : "",
      active: body.active === undefined ? true : Boolean(body.active),
    },
  };
}

app.post("/employees", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseEmployee(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const result = await db
    .insert(schema.hrEmployees)
    .values(data as NewHrEmployee)
    .returning();
  return c.json({ success: true, data: result[0], message: "Pracownik dodany" }, 201);
});

app.put("/employees/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseEmployee(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Optymistyczna kontrola współbieżności: gdy klient odeśle odczytany updatedAt,
  // zapis przechodzi tylko jeśli wiersz się nie zmienił — inaczej 409. Bez tego
  // dwóch operatorów zapisujących ten sam wiersz nadpisuje sobie nawzajem cały
  // payload (lost update).
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const result = await db
    .update(schema.hrEmployees)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      expectedUpdatedAt
        ? and(
            eq(schema.hrEmployees.id, id),
            eq(schema.hrEmployees.updatedAt, expectedUpdatedAt),
          )
        : eq(schema.hrEmployees.id, id),
    )
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Pracownik został zmieniony przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({ success: true, data: result[0], message: "Pracownik zapisany" });
});

app.delete("/employees/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const result = await db
    .delete(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Pracownik usunięty" });
});

// ==================== OBIEKTY ====================

/**
 * Słownik kadrowy obiektów (posterunków) — to na nim wiszą godziny. Do każdej
 * pozycji doklejamy:
 *  - obiekt z kartoteki, na który wskazuje ręczne mapowanie (`object_id`),
 *    razem z miastem i kontrahentem, żeby front nie musiał dociągać kartoteki
 *    po id pozycja po pozycji;
 *  - wagę pozycji: sumę godzin i liczbę osób z CAŁEJ historii `hr_hours`,
 *    a nie z wybranego miesiąca. Mapowanie robi się raz i na stałe, więc ma je
 *    porządkować realny wolumen pracy, a nie to, kto akurat był na urlopie
 *    w miesiącu otwartym w zakładce.
 */
app.get("/objects", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  const rows = await db
    .select({
      row: schema.hrObjects,
      objectName: schema.objects.name,
      objectCity: schema.objects.city,
      contractorName: schema.contractors.name,
      // Kolumnę nadrzędną piszemy DOSŁOWNIE (`hr_objects.id`) — drizzle renderuje
      // ${schema.hrObjects.id} w szablonie jako niekwalifikowane "id", które
      // wewnątrz podzapytania trafiłoby w kolumnę tabeli z podzapytania.
      hoursTotal: sql<number>`(
        select coalesce(sum(coalesce(hr_hours.worked_hours, 0)), 0)
        from hr_hours where hr_hours.object_id = hr_objects.id
      )`,
      employeesCount: sql<number>`(
        select count(distinct hr_hours.employee_id)
        from hr_hours where hr_hours.object_id = hr_objects.id
      )`,
    })
    .from(schema.hrObjects)
    .leftJoin(schema.objects, eq(schema.hrObjects.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id),
    )
    .orderBy(asc(schema.hrObjects.name));
  const data = rows
    .filter((r) => !onlyActive || r.row.active)
    .map((r) => ({
      ...r.row,
      // Mapowanie może wskazywać na obiekt skasowany w międzyczasie (FK jest
      // "set null", więc taki stan długo nie potrwa) — stąd null zamiast obiektu
      // z pustymi polami.
      object:
        r.row.objectId != null && r.objectName != null
          ? {
              id: r.row.objectId,
              name: r.objectName,
              city: r.objectCity,
              contractorName: r.contractorName ?? "",
            }
          : null,
      hoursTotal: r.hoursTotal ?? 0,
      employeesCount: r.employeesCount ?? 0,
    }));
  return c.json({ success: true, data });
});

/**
 * Kartoteka obiektów w formie listy wyboru do mapowania. Świadomie pod `/hr`,
 * a nie przez `GET /objects`: mapowanie robi kadrowa, która nie musi mieć
 * dostępu do modułu Kontrahenci/Obiekty, a tutaj potrzebuje wyłącznie nazw.
 * Samo zapytanie jest wspólne z bliźniaczym ekranem w CMA — patrz
 * src/lib/object-catalog.ts.
 */
app.get("/object-catalog", async (c) => {
  return c.json({ success: true, data: await fetchObjectCatalog() });
});

/**
 * Skrócona lista pracowników kadr (bez danych płacowych) — potrzebna poza
 * Kadrami: formularz handlowca i technika wiąże osobę z listą płac. Prefiks
 * `/hr/directory` ma w API_TAB_MAP własny, węższy wpis, żeby handlowiec-edytor
 * bez dostępu do Kadr mógł wybrać osobę, ale nie zobaczył jej wynagrodzenia.
 */
app.get("/directory/employees", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  const rows = await db
    .select({
      id: schema.hrEmployees.id,
      fullName: schema.hrEmployees.fullName,
      kind: schema.hrEmployees.kind,
      active: schema.hrEmployees.active,
    })
    .from(schema.hrEmployees)
    .orderBy(asc(schema.hrEmployees.fullName));
  return c.json({
    success: true,
    data: onlyActive ? rows.filter((e) => e.active) : rows,
  });
});

app.post("/objects", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nazwa obiektu jest wymagana" },
      400,
    );
  }
  const result = await db
    .insert(schema.hrObjects)
    .values({ name, active: body.active === undefined ? true : Boolean(body.active) })
    .returning();
  return c.json({ success: true, data: result[0], message: "Obiekt dodany" }, 201);
});

app.put("/objects/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nazwa obiektu jest wymagana" },
      400,
    );
  }
  const result = await db
    .update(schema.hrObjects)
    .set({
      name,
      active: body.active === undefined ? true : Boolean(body.active),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.hrObjects.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404,
    );
  }
  return c.json({ success: true, data: result[0], message: "Obiekt zapisany" });
});

/**
 * Ręczne mapowanie pozycji kadrowej na obiekt z kartoteki.
 * `{ objectId: null }` = zdejmij mapowanie (tak zostają pozycje typu #BIURO
 * czy CMA — to koszt ogólny, nie koszt konkretnego obiektu).
 *
 * Osobny endpoint zamiast pola w PUT /objects/:id, bo mapowanie ustawia się
 * jednym selectem w tabeli, bez przechodzenia przez formularz nazwy — i nie
 * chcemy, żeby zapis samej nazwy przypadkiem czyścił powiązanie.
 */
app.put("/objects/:id/mapping", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();
  const raw = body.objectId;
  let objectId: number | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    const n = toNum(raw);
    if (n == null || !Number.isInteger(n) || n <= 0) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowy obiekt" },
        400,
      );
    }
    objectId = n;
  }
  if (objectId !== null) {
    const [obj] = await db
      .select({ id: schema.objects.id })
      .from(schema.objects)
      .where(eq(schema.objects.id, objectId))
      .limit(1);
    if (!obj) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie znaleziono obiektu w kartotece" },
        404,
      );
    }
  }
  const result = await db
    .update(schema.hrObjects)
    .set({ objectId, updatedAt: new Date().toISOString() })
    .where(eq(schema.hrObjects.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404,
    );
  }
  return c.json({
    success: true,
    data: result[0],
    message: objectId === null ? "Mapowanie usunięte" : "Mapowanie zapisane",
  });
});

app.delete("/objects/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const result = await db
    .delete(schema.hrObjects)
    .where(eq(schema.hrObjects.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Obiekt usunięty" });
});

// ==================== NORMY GODZIN ====================

app.get("/norms", async (c) => {
  const now = new Date();
  const year = parseInt(c.req.query("year") ?? "") || now.getFullYear();
  const rows = await db
    .select()
    .from(schema.hrMonthNorms)
    .where(eq(schema.hrMonthNorms.year, year))
    .orderBy(asc(schema.hrMonthNorms.month));
  return c.json({ success: true, data: rows });
});

// Upsert normy jednego miesiąca
app.put("/norms", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const year = toNum(body.year);
  const month = toNum(body.month);
  const workNorm = toNum(body.workNorm);
  const contractNorm = toNum(body.contractNorm);
  if (!year || !month || month < 1 || month > 12 || workNorm == null || contractNorm == null) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagane: rok, miesiąc (1-12), norma pracy i zlecenia" },
      400,
    );
  }
  // Upsert w jednej synchronicznej transakcji — select i insert/update są
  // atomowe, więc równoległe PUT /norms dla tego samego (rok, miesiąc) nie
  // wstawią dwóch wierszy normy.
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.hrMonthNorms)
      .where(
        and(eq(schema.hrMonthNorms.year, year), eq(schema.hrMonthNorms.month, month)),
      )
      .get();
    return existing
      ? tx
          .update(schema.hrMonthNorms)
          .set({ workNorm, contractNorm, updatedAt: new Date().toISOString() })
          .where(eq(schema.hrMonthNorms.id, existing.id))
          .returning()
          .all()
      : tx
          .insert(schema.hrMonthNorms)
          .values({ year, month, workNorm, contractNorm })
          .returning()
          .all();
  });
  return c.json({ success: true, data: result[0], message: "Norma zapisana" });
});

// ==================== GODZINY ====================

function parseHours(body: Record<string, unknown>): {
  data?: Partial<NewHrHours>;
  error?: string;
} {
  const employeeId = toNum(body.employeeId);
  const year = toNum(body.year);
  const month = toNum(body.month);
  if (!employeeId) return { error: "Pracownik jest wymagany" };
  if (!year || !month || month < 1 || month > 12) {
    return { error: "Nieprawidłowy rok/miesiąc" };
  }
  return {
    data: {
      employeeId,
      objectId: toNum(body.objectId),
      year,
      month,
      nightHours: toNum(body.nightHours),
      workedHours: toNum(body.workedHours),
      uwHours: toNum(body.uwHours),
      l4Hours: toNum(body.l4Hours),
      maxHours: toNum(body.maxHours),
      deductions: toNum(body.deductions),
      bonuses: toNum(body.bonuses),
      notes: typeof body.notes === "string" ? body.notes : "",
      // Flaga "obiekt do potwierdzenia" (carry-over). Formularz jej nie wysyła,
      // więc każdy zapis wpisu przez użytkownika zdejmuje pytajnik.
      objectUncertain: body.objectUncertain === true,
    },
  };
}

app.get("/hours", async (c) => {
  const { year, month } = yearMonth(c);
  const rows = await db
    .select({
      hours: schema.hrHours,
      employeeName: schema.hrEmployees.fullName,
      objectName: schema.hrObjects.name,
    })
    .from(schema.hrHours)
    .innerJoin(schema.hrEmployees, eq(schema.hrHours.employeeId, schema.hrEmployees.id))
    .leftJoin(schema.hrObjects, eq(schema.hrHours.objectId, schema.hrObjects.id))
    .where(and(eq(schema.hrHours.year, year), eq(schema.hrHours.month, month)))
    .orderBy(asc(schema.hrEmployees.fullName));
  const data = rows.map((r) => ({
    ...r.hours,
    employeeName: r.employeeName,
    objectName: r.objectName ?? "",
  }));
  return c.json({ success: true, data });
});

app.post("/hours", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseHours(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const result = await db
    .insert(schema.hrHours)
    .values(data as NewHrHours)
    .returning();
  return c.json({ success: true, data: result[0], message: "Godziny dodane" }, 201);
});

app.put("/hours/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrHours)
    .where(eq(schema.hrHours.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu godzin" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseHours(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Optymistyczna kontrola współbieżności (patrz PUT /employees/:id) — zapis
  // tylko gdy odczytany updatedAt wciąż aktualny, inaczej 409.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const result = await db
    .update(schema.hrHours)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      expectedUpdatedAt
        ? and(
            eq(schema.hrHours.id, id),
            eq(schema.hrHours.updatedAt, expectedUpdatedAt),
          )
        : eq(schema.hrHours.id, id),
    )
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wpis godzin został zmieniony przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({ success: true, data: result[0], message: "Godziny zapisane" });
});

// Przeniesienie aktywnych pracowników z poprzedniego miesiąca: dla każdego
// wpisu godzin z miesiąca poprzedzającego (year, month) — o ile pracownik jest
// aktywny, a para (pracownik, obiekt) nie istnieje jeszcze w miesiącu docelowym
// — tworzy pusty wpis z flagą objectUncertain (obiekt do potwierdzenia).
// Idempotentny: ponowne wywołanie niczego nie dubluje. Uprawnienie edycji
// egzekwuje tabPermissionGuard (zapis na /hr/* wymaga poziomu "edit"),
// tak samo jak dla POST /hours.
app.post("/hours/carry-over", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const year = toNum(body.year);
  const month = toNum(body.month);
  if (!year || year < 2000 || year > 2100 || !month || month < 1 || month > 12) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy rok/miesiąc" },
      400,
    );
  }
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  // Wpisy poprzedniego miesiąca — tylko aktywni pracownicy
  const prevRows = await db
    .select({ hours: schema.hrHours })
    .from(schema.hrHours)
    .innerJoin(
      schema.hrEmployees,
      eq(schema.hrHours.employeeId, schema.hrEmployees.id),
    )
    .where(
      and(
        eq(schema.hrHours.year, prevYear),
        eq(schema.hrHours.month, prevMonth),
        eq(schema.hrEmployees.active, true),
      ),
    );

  // Dedup: pary (pracownik, obiekt) już obecne w miesiącu docelowym
  const existing = await db
    .select({
      employeeId: schema.hrHours.employeeId,
      objectId: schema.hrHours.objectId,
    })
    .from(schema.hrHours)
    .where(and(eq(schema.hrHours.year, year), eq(schema.hrHours.month, month)));
  const seen = new Set(
    existing.map((r) => `${r.employeeId}:${r.objectId ?? "null"}`),
  );

  const toInsert: NewHrHours[] = [];
  for (const { hours: prev } of prevRows) {
    const key = `${prev.employeeId}:${prev.objectId ?? "null"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push({
      employeeId: prev.employeeId,
      objectId: prev.objectId,
      objectUncertain: true,
      year,
      month,
      nightHours: null,
      workedHours: null,
      uwHours: null,
      l4Hours: null,
      maxHours: null,
      deductions: null,
      bonuses: null,
      notes: "",
    });
  }
  if (toInsert.length > 0) {
    await db.insert(schema.hrHours).values(toInsert);
  }
  return c.json({ success: true, data: { inserted: toInsert.length } });
});

app.delete("/hours/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const result = await db
    .delete(schema.hrHours)
    .where(eq(schema.hrHours.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu godzin" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Wpis godzin usunięty" });
});

// ==================== UMOWY ====================

/**
 * Spółka umowy pochodzi ze słownika spółek (tabela `companies`), z którym kadry
 * wiążą się po NAZWIE. Sprawdzamy istnienie nazwy, żeby literówka nie utworzyła
 * "spółki widmo" niewidocznej w zestawieniach. Wiersze historyczne ze spółką
 * spoza słownika da się zapisać dalej — pod warunkiem, że pole nie było ruszane.
 */
async function companyInDictionary(name: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.name, name));
  return rows.length > 0;
}

const UNKNOWN_COMPANY_ERROR =
  "Spółka spoza słownika — dodaj ją najpierw w zakładce Spółki";

function parseContract(body: Record<string, unknown>): {
  data?: Partial<NewHrContract>;
  error?: string;
} {
  const employeeId = toNum(body.employeeId);
  const company = typeof body.company === "string" ? body.company.trim() : "";
  if (!employeeId) return { error: "Pracownik jest wymagany" };
  if (!company) return { error: "Spółka jest wymagana" };
  const contractType = body.contractType === "praca" ? "praca" : "zlecenie";
  const mainChannel = body.mainChannel === "gotowka" ? "gotowka" : "przelew";
  const bonusTypes = ["brak", "gotowka", "delegacja_przelew", "delegacja_gotowka"];
  const bonusType = bonusTypes.includes(body.bonusType as string)
    ? (body.bonusType as NewHrContract["bonusType"])
    : "brak";
  return {
    data: {
      employeeId,
      company,
      contractType,
      chor: Boolean(body.chor),
      zua: typeof body.zua === "string" ? body.zua.trim() : "",
      zza: typeof body.zza === "string" ? body.zza.trim() : "",
      zwua: typeof body.zwua === "string" ? body.zwua.trim() : "",
      objectName: typeof body.objectName === "string" ? body.objectName.trim() : "",
      mainChannel,
      bonusType,
      active: body.active === undefined ? true : Boolean(body.active),
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  };
}

app.get("/contracts", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  const rows = await db
    .select({
      contract: schema.hrContracts,
      employeeName: schema.hrEmployees.fullName,
    })
    .from(schema.hrContracts)
    .innerJoin(
      schema.hrEmployees,
      eq(schema.hrContracts.employeeId, schema.hrEmployees.id),
    )
    .orderBy(asc(schema.hrEmployees.fullName), asc(schema.hrContracts.id));
  let data = rows.map((r) => ({ ...r.contract, employeeName: r.employeeName }));
  if (onlyActive) data = data.filter((r) => r.active);
  return c.json({ success: true, data });
});

app.post("/contracts", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseContract(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  if (!(await companyInDictionary(data.company as string))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: UNKNOWN_COMPANY_ERROR },
      400,
    );
  }
  const result = await db
    .insert(schema.hrContracts)
    .values(data as NewHrContract)
    .returning();
  return c.json({ success: true, data: result[0], message: "Umowa dodana" }, 201);
});

app.put("/contracts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseContract(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Zmiana spółki musi trafić w słownik; zostawienie starej (historycznej)
  // wartości bez zmian nie blokuje edycji pozostałych pól.
  if (
    data.company !== existing.company &&
    !(await companyInDictionary(data.company as string))
  ) {
    return c.json<ApiResponse<null>>(
      { success: false, error: UNKNOWN_COMPANY_ERROR },
      400,
    );
  }
  // Optymistyczna kontrola współbieżności (patrz PUT /employees/:id) — zapis
  // tylko gdy odczytany updatedAt wciąż aktualny, inaczej 409.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const result = await db
    .update(schema.hrContracts)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      expectedUpdatedAt
        ? and(
            eq(schema.hrContracts.id, id),
            eq(schema.hrContracts.updatedAt, expectedUpdatedAt),
          )
        : eq(schema.hrContracts.id, id),
    )
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Umowa została zmieniona przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({ success: true, data: result[0], message: "Umowa zapisana" });
});

app.delete("/contracts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const result = await db
    .delete(schema.hrContracts)
    .where(eq(schema.hrContracts.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Umowa usunięta" });
});

// ==================== WYNAGRODZENIA (kalkulacja) ====================

// Wiersze płacowe miesiąca: umowa + wejścia ręczne + wartości wyliczone
async function computeMonth(year: number, month: number) {
  const [contracts, payrollRows, hoursRows, norms] = await Promise.all([
    db
      .select({
        contract: schema.hrContracts,
        employeeName: schema.hrEmployees.fullName,
      })
      .from(schema.hrContracts)
      .innerJoin(
        schema.hrEmployees,
        eq(schema.hrContracts.employeeId, schema.hrEmployees.id),
      )
      .orderBy(asc(schema.hrEmployees.fullName), asc(schema.hrContracts.id)),
    db
      .select()
      .from(schema.hrPayroll)
      .where(and(eq(schema.hrPayroll.year, year), eq(schema.hrPayroll.month, month))),
    db
      .select()
      .from(schema.hrHours)
      .where(and(eq(schema.hrHours.year, year), eq(schema.hrHours.month, month))),
    getNorms(year, month),
  ]);

  const payrollByContract = new Map(payrollRows.map((p) => [p.contractId, p]));
  // aktywne umowy + nieaktywne, które mają wpis płacowy w tym miesiącu (historia)
  const relevant = contracts.filter(
    (r) => r.contract.active || payrollByContract.has(r.contract.id),
  );
  const hoursByEmployee = buildHoursAggregates(hoursRows);

  const computed = computePayroll({
    contracts: relevant.map((r) => r.contract),
    payrollByContract,
    hoursByEmployee,
    workNorm: norms.workNorm,
    contractNorm: norms.contractNorm,
  });
  const computedByContract = new Map<number, PayrollComputed>(
    computed.map((r) => [r.contractId, r]),
  );

  return relevant.map((r) => {
    const p = payrollByContract.get(r.contract.id);
    const calc = computedByContract.get(r.contract.id)!;
    return {
      ...calc,
      employeeName: r.employeeName,
      company: r.contract.company,
      contractType: r.contract.contractType,
      chor: r.contract.chor,
      zua: r.contract.zua,
      zza: r.contract.zza,
      objectName: r.contract.objectName,
      mainChannel: r.contract.mainChannel,
      bonusType: r.contract.bonusType,
      contractActive: r.contract.active,
      inputs: {
        mainAmount: p?.mainAmount ?? null,
        bonusRate: p?.bonusRate ?? null,
        bonusRatePending: p?.bonusRatePending ?? false,
        rateAdjustment: p?.rateAdjustment ?? null,
        maxHoursOverride: p?.maxHoursOverride ?? null,
        actualHoursOverride: p?.actualHoursOverride ?? null,
        bonusAmountOverride: p?.bonusAmountOverride ?? null,
        notes: p?.notes ?? "",
      },
      normsFromDb: norms.fromDb,
    };
  });
}

app.get("/payroll", async (c) => {
  const { year, month } = yearMonth(c);
  const data = await computeMonth(year, month);
  return c.json({ success: true, data });
});

// Upsert wejść płacowych umowy na miesiąc (kwoty od księgowości, stawki, nadpisania)
app.put("/payroll", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const contractId = toNum(body.contractId);
  const year = toNum(body.year);
  const month = toNum(body.month);
  if (!contractId || !year || !month || month < 1 || month > 12) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagane: umowa, rok, miesiąc (1-12)" },
      400,
    );
  }
  const [contract] = await db
    .select()
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.id, contractId));
  if (!contract) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  const values = {
    mainAmount: toNum(body.mainAmount),
    bonusRate: toNum(body.bonusRate),
    bonusRatePending: Boolean(body.bonusRatePending),
    rateAdjustment: toNum(body.rateAdjustment),
    maxHoursOverride: toNum(body.maxHoursOverride),
    actualHoursOverride: toNum(body.actualHoursOverride),
    bonusAmountOverride: toNum(body.bonusAmountOverride),
    notes: typeof body.notes === "string" ? body.notes : "",
  };
  // Upsert w jednej synchronicznej transakcji — select i insert/update są
  // atomowe, więc równoległe PUT /payroll dla tego samego (umowa, rok, miesiąc)
  // nie wstawią dwóch wierszy płacowych (co po cichu gubiłoby wpisy księgowości).
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.hrPayroll)
      .where(
        and(
          eq(schema.hrPayroll.contractId, contractId),
          eq(schema.hrPayroll.year, year),
          eq(schema.hrPayroll.month, month),
        ),
      )
      .get();
    return existing
      ? tx
          .update(schema.hrPayroll)
          .set({ ...values, updatedAt: new Date().toISOString() })
          .where(eq(schema.hrPayroll.id, existing.id))
          .returning()
          .all()
      : tx
          .insert(schema.hrPayroll)
          .values({ contractId, year, month, ...values })
          .returning()
          .all();
  });
  return c.json({ success: true, data: result[0], message: "Dane płacowe zapisane" });
});

// ==================== BIURO ====================

function parseOffice(body: Record<string, unknown>): {
  data?: Partial<NewHrOfficePayroll>;
  error?: string;
} {
  const employeeId = toNum(body.employeeId);
  const year = toNum(body.year);
  const month = toNum(body.month);
  if (!employeeId) return { error: "Pracownik jest wymagany" };
  if (!year || !month || month < 1 || month > 12) {
    return { error: "Nieprawidłowy rok/miesiąc" };
  }
  return {
    data: {
      employeeId,
      year,
      month,
      company: typeof body.company === "string" ? body.company.trim() : "",
      etatHours: toNum(body.etatHours),
      uwL4: toNum(body.uwL4),
      deductions: toNum(body.deductions),
      bonuses: toNum(body.bonuses),
      hoursForAccounting: toNum(body.hoursForAccounting),
      rate: toNum(body.rate),
      amount: toNum(body.amount),
      rorBase: toNum(body.rorBase),
      cashOverride: toNum(body.cashOverride),
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  };
}

// Kwota i gotówka wyliczane, gdy nie podano ręcznie:
// kwota = godziny do księgowej × stawka; gotówka = kwota − podstawa ROR
function withOfficeComputed(row: typeof schema.hrOfficePayroll.$inferSelect) {
  const amountComputed =
    row.amount ??
    (row.hoursForAccounting != null && row.rate != null
      ? round2(row.hoursForAccounting * row.rate)
      : null);
  const cash =
    row.cashOverride ??
    (amountComputed != null && row.rorBase != null && amountComputed > row.rorBase
      ? round2(amountComputed - row.rorBase)
      : null);
  const total = round2((row.rorBase ?? 0) + (cash ?? 0));
  return { ...row, amountComputed, cash, total };
}

app.get("/office", async (c) => {
  const { year, month } = yearMonth(c);
  const rows = await db
    .select({
      office: schema.hrOfficePayroll,
      employeeName: schema.hrEmployees.fullName,
    })
    .from(schema.hrOfficePayroll)
    .innerJoin(
      schema.hrEmployees,
      eq(schema.hrOfficePayroll.employeeId, schema.hrEmployees.id),
    )
    .where(
      and(
        eq(schema.hrOfficePayroll.year, year),
        eq(schema.hrOfficePayroll.month, month),
      ),
    )
    .orderBy(asc(schema.hrEmployees.fullName));
  const data = rows.map((r) => ({
    ...withOfficeComputed(r.office),
    employeeName: r.employeeName,
  }));
  return c.json({ success: true, data });
});

app.post("/office", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseOffice(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const result = await db
    .insert(schema.hrOfficePayroll)
    .values(data as NewHrOfficePayroll)
    .returning();
  return c.json(
    { success: true, data: withOfficeComputed(result[0]), message: "Wpis dodany" },
    201,
  );
});

app.put("/office/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrOfficePayroll)
    .where(eq(schema.hrOfficePayroll.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseOffice(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Optymistyczna kontrola współbieżności (patrz PUT /employees/:id) — zapis
  // tylko gdy odczytany updatedAt wciąż aktualny, inaczej 409.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const result = await db
    .update(schema.hrOfficePayroll)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      expectedUpdatedAt
        ? and(
            eq(schema.hrOfficePayroll.id, id),
            eq(schema.hrOfficePayroll.updatedAt, expectedUpdatedAt),
          )
        : eq(schema.hrOfficePayroll.id, id),
    )
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wpis został zmieniony przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({
    success: true,
    data: withOfficeComputed(result[0]),
    message: "Wpis zapisany",
  });
});

app.delete("/office/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const result = await db
    .delete(schema.hrOfficePayroll)
    .where(eq(schema.hrOfficePayroll.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Wpis usunięty" });
});

// ==================== PODSUMOWANIE MIESIĄCA ====================

app.get("/summary", async (c) => {
  const { year, month } = yearMonth(c);
  const [payroll, hoursRows, officeRows] = await Promise.all([
    computeMonth(year, month),
    db
      .select()
      .from(schema.hrHours)
      .where(and(eq(schema.hrHours.year, year), eq(schema.hrHours.month, month))),
    db
      .select()
      .from(schema.hrOfficePayroll)
      .where(
        and(
          eq(schema.hrOfficePayroll.year, year),
          eq(schema.hrOfficePayroll.month, month),
        ),
      ),
  ]);

  const employeesWithHours = new Set(hoursRows.map((h) => h.employeeId)).size;
  const totalHours = hoursRows.reduce(
    (s, h) => s + (h.workedHours ?? 0) + (h.uwHours ?? 0) + (h.l4Hours ?? 0),
    0,
  );
  const przelew = payroll.reduce((s, r) => s + r.przelew, 0);
  const gotowka = payroll.reduce((s, r) => s + r.gotowka, 0);
  const missingMain = payroll.filter(
    (r) => r.faktGodziny != null && r.faktGodziny > 0 && r.kwotaGlowna == null,
  ).length;
  const pendingBonus = payroll.filter((r) => r.bonusPending).length;

  const office = officeRows.map(withOfficeComputed);
  const officeTotal = office.reduce((s, r) => s + r.total, 0);

  return c.json({
    success: true,
    data: {
      year,
      month,
      employeesWithHours,
      hoursEntries: hoursRows.length,
      totalHours: round2(totalHours),
      contractsCount: payroll.length,
      przelew: round2(przelew),
      gotowka: round2(gotowka),
      wyplaty: round2(przelew + gotowka),
      missingMain, // wiersze z godzinami, ale bez kwoty od księgowości
      pendingBonus, // dodatki "do przeliczenia"
      officeTotal: round2(officeTotal),
      officeCount: office.length,
    },
  });
});

export default app;
