/**
 * Retencja czatów asystenta: usuwa assistant_chats z updated_at starszym niż
 * `retentionDays` (0 = bez limitu). Wiadomości kaskadują; assistant_usage zostaje
 * (chat_id → NULL). Uruchamiane przy starcie backendu i co 24 h (src/index.ts).
 */
import { lt } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { resolveField } from "./assistantConfig.js";

export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Zwraca liczbę usuniętych czatów (0 gdy retencja wyłączona). */
export function pruneOldChats(now = new Date()): number {
  const days = resolveField("retentionDays").value;
  if (!days || days <= 0) return 0;
  // updated_at ma zawsze format datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC) — patrz touchChat w routes/assistant.ts.
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const res = db.delete(schema.assistantChats).where(lt(schema.assistantChats.updatedAt, cutoff)).run();
  const n = Number(res.changes ?? 0);
  if (n > 0) console.log(`[assistant] retencja: usunięto ${n} czatów starszych niż ${days} dni`);
  return n;
}

let timer: NodeJS.Timeout | null = null;

/** Prune przy starcie + co 24 h. Nigdy nie rzuca (błąd tylko w logu). */
export function startRetentionScheduler(): void {
  const run = () => {
    try {
      pruneOldChats();
    } catch (e) {
      console.error("[assistant] retencja: błąd", e);
    }
  };
  run();
  if (timer) clearInterval(timer);
  timer = setInterval(run, RETENTION_INTERVAL_MS);
  timer.unref?.();
}
