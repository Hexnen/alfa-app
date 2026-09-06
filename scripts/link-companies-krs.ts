/**
 * Dowiązanie spółek grupy do rejestrów: NIP + KRS ustalone z Krajowego Rejestru Sądowego
 * (api-krs.ms.gov.pl, odpis aktualny) dla etykiet używanych w kadrach.
 *
 *   npx tsx scripts/link-companies-krs.ts            # suchy przebieg
 *   npx tsx scripts/link-companies-krs.ts --apply    # zapis NIP-u i KRS-u do słownika
 *
 * Skrypt NIE ufa mapowaniu na słowo — dla każdej pozycji pobiera odpis z KRS i sprawdza,
 * czy nazwa podmiotu faktycznie zawiera etykietę (np. „GUARD 21”). Dopiero wtedy zapisuje.
 * Dane firmowe (adres, REGON, status VAT) dociąga potem scripts/validate-companies-mf.ts.
 *
 * Etykiety kadrowe to nazwy spółek komandytowych: „ALFA GROUP sp. z o.o. <ETYKIETA> sp.k.”
 * (dla TRUST/TARK komplementariuszem jest ALFA GROUP S sp. z o.o.).
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";

const apply = process.argv.includes("--apply");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Etykieta w kadrach → numer KRS spółki komandytowej. */
const KRS_BY_LABEL: Record<string, string> = {
  BROWN: "0000710154",
  CONTROL: "0000826784",
  FRESH: "0000712223",
  "GUARD 2": "0000712226",
  "GUARD 4": "0000716678",
  "GUARD 6": "0000726451",
  "GUARD 9": "0000735185",
  "GUARD 14": "0000757189",
  "GUARD 17": "0000759217",
  "GUARD 20": "0000763005",
  "GUARD 21": "0000764531",
  "GUARD 22": "0000764483",
  "GUARD 23": "0000767919",
  "GUARD 24": "0000768047",
  "GUARD 25": "0000768077",
  // „GUARD SK” = ALFA GROUP sp. z o.o. GUARD sp.k. (bez numeru) — jedyny kandydat,
  // ale mapowanie etykiety jest naszym domysłem: potwierdź w księgowości.
  "GUARD SK": "0000626803",
  ONE: "0000626099",
  "TARK 1": "0000842490",
  "TRUST 2": "0000822741",
  "TRUST 3": "0000822612",
  "TRUST 4": "0000822621",
  "TRUST 5": "0000823183",
  "TRUST 6": "0000829346",
  "TRUST 7": "0000829258",
  "TRUST 10": "0000828164",
};

/** Czy nazwa z KRS pasuje do etykiety (dla „GUARD SK” wystarczy samo „GUARD … SPÓŁKA KOMANDYTOWA”). */
function nameMatches(label: string, name: string): boolean {
  const norm = name.toUpperCase().replace(/\s+/g, " ");
  if (label === "GUARD SK") return /GUARD SPÓŁKA KOMANDYTOWA/.test(norm);
  return norm.includes(` ${label} `) || norm.includes(` ${label} SPÓŁKA KOMANDYTOWA`);
}

let matched = 0;
let skipped = 0;
for (const [label, krs] of Object.entries(KRS_BY_LABEL)) {
  const company = db.select().from(schema.companies).where(eq(schema.companies.name, label)).get();
  if (!company) {
    console.log(`  ${label.padEnd(10)} → brak w słowniku spółek, pomijam`);
    skipped++;
    continue;
  }

  const res = await fetch(`https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/${krs}?rejestr=P&format=json`, {
    signal: AbortSignal.timeout(20000),
  });
  if (res.status !== 200) {
    console.log(`  ${label.padEnd(10)} KRS ${krs} → HTTP ${res.status}`);
    skipped++;
    await sleep(150);
    continue;
  }
  const json = (await res.json()) as {
    odpis?: {
      dane?: {
        dzial1?: {
          danePodmiotu?: { nazwa?: string; identyfikatory?: { nip?: string; regon?: string } };
          siedzibaIAdres?: {
            adres?: { ulica?: string; nrDomu?: string; nrLokalu?: string; kodPocztowy?: string; miejscowosc?: string };
          };
        };
      };
    };
  };
  const podmiot = json.odpis?.dane?.dzial1?.danePodmiotu;
  const adres = json.odpis?.dane?.dzial1?.siedzibaIAdres?.adres;
  const name = podmiot?.nazwa ?? "";
  const nip = podmiot?.identyfikatory?.nip ?? "";
  // REGON w odpisie bywa 14-znakowy (z zerami) — do słownika bierzemy 9 pierwszych cyfr.
  const regon = (podmiot?.identyfikatory?.regon ?? "").slice(0, 9);
  const street = [adres?.ulica, adres?.nrDomu].filter(Boolean).join(" ") + (adres?.nrLokalu ? "/" + adres.nrLokalu : "");

  if (!nameMatches(label, name) || !nip) {
    console.log(`  ${label.padEnd(10)} KRS ${krs} → NIE PASUJE: „${name}”`);
    skipped++;
    await sleep(150);
    continue;
  }

  console.log(`  ${label.padEnd(10)} KRS ${krs}  NIP ${nip}  ${name}`);
  if (apply) {
    db.update(schema.companies)
      .set({
        nip,
        krs,
        regon,
        fullName: name.replace(/"/g, "").trim(),
        address: street.trim(),
        postalCode: adres?.kodPocztowy ?? "",
        city: adres?.miejscowosc ?? "",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.companies.id, company.id))
      .run();
  }
  matched++;
  await sleep(150);
}

console.log(
  `\nDopasowano: ${matched}, pominięto: ${skipped}${apply ? " — NIP i KRS zapisane" : " — suchy przebieg"}`
);
