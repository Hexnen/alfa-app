// Podzakładka Kadry → Działy: słownik działów firmy do wpisów godzin.
//
// Dział jest rodzeństwem pozycji kadrowej, nie jej odmianą: godziny działu to
// koszt ogólny firmy, więc dział NIE mapuje się na obiekt z kartoteki —
// przypisanie go do jednego klienta obciążyłoby go kosztem wszystkich.
// Stąd osobny ekran obok Obiektów, a nie kolejna kolumna w tamtej tabeli.
//
// Osobny plik od `Kadry.tsx` z prozaicznego powodu: tamten ma już 1900 linii
// i kolejna tabela inline pogorszyłaby go bez żadnego zysku.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createHrDepartment,
  deleteHrDepartment,
  updateHrDepartment,
  type HrDepartment,
} from "@/lib/api";
import { hrs } from "./shared";
import { Th } from "./parts";

/** Kod HTTP z błędu `request()` — 409 przy usuwaniu znaczy „dział ma godziny". */
const errStatus = (e: unknown): number =>
  typeof e === "object" && e !== null && "status" in e
    ? Number((e as { status?: unknown }).status) || 0
    : 0;

const errMessage = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

export function DepartmentsTab({
  departments,
  editable,
  loading,
  onChanged,
}: {
  departments: HrDepartment[];
  editable: boolean;
  loading: boolean;
  /** Zmiana słownika — rodzic przeładowuje działy (i etykiety w Godzinach). */
  onChanged: () => Promise<void> | void;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Kolejność ustawia użytkownik (`sortOrder` 10, 20, …), a nazwa rozstrzyga
  // remisy — bez tie-breaka wiersze skakałyby po każdym zapisie.
  const sorted = useMemo(
    () =>
      [...departments].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pl"),
      ),
    [departments],
  );

  /** Każda zmiana idzie tą samą ścieżką: zapis → przeładowanie słownika. */
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    if (!editable || busy) return;
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      alert(errMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await createHrDepartment({ name });
      setNewName("");
    }, "Błąd dodawania działu");
  };

  // Edycja operuje na SUROWEJ nazwie, choć tabela pokazuje etykietę
  // z prefiksem firmy: prefiks pochodzi z ustawień (Administracja → Firma),
  // nie jest częścią nazwy i wpisanie go tutaj zdublowałoby go na ekranie.
  const handleRename = (row: HrDepartment) => {
    const name = window.prompt("Nazwa działu:", row.name);
    if (name == null) return;
    if (!name.trim() || name.trim() === row.name) return;
    void run(
      () => updateHrDepartment(row.id, { name: name.trim() }),
      "Błąd zapisu działu",
    );
  };

  const handleToggleActive = (row: HrDepartment) =>
    void run(
      () => updateHrDepartment(row.id, { active: !row.active }),
      "Błąd zapisu działu",
    );

  const handleTogglePool = (row: HrDepartment) => {
    if (
      !row.isCmaPool &&
      !window.confirm(
        `Oznaczyć „${row.name}" jako dział-pulę?\n\n` +
          "Koszt godzin takiego działu rozdziela się na WSZYSTKIE dozorowane " +
          "obiekty, zamiast obciążać jednego klienta. Pula może być tylko jedna " +
          "— poprzedni dział-pula straci ten znacznik.",
      )
    )
      return;
    void run(
      () => updateHrDepartment(row.id, { isCmaPool: !row.isCmaPool }),
      "Błąd zapisu znacznika puli",
    );
  };

  const handleOrder = (row: HrDepartment, value: string) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n === row.sortOrder) return;
    void run(
      () => updateHrDepartment(row.id, { sortOrder: n }),
      "Błąd zapisu kolejności",
    );
  };

  /**
   * Usunięcie działu. Backend odmawia (409), gdy wiszą na nim godziny — to
   * NIE jest błąd do pokazania i zapomnienia, tylko pytanie: wiersze przeżyją
   * usunięcie działu (`ON DELETE SET NULL`), ale stracą przypisanie i wpadną
   * do kosztu nieprzypisanego. Dlatego dopiero po świadomym potwierdzeniu
   * powtarzamy żądanie z `force`.
   */
  const handleDelete = async (row: HrDepartment) => {
    if (!editable || busy) return;
    if (!window.confirm(`Usunąć dział ${row.name}?`)) return;
    setBusy(true);
    try {
      await deleteHrDepartment(row.id);
      await onChanged();
    } catch (err) {
      if (errStatus(err) === 409) {
        const forced = window.confirm(
          `${errMessage(err, "Dział ma przypisane godziny.")}\n\n` +
            `Na dziale „${row.name}" wisi ${hrs(row.hoursTotal)} godz. ` +
            `(${row.employeesCount} prac.). Usunięcie zostawi te wpisy bez ` +
            "przypisania — trafią do kosztu ogólnego. Usunąć mimo to?",
        );
        if (forced) {
          try {
            await deleteHrDepartment(row.id, true);
            await onChanged();
          } catch (err2) {
            alert(errMessage(err2, "Błąd usuwania działu"));
          }
        }
      } else {
        alert(errMessage(err, "Błąd usuwania działu"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Banera „tylko do odczytu" nie dublujemy: `Kadry.tsx` renderuje go nad
          zakładkami dla klucza aktywnej podzakładki, więc `kadry/dzialy` bez
          edycji jest już oznaczone. Tu zostaje samo wygaszenie akcji. */}
      <div className="flex flex-wrap items-center gap-3">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Działy są alternatywą dla obiektu we wpisie godzin: wiersz wskazuje
          obiekt albo dział, nigdy oba naraz. Godziny działu są kosztem ogólnym
          firmy, więc nie mapują się na kartotekę. Etykietę w Godzinach
          poprzedza nazwa firmy z Administracja → Firma.
        </p>
        {editable && (
          <div className="ml-auto flex max-w-md gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nazwa nowego działu…"
              data-testid="department-new-name"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
            <Button
              onClick={handleAdd}
              disabled={!newName.trim() || busy}
              data-testid="department-add"
            >
              <Plus className="mr-2 h-4 w-4" />
              Dodaj
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <Th tip="Etykieta widoczna w Godzinach — z prefiksem nazwy firmy z Administracja → Firma. Edycja zmienia samą nazwę działu, bez prefiksu.">
                  Dział
                </Th>
                <Th
                  tip="Kolejność na listach wyboru — mniejsza liczba jest wyżej (przyjęte skoki co 10, żeby dało się wstawić dział pomiędzy)"
                  className="w-28 text-right"
                >
                  Kolejność
                </Th>
                <Th tip="Dział-pula: jego koszt rozdziela się na wszystkie dozorowane obiekty, zamiast obciążać jednego klienta. Pula może być tylko jedna.">
                  Pula CMA
                </Th>
                <Th tip="Nieaktywny dział nie jest podpowiadany przy wpisywaniu godzin (zostaje widoczny na wierszach, które już go używają)">
                  Status
                </Th>
                <Th
                  tip="Suma godzin wypracowanych na tym dziale z całej historii"
                  className="text-right"
                >
                  Godziny
                </Th>
                <Th
                  tip="Ilu różnych pracowników kiedykolwiek księgowało godziny na tym dziale"
                  className="text-right"
                >
                  Pracownicy
                </Th>
                <Th className="w-32" />
              </tr>
            </thead>
            <tbody data-testid="departments-table">
              {sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    {loading ? "Ładowanie…" : "Brak działów w słowniku"}
                  </td>
                </tr>
              ) : (
                sorted.map((r) => (
                  <tr
                    key={r.id}
                    className={cn(
                      "border-b hover:bg-accent/50",
                      !r.active && "text-muted-foreground",
                    )}
                  >
                    <td className="px-3 py-2 font-medium">
                      {/* Etykieta z prefiksem — użytkownik ma tu widzieć
                          dokładnie to, co zobaczy w selekcie Godzin. */}
                      {r.label || r.name}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        className="ml-auto h-8 w-20 text-right tabular-nums"
                        inputMode="numeric"
                        defaultValue={String(r.sortOrder)}
                        disabled={!editable}
                        aria-label={`Kolejność działu ${r.name}`}
                        key={`${r.id}:${r.sortOrder}`}
                        onBlur={(e) => handleOrder(r, e.currentTarget.value)}
                        onKeyDown={(e) =>
                          e.key === "Enter" && e.currentTarget.blur()
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => handleTogglePool(r)}
                        disabled={!editable || busy}
                        title="Koszt działu-puli rozdziela się na wszystkie dozorowane obiekty"
                        className={cn(
                          "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
                          r.isCmaPool
                            ? "bg-sky-100 text-sky-700"
                            : "bg-muted text-muted-foreground",
                          !editable && "cursor-default",
                        )}
                      >
                        {r.isCmaPool ? "pula CMA" : "zwykły"}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(r)}
                        disabled={!editable || busy}
                        className={cn(
                          "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
                          r.active
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-muted text-muted-foreground",
                          !editable && "cursor-default",
                        )}
                      >
                        {r.active ? "aktywny" : "nieaktywny"}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.hoursTotal ? hrs(r.hoursTotal) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.employeesCount || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {editable && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Zmień nazwę działu"
                            onClick={() => handleRename(r)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Usuń dział"
                            onClick={() => void handleDelete(r)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
