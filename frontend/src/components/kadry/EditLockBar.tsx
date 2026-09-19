/**
 * KTO TERAZ EDYTUJE TĘ LISTĘ — pasek nad tabelą i pigułka przy przełączniku trybu.
 *
 * Trzy stany, które trzeba pokazać, żeby rezerwacja nie była magią:
 *  1. lista jest nasza — pasek „Edytujesz tę listę (rezerwacja do 14:32)”,
 *     czyli także: nikt inny teraz nie wpisze tu ani grosza,
 *  2. ktoś poprosił o zwolnienie — wyróżniony baner z nazwiskiem i dwoma
 *     wyjściami: oddać albo dołożyć sobie 15 minut (bez tego prośba byłaby
 *     wiadomością wysłaną w próżnię),
 *  3. lista jest czyjaś — pigułka „Edytuje: Jan Kowalski do 14:32” widoczna
 *     TAKŻE w podglądzie, żeby odmowa przy kliknięciu „Edycja” nie była
 *     zaskoczeniem.
 *
 * Okno konfliktu (`LockConflictDialog`) wisi tutaj, bo pasek i tak dostaje cały
 * stan rezerwacji — ekran wstawia JEDEN element zamiast trzech.
 */
import { Clock, Hand, Lock, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { lockUntil } from "@/lib/hrLive";
import { LockConflictDialog } from "./LockConflictDialog";
import { TOOLBAR_BTN_CLS } from "./ui";
import type { HrEditLock } from "./useEditLock";

/**
 * Pasek stanu rezerwacji + okno konfliktu.
 *
 * `onRelease` woła ekran, który trzyma preferencję „Podgląd/Edycja”: zwolnienie
 * listy z banera musi przestawić przełącznik, inaczej tabela zostałaby w trybie
 * edycji bez prawa zapisu.
 */
export function EditLockBar({
  lock,
  onRelease,
  className,
  testId = "kadry-lock-bar",
}: {
  lock: HrEditLock;
  onRelease?: () => void;
  className?: string;
  testId?: string;
}) {
  const { mine, request, error, conflict, excluded } = lock;

  const dialog = (
    <LockConflictDialog
      conflict={conflict}
      scope={lock.scope}
      year={lock.year}
      month={lock.month}
      busy={lock.busy}
      onAsk={() => void lock.askRelease()}
      onClose={lock.dismissConflict}
    />
  );

  if (!mine && !error && excluded.length === 0) return dialog;

  return (
    <>
      {error && (
        <p
          className="text-sm text-destructive"
          role="status"
          data-testid={`${testId}-error`}
        >
          {error}
        </p>
      )}
      {excluded.length > 0 && (
        /* Działy, których ta rezerwacja NIE obejmuje: ich wiersze są w tabeli
           wyszarzone, więc pasek musi powiedzieć, czyje one są i jak je
           odzyskać — inaczej „czemu tu nie da się nic wpisać?”. */
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
          data-testid={`${testId}-excluded`}
        >
          <Lock className="h-4 w-4 shrink-0" aria-hidden />
          <span>Działy zajęte przez własne sekcje (ich wiersze są zablokowane):</span>
          {excluded.map((l) => (
            <button
              key={l.portal ?? ""}
              type="button"
              onClick={() => lock.askFor(l.portal)}
              className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-900 hover:bg-sky-200 dark:bg-sky-900/60 dark:text-sky-100 dark:hover:bg-sky-900"
              data-testid={`${testId}-excluded-${l.portal ?? "all"}`}
            >
              {l.portalLabel ?? l.portal} — {l.userLabel}
              <span className="tabular-nums opacity-80">do {lockUntil(l.expiresAt)}</span>
            </button>
          ))}
        </div>
      )}
      {mine && (
        <div className={cn("flex flex-col gap-2", className)} data-testid={testId}>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
            <PencilLine className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              Edytujesz tę listę — rezerwacja do{" "}
              <span className="font-medium tabular-nums">
                {lock.lock ? lockUntil(lock.lock.expiresAt) : "—"}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className={cn(TOOLBAR_BTN_CLS, "ml-auto")}
              onClick={() => {
                void lock.disable().then(() => onRelease?.());
              }}
              data-testid={`${testId}-release`}
            >
              Zwolnij listę
            </Button>
          </div>
          {request && (
            // Prośba jest jedynym momentem, w którym rezerwacja ma kogoś
            // zaczepić — stąd kolor ostrzeżenia i dwa jawne wyjścia.
            <div
              className="flex flex-wrap items-center gap-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
              role="status"
              data-testid={`${testId}-request`}
            >
              <Hand className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">{request.label}</span> prosi o zwolnienie
                listy
                {request.message ? ` — „${request.message}”` : ""}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  className={TOOLBAR_BTN_CLS}
                  onClick={() => {
                    void lock.disable().then(() => onRelease?.());
                  }}
                  data-testid={`${testId}-request-release`}
                >
                  Zwolnij
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={TOOLBAR_BTN_CLS}
                  onClick={() => void lock.extend()}
                  data-testid={`${testId}-request-extend`}
                >
                  <Clock className="mr-1 h-4 w-4" aria-hidden />
                  Jeszcze 15 min
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {dialog}
    </>
  );
}

/**
 * Pigułka przy przełączniku trybu: kto trzyma listę albo że czekamy na
 * zwolnienie. W podglądzie to jedyna informacja o tym, czemu „Edycja” za chwilę
 * odmówi — dlatego jest widoczna zawsze, nie tylko po nieudanej próbie.
 */
export function LockHolderPill({
  lock,
  testId = "kadry-lock-pill",
}: {
  lock: HrEditLock;
  testId?: string;
}) {
  if (lock.waiting) {
    return (
      <button
        type="button"
        onClick={lock.cancelWaiting}
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-100"
        title="Kliknij, aby przestać czekać"
        data-testid={`${testId}-waiting`}
      >
        <Clock className="h-3.5 w-3.5" aria-hidden />
        Czekam na zwolnienie…
      </button>
    );
  }
  if (!lock.holder) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
      data-testid={testId}
    >
      <Lock className="h-3.5 w-3.5" aria-hidden />
      Edytuje: {lock.holder.label}
      <span className="tabular-nums opacity-80">do {lockUntil(lock.holder.expiresAt)}</span>
    </span>
  );
}
