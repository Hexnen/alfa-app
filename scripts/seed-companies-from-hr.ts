/**
 * Zasianie słownika spółek nazwami używanymi w kadrach (arkusz WYNAGRODZENIA):
 *   npx tsx scripts/seed-companies-from-hr.ts            # suchy przebieg
 *   npx tsx scripts/seed-companies-from-hr.ts --apply    # zapis
 *
 * Źródłem są DISTINCT nazwy z `hr_contracts.company` i `hr_office_payroll.company`.
 * Skrypt jest idempotentny: dopisuje tylko te, których w słowniku jeszcze nie ma
 * (porównanie bez rozróżniania wielkości liter).
 */
import { sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";

const apply = process.argv.includes("--apply");

const fromContracts = db
  .selectDistinct({ name: schema.hrContracts.company })
  .from(schema.hrContracts)
  .all()
  .map((r) => r.name);
const fromOffice = db
  .selectDistinct({ name: schema.hrOfficePayroll.company })
  .from(schema.hrOfficePayroll)
  .all()
  .map((r) => r.name);

const names = [...new Set([...fromContracts, ...fromOffice].map((n) => (n ?? "").trim()).filter(Boolean))].sort(
  (a, b) => a.localeCompare(b, "pl")
);

const existing = new Set(
  db
    .select({ name: schema.companies.name })
    .from(schema.companies)
    .all()
    .map((r) => r.name.toLowerCase())
);

const missing = names.filter((n) => !existing.has(n.toLowerCase()));

console.log(`Spółki w kadrach: ${names.length}, w słowniku: ${existing.size}, do dodania: ${missing.length}`);
for (const n of missing) {
  const contracts = db
    .select({ c: sql<number>`count(*)` })
    .from(schema.hrContracts)
    .where(sql`${schema.hrContracts.company} = ${n}`)
    .get();
  console.log(`  ${n} (umów: ${contracts?.c ?? 0})`);
}

if (!apply) {
  console.log("\nSuchy przebieg — nic nie zapisano. Uruchom z --apply.");
  process.exit(0);
}

if (missing.length > 0) {
  db.insert(schema.companies)
    .values(missing.map((name) => ({ name })))
    .run();
}
console.log(`\nDodano ${missing.length} spółek.`);
