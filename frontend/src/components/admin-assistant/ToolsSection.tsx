import { Badge } from "@/components/ui/badge";
import { Field, SectionCard, SourceBadge, Switch } from "./shared";
import { selectClass, type FormApi } from "./helpers";
import { eventStatusLabel } from "@/lib/calendar-labels";

export function ToolsSection({ form, onReset }: { form: FormApi; onReset: () => void }) {
  const { settings, sources, saving, val, setField, isDirty } = form;
  const disabledTools = val("disabledTools") || [];
  // Kodujemy defensywnie: starszy backend może nie zwracać tych pól → domyślnie włączone / done.
  const allowMod = val("allowModifications") ?? true;
  const dayStatus = val("daySummaryDefaultStatus") ?? "done";

  return (
    <SectionCard id="narzedzia" title="Narzędzia" description="Do czego asystent ma dostęp. Wyłączone narzędzie znika dla modelu — o takie rzeczy asystent nie będzie mógł zapytać ani ich zrobić." onReset={onReset} resetDisabled={saving}>
      <div className="divide-y rounded-md border">
        {settings.meta.tools.map((t) => {
          const on = t.required || !disabledTools.includes(t.name);
          return (
            <div key={t.name} className="flex items-start justify-between gap-4 px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t.label} <span className="font-mono text-xs font-normal text-muted-foreground">{t.name}</span>
                  {t.required && (
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      wymagane
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t.description}
                  {t.required && " Bez tego narzędzia asystent nie może proponować wydarzeń."}
                </p>
              </div>
              <Switch
                label={`Narzędzie ${t.label}`}
                checked={on}
                disabled={t.required}
                onChange={(v) => setField("disabledTools", v ? disabledTools.filter((x) => x !== t.name) : [...disabledTools, t.name])}
              />
            </div>
          );
        })}
        {settings.meta.tools.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Brak metadanych narzędzi.</p>}
      </div>
      <div className="space-y-4 rounded-md border px-3 py-3" data-testid="tools-modifications">
        <Field
          id="f-allowModifications"
          label="Modyfikowanie wydarzeń przez asystenta"
          source={sources.allowModifications}
          dirty={isDirty("allowModifications")}
          inline
          description="Asystent może proponować zmiany w istniejących wydarzeniach (termin, technicy, status, anulowanie, usunięcie, przywrócenie) oraz tryb „Podsumowanie dnia”. Każda zmiana to karta do zatwierdzenia — nic nie zapisuje się samo. Po wyłączeniu narzędzia propose_changes i get_event znikają dla modelu."
        >
          <Switch id="f-allowModifications" label="Modyfikowanie wydarzeń przez asystenta" checked={!!allowMod} disabled={saving} onChange={(v) => setField("allowModifications", v)} />
        </Field>
        {allowMod && (
          <Field
            id="f-daySummaryDefaultStatus"
            label="Status dla podsumowania dnia"
            source={sources.daySummaryDefaultStatus}
            dirty={isDirty("daySummaryDefaultStatus")}
            description="Status nadawany wydarzeniom, które użytkownik relacjonuje jako odbyte („Wojtek skończył serwis o 13”). Wydarzenia z przyszłości nigdy nie są oznaczane jako wykonane."
          >
            <select id="f-daySummaryDefaultStatus" className={selectClass} value={dayStatus} disabled={saving} onChange={(e) => setField("daySummaryDefaultStatus", e.target.value as "done" | "confirmed")}>
              <option value="done">{eventStatusLabel("done")}</option>
              <option value="confirmed">{eventStatusLabel("confirmed")}</option>
            </select>
          </Field>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Źródło ustawienia:</span>
        <SourceBadge source={sources.disabledTools} />
        {isDirty("disabledTools") && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            zmienione
          </Badge>
        )}
      </div>
    </SectionCard>
  );
}
