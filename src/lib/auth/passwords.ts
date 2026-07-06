import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt — brak natywnych zależności (bcrypt/argon2), działa na goły node:crypto.
const KEYLEN = 64;

/** Zwraca "salt:hash" (hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Porównanie w stałym czasie (timingSafeEqual). */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
