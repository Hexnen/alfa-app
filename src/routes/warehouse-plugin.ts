/**
 * Trasy sesyjne wtyczki magazynu — kolejka importów, token i paczka ZIP.
 *
 * PODZIAŁ WZGLĘDEM src/routes/plugin.ts: tam mieszka API, z którym rozmawia
 * SAMA WTYCZKA (Bearer, bez cookie). Tutaj są trasy dla PANELU w przeglądarce
 * (zwykła sesja): lista propozycji z wtyczki, zarządzanie tokenem i pobranie
 * paczki. Router jest montowany pod `/warehouse` PRZED `warehouseRoutes`, więc
 * strażnik zakładek (`{ prefix: "/warehouse", tabs: ["technical/magazyn"] }`)
 * obejmuje go z prefiksu — odczyt wymaga „view”, zapis „edit”.
 *
 * Kolejność montażu ma znaczenie: gdyby ten router wisiał PO `warehouseRoutes`,
 * Hono dopasowałoby najpierw ogólniejsze trasy magazynu.
 */
import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import PizZip from "pizzip";
import { db, schema } from "../db/index.js";
import type { User } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { contentDisposition } from "../lib/calendar-attachments.js";
import { resolveBaseUrl } from "../lib/order-mail.js";
import { knownShops } from "../lib/shop-import/index.js";
import { appVersion, isCalibrated, queuedCountFor } from "./plugin.js";
import { PACKAGE_FILES, extensionDir, pluginBuild } from "../lib/plugin-package.js";

const app = new Hono();

const jsonError = (c: Context, status: 400 | 404 | 500, error: string) =>
  c.json({ success: false, error }, status);

/** „Żywy” wiersz kolejki: mój, nieprzeterminowany. */
const liveRow = (user: User) =>
  and(
    eq(schema.warehouseImportInbox.userId, user.id),
    sql`${schema.warehouseImportInbox.expiresAt} > datetime('now')`
  );

// ============================================================
// KOLEJKA IMPORTÓW Z WTYCZKI
// ============================================================

/**
 * GET /warehouse/import/inbox — „Do dodania z wtyczki”.
 *
 * Pokazujemy tylko `queued` i `opened`: `done` i `discarded` zostają w tabeli
 * (żeby ponowny klik w sklepie nie wskrzeszał zamkniętej sprawy), ale w panelu
 * byłyby szumem. Wiersze po terminie odpadają w WARUNKU, a nie przez
 * czyszczenie — lista musi być poprawna także wtedy, gdy nikt dawno nie
 * importował (czyszczenie chodzi leniwie przy POST /api/plugin/import).
 */
app.get("/import/inbox", (c) => {
  const user = getUser(c);
  const rows = db
    .select()
    .from(schema.warehouseImportInbox)
    .where(and(liveRow(user), inArray(schema.warehouseImportInbox.status, ["queued", "opened"])))
    .orderBy(desc(schema.warehouseImportInbox.createdAt), desc(schema.warehouseImportInbox.id))
    .limit(200)
    .all();

  return c.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      status: r.status,
      mode: r.mode,
      shop: r.shop,
      shopLabel: r.shopLabel,
      name: r.name,
      pageTitle: r.pageTitle,
      productUrl: r.productUrl,
      priceNet: r.priceNet,
      matchCount: r.matchCount,
      matchItemId: r.matchItemId,
      // Samego zdjęcia (do 1 MB base64) NIE wysyłamy w liście — wystarczy
      // informacja, że jest; pełne dane idą dopiero przy otwarciu wiersza.
      hasPhoto: r.photoData !== null && r.photoData !== "",
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    })),
  });
});

/**
 * GET /warehouse/import/inbox/count — licznik do nagłówka zakładki.
 * MUSI stać przed `/import/inbox/:id` (Hono dopasowuje po kolejności
 * rejestracji, więc „count” wpadłoby w parametr `:id` i dało 400).
 */
app.get("/import/inbox/count", (c) => {
  return c.json({ success: true, data: { queued: queuedCountFor(getUser(c).id) } });
});

function inboxId(c: Context): number | null {
  const id = parseInt(c.req.param("id") ?? "", 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /warehouse/import/inbox/:id — pełna propozycja do formularza towaru.
 *
 * Odpowiedź to DOKŁADNIE kształt `POST /warehouse/import/parse` (parsed,
 * suggestedItem, suggestedSource, matches, photoData, photoWarning) plus
 * `inboxId` i `matchItemId`. To jest sedno: formularz towaru wypełnia się tym
 * samym kodem niezależnie od tego, czy dane przyszły z pliku, czy z wtyczki.
 * Zdjęcie siedzi w kolumnach (nie w `parsed_json`), więc sklejamy je tutaj.
 *
 * Odczyt PRZESTAWIA status na `opened` — panel ma pokazywać, co jest w robocie,
 * a wtyczka nie ma jak tego zgłosić (kartę otwiera aplikacja).
 */
app.get("/import/inbox/:id", (c) => {
  const user = getUser(c);
  const id = inboxId(c);
  if (id === null) return jsonError(c, 400, "Nieprawidłowy identyfikator");

  const row = db
    .select()
    .from(schema.warehouseImportInbox)
    .where(and(eq(schema.warehouseImportInbox.id, id), liveRow(user)))
    .get();
  // Cudzy (albo wygasły) wiersz to 404, nie 403: właścicielowi tokenu nie
  // mówimy nawet tego, że taki wiersz istnieje.
  if (!row) return jsonError(c, 404, "Nie znaleziono propozycji importu");

  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(row.parsedJson) as Record<string, unknown>;
  } catch {
    return jsonError(c, 500, "Zapisana propozycja importu jest uszkodzona");
  }

  if (row.status === "queued") {
    db.update(schema.warehouseImportInbox)
      .set({ status: "opened", openedAt: sql`(datetime('now'))` })
      .where(eq(schema.warehouseImportInbox.id, row.id))
      .run();
  }

  return c.json({
    success: true,
    data: {
      ...stored,
      photoData: row.photoData,
      photoWarning: row.photoWarning,
      inboxId: row.id,
      matchItemId: row.matchItemId,
    },
  });
});

/** Zmiana statusu wiersza kolejki (odrzucenie / zamknięcie po zapisie towaru). */
function setStatus(c: Context, status: "discarded" | "done") {
  const user = getUser(c);
  const id = inboxId(c);
  if (id === null) return jsonError(c, 400, "Nieprawidłowy identyfikator");
  const row = db
    .update(schema.warehouseImportInbox)
    .set({ status })
    .where(and(eq(schema.warehouseImportInbox.id, id), liveRow(user)))
    .returning({ id: schema.warehouseImportInbox.id, status: schema.warehouseImportInbox.status })
    .get();
  if (!row) return jsonError(c, 404, "Nie znaleziono propozycji importu");
  return c.json({ success: true, data: row });
}

/** „Nie chcę tego” — wiersz zostaje w tabeli, żeby nie wrócił przy kolejnym kliku. */
app.post("/import/inbox/:id/discard", (c) => setStatus(c, "discarded"));

/** Towar zapisany z tej propozycji — panel woła to PO udanym zapisie kartoteki. */
app.post("/import/inbox/:id/done", (c) => setStatus(c, "done"));

// ============================================================
// TOKEN WTYCZKI
// ============================================================

/**
 * Zamaskowany token („abcd…wxyz”). Panel musi pokazać, że token ISTNIEJE
 * i który to (po rotacji zmienia się końcówka), ale pełnego sekretu nie
 * wolno mu wydać — jedyne miejsce, gdzie token wychodzi w całości, to
 * `config.js` w strumieniu ZIP.
 */
function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 10) return "…";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Adres aplikacji WPISYWANY do paczki (`config.js`). Jedno wyrażenie dla
 * obu miejsc, w których jest potrzebny: generowania ZIP-a i panelu, który
 * pokazuje „paczka dla tego adresu”. Rozjazd tych dwóch byłby najgorszym
 * możliwym błędem tego ekranu — użytkownik z osobnym devem i produkcją
 * wczytałby wtyczkę wskazującą na drugie środowisko i nie miałby jak tego
 * zauważyć.
 *
 * `resolveBaseUrl(c)` czyta konfigurację firmy i nagłówki proxy; origin
 * z żądania jest fallbackiem na instalację bez ustawionego adresu.
 */
function pluginBaseUrl(c: Context): string {
  return (resolveBaseUrl(c) || new URL(c.req.url).origin).replace(/\/+$/, "");
}

/**
 * `baseUrl` jedzie razem ze stanem tokenu (a nie osobną trasą), bo panel
 * potrzebuje obu naraz i w tej samej chwili: „ten token, dla tego adresu”.
 */
function tokenInfo(c: Context, user: User) {
  const row = db
    .select({
      token: schema.users.pluginToken,
      createdAt: schema.users.pluginTokenCreatedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .get();
  return {
    hasToken: !!row?.token,
    masked: maskToken(row?.token ?? null),
    createdAt: row?.createdAt ?? null,
    baseUrl: pluginBaseUrl(c),
  };
}

/** Nowy sekret wtyczki: 32 bajty losowe (64 znaki hex), jak token sesji. */
function issueToken(userId: number): string {
  const token = randomBytes(32).toString("hex");
  db.update(schema.users)
    .set({ pluginToken: token, pluginTokenCreatedAt: sql`(datetime('now'))` })
    .where(eq(schema.users.id, userId))
    .run();
  return token;
}

app.get("/plugin/token", (c) => c.json({ success: true, data: tokenInfo(c, getUser(c)) }));

/**
 * Rotacja tokenu — po niej WSZYSTKIE wcześniej pobrane paczki przestają
 * działać (jedna kolumna, jeden ważny token). Panel ostrzega o tym przed
 * kliknięciem; tutaj tylko wykonujemy.
 */
app.post("/plugin/token/rotate", (c) => {
  const user = getUser(c);
  issueToken(user.id);
  return c.json({
    success: true,
    data: tokenInfo(c, user),
    message: "Wygenerowano nowy token wtyczki",
  });
});

/** Unieważnienie bez wydawania nowego (paczka wyciekła, wtyczka niepotrzebna). */
app.delete("/plugin/token", (c) => {
  const user = getUser(c);
  db.update(schema.users)
    .set({ pluginToken: null, pluginTokenCreatedAt: null })
    .where(eq(schema.users.id, user.id))
    .run();
  return c.json({
    success: true,
    data: tokenInfo(c, user),
    message: "Token wtyczki unieważniony",
  });
});

// ============================================================
// PACZKA WTYCZKI (ZIP)
// ============================================================

/**
 * GET /warehouse/plugin/shops — co wtyczka obsługuje.
 *
 * `calibrated` mówi prawdę o jakości parsera: „dedykowany i sprawdzony” vs
 * „szkielet do kalibracji”. Bez tego użytkownik zakładałby, że brak kodu
 * dostawcy na stronie Eltroksa to błąd wtyczki, a nie niedokończony parser.
 */
app.get("/plugin/shops", (c) => {
  return c.json({
    success: true,
    data: knownShops().map((s) => ({ ...s, calibrated: isCalibrated(s.parser) })),
  });
});

/** Nazwa pliku generowanego przez serwer (nie ma go w repozytorium). */
const CONFIG_FILE = "config.js";

/**
 * Wersja do `manifest.json`. Chrome przyjmuje 1-4 liczby rozdzielone kropkami
 * i NIE przyjmuje sufiksów typu `-rc1`, więc z „1.2.3-rc1” robimy „1.2.3”,
 * a z niepełnej („1.2”) — „1.2.0”. Zły format = wtyczka, której nie da się
 * wczytać, z komunikatem, którego nikt nie powiąże z package.json.
 */
export function manifestVersion(raw: string): string {
  const parts = (raw.split("-")[0] || "").split(".").map((p) => parseInt(p, 10));
  const nums = [0, 1, 2].map((i) => (Number.isInteger(parts[i]) && parts[i] >= 0 ? parts[i] : 0));
  return nums.join(".");
}

/**
 * Wzorzec `matches` dla adresu aplikacji. Chrome NIE przyjmuje portu we
 * wzorcach dopasowania — `http://localhost:4001/*` jest odrzucane przy
 * wczytaniu wtyczki. Dlatego wpisujemy `${protocol}//${hostname}/*`, co
 * dopasowuje wszystkie porty tego hosta (i o tym jest komentarz w planie:
 * to świadomie szerszy wzorzec, nie przeoczenie).
 */
export function matchPatternFor(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

const MANIFEST_PLACEHOLDER = "__ALFA_MATCH__";

/**
 * GET /warehouse/plugin/download — paczka z WPISANYM adresem i tokenem.
 *
 * Dlaczego ZIP z serwera, a nie paczka w repozytorium: wtyczka musi znać adres
 * tej instalacji i token TEGO użytkownika. Gdyby paczka była statyczna,
 * użytkownik musiałby wklejać jedno i drugie w opcjach — a to jest właśnie ten
 * moment, w którym ludzie się mylą i zgłaszają „wtyczka nie działa”.
 *
 * Token powstaje przy PIERWSZYM pobraniu (leniwie): konta, które nigdy nie
 * pobrały paczki, nie mają czego wykradać.
 */
app.get("/plugin/download", (c) => {
  const user = getUser(c);
  const dir = extensionDir();

  const missing = PACKAGE_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    return jsonError(
      c,
      500,
      `Paczka wtyczki jest niekompletna na serwerze (brak: ${missing.join(", ")}) — skontaktuj się z administratorem.`
    );
  }

  // Ten sam helper co w `tokenInfo` — panel pokazuje DOKŁADNIE ten adres,
  // który wyląduje w `config.js`.
  const base = pluginBaseUrl(c);
  const version = manifestVersion(appVersion());

  // Manifest: podstawienie wzorca hosta aplikacji + wersja z package.json.
  // Wersję ustawiamy po parsowaniu JSON-a, żeby nie zależeć od tego, czy
  // w pliku źródłowym stoi placeholder, i żeby zły JSON dał czytelny błąd
  // TERAZ, a nie „nie można wczytać wtyczki” u użytkownika.
  const manifestRaw = readFileSync(join(dir, "manifest.json"), "utf8").replaceAll(
    MANIFEST_PLACEHOLDER,
    matchPatternFor(base)
  );
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch {
    return jsonError(c, 500, "manifest.json wtyczki jest uszkodzony — skontaktuj się z administratorem.");
  }
  manifest.version = version;

  const token =
    db
      .select({ token: schema.users.pluginToken })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .get()?.token ?? issueToken(user.id);

  // config.js: jedyne miejsce, gdzie pełny token opuszcza serwer. Plik jest
  // wczytywany i przez service workera (`importScripts`), i przez content
  // scripty, więc `self` — nie `window`.
  const configJs = [
    "// Plik GENEROWANY przez serwer Alfa przy pobraniu paczki — nie edytuj go ręcznie.",
    "// Zawiera token TWOJEGO konta: nie wysyłaj tej paczki nikomu innemu.",
    "self.ALFA_CONFIG = {",
    `  baseUrl: ${JSON.stringify(base)},`,
    `  apiBase: ${JSON.stringify(`${base}/api`)},`,
    `  token: ${JSON.stringify(token)},`,
    `  version: ${JSON.stringify(version)},`,
    // Skrót plików paczki — wtyczka porównuje go z `pluginBuild` z API
    // i mówi użytkownikowi, że ma starą paczkę.
    `  build: ${JSON.stringify(pluginBuild())},`,
    `  user: ${JSON.stringify(user.email)},`,
    "};",
    "",
  ].join("\n");

  const zip = new PizZip();
  // Wszystko wkładamy jako Buffer (nie string): pizzip traktuje stringi jak
  // „binary string”, więc polskie znaki w options.html wyszłyby przekręcone.
  zip.file("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  zip.file(CONFIG_FILE, Buffer.from(configJs, "utf8"));
  for (const name of PACKAGE_FILES) {
    if (name === "manifest.json") continue;
    zip.file(name, readFileSync(join(dir, name)));
  }

  const body = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(body.length),
      // Paczka niesie token — nie wolno jej trzymać w cache przeglądarki
      // ani proxy.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": contentDisposition("attachment", "alfa-magazyn-wtyczka.zip"),
    },
  });
});

export default app;
