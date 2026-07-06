/**
 * Tworzy konto bezpośrednio w bazie (bez API).
 * Użycie: npm run create:user -- <login> <hasło>
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/auth/passwords.js";

const login = (process.argv[2] || "").trim().toLowerCase();
const password = process.argv[3] || "";
if (!login || !password) {
  console.error("Użycie: npm run create:user -- <login> <hasło>");
  process.exit(1);
}

const existing = db.select().from(users).where(eq(users.email, login)).get();
if (existing) {
  console.log(`Konto "${login}" już istnieje (#${existing.id}).`);
  process.exit(0);
}

const row = db
  .insert(users)
  .values({ email: login, passwordHash: hashPassword(password), displayName: login })
  .returning()
  .get();
console.log(`✅ Utworzono konto "${login}" (#${row.id}).`);
