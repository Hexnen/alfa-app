import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AdminAssistantPromptPreview } from "@/lib/api";
import { Field, SectionCard } from "./shared";
import { fmtInt, type FormApi } from "./helpers";

export function PersonaSection({
  form,
  dirtyCount,
  prompt,
  promptOpen,
  promptLoading,
  promptError,
  onTogglePrompt,
  onRefreshPrompt,
  onReset,
}: {
  form: FormApi;
  dirtyCount: number;
  prompt: AdminAssistantPromptPreview | null;
  promptOpen: boolean;
  promptLoading: boolean;
  promptError: string | null;
  onTogglePrompt: () => void;
  onRefreshPrompt: () => void;
  onReset: () => void;
}) {
  const { sources, defaults, errors, saving, val, setField, isDirty } = form;
  const suggestions = val("suggestions") || [];

  return (
    <SectionCard id="prompt" title="Prompt i osobowość" description="Jak asystent się przedstawia użytkownikom i jakie stałe wskazówki dostaje od administratora." onReset={onReset} resetDisabled={saving}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="f-personaName"
          label="Nazwa asystenta"
          source={sources.personaName}
          dirty={isDirty("personaName")}
          error={errors.personaName}
          description="Tak asystent będzie się nazywał w nagłówku panelu i tak będzie mówił o sobie (maks. 40 znaków)."
        >
          <Input id="f-personaName" value={val("personaName") ?? ""} placeholder={defaults.personaName} maxLength={40} onChange={(e) => setField("personaName", e.target.value)} />
        </Field>
        <Field
          id="f-greeting"
          label="Powitanie"
          source={sources.greeting}
          dirty={isDirty("greeting")}
          error={errors.greeting}
          description="Pierwszy tekst, jaki użytkownik zobaczy w pustym czacie (maks. 500 znaków). Puste = domyślny tekst. Model go nie widzi."
        >
          <Textarea id="f-greeting" rows={3} value={val("greeting") ?? ""} placeholder={defaults.greeting || "Opisz wydarzenie po polsku — sprawdzę obiekt, techników i konflikty…"} maxLength={500} onChange={(e) => setField("greeting", e.target.value)} />
        </Field>
      </div>

      <Field
        id="f-suggestions-0"
        label="Sugestie startowe"
        source={sources.suggestions}
        dirty={isDirty("suggestions")}
        error={errors.suggestions}
        description="Klikalne podpowiedzi w pustym czacie — użytkownik wybiera jedną zamiast pisać od zera (3–5 pozycji, każda maks. 120 znaków)."
      >
        <div className="space-y-2">
          {suggestions.map((s, i) => (
            <div key={i} className="flex gap-2">
              <Input
                id={`f-suggestions-${i}`}
                value={s}
                maxLength={120}
                placeholder={defaults.suggestions[i] ?? "np. Co ma Wojtek w przyszłym tygodniu?"}
                aria-label={`Sugestia ${i + 1}`}
                onChange={(e) => setField("suggestions", suggestions.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <Button type="button" variant="ghost" size="icon" aria-label={`Usuń sugestię ${i + 1}`} disabled={suggestions.length <= 3} onClick={() => setField("suggestions", suggestions.filter((_, j) => j !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={suggestions.length >= 5} onClick={() => setField("suggestions", [...suggestions, ""])}>
            <Plus className="mr-1 h-4 w-4" /> Dodaj sugestię
          </Button>
        </div>
      </Field>

      <Field
        id="f-customInstructions"
        label="Dodatkowe instrukcje administratora"
        source={sources.customInstructions}
        dirty={isDirty("customInstructions")}
        error={errors.customInstructions}
        description={`Stałe zasady, których asystent ma się trzymać w każdej rozmowie (np. preferowane godziny, czego nie planować). Dopisywane do promptu po zapisie. Użyte: ${(val("customInstructions") ?? "").length}/8000.`}
      >
        <Textarea id="f-customInstructions" rows={6} value={val("customInstructions") ?? ""} placeholder="np. Zawsze proponuj serwisy w godzinach 8–14. Nie planuj wizji w piątki." maxLength={8000} onChange={(e) => setField("customInstructions", e.target.value)} className="font-mono text-xs" />
      </Field>

      <div className="rounded-md border">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-accent/50"
          onClick={onTogglePrompt}
          aria-expanded={promptOpen}
          aria-controls="prompt-preview"
        >
          <span className="flex items-center gap-2">
            {promptOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Podgląd pełnego promptu systemowego
            {prompt && <span className="text-xs font-normal text-muted-foreground">~{fmtInt(prompt.tokensEstimate)} tokenów · narzędzia: {prompt.tools.join(", ") || "brak"}</span>}
          </span>
          <span
            role="button"
            tabIndex={0}
            className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              onRefreshPrompt();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onRefreshPrompt();
              }
            }}
            aria-label="Odśwież podgląd promptu"
          >
            <RefreshCw className={cn("mr-1 h-3.5 w-3.5", promptLoading && "animate-spin")} /> Odśwież
          </span>
        </button>
        {promptOpen && (
          <div id="prompt-preview" className="border-t">
            {dirtyCount > 0 && (
              <p className="px-3 pt-2 text-xs text-amber-700 dark:text-amber-300">Podgląd pokazuje zapisane ustawienia — zapisz zmiany, aby je zobaczyć.</p>
            )}
            {promptError && <p className="px-3 py-2 text-xs text-destructive">{promptError}</p>}
            {promptLoading && !prompt && (
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Wczytywanie…
              </p>
            )}
            {prompt && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">{prompt.prompt}</pre>}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
