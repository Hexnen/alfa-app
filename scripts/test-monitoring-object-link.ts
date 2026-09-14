/**
 * Test podpinania projektów CCTV pod obiekty (migracja 0100 +
 * `/api/monitoring`) — przez trasy Hono (app.request) z podstawionym userem
 * i strażnikiem uprawnień, na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-monitoring-object-link.ts
 *
 * Sprawdza: zakładanie projektu od razu podpiętego pod obiekt, walidację
 * `objectId` (śmieć / nieistniejący obiekt → 400), obiekt w JOIN-ie na liście,
 * w detalu i w `/by-object/:objectId`, rozróżnienie „brak klucza = bez zmian”
 * od „null = odepnij” w PUT, przepięcie pod inny obiekt, wyszukiwarkę obiektów
 * `/pick/objects` (działa na kluczu `technical/projekty`, bez dostępu do
 * kartoteki), uprawnienia (obcy → 403, czytelnik bez zapisu) oraz ON DELETE SET
 * NULL: skasowany obiekt odpina projekt, ale go nie kasuje.
 *
 * Sprząta po sobie HARD (projekty + obiekty + kontrahent), także przy błędzie.
 */
import { Hono } from "hono";
import { eq, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import monitoringRoutes from "../src/routes/monitoring.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__MONPROJ_TEST__";
const BASE = "/monitoring";

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const plain = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !plain) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");

function withPerms(user: User, permissions: Record<string, "view" | "edit">): User {
  return { ...user, role: "user", permissions: JSON.stringify(permissions) };
}

// ---------------------------------------------------------------------------
// Sprzątanie
// ---------------------------------------------------------------------------

function cleanup(): number {
  const projects = db
    .delete(schema.monitoringProjects)
    .where(like(schema.monitoringProjects.name, `${PREFIX}%`))
    .returning({ id: schema.monitoringProjects.id })
    .all();
  db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  return projects.length;
}

cleanup();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function appFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // Hono bez generyka `Variables` typuje klucz jako `never` — w produkcji
    // ustawia go requireAuth, tutaj podstawiamy usera wprost.
    c.set("user" as never, user as never);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route(BASE, monitoringRoutes);
  return app;
}

const asAdmin = appFor(admin);
const asEditor = appFor(withPerms(plain, { "technical/projekty": "edit" }));
const asViewer = appFor(withPerms(plain, { "technical/projekty": "view" }));
const asStranger = appFor(withPerms(plain, { objects: "edit" }));

type Resp<T> = { success: boolean; data?: T; error?: string };

/** Router jest zamontowany pod BASE, a Hono chodzi w trybie strict (bez ukośnika na końcu). */
function url(path: string): string {
  if (path === "/") return BASE;
  if (path.startsWith("/?")) return BASE + path.slice(1);
  return BASE + path;
}

async function asJson<T>(res: Response): Promise<Resp<T>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Resp<T>;
  } catch {
    return { success: false, error: text };
  }
}

async function get<T>(app: Hono, path: string) {
  const res = await app.request(url(path));
  return { status: res.status, json: await asJson<T>(res) };
}

async function send<T>(app: Hono, method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const res = await app.request(url(path), {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return { status: res.status, json: await asJson<T>(res) };
}

type ProjectObject = { id: number; name: string; address: string | null; city: string | null };
type ProjectJson = {
  id: number;
  name: string;
  address: string;
  notes: string;
  objectId: number | null;
  object: ProjectObject | null;
  cameras: number;
  pinAddress: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Fikstury
// ---------------------------------------------------------------------------

try {
  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX} Kontrahent`, nip: `${Date.now()}`.slice(-10) })
    .returning()
    .get();

  const objA = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Aluzyjna 25`,
      address: "Aluzyjna 25",
      city: "Warszawa",
      type: "monitoring",
      installationType: "new",
    })
    .returning()
    .get();

  const objB = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Marsa 7`,
      address: "Marsa 7",
      city: "Radom",
      type: "monitoring",
      installationType: "new",
    })
    .returning()
    .get();

  // -------------------------------------------------------------------------
  // Zakładanie projektu z podpięciem
  // -------------------------------------------------------------------------

  const created = await send<ProjectJson>(asEditor, "POST", "/", {
    name: `${PREFIX} Projekt A`,
    address: "Aluzyjna 25, Warszawa",
    objectId: objA.id,
  });
  ok(
    "POST /monitoring z objectId → 201, projekt podpięty i z obiektem w odpowiedzi",
    created.status === 201 &&
      created.json.data?.objectId === objA.id &&
      created.json.data?.object?.name === objA.name &&
      created.json.data?.object?.city === "Warszawa",
    created.json
  );
  const projectId = created.json.data!.id;

  const loose = await send<ProjectJson>(asEditor, "POST", "/", { name: `${PREFIX} Projekt luzem` });
  ok(
    "POST bez objectId → projekt bez powiązania (null, nie błąd)",
    loose.status === 201 && loose.json.data?.objectId === null && loose.json.data?.object === null,
    loose.json
  );
  const looseId = loose.json.data!.id;

  const badId = await send<ProjectJson>(asEditor, "POST", "/", {
    name: `${PREFIX} Projekt zły`,
    objectId: "nie-liczba",
  });
  ok("POST z objectId niebędącym liczbą → 400", badId.status === 400, badId.json);

  const ghost = await send<ProjectJson>(asEditor, "POST", "/", {
    name: `${PREFIX} Projekt widmo`,
    objectId: 999_999_999,
  });
  ok(
    "POST z nieistniejącym obiektem → 400 „Obiekt nie istnieje”",
    ghost.status === 400 && ghost.json.error === "Obiekt nie istnieje",
    ghost.json
  );

  // -------------------------------------------------------------------------
  // Odczyt: lista, detal, projekty obiektu
  // -------------------------------------------------------------------------

  const list = await get<ProjectJson[]>(asViewer, "/");
  const onList = list.json.data?.find((p) => p.id === projectId);
  const looseOnList = list.json.data?.find((p) => p.id === looseId);
  ok(
    "GET /monitoring: lista niesie objectId i obiekt z JOIN-a",
    list.status === 200 && onList?.object?.id === objA.id && looseOnList?.object === null,
    { onList, looseOnList }
  );

  const detail = await get<ProjectJson & { data: string }>(asViewer, `/${projectId}`);
  ok(
    "GET /monitoring/:id: detal (dla designera) też zwraca obiekt",
    detail.status === 200 && detail.json.data?.object?.id === objA.id,
    detail.json.data?.object
  );

  const byObject = await get<{ items: ProjectJson[] }>(asViewer, `/by-object/${objA.id}`);
  ok(
    "GET /by-object/:objectId → tylko projekty tego obiektu",
    byObject.status === 200 &&
      byObject.json.data?.items.length === 1 &&
      byObject.json.data.items[0].id === projectId,
    byObject.json.data?.items.map((p) => p.id)
  );

  const byOther = await get<{ items: ProjectJson[] }>(asViewer, `/by-object/${objB.id}`);
  ok(
    "GET /by-object/:objectId obiektu bez projektów → pusta lista",
    byOther.status === 200 && byOther.json.data?.items.length === 0,
    byOther.json
  );

  const byBad = await get<{ items: ProjectJson[] }>(asViewer, "/by-object/0");
  ok("GET /by-object/0 → 400", byBad.status === 400, byBad.json);

  // -------------------------------------------------------------------------
  // Edycja: bez klucza = bez zmian, null = odepnij, liczba = przepnij
  // -------------------------------------------------------------------------

  const renamed = await send<ProjectJson>(asEditor, "PUT", `/${projectId}`, {
    name: `${PREFIX} Projekt A (po zmianie)`,
  });
  ok(
    "PUT bez klucza objectId NIE odpina projektu",
    renamed.status === 200 && renamed.json.data?.objectId === objA.id,
    renamed.json.data
  );

  const moved = await send<ProjectJson>(asEditor, "PUT", `/${projectId}`, { objectId: objB.id });
  ok(
    "PUT z innym objectId przepina projekt (obiekt w odpowiedzi też się zmienia)",
    moved.status === 200 && moved.json.data?.objectId === objB.id && moved.json.data?.object?.city === "Radom",
    moved.json.data?.object
  );

  const movedGhost = await send<ProjectJson>(asEditor, "PUT", `/${projectId}`, { objectId: 999_999_999 });
  ok("PUT z nieistniejącym obiektem → 400", movedGhost.status === 400, movedGhost.json);

  const detached = await send<ProjectJson>(asEditor, "PUT", `/${projectId}`, { objectId: null });
  ok(
    "PUT z objectId: null odpina projekt",
    detached.status === 200 && detached.json.data?.objectId === null && detached.json.data?.object === null,
    detached.json.data
  );

  // Z powrotem pod objA — dalsze testy (kasowanie obiektu) liczą na powiązanie.
  const reattached = await send<ProjectJson>(asEditor, "PUT", `/${projectId}`, { objectId: objA.id });
  ok("PUT przypina projekt z powrotem", reattached.json.data?.objectId === objA.id, reattached.json.data);

  // -------------------------------------------------------------------------
  // Wyszukiwarka obiektów do pickera
  // -------------------------------------------------------------------------

  const pick = await get<{ items: ProjectObject[] }>(asViewer, "/pick/objects?q=marsa");
  ok(
    "GET /pick/objects szuka po adresie i działa na kluczu technical/projekty",
    pick.status === 200 && pick.json.data?.items.some((o) => o.id === objB.id),
    pick.json.data?.items.slice(0, 3)
  );

  const pickByContractor = await get<{ items: ProjectObject[] }>(
    asViewer,
    `/pick/objects?q=${encodeURIComponent(PREFIX.toLowerCase())}`
  );
  ok(
    "GET /pick/objects: fraza z nazwy obiektu zwraca oba obiekty testowe",
    pickByContractor.json.data?.items.filter((o) => o.name.startsWith(PREFIX)).length === 2,
    pickByContractor.json.data?.items.map((o) => o.name)
  );

  // -------------------------------------------------------------------------
  // Uprawnienia
  // -------------------------------------------------------------------------

  const strangerList = await get<ProjectJson[]>(asStranger, "/");
  ok("Bez klucza technical/projekty: GET listy → 403", strangerList.status === 403, strangerList.json);

  const strangerByObject = await get<{ items: ProjectJson[] }>(asStranger, `/by-object/${objA.id}`);
  ok(
    "Bez klucza technical/projekty: GET /by-object → 403 (sekcja na karcie obiektu nic nie pokaże)",
    strangerByObject.status === 403,
    strangerByObject.json
  );

  const strangerPick = await get<{ items: ProjectObject[] }>(asStranger, "/pick/objects?q=marsa");
  ok("Bez klucza technical/projekty: GET /pick/objects → 403", strangerPick.status === 403, strangerPick.json);

  const viewerWrite = await send<ProjectJson>(asViewer, "PUT", `/${projectId}`, { objectId: objB.id });
  ok("Czytelnik (view) nie przepnie projektu → 403", viewerWrite.status === 403, viewerWrite.json);

  const adminList = await get<ProjectJson[]>(asAdmin, "/");
  ok("Admin widzi listę bez kluczy", adminList.status === 200, adminList.status);

  // -------------------------------------------------------------------------
  // ON DELETE SET NULL — projekt przeżywa skasowanie obiektu
  // -------------------------------------------------------------------------

  db.delete(schema.objects).where(eq(schema.objects.id, objA.id)).run();
  const survivor = db
    .select()
    .from(schema.monitoringProjects)
    .where(eq(schema.monitoringProjects.id, projectId))
    .get();
  ok(
    "Kasowanie obiektu odpina projekt (SET NULL), ale go NIE kasuje",
    !!survivor && survivor.objectId === null,
    survivor && { id: survivor.id, objectId: survivor.objectId }
  );
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} projektów testowych)`);
}

console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
