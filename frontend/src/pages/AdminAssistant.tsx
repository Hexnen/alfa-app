import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  adminAssistantApi,
  type AdminAssistantModels,
  type AdminAssistantPromptPreview,
  type AdminAssistantSettings,
  type AdminAssistantSettingsUpdate,
  type AdminAssistantTestResult,
  type AssistantSettingsField,
} from "@/lib/api";
import { ErrorBox } from "@/components/admin-assistant/shared";
import { deepEq, errMsg, SECTION_FIELDS, SECTIONS, useAdvancedMode, useFlash, type Draft, type DraftValue, type FormApi, type NumField } from "@/components/admin-assistant/helpers";
import { validateDraft } from "@/components/admin-assistant/validation";
import { StatusSection } from "@/components/admin-assistant/StatusSection";
import { ProviderSection } from "@/components/admin-assistant/ProviderSection";
import { GenerationSection } from "@/components/admin-assistant/GenerationSection";
import { PersonaSection } from "@/components/admin-assistant/PersonaSection";
import { RulesSection } from "@/components/admin-assistant/RulesSection";
import { ToolsSection } from "@/components/admin-assistant/ToolsSection";
import { AccessSection } from "@/components/admin-assistant/AccessSection";
import { UsageSection } from "@/components/admin-assistant/UsageSection";
import { EnvInfoCard } from "@/components/admin-assistant/EnvInfoCard";

/**
 * Panel admina asystenta AI — cienki orkiestrator: stan formularza (szkic,
 * walidacja, zapis, reset sekcji) i układ. Sekcje: components/admin-assistant/.
 */
export function AdminAssistant() {
  const [settings, setSettings] = useState<AdminAssistantSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, flash] = useFlash();
  const [advanced, setAdvanced] = useAdvancedMode();

  const [models, setModels] = useState<AdminAssistantModels | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdminAssistantTestResult | null>(null);

  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState<AdminAssistantPromptPreview | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  const [confirmReset, setConfirmReset] = useState<string | null>(null);

  // --- ładowanie ---------------------------------------------------------
  const loadSettings = useCallback(async () => {
    const s = await adminAssistantApi.settings();
    setSettings(s);
    setDraft({});
    setApiKeyInput("");
  }, []);

  const loadModels = useCallback(async (refresh?: boolean) => {
    setModelsLoading(true);
    try {
      setModels(await adminAssistantApi.models(refresh));
    } catch (e) {
      setModels({ models: [], fetchedAt: "", error: errMsg(e, "Nie udało się pobrać listy modeli") });
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const loadPrompt = useCallback(async () => {
    setPromptLoading(true);
    setPromptError(null);
    try {
      setPrompt(await adminAssistantApi.promptPreview());
    } catch (e) {
      setPromptError(errMsg(e, "Nie udało się pobrać podglądu promptu"));
    } finally {
      setPromptLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings().catch((e) => setLoadError(errMsg(e, "Nie udało się wczytać ustawień")));
    void loadModels();
  }, [loadSettings, loadModels]);

  useEffect(() => {
    if (promptOpen && !prompt && !promptLoading) void loadPrompt();
  }, [promptOpen, prompt, promptLoading, loadPrompt]);

  // --- szkic / dirty tracking --------------------------------------------
  const values = settings?.values;
  const defaults = settings?.defaults;
  const sources = settings?.sources;

  const val = useCallback(
    <K extends AssistantSettingsField>(k: K): DraftValue<K> => (k in draft ? draft[k] : values?.[k]) as DraftValue<K>,
    [draft, values]
  );
  const setField = useCallback(
    <K extends AssistantSettingsField>(k: K, v: DraftValue<K>) => {
      setDraft((d) => {
        const next = { ...d };
        if (values && deepEq(values[k], v)) delete next[k];
        else (next as Record<K, DraftValue<K>>)[k] = v;
        return next;
      });
    },
    [values]
  );
  const isDirty = useCallback((k: AssistantSettingsField) => k in draft, [draft]);
  const dirtyCount = Object.keys(draft).length + (apiKeyInput ? 1 : 0);

  const numVal = useCallback(
    (k: NumField) => {
      const v = val(k);
      return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
    },
    [val]
  );
  const setNum = useCallback((k: NumField, raw: string) => setField(k, raw === "" ? null : Number(raw)), [setField]);

  const effectiveBaseUrl = val("baseUrl") || defaults?.baseUrl || "";
  const isOpenRouter = /openrouter\.ai/i.test(effectiveBaseUrl);

  const errors = useMemo(() => (values ? validateDraft(draft, values, isOpenRouter) : {}), [draft, values, isOpenRouter]);
  const hasErrors = Object.keys(errors).length > 0;

  // Ostrzeżenie przeglądarki przy zamknięciu/odświeżeniu z niezapisanymi zmianami
  // (celowo bez blokowania nawigacji SPA — sticky pasek zapisu jest widoczny).
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  // --- akcje --------------------------------------------------------------
  const notify = (msg: string) => {
    setError(null);
    flash(msg);
  };

  const save = async () => {
    if (!settings || dirtyCount === 0) return;
    if (hasErrors) {
      setError("Popraw błędy w formularzu przed zapisem.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: AdminAssistantSettingsUpdate = { ...draft };
      if (apiKeyInput) body.apiKey = apiKeyInput;
      const s = await adminAssistantApi.updateSettings(body);
      setSettings(s);
      setDraft({});
      setApiKeyInput("");
      setPrompt(null);
      notify("Ustawienia zapisane.");
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać ustawień"));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft({});
    setApiKeyInput("");
    setError(null);
  };

  const resetSection = async (sectionId: string) => {
    const fields = SECTION_FIELDS[sectionId] || [];
    setSaving(true);
    setError(null);
    try {
      const body: AdminAssistantSettingsUpdate = {};
      for (const f of fields) body[f] = null;
      const s = await adminAssistantApi.updateSettings(body);
      setSettings(s);
      setDraft((d) => {
        const next = { ...d };
        for (const f of fields) delete next[f];
        return next;
      });
      setPrompt(null);
      notify("Przywrócono wartości domyślne sekcji.");
    } catch (e) {
      setError(errMsg(e, "Nie udało się przywrócić domyślnych"));
    } finally {
      setSaving(false);
      setConfirmReset(null);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    setError(null);
    try {
      const s = await adminAssistantApi.updateSettings({ apiKey: null });
      setSettings(s);
      setApiKeyInput("");
      notify("Klucz usunięty z bazy — używany będzie klucz z env/pliku (jeśli jest).");
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć klucza"));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: { model?: string; apiKey?: string; baseUrl?: string } = { model: (val("model") || "").trim() || undefined };
      if (apiKeyInput) body.apiKey = apiKeyInput;
      const bu = (val("baseUrl") || "").trim();
      if (bu) body.baseUrl = bu;
      setTestResult(await adminAssistantApi.test(body));
    } catch (e) {
      setTestResult({ ok: false, latencyMs: 0, model: val("model") || "", error: errMsg(e, "Błąd testu") });
    } finally {
      setTesting(false);
    }
  };

  // --- render -------------------------------------------------------------
  if (loadError) {
    return (
      <div className="space-y-3">
        <ErrorBox>{loadError}</ErrorBox>
        <Button variant="outline" onClick={() => loadSettings().then(() => setLoadError(null)).catch((e) => setLoadError(errMsg(e, "Błąd")))}>
          <RefreshCw className="mr-1 h-4 w-4" /> Spróbuj ponownie
        </Button>
      </div>
    );
  }
  if (!settings || !values || !defaults || !sources) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytywanie ustawień…
        </div>
      </div>
    );
  }

  const form: FormApi = { settings, values, defaults, sources, errors, saving, val, setField, isDirty, numVal, setNum };
  const resetFor = (id: string) => () => setConfirmReset(id);

  return (
    <div className="space-y-3 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Sekcje ustawień" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="shrink-0 rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {s.label}
            </a>
          ))}
        </nav>
        <Button
          type="button"
          variant={advanced ? "secondary" : "outline"}
          size="sm"
          aria-pressed={advanced}
          onClick={() => setAdvanced(!advanced)}
          title={advanced ? "Ukryj rzadko zmieniane ustawienia" : "Pokaż rzadko zmieniane ustawienia"}
        >
          <SlidersHorizontal className="mr-1 h-4 w-4" /> {advanced ? "Tryb: zaawansowany" : "Tryb: podstawowy"}
        </Button>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}
      {notice && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400" role="status">
          {notice}
        </div>
      )}

      <StatusSection form={form} effectiveBaseUrl={effectiveBaseUrl} testing={testing} testResult={testResult} onTest={() => void runTest()} />

      <ProviderSection
        form={form}
        apiKeyInput={apiKeyInput}
        onApiKeyInput={setApiKeyInput}
        onRemoveKey={removeKey}
        models={models}
        modelsLoading={modelsLoading}
        onRefreshModels={() => void loadModels(true)}
        isOpenRouter={isOpenRouter}
        advanced={advanced}
        onToggleAdvanced={setAdvanced}
        onReset={resetFor("dostawca")}
      />

      <GenerationSection form={form} advanced={advanced} onToggleAdvanced={setAdvanced} onReset={resetFor("generowanie")} />

      <PersonaSection
        form={form}
        dirtyCount={dirtyCount}
        prompt={prompt}
        promptOpen={promptOpen}
        promptLoading={promptLoading}
        promptError={promptError}
        onTogglePrompt={() => setPromptOpen((o) => !o)}
        onRefreshPrompt={() => {
          setPromptOpen(true);
          void loadPrompt();
        }}
        onReset={resetFor("prompt")}
      />

      <RulesSection form={form} advanced={advanced} onToggleAdvanced={setAdvanced} onReset={resetFor("reguly")} />

      <ToolsSection form={form} onReset={resetFor("narzedzia")} />

      <AccessSection form={form} advanced={advanced} onToggleAdvanced={setAdvanced} onReset={resetFor("dostep")} />

      <UsageSection onNotice={notify} onError={setError} />

      <EnvInfoCard env={settings.env} />

      {/* Sticky pasek zapisu */}
      {dirtyCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur lg:left-64" role="region" aria-label="Niezapisane zmiany">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="text-sm">
              <span className="font-medium">Niezapisane zmiany</span>{" "}
              <span className="text-muted-foreground">
                ({dirtyCount} {dirtyCount === 1 ? "pole" : dirtyCount < 5 ? "pola" : "pól"})
              </span>
              {hasErrors && <span className="ml-2 text-destructive">— popraw błędy, aby zapisać</span>}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={discard} disabled={saving}>
                Odrzuć
              </Button>
              <Button type="button" onClick={() => void save()} disabled={saving || hasErrors}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} Zapisz
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={confirmReset != null} onOpenChange={(o) => !o && setConfirmReset(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Przywrócić domyślne w sekcji „{SECTIONS.find((s) => s.id === confirmReset)?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Wartości tej sekcji zostaną usunięte z bazy. Obowiązywać będą zmienne środowiskowe (jeśli ustawione) lub wartości domyślne. Niezapisane zmiany w tej sekcji zostaną odrzucone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmReset && void resetSection(confirmReset)}>Przywróć</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

