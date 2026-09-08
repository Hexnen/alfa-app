import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// scrypt — brak natywnych zależności (bcrypt/argon2), działa na goły node:crypto.
const KEYLEN = 64;

/**
 * Asynchroniczny scrypt (pula wątków libuv), NIE `scryptSync`. Jedno haszowanie
 * trwa ~50–100 ms; wersja synchroniczna trzymała przez ten czas cały event loop,
 * więc 30 błędnych logowań z rzędu zamrażało API wszystkim zalogowanym — gotowa
 * dźwignia DoS bez żadnych uprawnień.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

/** Zwraca "salt:hash" (hex). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Porównanie w stałym czasie (timingSafeEqual). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Stały „zastępczy" hash dla loginów, których nie ma w bazie. Logowanie liczy
 * na nim scrypt tak samo jak dla istniejącego konta, żeby czas odpowiedzi nie
 * zdradzał, czy login istnieje (bez tego brak konta = odpowiedź w <1 ms,
 * istniejące konto = ~60 ms — wyrocznia do enumeracji loginów). Losowy salt
 * jest stały na czas życia procesu; wynik porównania i tak jest odrzucany.
 */
const DUMMY_HASH = `${randomBytes(16).toString("hex")}:${"0".repeat(KEYLEN * 2)}`;

/** Zużywa tyle samo czasu co `verifyPassword`, zawsze zwraca false. */
export async function burnPasswordCheck(password: string): Promise<false> {
  await verifyPassword(password, DUMMY_HASH);
  return false;
}
