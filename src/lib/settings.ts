/**
 * Generyczne ustawienia aplikacji (tabela app_settings, key/value).
 * Pierwszy konsument: konfiguracja Asystenta AI z panelu admina (src/routes/admin-assistant.ts).
 * Wartości nadpisują env/domyślne — precedencja DB → env → domyślne (patrz src/lib/ai/provider.ts).
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";

/**
 * Klucz API asystenta — sekret, celowo NIE jest polem ASSISTANT_FIELDS (nigdy nie wraca do frontu).
 * Pozostałe klucze `assistant.*` opisuje src/lib/ai/assistantConfig.ts (ASSISTANT_FIELDS[*].dbKey).
 */
export const ASSISTANT_API_KEY_SETTING = "assistant.api_key";

export function getSetting(key: string, dbx: DbOrTx = db): string | null {
  const row = dbx
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get();
  return row ? row.value : null;
}

/** Upsert — nadpisuje wartość i podpis (updated_by/updated_at). */
export function setSetting(key: string, value: string, userId: number | null, dbx: DbOrTx = db): void {
  dbx
    .insert(schema.appSettings)
    .values({ key, value, updatedBy: userId })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedBy: userId, updatedAt: sql`(datetime('now'))` },
    })
    .run();
}

export function deleteSetting(key: string, dbx: DbOrTx = db): void {
  dbx.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
}
