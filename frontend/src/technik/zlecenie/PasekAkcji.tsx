import { CircleCheckBig, FileText, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clockOf, parseStamp } from "../lib/dates";
import type { JobState } from "../lib/jobs";

/**
 * Jak długo po zakończeniu da się jeszcze wrócić do roboty. Doba pokrywa
 * pomyłkę („kliknąłem Zakończ, a klient poprosił o jeszcze jedną kamerę”)
 * i nocną zmianę, a nie zamienia „Wznów” w stały przycisk na zleceniach
 * sprzed tygodnia, które biuro ma już rozliczone.
 */
const REOPEN_WINDOW_MS = 24 * 3_600_000;

/** Czy zakończone zlecenie jest jeszcze w oknie wznowienia. */
function canReopen(state: JobState, finishedAt: string | null): boolean {
  if (state !== "done") return false;
  const at = parseStamp(finishedAt);
  return !!at && Date.now() - at.getTime() < REOPEN_WINDOW_MS;
}

/**
 * STICKY PASEK AKCJI — po lewej stan zlecenia tekstem, po prawej JEDEN główny
 * przycisk: Rozpocznij → Zakończ → Protokół.
 *
 * Primary nigdy nie ląduje na końcu scrolla, bo przy rozwiniętych notatkach
 * technik by go po prostu nie znalazł. Stan po lewej powtarza to, co mówi
 * pigułka w nagłówku — oko wraca tu po każdej akcji i ma dostać potwierdzenie
 * w tym samym miejscu, w którym kliknęło.
 *
 * Bez prawa edycji (podgląd zlecenia) zostaje sam stan: pasek nie znika, żeby
 * treść nie podskakiwała, ale nie obiecuje akcji zakończonej błędem 403.
 */
export function PasekAkcji({
  state,
  startedAt,
  finishedAt,
  canEdit,
  busy,
  hasProtocol,
  onStart,
  onFinish,
  onProtocol,
  onReopen,
}: {
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  canEdit: boolean;
  busy: boolean;
  hasProtocol: boolean;
  onStart: () => void;
  onFinish: () => void;
  onProtocol: () => void;
  /** „Wznów” — powrót do stanu „w toku” po omyłkowym zakończeniu. */
  onReopen: () => void;
}) {
  const actions = canEdit && state !== "cancelled";
  const reopenable = actions && canReopen(state, finishedAt);

  const primary =
    state === "planned"
      ? { label: "Rozpocznij", icon: Play, onClick: onStart }
      : state === "running"
        ? { label: "Zakończ", icon: CircleCheckBig, onClick: onFinish }
        : {
            label: hasProtocol ? "Otwórz protokół" : "Protokół",
            icon: FileText,
            onClick: onProtocol,
          };
  const PrimaryIcon = primary.icon;

  return (
    <div className="fixed inset-x-0 bottom-kb-nav z-40 border-t bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2.5">
        <p
          aria-live="polite"
          data-testid="zlecenie-pasek-stan"
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-tight tabular-nums",
            state === "running" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {stateLine(state, startedAt, finishedAt)}
        </p>

        {actions && (
          <>
            {/* Robota zamknięta za wcześnie zdarza się pod bramą częściej niż
                w biurze — przez dobę po zakończeniu stoi tu wyjście awaryjne.
                Outline, bo główną akcją zostaje protokół. */}
            {reopenable && (
              <Button
                variant="outline"
                size="lg"
                className="h-12 shrink-0 px-4 text-base"
                disabled={busy}
                onClick={onReopen}
                data-testid="zlecenie-akcja-wznow"
              >
                <RotateCcw className="h-5 w-5 sm:mr-2" />
                <span className="sr-only sm:not-sr-only">Wznów</span>
              </Button>
            )}
            {/* Protokół bywa potrzebny jeszcze przed „Zakończ” (klient podpisuje
                przy aucie), więc w toku zostaje OBOK głównej akcji. */}
            {state === "running" && (
              <Button
                variant="outline"
                size="lg"
                className="h-12 shrink-0 px-4 text-base"
                disabled={busy}
                onClick={onProtocol}
                data-testid="zlecenie-akcja-protokol"
              >
                <FileText className="h-5 w-5 sm:mr-2" />
                <span className="sr-only sm:not-sr-only">Protokół</span>
              </Button>
            )}
            <Button
              size="lg"
              className="h-12 shrink-0 px-5 text-base"
              disabled={busy}
              onClick={primary.onClick}
              data-testid="zlecenie-akcja"
            >
              <PrimaryIcon className="mr-2 h-5 w-5" />
              {busy ? "Chwileczkę…" : primary.label}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** „Zaplanowane” / „W toku od 09:12” / „Zakończone 11:05”. */
function stateLine(state: JobState, startedAt: string | null, finishedAt: string | null): string {
  switch (state) {
    case "running":
      return `W toku od ${clockOf(startedAt) || "—"}`;
    case "done": {
      const at = clockOf(finishedAt);
      return at ? `Zakończone ${at}` : "Zakończone";
    }
    case "cancelled":
      return "Odwołane przez biuro";
    default:
      return "Zaplanowane";
  }
}
