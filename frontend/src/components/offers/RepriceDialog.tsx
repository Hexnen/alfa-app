/**
 * Podgląd aktualizacji cen — co „Aktualizuj" ruszy, zanim cokolwiek zapisze.
 *
 * Pozycje oferty są migawkami cen z chwili dodania, więc aktualizacja potrafi
 * zmienić kwotę dokumentu. Dlatego nie robimy jej „w ciemno": backend zwraca
 * listę pozycji z ceną PRZED i PO (ta sama funkcja, która potem zapisuje —
 * podgląd nie może się rozjechać z zapisem), a użytkownik decyduje po
 * zobaczeniu różnic.
 *
 * Decyzja jest per pozycja, nie tylko „wszystko albo nic": każdy wiersz ma
 * własny przycisk, bo typowy przypadek to jedna cena, która podskoczyła —
 * reszty oferty przed wysyłką nikt nie chce ruszać.
 */
import { useEffect, useState } from "react";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { tip } from "@/components/ui/tooltip";
import { offersApi, type OfferRepriceChange } from "@/lib/api";
import { fmtPln, fmtPlnOrDash, fmtQty } from "./offersShared";

interface RepriceDialogProps {
  open: boolean;
  offerId: number;
  /** Czy pokazywać kolumnę kosztu — backend i tak przycina pola bez uprawnienia. */
  showCosts: boolean;
  onClose: () => void;
  /** Zapis: bez `itemIds` całość, z listą — tylko wskazane pozycje. */
  onApply: (itemIds?: number[]) => Promise<void>;
}

/** Cena „z czego na co", z kierunkiem zaznaczonym kolorem. */
function PriceDelta({ from, to }: { from: number | null | undefined; to: number | null | undefined }) {
  const up = (to ?? 0) > (from ?? 0);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
      <span className="text-muted-foreground line-through">{fmtPlnOrDash(from)}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <span className={cn("font-medium", up ? "text-red-600" : "text-emerald-600")}>
        {fmtPlnOrDash(to)}
      </span>
    </span>
  );
}

export function RepriceDialog({ open, offerId, showCosts, onClose, onApply }: RepriceDialogProps) {
  const [changes, setChanges] = useState<OfferRepriceChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Co właśnie leci na serwer: id pozycji, "all" albo nic. */
  const [pending, setPending] = useState<number | "all" | null>(null);
  /** Ile pozycji zdążyliśmy zapisać w tym otwarciu — inaczej pusta lista kłamie. */
  const [done, setDone] = useState(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChanges(null);
    setError(null);
    setDone(0);
    offersApi
      .repricePreview(offerId)
      .then((res) => {
        if (alive) setChanges(res.data ?? []);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "Nie udało się pobrać podglądu");
      });
    return () => {
      alive = false;
    };
  }, [open, offerId]);

  // Suma różnicy na dokumencie — jedna liczba mówi więcej niż lista pozycji.
  const diff = (changes ?? []).reduce(
    (acc, ch) => acc + ch.qty * (ch.newUnitPrice - ch.oldUnitPrice),
    0
  );
  const busy = pending !== null;

  /**
   * Zapis jednej pozycji albo wszystkich. Po pojedynczej zostajemy w modalu —
   * wiersz znika z listy, więc widać, co jeszcze czeka na decyzję.
   */
  const apply = async (ids?: number[]) => {
    setPending(ids && ids.length === 1 ? ids[0] : "all");
    setError(null);
    try {
      await onApply(ids);
      if (ids) {
        setDone((n) => n + ids.length);
        setChanges((prev) => (prev ?? []).filter((ch) => !ids.includes(ch.itemId)));
      } else {
        onClose();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Aktualizacja nie powiodła się");
    } finally {
      setPending(null);
    }
  };

  const empty = changes !== null && changes.length === 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 border-b px-5 py-3">
          <DialogTitle className="text-base">Aktualizacja cen</DialogTitle>
          <DialogDescription className="text-xs">
            Ceny pozycji zostaną zastąpione tymi z kartotek (magazyn i usługi). Pozycje wpisane
            ręcznie zostają bez zmian.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          {changes === null && !error && (
            <p className="text-sm text-muted-foreground">Sprawdzam kartoteki…</p>
          )}
          {empty && (
            <p className="text-sm text-muted-foreground">
              {done > 0
                ? `Gotowe — zaktualizowano ${done} ${done === 1 ? "pozycję" : "pozycje"}. Reszta oferty jest zgodna z kartotekami.`
                : "Ceny na ofercie są zgodne z kartotekami — nie ma czego aktualizować."}
            </p>
          )}
          {changes !== null && changes.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Pozycja</th>
                  <th className="px-2 py-1 text-right font-medium">Ilość</th>
                  <th className="px-2 py-1 text-right font-medium">Cena jedn.</th>
                  {showCosts && <th className="px-2 py-1 text-right font-medium">Koszt jedn.</th>}
                  <th className="px-2 py-1 text-right font-medium">Wartość</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {changes.map((ch) => {
                  const lineDiff = ch.qty * (ch.newUnitPrice - ch.oldUnitPrice);
                  return (
                    <tr key={ch.itemId} className="border-b align-top last:border-0">
                      <td className="px-2 py-1.5">
                        <div className="truncate" title={ch.name}>
                          {ch.name}
                        </div>
                        {ch.sectionTitle && (
                          <div className="text-xs text-muted-foreground">{ch.sectionTitle}</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {fmtQty(ch.qty)} {ch.unit}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <PriceDelta from={ch.oldUnitPrice} to={ch.newUnitPrice} />
                      </td>
                      {showCosts && (
                        <td className="px-2 py-1.5 text-right">
                          {ch.oldUnitCost === ch.newUnitCost ? (
                            <span className="text-muted-foreground">
                              {fmtPlnOrDash(ch.newUnitCost)}
                            </span>
                          ) : (
                            <PriceDelta from={ch.oldUnitCost} to={ch.newUnitCost} />
                          )}
                        </td>
                      )}
                      <td
                        className={cn(
                          "whitespace-nowrap px-2 py-1.5 text-right tabular-nums",
                          lineDiff > 0 ? "text-red-600" : lineDiff < 0 ? "text-emerald-600" : ""
                        )}
                      >
                        {lineDiff > 0 ? "+" : ""}
                        {fmtPln(lineDiff)}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2"
                          disabled={busy}
                          onClick={() => apply([ch.itemId])}
                          {...tip("Zaktualizuj tylko tę pozycję")}
                        >
                          {pending === ch.itemId ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-background px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {changes === null || changes.length === 0
              ? done > 0
                ? `Zaktualizowano ${done} poz.`
                : ""
              : `${changes.length} poz. do aktualizacji · zmiana wartości ${diff > 0 ? "+" : ""}${fmtPln(diff)}`}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              {empty ? "Zamknij" : "Anuluj"}
            </Button>
            {changes !== null && changes.length > 0 && (
              <Button type="button" size="sm" onClick={() => apply()} disabled={busy}>
                <RefreshCw className="mr-1 h-4 w-4" /> Aktualizuj wszystkie ({changes.length})
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
