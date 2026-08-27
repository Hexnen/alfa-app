/**
 * Jednorazowa migracja starych dopisków asystenta z `description` do notatek (calendar_event_notes):
 * fragmenty „[Przebieg DD.MM] …” / „[Anulowano DD.MM] …” (każdy akapit zaczynający się od takiego
 * znacznika) → osobna notatka source=assistant, userLabel „Asystent”, created_at = updated_at eventu;
 * description zostaje bez tych akapitów (pusty → NULL). NIE uruchamia się automatycznie.
 *
 *   npx tsx scripts/migrate-notes.ts          # dry-run (tylko wypisuje, co by zrobił)
 *   npx tsx scripts/migrate-notes.ts --apply  # zapis
 */
import { eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { logActivity } from "../src/lib/activity-log.js";

const APPLY = process.argv.includes("--apply");
const MARK_RE = /^\[(Przebieg|Anulowano)(?: (\d{2})\.(\d{2}))?\]\s*/;

const rows = db.select().from(schema.calendarEvents).where(isNotNull(schema.calendarEvents.description)).all();
let events = 0;
let notes = 0;
for (const ev of rows) {
  const paras = (ev.description ?? "").split(/\n{2,}/);
  const keep: string[] = [];
  const extracted: string[] = [];
  for (const p of paras) {
    const m = MARK_RE.exec(p.trim());
    if (!m) {
      keep.push(p);
      continue;
    }
    const body = p.trim().replace(MARK_RE, "");
    const day = m[2] && m[3] ? ` ${m[2]}.${m[3]}` : "";
    extracted.push(m[1] === "Przebieg" ? `Przebieg${day}: ${body}` : `Anulowano: ${body}`);
  }
  if (extracted.length === 0) continue;
  events++;
  notes += extracted.length;
  const newDesc = keep.join("\n\n").trim() || null;
  console.log(`#${ev.id} „${ev.title}”: ${extracted.length} notatek; opis → ${newDesc == null ? "NULL" : JSON.stringify(newDesc.slice(0, 60))}`);
  for (const t of extracted) console.log(`   + ${t.slice(0, 100)}`);
  if (!APPLY) continue;
  db.transaction((tx) => {
    for (const text of extracted) {
      tx.insert(schema.calendarEventNotes)
        .values({ eventId: ev.id, userId: ev.updatedBy ?? null, userLabel: "Asystent", source: "assistant", text, createdAt: ev.updatedAt, updatedAt: ev.updatedAt })
        .run();
    }
    tx.update(schema.calendarEvents).set({ description: newDesc, updatedAt: sql`(datetime('now'))` }).where(eq(schema.calendarEvents.id, ev.id)).run();
    logActivity(tx, {
      entityType: "calendar_event", entityId: ev.id, objectId: ev.objectId, user: null, action: "note_added",
      summary: `Migracja: ${extracted.length} dopisków z opisu przeniesiono do notatek`,
    });
  });
}
console.log(`\n${APPLY ? "Zmigrowano" : "Do migracji (dry-run)"}: ${events} wydarzeń, ${notes} notatek${APPLY ? "" : " — uruchom z --apply, aby zapisać"}`);
