// Jedno okno potwierdzenia dla całego modułu Kadry.
//
// Wcześniej każde usunięcie szło przez `window.confirm`: natywny modal blokuje
// wątek, wygląda jak alert przeglądarki (w Chrome z adresem strony nad treścią)
// i nie da się w nim odróżnić „usuń wpis godzin" od „usuń pracownika razem
// z umowami". Tu treść jest pełnym zdaniem, a przycisk potwierdzenia ma kolor
// operacji niszczącej.
import { useState } from "react";
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
import { cn } from "@/lib/utils";

export interface ConfirmRequest {
  title: string;
  /** Pełne zdanie: co zniknie i czy pociągnie za sobą inne dane. */
  description?: string;
  confirmLabel?: string;
  /**
   * Czy operacja jest niszcząca (domyślnie tak — okno powstało do usuwania).
   * `false` daje zwykły przycisk podstawowy i neutralny podpis w trakcie pracy:
   * czerwony „Usuwanie…" pod pytaniem „Oznaczyć dział jako pulę?" obiecywał coś
   * zupełnie innego niż operacja, która miała się wykonać.
   */
  destructive?: boolean;
  /** Akcja; błąd zostaje w oknie (czerwony tekst), okno się nie zamyka. */
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request) return null;

  const destructive = request.destructive !== false;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await request.onConfirm();
      onClose();
    } catch (err) {
      // Błąd zostaje w oknie: `alert()` gubił kontekst („czego dotyczyło?"),
      // a zamknięcie okna kasowałoby jedyny ślad po nieudanym usunięciu.
      setError(err instanceof Error ? err.message : "Nie udało się wykonać operacji");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <AlertDialogContent data-testid="kadry-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          {request.description && (
            <AlertDialogDescription>{request.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error && (
          <p className="text-sm text-destructive" data-testid="kadry-confirm-error">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Anuluj</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              // Radix domyślnie zamyka okno na kliknięcie akcji — my zamykamy
              // je dopiero po udanym zapisie, więc przejmujemy zdarzenie.
              e.preventDefault();
              void run();
            }}
            className={cn(
              destructive &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
            data-testid="kadry-confirm-ok"
          >
            {busy
              ? destructive
                ? "Usuwanie…"
                : "Zapisywanie…"
              : (request.confirmLabel ?? "Usuń")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
