/**
 * Ponowne przeliczenie raportów z podjazdów (po zmianie parsera, np. v2 event_kind):
 *   npx tsx scripts/patrol-reimport.ts raport_z_podjazdow_*.xlsx
 * Pliki idą w kolejności nazw (= chronologicznie), z opcją `force` — dedup po hashu
 * pomijany, zdarzenia odświeżane upsertem (ręcznie przypisany obiekt i rozliczenie
 * zostają). Baza: ALFA_DB_PATH albo ./data/alfa.db. Na koniec liczby per event_kind.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { importPatrolReportBuffer } from "../src/utils/patrol-import.js";

const files = process.argv.slice(2).sort((a, b) => basename(a).localeCompare(basename(b)));
if (!files.length) {
  console.error("Podaj pliki raport_z_podjazdow_*.xlsx");
  process.exit(1);
}
for (const f of files) {
  const r = importPatrolReportBuffer(readFileSync(f), basename(f), { source: "upload", force: true });
  console.log(`${basename(f)}: raport #${r.reportId}, zdarzeń ${r.eventsTotal} (nowe ${r.eventsNew}, odświeżone ${r.eventsUpdated}), podjazdów ${r.patrols}`);
}
const rows = db.all<{ kind: string; n: number }>(
  sql`SELECT event_kind AS kind, count(*) AS n FROM patrol_events GROUP BY event_kind ORDER BY n DESC`
);
console.log("event_kind:", Object.fromEntries(rows.map((r) => [r.kind, r.n])));
