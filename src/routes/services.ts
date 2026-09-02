/**
 * Usługi (/api/services) — katalog pozycji niebędących towarem, z których
 * składa się oferta: montaż kamery, uruchomienie, konfiguracja, dojazd.
 *
 * W odróżnieniu od Cennika (`/api/pricelist`) każda pozycja ma KOSZT WŁASNY
 * obok ceny sprzedaży — bez tego marża oferty byłaby fikcją. Cennik zostaje
 * nietknięty przy wycenach powykonawczych (patrz komentarz nad `services`
 * w src/db/schema.ts).
 *
 * Usługi archiwizujemy przez `active = false`, nie kasujemy: pozycja usunięta
 * z katalogu nadal figuruje na wystawionych ofertach, a te trzymają migawkę
 * nazwy i ceny, więc historia nie może zależeć od tego, czy ktoś sprzątnął
 * katalog.
 */
import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { eq, asc, and, type SQL } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import { getUser } from "../middleware/auth.js";
import { canEdit, canView } from "../lib/auth/permissions.js";
import {
  SERVICE_CATEGORIES,
  SERVICE_SYSTEMS,
  type NewService,
  type ServiceCategory,
  type ServiceSystem,
} from "../db/schema.js";
import { marginOf } from "../lib/margin.js";

const app = new Hono();

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Kwota netto ≥ 0; przecinek dziesiętny dozwolony. Pusto = 0. */
function money(v: unknown, label: string): { value?: number; error?: string } {
  if (v === undefined || v === null || v === "") return { value: 0 };
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  if (!Number.isFinite(n) || n < 0)
    return { error: `${label} musi być liczbą nieujemną` };
  return { value: Math.round(n * 100) / 100 };
}

function parseBody(body: Record<string, unknown>): {
  data?: Partial<NewService>;
  error?: string;
} {
  const name = str(body.name);
  if (!name) return { error: "Nazwa usługi jest wymagana" };
  if (name.length > 200) return { error: "Nazwa usługi jest za długa (maks. 200 znaków)" };

  const category = SERVICE_CATEGORIES.includes(body.category as ServiceCategory)
    ? (body.category as ServiceCategory)
    : "montaz";

  // NULL = usługa uniwersalna. Pusty string z selecta też znaczy „żaden system".
  const systemRaw = str(body.system);
  const system: ServiceSystem | null = SERVICE_SYSTEMS.includes(
    systemRaw as ServiceSystem
  )
    ? (systemRaw as ServiceSystem)
    : null;

  const cost = money(body.cost, "Koszt własny");
  if (cost.error) return { error: cost.error };
  const price = money(body.price, "Cena");
  if (price.error) return { error: price.error };

  return {
    data: {
      name,
      category,
      system,
      unit: str(body.unit) || "szt",
      cost: cost.value ?? 0,
      price: price.value ?? 0,
      description: str(body.description) || null,
      active: body.active === undefined ? true : Boolean(body.active),
      position: Number.isFinite(Number(body.position)) ? Number(body.position) : 0,
    },
  };
}

/**
 * Login (email) → nazwa użytkownika, rozwiązywane JEDNYM zapytaniem po całej
 * tabeli `users`, a nie zapytaniem na wiersz (N+1 przy setkach pozycji).
 * Ten sam wzorzec co w liście ofert i w kartotece magazynu.
 */
function userLabelByEmail(): (email: string | null) => string | null {
  const byEmail = new Map(
    db
      .select({ email: schema.users.email, displayName: schema.users.displayName })
      .from(schema.users)
      .all()
      .map((u) => [u.email.toLowerCase(), u.displayName || u.email])
  );
  // Surowy login zostaje, gdy konto zniknęło z bazy — lepszy ślad niż kreska.
  return (email) => (email ? byEmail.get(email.toLowerCase()) ?? email : null);
}

/**
 * Czy stawka FAKTYCZNIE się zmieniła. W usłudze cena to PARA (`cost` i `price`)
 * — przeterminowany koszt własny psuje marżę tak samo jak przeterminowana cena
 * sprzedaży, więc stempel przestawia zmiana którejkolwiek z nich.
 */
function priceChanged(
  before: { cost: number; price: number },
  after: { cost?: number; price?: number }
): boolean {
  return after.cost !== before.cost || after.price !== before.price;
}

/** Dokleja marżę i narzut — liczone, nigdy nie zapisywane (src/lib/margin.ts). */
function withMargin<T extends { cost: number; price: number }>(row: T) {
  const m = marginOf(row.cost, row.price);
  return {
    ...row,
    marginAmount: m?.amount ?? null,
    marginPct: m?.marginPct ?? null,
    markupPct: m?.markupPct ?? null,
  };
}

/**
 * Czy pokazać koszt własny i marżę pozycji.
 *
 * `/services` jest CELOWO czytelne także dla kogoś, kto ma same Oferty —
 * edytor musi z czegoś brać robociznę. Ale `services.cost` to dokładnie ta sama
 * liczba, którą `redactCosts` starannie wycina z pozycji oferty, więc bez tej
 * kontroli klucz `technical/oferty-koszty` nie chroniłby niczego: koszt
 * robocizny i tak leżałby w odpowiedzi, którą front ofert pobiera przy każdym
 * wejściu na stronę.
 *
 * Widzi je ten, kto ma własny klucz katalogu ALBO klucz kosztów ofert.
 */
function canSeeServiceCosts(c: Context): boolean {
  const user = getUser(c);
  if (!user) return false;
  return canView(user, "technical/uslugi") || canView(user, "technical/oferty-koszty");
}

const SERVICE_COST_FIELDS = ["cost", "marginAmount", "marginPct", "markupPct"] as const;

function stripCosts<T extends object>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if ((SERVICE_COST_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Zapis w katalogu wymaga WŁASNEGO uprawnienia do Usług.
 *
 * `API_TAB_MAP` daje `/services` dwie zakładki, a `maxLevel()` bierze z nich
 * NAJWYŻSZY poziom — więc `technical/oferty: edit` otwierał pełny zapis
 * w katalogu robocizny całej firmy (a te stawki wchodzą w marżę każdej oferty).
 * Intencja wspólnego wpisu dotyczy wyłącznie ODCZYTU — patrz komentarz
 * w src/middleware/auth.ts. To ta sama pułapka, którą przy Analityce rozbito
 * na trzy osobne wpisy.
 */
const canWriteServices = (c: Context): boolean => {
  const user = getUser(c);
  return !!user && canEdit(user, "technical/uslugi");
};

/** 403 dla zapisu bez uprawnienia do katalogu Usług. */
const forbiddenWrite = (c: Context) =>
  c.json<ApiResponse<null>>(
    { success: false, error: "Brak uprawnień do edycji katalogu Usług" },
    403
  );

// Lista usług; ?category= i ?system= zawężają, ?includeInactive=1 pokazuje archiwum.
app.get("/", async (c) => {
  const filters: SQL[] = [];
  if (c.req.query("includeInactive") !== "1") {
    filters.push(eq(schema.services.active, true));
  }
  const category = c.req.query("category");
  if (category && SERVICE_CATEGORIES.includes(category as ServiceCategory)) {
    filters.push(eq(schema.services.category, category as ServiceCategory));
  }
  const system = c.req.query("system");
  if (system && SERVICE_SYSTEMS.includes(system as ServiceSystem)) {
    filters.push(eq(schema.services.system, system as ServiceSystem));
  }

  const rows = await db
    .select()
    .from(schema.services)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(schema.services.position), asc(schema.services.name));

  const label = userLabelByEmail();
  const rows2 = rows.map((r) => ({
    ...withMargin(r),
    createdByLabel: label(r.createdBy),
    updatedByLabel: label(r.updatedBy),
  }));
  return c.json({
    success: true,
    data: canSeeServiceCosts(c) ? rows2 : rows2.map(stripCosts),
  });
});

// Nowa usługa
app.post("/", async (c) => {
  if (!canWriteServices(c)) return forbiddenWrite(c);
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  if (!data.position) {
    const rows = await db.select().from(schema.services);
    data.position = rows.length + 1;
  }

  // Stawka jest w usłudze zawsze (`cost`/`price` mają NOT NULL DEFAULT 0),
  // więc nowa pozycja od razu dostaje stempel — inaczej katalog założony dziś
  // wyglądałby na przeterminowany.
  const result = await db
    .insert(schema.services)
    .values({
      ...data,
      createdBy: getUser(c)?.email ?? null,
      priceUpdatedAt: new Date().toISOString(),
    } as NewService)
    .returning();

  const label = userLabelByEmail();
  return c.json(
    {
      success: true,
      data: {
        ...withMargin(result[0]),
        createdByLabel: label(result[0].createdBy),
        updatedByLabel: label(result[0].updatedBy),
      },
      message: "Usługa dodana",
    },
    201
  );
});

// Edycja usługi (PUT = pełna podmiana, jak w pozostałych słownikach)
app.put("/:id", async (c) => {
  if (!canWriteServices(c)) return forbiddenWrite(c);
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.services)
    .where(eq(schema.services.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono usługi" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  // Wiek stawki przestawia WYŁĄCZNIE zmiana `cost`/`price`. Poprawka nazwy czy
  // opisu ma zostawić stempel w spokoju — inaczej jedno porządkowanie katalogu
  // odmładzałoby wszystkie stawki naraz i alert o przeterminowaniu zamilkłby.
  const stampPrice = priceChanged(existing[0], data);
  const now = new Date().toISOString();
  const result = await db
    .update(schema.services)
    .set({
      ...data,
      updatedBy: getUser(c)?.email ?? null,
      ...(stampPrice ? { priceUpdatedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(schema.services.id, id))
    .returning();

  const label = userLabelByEmail();
  return c.json({
    success: true,
    data: {
      ...withMargin(result[0]),
      createdByLabel: label(result[0].createdBy),
      updatedByLabel: label(result[0].updatedBy),
    },
    message: "Usługa zaktualizowana",
  });
});

/**
 * DELETE = archiwizacja (`active = false`), nie skasowanie wiersza.
 * Oferty trzymają migawkę nazwy i ceny, ale `service_id` nadal na tę pozycję
 * wskazuje — twarde usunięcie zerwałoby ten ślad.
 */
app.delete("/:id", async (c) => {
  if (!canWriteServices(c)) return forbiddenWrite(c);
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.services)
    .where(eq(schema.services.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono usługi" },
      404
    );
  }

  await db
    .update(schema.services)
    .set({ active: false, updatedAt: new Date().toISOString() })
    .where(eq(schema.services.id, id))
    .run();

  return c.json({ success: true, data: null, message: "Usługa zarchiwizowana" });
});

export default app;
