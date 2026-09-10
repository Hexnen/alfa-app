/**
 * Test OKRESÓW USŁUG obiektu (`object_services`), przewidywanego zakończenia
 * i linku Google Maps:
 *   npx tsx scripts/test-object-services.ts
 *   npx tsx scripts/test-on-copy.ts scripts/test-object-services.ts   # na kopii bazy
 *
 * Do września 2026 usługi obiektu były czterema checkboxami — kartoteka nie
 * umiała powiedzieć, OD KIEDY obiekt ma kamery ani że kiedyś je miał. Okresy to
 * naprawiają, ale zamieniają flagi `objects.has_*` w CACHE, a każdy cache można
 * rozjechać ze źródłem. Ten test pilnuje dokładnie tego rozjazdu:
 * zapisu, wyliczania flag, zerowania po zakończeniu okresu i walidacji wejścia.
 *
 * Sprząta po sobie HARD (prefiks __SVC_TEST__), także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { eq, inArray, like } from "drizzle-orm";
import objectsApp from "../src/routes/objects.js";
import {
  flagsFromServices,
  syncAllObjectServiceFlags,
  todayIso,
} from "../src/lib/object-services.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const PREFIX = "__SVC_TEST__";

const app = new Hono();
app.route("/objects", objectsApp);

type Res = { status: number; success?: boolean; data?: any; error?: string; [k: string]: any };
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}

/** Data przesunięta o N dni względem „dziś” w strefie aplikacji. */
function day(offset: number): string {
  const d = new Date(`${todayIso()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const TODAY = todayIso();

function cleanup() {
  const objs = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all();
  const ids = objs.map((o) => o.id);
  if (ids.length) {
    db.delete(schema.objectServices).where(inArray(schema.objectServices.objectId, ids)).run();
    db.delete(schema.objectHistory).where(inArray(schema.objectHistory.objectId, ids)).run();
    db.delete(schema.objects).where(inArray(schema.objects.id, ids)).run();
  }
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  // Handlowcy na końcu: FK z obiektów i kontrahentów jest `on delete set null`,
  // ale kasujemy dopiero po wierszach, które na nich wskazywały.
  db.delete(schema.salespeople).where(like(schema.salespeople.lastName, `${PREFIX}%`)).run();
}

const rowOf = (id: number) =>
  db.select().from(schema.objects).where(eq(schema.objects.id, id)).get()!;
const periodsOf = (id: number) =>
  db.select().from(schema.objectServices).where(eq(schema.objectServices.objectId, id)).all();

try {
  cleanup();

  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX} Klient`, nip: "0000000000" })
    .returning()
    .all()[0];

  const base = {
    contractorId: contractor.id,
    installationType: "new" as const,
    status: "active" as const,
  };

  // --- 1. POST z usługami → flagi, liczba kamer i @deprecated `type` z okresów
  const created = await call("POST", "/objects", {
    ...base,
    name: `${PREFIX} Kamery i SSWiN`,
    services: [
      { service: "kamery", startDate: day(-30), cameraCount: 8 },
      { service: "sswin", startDate: day(-30) },
    ],
  });
  ok("POST z okresami zwraca 201", created.status === 201, created);
  const objA = created.data?.id as number;
  ok("POST zwraca zapisane okresy", (created.data?.services ?? []).length === 2, created.data?.services);
  {
    const row = rowOf(objA);
    ok("flagi wyliczone z okresów (kamery + SSWiN)", row.hasCameras && row.hasSswin && !row.hasOfi, row);
    ok("liczba kamer z okresu", row.cameraCount === 8, row.cameraCount);
    ok("@deprecated `type` z okresów = mixed", row.type === "mixed", row.type);
  }

  // Flagi z body są przy okresach IGNOROWANE (pole wyliczane, jak monthlyValue).
  const ignored = await call("POST", "/objects", {
    ...base,
    name: `${PREFIX} Flagi ignorowane`,
    hasOfi: true,
    cameraCount: 99,
    services: [{ service: "kamery", startDate: day(-5), cameraCount: 3 }],
  });
  {
    const row = rowOf(ignored.data.id);
    ok(
      "flagi `hasX` z body ignorowane przy okresach",
      row.hasCameras && !row.hasOfi && row.cameraCount === 3,
      row
    );
  }

  // --- 2. Dwa okresy tej samej usługi (przerwa w świadczeniu)
  const twice = await call("POST", "/objects", {
    ...base,
    name: `${PREFIX} Dwa okresy kamer`,
    services: [
      { service: "kamery", startDate: "2020-01-01", endDate: "2022-12-31", cameraCount: 4 },
      { service: "kamery", startDate: day(-10), cameraCount: 6 },
    ],
  });
  const objTwice = twice.data.id as number;
  ok("dwa okresy tej samej usługi zapisane", periodsOf(objTwice).length === 2, periodsOf(objTwice));
  ok(
    "zakończony okres nie wchodzi do liczby kamer (6, nie 10)",
    rowOf(objTwice).cameraCount === 6,
    rowOf(objTwice)
  );

  // --- 3. Jedyny okres zakończony → flaga false, wiersz nadal widoczny
  const ended = await call("POST", "/objects", {
    ...base,
    name: `${PREFIX} Kamery zakończone`,
    services: [{ service: "kamery", startDate: "2020-01-01", endDate: day(-1), cameraCount: 5 }],
  });
  const objEnded = ended.data.id as number;
  {
    const row = rowOf(objEnded);
    ok("zakończona usługa gasi flagę", !row.hasCameras, row);
    ok("...i czyści liczbę kamer", row.cameraCount === null, row.cameraCount);
    ok("...ale wiersz okresu zostaje", periodsOf(objEnded).length === 1, periodsOf(objEnded));
  }
  {
    const list = await call("GET", `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&service=kamery&pageSize=50`);
    const ids: number[] = (list.data ?? []).map((o: any) => o.id);
    ok("obiekt z zakończonymi kamerami wypada z filtru ?service=kamery", !ids.includes(objEnded), ids);
    ok("obiekt z aktywnymi kamerami zostaje w filtrze", ids.includes(objA), ids);
  }

  // --- 4. Suma kamer i „nie policzono” (null ≠ 0)
  const sum = await call("POST", "/objects", {
    ...base,
    name: `${PREFIX} Suma kamer`,
    services: [
      { service: "kamery", startDate: day(-20), cameraCount: 3 },
      { service: "kamery", startDate: day(-2), cameraCount: 4 },
    ],
  });
  ok("suma kamer z dwóch aktywnych okresów = 7", rowOf(sum.data.id).cameraCount === 7, rowOf(sum.data.id));

  const partial = await call("POST", "/objects", {
    ...base,
    name: `${PREFIX} Kamery bez liczby`,
    services: [
      { service: "kamery", startDate: day(-20), cameraCount: 3 },
      { service: "kamery", startDate: day(-2) },
    ],
  });
  ok(
    "okres bez liczby kamer → cameraCount null, a nie suma częściowa",
    rowOf(partial.data.id).cameraCount === null && rowOf(partial.data.id).hasCameras,
    rowOf(partial.data.id)
  );

  // --- 5. PUT: pełna podmiana listy (brak id = usunięcie), pusta lista = wszystko off
  {
    const before = periodsOf(objA);
    const keep = before.find((p) => p.service === "kamery")!;
    const put = await call("PUT", `/objects/${objA}`, {
      services: [{ id: keep.id, service: "kamery", startDate: keep.startDate, cameraCount: 12 }],
    });
    ok("PUT z okresami zwraca 200", put.status === 200, put);
    const after = periodsOf(objA);
    ok("okres spoza listy skasowany (SSWiN)", after.length === 1 && after[0].service === "kamery", after);
    ok("flaga SSWiN zgaszona po usunięciu okresu", !rowOf(objA).hasSswin, rowOf(objA));
    ok("zmieniona liczba kamer trafia do cache'u", rowOf(objA).cameraCount === 12, rowOf(objA));
    const hist = db
      .select()
      .from(schema.objectHistory)
      .where(eq(schema.objectHistory.objectId, objA))
      .all();
    ok(
      "zmiana okresów ma własny wpis w historii",
      hist.some((h) => h.description === "Zmieniono okresy usług"),
      hist.map((h) => h.description)
    );
  }
  {
    const put = await call("PUT", `/objects/${objA}`, { services: [] });
    ok("PUT z pustą listą zwraca 200", put.status === 200, put);
    const row = rowOf(objA);
    ok(
      "pusta lista gasi wszystkie flagi i czyści kamery",
      !row.hasCameras && !row.hasSswin && !row.hasVideoreception && !row.hasOfi && row.cameraCount === null,
      row
    );
    ok("...i kasuje wiersze okresów", periodsOf(objA).length === 0, periodsOf(objA));
  }

  // --- 6. Walidacja: 400 i ŻADNEGO zapisu
  {
    const snapshot = JSON.stringify(periodsOf(objTwice));
    const badOrder = await call("PUT", `/objects/${objTwice}`, {
      services: [{ service: "kamery", startDate: day(0), endDate: day(-3) }],
    });
    ok("koniec przed początkiem → 400", badOrder.status === 400, badOrder);
    ok("...komunikat po polsku z nazwą usługi", /Kamery/.test(badOrder.error ?? ""), badOrder.error);

    const badService = await call("PUT", `/objects/${objTwice}`, {
      services: [{ service: "dron", startDate: day(0) }],
    });
    ok("nieznana usługa → 400", badService.status === 400, badService);

    const notArray = await call("PUT", `/objects/${objTwice}`, { services: "abc" });
    ok("services jako string → 400", notArray.status === 400, notArray);

    const noStart = await call("PUT", `/objects/${objTwice}`, {
      services: [{ service: "kamery" }],
    });
    ok("okres bez daty startu → 400", noStart.status === 400, noStart);

    const foreignId = await call("PUT", `/objects/${objTwice}`, {
      services: [{ id: 999999999, service: "kamery", startDate: day(0) }],
    });
    ok("id okresu z innego obiektu → 400", foreignId.status === 400, foreignId);

    ok("odrzucone żądania niczego nie zapisały", JSON.stringify(periodsOf(objTwice)) === snapshot, periodsOf(objTwice));
  }

  // --- 7. Przewidywane zakończenie: zapis, czyszczenie i sortowanie
  {
    const withEnd = await call("PUT", `/objects/${objTwice}`, { expectedEndDate: day(30) });
    ok("PUT zapisuje przewidywane zakończenie", withEnd.status === 200 && rowOf(objTwice).expectedEndDate === day(30), rowOf(objTwice));
    const badDate = await call("PUT", `/objects/${objTwice}`, { expectedEndDate: "2026-02-30" });
    ok("data spoza kalendarza → 400", badDate.status === 400, badDate);
    ok("...i nie nadpisała poprzedniej", rowOf(objTwice).expectedEndDate === day(30), rowOf(objTwice));
    const cleared = await call("PUT", `/objects/${objEnded}`, { expectedEndDate: null });
    ok("null czyści przewidywane zakończenie", cleared.status === 200 && rowOf(objEnded).expectedEndDate === null, rowOf(objEnded));
  }
  {
    const asc = await call("GET", `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&sort=expectedEnd&dir=asc&pageSize=50`);
    const desc = await call("GET", `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&sort=expectedEnd&dir=desc&pageSize=50`);
    const emptyLast = (rows: any[]) => {
      const firstEmpty = rows.findIndex((r) => !r.expectedEndDate);
      return firstEmpty === -1 || rows.slice(firstEmpty).every((r) => !r.expectedEndDate);
    };
    ok("sort rosnąco: puste daty na końcu", emptyLast(asc.data ?? []), (asc.data ?? []).map((r: any) => r.expectedEndDate));
    ok("sort malejąco: puste daty też na końcu", emptyLast(desc.data ?? []), (desc.data ?? []).map((r: any) => r.expectedEndDate));
  }

  // --- 8. Lista i szczegóły zwracają okresy
  {
    const list = await call("GET", `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&pageSize=50`);
    const rowTwice = (list.data ?? []).find((o: any) => o.id === objTwice);
    ok("lista zwraca okresy w wierszu", (rowTwice?.services ?? []).length === 2, rowTwice?.services);
    ok("lista zwraca przewidywane zakończenie", rowTwice?.expectedEndDate === day(30), rowTwice?.expectedEndDate);
    const details = await call("GET", `/objects/${objTwice}`);
    ok("GET /:id zwraca okresy", (details.data?.services ?? []).length === 2, details.data?.services);
  }

  // --- 9. Filtr „kończące się w N dni” i podsumowanie
  {
    // Obiekt, którego JEDYNA usługa kończy się za 10 dni — kończy się mimo
    // braku wpisanego `expectedEndDate`.
    const soon = await call("POST", "/objects", {
      ...base,
      name: `${PREFIX} Usługa do końca miesiąca`,
      monthlyZdw: 500,
      services: [{ service: "sswin", startDate: day(-100), endDate: day(10) }],
    });
    const objSoon = soon.data.id as number;
    const filtered = await call("GET", `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&endingIn=30&pageSize=50`);
    const ids: number[] = (filtered.data ?? []).map((o: any) => o.id);
    ok("?endingIn łapie obiekt z usługą kończącą się w horyzoncie", ids.includes(objSoon), ids);
    ok("?endingIn łapie obiekt z wpisanym przewidywanym zakończeniem", ids.includes(objTwice), ids);
    // Obiekt „Suma kamer” ma dwa okresy BEZ końca i pusty `expectedEndDate` —
    // nic w nim się nie kończy, więc do zestawienia wpaść nie może.
    ok("?endingIn nie łapie obiektu z usługami bezterminowymi", !ids.includes(sum.data.id), ids);
    ok("podsumowanie liczy kończące się", filtered.endingSoonCount === ids.length, {
      count: filtered.endingSoonCount,
      ids,
    });
    ok("podsumowanie liczy przychód zagrożony", filtered.endingSoonRevenue >= 500, filtered.endingSoonRevenue);
    ok("horyzont wraca w odpowiedzi", filtered.endingSoonDays === 30, filtered.endingSoonDays);
  }

  // --- 10. Stara ścieżka flagowa (D5) — PUT bez `services`
  {
    const legacy = db
      .insert(schema.objects)
      .values({
        contractorId: contractor.id,
        name: `${PREFIX} Bez okresów`,
        type: "monitoring",
        installationType: "new",
        status: "active",
        hasCameras: true,
        cameraCount: 2,
      })
      .returning()
      .all()[0];
    const put = await call("PUT", `/objects/${legacy.id}`, { hasSswin: true });
    ok("PUT bez `services` działa po staremu", put.status === 200 && rowOf(legacy.id).hasSswin, rowOf(legacy.id));
    ok("...i nie rusza pozostałych flag", rowOf(legacy.id).hasCameras && rowOf(legacy.id).cameraCount === 2, rowOf(legacy.id));
    ok("...i przelicza @deprecated `type`", rowOf(legacy.id).type === "mixed", rowOf(legacy.id).type);

    // --- 11. Bulk-sync: obiekt bez okresów NIETKNIĘTY, z zakończonym — wyzerowany
    const dying = await call("POST", "/objects", {
      ...base,
      name: `${PREFIX} Do wygaszenia`,
      services: [{ service: "kamery", startDate: day(-100), cameraCount: 4 }],
    });
    const objDying = dying.data.id as number;
    // Koniec WCZORAJ — usługa wygasła sama z upływem czasu, bez żadnego zapisu.
    db.update(schema.objectServices)
      .set({ endDate: day(-1) })
      .where(eq(schema.objectServices.objectId, objDying))
      .run();
    syncAllObjectServiceFlags();
    ok("bulk-sync gasi flagę okresu zakończonego wczoraj", !rowOf(objDying).hasCameras, rowOf(objDying));
    ok(
      "bulk-sync NIE rusza obiektu bez wierszy okresów",
      rowOf(legacy.id).hasCameras && rowOf(legacy.id).hasSswin,
      rowOf(legacy.id)
    );
  }

  // --- 12. Link Google Maps
  {
    const bad = await call("PUT", `/objects/${objTwice}`, { mapsUrl: "https://evil.example.com/maps" });
    ok("link spoza Google → 400", bad.status === 400, bad);
    ok("...komunikat po polsku", /Google Maps/.test(bad.error ?? ""), bad.error);
    const goodShort = await call("PUT", `/objects/${objTwice}`, { mapsUrl: "https://maps.app.goo.gl/abc123" });
    ok("krótki link maps.app.goo.gl przechodzi", goodShort.status === 200 && rowOf(objTwice).mapsUrl === "https://maps.app.goo.gl/abc123", rowOf(objTwice).mapsUrl);
    const cleared = await call("PUT", `/objects/${objTwice}`, { mapsUrl: null });
    ok("null czyści link", cleared.status === 200 && rowOf(objTwice).mapsUrl === null, rowOf(objTwice).mapsUrl);
    const spoof = await call("PUT", `/objects/${objTwice}`, { mapsUrl: "https://google.com.evil.example/maps" });
    ok("podszywający się host (google.com.evil…) odrzucony", spoof.status === 400, spoof);
  }

  // --- 13. Czysta funkcja `flagsFromServices` (jednostkowo, bez HTTP)
  {
    const flags = flagsFromServices(
      [
        { service: "kamery", startDate: day(5), endDate: null, cameraCount: 2 },
        { service: "ofi", startDate: "2019-01-01", endDate: day(-1) },
      ],
      TODAY
    );
    ok("usługa zaplanowana (start w przyszłości) NADAL liczy się do flag", flags.hasCameras, flags);
    ok("usługa zakończona wczoraj już nie", !flags.hasOfi, flags);
  }

  /* --- 14. „Data startu szacowana” (`startEstimated`, migracja 0087)
   *
   * Backfill 0084 wpisał obiektom bez umowy i bez rejestru datę ZAŁOŻENIA
   * KARTOTEKI jako start usługi. Flaga oddziela takie daty od znanych, a jedyne
   * zdarzenie, które ją gasi, to WPISANIE innej daty przez człowieka — edycja
   * liczby kamer czy uwag nie może udawać, że nagle wiemy, od kiedy usługa trwa.
   */
  {
    const est = await call("POST", "/objects", {
      ...base,
      name: `${PREFIX} Data szacowana`,
      services: [{ service: "kamery", startDate: day(-40), cameraCount: 2 }],
    });
    const objEst = est.data.id as number;
    ok(
      "nowy okres z formularza ma datę ZNANĄ (startEstimated = false)",
      periodsOf(objEst)[0].startEstimated === false,
      periodsOf(objEst)[0]
    );
    ok(
      "API zwraca `startEstimated` w okresach",
      (est.data?.services ?? [])[0]?.startEstimated === false,
      est.data?.services
    );

    // Symulacja wiersza po backfillu: data zgadnięta z daty założenia kartoteki.
    const estId = periodsOf(objEst)[0].id;
    db.update(schema.objectServices)
      .set({ startEstimated: true })
      .where(eq(schema.objectServices.id, estId))
      .run();

    const details = await call("GET", `/objects/${objEst}`);
    ok(
      "GET /:id niesie flagę szacowanej daty",
      (details.data?.services ?? [])[0]?.startEstimated === true,
      details.data?.services
    );

    // (a) edycja INNEGO pola przy tej samej dacie — flaga ZOSTAJE
    const sameDate = await call("PUT", `/objects/${objEst}`, {
      services: [{ id: estId, service: "kamery", startDate: day(-40), cameraCount: 5 }],
    });
    ok("PUT bez zmiany daty zwraca 200", sameDate.status === 200, sameDate);
    ok(
      "...zapisuje zmianę liczby kamer",
      rowOf(objEst).cameraCount === 5,
      rowOf(objEst).cameraCount
    );
    ok(
      "...i ZACHOWUJE flagę „data szacowana”",
      periodsOf(objEst)[0].startEstimated === true,
      periodsOf(objEst)[0]
    );

    // (b) użytkownik wpisuje inną datę startu — flaga gaśnie
    const changed = await call("PUT", `/objects/${objEst}`, {
      services: [
        { id: estId, service: "kamery", startDate: day(-60), cameraCount: 5, startEstimated: true },
      ],
    });
    ok("PUT ze zmienioną datą zwraca 200", changed.status === 200, changed);
    ok(
      "zmiana daty startu KASUJE flagę (mimo `startEstimated: true` w body)",
      periodsOf(objEst)[0].startEstimated === false &&
        periodsOf(objEst)[0].startDate === day(-60),
      periodsOf(objEst)[0]
    );

    // (c) walidator przyjmuje bool z body przy NOWYM wierszu (import, kopia okresu)
    const fromImport = await call("PUT", `/objects/${objEst}`, {
      services: [
        { id: estId, service: "kamery", startDate: day(-60), cameraCount: 5 },
        { service: "sswin", startDate: day(-60), startEstimated: true },
      ],
    });
    ok("PUT z nowym okresem „szacowanym” zwraca 200", fromImport.status === 200, fromImport);
    ok(
      "nowy okres może przyjść z flagą szacowanej daty",
      periodsOf(objEst).find((p) => p.service === "sswin")?.startEstimated === true,
      periodsOf(objEst)
    );

    const badFlag = await call("PUT", `/objects/${objEst}`, {
      services: [{ id: estId, service: "kamery", startDate: day(-60), startEstimated: "moze" }],
    });
    ok("`startEstimated` spoza tak/nie → 400", badFlag.status === 400, badFlag);
  }

  // --- 8. Opiekun handlowy w KARCIE obiektu (GET /objects/:id)
  // Do września 2026 handlowca zwracała tylko lista — karta obiektu pokazywała
  // „Handlowiec —” nawet przy wypełnionym `objects.salesperson_id`.
  {
    const own = db
      .insert(schema.salespeople)
      .values({ firstName: "Ewa", lastName: `${PREFIX}Obiektowa` })
      .returning()
      .all()[0];
    const inheritedSales = db
      .insert(schema.salespeople)
      .values({ firstName: "Jan", lastName: `${PREFIX}Kontrahencki` })
      .returning()
      .all()[0];
    db.update(schema.contractors)
      .set({ salespersonId: inheritedSales.id })
      .where(eq(schema.contractors.id, contractor.id))
      .run();

    const withOwn = await call("POST", "/objects", {
      ...base,
      name: `${PREFIX} Handlowiec własny`,
      salespersonId: own.id,
      services: [{ service: "kamery", startDate: day(-1) }],
    });
    const detailOwn = await call("GET", `/objects/${withOwn.data.id}`);
    ok("GET /objects/:id zwraca handlowca obiektu", detailOwn.data?.salesperson?.id === own.id, detailOwn.data?.salesperson);
    ok(
      "...oznaczonego jako NIE odziedziczony",
      detailOwn.data?.salesperson?.inherited === false &&
        detailOwn.data?.salesperson?.lastName === `${PREFIX}Obiektowa`,
      detailOwn.data?.salesperson
    );

    const withoutOwn = await call("POST", "/objects", {
      ...base,
      name: `${PREFIX} Handlowiec po kliencie`,
      services: [{ service: "kamery", startDate: day(-1) }],
    });
    const detailInherited = await call("GET", `/objects/${withoutOwn.data.id}`);
    ok(
      "GET /objects/:id dziedziczy opiekuna kontrahenta z flagą `inherited`",
      detailInherited.data?.salesperson?.id === inheritedSales.id &&
        detailInherited.data?.salesperson?.inherited === true,
      detailInherited.data?.salesperson
    );

    // Lista zostaje bez zmian — ten sam kształt i ta sama kolejność źródeł.
    const list = await call("GET", `/objects?search=${encodeURIComponent(`${PREFIX} Handlowiec`)}&pageSize=50`);
    const listed = (list.data ?? []) as { id: number; salesperson?: { id: number; inherited: boolean } | null }[];
    ok(
      "lista obiektów nadal niesie tego samego handlowca",
      listed.find((o) => o.id === withOwn.data.id)?.salesperson?.id === own.id &&
        listed.find((o) => o.id === withoutOwn.data.id)?.salesperson?.inherited === true,
      listed.map((o) => o.salesperson)
    );
  }
} finally {
  cleanup();
  const left = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych obiektów", left.length === 0, left);
  const leftC = db
    .select({ id: schema.contractors.id })
    .from(schema.contractors)
    .where(like(schema.contractors.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych kontrahentów", leftC.length === 0, leftC);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
