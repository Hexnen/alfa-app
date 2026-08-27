import { Input } from "@/components/ui/input";
import { AdvancedBlock, Field, SectionCard } from "./shared";
import { countFieldState, type FormApi } from "./helpers";

const ADVANCED_FIELDS = ["retentionDays", "dailyTurnLimit"] as const;

export function AccessSection({
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
  const { sources, defaults, errors, saving, val, setField, isDirty, numVal, setNum } = form;

  return (
    <SectionCard id="dostep" title="Dostęp i limity" description="Kto zobaczy asystenta w kalendarzu, ile może z niego korzystać i jak długo trzymamy rozmowy." onReset={onReset} resetDisabled={saving}>
      <Field
        id="f-access"
        label="Dostęp"
        source={sources.access}
        dirty={isDirty("access")}
        description="Administratorzy widzą asystenta zawsze. Druga opcja pokazuje go także osobom z prawem edycji zakładki Kalendarz — bez zmiany ich uprawnień do samego kalendarza."
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
          {(
            [
              ["admins", "Tylko administratorzy"],
              ["calendar_editors", "Administratorzy i edytorzy kalendarza"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input type="radio" name="assistant-access" value={v} checked={val("access") === v} onChange={() => setField("access", v)} className="accent-primary" />
              {label}
            </label>
          ))}
        </div>
      </Field>

      <AdvancedBlock id="adv-dostep" open={advanced} onToggle={onToggleAdvanced} {...countFieldState(form, [...ADVANCED_FIELDS])}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id="f-retentionDays"
            label="Retencja czatów (dni)"
            source={sources.retentionDays}
            dirty={isDirty("retentionDays")}
            error={errors.retentionDays}
            description="Rozmowy, w których nikt nic nie napisał przez tyle dni, zostaną automatycznie usunięte — użytkownicy ich już nie zobaczą. 0 = nigdy nie usuwaj (maks. 3650)."
          >
            <Input id="f-retentionDays" type="number" min={0} max={3650} value={numVal("retentionDays")} placeholder={String(defaults.retentionDays)} onChange={(e) => setNum("retentionDays", e.target.value)} />
          </Field>
          <Field
            id="f-dailyTurnLimit"
            label="Dzienny limit tur na użytkownika"
            source={sources.dailyTurnLimit}
            dirty={isDirty("dailyTurnLimit")}
            error={errors.dailyTurnLimit}
            description="Po tylu wiadomościach jednego dnia użytkownik zobaczy komunikat o wyczerpaniu limitu i poczeka do jutra. Chroni budżet. 0 = bez limitu (maks. 10000)."
          >
            <Input id="f-dailyTurnLimit" type="number" min={0} max={10000} value={numVal("dailyTurnLimit")} placeholder={String(defaults.dailyTurnLimit)} onChange={(e) => setNum("dailyTurnLimit", e.target.value)} />
          </Field>
        </div>
      </AdvancedBlock>
    </SectionCard>
  );
}
