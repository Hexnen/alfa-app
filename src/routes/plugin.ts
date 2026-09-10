/**
 * API wtyczki przeglądarki „Dodaj do towarów Alfa" (/api/plugin/*).
 *
 * DLACZEGO OSOBNY ROUTER, POZA SESJĄ. Sesja aplikacji to cookie `alfa_session`
 * z SameSite=Lax: żądanie z service workera wtyczki NIE dostaje go w ogóle,
 * więc wtyczka musi mieć własne poświadczenie. Wzór jest w bazie od dawna —
 * `users.calendar_token` dla feedu ICS; tutaj to `users.plugin_token`
 * przysyłany jako `Authorization: Bearer <token>`.
 *
 * ZAKRES TOKENU jest wąski i taki ma zostać: cztery trasy poniżej. Odczyt
 * kartoteki („czy już to mamy?") i wrzucenie PROPOZYCJI do kolejki
 * `warehouse_import_inbox` — nigdy zapis towaru, nigdy panel, nigdy inny moduł.
 * Nawet gdy token wycieknie razem z paczką ZIP, napastnik nie ma czym zmienić
 * danych w systemie; propozycję z kolejki i tak zatwierdza człowiek w sesji.
 *
 * Router jest montowany PRZED `requireAuth` (src/routes/index.ts), bo cookie
 * tu nie ma. Uprawnienia sprawdzamy sami: `canView`/`canEdit` na
 * `technical/magazyn` — token nie może być obejściem uprawnień do zakładki.
 *
 * KSZTAŁT ODPOWIEDZI jest taki jak w całym API: `{ success, data }` przy 200
 * i `{ success: false, error }` przy błędzie. Wtyczka (extension/background.js)
 * czyta więc `json.data`.
 */
import { Hono, type Context, type Next } from "hono";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, schema } from "../db/index.js";
import type { User } from "../db/schema.js";
import { canView, canEdit } from "../lib/auth/permissions.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { resolveBaseUrl } from "../lib/order-mail.js";
import { pluginBuild } from "../lib/plugin-package.js";
import {
  parseShopPageInput,
  normalizeProductUrl,
  ShopImportInputError,
  type ShopImportParseResult,
} from "../lib/shop-import-service.js";
import { isKnownShop, parserFor, shopLabelFor } from "../lib/shop-import/parsers/registry.js";
import type { ParserId } from "../lib/shop-import/types.js";

const app = new Hono();

/** Zakładka, której uprawnienia rządzą całą wtyczką (magazyn → towary). */
export const PLUGIN_TAB = "technical/magazyn";

/**
 * Parsery sprawdzone na PRAWDZIWEJ stronie sklepu (kalibracja na zapisanej
 * próbce). Reszta rejestru to szkielety: dają nazwę i zdjęcie z JSON-LD/og,
 * ale kodu dostawcy ani ceny hurtowej nie gwarantują. Wtyczka mówi to
 * użytkownikowi wprost („parser ogólny — do kalibracji"), zamiast udawać
 * pewność, której nie ma.
 */
const CALIBRATED_PARSERS = new Set<ParserId>(["samal", "janex"]);
export function isCalibrated(parser: ParserId): boolean {
  return CALIBRATED_PARSERS.has(parser);
}

/**
 * Wersja aplikacji z package.json — wtyczka porównuje ją z wersją wpisaną do
 * paczki i ostrzega, gdy paczka jest starsza niż serwer. Czytane RAZ przy
 * starcie (plik się nie zmienia w trakcie życia procesu).
 */
let cachedVersion: string | null = null;
export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    cachedVersion = typeof v === "string" && v.trim() ? v.trim() : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

/**
 * Ile propozycji czeka w kolejce tego użytkownika (badge wtyczki i panel).
 * Wiersze po terminie odpadają w WARUNKU, nie dopiero przy czyszczeniu —
 * licznik musi być poprawny także wtedy, gdy nikt dawno nie importował.
 */
export function queuedCountFor(userId: number): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.warehouseImportInbox)
    .where(
      and(
        eq(schema.warehouseImportInbox.userId, userId),
        eq(schema.warehouseImportInbox.status, "queued"),
        sql`${schema.warehouseImportInbox.expiresAt} > datetime('now')`
      )
    )
    .get();
  return row?.count ?? 0;
}

/**
 * Usuwa wiersze po terminie (`expires_at`). Wołane LENIWIE — przy każdym
 * imporcie z wtyczki. Bez crona, bo to jedyna trasa, która kolejkę zapełnia:
 * skoro rośnie tylko tutaj, tutaj też wystarczy ją przycinać.
 *
 * `datetime('now')` to czas UTC (tak samo liczy się `created_at`), więc
 * porównanie tekstowe jest spójne z tym, co siedzi w kolumnie.
 */
function purgeExpired(): void {
  db.delete(schema.warehouseImportInbox)
    .where(sql`${schema.warehouseImportInbox.expiresAt} < datetime('now')`)
    .run();
}

/* ------------------------------- uwierzytelnienie ------------------------------- */

/**
 * Limity tempa w PAMIĘCI PROCESU, per użytkownik. Wtyczka pyta o `lookup` na
 * każdej stronie produktu, więc szybkie klikanie po katalogu jest normalne —
 * 60 odczytów na minutę mieści taką pracę, a nie mieści skryptu przemiatającego
 * sklep. Zapisy (import) są 3× rzadsze: to świadomy klik człowieka, a każdy
 * kosztuje parsowanie kilku MB HTML-a i wyjście po zdjęcie.
 *
 * Klucz to id użytkownika, nie IP: sekretem jest token, a nie adres, i nie
 * chcemy, żeby dwie osoby za jednym NAT-em zjadały sobie limit.
 */
const readLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, maxKeys: 2000 });
const writeLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, maxKeys: 2000 });

const TOKEN_MIN_LENGTH = 32;

function unauthorized(c: Context) {
  return c.json({ success: false, error: "Nieprawidłowy token wtyczki" }, 401);
}

/**
 * Bearer → użytkownik. Wszystko, co nie jest poprawnym, istniejącym tokenem,
 * daje 401 z tym samym komunikatem: przy 401 nie ma po co podpowiadać, czy
 * token „był za krótki", czy „nie istnieje".
 */
async function requirePluginToken(c: Context, next: Next) {
  const header = (c.req.header("authorization") ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1] ?? "";
  // Krótkiego tokenu nie szukamy w bazie — nasze mają 64 znaki (32 bajty hex),
  // a zapytanie o „” trafiłoby w kolumnę NULL, gdyby ktoś kiedyś zmienił typ.
  if (token.length < TOKEN_MIN_LENGTH) return unauthorized(c);

  const user = db.select().from(schema.users).where(eq(schema.users.pluginToken, token)).get();
  if (!user) return unauthorized(c);

  // Token NIE jest obejściem uprawnień do zakładki: bez wglądu w magazyn
  // wtyczka nie ma prawa nawet zapytać „czy mamy ten towar".
  if (!canView(user, PLUGIN_TAB)) {
    return c.json({ success: false, error: "Brak dostępu do magazynu" }, 403);
  }
  const isWrite = c.req.method.toUpperCase() !== "GET";
  if (isWrite && !canEdit(user, PLUGIN_TAB)) {
    return c.json({ success: false, error: "Brak uprawnień do edycji magazynu" }, 403);
  }

  const limiter = isWrite ? writeLimiter : readLimiter;
  if (!limiter.check(String(user.id))) {
    return c.json(
      { success: false, error: "Za dużo żądań z wtyczki — spróbuj po minucie" },
      429
    );
  }

  c.set("user", user);
  return next();
}

app.use("*", requirePluginToken);

const pluginUser = (c: Context): User => c.get("user") as User;

/* ------------------------------------ trasy ------------------------------------ */

/**
 * GET /api/plugin/me — „czy token żyje i kim jestem".
 * Wtyczka woła to w opcjach („Sprawdź połączenie") i przy starcie, żeby
 * ustawić badge oraz porównać wersje.
 */
app.get("/me", (c) => {
  const user = pluginUser(c);
  return c.json({
    success: true,
    data: {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      canEdit: canEdit(user, PLUGIN_TAB),
      appVersion: appVersion(),
      pluginBuild: pluginBuild(),
      baseUrl: resolveBaseUrl(c),
      queued: queuedCountFor(user.id),
    },
  });
});

/** Domena sklepu z adresu strony (bez `www.`) — klucz tożsamości źródła. */
function shopFromUrl(raw: string): string {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * GET /api/plugin/lookup?url= — „czy ten produkt jest już w kartotece".
 *
 * Odpowiada na PYTANIE PRZED KLIKNIĘCIEM: panel w sklepie pokazuje „Masz
 * w Alfa: NAZWA — cena z DATA" albo „Nowy towar". Dopasowanie idzie po
 * znormalizowanym adresie strony w `warehouse_item_sources` (http/https, `www.`,
 * kotwica i końcowy ukośnik nie tworzą trzech różnych produktów).
 *
 * Świadomie NIE parsujemy tu strony: to zapytanie leci przy każdym otwarciu
 * produktu, a HTML-a i tak nie mamy (content script wysyła go dopiero na klik).
 */
app.get("/lookup", (c) => {
  const user = pluginUser(c);
  const raw = (c.req.query("url") ?? "").trim();
  if (!raw) return c.json({ success: false, error: "Brak adresu produktu (?url=)" }, 400);

  const shop = shopFromUrl(raw);
  const parser = parserFor(shop).id;
  const normalized = normalizeProductUrl(raw);

  let item: {
    id: number;
    name: string;
    sku: string | null;
    purchasePrice: number | null;
    priceUpdatedAt: string | null;
    lastPriceNet: number | null;
    fetchedAt: string | null;
    isArchived: boolean;
  } | null = null;

  if (shop && normalized) {
    // Wierszy jednego sklepu jest w kartotece kilkadziesiąt, a normalizacja
    // adresu nie da się wyrazić w SQL — filtrujemy po sklepie (jest indeks),
    // porównujemy w pamięci.
    const sources = db
      .select({
        itemId: schema.warehouseItemSources.itemId,
        productUrl: schema.warehouseItemSources.productUrl,
        lastPriceNet: schema.warehouseItemSources.lastPriceNet,
        fetchedAt: schema.warehouseItemSources.fetchedAt,
      })
      .from(schema.warehouseItemSources)
      .where(eq(schema.warehouseItemSources.shop, shop))
      .all();
    const hit = sources.find((s) => normalizeProductUrl(s.productUrl) === normalized);
    if (hit) {
      const row = db
        .select({
          id: schema.warehouseItems.id,
          name: schema.warehouseItems.name,
          sku: schema.warehouseItems.sku,
          purchasePrice: schema.warehouseItems.purchasePrice,
          priceUpdatedAt: schema.warehouseItems.priceUpdatedAt,
          isArchived: schema.warehouseItems.isArchived,
        })
        .from(schema.warehouseItems)
        .where(eq(schema.warehouseItems.id, hit.itemId))
        .get();
      // Źródło bez towaru jest niemożliwe (FK CASCADE), ale gdy towar zniknął
      // w trakcie zapytania, uczciwiej powiedzieć „nie mam" niż zwrócić pół wiersza.
      if (row) {
        item = {
          ...row,
          lastPriceNet: hit.lastPriceNet,
          fetchedAt: hit.fetchedAt,
        };
      }
    }
  }

  return c.json({
    success: true,
    data: {
      shop,
      shopLabel: shopLabelFor(shop),
      parser,
      supported: isKnownShop(shop),
      calibrated: isCalibrated(parser),
      found: item !== null,
      item,
      queued: queuedCountFor(user.id),
      // Aktualny build paczki na serwerze — widget porównuje z ALFA_CONFIG.build.
      pluginBuild: pluginBuild(),
    },
  });
});

/** +7 dni od teraz w formacie SQLite (UTC) — tak samo liczy się `created_at`. */
const EXPIRES_SQL = sql`(datetime('now','+7 days'))`;
const NOW_SQL = sql`(datetime('now'))`;

/**
 * POST /api/plugin/import — jedyna trasa zapisu wtyczki.
 *
 * Wtyczka jest CIENKIM KLIENTEM: przysyła `outerHTML` strony, adres i tytuł
 * karty, a całe parsowanie, dopasowanie i pobranie zdjęcia robi ten sam serwis,
 * co import z pliku (src/lib/shop-import-service.ts). Dzięki temu nie ma dwóch
 * pojęć „co udało się rozpoznać" i dwóch list dopasowań.
 *
 * Kolejka jest zapisywana ZAWSZE, także w trybie „open": klik przy zamkniętej
 * karcie Magazynu inaczej przepadałby bez śladu. `openUrl` to tylko adres,
 * pod który wtyczka przełączy (albo otworzy) kartę aplikacji.
 */
app.post("/import", async (c) => {
  const user = pluginUser(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);

  const html = typeof body?.html === "string" ? body.html : "";
  if (!html.trim()) return c.json({ success: false, error: "Brak treści strony (pole „html”)" }, 400);
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : null;
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : null;
  const rawMode = body?.mode;
  if (rawMode !== undefined && rawMode !== null && rawMode !== "open" && rawMode !== "queue") {
    return c.json({ success: false, error: "Nieprawidłowy tryb (dozwolone: open, queue)" }, 400);
  }
  // Brak `mode` traktujemy jak „open" — tak działa duży przycisk w sklepie.
  const mode: "open" | "queue" = rawMode === "queue" ? "queue" : "open";

  // Kolejka rośnie tylko tutaj, więc tutaj ją przycinamy (bez crona).
  purgeExpired();

  let result: ShopImportParseResult;
  try {
    result = await parseShopPageInput({ kind: "html", html, url: url ?? undefined });
  } catch (err) {
    if (err instanceof ShopImportInputError) {
      return c.json({ success: false, error: err.message }, 400);
    }
    throw err;
  }

  // Co idzie do `parsed_json`, a co do kolumn:
  //  · `accountLabel` (e-mail konta w sklepie) to dana osobowa nieprzydatna
  //    w kartotece — zerujemy ją PRZED zapisem, ale KLUCZ zostaje, żeby wiersz
  //    kolejki dał się odesłać w dokładnie tym samym kształcie, co odpowiedź
  //    `/import/parse` (formularz towaru czyta jedno i drugie tym samym kodem);
  //  · zdjęcie i jego ostrzeżenie mają WŁASNE kolumny (`photo_data`,
  //    `photo_warning`) — trzymanie ich także w JSON-ie podwajałoby megabajt
  //    base64 na każdy wiersz. Trasa `/warehouse/import/inbox/:id` skleja
  //    jedno z drugim.
  const stored: Omit<ShopImportParseResult, "photoData" | "photoWarning"> = {
    parsed: { ...result.parsed, accountLabel: null },
    suggestedItem: result.suggestedItem,
    suggestedSource: result.suggestedSource,
    matches: result.matches,
  };

  const parsed = result.parsed;
  const firstSourceMatch = result.matches.find((m) => m.reason === "source") ?? null;
  const normalized = normalizeProductUrl(url ?? parsed.url);

  const values = {
    userId: user.id,
    status: "queued" as const,
    mode,
    shop: parsed.shop || null,
    shopLabel: parsed.shopLabel || null,
    productUrl: url ?? parsed.url,
    pageTitle: title,
    name: parsed.name,
    priceNet: result.suggestedItem.purchasePrice,
    parsedJson: JSON.stringify(stored),
    photoData: result.photoData,
    photoWarning: result.photoWarning,
    matchCount: result.matches.length,
    matchItemId: firstSourceMatch?.id ?? null,
    expiresAt: EXPIRES_SQL,
  };

  // Dedup po ZNORMALIZOWANYM adresie: dwa kliknięcia na tej samej stronie to
  // jedna propozycja z nowszymi danymi, nie dwa wiersze do przeklikania.
  // Bierzemy tylko wiersze żywe (queued|opened) — `done`/`discarded` to
  // zamknięte sprawy, których nie wolno wskrzeszać w tle.
  let existingId: number | null = null;
  if (normalized) {
    const rows = db
      .select({
        id: schema.warehouseImportInbox.id,
        productUrl: schema.warehouseImportInbox.productUrl,
      })
      .from(schema.warehouseImportInbox)
      .where(
        and(
          eq(schema.warehouseImportInbox.userId, user.id),
          inArray(schema.warehouseImportInbox.status, ["queued", "opened"])
        )
      )
      .orderBy(desc(schema.warehouseImportInbox.id))
      .all();
    existingId = rows.find((r) => normalizeProductUrl(r.productUrl) === normalized)?.id ?? null;
  }

  let id: number;
  if (existingId !== null) {
    // Nadpisanie wraca do statusu `queued` i odświeża `created_at`: to nowy
    // klik człowieka, więc propozycja ma znów stanąć na górze listy, nawet
    // jeśli poprzednio ktoś ją tylko otworzył i zostawił.
    const updated = db
      .update(schema.warehouseImportInbox)
      .set({ ...values, openedAt: null, createdAt: NOW_SQL })
      .where(eq(schema.warehouseImportInbox.id, existingId))
      .returning({ id: schema.warehouseImportInbox.id })
      .get();
    id = updated?.id ?? existingId;
  } else {
    const inserted = db
      .insert(schema.warehouseImportInbox)
      .values(values)
      .returning({ id: schema.warehouseImportInbox.id })
      .get();
    id = inserted.id;
  }

  // `openUrl` musi być ABSOLUTNY: wtyczka wkleja go w `tabs.update`, gdzie
  // ścieżka względna nie ma do czego się odnieść. Gdy nagłówków proxy nie ma
  // (testy przez `app.request`), bierzemy origin z samego żądania.
  const base = resolveBaseUrl(c) || new URL(c.req.url).origin;
  const warnings = [...parsed.diagnostics.warnings];
  if (result.photoWarning) warnings.push(result.photoWarning);

  return c.json({
    success: true,
    data: {
      id,
      shop: parsed.shop,
      shopLabel: parsed.shopLabel,
      name: parsed.name,
      priceNet: result.suggestedItem.purchasePrice,
      parser: parsed.diagnostics.parserUsed,
      calibrated: isCalibrated(parsed.diagnostics.parserUsed),
      // Werdykt parsera o zalogowaniu w SKLEPIE (nie w Alfa) — wtyczka pokazuje
      // go w toaście, bo ceny ze strony bez logowania są detaliczne albo puste.
      loggedIn: parsed.loggedIn,
      matches: result.matches.map((m) => ({
        itemId: m.id,
        name: m.name,
        reason: m.reason,
        confidence: m.confidence,
      })),
      openUrl: `${base}/technical/magazyn?import=${id}`,
      queued: queuedCountFor(user.id),
      warnings,
    },
  });
});

/** GET /api/plugin/queue-count — badge wtyczki po starcie przeglądarki. */
app.get("/queue-count", (c) => {
  return c.json({ success: true, data: { queued: queuedCountFor(pluginUser(c).id) } });
});

export default app;
