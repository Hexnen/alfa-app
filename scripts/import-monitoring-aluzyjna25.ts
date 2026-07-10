// Import projektu monitoringu "Aluzyjna 25" z narzędzia standalone
// (monitoring-system-aluzyjna25.zip) do tabeli monitoring_projects.
// Uruchomienie: npx tsx scripts/import-monitoring-aluzyjna25.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, schema } from "../src/db/index.js";
import { eq } from "drizzle-orm";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "Aluzyjna 25, Warszawa";

const data = readFileSync(join(here, "data/projekt-aluzyjna25.json"), "utf8");
JSON.parse(data); // walidacja
const notes = readFileSync(join(here, "data/kontekst-aluzyjna25.md"), "utf8");

const [existing] = await db
  .select({ id: schema.monitoringProjects.id })
  .from(schema.monitoringProjects)
  .where(eq(schema.monitoringProjects.name, NAME));

if (existing) {
  console.log(`Projekt "${NAME}" już istnieje (id=${existing.id}) — pomijam.`);
} else {
  const [p] = await db
    .insert(schema.monitoringProjects)
    .values({
      name: NAME,
      address: "ul. Aluzyjna 25, 03-149 Warszawa (Białołęka / Nowodwory)",
      notes,
      data,
    })
    .returning();
  console.log(`Zaimportowano projekt "${NAME}" (id=${p.id}).`);
}
