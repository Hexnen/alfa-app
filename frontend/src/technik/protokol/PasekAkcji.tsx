import { ChevronLeft, ChevronRight, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "signed" | "conflict";

/**
 * STAN ZAPISU TEKSTEM, Z GODZINĄ — nigdy kręciołkiem. Technik ma wiedzieć, czy
 * może zamknąć tablet, a nie zgadywać, co znaczy obracająca się ikonka.
 */
function saveLabel(state: SaveState, savedAt: string | null): string {
  switch (state) {
    case "signed":
      return "Protokół podpisany";
    case "saving":
      return "Zapisywanie…";
    case "dirty":
      return "Niezapisane zmiany";
    case "conflict":
      return "Zapis wstrzymany";
    case "saved":
      return savedAt ? `Zapisano ${savedAt}` : "Zapisano";
    default:
      return savedAt ? `Zapisano ${savedAt}` : "Szkic";
  }
}

/**
 * STICKY PASEK AKCJI — po lewej stan zapisu, po prawej ruch po krokach.
 * Unoszony nad klawiaturę przez `--kb` (patrz `lib/keyboard.ts`), bo Safari nie
 * zna `interactive-widget` i primary schowałby się pod klawiaturą.
 */
export function PasekAkcji({
  state,
  savedAt,
  canBack,
  lastStep,
  signed,
  disabled,
  onBack,
  onNext,
  onSign,
  onFinish,
}: {
  state: SaveState;
  savedAt: string | null;
  canBack: boolean;
  lastStep: boolean;
  signed: boolean;
  disabled?: boolean;
  onBack: () => void;
  onNext: () => void;
  onSign: () => void;
  onFinish: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-kb z-40 border-t bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2.5">
        <p
          aria-live="polite"
          data-testid="protokol-stan-zapisu"
          className={cn(
            "min-w-0 flex-1 text-xs leading-tight",
            state === "dirty" || state === "conflict"
              ? "text-amber-700 dark:text-amber-400"
              : "text-muted-foreground",
          )}
        >
          {saveLabel(state, savedAt)}
        </p>

        {/* Po podpisie nawigacja po krokach zostaje tylko na pasku u góry —
            na dole liczy się jedno wyjście. */}
        {!signed && (
          <Button
            variant="outline"
            size="lg"
            className="h-12 shrink-0 px-4 text-base"
            data-testid="protokol-wstecz"
            onClick={onBack}
          >
            <ChevronLeft className="mr-1 h-5 w-5" />
            {canBack ? "Wstecz" : "Zlecenie"}
          </Button>
        )}

        {signed ? (
          <Button
            size="lg"
            className="h-12 shrink-0 px-4 text-base"
            data-testid="protokol-wroc"
            onClick={onFinish}
          >
            Wróć do zlecenia
          </Button>
        ) : lastStep ? (
          <Button
            size="lg"
            className="h-12 shrink-0 px-4 text-base"
            disabled={disabled}
            data-testid="protokol-podpis"
            onClick={onSign}
          >
            <PenLine className="mr-2 h-5 w-5" />
            Podpis klienta
          </Button>
        ) : (
          <Button
            size="lg"
            className="h-12 shrink-0 px-5 text-base"
            data-testid="protokol-dalej"
            onClick={onNext}
          >
            Dalej
            <ChevronRight className="ml-1 h-5 w-5" />
          </Button>
        )}
      </div>
    </div>
  );
}
