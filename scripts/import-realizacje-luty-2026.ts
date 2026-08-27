// Jednorazowy import realizacji z arkusza "2026 2 Luty.xlsx" (Google Drive)
// do tabeli realizations. Bezpieczny do ponownego uruchomienia — pomija import,
// jeśli luty 2026 ma już wpisy.
import { db, schema } from "../src/db/index.js";
import { like } from "drizzle-orm";
import { splitLegacyKind } from "../src/lib/realization-kind.js";

/** Arkusz zna tylko stary, jednowymiarowy `kind` — rozbijamy go na rodzaj + typ. */
const withKindSplit = (r: typeof schema.realizations.$inferInsert) => ({
  ...r,
  ...splitLegacyKind(r.kind),
});

const ROWS: (typeof schema.realizations.$inferInsert)[] = [
  { date: "2026-02-01", site: "CS - Bud Świętojańska", kind: "warranty", amountHours: 35, note: "wymiana spalonego switcha", contractor1: "D. Jaworski" },
  { date: "2026-02-04", site: "Osteo Concept", kind: "installation", amountHours: 35, note: "montaż systemu", contractor1: "D. Jaworski" },
  { date: "2026-02-05", site: "Pobożengo", kind: "warranty", amountHours: 35, note: "wymiana anteny", contractor1: "D. Jaworski" },
  { date: "2026-02-09", site: "Mogilno", kind: "service", amountHours: 470, amountMaterial: 660, amountKm: 1044, note: "przebudowa", contractor1: "D. Jaworski", actualHours: 3, actualKm: 580, hourlyCost: 120 },
  { date: "2026-02-11", site: "Beton Techniq", kind: "warranty", amountHours: 35, note: "wymiana zasilacza aibox", contractor1: "D. Jaworski" },
  { date: "2026-02-11", site: "STE Nasienna", kind: "service", amountHours: 325, note: "naprawa uszkodzonego przewodu", invoiced: true, contractor1: "D. Jaworski", actualHours: 2, hourlyCost: 80 },
  { date: "2026-02-12", site: "Bluszczańska 12", kind: "installation", amountHours: 180, amountMaterial: 370, discount: 180, note: "wymiana kamery", invoiced: true, contractor1: "D. Jaworski", actualHours: 1, hourlyCost: 40 },
  { date: "2026-02-17", site: "Radzymińska 299 Rawski", kind: "installation", amountHours: 35, note: "montaż 4 kamer", invoiced: true, contractor1: "D. Jaworski" },
  { date: "2026-02-18", site: "Toyota Żerań Inifinite", kind: "installation", amountHours: 35, note: "montaż systemu", invoiced: true, contractor1: "D. Jaworski" },
];

const existing = await db
  .select()
  .from(schema.realizations)
  .where(like(schema.realizations.date, "2026-02-%"));

if (existing.length > 0) {
  console.log(`Pomijam import — luty 2026 ma już ${existing.length} wpisów.`);
} else {
  await db.insert(schema.realizations).values(ROWS.map(withKindSplit));
  console.log(`Zaimportowano ${ROWS.length} realizacji.`);
}

const rows = await db
  .select()
  .from(schema.realizations)
  .where(like(schema.realizations.date, "2026-02-%"));

const total = (r: (typeof rows)[0]) =>
  r.amountHours + r.amountMaterial + r.amountKm - r.discount;
const sum = (kind: string) =>
  rows.filter((r) => r.kind === kind).reduce((a, r) => a + total(r), 0);

console.log(
  `Płatne serwisy: ${sum("service")} | Montaże: ${sum("installation")} | Bezpłatne: ${sum("warranty")}`
);
process.exit(0);
