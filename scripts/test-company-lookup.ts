/**
 * Test wyszukiwarki firm (wykaz podatników VAT MF):
 *   npx tsx scripts/test-company-lookup.ts          # offline, na wstrzykniętym fetchu
 *   npx tsx scripts/test-company-lookup.ts --live   # dodatkowo jedno prawdziwe zapytanie do MF
 *
 * Zakres: walidacja NIP przed wyjściem w sieć, parsowanie adresu MF (jeden string →
 * ulica/kod/miasto), normalizacja statusu VAT, brak podmiotu w wykazie, 404, błąd HTTP
 * z komunikatem MF, timeout/awaria sieci (zwraca `{error}`, nie rzuca), cache (drugie
 * zapytanie bez ruchu) i `refresh` pomijający cache.
 *
 * Nie dotyka bazy — testuje wyłącznie src/lib/mf-whitelist.ts.
 */
import {
  lookupCompanyByNip,
  isMfError,
  parseMfAddress,
  titleCasePl,
  setMfFetch,
  clearMfCache,
} from "../src/lib/mf-whitelist.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

/** NIP-y z poprawną sumą kontrolną (wyliczone, nie z produkcji). */
const NIP_VALID = "1234563218";
const NIP_VALID_2 = "5260250274"; // NIP Ministerstwa Finansów — używany też w trybie --live
const NIP_BAD_SUM = "1234567890";

function mfResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SUBJECT = {
  name: "PRZYKŁADOWA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
  nip: NIP_VALID,
  statusVat: "Czynny",
  regon: "123456789",
  krs: "0000123456",
  workingAddress: "UL. TESTOWA 12 LOK. 3, 00-001 WARSZAWA",
  residenceAddress: null,
  accountNumbers: ["12106000760000320000546101"],
};

// ---------------------------------------------------------------------------
// 1. Parser adresu i wielkość liter
// ---------------------------------------------------------------------------

{
  const a = parseMfAddress("UL. TESTOWA 12 LOK. 3, 00-001 WARSZAWA");
  ok("adres: ulica", a.address === "UL. TESTOWA 12 LOK. 3", a);
  ok("adres: kod", a.postalCode === "00-001", a);
  ok("adres: miasto", a.city === "WARSZAWA", a);

  const b = parseMfAddress("ALEJA JEROZOLIMSKIE 100, 02-486 WARSZAWA-WŁOCHY");
  ok("adres: miasto z myślnikiem", b.city === "WARSZAWA-WŁOCHY", b);

  // Bez kodu pocztowego nie zgadujemy — cały tekst zostaje w polu adresu.
  const c = parseMfAddress("JAKIŚ NIETYPOWY ADRES");
  ok("adres bez kodu: nie zgaduje", c.address === "JAKIŚ NIETYPOWY ADRES" && c.city === "", c);
  const d = parseMfAddress("");
  ok("adres pusty", d.address === "" && d.postalCode === "" && d.city === "", d);

  ok("wielkość liter: ulica", titleCasePl("UL. TESTOWA 12") === "ul. Testowa 12", titleCasePl("UL. TESTOWA 12"));
  ok("wielkość liter: miasto z myślnikiem", titleCasePl("WARSZAWA-WŁOCHY") === "Warszawa-Włochy", titleCasePl("WARSZAWA-WŁOCHY"));
}

// ---------------------------------------------------------------------------
// 2. Walidacja NIP przed wyjściem w sieć
// ---------------------------------------------------------------------------

{
  clearMfCache();
  let calls = 0;
  setMfFetch(async () => {
    calls++;
    return mfResponse({ result: { subject: SUBJECT } });
  });

  const bad = await lookupCompanyByNip(NIP_BAD_SUM);
  ok("zła suma kontrolna → błąd bez ruchu sieciowego", isMfError(bad) && calls === 0, bad);

  const short = await lookupCompanyByNip("123");
  ok("za krótki NIP → błąd", isMfError(short) && calls === 0, short);
}

// ---------------------------------------------------------------------------
// 3. Poprawne trafienie + cache
// ---------------------------------------------------------------------------

{
  clearMfCache();
  let calls = 0;
  let lastUrl = "";
  setMfFetch(async (url) => {
    calls++;
    lastUrl = url;
    return mfResponse({ result: { subject: SUBJECT, requestId: "x" } });
  });

  const r1 = await lookupCompanyByNip(NIP_VALID);
  if (isMfError(r1)) {
    ok("znaleziono firmę", false, r1);
  } else {
    ok("znaleziono firmę", r1.found && r1.company !== null, r1);
    ok("nazwa firmy", r1.company?.name === SUBJECT.name, r1.company?.name);
    ok("adres rozbity", r1.company?.postalCode === "00-001" && r1.company?.city === "Warszawa", r1.company);
    ok("ulica z małych liter", r1.company?.address === "ul. Testowa 12 lok. 3", r1.company?.address);
    ok("REGON/KRS", r1.company?.regon === "123456789" && r1.company?.krs === "0000123456", r1.company);
    ok("status VAT", r1.company?.statusVat === "Czynny", r1.company?.statusVat);
    ok("rachunki", r1.company?.accountNumbers.length === 1, r1.company?.accountNumbers);
    ok("pierwsze zapytanie nie z cache", r1.cached === false, r1.cached);
  }
  ok("URL z datą", /\/1234563218\?date=\d{4}-\d{2}-\d{2}$/.test(lastUrl), lastUrl);

  const r2 = await lookupCompanyByNip(NIP_VALID);
  ok("drugie zapytanie z cache (bez ruchu)", calls === 1 && !isMfError(r2) && r2.cached === true, { calls, r2 });

  // NIP z myślnikami trafia w ten sam wpis cache'u.
  const r3 = await lookupCompanyByNip("123-456-32-18");
  ok("NIP z myślnikami = ten sam cache", calls === 1 && !isMfError(r3) && r3.cached === true, { calls });

  const r4 = await lookupCompanyByNip(NIP_VALID, { skipCache: true });
  ok("refresh pomija cache", calls === 2 && !isMfError(r4), { calls });
}

// ---------------------------------------------------------------------------
// 4. Status VAT: zwolniony / niezarejestrowany, adres zamieszkania (JDG)
// ---------------------------------------------------------------------------

{
  clearMfCache();
  setMfFetch(async () =>
    mfResponse({
      result: {
        subject: {
          name: "JAN KOWALSKI",
          nip: NIP_VALID,
          statusVat: "Zwolniony",
          regon: "",
          krs: "",
          workingAddress: null,
          residenceAddress: "UL. KWIATOWA 5, 30-001 KRAKÓW",
          accountNumbers: [],
        },
      },
    })
  );
  const r = await lookupCompanyByNip(NIP_VALID);
  ok(
    "JDG: adres zamieszkania gdy brak siedziby",
    !isMfError(r) && r.company?.city === "Kraków" && r.company?.statusVat === "Zwolniony",
    r
  );

  clearMfCache();
  setMfFetch(async () =>
    mfResponse({ result: { subject: { ...SUBJECT, statusVat: "Nieczynny" } } })
  );
  const r2 = await lookupCompanyByNip(NIP_VALID);
  ok(
    "nieznany status → Niezarejestrowany",
    !isMfError(r2) && r2.company?.statusVat === "Niezarejestrowany",
    !isMfError(r2) ? r2.company?.statusVat : r2
  );
}

// ---------------------------------------------------------------------------
// 5. Brak podmiotu, 404, błąd HTTP, awaria sieci
// ---------------------------------------------------------------------------

{
  clearMfCache();
  setMfFetch(async () => mfResponse({ result: { subject: null, requestId: "x" } }));
  const r = await lookupCompanyByNip(NIP_VALID_2);
  ok("brak podmiotu w wykazie → found:false", !isMfError(r) && r.found === false && r.company === null, r);

  clearMfCache();
  setMfFetch(async () => mfResponse({ message: "Nie znaleziono" }, 404));
  const r404 = await lookupCompanyByNip(NIP_VALID_2);
  ok("HTTP 404 → found:false (nie błąd)", !isMfError(r404) && r404.found === false, r404);

  clearMfCache();
  setMfFetch(async () => mfResponse({ message: "Limit zapytań przekroczony", code: "WL-112" }, 400));
  const rErr = await lookupCompanyByNip(NIP_VALID_2);
  ok(
    "HTTP 400 → błąd z komunikatem MF",
    isMfError(rErr) && rErr.error.includes("Limit zapytań przekroczony"),
    rErr
  );

  clearMfCache();
  setMfFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  const rNet = await lookupCompanyByNip(NIP_VALID_2);
  ok("awaria sieci → {error}, bez wyjątku", isMfError(rNet) && rNet.error.includes("ECONNREFUSED"), rNet);

  clearMfCache();
  setMfFetch(async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  });
  const rTimeout = await lookupCompanyByNip(NIP_VALID_2);
  ok("timeout → czytelny komunikat", isMfError(rTimeout) && rTimeout.error.includes("czasie"), rTimeout);

  // Błędy nie mogą trafić do cache'u — po awarii kolejna próba znowu idzie w sieć.
  let calls = 0;
  setMfFetch(async () => {
    calls++;
    return mfResponse({ result: { subject: SUBJECT } });
  });
  const rAfter = await lookupCompanyByNip(NIP_VALID_2);
  ok("błąd nie zatruwa cache'u", calls === 1 && !isMfError(rAfter), { calls, rAfter });
}

// ---------------------------------------------------------------------------
// 6. Tryb offline
// ---------------------------------------------------------------------------

{
  clearMfCache();
  setMfFetch(null);
  process.env.MF_OFFLINE = "1";
  const r = await lookupCompanyByNip(NIP_VALID);
  ok("MF_OFFLINE=1 → brak ruchu sieciowego", isMfError(r) && r.error.includes("MF_OFFLINE"), r);
  delete process.env.MF_OFFLINE;
}

// ---------------------------------------------------------------------------
// 7. Opcjonalnie: prawdziwe zapytanie do MF (--live)
// ---------------------------------------------------------------------------

if (process.argv.includes("--live")) {
  clearMfCache();
  setMfFetch(null);
  const r = await lookupCompanyByNip(NIP_VALID_2);
  if (isMfError(r)) {
    console.log(`SKIP live: ${r.error}`);
  } else {
    ok("live: MF zwrócił podmiot", r.found && !!r.company?.name, r.company);
    console.log("     ", JSON.stringify(r.company, null, 2));
  }
}

console.log(failures === 0 ? "\nWszystkie testy przeszły." : `\n${failures} test(ów) nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
