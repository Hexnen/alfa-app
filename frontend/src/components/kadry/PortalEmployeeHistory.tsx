/**
 * Historia PRACOWNIKA w mini-Kadrach sekcji („Godziny działu”).
 *
 * W pełnych Kadrach tę oś czasu pokazuje rozwinięty wiersz kartoteki
 * (`EmployeeHistory`) — razem z umowami, wypłatami i biurem. Sekcja kartoteki
 * nie ma i mieć nie powinna, więc dostaje wersję zawężoną: wyłącznie wpisy
 * godzin tej osoby z działów swojej sekcji (`GET /hr/activity/employee/:id`
 * z `?portal=`, zawężenie w src/routes/hr-activity.ts).
 *
 * Ikona stoi w akcjach wiersza obok historii samego WPISU — bo pytanie
 * „co się działo z godzinami tego człowieka w tym miesiącu” pada dokładnie
 * tam, gdzie się je wpisuje, a nie w osobnej zakładce.
 */
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import {
  getHrPortalEmployeeActivity,
  type HrActivityEntry,
  type HrPortalKey,
} from "@/lib/api";
import { IconButton } from "./ui";
import {
  describeHrActivity,
  hrEntryDetail,
  hrFieldLabel,
  hrFieldValue,
} from "./history-labels";

export function PortalEmployeeHistory({
  employeeId,
  employeeName,
  portal,
}: {
  employeeId: number;
  employeeName: string;
  portal: HrPortalKey;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HrActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dane ciągną się DOPIERO po otwarciu: tabela ma kilkaset wierszy, a każdy
  // z nich renderuje tę ikonę.
  useEffect(() => {
    if (!open || entries !== null) return;
    let alive = true;
    void (async () => {
      try {
        const res = await getHrPortalEmployeeActivity(employeeId, portal);
        if (alive) setEntries(res.data?.items ?? []);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Nie udało się pobrać historii");
        setEntries([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, entries, employeeId, portal]);

  return (
    <>
      <IconButton
        icon={Users}
        label={`Historia godzin: ${employeeName}`}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Historia godzin — {employeeName}</DialogTitle>
            <DialogDescription>
              Zmiany wpisów godzin tej osoby w działach tej sekcji. Umowy,
              wypłaty i rozliczenie biura widać wyłącznie w pełnych Kadrach.
            </DialogDescription>
          </DialogHeader>
          <div data-testid="portal-employee-history">
            {error ? (
              <p className="px-4 py-6 text-center text-xs text-destructive">{error}</p>
            ) : entries === null ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                Wczytywanie…
              </p>
            ) : (
              <ActivityTimeline
                entries={entries}
                describe={(e) => describeHrActivity(e as HrActivityEntry)}
                fieldLabel={hrFieldLabel}
                formatValue={hrFieldValue}
                entryDetail={(e) => hrEntryDetail(e as HrActivityEntry)}
                emptyText="Brak zapisanych zmian godzin tego pracownika."
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
