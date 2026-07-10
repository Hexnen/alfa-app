// Import realizacji z arkuszy "2026 1 Styczeń.xlsx" i "2026 3 Marzec.xlsx"
// + korekta stawki godzinowej w lutym (kolumna arkusza to koszt łączny =
// godziny × 40 zł, więc stawka godzinowa to 40 zł).
// Bezpieczny do ponownego uruchomienia — pomija miesiące z istniejącymi wpisami.
import { db, schema } from "../src/db/index.js";
import { like, gt, and, eq } from "drizzle-orm";

type Row = typeof schema.realizations.$inferInsert;

const RATE = 40; // zł za roboczogodzinę (koszt wewnętrzny)

const JANUARY: Row[] = [
  { date: "2026-01-01", site: "Sandex", kind: "warranty", amountHours: 180, note: "Wymiana switcha", contractor1: "Dominik Jaworski", actualHours: 1, hourlyCost: RATE },
  { date: "2026-01-12", site: "Toyota Blizne", kind: "service", amountHours: 470, note: "serwis przewodów, wymiana switcha", invoiced: true, contractor1: "Daniel Styczewski", actualHours: 3, hourlyCost: RATE },
  { date: "2026-01-13", site: "Kalter Orlińskiego", kind: "warranty", amountHours: 180, note: "Demontaż anteny", contractor1: "Wojtek Brodzicki", actualHours: 1, hourlyCost: RATE },
  { date: "2026-01-15", site: "CS-bud Świętojańska, Łódź", kind: "warranty", amountHours: 180, note: "demontaż huba", contractor1: "Dominik Jaworski", actualHours: 1, hourlyCost: RATE },
  { date: "2026-01-19", site: "Kalter Orlińskiego", kind: "warranty", amountHours: 180, note: "Wymiana karty sim", contractor1: "Dominik Jaworski", actualHours: 1, hourlyCost: RATE },
  { date: "2026-01-22", site: "Infine Jagiellońska Żerań", kind: "service", amountHours: 325, note: "serwis przewodów", contractor1: "Dominik Jaworski", actualHours: 2, hourlyCost: RATE },
  { date: "2026-01-26", site: "Toyota Blizne", kind: "service", amountHours: 940, note: "Naprawa przeciętych przewodów", contractor1: "Dominik Jaworski", contractor2: "Daniel Styczewski", actualHours: 6, hourlyCost: RATE },
];

const MARCH: Row[] = [
  { date: "2026-03-03", site: "Kujakowice Górne", kind: "installation", amountHours: 470, amountKm: 1044, note: "wieża na kujakowice", contractor1: "Wojtek Brodzicki", actualHours: 3, actualKm: 580, hourlyCost: RATE },
  { date: "2026-03-04", site: "STB Ostrołęka", kind: "installation", amountHours: 35, note: "montaż 10 kamer (dzierżawa)", invoiced: true, contractor1: "Dominik Jaworski" },
  { date: "2026-03-06", site: "Toyota Cygan Warszawska 13", kind: "service", amountHours: 35, note: "ułożenie okablowania, serwis | 50m utp", invoiced: true, contractor1: "M. Witwera" },
  { date: "2026-03-09", site: "Toyota Cygan Warszawska 13", kind: "service", amountHours: 615, note: "ułożenie okablowania, serwis | 100m zasilający", invoiced: true, contractor1: "M. Witwera", actualHours: 4, hourlyCost: RATE },
  { date: "2026-03-18", site: "Gostynin", kind: "service", amountHours: 70, note: "przeniesienie wieży", contractor1: "Dominik Jaworski", contractor2: "Wojtek Brodzicki" },
  { date: "2026-03-23", site: "Góraszka Południowa 2", kind: "service", amountHours: 35, note: "serwis okablowania", invoiced: true, contractor1: "M. Witwera" },
  { date: "2026-03-24", site: "Infine Cygan", kind: "service", amountHours: 470, note: "przeniesienie systemu", invoiced: true, contractor1: "Dominik Jaworski", actualHours: 3, hourlyCost: RATE },
  { date: "2026-03-30", site: "Łódź Dussman", kind: "warranty", amountHours: 905, amountKm: 1044, note: "serwis, wymiana switcha i dysku twardego", contractor1: "M. Witwera", actualHours: 6, actualKm: 580, hourlyCost: RATE },
];

async function importMonth(label: string, prefix: string, rows: Row[]) {
  const existing = await db
    .select()
    .from(schema.realizations)
    .where(like(schema.realizations.date, `${prefix}-%`));
  if (existing.length > 0) {
    console.log(`${label}: pomijam — ma już ${existing.length} wpisów.`);
    return;
  }
  await db.insert(schema.realizations).values(rows);
  console.log(`${label}: zaimportowano ${rows.length} realizacji.`);
}

await importMonth("Styczeń 2026", "2026-01", JANUARY);
await importMonth("Marzec 2026", "2026-03", MARCH);

// Korekta lutego: stawka godzinowa = 40 zł (nie koszt łączny z arkusza)
const fixed = await db
  .update(schema.realizations)
  .set({ hourlyCost: RATE })
  .where(
    and(
      like(schema.realizations.date, "2026-02-%"),
      gt(schema.realizations.actualHours, 0)
    )
  )
  .returning();
console.log(`Luty: skorygowano stawkę godzinową w ${fixed.length} wpisach.`);

// Nowy serwisant z arkusza marcowego (imię nieznane; nieaktywny wg reguły)
const witwera = await db
  .select()
  .from(schema.technicians)
  .where(eq(schema.technicians.lastName, "Witwera"));
if (witwera.length === 0) {
  await db.insert(schema.technicians).values({
    firstName: "M.",
    lastName: "Witwera",
    type: "external",
    active: false,
  });
  console.log("Dodano technika M. Witwera (nieaktywny).");
}

// Kontrola sum
const all = await db.select().from(schema.realizations);
const total = (r: (typeof all)[0]) =>
  r.amountHours + r.amountMaterial + r.amountKm - r.discount;
for (const m of ["2026-01", "2026-02", "2026-03"]) {
  const rows = all.filter((r) => r.date.startsWith(m));
  const s = (k: string) =>
    rows.filter((r) => r.kind === k).reduce((a, r) => a + total(r), 0);
  const cost = rows
    .filter((r) => r.kind === "warranty")
    .reduce((a, r) => a + r.actualHours * r.hourlyCost, 0);
  console.log(
    `${m}: płatne=${s("service")} montaże=${s("installation")} bezpłatne=${s("warranty")} strata=${cost}`
  );
}
process.exit(0);
