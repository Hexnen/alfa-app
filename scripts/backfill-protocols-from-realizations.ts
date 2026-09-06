/**
 * Jednorazowe dosypanie godzin i km do NIEPODPISANYCH protokołów, które powstały, zanim
 * realizacja je policzyła (protokół rodzi się w tej samej transakcji co realizacja, więc
 * km z kalkulacji i godziny z automatu dochodziły do niego dopiero na żądanie).
 *
 * Domyślnie SUCHY PRZEBIEG — pokazuje, co by zmienił, i nic nie zapisuje:
 *   npx tsx scripts/backfill-protocols-from-realizations.ts
 * Zapis:
 *   npx tsx scripts/backfill-protocols-from-realizations.ts --apply
 *
 * Zasada jest ta sama, co w automacie: uzupełniamy WYŁĄCZNIE pola zerowe protokołu
 * (`fillProtocolFromRealizationSync`), podpisanych i zatwierdzonych nie ruszamy.
 */
import { eq, isNull, ne, and } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { fillProtocolFromRealizationSync } from "../src/lib/protocol-prefill.js";

const apply = process.argv.includes("--apply");

const rows = db
  .select({
    protocolId: schema.protocols.id,
    number: schema.protocols.number,
    protoHours: schema.protocols.actualHours,
    protoKm: schema.protocols.actualKm,
    realizationId: schema.realizations.id,
    site: schema.realizations.site,
    realHours: schema.realizations.actualHours,
    realKm: schema.realizations.actualKm,
  })
  .from(schema.protocols)
  .innerJoin(schema.realizations, eq(schema.realizations.id, schema.protocols.realizationId))
  .where(and(isNull(schema.protocols.signedAt), ne(schema.protocols.status, "final")))
  .all();

const candidates = rows.filter(
  (r) => (r.protoHours === 0 && r.realHours > 0) || (r.protoKm === 0 && r.realKm > 0)
);

console.log(`Protokoły (szkice) z realizacją: ${rows.length}, do uzupełnienia: ${candidates.length}\n`);
for (const r of candidates) {
  const bits: string[] = [];
  if (r.protoHours === 0 && r.realHours > 0) bits.push(`godziny 0 → ${r.realHours}`);
  if (r.protoKm === 0 && r.realKm > 0) bits.push(`km 0 → ${r.realKm}`);
  console.log(`  ${r.number} (realizacja #${r.realizationId}, ${r.site}): ${bits.join(", ")}`);
}

if (!apply) {
  console.log(`\nSuchy przebieg — nic nie zapisano. Uruchom z --apply, żeby zapisać.`);
  process.exit(0);
}

let changed = 0;
for (const r of candidates) {
  const realization = db
    .select()
    .from(schema.realizations)
    .where(eq(schema.realizations.id, r.realizationId))
    .get();
  if (!realization) continue;
  const res = db.transaction((tx) =>
    fillProtocolFromRealizationSync(tx, realization, {
      user: null,
      reason: "uzupełnienie historyczne",
      summarySuffix: "(przez skrypt backfill)",
    })
  );
  if (res) changed++;
}
console.log(`\nZapisano: ${changed} protokołów.`);
