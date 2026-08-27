/**
 * Test kolumny „Protokół” w module Realizacje na prawdziwej bazie (data/alfa.db),
 * przez trasy Hono (app.request) z podstawionym userem w kontekście:
 *   npx tsx scripts/test-realization-protocol.ts
 *
 * Zakres:
 *   - POST /realizations/:id/protocol → 201 dla realizacji bez protokołu,
 *   - 409 „Realizacja ma już protokół” (z protokołem w data) przy powtórzeniu,
 *   - 404 dla nieistniejącej realizacji,
 *   - numeracja P/RRRR/MM/NNN rośnie w obrębie miesiąca (i jest zerowana per miesiąc),
 *   - pole `protocol` w GET /realizations (id/number/status/signedAt) oraz w POST/PUT,
 *   - filtr ?protocol=with|without (+ 400 dla nieznanej wartości) i jego złożenie z ?source=.
 *
 * Dane testowe: realizacje z obiektem o prefiksie ZZ-REALPROTO, daty w 2029-05 / 2029-06
 * (poza danymi produkcyjnymi — realne realizacje 1–26 i protokoły 1–25 nie są dotykane).
 * Sprząta po sobie HARD (protokoły + realizacje testowe), także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { eq, inArray, like } from "drizzle-orm";
import realizations from "../src/routes/realizations.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-REALPROTO";
const MONTH_A = { year: 2029, month: 5 };
const MONTH_B = { year: 2029, month: 6 };

const user = db.select().from(schema.users).limit(1).get() as User | undefined;
if (!user) {
  console.error("Brak użytkownika w bazie — przerywam.");
  process.exit(1);
}

// --- Klient HTTP (podstawia kontekst tak, jak robi requireAuth) ---
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("user", user);
  return next();
});
app.route("/realizations", realizations);

interface Json {
  status: number;
  success?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

async function call(method: string, path: string, body?: unknown): Promise<Json> {
  const res = await app.request(`/realizations${path === "/" ? "" : path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Omit<Json, "status"> | null;
  return { status: res.status, ...(json ?? {}) };
}

// --- Sprzątanie (protokoły lecą kaskadą, ale kasujemy jawnie dla pewności) ---
function cleanup(): { protocols: number; realizations: number } {
  const ids = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(like(schema.realizations.site, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return { protocols: 0, realizations: 0 };
  const p = db.delete(schema.protocols).where(inArray(schema.protocols.realizationId, ids)).run();
  const r = db.delete(schema.realizations).where(inArray(schema.realizations.id, ids)).run();
  return { protocols: p.changes, realizations: r.changes };
}
cleanup();

interface ProtocolBrief {
  id: number;
  number: string;
  status: "draft" | "final";
  signedAt: string | null;
}
interface RealizationJson {
  id: number;
  date: string;
  site: string;
  total: number;
  calendarEventId: number | null;
  protocol: ProtocolBrief | null;
}

const input = (date: string, site: string) => ({
  date,
  site: `${PREFIX} ${site}`,
  kind: "service",
  amountHours: 100,
  amountMaterial: 0,
  amountKm: 0,
  discount: 0,
  note: "test",
  invoiced: false,
  actualHours: 2,
  actualKm: 10,
  hourlyCost: 50,
});

/** Realizacja BEZ protokołu — insert prosto do bazy (jak stary/zaimportowany wpis). */
function insertBare(date: string, site: string): number {
  const row = db
    .insert(schema.realizations)
    .values({
      date,
      site: `${PREFIX} ${site}`,
      kind: "service",
      amountHours: 100,
      amountMaterial: 0,
      amountKm: 0,
      discount: 0,
      note: "test",
      invoiced: false,
      caretaker: "",
      contractor1: "Jan Testowy",
      contractor2: "",
      actualHours: 2,
      actualKm: 10,
      hourlyCost: 50,
    })
    .returning()
    .get();
  return row.id;
}

const listOf = async (m: { year: number; month: number }, query = "") =>
  (await call("GET", `?year=${m.year}&month=${m.month}${query}`)).data as RealizationJson[];

async function main() {
  // -------------------------------------------------------------------------
  // 1. POST /realizations — realizacja dostaje protokół od razu
  // -------------------------------------------------------------------------
  const created = await call("POST", "/", input("2029-05-10", "Alfa"));
  ok("POST /realizations → 201", created.status === 201, created);
  const alfa = created.data as RealizationJson;
  ok("POST zwraca pole protocol", alfa?.protocol != null, alfa?.protocol);
  ok(
    "protokół z POST: numer P/2029/05/NNN, status draft, signedAt null",
    /^P\/2029\/05\/\d{3}$/.test(alfa?.protocol?.number ?? "") &&
      alfa.protocol?.status === "draft" &&
      alfa.protocol?.signedAt === null,
    alfa?.protocol
  );

  // -------------------------------------------------------------------------
  // 2. Realizacje bez protokołu (starsze wpisy) + POST /:id/protocol
  // -------------------------------------------------------------------------
  const bare1 = insertBare("2029-05-11", "Beta");
  const bare2 = insertBare("2029-05-12", "Gamma");
  const bareOther = insertBare("2029-06-01", "Delta"); // inny miesiąc

  const listBefore = await listOf(MONTH_A);
  ok(
    "GET /realizations: protocol=null dla wpisów bez protokołu",
    listBefore.filter((r) => r.protocol === null).length === 2,
    listBefore.map((r) => [r.id, r.protocol?.number ?? null])
  );
  ok(
    "GET /realizations: protocol wypełniony dla wpisu z protokołem",
    listBefore.find((r) => r.id === alfa.id)?.protocol?.number === alfa.protocol?.number,
    listBefore.find((r) => r.id === alfa.id)?.protocol
  );

  const p1 = await call("POST", `/${bare1}/protocol`);
  ok("POST /:id/protocol → 201", p1.status === 201 && p1.success === true, p1);
  const brief1 = (p1.data as { protocol: ProtocolBrief })?.protocol;
  ok(
    "zwrócony protokół: {id, number, status, signedAt}",
    typeof brief1?.id === "number" &&
      /^P\/2029\/05\/\d{3}$/.test(brief1?.number ?? "") &&
      brief1?.status === "draft" &&
      brief1?.signedAt === null,
    brief1
  );

  const p2 = await call("POST", `/${bare2}/protocol`);
  const brief2 = (p2.data as { protocol: ProtocolBrief })?.protocol;
  ok("drugi POST /:id/protocol → 201", p2.status === 201, p2);

  const seq = (n: string) => parseInt(n.slice(-3));
  ok(
    `numeracja rośnie w miesiącu: ${alfa.protocol?.number} < ${brief1?.number} < ${brief2?.number}`,
    seq(alfa.protocol!.number) < seq(brief1.number) && seq(brief1.number) < seq(brief2.number),
    [alfa.protocol?.number, brief1?.number, brief2?.number]
  );

  const pOther = await call("POST", `/${bareOther}/protocol`);
  const briefOther = (pOther.data as { protocol: ProtocolBrief })?.protocol;
  ok(
    "numeracja per miesiąc: inny miesiąc → prefiks P/2029/06/",
    briefOther?.number?.startsWith("P/2029/06/") === true,
    briefOther?.number
  );

  // Kopia protokołu w bazie zgadza się z odpowiedzią
  const stored = db.select().from(schema.protocols).where(eq(schema.protocols.id, brief1.id)).get();
  ok(
    "protokół zapisany w bazie: realizationId + prefill z realizacji",
    stored?.realizationId === bare1 &&
      stored?.workDate === "2029-05-11" &&
      stored?.workType === "serwis" &&
      stored?.installationAddress === `${PREFIX} Beta` &&
      stored?.contractor === "Jan Testowy" &&
      stored?.status === "draft",
    stored && { realizationId: stored.realizationId, workDate: stored.workDate, addr: stored.installationAddress }
  );

  // -------------------------------------------------------------------------
  // 3. Konflikty i błędy
  // -------------------------------------------------------------------------
  const again = await call("POST", `/${bare1}/protocol`);
  ok("powtórny POST /:id/protocol → 409", again.status === 409 && again.success === false, again);
  ok("409: komunikat „Realizacja ma już protokół”", again.error === "Realizacja ma już protokół", again.error);
  ok(
    "409: data zawiera istniejący protokół",
    (again.data as { protocol: ProtocolBrief })?.protocol?.id === brief1.id,
    again.data
  );

  const onCreated = await call("POST", `/${alfa.id}/protocol`);
  ok("409 także dla realizacji z protokołem z POST /realizations", onCreated.status === 409, onCreated);

  const missingId = (db.select({ id: schema.realizations.id }).from(schema.realizations).all().reduce((m, r) => Math.max(m, r.id), 0)) + 5000;
  const notFound = await call("POST", `/${missingId}/protocol`);
  ok("POST /:id/protocol dla nieistniejącej realizacji → 404", notFound.status === 404, notFound);
  ok("404: komunikat „Nie znaleziono realizacji”", notFound.error === "Nie znaleziono realizacji", notFound.error);
  ok(
    "404 nie tworzy protokołu-sieroty",
    db.select().from(schema.protocols).where(eq(schema.protocols.realizationId, missingId)).all().length === 0
  );

  const badId = await call("POST", "/abc/protocol");
  ok("POST /abc/protocol → 400", badId.status === 400, badId);

  // -------------------------------------------------------------------------
  // 4. Filtr ?protocol=with|without
  // -------------------------------------------------------------------------
  const bare3 = insertBare("2029-05-20", "Epsilon"); // celowo bez protokołu

  const all = await listOf(MONTH_A);
  const withP = await listOf(MONTH_A, "&protocol=with");
  const withoutP = await listOf(MONTH_A, "&protocol=without");
  ok("lista bez filtra: 4 realizacje testowe", all.length === 4, all.map((r) => r.site));
  ok(
    "?protocol=with → tylko z protokołem (3)",
    withP.length === 3 && withP.every((r) => r.protocol != null),
    withP.map((r) => [r.id, r.protocol?.number ?? null])
  );
  ok(
    "?protocol=without → tylko bez protokołu (1: Epsilon)",
    withoutP.length === 1 && withoutP[0].id === bare3 && withoutP[0].protocol === null,
    withoutP.map((r) => [r.id, r.site, r.protocol])
  );
  ok("with + without = wszystkie", withP.length + withoutP.length === all.length);

  const badFilter = await call("GET", `?year=${MONTH_A.year}&month=${MONTH_A.month}&protocol=maybe`);
  ok("?protocol=maybe → 400", badFilter.status === 400, badFilter);
  ok(
    "400: komunikat o dozwolonych wartościach",
    badFilter.error === "Parametr protocol: dozwolone with, without",
    badFilter.error
  );

  // Złożenie z istniejącym ?source= (wszystkie testowe są ręczne — bez kalendarza)
  const manualWithout = await listOf(MONTH_A, "&source=manual&protocol=without");
  ok("?source=manual&protocol=without → 1", manualWithout.length === 1 && manualWithout[0].id === bare3, manualWithout.map((r) => r.id));
  const calendarWith = await listOf(MONTH_A, "&source=calendar&protocol=with");
  ok("?source=calendar&protocol=with → 0 (brak wydarzeń)", calendarWith.length === 0, calendarWith.map((r) => r.id));

  // -------------------------------------------------------------------------
  // 5. PUT /realizations/:id zwraca protocol
  // -------------------------------------------------------------------------
  const beforePut = (await listOf(MONTH_A)).find((r) => r.id === bare1)!;
  const rowNow = db.select().from(schema.realizations).where(eq(schema.realizations.id, bare1)).get()!;
  const put = await call("PUT", `/${bare1}`, {
    ...input("2029-05-11", "Beta"),
    amountHours: 250,
    expectedUpdatedAt: rowNow.updatedAt,
  });
  ok("PUT /realizations/:id → 200", put.status === 200, put);
  const afterPut = put.data as RealizationJson;
  ok(
    "PUT zwraca ten sam protokół co lista",
    afterPut?.protocol?.id === beforePut.protocol?.id && afterPut?.protocol?.number === brief1.number,
    afterPut?.protocol
  );
  ok("PUT zachowuje pola liczone (total)", afterPut?.total === 250, afterPut?.total);

  // -------------------------------------------------------------------------
  // 6. Status „final” po podpisie widoczny w liście
  // -------------------------------------------------------------------------
  const signedAt = new Date().toISOString();
  db.update(schema.protocols)
    .set({ status: "final", signedAt, signerName: "Test", signaturePng: "data:image/png;base64,AA" })
    .where(eq(schema.protocols.id, brief1.id))
    .run();
  const afterSign = (await listOf(MONTH_A)).find((r) => r.id === bare1);
  ok(
    "podpisany protokół → status final + signedAt w liście",
    afterSign?.protocol?.status === "final" && afterSign?.protocol?.signedAt === signedAt,
    afterSign?.protocol
  );

  // -------------------------------------------------------------------------
  // 7. Realizacje produkcyjne nietknięte
  // -------------------------------------------------------------------------
  const prod = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(eq(schema.realizations.id, 1))
    .get();
  ok("realizacja #1 (produkcyjna) nadal istnieje", prod?.id === 1, prod);
}

main()
  .catch((e) => {
    failures++;
    console.error("FAIL (wyjątek):", e);
  })
  .finally(() => {
    const removed = cleanup();
    console.log(`\nSprzątanie: usunięto ${removed.realizations} realizacji i ${removed.protocols} protokołów testowych.`);
    console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} testów nie przeszło`);
    process.exit(failures === 0 ? 0 : 1);
  });
