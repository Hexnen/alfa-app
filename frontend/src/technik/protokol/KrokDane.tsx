import { Building2, CalendarDays, Clock, Route, User } from "lucide-react";
import type { TechnikJobDistance } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { REALIZATION_WORK_TYPE_META } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { Chip, ChipGroup } from "../ui/chip";
import { Field, Panel, ReadRow, WarnNote } from "../ui/panel";
import { Stepper } from "../ui/stepper";
import { dayOf, formatDatePl, parseStamp, timeOf, todayIso } from "../lib/dates";
import { hoursBetween, pl, WORK_TYPES } from "../lib/protocol";
import type { StepProps } from "./types";

/**
 * KROK 1 — KTO, CO, KIEDY, ILE.
 *
 * Wszystko, co da się policzyć, jest chipem: data z zlecenia, godziny
 * z planu albo ze znaczników „Rozpocznij / Zakończ”, kilometry z odległości
 * biuro → obiekt. Klawiatura zostaje awaryjnym wyjściem (natywna data,
 * środek steppera), a nie domyślną drogą.
 */
export function KrokDane({
  protocol,
  job,
  form,
  set,
  readOnly,
  distance,
  distanceLoading,
  kmFromDistance,
  onKmFromOffice,
}: StepProps & {
  distance: TechnikJobDistance | null;
  distanceLoading: boolean;
  kmFromDistance: boolean;
  onKmFromOffice: () => void;
}) {
  const today = todayIso();
  const jobDay = job ? dayOf(job.startAt) : null;

  /** Godziny z planu zlecenia (09:00–11:00) i ze znaczników start/koniec. */
  const plannedHours =
    job && !job.allDay ? hoursBetween(parseStamp(job.startAt), parseStamp(job.endAt)) : null;
  const plannedRange = job ? `${timeOf(job.startAt)}–${timeOf(job.endAt)}` : "";
  const workedHours = job
    ? hoursBetween(parseStamp(job.startedAt), parseStamp(job.finishedAt))
    : null;

  const suggestedKm = distance?.km == null ? null : (distance.suggestedKm ?? distance.km);

  return (
    <div className="space-y-3" data-testid="protokol-panel-dane">
      {/* --- KLIENT (read-only, z kartoteki) ------------------------- */}
      {job && !job.objectName && (
        <WarnNote data-testid="protokol-bez-obiektu">
          Zlecenie bez obiektu — dane klienta uzupełni biuro. Wypełnij resztę
          protokołu normalnie.
        </WarnNote>
      )}

      <Panel icon={User} title="Klient">
        <dl className="space-y-1">
          <ReadRow label="Nazwa" value={protocol.clientName} />
          <ReadRow
            label="Adres montażu"
            value={protocol.installationAddress || protocol.clientCity || job?.address}
          />
          <ReadRow label="Kontakt" value={protocol.contact} />
        </dl>
        {(protocol.site || job?.objectName) && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{protocol.site || job?.objectName}</span>
          </p>
        )}
      </Panel>

      {/* --- RODZAJ PRAC --------------------------------------------- */}
      <Panel title="Rodzaj prac">
        <ChipGroup>
          {WORK_TYPES.map((t) => {
            const meta = REALIZATION_WORK_TYPE_META[t];
            const Icon = meta.icon;
            return (
              <Chip
                key={t}
                selected={form.workType === t}
                disabled={readOnly}
                data-testid={`protokol-typ-${t}`}
                onClick={() => set("workType", t)}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {meta.label}
              </Chip>
            );
          })}
        </ChipGroup>
      </Panel>

      {/* --- DATA I GODZINY ------------------------------------------ */}
      <Panel icon={CalendarDays} title="Wykonanie">
        <Field label="Data wykonania" htmlFor="p-date">
          <ChipGroup className="mb-2">
            <Chip
              selected={form.workDate === today}
              disabled={readOnly}
              data-testid="protokol-data-dzis"
              onClick={() => set("workDate", today)}
            >
              Dziś
            </Chip>
            {jobDay && jobDay !== today && (
              <Chip
                selected={form.workDate === jobDay}
                disabled={readOnly}
                data-testid="protokol-data-zlecenia"
                onClick={() => set("workDate", jobDay)}
              >
                Data zlecenia ({formatDatePl(jobDay).slice(0, 5)})
              </Chip>
            )}
          </ChipGroup>
          <Input
            id="p-date"
            type="date"
            value={form.workDate}
            disabled={readOnly}
            onChange={(e) => set("workDate", e.target.value)}
            className="h-12 w-full text-base tabular-nums"
          />
        </Field>

        <Field
          label="Godziny pracy"
          hint={
            form.actualHours > 0
              ? null
              : "Bez godzin biuro nie rozliczy zlecenia — wstaw z planu albo dolicz stepperem."
          }
        >
          <ChipGroup className="mb-2">
            {plannedHours != null && (
              <Chip
                selected={form.actualHours === plannedHours}
                disabled={readOnly}
                data-testid="protokol-godz-plan"
                onClick={() => set("actualHours", plannedHours)}
              >
                <Clock className="h-4 w-4 shrink-0" aria-hidden />
                Z zlecenia ({plannedRange})
              </Chip>
            )}
            {workedHours != null && (
              <Chip
                selected={form.actualHours === workedHours}
                disabled={readOnly}
                data-testid="protokol-godz-znaczniki"
                onClick={() => set("actualHours", workedHours)}
              >
                <Clock className="h-4 w-4 shrink-0" aria-hidden />
                Z rozpoczęcia i zakończenia ({pl(workedHours)} h)
              </Chip>
            )}
          </ChipGroup>
          <Stepper
            label="Godziny pracy"
            value={form.actualHours}
            onChange={(v) => set("actualHours", v)}
            step={0.5}
            min={0}
            max={24}
            editable
            disabled={readOnly}
            format={(v) => `${pl(v)} h`}
            data-testid="protokol-godziny"
          />
        </Field>

        <Field
          label="Kilometry"
          hint={
            !readOnly && distanceLoading ? (
              "Liczę odległość od biura…"
            ) : kmFromDistance && distance ? (
              <span data-testid="km-hint">
                z odległości od biura: {pl(distance.km ?? 0)} km
                {distance.roundTrip ? " × 2" : ""}
              </span>
            ) : !readOnly && distance?.reason ? (
              <span data-testid="km-hint">Nie policzę km: {distance.reason}</span>
            ) : null
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Stepper
              label="Kilometry"
              value={form.actualKm}
              onChange={(v) => set("actualKm", v)}
              step={1}
              min={0}
              max={9999}
              editable
              inputMode="numeric"
              disabled={readOnly}
              format={(v) => `${pl(v)} km`}
              data-testid="protokol-km"
            />
            {!readOnly && suggestedKm != null && (
              <Chip
                tone="neutral"
                selected={false}
                className={cn(form.actualKm === suggestedKm && "opacity-60")}
                data-testid="km-from-office"
                onClick={onKmFromOffice}
              >
                <Route className="h-4 w-4 shrink-0" aria-hidden />
                Policz z biura ({pl(suggestedKm)} km)
              </Chip>
            )}
          </div>
        </Field>
      </Panel>
    </div>
  );
}
