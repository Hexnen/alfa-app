/**
 * Panel technika „na żywo" — tłumaczenie sygnałów kalendarza na sygnały JEDNEGO technika.
 *
 * PO CO. Biuro zmienia zlecenie w kalendarzu CRM (status, termin, opis, ekipę,
 * notatkę, odwołanie, usunięcie), a tablet w terenie dowiadywał się o tym dopiero
 * po powrocie fokusu. Broker z src/lib/calendar-live.ts rozsyła już sygnał o każdej
 * mutacji — tu jest filtr, który decyduje, CZY i JAKI sygnał ma zobaczyć konkretny
 * technik.
 *
 * DLACZEGO FILTR JEST PO STRONIE SERWERA. Sygnał kalendarza niesie id wydarzeń
 * z CAŁEGO działu technicznego. Przepuszczenie go do panelu powiedziałoby
 * podwykonawcy, ile i jakich zleceń ma firma — a on ma widzieć wyłącznie swoje.
 * Stąd `technikChangesFor`: z sygnału działowego zostają tylko id, do których
 * pytający jest (albo BYŁ) przypisany.
 *
 * SAM SYGNAŁ NIE NIESIE DANYCH ZLECENIA — panel po nim woła zwykłe
 * `GET /technik/jobs`, które nadal pilnuje własności wierszowej.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { TECHNIK_JOB_TYPES } from "./calendar-labels.js";
import { getEventRow } from "./calendar-mutations.js";
import type { CalendarChange } from "./calendar-live.js";

/**
 * Co panel ma zrobić:
 *  - `updated` — zlecenie technika się zmieniło (termin, status, opis, przypisanie
 *    kogoś z ekipy, odwołanie); front przeładowuje listę i ekran zlecenia,
 *  - `notes`  — doszła/zmieniła się notatka przy zleceniu,
 *  - `deleted` — biuro usunęło wydarzenie,
 *  - `unassigned` — technika zdjęto ze zlecenia (albo zlecenie przestało nim być,
 *    np. po zmianie typu na kafelek notatki); zlecenie ma zniknąć z listy.
 */
export type TechnikChangeKind = "updated" | "deleted" | "unassigned" | "notes";

export interface TechnikChange {
  kind: TechnikChangeKind;
  /** Id zleceń objętych zmianą. Puste = „nie wiadomo które, przeładuj listę". */
  ids: number[];
  /** Kiedy zmiana poszła w świat (ISO) — do logów i ewentualnego komunikatu. */
  at: string;
}

/** Czy technik jest TERAZ przypisany do wydarzenia. */
function isAssigned(eventId: number, technicianId: number): boolean {
  return (
    db
      .select({ id: schema.calendarEventAssignees.technicianId })
      .from(schema.calendarEventAssignees)
      .where(
        and(
          eq(schema.calendarEventAssignees.eventId, eventId),
          eq(schema.calendarEventAssignees.technicianId, technicianId)
        )
      )
      .get() != null
  );
}

/**
 * Sygnał kalendarza → sygnały dla jednego technika (zero, jeden albo kilka —
 * jedna zmiana w serii potrafi część terminów zmienić, a część odpiąć).
 *
 * Rozstrzygnięcie per wydarzenie:
 *  - wydarzenia nie ma / jest usunięte, a technik był z nim związany → `deleted`,
 *  - technik nadal przypisany do zlecenia (dział techniczny + typ widoczny
 *    w panelu) → `updated` albo `notes`. ODWOŁANE (`status = cancelled`) też
 *    tu wpada: to jest zmiana, którą technik ma zobaczyć na ekranie zlecenia,
 *    a z listy i tak wypadnie przy przeładowaniu,
 *  - przypisania już nie ma (albo wydarzenie przestało być zleceniem), a przed
 *    zmianą było → `unassigned`.
 */
export function technikChangesFor(change: CalendarChange, technicianId: number): TechnikChange[] {
  if (change.department !== "technical") return [];
  const at = new Date(change.ts).toISOString();
  // Sygnał bez id („przeładuj wszystko") — rzadki (import, operacja zbiorcza).
  // Panel po nim odświeża listy; nic o cudzych zleceniach się z niego nie dowie.
  if (change.ids.length === 0) return [{ kind: "updated", ids: [], at }];

  const wasMine = change.technicianIds.includes(technicianId);
  const mine: number[] = [];
  const deleted: number[] = [];
  const gone: number[] = [];

  for (const id of change.ids) {
    const row = getEventRow(db, id);
    const assigned = isAssigned(id, technicianId);
    if (!assigned && !wasMine) continue;
    if (!row || row.deletedAt != null) {
      deleted.push(id);
      continue;
    }
    // Ten sam zakres, co lista panelu (mineConditions): dział techniczny
    // i wszystko poza kafelkiem notatki.
    const isJob = row.department === "technical" && TECHNIK_JOB_TYPES.includes(row.type);
    if (assigned && isJob) mine.push(id);
    else gone.push(id);
  }

  const out: TechnikChange[] = [];
  if (mine.length > 0) out.push({ kind: change.kind === "notes" ? "notes" : "updated", ids: mine, at });
  if (deleted.length > 0) out.push({ kind: "deleted", ids: deleted, at });
  if (gone.length > 0) out.push({ kind: "unassigned", ids: gone, at });
  return out;
}
