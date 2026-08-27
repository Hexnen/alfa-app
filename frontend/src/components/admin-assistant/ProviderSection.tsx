import { useState } from "react";
import { Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import type { AdminAssistantModels, AssistantSettingsValues } from "@/lib/api";
import { ModelPicker } from "./ModelPicker";
import { AdvancedBlock, Field, SectionCard, Switch } from "./shared";
import { countFieldState, keySourceLabel, selectClass, type FormApi } from "./helpers";

const PROVIDER_SORT_LABEL: Record<string, string> = {
  latency: "Najniższe opóźnienie",
  price: "Najniższa cena",
  throughput: "Największa przepustowość",
  "": "Bez sortowania",
};

const ADVANCED_FIELDS = ["providerSort"] as const;

export function ProviderSection({
  form,
  apiKeyInput,
  onApiKeyInput,
  onRemoveKey,
  models,
  modelsLoading,
  onRefreshModels,
  isOpenRouter,
  advanced,
  onToggleAdvanced,
  onReset,
}: {
  form: FormApi;
  apiKeyInput: string;
  onApiKeyInput: (v: string) => void;
  onRemoveKey: () => Promise<void>;
  models: AdminAssistantModels | null;
  modelsLoading: boolean;
  onRefreshModels: () => void;
  isOpenRouter: boolean;
  advanced: boolean;
  onToggleAdvanced: (v: boolean) => void;
  onReset: () => void;
}) {
  const { settings, sources, defaults, errors, saving, val, setField, isDirty } = form;
  const apiKey = settings.apiKey;
  const [showKey, setShowKey] = useState(false);
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false);

  return (
    <SectionCard
      id="dostawca"
      title="Dostawca i model"
      description="Skąd asystent bierze odpowiedzi: adres API, klucz i model. Zmiany działają od następnej wiadomości."
      onReset={onReset}
      resetDisabled={saving}
    >
      <Field
        id="f-enabled"
        label="Asystent włączony"
        source={sources.enabled}
        dirty={isDirty("enabled")}
        inline
        description="Po wyłączeniu przycisk asystenta znika z kalendarza u wszystkich, a trwające czaty nie dostaną odpowiedzi."
      >
        <Switch id="f-enabled" label="Asystent włączony" checked={!!val("enabled")} onChange={(v) => setField("enabled", v)} />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="f-baseUrl"
          label="Adres API (base URL)"
          source={sources.baseUrl}
          dirty={isDirty("baseUrl")}
          error={errors.baseUrl}
          description="Puste = OpenRouter. Po wpisaniu innego adresu (zgodnego z API OpenAI) lista modeli i routing dostawców przestaną być dostępne — model wpiszesz ręcznie."
        >
          <Input id="f-baseUrl" value={val("baseUrl") ?? ""} placeholder={defaults.baseUrl} onChange={(e) => setField("baseUrl", e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field
          id="f-providerLabel"
          label="Nazwa dostawcy"
          source={sources.providerLabel}
          dirty={isDirty("providerLabel")}
          error={errors.providerLabel}
          description="Tylko etykieta: pojawia się w karcie Stan i w komunikatach o błędach. Nie wpływa na połączenie."
        >
          <Input id="f-providerLabel" value={val("providerLabel") ?? ""} placeholder={defaults.providerLabel} maxLength={40} onChange={(e) => setField("providerLabel", e.target.value)} />
        </Field>
      </div>

      <Field
        id="f-apiKey"
        label="Klucz API"
        dirty={!!apiKeyInput}
        description={
          <>
            Wpisz tylko, gdy chcesz podmienić klucz — puste pole niczego nie zmienia.
            {apiKey.source !== "db" && apiKey.set && " Klucz zapisany tutaj będzie miał pierwszeństwo przed kluczem z env/pliku."}
            {!apiKey.set && " Bez klucza asystent nie odpowie na żadną wiadomość."}
          </>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Input
              id="f-apiKey"
              type={showKey ? "text" : "password"}
              value={apiKeyInput}
              autoComplete="new-password"
              placeholder="sk-or-v1-…"
              onChange={(e) => onApiKeyInput(e.target.value)}
              className="pr-10 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              aria-label={showKey ? "Ukryj klucz" : "Pokaż klucz"}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {apiKey.source === "db" && (
            <Button type="button" variant="outline" onClick={() => setConfirmRemoveKey(true)} disabled={saving} className="shrink-0">
              <Trash2 className="mr-1 h-4 w-4" /> Usuń klucz z bazy
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="assistant-saved-key">
          Zapisany klucz: <span className="font-mono">{apiKey.masked ?? "brak"}</span>
          {apiKey.set && <span> ({keySourceLabel(apiKey.source)})</span>}
        </p>
      </Field>

      <Field
        id="assistant-model"
        label="Model"
        source={sources.model}
        dirty={isDirty("model")}
        error={errors.model}
        description={
          <>
            Od tego zależy jakość odpowiedzi, szybkość i koszt każdej tury. Domyślnie <span className="font-mono">{defaults.model}</span>.{" "}
            {isOpenRouter
              ? "Wybierz z listy (pokazujemy tylko modele obsługujące narzędzia; gwiazdka = polecany) lub wpisz ID ręcznie."
              : "Dla własnego endpointu wpisz ID modelu ręcznie."}
            {models?.error && (
              <span className="mt-1 block text-amber-700 dark:text-amber-300">Nie udało się pobrać listy: {models.error}</span>
            )}
            {models && !models.error && models.models.length > 0 && (
              <span className="ml-1 text-muted-foreground">({models.models.length} modeli{models.source === "custom" ? ", własny endpoint" : ""})</span>
            )}
          </>
        }
      >
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            {isOpenRouter ? (
              <ModelPicker value={val("model") ?? ""} onChange={(v) => setField("model", v)} models={models} placeholder={defaults.model} />
            ) : (
              <Input id="assistant-model" value={val("model") ?? ""} placeholder={defaults.model} onChange={(e) => setField("model", e.target.value)} className="font-mono text-xs" />
            )}
          </div>
          <Button type="button" variant="outline" size="icon" onClick={onRefreshModels} disabled={modelsLoading} aria-label="Odśwież listę modeli" title="Odśwież listę modeli">
            <RefreshCw className={cn("h-4 w-4", modelsLoading && "animate-spin")} />
          </Button>
        </div>
      </Field>

      {isOpenRouter && (
        <AdvancedBlock id="adv-dostawca" open={advanced} onToggle={onToggleAdvanced} {...countFieldState(form, [...ADVANCED_FIELDS])}>
          <Field
            id="f-providerSort"
            label="Routing dostawców (OpenRouter)"
            source={sources.providerSort}
            dirty={isDirty("providerSort")}
            description="Ten sam model bywa hostowany przez kilku dostawców — tu decydujesz, czy asystent ma odpowiadać szybciej, taniej, czy stabilniej pod obciążeniem. Bez wpływu na własne endpointy."
          >
            <select id="f-providerSort" className={selectClass} value={val("providerSort") ?? ""} onChange={(e) => setField("providerSort", e.target.value as AssistantSettingsValues["providerSort"])}>
              {(settings.meta.providerSorts.length ? settings.meta.providerSorts : (["latency", "price", "throughput", ""] as const)).map((s) => (
                <option key={s || "none"} value={s}>
                  {PROVIDER_SORT_LABEL[s] ?? s}
                </option>
              ))}
            </select>
          </Field>
        </AdvancedBlock>
      )}

      <AlertDialog open={confirmRemoveKey} onOpenChange={setConfirmRemoveKey}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć klucz API z bazy?</AlertDialogTitle>
            <AlertDialogDescription>
              Asystent wróci do klucza z <span className="font-mono">OPENROUTER_API_KEY</span> lub pliku. Jeśli żaden nie istnieje, asystent przestanie działać.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void onRemoveKey().finally(() => setConfirmRemoveKey(false));
              }}
            >
              Usuń klucz
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
