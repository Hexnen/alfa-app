/**
 * Test strażnika uprawnień Analityki na żywym backendzie (port 4001):
 *   ./alfa start && npx tsx scripts/test-analytics-perms.ts
 * Zakłada tymczasowe konto __ZZ_PERM__ z JEDNYM uprawnieniem `analityka/obiekty`
 * (poziom "view") i sprawdza, że API_TAB_MAP rozdziela trzy widoki osobno:
 * własny widok 200, dwa pozostałe 403. Wspólny wpis `{ prefix: "/analytics" }`
 * przepuściłby wszystkie trzy, bo maxLevel() bierze najwyższy poziom z listy.
 * Kasuje konto i sesję HARD, także przy błędzie.
 */
import { db, schema } from "../src/db/index.js";
import { eq, like } from "drizzle-orm";
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
const EMAIL = "__ZZ_PERM__@example.invalid";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

function cleanup() {
  const u = db.select().from(schema.users).where(eq(schema.users.email, EMAIL)).get();
  if (u) db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  db.delete(schema.users).where(like(schema.users.email, "__ZZ_PERM__%")).run();
}

async function status(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  return res.status;
}

async function main() {
  cleanup();

  const [user] = db
    .insert(schema.users)
    .values({
      email: EMAIL,
      passwordHash: "x", // konto nigdy się nie loguje — sesję tworzymy wprost
      displayName: "__ZZ_PERM__",
      role: "user",
      permissions: JSON.stringify({ "analityka/obiekty": "view" }),
    })
    .returning()
    .all();

  const { token } = createSession(user.id);

  ok("bez sesji → 401", (await (await fetch(`${BASE}/analytics/obiekty`)).status) === 401);

  const obiekty = await status("/analytics/obiekty", token);
  const kontrahenci = await status("/analytics/kontrahenci", token);
  const handlowcy = await status("/analytics/handlowcy", token);

  ok("nadany widok Obiekty → 200", obiekty === 200, obiekty);
  ok("nienadany widok Kontrahenci → 403", kontrahenci === 403, kontrahenci);
  ok("nienadany widok Handlowcy → 403", handlowcy === 403, handlowcy);

  // Trasa jest zamontowana (a nie 404) — inaczej strażnik nie miałby czego chronić.
  ok("trasa /analytics zamontowana pod strażnikiem", obiekty !== 404, obiekty);
}

try {
  await main();
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  cleanup();
  console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} nieudanych asercji`);
  process.exit(failures === 0 ? 0 : 1);
}
