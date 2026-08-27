import { Input } from "@/components/ui/input";
import type { AssistantSettingsValues } from "@/lib/api";
import { AdvancedBlock, Field, SectionCard } from "./shared";
import { countFieldState, selectClass, type FormApi } from "./helpers";

const REASONING_LABEL: Record<string, string> = {
  "": "Wyłączone (domyślne modelu)",
  low: "Niskie",
  medium: "Średnie",
  high: "Wysokie",
};

const ADVANCED_FIELDS = ["temperature", "maxSteps", "historyTokenBudget", "reasoningEffort"] as const;

export function GenerationSection({
  form,
  advanced,
  onToggleAdvanced,
  onReset,
}: {
  form: FormApi;
  advanced: boolean;
  onToggleAdvanced: (v: boolean) => void;
  onReset: () => void;
}) {
  const { settings, sources, defaults, errors, saving, val, setField, isDirty, numVal, setNum } = form;
  const temp = val("temperature");

  return (
    <SectionCard id="generowanie" title="Generowanie" description="Jak długo i jak „odważnie” model odpowiada — wpływa na koszt i czas każdej tury." onReset={onReset} resetDisabled={saving}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="f-maxOutputTokens"
          label="Maks. długość odpowiedzi (tokeny)"
          source={sources.maxOutputTokens}
          dirty={isDirty("maxOutputTokens")}
          error={errors.maxOutputTokens}
          description={`Za mała wartość utnie dłuższe odpowiedzi w połowie; większa pozwala na obszerniejsze, ale droższe odpowiedzi (100–32000). Domyślnie ${defaults.maxOutputTokens}.`}
        >
          <Input id="f-maxOutputTokens" type="number" min={100} max={32000} step={50} value={numVal("maxOutputTokens")} placeholder={String(defaults.maxOutputTokens)} onChange={(e) => setNum("maxOutputTokens", e.target.value)} />
        </Field>
      </div>

      <AdvancedBlock id="adv-generowanie" open={advanced} onToggle={onToggleAdvanced} {...countFieldState(form, [...ADVANCED_FIELDS])}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id="f-temperature"
            label="Temperatura"
            source={sources.temperature}
            dirty={isDirty("temperature")}
            error={errors.temperature}
            description={`Niżej = odpowiedzi bardziej przewidywalne i powtarzalne, wyżej = bardziej swobodne, ale częściej niedokładne. Domyślnie ${defaults.temperature}.`}
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                aria-label="Temperatura (suwak)"
                value={typeof temp === "number" && Number.isFinite(temp) ? temp : defaults.temperature}
                onChange={(e) => setField("temperature", Number(e.target.value))}
                className="flex-1 accent-primary"
              />
              <Input id="f-temperature" type="number" min={0} max={1} step={0.05} value={numVal("temperature")} placeholder={String(defaults.temperature)} onChange={(e) => setNum("temperature", e.target.value)} className="w-24" />
            </div>
          </Field>
          <Field
            id="f-maxSteps"
            label="Maks. kroków (wywołań narzędzi)"
            source={sources.maxSteps}
            dirty={isDirty("maxSteps")}
            error={errors.maxSteps}
            description={`Ile razy w jednej turze asystent może zajrzeć do kalendarza, obiektów itp., zanim odpowie. Za mało = „nie zdążył sprawdzić”, za dużo = dłuższe i droższe tury (1–20). Domyślnie ${defaults.maxSteps}.`}
          >
            <Input id="f-maxSteps" type="number" min={1} max={20} value={numVal("maxSteps")} placeholder={String(defaults.maxSteps)} onChange={(e) => setNum("maxSteps", e.target.value)} />
          </Field>
          <Field
            id="f-historyTokenBudget"
            label="Pamięć rozmowy (tokeny historii)"
            source={sources.historyTokenBudget}
            dirty={isDirty("historyTokenBudget")}
            error={errors.historyTokenBudget}
            description={`Ile wcześniejszych wiadomości z czatu asystent „pamięta”. Mniej = szybciej zapomina kontekst w długich rozmowach, więcej = każda tura droższa (2000–200000). Domyślnie ${defaults.historyTokenBudget}.`}
          >
            <Input id="f-historyTokenBudget" type="number" min={2000} max={200000} step={500} value={numVal("historyTokenBudget")} placeholder={String(defaults.historyTokenBudget)} onChange={(e) => setNum("historyTokenBudget", e.target.value)} />
          </Field>
          <Field
            id="f-reasoningEffort"
            label="Rozumowanie (reasoning)"
            source={sources.reasoningEffort}
            dirty={isDirty("reasoningEffort")}
            description="Dla modeli, które to obsługują: asystent dłużej „myśli” przed odpowiedzią — lepiej radzi sobie z zawiłymi terminami, ale odpowiada wolniej i kosztuje więcej."
          >
            <select id="f-reasoningEffort" className={selectClass} value={val("reasoningEffort") ?? ""} onChange={(e) => setField("reasoningEffort", e.target.value as AssistantSettingsValues["reasoningEffort"])}>
              {(settings.meta.reasoningEfforts.length ? settings.meta.reasoningEfforts : (["", "low", "medium", "high"] as const)).map((r) => (
                <option key={r || "off"} value={r}>
                  {REASONING_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </AdvancedBlock>
    </SectionCard>
  );
}
