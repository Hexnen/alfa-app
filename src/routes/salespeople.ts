import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { asc, eq, or, sql } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { NewSalesperson } from "../db/schema.js";

const app = new Hono();

/**
 * Handlowcy — słownik opiekunów handlowych, prowadzony jak technicy
 * (src/routes/technicians.ts): miękkie archiwum przez `active`, kasowanie tylko
 * dla nieprzypisanych. Lista zwraca od razu liczbę przypisanych kontrahentów
 * i obiektów, żeby zakładka „Handlowcy” nie musiała dociągać ich osobno.
 *
 * Portfel handlowca (liczba obiektów i sumy kwot) liczymy według reguły EFEKTYWNEJ —
 * handlowiec obiektu, a gdy go nie ma, opiekun kontrahenta — czyli tak samo, jak
 * dopasowuje to lista obiektów (src/routes/objects.ts). Liczenie po samym
 * objects.salesperson_id pokazywało portfele bliskie zeru, bo obiekty rzadko mają
 * własnego handlowca — dziedziczą go po kontrahencie.
 */
/** Wartownik dla kwoty, której nie da się sparsować — odróżnia śmieć od pustego pola. */
const INVALID = Symbol("invalid-amount");

/** Kwota z formularza: brak / pusty string → null (nieuzupełnione), śmieć → INVALID. */
function parseAmount(raw: unknown): number | null | typeof INVALID {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : INVALID;
  if (typeof raw !== "string") return INVALID;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(",", "."));
  return Number.isFinite(n) ? n : INVALID;
}

/**
 * Powiązanie z kartoteką kadrową: brak / pusty / null → null (osoba spoza listy
 * płac), śmieć → INVALID. Odrębny parser od kwot, bo tu wolno wyłącznie
 * dodatnią liczbę całkowitą (id wiersza), a nie „1,5”.
 */
function parseEmployeeId(raw: unknown): number | null | typeof INVALID {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : INVALID;
}

/** Czy wskazany pracownik kadr istnieje (null = brak powiązania, zawsze OK). */
async function employeeOk(id: number | null | undefined): Promise<boolean> {
  if (!id) return true;
  const rows = await db
    .select({ id: schema.hrEmployees.id })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, id))
    .limit(1);
  return rows.length > 0;
}

function parseBody(body: Record<string, unknown>): {
  data?: Partial<NewSalesperson>;
  error?: string;
} {
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  if (!lastName) return { error: "Nazwisko jest wymagane" };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email && !email.includes("@")) return { error: "Nieprawidłowy adres e-mail" };

  // Kwoty rozdzielamy na „nieuzupełnione" (null) i „wpisane" — null to nie zero,
  // bo handlowiec bez wpisanego kosztu nie jest handlowcem darmowym.
  const monthlyCost = parseAmount(body.monthlyCost);
  if (monthlyCost === INVALID) return { error: "Koszt miesięczny musi być liczbą" };
  if (monthlyCost !== null && monthlyCost < 0) {
    return { error: "Koszt miesięczny nie może być ujemny" };
  }
  const commissionRate = parseAmount(body.commissionRate);
  // Prowizję odrzucamy zamiast przycinać do zakresu — po cichu poprawiona stawka
  // rozjechałaby się z tym, co użytkownik widzi w formularzu.
  if (
    commissionRate === INVALID ||
    (commissionRate !== null && (commissionRate < 0 || commissionRate > 100))
  ) {
    return { error: "Prowizja musi być z zakresu 0–100%" };
  }

  // Ten sam człowiek w kadrach. Gdy powiązanie jest ustawione, koszt własny
  // liczy się z jego wypłat, a `monthlyCost` przestaje być brane pod uwagę —
  // inaczej handlowiec kosztowałby firmę dwa razy.
  const employeeId = parseEmployeeId(body.employeeId);
  if (employeeId === INVALID) return { error: "Nieprawidłowy pracownik kadr" };

  return {
    data: {
      employeeId,
      firstName,
      lastName,
      phone: typeof body.phone === "string" ? body.phone.trim() : "",
      email,
      region: typeof body.region === "string" ? body.region.trim() : "",
      notes: typeof body.notes === "string" ? body.notes : "",
      active: body.active === undefined ? true : Boolean(body.active),
      monthlyCost,
      commissionRate,
    },
  };
}

/**
 * Ilu kontrahentów i ile obiektów wisi na handlowcu (do etykiet i blokady kasowania).
 * Świadomie liczymy po BEZPOŚREDNIM kluczu obcym, nie po regule efektywnej z listy:
 * blokada kasowania pyta o realne przypisania, które trzeba przepiąć, a nie o portfel.
 */
function assignmentsOf(id: number) {
  const contractors = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contractors)
    .where(eq(schema.contractors.salespersonId, id))
    .get();
  const objects = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.salespersonId, id))
    .get();
  return { contractors: contractors?.count ?? 0, objects: objects?.count ?? 0 };
}

// Lista handlowców (domyślnie wszyscy; ?active=true tylko bieżący)
app.get("/", async (c) => {
  const onlyActive = c.req.query("active") === "true";

  const rows = await db
    .select({
      salesperson: schema.salespeople,
      // Nazwisko z kartoteki kadrowej — lista pokazuje, kto jest na liście płac,
      // bez dociągania Kadr osobnym żądaniem.
      employeeName: schema.hrEmployees.fullName,
      // Odwołanie do kolumny nadrzędnej piszemy DOSŁOWNIE (`salespeople.id`): drizzle
      // renderuje \${schema.salespeople.id} w szablonie jako niekwalifikowane "id", które
      // wewnątrz podzapytania trafiłoby w kolumnę `id` tabeli z podzapytania.
      contractorsCount: sql<number>`(
        select count(*) from contractors where contractors.salesperson_id = salespeople.id
      )`,
      // Portfel liczymy regułą efektywną: własny handlowiec obiektu, a gdy go nie ma —
      // opiekun kontrahenta. Stąd JOIN na contractors w każdym z podzapytań.
      objectsCount: sql<number>`(
        select count(*) from objects
        join contractors on contractors.id = objects.contractor_id
        where coalesce(objects.salesperson_id, contractors.salesperson_id) = salespeople.id
      )`,
      objectsMonthlyValue: sql<number>`(
        select coalesce(sum(objects.monthly_value), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where coalesce(objects.salesperson_id, contractors.salesperson_id) = salespeople.id
      )`,
      objectsMonthlyCost: sql<number>`(
        select coalesce(sum(objects.monthly_cost), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where coalesce(objects.salesperson_id, contractors.salesperson_id) = salespeople.id
      )`,
      objectsSetupCost: sql<number>`(
        select coalesce(sum(objects.setup_cost), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where coalesce(objects.salesperson_id, contractors.salesperson_id) = salespeople.id
      )`,
    })
    .from(schema.salespeople)
    .leftJoin(
      schema.hrEmployees,
      eq(schema.salespeople.employeeId, schema.hrEmployees.id),
    )
    .orderBy(asc(sql`lower(${schema.salespeople.lastName})`), asc(schema.salespeople.firstName));

  const data = rows
    .filter((r) => !onlyActive || r.salesperson.active)
    .map((r) => ({
      ...r.salesperson,
      employeeName: r.employeeName ?? null,
      contractorsCount: r.contractorsCount ?? 0,
      objectsCount: r.objectsCount ?? 0,
      objectsMonthlyValue: r.objectsMonthlyValue ?? 0,
      objectsMonthlyCost: r.objectsMonthlyCost ?? 0,
      objectsSetupCost: r.objectsSetupCost ?? 0,
    }));

  return c.json({ success: true, data });
});

// Nowy handlowiec
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  if (!(await employeeOk(data.employeeId))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika w kadrach" },
      404,
    );
  }

  const result = await db
    .insert(schema.salespeople)
    .values(data as NewSalesperson)
    .returning();

  return c.json({ success: true, data: result[0], message: "Handlowiec dodany" }, 201);
});

// Edycja handlowca
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.salespeople)
    .where(eq(schema.salespeople.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono handlowca" }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  // Sam przełącznik archiwum (PUT { active: false }) nie musi nieść całego formularza.
  if (Object.keys(body).length === 1 && typeof body.active === "boolean") {
    const result = await db
      .update(schema.salespeople)
      .set({ active: body.active, updatedAt: new Date().toISOString() })
      .where(eq(schema.salespeople.id, id))
      .returning();
    return c.json({
      success: true,
      data: result[0],
      message: body.active ? "Handlowiec przywrócony" : "Handlowiec zarchiwizowany",
    });
  }

  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  if (!(await employeeOk(data.employeeId))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika w kadrach" },
      404,
    );
  }

  const result = await db
    .update(schema.salespeople)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(schema.salespeople.id, id))
    .returning();

  return c.json({ success: true, data: result[0], message: "Handlowiec zaktualizowany" });
});

/**
 * Kasowanie tylko dla handlowca bez przypisań — inaczej 409 z podpowiedzią, żeby
 * go zarchiwizować. Kartoteka klienta ma pamiętać, kto ją prowadził.
 */
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.salespeople)
    .where(eq(schema.salespeople.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono handlowca" }, 404);
  }

  const used = assignmentsOf(id);
  if (used.contractors > 0 || used.objects > 0) {
    const bits = [
      used.contractors > 0 ? `${used.contractors} kontrahent(ów)` : null,
      used.objects > 0 ? `${used.objects} obiekt(ów)` : null,
    ].filter(Boolean);
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `Handlowiec ma przypisane ${bits.join(" i ")} — zarchiwizuj go zamiast kasować albo przepnij przypisania.`,
      },
      409
    );
  }

  await db.delete(schema.salespeople).where(eq(schema.salespeople.id, id));
  return c.json<ApiResponse<null>>({ success: true, message: "Handlowiec usunięty" });
});

export default app;
