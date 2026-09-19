/**
 * Sekcja „Historia” w rozwiniętym wierszu pracownika (Kadry → Pracownicy).
 *
 * Trzecia sekcja obok Umów i Biura, domyślnie ZWINIĘTA i ładowana leniwie:
 * rozwinięcie kartoteki ma dalej kosztować jedno kliknięcie, a nie zapytanie
 * o historię każdej osoby, którą ktoś po drodze otworzył.
 *
 * Źródło: `GET /hr/employees/:id/activity` — zbiera zmiany osoby, jej umów,
 * wpisów godzin, wypłat i wierszy biura (src/routes/hr-activity.ts).
 */
import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Section } from "@/components/ui/section";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { getHrEmployeeActivity, type HrActivityEntry } from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { describeHrActivity, hrEntryDetail, hrFieldLabel, hrFieldValue } from "./history-labels";

export function EmployeeHistory({ employeeId }: { employeeId: number }) {
  // Dziennik streszcza KWOTY WYNAGRODZEŃ (własne i cudze), więc ma własny klucz
  // uprawnień — jak backend (`guard()` w src/routes/hr-activity.ts). Sekcja bez
  // tego klucza nie pokazuje się wcale: przycisk, który zawsze kończy się 403,
  // jest gorszy niż jego brak.
  const { canView } = usePerms();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HrActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || entries !== null) return;
    let alive = true;
    void (async () => {
      try {
        const res = await getHrEmployeeActivity(employeeId);
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
  }, [open, entries, employeeId]);

  if (!canView("kadry/historia")) return null;

  return (
    <Section
      id={`hr-employee-history-${employeeId}`}
      icon={History}
      title={entries === null ? "Historia" : `Historia (${entries.length})`}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div data-testid="kadry-employee-history">
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
            emptyText="Brak zapisanych zmian tego pracownika."
          />
        )}
      </div>
    </Section>
  );
}
