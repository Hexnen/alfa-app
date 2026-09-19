/**
 * „Lista jest zajęta” — okno po nieudanym przejściu w tryb edycji.
 *
 * Kliknięcie „Edycja” na liście, którą trzyma ktoś inny, kończyło się dotąd
 * wyłącznie odmową przy PIERWSZYM zapisie — po wpisaniu kwot. Tu odmowa
 * przychodzi od razu, z nazwiskiem i godziną, a jedyne sensowne wyjście
 * (poprosić o zwolnienie) jest przyciskiem, a nie wyjściem na korytarz.
 *
 * Gdy prośba już poszła, okno tego nie powtarza: właściciel ma jeden baner,
 * nie dziesięć, a proszący widzi, że czeka (przełącznik trybu sam wejdzie
 * w edycję, kiedy lista się zwolni — patrz `useEditLock`).
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MONTH_NAMES } from "./shared";
import { lockUntil, type HrLockScope } from "@/lib/hrLive";
import type { HrLockConflict } from "./useEditLock";

/** Nazwa listy w bierniku — „Listę wypłat edytuje…”. */
const SCOPE_LABEL: Record<HrLockScope, string> = {
  payroll: "Listę wypłat",
  hours: "Listę godzin",
  office: "Rozliczenie biura",
};

export function LockConflictDialog({
  conflict,
  scope,
  year,
  month,
  busy,
  onAsk,
  onClose,
}: {
  conflict: HrLockConflict | null;
  scope: HrLockScope;
  year: number;
  month: number;
  busy?: boolean;
  onAsk: () => void;
  onClose: () => void;
}) {
  if (!conflict) return null;
  const period = `${MONTH_NAMES[month - 1].toLowerCase()} ${year}`;

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="kadry-lock-conflict">
        <AlertDialogHeader>
          <AlertDialogTitle>Lista jest zajęta</AlertDialogTitle>
          <AlertDialogDescription>
            {conflict.portal
              ? `Wiersze działu ${conflict.portalLabel ?? conflict.portal} (${SCOPE_LABEL[scope].toLowerCase()} za ${period})`
              : `${SCOPE_LABEL[scope]} za ${period}`}{" "}
            edytuje {conflict.label} (rezerwacja do {lockUntil(conflict.expiresAt)}).{" "}
            {conflict.pending
              ? "Prośba o zwolnienie już poszła — gdy lista się zwolni, wejdziesz w tryb edycji bez klikania."
              : "Poprosić o zwolnienie?"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="kadry-lock-conflict-cancel">
            {conflict.pending ? "Zamknij" : "Anuluj"}
          </AlertDialogCancel>
          {!conflict.pending && (
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                // Okno zamyka dopiero wysłana prośba (albo błąd) — Radix
                // zamknąłby je od razu, zanim wiadomo, czy poszła.
                e.preventDefault();
                onAsk();
              }}
              data-testid="kadry-lock-conflict-ask"
            >
              {busy ? "Wysyłanie…" : "Poproś o zwolnienie"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
