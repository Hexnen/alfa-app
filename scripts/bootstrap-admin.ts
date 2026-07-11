/**
 * Bootstrap konta master-admina ze zmiennych środowiskowych.
 * Odpalane przy starcie kontenera (po migracjach) — idempotentne.
 *
 *   ADMIN_LOGIN     login admina (domyślnie "msajdak")
 *   ADMIN_PASSWORD  hasło; BEZ niego skrypt jest no-op (nie wywala bootu)
 *
 * Env jest źródłem prawdy dla tego konta: przy każdym starcie hasło jest
 * synchronizowane do wartości z ADMIN_PASSWORD, a rola ustawiana na "admin".
 * To konto break-glass — zwykłych userów zakładaj przez panel / create:user.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/auth/passwords.js";

const login = (process.env.ADMIN_LOGIN || "msajdak").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";

if (!password) {
  console.log("[bootstrap-admin] ADMIN_PASSWORD nie ustawione — pomijam.");
  process.exit(0);
}

const passwordHash = hashPassword(password);
const existing = db.select().from(users).where(eq(users.email, login)).get();

if (existing) {
  db.update(users)
    .set({ role: "admin", passwordHash })
    .where(eq(users.id, existing.id))
    .run();
  console.log(`[bootstrap-admin] Zsynchronizowano admina "${login}" (#${existing.id}).`);
} else {
  const row = db
    .insert(users)
    .values({ email: login, passwordHash, displayName: login, role: "admin" })
    .returning()
    .get();
  console.log(`[bootstrap-admin] Utworzono admina "${login}" (#${row.id}).`);
}
