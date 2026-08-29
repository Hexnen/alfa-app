/**
 * Panel admina — Kalendarz (/api/admin/calendar/*): ustawienia realizacji z wydarzeń
 * i ręczne uzupełnienie zaległości (backfill).
 *
 * Ustawienia żyją w app_settings (klucze `calendar.*`, opis pól: src/lib/calendar-config.ts),
 * precedencja DB → domyślne; czytane przy każdej operacji kalendarza — bez restartu.
 * Konwencja odpowiedzi: { success, data } / { success:false, error }.
 */
import { Hono } from "hono";
import { db } from "../db/index.js";
import { requireAdmin, getUser } from "../middleware/auth.js";
import { logActivity } from "../lib/activity-log.js";
import { deleteSetting, getSetting, setSetting } from "../lib/settings.js";
import {
  CALENDAR_DEFAULTS,
  CALENDAR_FIELDS,
  CALENDAR_FIELD_NAMES,
  calendarSettingsMeta,
  getCalendarConfig,
  type CalendarFieldDef,
  type CalendarSettingField,
  type CalendarSettingsValues,
} from "../lib/calendar-config.js";
import { runBackfill, type BackfillResult } from "../lib/calendar-realizations.js";
import { DATE_RE, isValidCalendarDate } from "../lib/calendar-mutations.js";

const app = new Hono();
app.use("*", requireAdmin);

// ---------------------------------------------------------------------------
// Ustawienia
// ---------------------------------------------------------------------------

function settingsPayload() {
  const cfg = getCalendarConfig();
  return {
    values: cfg.values,
    sources: cfg.sources,
    defaults: CALENDAR_DEFAULTS,
    meta: calendarSettingsMeta(),
  };
}

app.get("/settings", (c) => c.json({ success: true, data: settingsPayload() }));

type Op = {
  dbKey: string;
  /** null = usunięcie wpisu (powrót do wartości domyślnej). */
  value: string | null;
  summary: string;
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
};

function toLogValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

app.put("/settings", async (c) => {
  const user = getUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ success: false, error: "Nieprawidłowe body" }, 400);

  const errors: string[] = [];
  const ops: Op[] = [];
  const before = getCalendarConfig();

  for (const name of CALENDAR_FIELD_NAMES) {
    if (!(name in body)) continue;
    const raw = body[name];
    const def = CALENDAR_FIELDS[name] as CalendarFieldDef<CalendarSettingsValues[CalendarSettingField]>;
    const prev = before.values[name];
    // null = „przywróć domyślne” (usuwa wiersz z app_settings).
    if (raw === null) {
      if (getSetting(def.dbKey) !== null) {
        ops.push({
          dbKey: def.dbKey,
          value: null,
          summary: `Przywrócono domyślne ustawienie kalendarza „${def.label}” (było: ${def.format(prev)})`,
          oldValue: toLogValue(prev),
          newValue: null,
        });
      }
      continue;
    }
    let val: unknown = raw;
    if (def.type === "stringArray" && Array.isArray(raw)) val = raw.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim());
    const err = def.validate(val);
    if (err) {
      errors.push(err);
      continue;
    }
    const next = val as CalendarSettingsValues[CalendarSettingField];
    const serialized = def.serialize(next);
    // Ta sama wartość efektywna = nic do zapisania (bez pustych wpisów w activity_log).
    if (def.serialize(prev) === serialized) continue;
    ops.push({
      dbKey: def.dbKey,
      value: serialized,
      summary: `Zmieniono ustawienie kalendarza „${def.label}”: ${def.format(prev)} → ${def.format(next)}`,
      oldValue: toLogValue(prev),
      newValue: toLogValue(next),
    });
  }

  if (errors.length) return c.json({ success: false, error: errors.join("; ") }, 400);

  db.transaction((tx) => {
    for (const op of ops) {
      if (op.value === null) deleteSetting(op.dbKey, tx);
      else setSetting(op.dbKey, op.value, user.id, tx);
      logActivity(tx, {
        entityType: "app_settings",
        entityId: 0,
        user,
        action: "updated",
        field: op.dbKey,
        oldValue: op.oldValue,
        newValue: op.newValue,
        summary: op.summary,
      });
    }
  });

  return c.json({ success: true, data: settingsPayload() });
});

// ---------------------------------------------------------------------------
// Backfill — uzupełnienie realizacji dla zaległych wydarzeń
// ---------------------------------------------------------------------------

/**
 * POST /backfill-realizations { dryRun: boolean, from?: "YYYY-MM-DD" }
 * → { candidates, created?, skipped, quoteCandidates, quotesCreated? }. Tryb zapisu tworzy realizacje niezależnie od
 * `calendar.auto_realization` (świadoma akcja admina), ale respektuje listę objętych typów.
 */
app.post("/backfill-realizations", async (c) => {
  const user = getUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const dryRun = body?.dryRun !== false; // brak pola / cokolwiek poza false = podgląd
  const fromRaw = typeof body?.from === "string" ? body.from.trim() : "";
  if (fromRaw && (!DATE_RE.test(fromRaw) || !isValidCalendarDate(fromRaw))) {
    return c.json({ success: false, error: "Pole from: oczekiwano daty YYYY-MM-DD" }, 400);
  }
  const from = fromRaw || null;

  try {
    const result: BackfillResult = db.transaction((tx) => {
      const r = runBackfill(tx, { user }, { from, dryRun });
      const madeQuotes = r.quotesCreated ?? 0;
      if (!dryRun && ((r.created?.length ?? 0) > 0 || madeQuotes > 0)) {
        const parts = [
          r.created?.length ? `realizacje dla ${r.created.length} wydarzeń` : null,
          madeQuotes ? `${madeQuotes} wycen prac płatnych` : null,
        ].filter(Boolean);
        logActivity(tx, {
          entityType: "app_settings",
          entityId: 0,
          user,
          action: "updated",
          field: "calendar.backfill_realizations",
          newValue: (r.created?.length ?? 0) + madeQuotes,
          summary: `Uzupełniono ${parts.join(" i ")} w kalendarzu${from ? ` (od ${from})` : ""}`,
        });
      }
      return r;
    });
    return c.json({ success: true, data: result });
  } catch (error) {
    console.error("Error in admin calendar backfill:", error);
    return c.json({ success: false, error: "Błąd: uzupełnianie realizacji" }, 500);
  }
});

export default app;
