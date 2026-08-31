import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { EMPLOYER_MARKUP_MAX, EMPLOYER_MARKUP_MIN } from "../lib/company-config.js";
import { asc, eq, sql } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { isMfError, lookupCompanyByNip } from "../lib/mf-whitelist.js";

const app = new Hono();

/**
 * Spółki grupy — słownik wspólny dla kadr (arkusz WYNAGRODZENIA trzyma spółkę jako
 * tekst w `hr_contracts.company` / `hr_office_payroll.company`) i dla obiektów
 * (`objects.company_id`).
 *
 * Ponieważ kadry wiążą się po NAZWIE, zmiana nazwy w słowniku przepisuje wiersze kadrowe
 * w tej samej transakcji — inaczej umowy zostałyby przy starym napisie i wypadły ze
 * statystyk spółki. Kasowanie jest możliwe tylko dla spółki bez obiektów i bez umów.
 */
function usageOf(name: string, id: number) {
  const objects = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.companyId, id))
    .get();
  const contracts = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.company, name))
    .get();
  const office = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.hrOfficePayroll)
    .where(eq(schema.hrOfficePayroll.company, name))
    .get();
  return {
    objects: objects?.count ?? 0,
    contracts: contracts?.count ?? 0,
    officeRows: office?.count ?? 0,
  };
}

interface CompanyFields {
  name: string;
  fullName: string;
  nip: string;
  regon: string;
  krs: string;
  address: string;
  postalCode: string;
  city: string;
  vatStatus: string;
  vatCheckedAt: string;
  notes: string;
  active: boolean;
  // Nadpisania narzutów składek pracodawcy. null = spółka bierze wartość globalną
  // z app_settings (`company.employer_markup_*`).
  employerMarkupUop: number | null;
  employerMarkupZlecenieZua: number | null;
  employerMarkupZlecenieZza: number | null;
}

/**
 * Narzut: pusty/`null` = dziedzicz globalny; liczba musi mieścić się w 1–3.
 * Poniżej 1 znaczyłoby, że koszt zatrudnienia jest niższy niż sama wypłata,
 * powyżej 3 — że składki są dwukrotnie wyższe od pensji; oba to pomyłka wpisu.
 */
function parseMarkup(v: unknown, label: string): { value: number | null } | { error: string } {
  if (v === undefined || v === null || v === "") return { value: null };
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(",", ".")) : NaN;
  if (!Number.isFinite(n)) {
    return { error: `Narzut składek (${label}) musi być liczbą albo pozostać pusty` };
  }
  // Granice z company-config.ts, a nie wpisane tu drugi raz — inaczej zmiana
  // limitu w ustawieniach globalnych rozjechałaby się z walidacją nadpisań.
  if (n < EMPLOYER_MARKUP_MIN) {
    return {
      error: `Narzut składek (${label}) nie może być mniejszy niż ${EMPLOYER_MARKUP_MIN} — znaczyłoby to, że koszt zatrudnienia jest niższy niż sama wypłata. Zostaw pole puste, żeby użyć wartości globalnej.`,
    };
  }
  if (n > EMPLOYER_MARKUP_MAX) {
    return {
      error: `Narzut składek (${label}) nie może być większy niż ${EMPLOYER_MARKUP_MAX} — to już ${EMPLOYER_MARKUP_MAX}-krotność wypłaty, więc pewnie literówka. Zostaw pole puste, żeby użyć wartości globalnej.`,
    };
  }
  return { value: n };
}

function parseBody(body: Record<string, unknown>): { data?: CompanyFields; error?: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Nazwa spółki jest wymagana" };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const nip = typeof body.nip === "string" ? normalizeNIP(body.nip) : "";
  // NIP jest opcjonalny (spółka może być w słowniku bez niego), ale wpisany musi być poprawny —
  // ten sam walidator sumy kontrolnej, co przy kontrahentach.
  if (nip && !validateNIP(nip)) {
    return { error: "Nieprawidłowy NIP (błędna suma kontrolna)" };
  }

  const uop = parseMarkup(body.employerMarkupUop, "umowa o pracę");
  if ("error" in uop) return { error: uop.error };
  const zua = parseMarkup(body.employerMarkupZlecenieZua, "zlecenie ZUA");
  if ("error" in zua) return { error: zua.error };
  const zza = parseMarkup(body.employerMarkupZlecenieZza, "zlecenie ZZA");
  if ("error" in zza) return { error: zza.error };

  return {
    data: {
      name,
      fullName: str(body.fullName),
      nip,
      regon: str(body.regon),
      krs: str(body.krs),
      address: str(body.address),
      postalCode: str(body.postalCode),
      city: str(body.city),
      vatStatus: str(body.vatStatus),
      vatCheckedAt: str(body.vatCheckedAt),
      notes: typeof body.notes === "string" ? body.notes : "",
      active: body.active === undefined ? true : Boolean(body.active),
      employerMarkupUop: uop.value,
      employerMarkupZlecenieZua: zua.value,
      employerMarkupZlecenieZza: zza.value,
    },
  };
}

// Lista spółek z licznikami użycia (obiekty + kadry)
app.get("/", async (c) => {
  const onlyActive = c.req.query("active") === "true";

  const rows = await db
    .select({
      company: schema.companies,
      objectsCount: sql<number>`(
        select count(*) from objects where objects.company_id = companies.id
      )`,
      objectsMonthlyValue: sql<number>`(
        select coalesce(sum(coalesce(monthly_value, 0) + coalesce(monthly_rental, 0)), 0) from objects where objects.company_id = companies.id
      )`,
      contractsCount: sql<number>`(
        select count(*) from hr_contracts where hr_contracts.company = companies.name
      )`,
    })
    .from(schema.companies)
    .orderBy(asc(sql`lower(${schema.companies.name})`));

  const data = rows
    .filter((r) => !onlyActive || r.company.active)
    .map((r) => ({
      ...r.company,
      objectsCount: r.objectsCount ?? 0,
      objectsMonthlyValue: r.objectsMonthlyValue ?? 0,
      contractsCount: r.contractsCount ?? 0,
    }));

  return c.json({ success: true, data });
});

// Nowa spółka
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const exists = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(sql`lower(${schema.companies.name}) = lower(${data.name})`)
    .limit(1);
  if (exists.length > 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Spółka o tej nazwie już istnieje" }, 409);
  }

  const result = await db.insert(schema.companies).values(data).returning();
  return c.json({ success: true, data: result[0], message: "Spółka dodana" }, 201);
});

// Edycja spółki (zmiana nazwy przepisuje wiersze kadrowe)
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();

  // Sam przełącznik archiwum nie musi nieść całego formularza.
  if (Object.keys(body).length === 1 && typeof body.active === "boolean") {
    const updated = await db
      .update(schema.companies)
      .set({ active: body.active, updatedAt: new Date().toISOString() })
      .where(eq(schema.companies.id, id))
      .returning();
    if (updated.length === 0) {
      return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono spółki" }, 404);
    }
    return c.json({
      success: true,
      data: updated[0],
      message: body.active ? "Spółka przywrócona" : "Spółka zarchiwizowana",
    });
  }

  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const outcome = db.transaction((tx) => {
    const existing = tx.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
    if (!existing) return { status: 404 as const };

    if (existing.name !== data.name) {
      const clash = tx
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(sql`lower(${schema.companies.name}) = lower(${data.name}) and ${schema.companies.id} <> ${id}`)
        .get();
      if (clash) return { status: 409 as const };
    }

    const updated = tx
      .update(schema.companies)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(schema.companies.id, id))
      .returning()
      .all();

    // Kadry wiążą się ze spółką po nazwie — przepisujemy je razem ze zmianą.
    let renamed = 0;
    if (existing.name !== data.name) {
      renamed += tx
        .update(schema.hrContracts)
        .set({ company: data.name })
        .where(eq(schema.hrContracts.company, existing.name))
        .run().changes;
      renamed += tx
        .update(schema.hrOfficePayroll)
        .set({ company: data.name })
        .where(eq(schema.hrOfficePayroll.company, existing.name))
        .run().changes;
    }

    return { status: 200 as const, company: updated[0], renamed, oldName: existing.name };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono spółki" }, 404);
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>({ success: false, error: "Spółka o tej nazwie już istnieje" }, 409);
  }

  return c.json({
    success: true,
    data: outcome.company,
    message:
      outcome.renamed > 0
        ? `Spółka zaktualizowana; przepisano ${outcome.renamed} wierszy kadrowych z „${outcome.oldName}”`
        : "Spółka zaktualizowana",
  });
});

// Kasowanie tylko dla spółki bez obiektów i bez śladu w kadrach
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono spółki" }, 404);
  }

  const used = usageOf(existing[0].name, id);
  if (used.objects > 0 || used.contracts > 0 || used.officeRows > 0) {
    const bits = [
      used.objects > 0 ? `${used.objects} obiekt(ów)` : null,
      used.contracts > 0 ? `${used.contracts} umów w kadrach` : null,
      used.officeRows > 0 ? `${used.officeRows} wierszy wynagrodzeń biura` : null,
    ].filter(Boolean);
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `Spółka ma powiązane ${bits.join(" i ")} — zarchiwizuj ją zamiast kasować.`,
      },
      409
    );
  }

  await db.delete(schema.companies).where(eq(schema.companies.id, id));
  return c.json<ApiResponse<null>>({ success: true, message: "Spółka usunięta" });
});

/**
 * Sprawdzenie spółki w wykazie VAT MF po jej NIP-ie i zapis pobranych danych
 * (pełna nazwa, REGON, KRS, adres, status VAT). Ten sam walidator, co przy
 * kontrahentach — tylko wołany dla wiersza słownika, a nie z formularza.
 */
app.post("/:id/lookup", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono spółki" }, 404);
  }

  const nip = normalizeNIP(existing[0].nip ?? "");
  if (!nip) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Spółka nie ma NIP-u — uzupełnij go, żeby sprawdzić w wykazie MF" },
      400
    );
  }
  if (!validateNIP(nip)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy NIP (błędna suma kontrolna)" },
      400
    );
  }

  const result = await lookupCompanyByNip(nip, { skipCache: c.req.query("refresh") === "1" });
  if (isMfError(result)) {
    // Awaria rejestru to nie błąd naszej bazy — 502, dane w słowniku zostają.
    return c.json<ApiResponse<null>>({ success: false, error: result.error }, 502);
  }
  if (!result.found || !result.company) {
    const updated = await db
      .update(schema.companies)
      .set({ vatStatus: "Niezarejestrowany", vatCheckedAt: new Date().toISOString().slice(0, 10), updatedAt: new Date().toISOString() })
      .where(eq(schema.companies.id, id))
      .returning();
    return c.json({
      success: true,
      data: updated[0],
      message: "Wykaz MF nie zna tego NIP-u (status: niezarejestrowany)",
    });
  }

  const mf = result.company;
  const updated = await db
    .update(schema.companies)
    .set({
      fullName: mf.name,
      nip: mf.nip,
      regon: mf.regon,
      krs: mf.krs,
      address: mf.address,
      postalCode: mf.postalCode,
      city: mf.city,
      vatStatus: mf.statusVat ?? "",
      vatCheckedAt: mf.date,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.companies.id, id))
    .returning();

  return c.json({
    success: true,
    data: updated[0],
    message: `Zaktualizowano z wykazu MF: ${mf.name} (VAT: ${mf.statusVat ?? "brak"})`,
  });
});

export default app;
