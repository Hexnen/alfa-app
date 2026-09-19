// Pasek stanu miesiąca rozliczeniowego — nad tabelą Wynagrodzeń i Godzin.
//
// Miesiąc kadrowy kończy się raz: kwoty idą do księgowości, wypłaty wychodzą
// i arkusz ma przestać się ruszać. Do tej pory nic tego nie pokazywało ani nie
// pilnowało — poprawka wpisana w październiku w sierpniowe godziny po cichu
// zmieniała kwotę, którą ktoś już wypłacił.
//
// Pasek robi dwie rzeczy:
//  1. mówi, CO ZOSTAŁO do zamknięcia (ta sama lista, którą liczy backend —
//     `buildMonthChecklist` w src/lib/hr-month.ts; front jej nie przelicza),
//  2. daje jedno kliknięcie „Zamknij miesiąc" i — po zamknięciu — „Otwórz
//     ponownie", z powodem, który trafia do dziennika zmian.
//
// Zamknięcie z brakami jest możliwe, ale świadome: potwierdzenie mówi wprost,
// czego brakuje, a przycisk nazywa się „Zamknij mimo to".
import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  Lock,
  LockOpen,
  RotateCcw,
} from "lucide-react";
import {
  closeHrMonth,
  reopenHrMonth,
  type HrMonthChecklist,
  type HrMonthStatus,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { KadryBadge, TEXT_TONE, TOOLBAR_BTN_CLS } from "./ui";
import { useConfirm } from "./useConfirm";
import { MONTH_NAMES } from "./shared";

const monthLabel = (year: number, month: number) =>
  `${(MONTH_NAMES[month - 1] ?? "").toLowerCase()} ${year}`;

/** Minimalna długość powodu — ta sama, co na backendzie (`REASON_MIN`). */
const REASON_MIN = 5;

/**
 * Braki, które zatrzymują zamknięcie. Lustro `closingWarnings` z backendu:
 * front pokazuje je w oknie zanim wyśle żądanie, backend i tak sprawdza je
 * jeszcze raz (bez `force` odpowiada 409).
 *
 * Dodatki „do przeliczenia" świadomie NIE są brakiem — one domykają się przy
 * wypłacie, już po zamknięciu miesiąca.
 */
function closingWarnings(c: HrMonthChecklist): string[] {
  const out: string[] = [];
  const emptyHours = c.hoursEntries - c.hoursFilled;
  if (emptyHours > 0) out.push(`${emptyHours} wpisów godzin bez godzin`);
  if (c.uncertainAssignments > 0) {
    out.push(`${c.uncertainAssignments} wpisów godzin z niepotwierdzonym przypisaniem`);
  }
  if (c.missingMain > 0) out.push(`${c.missingMain} umów z godzinami bez kwoty głównej`);
  if (c.officeEntries === 0 && c.prevOfficeEntries > 0) {
    out.push(`brak rozliczenia biura — w poprzednim miesiącu było ${c.prevOfficeEntries} wpisów`);
  }
  return out;
}

/**
 * To, co warto wiedzieć przy zamykaniu, ale co go NIE blokuje — lustro
 * `closingNotes` z backendu. Dodatek „do przeliczenia" domyka się przy
 * wypłacie, więc wymaganie na niego „mimo to" byłoby formalnością klikaną
 * co miesiąc.
 */
function closingNotes(c: HrMonthChecklist): string[] {
  const out: string[] = [];
  if (c.pendingBonus > 0) {
    out.push(`${c.pendingBonus} dodatków „do przeliczenia" — kwota domknie się przy wypłacie`);
  }
  return out;
}

/** Data zamknięcia w zapisie polskim („5.10.2026, 14:32"). */
const stamp = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
};

/** Jedna pozycja listy kontrolnej: ✓ zrobione / ○ zostało. */
function ChecklistItem({
  done,
  children,
  testId,
}: {
  done: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  const Icon = done ? Check : Circle;
  return (
    <span
      className={cn("flex items-center gap-1", done ? TEXT_TONE.good : TEXT_TONE.muted)}
      data-testid={testId}
    >
      <Icon className={done ? "h-3.5 w-3.5" : "h-2.5 w-2.5"} aria-hidden />
      {children}
    </span>
  );
}

export function MonthStatusBar({
  status,
  year,
  month,
  /** `edit` na Wynagrodzeniach — bez tego pasek jest samą informacją. */
  canClose,
  /** Po zamknięciu/otwarciu: przeładowanie miesiąca (dane zmieniają tryb). */
  onChanged,
}: {
  status: HrMonthStatus | null;
  year: number;
  month: number;
  canClose: boolean;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Póki stan nie przyszedł, nie rysujemy nic: pasek „otwarty", który za chwilę
  // zmienia się w „zamknięty", jest gorszy niż brak paska przez pół sekundy.
  if (!status) return null;

  const label = monthLabel(year, month);
  const { checklist } = status;
  const warnings = closingWarnings(checklist);
  const notes = closingNotes(checklist);
  const closed = status.status === "closed";

  /**
   * Pytanie o zamknięcie. `serverReason` pojawia się w drugim podejściu: gdy
   * backend odmówił (409), bo między wczytaniem listy kontrolnej a kliknięciem
   * ktoś dopisał brak — wtedy pokazujemy DOKŁADNIE to, co napisał serwer,
   * zamiast własnej, już nieaktualnej listy.
   */
  const askClose = (serverReason?: string) => {
    const hasGaps = warnings.length > 0 || serverReason != null;
    const noteText = notes.length > 0 ? ` Do odnotowania (nie blokuje): ${notes.join("; ")}.` : "";
    confirm.ask({
      // Tytuł nie może uspokajać, kiedy jest czego brakować: „Zamknąć
      // październik 2026?" nad listą braków czytało się jak formalność.
      title: hasGaps ? `Miesiąc ${label} ma braki — zamknąć mimo to?` : `Zamknąć ${label}?`,
      description: hasGaps
        ? `${serverReason ?? `Zostało do uzupełnienia: ${warnings.join("; ")}.`}${noteText} ` +
          "Zamknięcie mimo to zapisze te braki w dzienniku zmian, a dane miesiąca " +
          "przejdą w tryb tylko do odczytu."
        : "Godziny, wypłaty i biuro tego miesiąca przejdą w tryb tylko do odczytu. " +
          "Ponowne otwarcie będzie wymagało podania powodu." +
          noteText,
      confirmLabel: hasGaps ? "Zamknij mimo to" : "Zamknij miesiąc",
      destructive: false,
      onConfirm: async () => {
        try {
          await closeHrMonth(year, month, hasGaps);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          // Odmowa z braków (409) wygląda tak: „Miesiąc X ma braki: …".
          // Pytamy drugi raz, treścią serwera — `setTimeout`, bo okno zamyka
          // się zaraz po `onConfirm` i bez tego skasowałoby nowe pytanie.
          if (!hasGaps && /ma braki:/i.test(msg)) {
            setTimeout(() => askClose(msg), 0);
            return;
          }
          throw err;
        }
        onChanged();
      },
    });
  };

  const submitReopen = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      setError(`Podaj powód ponownego otwarcia (min. ${REASON_MIN} znaków)`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reopenHrMonth(year, month, trimmed);
      setReopenOpen(false);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nie udało się otworzyć miesiąca");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm",
          // Zamknięty miesiąc ma być widoczny od razu, ale w obu motywach:
          // sama `border-amber-300` w ciemnym świeciłaby jak ostrzeżenie błędu.
          closed
            ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-800/60 dark:bg-amber-950/20"
            : "bg-muted/30",
        )}
        data-testid="kadry-month-status"
      >
        {closed ? (
          <>
            <KadryBadge tone="ostrzezenie" icon={Lock} testId="kadry-month-status-badge">
              Miesiąc zamknięty
            </KadryBadge>
            <span data-testid="kadry-month-status-closed-by">
              {label} — zamknięty {stamp(status.closedAt)}
              {status.closedBy ? ` przez ${status.closedBy}` : ""}
            </span>
            <span className={TEXT_TONE.muted}>
              Godziny, wypłaty i biuro tego miesiąca są tylko do odczytu.
            </span>
            {canClose && (
              <Button
                variant="outline"
                size="sm"
                className={cn(TOOLBAR_BTN_CLS, "ml-auto")}
                onClick={() => {
                  setError(null);
                  setReopenOpen(true);
                }}
                data-testid="kadry-month-reopen"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Otwórz ponownie
              </Button>
            )}
          </>
        ) : (
          <>
            <KadryBadge tone="aktywny" icon={LockOpen} testId="kadry-month-status-badge">
              Miesiąc otwarty
            </KadryBadge>
            <ChecklistItem
              done={checklist.hoursEntries > 0 && checklist.hoursFilled === checklist.hoursEntries}
              testId="kadry-month-check-hours"
            >
              godziny {checklist.hoursFilled} z {checklist.hoursEntries} wpisów
            </ChecklistItem>
            <ChecklistItem
              done={checklist.uncertainAssignments === 0}
              testId="kadry-month-check-assignments"
            >
              {checklist.uncertainAssignments === 0
                ? "przypisania potwierdzone"
                : `${checklist.uncertainAssignments} przypisań do potwierdzenia`}
            </ChecklistItem>
            <ChecklistItem
              done={checklist.missingMain === 0}
              testId="kadry-month-check-amounts"
            >
              kwoty {checklist.contractsWithAmount} z {checklist.contractsWithHours} umów
            </ChecklistItem>
            {/* Biuro bez wpisów jest brakiem tylko wtedy, gdy poprzedni
                miesiąc je miał — firma bez biura nie ma czego uzupełniać. */}
            <ChecklistItem
              done={checklist.officeEntries > 0 || checklist.prevOfficeEntries === 0}
              testId="kadry-month-check-office"
            >
              biuro {checklist.officeEntries} wpisów
              {checklist.officeEntries === 0 && checklist.prevOfficeEntries > 0
                ? ` (poprzedni miesiąc: ${checklist.prevOfficeEntries})`
                : ""}
            </ChecklistItem>
            {checklist.pendingBonus > 0 && (
              <span className={cn("flex items-center gap-1", TEXT_TONE.warn)}>
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                {checklist.pendingBonus} dodatków do przeliczenia
              </span>
            )}
            {/* Miesiąc otwierany ponownie to nie to samo, co nigdy nie zamykany
                — powód zostaje na wierzchu, dopóki miesiąc jest otwarty. */}
            {status.reopenReason && (
              <span className={TEXT_TONE.muted} data-testid="kadry-month-reopen-reason">
                otwarty ponownie — powód: {status.reopenReason}
              </span>
            )}
            {canClose && (
              <Button
                variant="outline"
                size="sm"
                className={cn(TOOLBAR_BTN_CLS, "ml-auto")}
                onClick={() => askClose()}
                data-testid="kadry-month-close"
              >
                <Lock className="mr-2 h-4 w-4" />
                Zamknij miesiąc
              </Button>
            )}
          </>
        )}
      </div>

      {confirm.dialog}

      <Dialog
        open={reopenOpen}
        onOpenChange={(o) => {
          if (!busy) setReopenOpen(o);
        }}
      >
        <DialogContent data-testid="kadry-month-reopen-dialog">
          <DialogHeader>
            <DialogTitle>Otworzyć ponownie {label}?</DialogTitle>
            <DialogDescription>
              Miesiąc był zamknięty{status.closedBy ? ` przez ${status.closedBy}` : ""}
              {status.closedAt ? ` ${stamp(status.closedAt)}` : ""}. Powód otwarcia trafi do
              dziennika zmian — za miesiąc nikt nie będzie pamiętał, po co dane były ruszane.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="np. korekta godzin na obiekcie Galeria — wpis z L4 przyszedł po terminie"
            data-testid="kadry-month-reopen-reason-input"
          />
          {error && (
            <p className="text-sm text-destructive" data-testid="kadry-month-reopen-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setReopenOpen(false)}>
              Anuluj
            </Button>
            <Button
              disabled={busy}
              onClick={() => void submitReopen()}
              data-testid="kadry-month-reopen-ok"
            >
              {busy ? "Otwieranie…" : "Otwórz ponownie"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
