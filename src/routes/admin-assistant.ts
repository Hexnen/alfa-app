/**
 * Panel admina — pełna konfiguracja Asystenta AI (/api/admin/assistant/*).
 *
 * Ustawienia żyją w tabeli app_settings (klucze `assistant.*`, opis pól: src/lib/ai/assistantConfig.ts),
 * precedencja DB → env → domyślne; czytane przy każdej turze — bez restartu.
 * Klucz API NIGDY nie wraca do frontu w całości (tylko maska) i NIGDY nie trafia do activity_log.
 * Konwencja odpowiedzi: { success, data } / { success:false, error }.
 */
import { Hono } from "hono";
import { desc, eq, gte, sql } from "drizzle-orm";
import { listActiveTechnicians } from "../lib/calendar-queries.js";
import { generateText } from "ai";
import fs from "node:fs";
import { db, schema } from "../db/index.js";
import { requireAdmin, getUser } from "../middleware/auth.js";
import { logActivity } from "../lib/activity-log.js";
import { ASSISTANT_API_KEY_SETTING, deleteSetting, getSetting, setSetting } from "../lib/settings.js";
import { getKeyFilePath, makeChatClient, OPENROUTER, resolveApiKey } from "../lib/ai/provider.js";
import {
  ASSISTANT_DEFAULTS,
  ASSISTANT_FIELD_NAMES,
  ASSISTANT_FIELDS,
  assistantMeta,
  getAssistantConfig,
  isOpenRouterUrl,
  MODEL_RE,
  type AssistantField,
  type AssistantSettingsValues,
  type FieldDef,
} from "../lib/ai/assistantConfig.js";
import { classifyError } from "../lib/ai/errors.js";
import { assembleSystemPrompt, localToday } from "../lib/ai/calendarPrompt.js";
import { estimateTokens } from "../lib/ai/context.js";
import { CALENDAR_EVENT_STATUSES, CALENDAR_EVENT_TYPES } from "../db/schema.js";

const app = new Hono();
app.use("*", requireAdmin);

// ---------------------------------------------------------------------------
// Ustawienia
// ---------------------------------------------------------------------------

/** "sk-or-v1-abc…wxyz": 6 pierwszych + "…" + 4 ostatnie; krótkie klucze tylko "…" + 4. */
function maskKey(key: string): string {
  if (key.length >= 14) return `${key.slice(0, 6)}…${key.slice(-4)}`;
  return `…${key.slice(-4)}`;
}

function settingsPayload() {
  const cfg = getAssistantConfig();
  const key = resolveApiKey();
  const keyFile = getKeyFilePath();
  let keyFileExists = false;
  try {
    keyFileExists = fs.existsSync(keyFile) && fs.readFileSync(keyFile, "utf8").trim().length > 0;
  } catch {
    keyFileExists = false;
  }
  return {
    values: cfg.values,
    sources: cfg.sources,
    defaults: ASSISTANT_DEFAULTS,
    apiKey: { set: Boolean(key.key), source: key.source, masked: key.key ? maskKey(key.key) : null },
    isOpenRouter: cfg.isOpenRouter,
    env: {
      OPENROUTER_API_KEY: Boolean(process.env[OPENROUTER.envKey]?.trim()),
      OPENROUTER_KEY_FILE: process.env.OPENROUTER_KEY_FILE?.trim() || null,
      keyFileExists,
      OPENROUTER_MODEL: process.env.OPENROUTER_MODEL?.trim() || null,
      OPENROUTER_PROVIDER_SORT: process.env.OPENROUTER_PROVIDER_SORT ?? null,
      OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL?.trim() || null,
    },
    meta: assistantMeta(),
  };
}

app.get("/settings", (c) => c.json({ success: true, data: settingsPayload() }));

type Op = {
  dbKey: string;
  value: string | null;
  summary: string;
  oldValue?: string | number | boolean | null;
  newValue?: string | number | boolean | null;
  secret?: boolean;
};

function fmtValue<T>(def: FieldDef<T>, v: T): string {
  if (def.format) return def.format(v);
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(brak)";
  if (typeof v === "boolean") return v ? "tak" : "nie";
  return String(v);
}

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
  const before = getAssistantConfig();

  for (const name of ASSISTANT_FIELD_NAMES) {
    if (!(name in body)) continue;
    const raw = body[name];
    const def = ASSISTANT_FIELDS[name] as FieldDef<AssistantSettingsValues[AssistantField]>;
    const prev = before.values[name];
    if (raw === null || (name === "model" && raw === "")) {
      if (getSetting(def.dbKey) !== null) {
        ops.push({
          dbKey: def.dbKey,
          value: null,
          summary: `Przywrócono domyślne ustawienie asystenta „${def.label}” (było: ${fmtValue(def, prev)})`,
          oldValue: toLogValue(prev),
          newValue: null,
        });
      }
      continue;
    }
    // Normalizacja: liczby przysłane jako string, tablice z pustymi elementami.
    let val: unknown = raw;
    if (def.type === "number" && typeof raw === "string" && raw.trim() !== "") val = Number(raw);
    if (def.type === "string" && typeof raw === "string") val = raw.trim();
    if (def.type === "stringArray" && Array.isArray(raw)) val = raw.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim());
    const err = def.validate(val);
    if (err) {
      errors.push(err);
      continue;
    }
    if (name === "disabledTools" && (val as string[]).includes("propose_event")) {
      errors.push("Narzędzia propose_event nie można wyłączyć");
      continue;
    }
    const next = val as AssistantSettingsValues[AssistantField];
    const serialized = def.serialize(next);
    // Ta sama wartość efektywna (z DB, env czy domyślna) = nic do zapisania — bez pustych wpisów w activity_log.
    if (def.serialize(prev) === serialized) continue;
    ops.push({
      dbKey: def.dbKey,
      value: serialized,
      summary:
        name === "enabled"
          ? next
            ? "Włączono asystenta"
            : "Wyłączono asystenta"
          : name === "model"
            ? `Zmieniono model asystenta: ${fmtValue(def, prev)} → ${fmtValue(def, next)}`
            : `Zmieniono ustawienie asystenta „${def.label}”: ${fmtValue(def, prev)} → ${fmtValue(def, next)}`,
      oldValue: toLogValue(prev),
      newValue: toLogValue(next),
    });
  }

  if ("apiKey" in body) {
    const raw = body.apiKey;
    if (raw === null) {
      if (getSetting(ASSISTANT_API_KEY_SETTING) !== null) {
        ops.push({ dbKey: ASSISTANT_API_KEY_SETTING, value: null, summary: "Usunięto klucz API asystenta z bazy", secret: true });
      }
    } else if (typeof raw !== "string") {
      errors.push("Klucz API: oczekiwano tekstu");
    } else {
      const k = raw.trim();
      if (k !== "") {
        if (k.length < 10) errors.push("Klucz API: min. 10 znaków");
        else if (/\s/.test(k)) errors.push("Klucz API nie może zawierać białych znaków");
        else ops.push({ dbKey: ASSISTANT_API_KEY_SETTING, value: k, summary: "Zmieniono klucz API asystenta", secret: true });
      }
      // pusty string = bez zmian
    }
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
        oldValue: op.secret ? null : (op.oldValue ?? null),
        newValue: op.secret ? null : (op.newValue ?? null),
        summary: op.summary,
      });
    }
  });

  return c.json({ success: true, data: settingsPayload() });
});

// ---------------------------------------------------------------------------
// Lista modeli (cache w pamięci 1 h; negatywny 60 s) — OpenRouter albo endpoint OpenAI-compatible
// ---------------------------------------------------------------------------

export type ModelInfo = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPer1M: number | null;
  completionPer1M: number | null;
};

type ModelsResult = { models: ModelInfo[]; fetchedAt: string; error: string | null; source: "openrouter" | "custom" };
type ModelsCache = ModelsResult & { expiresAt: number; baseUrl: string };
let modelsCache: ModelsCache | null = null;
const MODELS_TTL_MS = 60 * 60 * 1000;
const MODELS_NEG_TTL_MS = 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 10_000;

function pricePer1M(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6 * 1e4) / 1e4;
}

type RawModel = {
  id?: string;
  name?: string;
  context_length?: number | null;
  supported_parameters?: string[];
  pricing?: { prompt?: unknown; completion?: unknown };
};

async function fetchModels(baseUrl: string, key: string | undefined): Promise<{ models: ModelInfo[]; error: string | null }> {
  const openrouter = isOpenRouterUrl(baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODELS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) return { models: [], error: `${openrouter ? "OpenRouter" : "API"} HTTP ${res.status}` };
    const json = (await res.json()) as { data?: RawModel[] };
    const models: ModelInfo[] = (json.data ?? [])
      .filter((m) => m && typeof m.id === "string")
      // Wpisy z prefiksem "~" to aliasy (np. "~deepseek/deepseek-v4-flash-latest"),
      // których API nie przyjmuje jako ID modelu — nie pokazujemy ich na liście.
      .filter((m) => !(m.id as string).startsWith("~"))
      // OpenRouter: tylko modele z tool-callingiem; inne API zwykle nie raportują supported_parameters.
      .filter((m) => !openrouter || (Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools")))
      .map((m) => ({
        id: m.id as string,
        name: typeof m.name === "string" && m.name ? m.name : (m.id as string),
        contextLength: typeof m.context_length === "number" ? m.context_length : null,
        promptPer1M: pricePer1M(m.pricing?.prompt),
        completionPer1M: pricePer1M(m.pricing?.completion),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    return { models, error: null };
  } catch (e) {
    const msg =
      (e as Error)?.name === "AbortError" ? "Przekroczono czas pobierania listy modeli (10 s)" : String((e as Error)?.message || e);
    return { models: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Lista modeli z cache (1 h; przy błędzie negatywny cache 60 s). refresh=true omija cache. */
export async function getModels(refresh = false): Promise<ModelsResult> {
  const baseUrl = getAssistantConfig().values.baseUrl;
  const now = Date.now();
  if (!refresh && modelsCache && modelsCache.baseUrl === baseUrl && modelsCache.expiresAt > now) {
    const { expiresAt: _e, baseUrl: _b, ...rest } = modelsCache;
    return rest;
  }
  const { models, error } = await fetchModels(baseUrl, resolveApiKey().key);
  const source = isOpenRouterUrl(baseUrl) ? "openrouter" : "custom";
  const fetchedAt = new Date().toISOString();
  if (error && modelsCache && modelsCache.baseUrl === baseUrl && modelsCache.models.length > 0) {
    // Zachowaj poprzednią dobrą listę, ale nie odpytuj ponownie przez 60 s.
    modelsCache = { ...modelsCache, error, expiresAt: now + MODELS_NEG_TTL_MS };
  } else {
    modelsCache = { models, fetchedAt, error, source, baseUrl, expiresAt: now + (error ? MODELS_NEG_TTL_MS : MODELS_TTL_MS) };
  }
  const { expiresAt: _e, baseUrl: _b, ...rest } = modelsCache;
  return rest;
}

app.get("/models", async (c) => {
  const refresh = ["1", "true"].includes((c.req.query("refresh") ?? "").toLowerCase());
  return c.json({ success: true, data: await getModels(refresh) });
});

// ---------------------------------------------------------------------------
// Test połączenia
// ---------------------------------------------------------------------------

const TEST_TIMEOUT_MS = 30_000;

/**
 * Adres API do testu: https:// (http tylko dla localhost), bez hostów prywatnych — panel admina
 * nie może posłużyć do sondowania sieci wewnętrznej ani do wysłania klucza z bazy na obcy host.
 */
export function checkBaseUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Adres API: nieprawidłowy URL" };
  }
  const host = u.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) return { ok: false, error: "Adres API: wymagane https:// (http tylko dla localhost)" };
  if (
    !isLocal &&
    (/^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^127\./.test(host) ||
      /^0\./.test(host) ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      !host.includes("."))
  ) {
    return { ok: false, error: "Adres API: hosty sieci prywatnej nie są dozwolone" };
  }
  return { ok: true, url: u.toString().replace(/\/+$/, "") };
}

app.post("/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { model?: unknown; apiKey?: unknown; baseUrl?: unknown };
  const cfg = getAssistantConfig().values;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 200) : cfg.model;
  const overrideKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const rawBase = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const baseOverridden = Boolean(rawBase) && rawBase.replace(/\/+$/, "") !== cfg.baseUrl.replace(/\/+$/, "");
  let baseUrl = cfg.baseUrl;
  if (baseOverridden) {
    const chk = checkBaseUrl(rawBase);
    if (!chk.ok) return c.json({ success: false, error: chk.error }, 400);
    // Klucz z bazy NIGDY nie idzie na inny host niż skonfigurowany — test obcego adresu wymaga jawnego klucza.
    if (!overrideKey) return c.json({ success: false, error: "Test innego adresu API wymaga podania klucza API w formularzu" }, 400);
    baseUrl = chk.url;
  }
  const key = overrideKey || resolveApiKey().key;
  if (model.startsWith("~"))
    return c.json({ success: true, data: { ok: false, latencyMs: 0, error: "Wpis z \"~\" to alias z listy OpenRouter, nie ID modelu — wybierz np. " + model.slice(1).replace(/-latest$/, ""), model } });
  if (!MODEL_RE.test(model)) return c.json({ success: true, data: { ok: false, latencyMs: 0, error: "Nieprawidłowy identyfikator modelu (oczekiwany format dostawca/model)", model } });
  if (!key) return c.json({ success: true, data: { ok: false, latencyMs: 0, error: "Brak klucza API", model } });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const result = await generateText({
      model: makeChatClient(key, baseUrl).chatModel(model),
      prompt: "Odpowiedz jednym słowem: OK",
      maxOutputTokens: 20,
      abortSignal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;
    return c.json({ success: true, data: { ok: true, latencyMs, reply: result.text.trim(), model } });
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    const err = ctrl.signal.aborted
      ? { code: "timeout", message: `Przekroczono czas testu (${TEST_TIMEOUT_MS / 1000} s)` }
      : classifyError(e);
    return c.json({ success: true, data: { ok: false, latencyMs, error: err.message, code: err.code, model } });
  } finally {
    clearTimeout(timer);
  }
});

// ---------------------------------------------------------------------------
// Podgląd promptu
// ---------------------------------------------------------------------------

app.get("/prompt-preview", (c) => {
  const user = getUser(c);
  const cfg = getAssistantConfig();
  const prompt = assembleSystemPrompt({
    ...localToday(),
    user: { displayName: user.displayName || user.email },
    technicians: listActiveTechnicians(),
    types: CALENDAR_EVENT_TYPES,
    statuses: CALENDAR_EVENT_STATUSES,
    rules: cfg.values,
  });
  return c.json({ success: true, data: { prompt, tokensEstimate: estimateTokens(prompt), tools: cfg.enabledTools } });
});

// ---------------------------------------------------------------------------
// Zużycie (assistant_usage)
// ---------------------------------------------------------------------------

const USAGE_DAYS = [7, 30, 90] as const;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whitelist 7 | 30 | 90; wszystko inne → 30. */
function parseDays(raw: string | undefined): number {
  const n = Number(raw);
  return (USAGE_DAYS as readonly number[]).includes(n) ? n : 30;
}

/** Początek zakresu (UTC, jak created_at z datetime('now')): dziś i days-1 dni wstecz. */
function sinceOf(days: number): { sinceDate: Date; since: string } {
  const sinceDate = new Date(Date.now() - (days - 1) * 86_400_000);
  return { sinceDate, since: `${isoDate(sinceDate)} 00:00:00` };
}

/**
 * Ceny WYŁĄCZNIE z cache modeli (bez fetchu): /usage i /turns mają odpowiadać natychmiast
 * i nie wisieć 10 s na OpenRouterze. Cache buduje GET /models (panel woła go przy otwarciu).
 */
function priceMap(): Map<string, ModelInfo> {
  const models = modelsCache?.models ?? [];
  return new Map(models.map((m) => [m.id, m]));
}

function costOf(p: ModelInfo | undefined, promptTokens: number, completionTokens: number): number | null {
  if (!p || (p.promptPer1M === null && p.completionPer1M === null)) return null;
  const c = ((p.promptPer1M ?? 0) * promptTokens + (p.completionPer1M ?? 0) * completionTokens) / 1e6;
  return Math.round(c * 1e6) / 1e6;
}

app.get("/usage", (c) => {
  const days = parseDays(c.req.query("days"));
  const u = schema.assistantUsage;
  const { sinceDate, since } = sinceOf(days);
  const cond = gte(u.createdAt, since);

  const totals = db
    .select({
      turns: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${u.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${u.completionTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${u.reasoningTokens}), 0)`,
      toolCalls: sql<number>`coalesce(sum(${u.toolCalls}), 0)`,
      avgMs: sql<number>`coalesce(avg(${u.ms}), 0)`,
    })
    .from(u)
    .where(cond)
    .get()!;

  const byModelRows = db
    .select({
      model: u.model,
      turns: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${u.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${u.completionTokens}), 0)`,
    })
    .from(u)
    .where(cond)
    .groupBy(u.model)
    .orderBy(desc(sql`count(*)`))
    .all();

  const topUsers = db
    .select({
      userId: u.userId,
      displayName: schema.users.displayName,
      email: schema.users.email,
      turns: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${u.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${u.completionTokens}), 0)`,
    })
    .from(u)
    .leftJoin(schema.users, eq(schema.users.id, u.userId))
    .where(cond)
    .groupBy(u.userId)
    .orderBy(desc(sql`count(*)`))
    .limit(10)
    .all()
    .map((r) => ({
      userId: r.userId,
      label: (r.displayName || "").trim() || r.email || "—",
      turns: r.turns,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    }));

  const dailyRows = db
    .select({
      date: sql<string>`date(${u.createdAt})`,
      turns: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${u.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${u.completionTokens}), 0)`,
    })
    .from(u)
    .where(cond)
    .groupBy(sql`date(${u.createdAt})`)
    .all();
  const dailyMap = new Map(dailyRows.map((r) => [r.date, r]));
  const daily: { date: string; turns: number; promptTokens: number; completionTokens: number }[] = [];
  for (let i = 0; i < days; i++) {
    const date = isoDate(new Date(sinceDate.getTime() + i * 86_400_000));
    const r = dailyMap.get(date);
    daily.push({ date, turns: r?.turns ?? 0, promptTokens: r?.promptTokens ?? 0, completionTokens: r?.completionTokens ?? 0 });
  }

  // Koszt: ceny z cache modeli (buduje cache, jeśli pusty; błąd sieci → brak cen).
  const prices = priceMap();
  let knownTurns = 0;
  let totalCost = 0;
  let anyPriced = false;
  const byModel = byModelRows.map((r) => {
    const costUsd = costOf(prices.get(r.model), r.promptTokens, r.completionTokens);
    if (costUsd !== null) {
      knownTurns += r.turns;
      totalCost += costUsd;
      anyPriced = true;
    }
    return { model: r.model, turns: r.turns, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd };
  });

  return c.json({
    success: true,
    data: {
      days,
      turns: totals.turns,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      reasoningTokens: totals.reasoningTokens,
      toolCalls: totals.toolCalls,
      avgMs: Math.round(totals.avgMs),
      estimatedCostUsd: anyPriced ? Math.round(totalCost * 1e6) / 1e6 : null,
      costCoverage: totals.turns > 0 ? Math.round((knownTurns / totals.turns) * 1000) / 1000 : 1,
      byModel,
      topUsers,
      daily,
    },
  });
});

/** Ostatnie tury (paginacja) — do tabeli w panelu. */
app.get("/turns", (c) => {
  const days = parseDays(c.req.query("days"));
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(c.req.query("pageSize") ?? 25)) || 25));
  const u = schema.assistantUsage;
  const { since } = sinceOf(days);
  const cond = gte(u.createdAt, since);

  const total = db.select({ n: sql<number>`count(*)` }).from(u).where(cond).get()?.n ?? 0;
  const rows = db
    .select({
      id: u.id,
      createdAt: u.createdAt,
      userId: u.userId,
      displayName: schema.users.displayName,
      email: schema.users.email,
      chatId: u.chatId,
      chatTitle: schema.assistantChats.title,
      model: u.model,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      reasoningTokens: u.reasoningTokens,
      ms: u.ms,
      steps: u.steps,
      toolCalls: u.toolCalls,
      finishReason: u.finishReason,
    })
    .from(u)
    .leftJoin(schema.users, eq(schema.users.id, u.userId))
    .leftJoin(schema.assistantChats, eq(schema.assistantChats.id, u.chatId))
    .where(cond)
    .orderBy(desc(u.createdAt), desc(u.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const prices = priceMap();
  const items = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    userId: r.userId,
    userLabel: (r.displayName || "").trim() || r.email || "—",
    chatId: r.chatId,
    chatTitle: r.chatTitle ?? null,
    model: r.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    reasoningTokens: r.reasoningTokens,
    costUsd: costOf(prices.get(r.model), r.promptTokens, r.completionTokens),
    ms: r.ms,
    steps: r.steps,
    toolCalls: r.toolCalls,
    finishReason: r.finishReason,
  }));
  return c.json({ success: true, data: { items, total, page, pageSize } });
});

/** Usuwa WSZYSTKIE czaty (kaskada wiadomości; assistant_usage zostaje z chat_id = NULL). */
app.delete("/chats", (c) => {
  const user = getUser(c);
  const deleted = db.transaction((tx) => {
    const n = tx.select({ n: sql<number>`count(*)` }).from(schema.assistantChats).get()?.n ?? 0;
    tx.delete(schema.assistantChats).run();
    logActivity(tx, {
      entityType: "assistant_chats",
      entityId: 0,
      user,
      action: "deleted",
      summary: `Wyczyszczono wszystkie czaty asystenta (${n})`,
    });
    return n;
  });
  return c.json({ success: true, data: { deleted } });
});


export default app;
