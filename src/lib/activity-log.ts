/**
 * Generyczny dziennik aktywności (tabela activity_log).
 *
 * Pierwszym konsumentem jest kalendarz, ale helper nie zna kalendarza —
 * loguje zmiany dowolnej encji (entityType + entityId). Wpisy zapisujemy
 * w tej samej transakcji co zmiana (better-sqlite3 jest synchroniczny,
 * więc przekazujemy `db` albo `tx`).
 */
import { db, schema } from "../db/index.js";
import type { ActivityAction, User } from "../db/schema.js";

// Typ transakcji drizzle/better-sqlite3 — helpery działają na db lub tx.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

// Minimalny fragment użytkownika potrzebny do podpisania wpisu.
export type ActivityUser = Pick<User, "id" | "email" | "displayName"> | null | undefined;

export interface LogActivityInput {
  entityType: string;
  entityId: number;
  objectId?: number | null;
  user: ActivityUser;
  action: ActivityAction;
  field?: string | null;
  oldValue?: string | number | boolean | null;
  newValue?: string | number | boolean | null;
  summary?: string | null;
}

/** Etykieta użytkownika do snapshotu (odporna na późniejsze usunięcie konta). */
export function userLabelOf(user: ActivityUser): string | null {
  if (!user) return null;
  const name = (user.displayName || "").trim();
  return name || user.email || null;
}

function toText(v: string | number | boolean | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

/** Zapisuje jeden wpis do activity_log. Zwraca id wpisu. */
export function logActivity(dbx: DbOrTx, input: LogActivityInput): number {
  const row = dbx
    .insert(schema.activityLog)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      objectId: input.objectId ?? null,
      userId: input.user?.id ?? null,
      userLabel: userLabelOf(input.user),
      action: input.action,
      field: input.field ?? null,
      oldValue: toText(input.oldValue),
      newValue: toText(input.newValue),
      summary: input.summary ?? null,
    })
    .returning({ id: schema.activityLog.id })
    .get();
  return row.id;
}

// Opis pojedynczego pola do porównania w logFieldDiffs.
export interface DiffField<T> {
  key: keyof T & string; // klucz w rekordzie (camelCase)
  /** Nazwa pola zapisywana w kolumnie `field` (domyślnie snake_case z key). */
  field?: string;
  /** Etykieta PL do summary (domyślnie = field). */
  label?: string;
  /** Akcja logu dla tego pola (domyślnie "updated"). */
  action?: ActivityAction;
  /** Formatowanie wartości do summary (old/new). */
  format?: (v: T[keyof T & string]) => string;
}

export interface LogFieldDiffsInput<T extends Record<string, unknown>> {
  entityType: string;
  entityId: number;
  objectId?: number | null;
  user: ActivityUser;
  before: T;
  after: T;
  fields: (DiffField<T> | (keyof T & string))[];
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

function norm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = String(v);
  return s === "" ? null : s;
}

/**
 * Porównuje stary i nowy rekord dla listy pól i zapisuje po jednym wpisie
 * per zmienione pole. Zwraca listę nazw zmienionych pól.
 */
export function logFieldDiffs<T extends Record<string, unknown>>(
  dbx: DbOrTx,
  input: LogFieldDiffsInput<T>
): string[] {
  const changed: string[] = [];
  for (const f of input.fields) {
    const def: DiffField<T> = typeof f === "string" ? { key: f } : f;
    const oldRaw = input.before[def.key];
    const newRaw = input.after[def.key];
    const oldV = norm(oldRaw);
    const newV = norm(newRaw);
    if (oldV === newV) continue;

    const field = def.field ?? camelToSnake(def.key);
    const label = def.label ?? field;
    const fmt = (v: T[keyof T & string]) =>
      def.format ? def.format(v) : (norm(v) ?? "—");
    const summary = `Zmieniono ${label}: ${fmt(oldRaw)} → ${fmt(newRaw)}`;

    logActivity(dbx, {
      entityType: input.entityType,
      entityId: input.entityId,
      objectId: input.objectId,
      user: input.user,
      action: def.action ?? "updated",
      field,
      oldValue: oldV,
      newValue: newV,
      summary,
    });
    changed.push(field);
  }
  return changed;
}
