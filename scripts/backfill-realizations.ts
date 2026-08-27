/**
 * Uzupełnienie realizacji (+ protokołów) dla istniejących wydarzeń kalendarza objętych typów,
 * które nie mają jeszcze `realization_id`. Ta sama logika co przycisk „Uzupełnij zaległe”
 * w panelu admina (POST /api/admin/calendar/backfill-realizations) — src/lib/calendar-realizations.ts.
 *
 * Uruchomienie (Node 22):
 *   npx tsx scripts/backfill-realizations.ts                      # podgląd (dry-run, domyślny)
 *   npx tsx scripts/backfill-realizations.ts --from=2026-01-01    # tylko od daty
 *   npx tsx scripts/backfill-realizations.ts --apply              # zapis
 *
 * NIE uruchamiać automatycznie na produkcji — najpierw dry-run i przegląd listy.
 */
import { db, schema } from "../src/db/index.js";
import { eq } from "drizzle-orm";
import { runBackfill } from "../src/lib/calendar-realizations.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fromArg = args.find((a) => a.startsWith("--from="));
const from = fromArg ? fromArg.slice("--from=".length).trim() : null;

if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
  console.error("❌ --from wymaga daty YYYY-MM-DD");
  process.exit(1);
}

// Podpis wpisów activity_log: pierwszy administrator (skrypt nie ma sesji).
const admin =
  db.select().from(schema.users).where(eq(schema.users.role, "admin")).get() ??
  db.select().from(schema.users).get();
if (!admin) {
  console.error("❌ Brak użytkowników w bazie — najpierw npm run bootstrap:admin");
  process.exit(1);
}

const ctx = { user: admin, summarySuffix: "(backfill)" };
const result = db.transaction((tx) => runBackfill(tx, ctx, { from, dryRun: !apply }));

console.log(`\nTryb: ${apply ? "ZAPIS (--apply)" : "podgląd (dry-run)"}${from ? `, od ${from}` : ""}`);
console.log(`Kandydaci: ${result.candidates.length}`);
for (const cand of result.candidates) {
  const skipped = result.skipped.find((s) => s.eventId === cand.eventId);
  const created = result.created?.find((x) => x.eventId === cand.eventId);
  const mark = skipped ? `⏭  ${skipped.reason}` : created ? `✅ realizacja #${created.realizationId}${created.protocolNumber ? `, protokół ${created.protocolNumber}` : ""}` : "→ do utworzenia";
  console.log(`  #${cand.eventId} ${cand.startAt} [${cand.type}] ${cand.title} — ${cand.site}  ${mark}`);
}
console.log(`\nUtworzono: ${result.created?.length ?? 0}, pominięto: ${result.skipped.length}`);
if (!apply) console.log("To był podgląd — dodaj --apply, aby zapisać.\n");
