// Seed/naprawa listy techników — pełne imiona i nazwiska.
// Aktywni tylko: Sajdak, Brodzicki, Jaworski. Uruchomienie nadpisuje tabelę.
import { db, schema } from "../src/db/index.js";
import { like } from "drizzle-orm";

const TECHNICIANS: (typeof schema.technicians.$inferInsert)[] = [
  { firstName: "Dominik", lastName: "Jaworski", type: "internal", active: true },
  { firstName: "Wojtek", lastName: "Brodzicki", type: "internal", active: true },
  { firstName: "Mikołaj", lastName: "Sajdak", type: "internal", active: true },
  { firstName: "Daniel", lastName: "Styczewski", type: "internal", notes: "Kontrolny", active: false },
  { firstName: "Michał", lastName: "Gozdek", type: "external", active: false },
  { firstName: "Kamil", lastName: "Potaś", type: "external", active: false },
  { firstName: "Darek", lastName: "Kazimierak", type: "external", active: false },
];

await db.delete(schema.technicians);
await db.insert(schema.technicians).values(TECHNICIANS);
console.log(`Zapisano ${TECHNICIANS.length} techników (aktywni: Jaworski, Brodzicki, Sajdak).`);

// Ujednolicenie starych wpisów: "D. Jaworski" → "Dominik Jaworski"
const upd1 = await db
  .update(schema.realizations)
  .set({ contractor1: "Dominik Jaworski" })
  .where(like(schema.realizations.contractor1, "D. Jaworski"))
  .returning();
const upd2 = await db
  .update(schema.protocols)
  .set({ contractor: "Dominik Jaworski" })
  .where(like(schema.protocols.contractor, "D. Jaworski"))
  .returning();
console.log(`Zaktualizowano wykonawcę w ${upd1.length} realizacjach i ${upd2.length} protokołach.`);
process.exit(0);
