import { ChevronLeft, FileCheck2, FileText } from "lucide-react";
import type { TechnikJobDetails, TechnikProtocol } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SegmentedControl } from "../ui/segmented";
import { jobTypeMeta, typeBarClass } from "../lib/jobs";
import { STEP_KEYS, STEP_LABELS, type StepKey } from "../lib/protocol";

/**
 * NAGŁÓWEK PROTOKOŁU — ten sam język znaków co na ekranie zlecenia: pasek
 * koloru typu, ikona typu z kalendarza, a po prawej pigułka stanu dokumentu.
 * Pod spodem pasek kroków, bo to jedyna nawigacja tego ekranu.
 *
 * Pasek jest sticky i celowo NISKI: pod nim wypełnia się formularz, a każde
 * 10 px nad klawiaturą to jedno pole mniej do przewijania.
 */
export function Naglowek({
  protocol,
  job,
  signed,
  step,
  marks,
  onStep,
  onBack,
}: {
  protocol: TechnikProtocol;
  job: TechnikJobDetails | null;
  signed: boolean;
  step: StepKey;
  marks: Partial<Record<StepKey, "ok" | "warn">>;
  onStep: (next: StepKey) => void;
  onBack: () => void;
}) {
  const typeMeta = job ? jobTypeMeta(job.type) : undefined;
  const TypeIcon = typeMeta?.icon;

  return (
    <header className="sticky top-0 z-30 -mx-4 mb-3 border-b bg-background/95 px-2 pb-2 pt-safe backdrop-blur-sm">
      <div className="flex min-h-12 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Wróć do zlecenia"
          className="h-11 w-11 shrink-0"
          onClick={onBack}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        {job && (
          <span
            aria-hidden
            className={cn("h-8 w-1 shrink-0 rounded-full", typeBarClass(job.type))}
          />
        )}
        <div className="min-w-0 flex-1 pl-1">
          <h1 className="flex items-center gap-1.5 truncate text-base font-semibold leading-tight tabular-nums">
            {TypeIcon && (
              <TypeIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="truncate">Protokół {protocol.number}</span>
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {job?.objectName || protocol.clientName || protocol.site || "Bez obiektu"}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
            signed
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "bg-muted text-muted-foreground",
          )}
          data-testid="protokol-stan"
        >
          {signed ? (
            <FileCheck2 className="h-3 w-3" aria-hidden />
          ) : (
            <FileText className="h-3 w-3" aria-hidden />
          )}
          {signed ? "Podpisany" : "Szkic"}
        </span>
      </div>

      {/* Pasek kroków. Kropka w rogu segmentu mówi, czy krok jest uzupełniony
          (zielona) czy ma braki (bursztynowa); to samo niesie `aria-label`,
          więc kolor nie jest jedynym nośnikiem znaczenia. */}
      <SegmentedControl<StepKey>
        label="Krok protokołu"
        value={step}
        onChange={onStep}
        dense
        // `mt-1`: bez tego pasek kroków stał 6 px pod strzałką „Wróć do
        // zlecenia” — poniżej 8 px z PLAN pkt 2.
        className="mt-1"
        options={STEP_KEYS.map((key, i) => ({
          value: key,
          label: `${i + 1}. ${STEP_LABELS[key]}`,
          shortLabel: STEP_LABELS[key],
          mark: marks[key],
          "data-testid": `protokol-krok-${key}`,
        }))}
      />
    </header>
  );
}
