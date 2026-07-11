/**
 * Tworzy konto bezpośrednio w bazie (bez API).
 * Użycie: npm run create:user -- <login> <hasło> [--admin]
 * Z flagą --admin konto dostaje role='admin' (pełny dostęp do wszystkich
 * podzakładek). Jeśli konto już istnieje, --admin podnosi je do admina.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/auth/passwords.js";

const args = process.argv.slice(2);
const isAdmin = args.includes("--admin");
const positional = args.filter((a) => !a.startsWith("--"));
const login = (positional[0] || "").trim().toLowerCase();
const password = positional[1] || "";
const role = isAdmin ? "admin" : "user";
if (!login || !password) {
  console.error("Użycie: npm run create:user -- <login> <hasło> [--admin]");
  process.exit(1);
}

const existing = db.select().from(users).where(eq(users.email, login)).get();
if (existing) {
  if (isAdmin && existing.role !== "admin") {
    db.update(users).set({ role: "admin" }).where(eq(users.id, existing.id)).run();
    console.log(`⬆️  Konto "${login}" (#${existing.id}) podniesione do admina.`);
  } else {
    console.log(`Konto "${login}" już istnieje (#${existing.id}, role=${existing.role}).`);
  }
  process.exit(0);
}

const row = db
  .insert(users)
  .values({ email: login, passwordHash: hashPassword(password), displayName: login, role })
  .returning()
  .get();
console.log(`✅ Utworzono konto "${login}" (#${row.id}, role=${role}).`);
