/**
 * Provider LLM asystenta (OpenRouter albo dowolny endpoint zgodny z API OpenAI) — klucz i klient.
 * Okrojona kopia roleplay/src/lib/roleplay/{config,client}.ts: jeden provider, bez configu per user.
 *
 * Precedencja KAŻDEGO ustawienia: baza (app_settings, panel admina /admin/asystent) → env → domyślne
 * (patrz src/lib/ai/assistantConfig.ts). Klucz: DB `assistant.api_key` → env OPENROUTER_API_KEY
 * → plik OPENROUTER_KEY_FILE → ./data/openrouter.key (data/ to volume na Dokploy).
 */
import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { streamText } from "ai";
import { ASSISTANT_API_KEY_SETTING, getSetting } from "../settings.js";
import { ASSISTANT_DEFAULTS, getAssistantConfig, isOpenRouterUrl, resolveField, type AssistantConfig } from "./assistantConfig.js";

/** Typ providerOptions z ai@7 — nieeksportowany wprost, więc wyprowadzony z streamText. */
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

export const OPENROUTER = {
  label: "OpenRouter",
  baseURL: ASSISTANT_DEFAULTS.baseUrl,
  envKey: "OPENROUTER_API_KEY",
  keyFile: process.env.OPENROUTER_KEY_FILE || path.resolve("./data/openrouter.key"),
};

export type KeySource = "db" | "env" | "file" | null;

/** Ścieżka pliku z kluczem (do panelu admina — bez ujawniania zawartości). */
export function getKeyFilePath(): string {
  return OPENROUTER.keyFile;
}

/** Klucz + skąd pochodzi (do statusu w panelu admina; bez ujawniania wartości). */
export function resolveApiKey(): { key: string | undefined; source: KeySource } {
  const fromDb = getSetting(ASSISTANT_API_KEY_SETTING)?.trim();
  if (fromDb) return { key: fromDb, source: "db" };
  const fromEnv = process.env[OPENROUTER.envKey]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  try {
    const fromFile = fs.readFileSync(OPENROUTER.keyFile, "utf8").trim();
    if (fromFile) return { key: fromFile, source: "file" };
  } catch {
    /* brak pliku — nieskonfigurowane */
  }
  return { key: undefined, source: null };
}

/**
 * Klient czatu. name="openrouter" — pod tym kluczem SDK czyta providerOptions
 * (dla innych endpointów providerOptions.openrouter jest po prostu ignorowane).
 */
export function makeChatClient(apiKey: string, baseURL: string = resolveField("baseUrl").value) {
  return createOpenAICompatible({
    name: "openrouter",
    baseURL,
    apiKey,
    includeUsage: true,
    headers: {
      "HTTP-Referer": "https://alfa.local/calendar",
      "X-Title": "Alfa App",
    },
  });
}

/**
 * providerOptions dla OpenRoutera: rozliczanie kosztów w ramce usage (usage.include),
 * routing dostawców (provider.sort: latency domyślnie — tury z narzędziami robią 3–4
 * wywołania, więc wolny dostawca boli podwójnie) i wymuszone rozumowanie (reasoning.effort,
 * wzór: roleplay buildProviderOptions). Dla endpointów spoza OpenRoutera: pusty obiekt.
 */
export function buildProviderOptions(cfg: AssistantConfig = getAssistantConfig()): ProviderOptions {
  if (!isOpenRouterUrl(cfg.values.baseUrl)) return {};
  const sort = cfg.values.providerSort;
  const effort = cfg.values.reasoningEffort;
  return {
    openrouter: {
      usage: { include: true },
      ...(sort ? { provider: { sort } } : {}),
      ...(effort ? { reasoning: { effort, exclude: false } } : {}),
    },
  };
}
