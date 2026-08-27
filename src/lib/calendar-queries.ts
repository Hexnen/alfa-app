/**
 * Wspólne zapytania kalendarza — używane przez trasy (src/routes/calendar.ts)
 * i narzędzia asystenta AI (src/lib/ai/calendarTools.ts). Zachowanie 1:1 z
 * dotychczasowym GET /calendar/conflicts.
 */
import { and, asc, desc, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";

/**
 * Id wydarzeń kolidujących z zakresem [startAt, endAt) dla podanych techników
 * (bez usuniętych i anulowanych; opcjonalnie z pominięciem edytowanego eventu).
 * Porównanie leksykalne ISO działa też między "YYYY-MM-DD" a "YYYY-MM-DDTHH:MM".
 */
export function conflictEventIds(
  dbx: DbOrTx,
  params: { technicianIds: number[]; startAt: string; endAt: string; excludeId?: number | null }
): number[] {
  const { technicianIds, startAt, endAt, excludeId } = params;
  if (technicianIds.length === 0 || !startAt || !endAt) return [];
  const conds = [
    isNull(schema.calendarEvents.deletedAt),
    ne(schema.calendarEvents.status, "cancelled"),
    lt(schema.calendarEvents.startAt, endAt),
    gt(schema.calendarEvents.endAt, startAt),
    sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id IN (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)}))`,
  ];
  if (excludeId != null && Number.isInteger(excludeId)) conds.push(ne(schema.calendarEvents.id, excludeId));
  return dbx
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(and(...conds))
    .orderBy(asc(schema.calendarEvents.startAt))
    .limit(200)
    .all()
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Technicy — wspólne dla promptu asystenta (calendarPrompt/calendarTools) i tras
// ---------------------------------------------------------------------------

export interface TechnicianBrief {
  id: number;
  name: string;
  active: boolean;
}

/** "Jan Kowalski" z wiersza technika (trim — puste nazwisko nie zostawia spacji). */
export function techName(t: { firstName: string; lastName: string }): string {
  return `${t.firstName} ${t.lastName}`.trim();
}

/**
 * Wszyscy technicy (aktywni najpierw, potem po nazwisku) w kształcie dla promptu
 * i narzędzi asystenta. Nazwa historyczna: lista zawiera też nieaktywnych (flaga `active`),
 * bo model musi umieć powiedzieć „ten technik jest nieaktywny” zamiast „nie znam”.
 */
export function listActiveTechnicians(dbx: DbOrTx = db): TechnicianBrief[] {
  return dbx
    .select({
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
      active: schema.technicians.active,
    })
    .from(schema.technicians)
    .orderBy(desc(schema.technicians.active), asc(schema.technicians.lastName), asc(schema.technicians.firstName))
    .all()
    .map((t) => ({ id: t.id, name: techName(t), active: t.active }));
}
