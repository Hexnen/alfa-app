// Podzakładka Kadry → Obiekty: słownik pozycji kadrowych i ich mapowanie na
// kartotekę obiektów (stąd bierze się koszt osobowy w Analityce).
//
// Zmiana nazwy szła przez `window.prompt` — okienko przeglądarki bez kontekstu,
// w którym nie widać ani reszty listy, ani tego, ile godzin wisi na pozycji.
// Teraz nazwa zamienia się w pole w tym samym wierszu (Enter zapisuje, Esc
// cofa), a usuwanie potwierdza wspólne okno modułu zamiast `window.confirm`.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Building2, Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { EntityHistory } from "./EntityHistory";
import { KadryHelp } from "./KadryHelp";
import {
  createHrObject,
  deleteHrObject,
  setHrObjectMapping,
  updateHrObject,
  type HrObject,
  type HrObjectRef,
} from "@/lib/api";
import { catalogLabel } from "@/lib/labels";
import { SortTh, Th, type SortDir } from "./parts";
import {
  EmptyRow,
  IconButton,
  KadryBadge,
  RowActions,
  TEXT_TONE,
  THEAD_CLS,
} from "./ui";
import { TABLE_SELECT_CLS, cmpMoney, cmpNum, cmpText, hrs, overheadKind } from "./shared";
import { useConfirm } from "./useConfirm";

type ObjectSortKey = "name" | "hoursTotal" | "employeesCount" | "mapping";

const OBJECT_DIR: Record<ObjectSortKey, SortDir> = {
  name: "asc",
  hoursTotal: "desc",
  employeesCount: "desc",
  mapping: "asc",
};

type ActiveFilter = "all" | "active" | "inactive";

export function ObjectsTab({
  objects,
  catalog,
  editable,
  loading,
  onChanged,
}: {
  objects: HrObject[];
  /** Kartoteka obiektów — lista wyboru przy mapowaniu pozycji kadrowych. */
  catalog: HrObjectRef[];
  editable: boolean;
  loading: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [search, setSearch] = useState("");
  const [mapping, setMapping] = useState<"all" | "mapped" | "unmapped">("all");
  const [active, setActive] = useState<ActiveFilter>("all");
  /** Pozycje techniczne (#BIURO, #zlecenie): ukryj / tylko one / wszystkie. */
  const [tech, setTech] = useState<"all" | "hide" | "only">("all");
  const [withHours, setWithHours] = useState(false);
  const [sort, setSort] = useState<ObjectSortKey>("hoursTotal");
  const [dir, setDir] = useState<SortDir>("desc");
  const [newName, setNewName] = useState("");
  /** Wiersz w trakcie zmiany nazwy: id → tekst w polu. */
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err) {
      // Błąd w pasku nad tabelą, nie w `alert()`: widać przy nim wiersz,
      // którego dotyczy, i da się skopiować treść.
      setError(err instanceof Error ? err.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const visible = (() => {
    const q = search.trim().toLowerCase();
    const list = objects.filter((o) => {
      if (q && !o.name.toLowerCase().includes(q)) return false;
      if (mapping === "mapped" && o.objectId == null) return false;
      if (mapping === "unmapped" && o.objectId != null) return false;
      if (active === "active" && !o.active) return false;
      if (active === "inactive" && o.active) return false;
      const isTech = overheadKind(o.name) != null;
      if (tech === "hide" && isTech) return false;
      if (tech === "only" && !isTech) return false;
      if (withHours && o.hoursTotal <= 0) return false;
      return true;
    });
    const mul = dir === "asc" ? 1 : -1;
    const mappingLabel = (o: HrObject) => (o.object ? catalogLabel(o.object) : "");
    const cmp = (a: HrObject, b: HrObject) => {
      switch (sort) {
        case "name":
          return cmpText(a.name, b.name, mul);
        case "employeesCount":
          return cmpNum(a.employeesCount, b.employeesCount, mul);
        case "mapping":
          return cmpText(mappingLabel(a), mappingLabel(b), mul);
        default:
          // Godziny: 0 to „pozycja bez historii” — tabela pisze tam kreskę,
          // więc w sortowaniu zachowuje się jak brak wartości.
          return cmpMoney(a.hoursTotal, b.hoursTotal, mul);
      }
    };
    return list.sort(
      (a, b) => cmp(a, b) || a.name.localeCompare(b.name, "pl") || a.id - b.id,
    );
  })();

  const filtersActive =
    search !== "" ||
    mapping !== "all" ||
    active !== "all" ||
    tech !== "all" ||
    withHours;

  const clearFilters = () => {
    setSearch("");
    setMapping("all");
    setActive("all");
    setTech("all");
    setWithHours(false);
  };

  const toggleSort = (key: ObjectSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(OBJECT_DIR[key]);
  };

  /**
   * Postęp mapowania liczymy TYLKO z pozycji, które mają godziny i nie są
   * kosztem ogólnym: pozycja bez godzin nic do Analityki nie wniesie, a
   * #BIURO / #zlecenie nie mają być mapowane — w mianowniku zaniżałyby wynik.
   */
  const relevant = objects.filter(
    (o) => o.hoursTotal > 0 && !overheadKind(o.name),
  );
  const mapped = relevant.filter((o) => o.objectId != null);
  const sumHours = (list: HrObject[]) =>
    list.reduce((acc, o) => acc + o.hoursTotal, 0);

  const handleAdd = () =>
    run(async () => {
      const name = newName.trim();
      if (!name) return;
      await createHrObject({ name });
      setNewName("");
    }, "Błąd dodawania obiektu");

  const commitRename = async () => {
    if (!renaming) return;
    const row = objects.find((o) => o.id === renaming.id);
    const name = renaming.value.trim();
    if (!row || !name || name === row.name) {
      setRenaming(null);
      return;
    }
    const ok = await run(
      () => updateHrObject(row.id, { name, active: row.active }),
      "Błąd zapisu obiektu",
    );
    if (ok) setRenaming(null);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Szukaj: nazwa pozycji…"
            className="pl-10"
            data-testid="kadry-obiekty-filter-search"
          />
        </div>
        <Select value={mapping} onValueChange={(v) => setMapping(v as typeof mapping)}>
          <SelectTrigger className="w-[190px]" data-testid="kadry-obiekty-filter-mapping">
            <SelectValue placeholder="Mapowanie" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Mapowanie: wszystkie</SelectItem>
            <SelectItem value="unmapped">Tylko niezmapowane</SelectItem>
            <SelectItem value="mapped">Tylko zmapowane</SelectItem>
          </SelectContent>
        </Select>
        <Select value={active} onValueChange={(v) => setActive(v as ActiveFilter)}>
          <SelectTrigger className="w-[170px]" data-testid="kadry-obiekty-filter-active">
            <SelectValue placeholder="Aktywność" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Aktywne i nieaktywne</SelectItem>
            <SelectItem value="active">Tylko aktywne</SelectItem>
            <SelectItem value="inactive">Tylko nieaktywne</SelectItem>
          </SelectContent>
        </Select>
        {/* #BIURO / #zlecenie są celowo niezmapowane, więc przy przeglądaniu
            „co zostało do zmapowania” tylko zaśmiecają listę. */}
        <Select value={tech} onValueChange={(v) => setTech(v as typeof tech)}>
          <SelectTrigger className="w-[220px]" data-testid="kadry-obiekty-filter-tech">
            <SelectValue placeholder="Pozycje techniczne" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Pozycje techniczne: pokaż</SelectItem>
            <SelectItem value="hide">Pozycje techniczne: ukryj</SelectItem>
            <SelectItem value="only">Tylko pozycje techniczne</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Checkbox
            id="kadry-obiekty-with-hours"
            checked={withHours}
            onCheckedChange={(checked) => setWithHours(checked === true)}
            data-testid="kadry-obiekty-filter-with-hours"
          />
          <label htmlFor="kadry-obiekty-with-hours" className="cursor-pointer text-sm">
            Tylko z godzinami
          </label>
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="kadry-obiekty-filters-clear"
          >
            <X className="mr-1 h-4 w-4" />
            Wyczyść filtry
          </Button>
        )}
        {editable && (
          <div className="ml-auto flex max-w-md gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nazwa nowego obiektu…"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
            <Button onClick={handleAdd} disabled={!newName.trim() || busy}>
              <Plus className="mr-1 h-4 w-4" />
              Dodaj
            </Button>
          </div>
        )}
        {/* Legenda zakładki. `ml-auto` tylko bez pola „nowy obiekt” — inaczej
            dwa automatyczne marginesy podzieliłyby wolną przestrzeń po połowie. */}
        <KadryHelp tab="obiekty" className={editable ? undefined : "ml-auto"} />
      </div>

      {error && (
        <p className="text-sm text-destructive" data-testid="kadry-obiekty-error">
          {error}
        </p>
      )}

      {/* Postęp mapowania — od niego zależy, ile kosztu osobowego w ogóle
          trafi do Analityki obiektów; niezmapowana pozycja zostaje kosztem
          nieprzypisanym do nikogo. */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium">
              Zmapowano {mapped.length} z {relevant.length} pozycji z godzinami
            </span>
            <span className="text-xs text-muted-foreground">
              {hrs(sumHours(mapped))} z {hrs(sumHours(relevant))} godz. trafi do
              kosztu obiektów w Analityce
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{
                width: `${
                  relevant.length
                    ? Math.round((mapped.length / relevant.length) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Słownik kadrowy powstał niezależnie od kartoteki i nazwy się nie
            pokrywają, więc powiązanie ustawia się ręcznie. Pozycje techniczne
            (#BIURO, #zlecenie) zostaw niezmapowane — to koszt ogólny firmy, nie
            koszt obiektu. Praca działowa (CMA, Handlowy, Księgowość…) ma własny
            słownik w Kadry → Działy i we wpisie godzin wybiera się ją zamiast
            obiektu.
          </p>
        </CardContent>
      </Card>
      {/* Postęp mapowania powyżej liczy CAŁY słownik (to miara roboty do
          wykonania), więc licznik listy stoi osobno. */}
      <p className="text-sm text-muted-foreground" data-testid="kadry-obiekty-count">
        {visible.length}
        {visible.length === objects.length ? "" : ` z ${objects.length}`} pozycji ·{" "}
        {hrs(visible.reduce((s, o) => s + o.hoursTotal, 0))} h
      </p>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className={THEAD_CLS}>
              <tr>
                <SortTh
                  label="Obiekt kadrowy"
                  sortKey="name"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="kadry-obiekty-sort"
                  tip="Nazwa obiektu (posterunku) — słownik do wpisów godzin"
                />
                <SortTh
                  label="Godziny"
                  sortKey="hoursTotal"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="kadry-obiekty-sort"
                  align="right"
                  tip="Suma godzin wypracowanych na tej pozycji z całej historii — im więcej, tym ważniejsze mapowanie"
                />
                <SortTh
                  label="Pracownicy"
                  sortKey="employeesCount"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="kadry-obiekty-sort"
                  align="right"
                  tip="Ilu różnych pracowników kiedykolwiek księgowało godziny na tej pozycji"
                />
                <SortTh
                  label="Obiekt w kartotece"
                  sortKey="mapping"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="kadry-obiekty-sort"
                  tip="Obiekt z kartoteki, na który przeniosą się wynagrodzenia z tej pozycji (Analityka → Obiekty). Sortowanie ustawia niezmapowane na końcu"
                />
                <Th tip="Nieaktywny obiekt nie jest podpowiadany przy wpisywaniu godzin">
                  Status
                </Th>
                <Th className="w-32" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <EmptyRow
                  colSpan={6}
                  loading={loading}
                  icon={Building2}
                  title={
                    filtersActive
                      ? "Brak pozycji dla wybranych filtrów"
                      : "Słownik kadrowy jest pusty"
                  }
                  description={
                    filtersActive
                      ? "Zdejmij filtry albo zmień szukajkę — pozycje bez godzin też są na liście."
                      : "Pozycje kadrowe biorą się z wpisów godzin. Nową można dodać polem u góry."
                  }
                  action={
                    filtersActive ? (
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        <X className="mr-1 h-4 w-4" /> Wyczyść filtry
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {visible.map((r) => {
                const overhead = overheadKind(r.name);
                const isRenaming = renaming?.id === r.id;
                return (
                  <tr
                    key={r.id}
                    className={cn(
                      // `group` — akcje po prawej wyłażą dopiero pod kursorem.
                      "group border-b hover:bg-accent/50",
                      overhead && "bg-muted/30 text-muted-foreground",
                    )}
                  >
                    <td className="px-3 py-2 font-medium">
                      {isRenaming ? (
                        <div className="flex items-center gap-1">
                          <Input
                            autoFocus
                            className="h-8 max-w-sm"
                            value={renaming.value}
                            data-testid="kadry-obiekty-rename-input"
                            onChange={(e) =>
                              setRenaming({ id: r.id, value: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void commitRename();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setRenaming(null);
                              }
                            }}
                            onBlur={() => void commitRename()}
                          />
                          {/* Akcje trybu edycji zostają widoczne zawsze (nie
                              `RowActions`): pole jest otwarte, więc „zapisz"
                              i „anuluj" są tu jedyną drogą wyjścia.
                              `onMouseDown` z `preventDefault` chroni je przed
                              `onBlur` pola, który zapisałby przed kliknięciem. */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn("h-8 w-8", TEXT_TONE.good)}
                            aria-label="Zapisz nazwę"
                            {...tip("Zapisz nazwę")}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => void commitRename()}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="Anuluj zmianę nazwy"
                            {...tip("Anuluj zmianę nazwy")}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setRenaming(null)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          {r.name}
                          {overhead && (
                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal">
                              pozycja techniczna
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.hoursTotal ? hrs(r.hoursTotal) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.employeesCount || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {overhead ? (
                        <span
                          className="cursor-help text-xs italic"
                          {...tip(
                            "Koszt ogólny firmy — przypisanie go do jednego obiektu obciążyłoby jednego klienta kosztem wszystkich",
                          )}
                        >
                          koszt ogólny, nie mapuj
                        </span>
                      ) : (
                        <select
                          className={TABLE_SELECT_CLS}
                          value={r.objectId ?? ""}
                          disabled={!editable}
                          aria-label={`Obiekt w kartotece dla pozycji ${r.name}`}
                          {...tip(
                            r.object
                              ? catalogLabel(r.object)
                              : "Wskaż obiekt z kartoteki, którego dotyczą godziny tej pozycji",
                          )}
                          onChange={(e) =>
                            void run(
                              () =>
                                setHrObjectMapping(
                                  r.id,
                                  e.target.value ? Number(e.target.value) : null,
                                ),
                              "Błąd zapisu mapowania",
                            )
                          }
                        >
                          <option value="">— nie mapuj —</option>
                          {catalog.map((o) => (
                            <option key={o.id} value={o.id}>
                              {catalogLabel(o)}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <KadryBadge
                        tone={r.active ? "aktywny" : "nieaktywny"}
                        disabled={!editable || busy}
                        hint={
                          r.active
                            ? "Pozycja podpowiadana przy wpisywaniu godzin. Kliknij, żeby ją wygasić."
                            : "Pozycja nie jest podpowiadana przy wpisywaniu godzin (zostaje na wpisach, które już jej używają). Kliknij, żeby przywrócić."
                        }
                        onClick={() =>
                          void run(
                            () =>
                              updateHrObject(r.id, {
                                name: r.name,
                                active: !r.active,
                              }),
                            "Błąd zapisu obiektu",
                          )
                        }
                      >
                        {r.active ? "aktywny" : "nieaktywny"}
                      </KadryBadge>
                    </td>
                    <td className="px-3 py-2">
                      {!isRenaming && (
                        <RowActions>
                          {/* Historia pozycji: odczyt, więc bez bramki `editable`. */}
                          <EntityHistory
                            entityType="hr_object"
                            entityId={r.id}
                            title={r.name}
                            className="h-8 w-8"
                          />
                          {editable && (
                            <>
                              <IconButton
                                icon={Pencil}
                                label="Zmień nazwę pozycji"
                                testId="kadry-obiekty-rename"
                                onClick={() =>
                                  setRenaming({ id: r.id, value: r.name })
                                }
                              />
                              <IconButton
                                icon={Trash2}
                                danger
                                label="Usuń pozycję"
                                onClick={() =>
                                  confirm.ask({
                                    title: `Usunąć pozycję „${r.name}"?`,
                                    description:
                                      r.hoursTotal > 0
                                        ? `Na tej pozycji wisi ${hrs(r.hoursTotal)} h z historii — usunięcie zdejmie przypisanie z tych wpisów.`
                                        : "Pozycja zniknie ze słownika wpisów godzin.",
                                    onConfirm: async () => {
                                      await deleteHrObject(r.id);
                                      await onChanged();
                                    },
                                  })
                                }
                              />
                            </>
                          )}
                        </RowActions>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {confirm.dialog}
    </>
  );
}
