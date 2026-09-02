// Podzakładka Kadry → Godziny.
//
// Miesiąc nie zaczyna się od pustej listy: carry-over podstawia wiersze
// z poprzedniego miesiąca, więc praca polega na UZUPEŁNIANIU komórek, a nie na
// zakładaniu wpisów. Dialog na każdy wiersz był tu wąskim gardłem (klik →
// modal → zapis → zamknięcie, i tak kilkadziesiąt razy w miesiącu), dlatego
// tabela ma dwa tryby przełączane w pasku narzędzi:
//   • Podgląd — czytelna tabela, wiersz otwiera dialog (dawne zachowanie),
//   • Edycja — komórki są polami; zapis leci po opuszczeniu pola, Enter
//     przeskakuje na tę samą kolumnę w kolejnym wierszu, Esc cofa zmianę.
//
// Zapis idzie przez PUT /hr/hours/:id z `expectedUpdatedAt`, więc równoległa
// edycja tego samego wpisu z drugiej karty kończy się czytelnym 409, a nie
// cichym nadpisaniem cudzej godziny.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  Eye,
  Loader2,
  Pencil,
  PencilLine,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  updateHrHours,
  type HrDepartment,
  type HrHoursEntry,
  type HrHoursInput,
  type HrObject,
} from "@/lib/api";
import {
  TABLE_SELECT_CLS,
  fieldToNum,
  formatAssignment,
  hrs,
  money,
  numToField,
  parseAssignment,
} from "./shared";
import { SortTh, Th, type SortDir } from "./parts";

/** Pola liczbowe wiersza — kolejność zgodna z kolumnami tabeli. */
type NumericField =
  | "nightHours"
  | "workedHours"
  | "uwHours"
  | "l4Hours"
  | "maxHours"
  | "deductions"
  | "bonuses";
/**
 * `assignment` to JEDNO pole logiczne obejmujące obiekt i dział: w wierszu
 * mieszka pod nim jeden select, jeden brudnopis i jedna komórka nawigacji
 * Enterem, mimo że w payloadzie rozkłada się na dwa rozłączne id.
 */
type EditableField = NumericField | "assignment" | "notes";

/** Stan wypełnienia wiersza — filtr „co jeszcze zostało do zrobienia". */
type FillFilter = "all" | "filled" | "empty" | "uncertain";

/** Kolumny, po których wolno sortować (notatka i akcje nie mają sensu). */
type SortKey = "employee" | "assignment" | NumericField;

/** Domyślny kierunek kolumny — godziny i kwoty czyta się od największych. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  employee: "asc",
  assignment: "asc",
  nightHours: "desc",
  workedHours: "desc",
  uwHours: "desc",
  l4Hours: "desc",
  maxHours: "desc",
  deductions: "desc",
  bonuses: "desc",
};

const EDIT_MODE_KEY = "kadry:godziny:tryb-edycji";

/** Wiersz ma wpisane godziny, gdy cokolwiek się w nim rozlicza. */
const isFilled = (r: HrHoursEntry) =>
  (r.workedHours ?? 0) > 0 || (r.uwHours ?? 0) > 0 || (r.l4Hours ?? 0) > 0;

/**
 * Etykieta przypisania wiersza. Dział wygrywa z obiektem, bo pola są rozłączne
 * i wypełniony `departmentName` znaczy, że obiektu tu nie ma. Jedna funkcja na
 * szukajkę, sortowanie i podgląd — trzy kopie rozjechałyby wyniki filtrów
 * z tym, co widać w tabeli.
 */
const assignmentLabel = (r: HrHoursEntry) => r.departmentName || r.objectName || "";

const rowToInput = (r: HrHoursEntry): HrHoursInput => ({
  employeeId: r.employeeId,
  objectId: r.objectId,
  departmentId: r.departmentId,
  year: r.year,
  month: r.month,
  nightHours: r.nightHours,
  workedHours: r.workedHours,
  uwHours: r.uwHours,
  l4Hours: r.l4Hours,
  maxHours: r.maxHours,
  deductions: r.deductions,
  bonuses: r.bonuses,
  notes: r.notes,
});

const cellValue = (r: HrHoursEntry, field: EditableField): string => {
  if (field === "assignment") return formatAssignment(r);
  if (field === "notes") return r.notes ?? "";
  return numToField(r[field]);
};

export function HrHoursTab({
  rows,
  objects,
  departments,
  editable,
  loading,
  monthNav,
  onRowSaved,
  onAdd,
  onEdit,
  onDelete,
}: {
  rows: HrHoursEntry[];
  objects: HrObject[];
  /** Słownik działów — druga grupa w selekcie przypisania. */
  departments: HrDepartment[];
  editable: boolean;
  loading: boolean;
  /** Przełącznik miesiąca — wspólny dla całego modułu, wstawiany w pasek. */
  monthNav: React.ReactNode;
  /** Wiersz zapisany inline — rodzic podmienia go w swoim stanie miesiąca. */
  onRowSaved: (id: number, saved: HrHoursEntry) => void;
  onAdd: () => void;
  onEdit: (row: HrHoursEntry) => void;
  onDelete: (row: HrHoursEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState<"all" | number>("all");
  /**
   * Filtr przypisania na tych samych tokenach co komórka: `all` — wszystko,
   * `none` — ani obiekt, ani dział, `o:<id>` / `d:<id>` — konkretna pozycja.
   */
  const [assignmentFilter, setAssignmentFilter] = useState<string>("all");
  const [fillFilter, setFillFilter] = useState<FillFilter>("all");
  const [sort, setSort] = useState<SortKey>("employee");
  const [dir, setDir] = useState<SortDir>("asc");

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego. */
  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  // Tryb edycji przeżywa przeładowanie: kadrowa wchodzi tu, żeby wpisywać
  // godziny, i nie ma jej co witać podglądem po każdym odświeżeniu.
  const [editModePref, setEditModePref] = useState(() => {
    try {
      return localStorage.getItem(EDIT_MODE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const editMode = editable && editModePref;
  const setEditMode = (on: boolean) => {
    setEditModePref(on);
    try {
      localStorage.setItem(EDIT_MODE_KEY, on ? "1" : "0");
    } catch {
      // tryb prywatny / zablokowane dane witryny — preferencja tylko na sesję
    }
  };

  /** Brudnopis komórek: `${id}:${field}` → tekst wpisany, jeszcze niezapisany. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<number, boolean>>({});
  const [savedAt, setSavedAt] = useState<Record<number, number>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  // Esc ma cofnąć zmianę, a nie zapisać ją przy okazji utraty focusu.
  const skipBlurRef = useRef<string | null>(null);
  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
    },
    [],
  );

  const employeeOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) m.set(r.employeeId, r.employeeName);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));
  }, [rows]);

  // Listy w filtrze pochodzą z wpisów miesiąca, a nie z całego słownika:
  // filtr ma zawężać to, co widać, a nie oferować puste wyniki. Obiekty
  // i działy są rozdzielone, bo w selekcie stoją w osobnych grupach.
  const assignmentOptions = useMemo(() => {
    const objs = new Map<string, string>();
    const deps = new Map<string, string>();
    for (const r of rows) {
      if (r.departmentId != null) deps.set(formatAssignment(r), assignmentLabel(r));
      else if (r.objectId != null) objs.set(formatAssignment(r), assignmentLabel(r));
    }
    const toList = (m: Map<string, string>) =>
      [...m.entries()]
        .map(([token, label]) => ({ token, label }))
        .sort((a, b) => a.label.localeCompare(b.label, "pl"));
    return { objects: toList(objs), departments: toList(deps) };
  }, [rows]);

  /** Obiekty do wyboru w komórce: aktywne + ten już wpisany w wierszu. */
  const objectChoices = (row: HrHoursEntry) =>
    objects.filter((o) => o.active || o.id === row.objectId);

  /**
   * Działy do wyboru w komórce — ta sama reguła co przy obiektach:
   * zdezaktywowany dział znika z podpowiedzi, ale musi zostać widoczny
   * na wierszu, który już go używa, inaczej select pokazałby pustkę.
   */
  const departmentChoices = (row: HrHoursEntry) =>
    departments.filter((d) => d.active || d.id === row.departmentId);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (
        q &&
        !`${r.employeeName} ${assignmentLabel(r)} ${r.notes ?? ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      if (employeeFilter !== "all" && r.employeeId !== employeeFilter) return false;
      if (assignmentFilter === "none" && formatAssignment(r) !== "") return false;
      if (
        assignmentFilter !== "all" &&
        assignmentFilter !== "none" &&
        formatAssignment(r) !== assignmentFilter
      )
        return false;
      if (fillFilter === "filled" && !isFilled(r)) return false;
      if (fillFilter === "empty" && isFilled(r)) return false;
      if (fillFilter === "uncertain" && !r.objectUncertain) return false;
      return true;
    });

    // Puste komórki zawsze na końcu, niezależnie od kierunku: sortowanie ma
    // wyciągnąć na wierzch to, co wpisane, a nie zasypać ekran dziurami.
    const blank = (r: HrHoursEntry) =>
      sort === "employee"
        ? false
        : sort === "assignment"
          ? assignmentLabel(r) === ""
          : r[sort] == null;
    const factor = dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (blank(a) !== blank(b)) return blank(a) ? 1 : -1;
      let d = 0;
      if (sort === "employee") d = a.employeeName.localeCompare(b.employeeName, "pl");
      else if (sort === "assignment")
        d = assignmentLabel(a).localeCompare(assignmentLabel(b), "pl");
      else d = (a[sort] ?? 0) - (b[sort] ?? 0);
      return (
        d * factor ||
        // Remis rozstrzyga stała kolejność, żeby wiersze nie skakały przy
        // każdym zapisie (jedna osoba ma zwykle kilka wpisów w miesiącu).
        a.employeeName.localeCompare(b.employeeName, "pl") ||
        assignmentLabel(a).localeCompare(assignmentLabel(b), "pl") ||
        a.id - b.id
      );
    });
  }, [rows, search, employeeFilter, assignmentFilter, fillFilter, sort, dir]);

  const filtersActive =
    search !== "" ||
    employeeFilter !== "all" ||
    assignmentFilter !== "all" ||
    fillFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setEmployeeFilter("all");
    setAssignmentFilter("all");
    setFillFilter("all");
  };

  const sum = (pick: (r: HrHoursEntry) => number | null) =>
    visible.reduce((s, r) => s + (pick(r) ?? 0), 0);

  const uncertainCount = rows.filter((r) => r.objectUncertain).length;
  const emptyCount = rows.filter((r) => !isFilled(r)).length;

  const summaryLine = [
    `${visible.length}${visible.length === rows.length ? "" : ` z ${rows.length}`} wpisów`,
    `${hrs(sum((r) => r.workedHours))} h wypracowanych`,
    emptyCount > 0 ? `${emptyCount} bez godzin` : null,
    uncertainCount > 0 ? `${uncertainCount} do potwierdzenia przypisania` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // --- edycja inline ---

  const draftKey = (id: number, field: EditableField) => `${id}:${field}`;

  const shown = (r: HrHoursEntry, field: EditableField) =>
    drafts[draftKey(r.id, field)] ?? cellValue(r, field);

  const setDraft = (r: HrHoursEntry, field: EditableField, value: string) =>
    setDrafts((p) => ({ ...p, [draftKey(r.id, field)]: value }));

  const dropDraft = (r: HrHoursEntry, field: EditableField) =>
    setDrafts((p) => {
      const next = { ...p };
      delete next[draftKey(r.id, field)];
      return next;
    });

  /**
   * Zapis pojedynczej komórki. Wysyłamy cały wiersz (backend waliduje wpis
   * jako całość), a `expectedUpdatedAt` pilnuje, żeby nie nadpisać cudzej
   * zmiany. Brak zmiany = brak żądania: przejście Tabem przez tabelę nie ma
   * generować kilkudziesięciu PUT-ów.
   */
  const commit = async (r: HrHoursEntry, field: EditableField, value: string) => {
    const before = cellValue(r, field);
    const normalized =
      field === "assignment" || field === "notes"
        ? value.trim()
        : numToField(fieldToNum(value));
    const beforeNormalized =
      field === "assignment" || field === "notes"
        ? before.trim()
        : numToField(fieldToNum(before));
    if (normalized === beforeNormalized) {
      dropDraft(r, field);
      return;
    }

    const payload = rowToInput(r);
    if (field === "notes") payload.notes = value;
    else if (field === "assignment") {
      // Wysyłamy OBA pola (jedno zawsze null): PUT nadpisuje cały wiersz, więc
      // przełączenie obiekt→dział musi jawnie wyzerować poprzednie
      // przypisanie — inaczej wpis wskazywałby oba naraz i backend odbiłby 400.
      const { objectId, departmentId } = parseAssignment(value);
      payload.objectId = objectId;
      payload.departmentId = departmentId;
    } else payload[field] = fieldToNum(value);

    setSaving((p) => ({ ...p, [r.id]: true }));
    setErrors((p) => {
      const next = { ...p };
      delete next[r.id];
      return next;
    });
    try {
      const res = await updateHrHours(r.id, {
        ...payload,
        expectedUpdatedAt: r.updatedAt,
      });
      dropDraft(r, field);
      if (res.data) onRowSaved(r.id, res.data);
      setSavedAt((p) => ({ ...p, [r.id]: Date.now() }));
      timersRef.current.push(
        window.setTimeout(
          () =>
            setSavedAt((p) => {
              const next = { ...p };
              delete next[r.id];
              return next;
            }),
          1600,
        ),
      );
    } catch (err) {
      // Brudnopis zostaje — wpisana wartość nie ma zniknąć razem z błędem.
      setErrors((p) => ({
        ...p,
        [r.id]: err instanceof Error ? err.message : "Błąd zapisu",
      }));
    } finally {
      setSaving((p) => {
        const next = { ...p };
        delete next[r.id];
        return next;
      });
    }
  };

  /**
   * Enter → ta sama kolumna niżej (Shift+Enter wyżej), Esc → cofnij wpis.
   * Enter sam niczego nie zapisuje — przenosi focus, a zapis robi `onBlur`
   * opuszczanego pola. Inaczej ta sama komórka leciała do backendu dwa razy:
   * drugi raz ze zdezaktualizowanym `expectedUpdatedAt`, czyli z 409.
   */
  const onCellKey = (
    e: React.KeyboardEvent<HTMLInputElement>,
    r: HrHoursEntry,
    rowIndex: number,
    field: EditableField,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const target = bodyRef.current?.querySelector<HTMLElement>(
        `[data-cell="${rowIndex + (e.shiftKey ? -1 : 1)}:${field}"]`,
      );
      if (target) {
        target.focus();
        if (target instanceof HTMLInputElement) target.select();
      } else {
        e.currentTarget.blur();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      skipBlurRef.current = draftKey(r.id, field);
      dropDraft(r, field);
      e.currentTarget.blur();
    }
  };

  const onCellBlur = (
    e: React.FocusEvent<HTMLInputElement>,
    r: HrHoursEntry,
    field: EditableField,
  ) => {
    if (skipBlurRef.current === draftKey(r.id, field)) {
      skipBlurRef.current = null;
      return;
    }
    void commit(r, field, e.currentTarget.value);
  };

  const numCell = (
    r: HrHoursEntry,
    rowIndex: number,
    field: NumericField,
    className?: string,
  ) => (
    <td className="px-1.5 py-1 text-right">
      <Input
        data-cell={`${rowIndex}:${field}`}
        className={cn("ml-auto h-8 w-[74px] text-right tabular-nums", className)}
        inputMode="decimal"
        value={shown(r, field)}
        onChange={(e) => setDraft(r, field, e.target.value)}
        onBlur={(e) => onCellBlur(e, r, field)}
        onKeyDown={(e) => onCellKey(e, r, rowIndex, field)}
        onFocus={(e) => e.currentTarget.select()}
      />
    </td>
  );

  /** Ikona stanu zapisu wiersza — zamiast toastów przy każdej komórce. */
  const rowStatus = (r: HrHoursEntry) => {
    if (saving[r.id])
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    if (errors[r.id])
      return (
        <span title={errors[r.id]} className="cursor-help">
          <AlertTriangle className="h-4 w-4 text-destructive" />
        </span>
      );
    if (savedAt[r.id]) return <Check className="h-4 w-4 text-emerald-600" />;
    return null;
  };

  const colCount = 11;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {monthNav}
        <div className="relative min-w-[200px] max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Szukaj: pracownik / obiekt / dział / notatka…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="hours-filter-search"
          />
        </div>

        <Select
          value={employeeFilter === "all" ? "all" : String(employeeFilter)}
          onValueChange={(v) => setEmployeeFilter(v === "all" ? "all" : parseInt(v))}
        >
          <SelectTrigger className="w-[210px]" data-testid="hours-filter-employee">
            <SelectValue placeholder="Pracownik" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy pracownicy</SelectItem>
            {employeeOptions.map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={assignmentFilter} onValueChange={setAssignmentFilter}>
          <SelectTrigger className="w-[230px]" data-testid="hours-filter-assignment">
            <SelectValue placeholder="Obiekt / dział" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie przypisania</SelectItem>
            <SelectItem value="none">Bez przypisania</SelectItem>
            {assignmentOptions.objects.length > 0 && (
              <SelectGroup>
                <SelectLabel>Obiekty</SelectLabel>
                {assignmentOptions.objects.map((o) => (
                  <SelectItem key={o.token} value={o.token}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {assignmentOptions.departments.length > 0 && (
              <SelectGroup>
                <SelectLabel>Działy</SelectLabel>
                {assignmentOptions.departments.map((d) => (
                  <SelectItem key={d.token} value={d.token}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>

        <Select value={fillFilter} onValueChange={(v) => setFillFilter(v as FillFilter)}>
          <SelectTrigger className="w-[210px]" data-testid="hours-filter-fill">
            <SelectValue placeholder="Wypełnienie" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie wpisy</SelectItem>
            <SelectItem value="filled">Z godzinami</SelectItem>
            <SelectItem value="empty">Bez godzin</SelectItem>
            <SelectItem value="uncertain">Przypisanie do potwierdzenia</SelectItem>
          </SelectContent>
        </Select>

        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="hours-filters-clear"
          >
            <X className="mr-1 h-4 w-4" />
            Wyczyść filtry
          </Button>
        )}

        {editable && (
          <div className="ml-auto flex items-center gap-2">
            {/* Przełącznik trybu: podgląd czyta się lepiej, edycja pozwala
                wpisywać godziny bez otwierania dialogu na każdy wiersz. */}
            <div className="flex overflow-hidden rounded-md border">
              {(
                [
                  [false, "Podgląd", Eye],
                  [true, "Edycja", PencilLine],
                ] as const
              ).map(([mode, label, Icon]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setEditMode(mode)}
                  data-testid={`hours-mode-${mode ? "edit" : "view"}`}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-2 text-sm",
                    editMode === mode
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
            <Button onClick={onAdd}>
              <Plus className="mr-2 h-4 w-4" />
              Dodaj godziny
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span data-testid="hours-summary">{summaryLine}</span>
        {editMode && (
          <span className="text-xs">
            Tryb edycji: zapis po wyjściu z pola · Enter — niżej · Shift+Enter —
            wyżej · Esc — cofnij
          </span>
        )}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className={cn("w-full text-sm", editMode ? "min-w-[1220px]" : "min-w-[1080px]")}>
            <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <SortTh
                  label="Pracownik"
                  sortKey="employee"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Pracownik, którego dotyczy wpis (jedna osoba może mieć kilka wpisów w miesiącu — sumują się). Zmiana osoby tylko w formularzu wpisu."
                />
                <SortTh
                  label="Obiekt / dział"
                  sortKey="assignment"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Obiekt (posterunek) albo dział firmy — wpis wskazuje jedno albo drugie. Informacyjne, nie wpływa na kalkulację wypłaty; godziny działu są kosztem ogólnym, nie kosztem klienta."
                />
                <SortTh
                  label="Nocne"
                  sortKey="nightHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Godziny nocne — informacyjne, nie wchodzą do kalkulacji"
                  align="right"
                />
                <SortTh
                  label="Wyprac."
                  sortKey="workedHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Godziny wypracowane — podstawa fakt godzin i nadwyżki dodatku"
                  align="right"
                />
                <SortTh
                  label="UW"
                  sortKey="uwHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Urlop wypoczynkowy (h) — wlicza się do godzin rozliczanych"
                  align="right"
                />
                <SortTh
                  label="L4"
                  sortKey="l4Hours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Chorobowe (h) — wlicza się przy umowie o pracę (oraz do nadwyżki dodatku przy zleceniu w ALFA)"
                  align="right"
                />
                <SortTh
                  label="Godz. maks"
                  sortKey="maxHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Indywidualny limit godzin — przy UoP zastępuje normę miesiąca (brany największy wpis z miesiąca)"
                  align="right"
                />
                <SortTh
                  label="Potrącenia"
                  sortKey="deductions"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Potrącenia (zł) — pomniejszają premię/potrącenie w wynagrodzeniu"
                  align="right"
                />
                <SortTh
                  label="Dodatki"
                  sortKey="bonuses"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Dodatki/premie (zł) — powiększają premię/potrącenie w wynagrodzeniu"
                  align="right"
                />
                <Th>Notatka</Th>
                <Th className="w-24" />
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={colCount}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    {loading
                      ? "Ładowanie…"
                      : filtersActive
                        ? "Brak wpisów dla wybranych filtrów"
                        : "Brak wpisów godzin w tym miesiącu"}
                  </td>
                </tr>
              ) : editMode ? (
                visible.map((r, idx) => (
                  <tr
                    key={r.id}
                    className={cn(
                      "border-b",
                      errors[r.id] && "bg-destructive/5",
                      !errors[r.id] && savedAt[r.id] && "bg-emerald-500/5",
                    )}
                  >
                    <td className="whitespace-nowrap px-3 py-1 font-medium">
                      {r.employeeName}
                    </td>
                    <td className="px-1.5 py-1">
                      {/* Jeden select na dwa słowniki: natywny, więc optgroup
                          działa bez obejść, a wartością opcji jest token
                          `o:`/`d:` — samo id nie odróżniłoby obiektu 5 od
                          działu 5. */}
                      <select
                        data-cell={`${idx}:assignment`}
                        className={cn(
                          TABLE_SELECT_CLS,
                          "h-8",
                          r.objectUncertain && "border-amber-500 text-amber-700",
                        )}
                        title={
                          r.objectUncertain
                            ? "Przeniesione z poprzedniego miesiąca — zapis wpisu potwierdza przypisanie"
                            : undefined
                        }
                        value={shown(r, "assignment")}
                        onChange={(e) => {
                          setDraft(r, "assignment", e.target.value);
                          void commit(r, "assignment", e.target.value);
                        }}
                      >
                        <option value="">—</option>
                        <optgroup label="Obiekty">
                          {objectChoices(r).map((o) => (
                            <option key={o.id} value={`o:${o.id}`}>
                              {o.name}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Działy">
                          {departmentChoices(r).map((d) => (
                            <option key={d.id} value={`d:${d.id}`}>
                              {d.label}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </td>
                    {numCell(r, idx, "nightHours")}
                    {numCell(r, idx, "workedHours", "font-medium")}
                    {numCell(r, idx, "uwHours")}
                    {numCell(r, idx, "l4Hours")}
                    {numCell(r, idx, "maxHours")}
                    {numCell(r, idx, "deductions", "text-red-600")}
                    {numCell(r, idx, "bonuses", "text-emerald-700")}
                    <td className="px-1.5 py-1">
                      <Input
                        data-cell={`${idx}:notes`}
                        className="h-8 min-w-[180px] text-xs"
                        value={shown(r, "notes")}
                        onChange={(e) => setDraft(r, "notes", e.target.value)}
                        onBlur={(e) => onCellBlur(e, r, "notes")}
                        onKeyDown={(e) => onCellKey(e, r, idx, "notes")}
                      />
                    </td>
                    <td className="px-3 py-1">
                      <div className="flex items-center justify-end gap-1">
                        {rowStatus(r)}
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Otwórz formularz wpisu"
                          onClick={() => onEdit(r)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Usuń wpis"
                          onClick={() => onDelete(r)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                visible.map((r) => (
                  <tr
                    key={r.id}
                    className={cn(
                      "border-b hover:bg-accent/50",
                      editable && "cursor-pointer",
                    )}
                    onClick={editable ? () => onEdit(r) : undefined}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-medium">
                      {r.employeeName}
                    </td>
                    <td className="px-3 py-2">
                      {r.departmentName || r.objectName || "—"}
                      {r.objectUncertain && (
                        <span
                          title="Przeniesione z poprzedniego miesiąca — potwierdź przypisanie zapisując wpis"
                          className="ml-1.5 cursor-help font-semibold text-amber-600"
                        >
                          ?
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.nightHours != null ? hrs(r.nightHours) : ""}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">
                      {r.workedHours != null ? hrs(r.workedHours) : ""}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.uwHours != null ? hrs(r.uwHours) : ""}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.l4Hours != null ? hrs(r.l4Hours) : ""}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.maxHours != null ? hrs(r.maxHours) : ""}
                    </td>
                    <td className="px-3 py-2 text-right text-red-600">
                      {r.deductions != null ? money(r.deductions) : ""}
                    </td>
                    <td className="px-3 py-2 text-right text-emerald-700">
                      {r.bonuses != null ? money(r.bonuses) : ""}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-xs text-muted-foreground">
                      {r.notes}
                    </td>
                    <td className="px-3 py-2">
                      {editable && (
                        <div
                          className="flex justify-end gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edytuj wpis"
                            onClick={() => onEdit(r)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Usuń wpis"
                            onClick={() => onDelete(r)}
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
            {visible.length > 0 && (
              <tfoot>
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-3 py-2" colSpan={2}>
                    Razem ({visible.length})
                  </td>
                  <td className="px-3 py-2 text-right">{hrs(sum((r) => r.nightHours))}</td>
                  <td className="px-3 py-2 text-right">{hrs(sum((r) => r.workedHours))}</td>
                  <td className="px-3 py-2 text-right">{hrs(sum((r) => r.uwHours))}</td>
                  <td className="px-3 py-2 text-right">{hrs(sum((r) => r.l4Hours))}</td>
                  <td />
                  <td className="px-3 py-2 text-right text-red-600">
                    {money(sum((r) => r.deductions))}
                  </td>
                  <td className="px-3 py-2 text-right text-emerald-700">
                    {money(sum((r) => r.bonuses))}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </CardContent>
      </Card>
    </>
  );
}
