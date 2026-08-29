/**
 * Test tras wyszukiwarki firm:
 *   npx tsx scripts/test-company-lookup-route.ts
 *
 * Trasa dla zalogowanych (GET /company-lookup/nip/:nip): walidacja NIP (400),
 * poprawne trafienie (200), brak podmiotu w wykazie (200 + found:false), awaria
 * rejestru (502 zamiast 500), limit 100/h per użytkownik (429), ?refresh=1.
 *
 * Trasa publiczna dla formularza ZDW (GET /public/company-lookup/nip/:nip):
 * limit 5 zapytań na 5 minut per IP, liczony po X-Forwarded-For, błędny NIP nie
 * zjada puli, odpowiedź nie wystawia anonimowo rachunków bankowych ani REGON/KRS.
 *
 * Wołania do MF są mockowane — test nie rusza sieci ani bazy (użytkownik jest
 * wstrzykiwany do kontekstu, bez sesji).
 */
import { Hono } from "hono";
import companyLookup from "../src/routes/company-lookup.js";
import publicRoutes from "../src/routes/public.js";
import { setMfFetch, clearMfCache } from "../src/lib/mf-whitelist.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const NIP = "1234563218";
const NIP_2 = "5260250274";

/** Aplikacja testowa: zalogowany użytkownik zamiast prawdziwej sesji. */
function appFor(userId: number) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId, username: "test", role: "admin" });
    return next();
  });
  app.route("/company-lookup", companyLookup);
  return app;
}

const subject = {
  name: "PRZYKŁADOWA SP. Z O.O.",
  nip: NIP,
  statusVat: "Czynny",
  regon: "123456789",
  krs: "",
  workingAddress: "UL. TESTOWA 1, 00-001 WARSZAWA",
  accountNumbers: [],
};

function mfOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- 400: zły NIP nie wychodzi w sieć ---
{
  clearMfCache();
  let calls = 0;
  setMfFetch(async () => {
    calls++;
    return mfOk({ result: { subject } });
  });
  const res = await appFor(1).request("/company-lookup/nip/1234567890");
  const body = await res.json();
  ok("zły NIP → 400 bez zapytania do MF", res.status === 400 && calls === 0 && body.success === false, { status: res.status, body });
}

// --- 200: dane firmy + źródło ---
{
  clearMfCache();
  let calls = 0;
  setMfFetch(async () => {
    calls++;
    return mfOk({ result: { subject } });
  });
  const res = await appFor(2).request(`/company-lookup/nip/${NIP}`);
  const body = await res.json();
  ok(
    "poprawny NIP → 200 z danymi firmy",
    res.status === 200 && body.data?.found === true && body.data?.company?.city === "Warszawa" && body.data?.source === "mf-wl",
    { status: res.status, body }
  );

  // NIP z myślnikami trafia w ten sam wpis cache'u — bez drugiego zapytania do MF.
  const res2 = await appFor(2).request("/company-lookup/nip/123-456-32-18");
  const body2 = await res2.json();
  ok("NIP z myślnikami → cache", res2.status === 200 && calls === 1 && body2.data?.cached === true, { calls, body2 });

  const res3 = await appFor(2).request(`/company-lookup/nip/${NIP}?refresh=1`);
  ok("refresh=1 → ponowne zapytanie do MF", res3.status === 200 && calls === 2, { calls });
}

// --- 200 + found:false: firmy nie ma w wykazie ---
{
  clearMfCache();
  setMfFetch(async () => mfOk({ result: { subject: null } }));
  const res = await appFor(3).request(`/company-lookup/nip/${NIP_2}`);
  const body = await res.json();
  ok(
    "brak w wykazie → 200, found:false",
    res.status === 200 && body.success === true && body.data?.found === false,
    { status: res.status, body }
  );
}

// --- 502: awaria rejestru nie jest błędem naszej aplikacji ---
{
  clearMfCache();
  setMfFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  const res = await appFor(4).request(`/company-lookup/nip/${NIP_2}`);
  const body = await res.json();
  ok("awaria MF → 502 z komunikatem", res.status === 502 && body.success === false && typeof body.error === "string", {
    status: res.status,
    body,
  });
}

// --- 429: limit zapytań per użytkownik ---
{
  clearMfCache();
  setMfFetch(async () => mfOk({ result: { subject } }));
  const app = appFor(99);
  let last = 200;
  // 100 zapytań mieści się w limicie, 101. już nie (cache po stronie NIP-u
  // nie chroni limitu — liczymy każde wejście na trasę).
  for (let i = 0; i < 101; i++) {
    const res = await app.request(`/company-lookup/nip/${NIP}`);
    last = res.status;
  }
  ok("101. zapytanie w godzinie → 429", last === 429, last);

  // Limit jest per użytkownik — inny użytkownik dalej może szukać.
  const other = await appFor(100).request(`/company-lookup/nip/${NIP}`);
  ok("limit nie dotyka innego użytkownika", other.status === 200, other.status);
}

// ---------------------------------------------------------------------------
// Trasa publiczna (formularz ZDW) — limit 5 zapytań / 5 minut na adres IP
// ---------------------------------------------------------------------------

/** Zapytanie na trasę publiczną z podanym adresem w X-Forwarded-For. */
function publicGet(nip: string, ip: string) {
  const app = new Hono();
  app.route("/public", publicRoutes);
  return app.request(`/public/company-lookup/nip/${nip}`, {
    headers: { "x-forwarded-for": ip },
  });
}

{
  clearMfCache();
  setMfFetch(async () => mfOk({ result: { subject } }));

  // Błędny NIP odbijamy przed limitem — literówka nie może zjadać puli.
  for (let i = 0; i < 3; i++) {
    const bad = await publicGet("1234567890", "10.0.0.1");
    ok(`publiczna: zły NIP → 400 (próba ${i + 1})`, bad.status === 400, bad.status);
  }

  const first = await publicGet(NIP, "10.0.0.1");
  const firstBody = await first.json();
  ok(
    "publiczna: poprawny NIP → 200 z danymi firmy",
    first.status === 200 && firstBody.data?.found === true && firstBody.data?.company?.name === subject.name,
    { status: first.status, body: firstBody }
  );
  ok(
    "publiczna: bez rachunków i danych rejestrowych",
    firstBody.data?.company?.accountNumbers === undefined &&
      firstBody.data?.company?.regon === undefined &&
      firstBody.data?.company?.krs === undefined,
    firstBody.data?.company
  );

  // Pierwsze zapytanie już poszło — zostały cztery.
  for (let i = 2; i <= 5; i++) {
    const res = await publicGet(NIP, "10.0.0.1");
    ok(`publiczna: zapytanie ${i}/5 mieści się w limicie`, res.status === 200, res.status);
  }

  const sixth = await publicGet(NIP, "10.0.0.1");
  const sixthBody = await sixth.json();
  ok(
    "publiczna: 6. zapytanie w oknie → 429",
    sixth.status === 429 && sixthBody.success === false,
    { status: sixth.status, body: sixthBody }
  );

  const otherIp = await publicGet(NIP, "10.0.0.2");
  ok("publiczna: limit jest per adres IP", otherIp.status === 200, otherIp.status);

  // Awaria rejestru → 502, tak samo jak na trasie dla zalogowanych.
  setMfFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  clearMfCache();
  const broken = await publicGet(NIP_2, "10.0.0.3");
  ok("publiczna: awaria MF → 502", broken.status === 502, broken.status);
}

console.log(failures === 0 ? "\nWszystkie testy przeszły." : `\n${failures} test(ów) nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
