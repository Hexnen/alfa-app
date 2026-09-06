/**
 * Zbiorowe sprawdzenie spółek w wykazie VAT MF (nasz walidator: src/lib/mf-whitelist.ts):
 *   npx tsx scripts/validate-companies-mf.ts            # suchy przebieg — pokazuje, co przyjdzie
 *   npx tsx scripts/validate-companies-mf.ts --apply    # zapis do słownika spółek
 *
 * Sprawdzamy tylko spółki, które MAJĄ wpisany NIP — wykaz MF wyszukuje wyłącznie po NIP-ie
 * (albo REGON-ie i numerze konta), nie po nazwie. Spółki bez NIP-u są wypisane na końcu jako
 * „do uzupełnienia”: bez numeru nie ma czego walidować i nie wolno go zgadywać.
 *
 * Zapytania idą przez cache MF (jedno na NIP na dzień) i są rozłożone w czasie (250 ms),
 * żeby nie wyczerpać limitu rejestru.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { isMfError, lookupCompanyByNip } from "../src/lib/mf-whitelist.js";
import { normalizeNIP, validateNIP } from "../src/utils/nip.js";

const apply = process.argv.includes("--apply");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const companies = db
  .select()
  .from(schema.companies)
  .all()
  .sort((a, b) => a.name.localeCompare(b.name, "pl"));

const withNip = companies.filter((c) => normalizeNIP(c.nip ?? ""));
const withoutNip = companies.filter((c) => !normalizeNIP(c.nip ?? ""));

console.log(`Spółek w słowniku: ${companies.length} — z NIP-em: ${withNip.length}, bez: ${withoutNip.length}\n`);

let ok = 0;
let failed = 0;
for (const company of withNip) {
  const nip = normalizeNIP(company.nip ?? "");
  if (!validateNIP(nip)) {
    console.log(`  ${company.name.padEnd(14)} ${nip} → BŁĘDNA SUMA KONTROLNA`);
    failed++;
    continue;
  }

  const result = await lookupCompanyByNip(nip);
  if (isMfError(result)) {
    console.log(`  ${company.name.padEnd(14)} ${nip} → błąd: ${result.error}`);
    failed++;
    continue;
  }
  if (!result.found || !result.company) {
    console.log(`  ${company.name.padEnd(14)} ${nip} → wykaz MF nie zna tego NIP-u`);
    if (apply) {
      db.update(schema.companies)
        .set({ vatStatus: "Niezarejestrowany", vatCheckedAt: new Date().toISOString().slice(0, 10) })
        .where(eq(schema.companies.id, company.id))
        .run();
    }
    failed++;
    continue;
  }

  const mf = result.company;
  console.log(
    `  ${company.name.padEnd(14)} ${nip} → ${mf.name} | ${mf.postalCode} ${mf.city}, ${mf.address} | VAT: ${mf.statusVat} | REGON ${mf.regon} | KRS ${mf.krs || "—"}`
  );
  if (apply) {
    db.update(schema.companies)
      .set({
        fullName: mf.name,
        nip: mf.nip,
        regon: mf.regon,
        krs: mf.krs,
        address: mf.address,
        postalCode: mf.postalCode,
        city: mf.city,
        vatStatus: mf.statusVat ?? "",
        vatCheckedAt: mf.date,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.companies.id, company.id))
      .run();
  }
  ok++;
  if (!result.cached) await sleep(250);
}

if (withoutNip.length > 0) {
  console.log(`\nBez NIP-u (wykaz MF szuka tylko po NIP — uzupełnij numer, wtedy skrypt je sprawdzi):`);
  console.log(`  ${withoutNip.map((c) => c.name).join(", ")}`);
}

console.log(`\nSprawdzono: ${ok}, nie udało się: ${failed}${apply ? " — dane zapisane" : " — suchy przebieg, nic nie zapisano"}`);
