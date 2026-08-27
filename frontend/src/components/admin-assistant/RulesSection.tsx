import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { AssistantSettingsValues } from "@/lib/api";
import { eventStatusLabel, eventTypeLabel } from "@/lib/calendar-labels";
import { AdvancedBlock, Field, SectionCard, Switch } from "./shared";
import { countFieldState, selectClass, type FormApi } from "./helpers";

const ADVANCED_FIELDS = ["defaultStatus", "maxHorizonDays", "allowRecurrence"] as const;

export function RulesSection({
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
  const allDayTypes = val("allDayTypes") || [];

  return (
    <SectionCard id="reguly" title="Reguły kalendarza" description="Czego asystent domyślnie założy, gdy użytkownik nie poda szczegółów (godzina, czas trwania, status)." onReset={onReset} resetDisabled={saving}>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Field id="f-workStart" label="Początek dnia pracy" source={sources.workStart} dirty={isDirty("workStart")} error={errors.workStart} description={`Wcześniej niż ta godzina asystent nie zaproponuje terminu. Domyślnie ${defaults.workStart}.`}>
          <Input id="f-workStart" type="time" lang="pl" value={val("workStart") ?? ""} onChange={(e) => setField("workStart", e.target.value)} />
        </Field>
        <Field id="f-workEnd" label="Koniec dnia pracy" source={sources.workEnd} dirty={isDirty("workEnd")} error={errors.workEnd} description={`Po tej godzinie asystent nie zaproponuje terminu. Domyślnie ${defaults.workEnd}.`}>
          <Input id="f-workEnd" type="time" lang="pl" value={val("workEnd") ?? ""} onChange={(e) => setField("workEnd", e.target.value)} />
        </Field>
        <Field
          id="f-defaultDurationHours"
          label="Domyślny czas trwania (h)"
          source={sources.defaultDurationHours}
          dirty={isDirty("defaultDurationHours")}
          error={errors.defaultDurationHours}
          description={`Gdy użytkownik poda tylko godzinę początku, wydarzenie dostanie taką długość (0,5–12). Domyślnie ${defaults.defaultDurationHours}.`}
        >
          <Input id="f-defaultDurationHours" type="number" min={0.5} max={12} step={0.5} value={numVal("defaultDurationHours")} placeholder={String(defaults.defaultDurationHours)} onChange={(e) => setNum("defaultDurationHours", e.target.value)} />
        </Field>
      </div>
      <Field id="f-allDayTypes" label="Typy całodniowe" source={sources.allDayTypes} dirty={isDirty("allDayTypes")} description="Wydarzenia zaznaczonych typów asystent zaproponuje jako całodniowe, chyba że użytkownik poda konkretne godziny.">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(settings.meta.eventTypes.length ? settings.meta.eventTypes : defaults.allDayTypes).map((t) => {
            const checked = allDayTypes.includes(t);
            return (
              <label key={t} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  aria-label={eventTypeLabel(t)}
                  onCheckedChange={(c) => setField("allDayTypes", c ? [...allDayTypes, t] : allDayTypes.filter((x) => x !== t))}
                />
                {eventTypeLabel(t)}
              </label>
            );
          })}
        </div>
      </Field>

      <AdvancedBlock id="adv-reguly" open={advanced} onToggle={onToggleAdvanced} {...countFieldState(form, [...ADVANCED_FIELDS])}>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Field id="f-defaultStatus" label="Domyślny status wydarzenia" source={sources.defaultStatus} dirty={isDirty("defaultStatus")} description={`Z takim statusem trafią do kalendarza wydarzenia zatwierdzone z propozycji asystenta. Domyślnie „${eventStatusLabel(defaults.defaultStatus)}”.`}>
            <select id="f-defaultStatus" className={selectClass} value={val("defaultStatus") ?? "planned"} onChange={(e) => setField("defaultStatus", e.target.value as AssistantSettingsValues["defaultStatus"])}>
              {(settings.meta.statuses.length ? settings.meta.statuses : ["planned", "confirmed"]).map((s) => (
                <option key={s} value={s}>
                  {eventStatusLabel(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id="f-maxHorizonDays"
            label="Maks. horyzont (dni)"
            source={sources.maxHorizonDays}
            dirty={isDirty("maxHorizonDays")}
            error={errors.maxHorizonDays}
            description={`Dalej w przyszłość asystent nie zajrzy ani nie zaplanuje — pytania o późniejsze terminy dostaną odmowę (7–730). Domyślnie ${defaults.maxHorizonDays}.`}
          >
            <Input id="f-maxHorizonDays" type="number" min={7} max={730} value={numVal("maxHorizonDays")} placeholder={String(defaults.maxHorizonDays)} onChange={(e) => setNum("maxHorizonDays", e.target.value)} />
          </Field>
          <Field id="f-allowRecurrence" label="Zezwalaj na cykliczność" source={sources.allowRecurrence} dirty={isDirty("allowRecurrence")} inline description="Po wyłączeniu prośby typu „co tydzień” dadzą pojedyncze wydarzenie zamiast serii.">
            <Switch id="f-allowRecurrence" label="Zezwalaj na cykliczność" checked={!!val("allowRecurrence")} onChange={(v) => setField("allowRecurrence", v)} />
          </Field>
        </div>
      </AdvancedBlock>
    </SectionCard>
  );
}
