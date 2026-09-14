/**
 * Panel admina — Panel technika (/api/admin/technik/*): słownik czynności
 * podpowiadanych technikowi w protokole.
 *
 * Wzorzec dokładnie jak w src/routes/admin-calendar.ts: ustawienia żyją
 * w `app_settings` (klucz `technik.activities`, opis pola:
 * src/lib/technik-config.ts), precedencja DB → domyślne, każda zmiana idzie do
 * `activity_log`. Konwencja odpowiedzi: { success, data } / { success:false, error }.
 *
 * Technik NIE czyta tego routera — rola `technik` nie ma wstępu do /api/admin/*
 * (technikRoleGuard). Odczyt dla panelu: GET /api/technik/activities.
 */
import { Hono } from "hono";
import { db } from "../db/index.js";
import { requireAdmin, getUser } from "../middleware/auth.js";
import { logActivity } from "../lib/activity-log.js";
import { deleteSetting, getSetting, setSetting } from "../lib/settings.js";
import {
  DEFAULT_TECHNIK_ACTIVITIES,
  TECHNIK_ACTIVITIES_KEY,
  TECHNIK_ACTIVITIES_MAX,
  TECHNIK_ACTIVITY_MAX_LEN,
  formatTechnikActivities,
  normalizeTechnikActivities,
  resolveTechnikActivities,
  serializeTechnikActivities,
  validateTechnikActivities,
} from "../lib/technik-config.js";

const app = new Hono();
app.use("*", requireAdmin);

function activitiesPayload() {
  const r = resolveTechnikActivities();
  return {
    values: { activities: r.value },
    sources: { activities: r.source },
    defaults: { activities: [...DEFAULT_TECHNIK_ACTIVITIES] },
    meta: { maxItems: TECHNIK_ACTIVITIES_MAX, maxLength: TECHNIK_ACTIVITY_MAX_LEN },
  };
}

app.get("/activities", (c) => c.json({ success: true, data: activitiesPayload() }));

/**
 * PUT { activities: string[] | null } — `null` przywraca słownik domyślny
 * (usuwa wiersz z app_settings), pusta tablica to świadome „nie podpowiadaj nic”.
 */
app.put("/activities", async (c) => {
  const user = getUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ success: false, error: "Nieprawidłowe body" }, 400);
  }
  if (!("activities" in body)) return c.json({ success: false, error: "Brak pola activities" }, 400);

  const before = resolveTechnikActivities();
  const raw = body.activities;

  if (raw === null) {
    if (getSetting(TECHNIK_ACTIVITIES_KEY) !== null) {
      db.transaction((tx) => {
        deleteSetting(TECHNIK_ACTIVITIES_KEY, tx);
        logActivity(tx, {
          entityType: "app_settings",
          entityId: 0,
          user,
          action: "updated",
          field: TECHNIK_ACTIVITIES_KEY,
          oldValue: JSON.stringify(before.value),
          newValue: null,
          summary: `Przywrócono domyślny słownik czynności technika (było: ${formatTechnikActivities(before.value)})`,
        });
      });
    }
    return c.json({ success: true, data: activitiesPayload() });
  }

  const err = validateTechnikActivities(raw);
  if (err) return c.json({ success: false, error: err }, 400);

  const next = normalizeTechnikActivities(raw as string[]);
  const serialized = serializeTechnikActivities(next);
  // Ta sama wartość efektywna = nic do zapisania (bez pustych wpisów w activity_log).
  if (serializeTechnikActivities(before.value) !== serialized || before.source === "default") {
    db.transaction((tx) => {
      setSetting(TECHNIK_ACTIVITIES_KEY, serialized, user.id, tx);
      logActivity(tx, {
        entityType: "app_settings",
        entityId: 0,
        user,
        action: "updated",
        field: TECHNIK_ACTIVITIES_KEY,
        oldValue: JSON.stringify(before.value),
        newValue: serialized,
        summary: `Zmieniono słownik czynności technika: ${formatTechnikActivities(before.value)} → ${formatTechnikActivities(next)}`,
      });
    });
  }

  return c.json({ success: true, data: activitiesPayload() });
});

export default app;
