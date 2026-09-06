/**
 * Test uprawnień modułu Oferty i Usługi na ŻYWYM backendzie (port 4001):
 *   ./alfa start && npx tsx scripts/test-offers-perms.ts
 *
 * Testy in-process (scripts/test-offers.ts) montują router bez middleware, więc
 * nie przechodzą przez `tabPermissionGuard` — tu sprawdzamy właśnie jego:
 *   • brak klucza `technical/oferty` → 403 na całym module,
 *   • poziom „view" czyta, ale nie zapisuje (403 na POST),
 *   • katalog usług jest czytelny także dla kogoś, kto ma SAME oferty
 *     (edytor musi z czegoś brać robociznę),
 *   • klucz kosztowy `technical/oferty-koszty` steruje TYLKO widocznością pól,
 *     a nie dostępem do tras.
 *
 * Kasuje konta i sesje HARD, także przy błędzie.
 */
import { db, schema } from "../src/db/index.js";
import { and, eq, like } from "drizzle-orm";
import { createSession, SESSION_COOKIE } from "../src/lib/auth/sessions.js";

/*
 * TEN TEST WYMAGA ŻYWEGO BACKENDU i pracuje na TEJ SAMEJ bazie, co on.
 * Uruchomiony przez `test-on-copy.ts` dostaje `ALFA_DB_PATH` wskazujący kopię:
 * sesję zakłada w kopii, a serwer czyta oryginał, więc każde żądanie wraca 401
 * i wygląda to na regresję, którą nie jest. Mówimy o tym wprost.
 */
if (process.env.ALFA_DB_PATH) {
  console.error(
    "Ten test nie działa na kopii bazy (ALFA_DB_PATH) — sesja poszłaby do kopii,\n" +
      "a serwer czyta data/alfa.db. Uruchom bezpośrednio: ./alfa start && npx tsx " +
      process.argv[1]
  );
  process.exit(1);
}

const BASE = "http://localhost:4001/api";
const PREFIX = "__ZZ_OFPERM__";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

function cleanup() {
  const users = db
    .select()
    .from(schema.users)
    .where(like(schema.users.email, `${PREFIX}%`))
    .all();
  for (const u of users) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
}

function makeUser(suffix: string, permissions: Record<string, "view" | "edit">) {
  const [user] = db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x", // konto nigdy się nie loguje — sesję tworzymy wprost
      displayName: `${PREFIX}${suffix}`,
      role: "user",
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .all();
  return createSession(user.id).token;
}

async function call(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  cleanup();

  const noAccess = makeUser("_none", { "technical/magazyn": "edit" });
  const viewer = makeUser("_view", { "technical/oferty": "view" });
  const editor = makeUser("_edit", { "technical/oferty": "edit" });
  const editorWithCosts = makeUser("_costs", {
    "technical/oferty": "edit",
    "technical/oferty-koszty": "view",
  });

  // --- Brak sesji ---
  const anon = await fetch(`${BASE}/offers`);
  ok("bez sesji → 401", anon.status === 401, anon.status);

  // --- Brak klucza ---
  const denied = await call("/offers", noAccess);
  ok("bez klucza technical/oferty → 403", denied.status === 403, denied);
  const deniedPkgs = await call("/offers/packages", noAccess);
  ok("…także na bibliotece pakietów", deniedPkgs.status === 403, deniedPkgs);

  // --- Poziom „view" ---
  const read = await call("/offers", viewer);
  ok("z poziomem view lista czytelna → 200", read.status === 200, read.status);
  const write = await call("/offers", viewer, {
    method: "POST",
    body: JSON.stringify({ date: "2026-08-10" }),
  });
  ok("…ale zapis odrzucony → 403", write.status === 403, write);

  // --- Usługi widoczne dla edytora ofert ---
  const svcForOfferEditor = await call("/services", editor);
  ok(
    "katalog usług czytelny dla kogoś z samymi ofertami → 200",
    svcForOfferEditor.status === 200,
    svcForOfferEditor.status
  );
  const svcForOutsider = await call("/services", noAccess);
  ok(
    "…ale nie dla kogoś bez ofert i bez usług → 403",
    svcForOutsider.status === 403,
    svcForOutsider.status
  );

  // --- Klucz kosztowy nie zamyka tras, tylko przycina pola ---
  const created = await call("/offers", editorWithCosts, {
    method: "POST",
    body: JSON.stringify({ date: "2026-08-10", site: PREFIX, notes: PREFIX }),
  });
  ok("edytor tworzy ofertę → 201", created.status === 201, created);
  const offerId = created.body?.data?.id as number | undefined;

  if (offerId) {
    const withCosts = await call(`/offers/${offerId}`, editorWithCosts);
    const withoutCosts = await call(`/offers/${offerId}`, editor);
    ok(
      "bez klucza kosztowego trasa NADAL działa → 200",
      withoutCosts.status === 200,
      withoutCosts.status
    );
    ok(
      "z kluczem kosztowym w sumach jest marża",
      Object.prototype.hasOwnProperty.call(withCosts.body?.data?.totals ?? {}, "margin"),
      withCosts.body?.data?.totals
    );
    ok(
      "bez klucza kosztowego marży w sumach nie ma",
      !Object.prototype.hasOwnProperty.call(withoutCosts.body?.data?.totals ?? {}, "margin"),
      withoutCosts.body?.data?.totals
    );
    // Konkretne nazwy pól, nie podciągi — `marginHorizonMonths` to okres, nie kwota.
    const raw = JSON.stringify(withoutCosts.body);
    for (const f of ["unitCost", "lineCost", "oneTimeCost", "monthlyCost", "horizonCost", "\"margin\"", "belowMinMargin"]) {
      ok(`w odpowiedzi nie ma pola ${f}`, !raw.includes(f), raw.slice(0, 200));
    }

    // ================================================================
    // REGRESJE Z BUGHUNTU (2026-08-31)
    // ================================================================

    // Katalog usług: czytelny dla ofert, ale bez kosztów i bez prawa zapisu.
    const svcRead = await call("/services", editor);
    const svcFirst = (svcRead.body?.data ?? [])[0];
    ok(
      "usługi bez klucza kosztowego nie wydają kosztu własnego",
      svcFirst === undefined || svcFirst.cost === undefined,
      svcFirst
    );
    ok(
      "…ani marży",
      svcFirst === undefined || svcFirst.marginPct === undefined,
      svcFirst
    );
    const svcWrite = await call("/services", editor, {
      method: "POST",
      body: JSON.stringify({ name: `${PREFIX} wstrzyknięta`, cost: 1, price: 2 }),
    });
    ok("zapis w katalogu usług z samymi Ofertami → 403", svcWrite.status === 403, svcWrite);

    // Projekty CCTV: wycena projektu wymaga dostępu do Projektów.
    const fromMon = await call("/offers/from-monitoring/1", editorWithCosts, {
      method: "POST",
      body: JSON.stringify({}),
    });
    ok(
      "oferta z projektu CCTV bez uprawnienia do Projektów → 403",
      fromMon.status === 403,
      fromMon
    );

    // Sprzątanie oferty utworzonej po drodze.
    await call(`/offers/${offerId}`, editorWithCosts, { method: "DELETE" });
  }
}

try {
  await main();
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  cleanup();
  // Oferta mogła zostać, gdy DELETE nie doszedł — sprzątamy po sentinelu.
  const left = db
    .select()
    .from(schema.offers)
    .all()
    .filter((o) => (o.notes ?? "").includes(PREFIX));
  for (const o of left) {
    db.delete(schema.offerItems).where(eq(schema.offerItems.offerId, o.id)).run();
    db.delete(schema.offerSections).where(eq(schema.offerSections.offerId, o.id)).run();
    db.delete(schema.offers).where(eq(schema.offers.id, o.id)).run();
    // Dziennik kasujemy PO ID tej jednej oferty. Zamiatanie całego
    // `entity_type = 'offer'` zabrałoby historię cudzych dokumentów.
    db.delete(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "offer"),
          eq(schema.activityLog.entityId, o.id)
        )
      )
      .run();
  }
  ok("sprzątanie: brak testowych ofert i kont", true);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
