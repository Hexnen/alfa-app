import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, type User } from "../../db/schema.js";
import { hashPassword } from "./passwords.js";

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: string;
}

export function publicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, displayName: u.displayName, role: u.role };
}

export function findUserByEmail(email: string): User | null {
  return db.select().from(users).where(eq(users.email, email)).get() ?? null;
}

export function findUserById(id: number): User | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

export function createUser(email: string, password: string, displayName: string): User {
  return db
    .insert(users)
    .values({ email, passwordHash: hashPassword(password), displayName })
    .returning()
    .get();
}
