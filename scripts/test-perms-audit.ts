/**
 * Poprawki z audytów uprawnień (docs/AUDYT-UPRAWNIEN-A.md, -B.md), paczka
 * „Kadry / Zlecenia / Oferty / CMA / Aktywność / Kontakty”. Trasy Hono przez
 * `app.request` z podstawionym userem i PRAWDZIWYM `tabPermissionGuard`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-perms-audit.ts
 *
 * Sprawdza w obie strony — że klucz modułu otwiera to, czego ekran potrzebuje,
 * i że przy okazji NIE wycieka nic ponad to (kwoty, ceny zakupu, cudze działy,
 * dziennik Kadr w feedzie kalendarza).
 *
 * Sprząta po sobie HARD (fikstury z prefiksem), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";
import contractorsRoutes from "../src/routes/contractors.js";
import ordersRoutes from "../src/routes/orders.js";
import offersRoutes from "../src/routes/offers.js";
import companiesRoutes from "../src/routes/companies.js";
import pricelistRoutes from "../src/routes/pricelist.js";
import realizationsRoutes from "../src/routes/realizations.js";
import activityRoutes from "../src/routes/activity.js";
import contactsRoutes from "../src/routes/contacts.js";
import cmaMailRoutes from "../src/routes/cma-mail.js";
import hrLocksRoutes from "../src/routes/hr-locks.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)?.slice(0, 400)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__PAUD_TEST__";

// ---------------------------------------------------------------------------
// Sprzątanie
// ---------------------------------------------------------------------------

function cleanup() {
  const eventIds = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (eventIds.length) {
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  db.delete(schema.activityLog).where(like(schema.activityLog.userLabel, `${PREFIX}%`)).run();
  db.delete(schema.contacts).where(like(schema.contacts.lastName, `${PREFIX}%`)).run();
  db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  db.delete(schema.warehouseItems).where(like(schema.warehouseItems.name, `${PREFIX}%`)).run();
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.hrEditLocks).where(eq(schema.hrEditLocks.userId, u.id)).run();
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
}
cleanup();

// ---------------------------------------------------------------------------
// Fikstury
// ---------------------------------------------------------------------------

function makeUser(suffix: string, permissions: PermissionMap): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x",
      displayName: `${PREFIX}${suffix}`,
      role: "user",
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .get();
}

/** Losowy POPRAWNY NIP (suma kontrolna), żeby /by-nip go nie odrzucił. */
function validNip(): string {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (;;) {
    const d = Array.from({ length: 9 }, (_, i) => (i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10)));
    const sum = d.reduce((s, x, i) => s + x * w[i], 0) % 11;
    if (sum === 10) continue;
    return d.join("") + String(sum);
  }
}

const routers: [string, Hono][] = [
  ["/api/contractors", contractorsRoutes],
  ["/api/orders", ordersRoutes],
  ["/api/offers", offersRoutes],
  ["/api/companies", companiesRoutes],
  ["/api/pricelist", pricelistRoutes],
  ["/api/realizations", realizationsRoutes],
  ["/api/activity", activityRoutes],
  ["/api/contacts", contactsRoutes],
  ["/api/cma/mail", cmaMailRoutes],
  ["/api/hr/locks", hrLocksRoutes],
];

/**
 * Klient: kontekst jak po requireAuth + prawdziwy strażnik. Ścieżki spoza
 * zamontowanych routerów (np. SSE /hr/live) trafiają w atrapę 200 — wtedy
 * sprawdzamy wyłącznie decyzję strażnika.
 */
function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  for (const [path, r] of routers) app.route(path, r);
  app.all("*", (c) => c.json({ success: true, stub: true }));
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body: json, data: json?.data as unknown };
  };
}

try {
  const nip = validNip();
  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX} Płatnik`, nip, city: "Testowo", notes: "TAJNA notatka" })
    .returning()
    .get();
  const object = db
    .insert(schema.objects)
    .values({ contractorId: contractor.id, name: `${PREFIX} Obiekt`, type: "monitoring", installationType: "new", monthlyZdw: 999 })
    .returning()
    .get();
  const item = db
    .insert(schema.warehouseItems)
    .values({ name: `${PREFIX} Kamera`, purchasePrice: 123.45, salePrice: 300 })
    .returning()
    .get();
  db.insert(schema.technicians)
    .values({ firstName: "Jan", lastName: `${PREFIX}Technik`, phone: "600000000", email: "t@example.invalid", active: true })
    .run();
  const contact = db
    .insert(schema.contacts)
    .values({ firstName: "Anna", lastName: `${PREFIX}Kontakt`, contractorId: contractor.id })
    .returning()
    .get();
  const mkEvent = (department: "technical" | "handlowy") =>
    db
      .insert(schema.calendarEvents)
      .values({
        type: "spotkanie" as never,
        title: `${PREFIX} ${department}`,
        startAt: "2026-10-14T10:00",
        endAt: "2026-10-14T11:00",
        allDay: false,
        department,
        contactId: contact.id,
      })
      .returning()
      .get();
  const evTech = mkEvent("technical");
  const evSales = mkEvent("handlowy");
  const logRow = (entityType: string, entityId: number) =>
    db.insert(schema.activityLog)
      .values({ entityType, entityId, action: "update", userLabel: `${PREFIX}log`, field: "x", oldValue: "1", newValue: "2" })
      .run();
  logRow("calendar_event", evTech.id);
  logRow("calendar_event", evSales.id);
  logRow("hr_payroll", 424242);

  // -------------------------------------------------------------------------
  // Kadry: rezerwacje i SSE (A #3, #18)
  // -------------------------------------------------------------------------
  {
    const payroll = clientFor(makeUser("payroll", { "kadry/wynagrodzenia": "edit" }));
    const r1 = await payroll("POST", "/hr/locks/acquire", { scope: "payroll", year: 2031, month: 3 });
    ok("kadry/wynagrodzenia: edit → rezerwacja payroll 200", r1.status === 200, r1);
    await payroll("POST", "/hr/locks/release", { scope: "payroll", year: 2031, month: 3 });
    const r2 = await payroll("POST", "/hr/locks/acquire", { scope: "hours", year: 2031, month: 3 });
    ok("kadry/wynagrodzenia: edit → rezerwacja hours 403", r2.status === 403, r2);
    const r3 = await payroll("GET", "/hr/locks?year=2031&month=3");
    ok("kadry/wynagrodzenia → GET /hr/locks 200", r3.status === 200, r3);

    const norms = clientFor(makeUser("normy", { "kadry/normy": "view" }));
    ok("kadry/normy → /hr/live przepuszczone", (await norms("GET", "/hr/live")).status === 200);
    ok("kadry/normy → /hr/month-status przepuszczone", (await norms("GET", "/hr/month-status?year=2026&month=1")).status === 200);
    ok("kadry/normy → zamknięcie miesiąca 403", (await norms("POST", "/hr/month-status/close", {})).status === 403);
    const kadryView = clientFor(makeUser("dzialy", { "kadry/dzialy": "view" }));
    ok("kadry/dzialy → /companies 200", (await kadryView("GET", "/companies")).status === 200);
    const comps = (await kadryView("GET", "/companies")).data as Record<string, unknown>[];
    ok("kadry/dzialy → spółki bez objectsMonthlyValue", comps.every((c) => !("objectsMonthlyValue" in c)), comps[0]);
  }

  // -------------------------------------------------------------------------
  // Zlecenia: płatnik i jego obiekty (A #5, #6)
  // -------------------------------------------------------------------------
  {
    const orders = clientFor(makeUser("orders", { orders: "edit" }));
    const r = await orders("GET", `/contractors/by-nip/${nip}`);
    const d = r.data as Record<string, unknown>;
    ok("orders → /contractors/by-nip 200", r.status === 200, r);
    ok("orders → by-nip zawężony (bez notatek)", d?.exists === true && d?.id === contractor.id && !("notes" in d), d);
    ok("orders → pełne /contractors/:id 403", (await orders("GET", `/contractors/${contractor.id}`)).status === 403);
    ok("orders → zapis kontrahenta przez by-nip 403", (await orders("POST", `/contractors/by-nip/${nip}`, {})).status === 403);
    const po = await orders("GET", `/orders/payer-objects/${contractor.id}`);
    const list = po.data as Record<string, unknown>[];
    ok("orders → payer-objects zwraca obiekt", po.status === 200 && list.some((o) => o.id === object.id), po);
    ok("orders → payer-objects bez kwot", list.every((o) => !("monthlyZdw" in o) && !("monthlyValue" in o)), list[0]);
    const os = await orders("GET", `/orders/object-services/${object.id}`);
    ok("orders → object-services 200", os.status === 200 && Array.isArray(os.data), os);

    const full = clientFor(makeUser("contractors", { contractors: "view" }));
    const fr = (await full("GET", `/contractors/by-nip/${nip}`)).data as Record<string, unknown>;
    ok("contractors → by-nip pełny rekord (z notatkami)", fr?.notes === "TAJNA notatka", fr);
  }

  // -------------------------------------------------------------------------
  // Oferty / Protokoły: słowniki (A #7, #8)
  // -------------------------------------------------------------------------
  {
    const offers = clientFor(makeUser("offers", { "technical/oferty": "edit" }));
    const items = await offers("GET", "/offers/catalog/items");
    const rows = items.data as Record<string, unknown>[];
    const mine = rows?.find((r) => r.id === item.id);
    ok("oferty → /offers/catalog/items zawiera towar", items.status === 200 && !!mine, items);
    ok("oferty → katalog bez purchasePrice/marży", !!mine && !("purchasePrice" in mine) && !("marginAmount" in mine) && mine.effectiveSalePrice === 300, mine);
    ok("oferty → /offers/catalog/stock 200", (await offers("GET", "/offers/catalog/stock")).status === 200);
    ok("oferty → pełny /warehouse/items 403", (await offers("GET", "/warehouse/items")).status === 403);
    ok("oferty → /companies 200", (await offers("GET", "/companies")).status === 200);
    const pick = await offers("GET", `/contractors/pick?q=${encodeURIComponent(PREFIX)}`);
    const pr = pick.data as Record<string, unknown>[];
    ok("oferty → /contractors/pick znajduje kontrahenta", pick.status === 200 && pr.some((c) => c.id === contractor.id), pick);
    ok("oferty → pick bez notatek", pr.every((c) => !("notes" in c)), pr[0]);
    ok("oferty → pełne /contractors 403", (await offers("GET", "/contractors?search=x")).status === 403);

    const proto = clientFor(makeUser("proto", { "technical/protokoly": "view" }));
    ok("protokoly → /contractors/pick 200", (await proto("GET", "/contractors/pick?q=ab")).status === 200);
  }

  // -------------------------------------------------------------------------
  // Cennik, Technicy, Realizacje (A #11, #15, #16)
  // -------------------------------------------------------------------------
  {
    const cennik = clientFor(makeUser("cennik", { "technical/cennik": "edit" }));
    const t = await cennik("GET", "/pricelist/technicians");
    const tr = t.data as Record<string, unknown>[];
    ok("cennik → /pricelist/technicians 200", t.status === 200 && tr.some((x) => x.lastName === `${PREFIX}Technik`), t);
    ok("cennik → technicy bez telefonu/e-maila", tr.every((x) => !("phone" in x) && !("email" in x)), tr[0]);

    const techs = clientFor(makeUser("technicy", { "technical/technicy": "edit" }));
    ok("technicy → /pricelist/lists 200", (await techs("GET", "/pricelist/lists")).status === 200);
    ok("technicy → pozycje cennika 403", (await techs("GET", "/pricelist")).status === 403);
    ok("technicy → nowy cennik 403", (await techs("POST", "/pricelist/lists", { name: "x" })).status === 403);

    const real = clientFor(makeUser("real", { "technical/realizacje": "view" }));
    const n = await real("GET", "/realizations/technician-names");
    ok("realizacje → technician-names", n.status === 200 && (n.data as string[]).includes(`Jan ${PREFIX}Technik`), n);
  }

  // -------------------------------------------------------------------------
  // CMA: wysyłka z raportu (B #9), zapis /cma (B #12)
  // -------------------------------------------------------------------------
  {
    const rap = clientFor(makeUser("raporty", { "cma/raporty": "edit" }));
    const r = await rap("POST", "/cma/mail/send-issues/999999999", {});
    ok("cma/raporty: edit → send-issues przechodzi strażnika (404 raportu)", r.status === 404, r);
    ok("cma/raporty → ustawienia poczty 403", (await rap("GET", "/cma/mail/settings")).status === 403);
    const trendy = clientFor(makeUser("trendy", { "cma/trendy": "edit" }));
    ok("cma/trendy: edit → kasowanie raportu 403", (await trendy("DELETE", "/cma/reports/1")).status === 403);
    ok("cma/trendy → odczyt /cma przechodzi", (await trendy("GET", "/cma/reports")).status === 200);
  }

  // -------------------------------------------------------------------------
  // Aktywność kalendarza (B #8 + wyciek dziennika Kadr)
  // -------------------------------------------------------------------------
  {
    const tech = clientFor(makeUser("kal", { "technical/kalendarz": "view" }));
    const r = await tech("GET", "/activity/recent?limit=500");
    const rows = r.data as { entityType: string; entityId: number }[];
    ok("technical/kalendarz → feed 200", r.status === 200, r);
    ok("feed: tylko calendar_event", rows.every((e) => e.entityType === "calendar_event"), rows.find((e) => e.entityType !== "calendar_event"));
    ok("feed: wpis technicznego wydarzenia jest", rows.some((e) => e.entityId === evTech.id));
    ok("feed: brak wpisu handlowego", !rows.some((e) => e.entityId === evSales.id));
    const forced = await tech("GET", "/activity/recent?entityType=hr_payroll");
    ok("?entityType=hr_payroll nie wyciąga Kadr", (forced.data as { entityType: string }[]).every((e) => e.entityType === "calendar_event"), forced.data);

    const sales = clientFor(makeUser("hkal", { "handlowy/kalendarz": "view" }));
    const s = await sales("GET", "/activity/recent?department=handlowy&limit=500");
    const srows = s.data as { entityId: number }[];
    ok("handlowy/kalendarz → feed handlowy 200", s.status === 200, s);
    ok("feed handlowy: swoje jest, techniczne nie", srows.some((e) => e.entityId === evSales.id) && !srows.some((e) => e.entityId === evTech.id));
    ok("handlowy/kalendarz → ?department=technical 403", (await sales("GET", "/activity/recent?department=technical")).status === 403);
    const none = clientFor(makeUser("none", { orders: "view" }));
    ok("bez kalendarza → feed 403", (await none("GET", "/activity/recent")).status === 403);
  }

  // -------------------------------------------------------------------------
  // Kontakty: wydarzenia osoby (B #6)
  // -------------------------------------------------------------------------
  {
    const kont = clientFor(makeUser("kontakty", { "handlowy/kontakty": "view" }));
    const r = await kont("GET", `/contacts/${contact.id}`);
    const evs = ((r.data as { events?: { id: number }[] })?.events ?? []).map((e) => e.id);
    ok("handlowy/kontakty → karta kontaktu z wydarzeniem handlowym", r.status === 200 && evs.includes(evSales.id), r);
    ok("handlowy/kontakty → bez wydarzeń technicznych", !evs.includes(evTech.id), evs);

    const ctr = clientFor(makeUser("ctr", { contractors: "view" }));
    const c2 = await ctr("GET", `/contacts/${contact.id}`);
    const ev2 = ((c2.data as { events?: { id: number }[] })?.events ?? []).map((e) => e.id);
    ok("contractors → kontakt bez cudzych wydarzeń", c2.status === 200 && ev2.length === 0, ev2);
  }
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWSZYSTKO OK" : `\n${failures} BŁĘDÓW`);
process.exit(failures === 0 ? 0 : 1);
