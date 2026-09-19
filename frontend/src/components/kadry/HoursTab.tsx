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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  Clock,
  CornerRightDown,
  Eye,
  Loader2,
  Pencil,
  PencilLine,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { EntityHistory } from "./EntityHistory";
// Rezerwacja listy godzin: pasek właściciela + pigułka „kto edytuje”.
import { EditLockBar, LockHolderPill } from "./EditLockBar";
import { lockUntil, type HrLockDto } from "@/lib/hrLive";
import type { HrEditLock } from "./useEditLock";
import {
  EmptyRow,
  IconButton,
  KadryBadge,
  NUM_CELL_CLS,
  departmentTone,
  RowActions,
  TEXT_TONE,
  TFOOT_ROW_CLS,
  THEAD_CLS,
  TOOLBAR_BTN_CLS,
} from "./ui";
import { tip } from "@/components/ui/tooltip";
import {
  bulkSaveHrHours,
  carryOverHrHours,
  confirmHrHoursAssignments,
  getHrContracts,
  getHrNorms,
  updateHrHours,
  type HrContract,
  type HrDepartment,
  type HrHoursEntry,
  type HrHoursInput,
  type HrMonthNorm,
  type HrObject,
  type HrPortalKey,
} from "@/lib/api";
import {
  MONTH_NAMES,
  NUM_FIELD_ERROR,
  TABLE_SELECT_CLS,
  fieldToNum,
  hrs,
  isNumFieldValid,
  money,
  numToField,
} from "./shared";
import { SortTh, Th, type SortDir } from "./parts";
import { monthYearLabel } from "@/lib/plDates";
import { useConfirm } from "./useConfirm";
import { PasteHoursDialog } from "./PasteHoursDialog";

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
 * Dział i obiekt to DWA pola, nie jedno: obiekt należy do działu obiektowego
 * (OFI), a nie stoi zamiast działu. Kolejność wyboru jest wymuszona — najpierw
 * dział, obiekt tylko gdy ten dział ma obiekty.
 */
type EditableField = NumericField | "department" | "object" | "notes";

/** Stan wypełnienia wiersza — filtr „co jeszcze zostało do zrobienia". */
type FillFilter = "all" | "filled" | "empty" | "uncertain" | "warn";

/**
 * Pola, dla których znamy wartość z poprzedniego miesiąca (kolumna „pop.”,
 * Ctrl+D, kopiowanie zbiorcze i wklejka z arkusza). Reszta kolumn jest albo
 * limitem (godziny maks), albo kwotą — i jedno, i drugie zmienia się z innych
 * powodów niż grafik, więc przenoszenie ich z miesiąca na miesiąc byłoby
 * podpowiedzią wprowadzającą w błąd.
 */
const PREV_FIELDS = ["workedHours", "uwHours", "l4Hours", "nightHours"] as const;
type PrevField = (typeof PREV_FIELDS)[number];

const isPrevField = (f: EditableField): f is PrevField =>
  (PREV_FIELDS as readonly string[]).includes(f);

/** Kolumny, po których wolno sortować (notatka i akcje nie mają sensu). */
type SortKey = "employee" | "department" | "object" | NumericField;

/** Domyślny kierunek kolumny — godziny i kwoty czyta się od największych. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  employee: "asc",
  department: "asc",
  object: "asc",
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

/** Tekst do szukajki: obie etykiety naraz (dział i obiekt są niezależne). */
const assignmentLabel = (r: HrHoursEntry) =>
  [r.departmentName, r.objectName].filter(Boolean).join(" ");

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
  if (field === "department") return r.departmentId == null ? "" : String(r.departmentId);
  if (field === "object") return r.objectId == null ? "" : String(r.objectId);
  if (field === "notes") return r.notes ?? "";
  return numToField(r[field]);
};

export function HrHoursTab({
  rows,
  objects,
  departments,
  editable,
  lock,
  loading,
  monthNav,
  year,
  month,
  portal = null,
  showDepartment = true,
  showObject = true,
  rowExtras,
  onRowSaved,
  onChanged,
  onAdd,
  onEdit,
  onDelete,
}: {
  rows: HrHoursEntry[];
  objects: HrObject[];
  /** Słownik działów — druga grupa w selekcie przypisania. */
  departments: HrDepartment[];
  editable: boolean;
  /**
   * Rezerwacja listy godzin (`useEditLock` w Kadry.tsx). Tryb edycji wymaga
   * jej posiadania: backend odrzuca zapisy bez rezerwacji (423), więc pola
   * bez niej byłyby obietnicą bez pokrycia.
   */
  lock: HrEditLock;
  loading: boolean;
  /** Przełącznik miesiąca — wspólny dla całego modułu, wstawiany w pasek. */
  monthNav: React.ReactNode;
  year: number;
  month: number;
  /**
   * SEKCJA DZIAŁOWA („Godziny działu”, src/lib/hr-scope.ts). `null` = pełne
   * Kadry. Leci przy każdym zapisie i przy historii wpisu — to on mówi
   * backendowi, w czyim imieniu piszemy (bez niego konto sekcji dostaje 403).
   */
  portal?: HrPortalKey | null;
  /**
   * Kolumna i filtr „Dział”. Sensowne tylko tam, gdzie działów jest więcej niż
   * jeden: w sekcji CMA select z jedną pozycją byłby pytaniem bez wyboru
   * (dział i tak ustawia się sam przy zapisie).
   */
  showDepartment?: boolean;
  /**
   * Kolumna i filtr „Obiekt”. Posterunki istnieją wyłącznie w dziale
   * obiektowym (OFI) — pozostałe sekcje rozliczają pracę działową i kolumna
   * byłaby u nich pustą szpaltą na całą szerokość tabeli.
   */
  showObject?: boolean;
  /**
   * Dodatkowe akcje wiersza (obok historii wpisu i kosza). Mini-Kadry sekcji
   * wstawiają tu historię PRACOWNIKA — w pełnych Kadrach mieszka ona
   * w kartotece, której sekcja nie ma.
   */
  rowExtras?: (row: HrHoursEntry) => React.ReactNode;
  /** Wiersz zapisany inline — rodzic podmienia go w swoim stanie miesiąca. */
  onRowSaved: (id: number, saved: HrHoursEntry) => void;
  /** Operacja zbiorcza (carry-over, potwierdzenie przypisań) — przeładuj miesiąc. */
  onChanged: () => void;
  onAdd: () => void;
  onEdit: (row: HrHoursEntry) => void;
  onDelete: (row: HrHoursEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState<"all" | number>("all");
/**
   * Dział i obiekt filtruje się osobno: `all` — wszystko, `none` — wiersze bez
   * przypisania, liczba — konkretna pozycja.
   */
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [objectFilter, setObjectFilter] = useState<string>("all");
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
  // Osobny klucz per sekcja: „Edycja” włączona w OFI nie ma otwierać pól
  // w pełnych Kadrach (i odwrotnie) — to dwie różne rezerwacje.
  const editModeKey = portal ? `${EDIT_MODE_KEY}:${portal}` : EDIT_MODE_KEY;
  const [editModePref, setEditModePref] = useState(() => {
    try {
      return localStorage.getItem(editModeKey) === "1";
    } catch {
      return false;
    }
  });
  // Tryb edycji = preferencja ORAZ rezerwacja listy. Bez `lock.mine` pola
  // byłyby otwarte, a każdy zapis wracał z 423 „listę edytuje ktoś inny”.
  const editMode = editable && editModePref && lock.mine;
  // `useCallback`, bo funkcja jest zależnością efektu „lista przyszła sama”
  // niżej: bez tego każdy render dawał nową referencję i efekt musiałby ją
  // przemilczeć wyłączoną regułą zamiast po prostu jej nie zmieniać.
  const rememberMode = useCallback(
    (on: boolean) => {
      setEditModePref(on);
      try {
        localStorage.setItem(editModeKey, on ? "1" : "0");
      } catch {
        // tryb prywatny / zablokowane dane witryny — preferencja tylko na sesję
      }
    },
    [editModeKey],
  );
  /**
   * Przełącznik trybu: „Edycja” najpierw REZERWUJE listę na 15 minut. Odmowa
   * (ktoś inny ją trzyma) otwiera okno „poprosić o zwolnienie?” i zostawia
   * ekran w podglądzie — preferencji nie zapisujemy, bo tryb się nie zmienił.
   */
  const setEditMode = (on: boolean) => {
    if (!on) {
      rememberMode(false);
      void lock.disable();
      return;
    }
    void lock.enable().then((ok) => {
      if (ok) rememberMode(true);
    });
  };

  // Zapamiętany tryb „Edycja” odtwarzamy po cichu przy wejściu i przy zmianie
  // miesiąca: rezerwacja jest na (lista, miesiąc), więc wrzesień nie użycza
  // niczego październikowi. Nieudana próba zostawia ekran w podglądzie
  // z pigułką „Edytuje: …” — bez okna, którego nikt nie wywołał.
  useEffect(() => {
    if (!editable || !editModePref || lock.mine) return;
    void lock.enable(true);
    // Tylko przy wejściu i zmianie okresu — reakcją na kliknięcia jest `setEditMode`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, editable]);

  // Lista przyszła SAMA po czekaniu (właściciel zwolnił po naszej prośbie) —
  // wtedy przełącznik ma wejść w tryb edycji bez drugiego kliknięcia. Zwykłe
  // wzięcie listy tego nie robi: tam tryb ustawia ten, kto kliknął.
  useEffect(() => {
    if (lock.granted > 0) rememberMode(true);
  }, [lock.granted, rememberMode]);

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
      if (r.departmentId != null) deps.set(String(r.departmentId), r.departmentName);
      if (r.objectId != null) objs.set(String(r.objectId), r.objectName);
    }
    const toList = (m: Map<string, string>) =>
      [...m.entries()]
        .map(([token, label]) => ({ token, label }))
        .sort((a, b) => a.label.localeCompare(b.label, "pl"));
    return { objects: toList(objs), departments: toList(deps) };
  }, [rows]);

  /**
   * Działy obiektowe (`hasObjects`) — tylko w nich wpis wskazuje obiekt.
   * Do czasu, aż backend odda flagę, rozpoznajemy dział OFI po nazwie: bez tego
   * select obiektu byłby zablokowany na wszystkich wierszach.
   */
  const isObjectDept = (d: HrDepartment | undefined) =>
    d != null && (d.hasObjects === true || (d.hasObjects == null && d.name === "OFI"));
  const objectDepartments = departments.filter(isObjectDept);
  const rowDepartment = (r: HrHoursEntry, draftId?: string) => {
    const id = draftId !== undefined && draftId !== "" ? Number(draftId) : r.departmentId;
    return departments.find((d) => d.id === id);
  };

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

  /**
   * Rezerwacja, która blokuje TEN wiersz — albo `null`, gdy jest nasz.
   * Wiersz należy do sekcji swojego działu (`hr_departments.portal`), więc gdy
   * OFI wypełnia swoje godziny, pozostałe wiersze listy zostają do pisania,
   * a te są wygaszone. Liczymy tylko wtedy, gdy jest co blokować.
   */
  const rowLockOf = (r: HrHoursEntry): HrLockDto | null => {
    if (lock.excluded.length === 0) return null;
    const portal =
      r.departmentId == null
        ? null
        : (departments.find((d) => d.id === r.departmentId)?.portal ?? null);
    return lock.lockedBy(portal);
  };

  // --- ostrzeżenia wiersza (liczone na froncie, bez dodatkowego endpointu) ---

  /**
   * Normy miesiąca i umowy — potrzebne WYŁĄCZNIE do reguły „ponad normę".
   * Czyta je tylko pełne Kadry (`portal == null`): sekcja działowa nie ma klucza
   * ani do norm, ani do umów, więc tam ta jedna reguła po prostu nie działa
   * (pozostałe liczą się dalej). Błąd odczytu też wyłącza regułę — ostrzeżenie
   * jest pomocą, a nie powodem, żeby zepsuć ekran godzin.
   */
  const [norms, setNorms] = useState<HrMonthNorm[]>([]);
  const [contracts, setContracts] = useState<HrContract[]>([]);
  useEffect(() => {
    if (portal != null) return;
    let alive = true;
    void Promise.all([getHrNorms(year), getHrContracts()])
      .then(([n, ct]) => {
        if (!alive) return;
        setNorms(n.data ?? []);
        setContracts(ct.data ?? []);
      })
      .catch(() => {
        if (alive) setNorms([]);
      });
    return () => {
      alive = false;
    };
  }, [portal, year]);

  /** Dni miesiąca — dzień zerowy następnego miesiąca to ostatni dzień tego. */
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthNorm = norms.find((n) => n.year === year && n.month === month) ?? null;

  /**
   * Umowy obowiązujące W TYM MIESIĄCU, per pracownik. Umowa sprzed roku nie
   * mówi nic o normie, którą rozlicza się wrzesień — a to ona decyduje, czy
   * patrzeć na normę pracy czy zlecenia.
   */
  const contractsByEmployee = useMemo(() => {
    const mm = String(month).padStart(2, "0");
    const start = `${year}-${mm}-01`;
    const end = `${year}-${mm}-${String(daysInMonth).padStart(2, "0")}`;
    const m = new Map<number, HrContract[]>();
    for (const ct of contracts) {
      if (!ct.active) continue;
      if (ct.validFrom && ct.validFrom > end) continue;
      if (ct.validTo && ct.validTo < start) continue;
      const list = m.get(ct.employeeId);
      if (list) list.push(ct);
      else m.set(ct.employeeId, [ct]);
    }
    return m;
  }, [contracts, year, month, daysInMonth]);

  /**
   * Ostrzeżenia wiersza — pełne zdania, bo lądują w dymku i mają powiedzieć, co
   * jest nie tak, a nie tylko, ŻE coś jest. Dwie reguły:
   *  • ponad normę BEZ rodzaju dodatku w umowie — nadwyżka nie ma się z czego
   *    rozliczyć, więc albo godziny są pomyłką, albo umowie brakuje dodatku,
   *  • więcej godzin niż doba razy liczba dni miesiąca — fizycznie niemożliwe,
   *    czyli literówka (168 → 1680) albo wpis wklejony dwa razy.
   * Pusty wiersz i niepotwierdzone przypisanie ostrzeżeniem NIE są: pierwszy
   * jest w stopce, drugi ma swój „?" przy przypisaniu.
   */
  const warnings = useMemo(() => {
    const maxPhysical = daysInMonth * 24;
    const out = new Map<number, string[]>();
    for (const r of rows) {
      const list: string[] = [];
      const worked = r.workedHours ?? 0;
      const cts = contractsByEmployee.get(r.employeeId) ?? [];
      if (monthNorm && cts.length > 0 && worked > 0) {
        // Praca ma wyższą normę niż zlecenie — gdy ktoś ma oba rodzaje umów,
        // bierzemy tę łagodniejszą, żeby nie ostrzegać o czymś, co się mieści.
        const norm = cts.some((ct) => ct.contractType === "praca")
          ? monthNorm.workNorm
          : monthNorm.contractNorm;
        const noBonus = cts.every((ct) => ct.bonusType === "brak");
        if (worked > norm && noBonus) {
          list.push(
            `Wypracowane ${hrs(worked)} h ponad normę miesiąca (${hrs(norm)} h), a umowa nie ma rodzaju dodatku — nadwyżka nie ma się z czego rozliczyć`,
          );
        }
      }
      const total = worked + (r.uwHours ?? 0) + (r.l4Hours ?? 0);
      if (total > maxPhysical) {
        list.push(
          `Wypracowane + urlop + chorobowe to ${hrs(total)} h, a ${MONTH_NAMES[month - 1].toLowerCase()} ma ${daysInMonth} dni, czyli najwyżej ${maxPhysical} h — sprawdź, czy to nie literówka`,
        );
      }
      if (list.length > 0) out.set(r.id, list);
    }
    return out;
  }, [rows, contractsByEmployee, monthNorm, daysInMonth, month]);

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
      if (departmentFilter === "none" && r.departmentId != null) return false;
      if (
        departmentFilter !== "all" &&
        departmentFilter !== "none" &&
        String(r.departmentId ?? "") !== departmentFilter
      )
        return false;
      if (objectFilter === "none" && r.objectId != null) return false;
      if (
        objectFilter !== "all" &&
        objectFilter !== "none" &&
        String(r.objectId ?? "") !== objectFilter
      )
        return false;
      if (fillFilter === "filled" && !isFilled(r)) return false;
      if (fillFilter === "empty" && isFilled(r)) return false;
      if (fillFilter === "uncertain" && !r.objectUncertain) return false;
      if (fillFilter === "warn" && !warnings.has(r.id)) return false;
      return true;
    });

    // Puste komórki zawsze na końcu, niezależnie od kierunku: sortowanie ma
    // wyciągnąć na wierzch to, co wpisane, a nie zasypać ekran dziurami.
    const blank = (r: HrHoursEntry) =>
      sort === "employee"
        ? false
        : sort === "department"
          ? r.departmentName === ""
          : sort === "object"
            ? r.objectName === ""
            : r[sort] == null;
    const factor = dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (blank(a) !== blank(b)) return blank(a) ? 1 : -1;
      let d = 0;
      if (sort === "employee") d = a.employeeName.localeCompare(b.employeeName, "pl");
      else if (sort === "department")
        d = a.departmentName.localeCompare(b.departmentName, "pl");
      else if (sort === "object") d = a.objectName.localeCompare(b.objectName, "pl");
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
  }, [
    rows,
    search,
    employeeFilter,
    departmentFilter,
    objectFilter,
    fillFilter,
    warnings,
    sort,
    dir,
  ]);

  const filtersActive =
    search !== "" ||
    employeeFilter !== "all" ||
    departmentFilter !== "all" ||
    objectFilter !== "all" ||
    fillFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setEmployeeFilter("all");
    setDepartmentFilter("all");
    setObjectFilter("all");
    setFillFilter("all");
  };

  const sum = (pick: (r: HrHoursEntry) => number | null) =>
    visible.reduce((s, r) => s + (pick(r) ?? 0), 0);

  const uncertainCount = rows.filter((r) => r.objectUncertain).length;
  const emptyCount = rows.filter((r) => !isFilled(r)).length;
  const warnCount = warnings.size;

  // --- operacje zbiorcze miesiąca (carry-over, potwierdzenie przypisań) ---
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [pasteOpen, setPasteOpen] = useState(false);
  /** Niepotwierdzone przypisania w TYM, co widać — przycisk działa na widok. */
  const visibleUncertain = visible.filter((r) => r.objectUncertain);

  /**
   * Carry-over zostawia ~130 wierszy z pytajnikiem „przypisanie do
   * potwierdzenia". Dotąd zdejmowało się go zapisując każdy wpis z osobna —
   * a zwykle wszystkie przypisania są w porządku (ci sami ludzie, te same
   * posterunki) i chodzi o jedno „tak" na całą listę.
   */
  const confirmAssignments = async () => {
    // Zbiorcze potwierdzenie to zapis jak każdy inny — bez rezerwacji listy
    // backend odmówi (423), więc bierzemy ją na czas operacji.
    if (!(await lock.ensure())) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await confirmHrHoursAssignments(visibleUncertain.map((r) => r.id), portal);
      onChanged();
    } catch (err) {
      setBulkError(
        err instanceof Error ? err.message : "Nie udało się potwierdzić przypisań",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  /**
   * Ręczne przeniesienie pracowników z poprzedniego miesiąca. Automat próbuje
   * raz na sesję i tylko dla miesiąca pustego — po odrzuceniu (albo po
   * usunięciu wszystkich wierszy) nie ma innej drogi niż wpisywanie od zera.
   */
  const carryOver = async () => {
    if (!(await lock.ensure())) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const res = await carryOverHrHours(year, month, portal);
      if ((res.data?.inserted ?? 0) === 0) {
        setBulkError(
          "Poprzedni miesiąc nie ma wpisów z godzinami do przeniesienia",
        );
        return;
      }
      onChanged();
    } catch (err) {
      setBulkError(
        err instanceof Error ? err.message : "Nie udało się przenieść wpisów",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  // --- poprzedni miesiąc: kolumna „pop.”, Ctrl+D i kopiowanie zbiorcze ---

  /**
   * „sierpień 2026" — MAŁĄ literą, bo nazwa miesiąca stoi zawsze w środku
   * zdania. Zdania są przy tym tak ułożone, żeby miesiąc szedł w nawiasie
   * (mianownik): „z sierpień 2026" byłoby po polsku błędem, a odmiany nazw
   * miesięcy front nie ma (dopełniacz mieszka tylko w `src/routes/hr.ts`).
   */
  const prevLabel = monthYearLabel(
    month === 1 ? year - 1 : year,
    month === 1 ? 12 : month - 1,
  );

  /**
   * Wartość tego pola z poprzedniego miesiąca — `null`, gdy wtedy jej nie było.
   * ZERO też znaczy „nie ma czego pokazać": „pop. 0" pod pustą komórką jest
   * szumem, a Ctrl+D wstawiające zero byłoby akcją, której nikt nie zamawiał
   * (tak samo traktuje zerowe kwoty podpowiedź w Wynagrodzeniach).
   */
  const prevOf = (r: HrHoursEntry, field: PrevField): number | null =>
    r.prev?.[field] || null;

  /**
   * Wiersze, które „Skopiuj z poprzedniego miesiąca" faktycznie wypełni: puste
   * (bez wypracowanych) i mające co skopiować. Liczone z WIDOKU, jak
   * potwierdzanie przypisań — przycisk działa na to, co widać, więc filtr
   * pozwala skopiować godziny tylko jednemu działowi.
   */
  const copyTargets = visible.filter(
    (r) => (r.workedHours ?? 0) === 0 && (prevOf(r, "workedHours") ?? 0) > 0,
  );

  /**
   * Kopiowanie zbiorcze. Bez rezerwacji listy backend odmówi (423), więc
   * bierzemy ją na czas operacji — i dopiero po potwierdzeniu, bo to zapis
   * kilkudziesięciu wierszy naraz, którego nie da się cofnąć jednym Ctrl+Z.
   */
  const copyFromPrevMonth = () => {
    const n = copyTargets.length;
    confirm.ask({
      title: `Skopiować wypracowane z poprzedniego miesiąca?`,
      description: `${n} ${n === 1 ? "wiersz bez wypracowanych godzin dostanie wartość" : "wierszy bez wypracowanych godzin dostanie wartości"} z poprzedniego miesiąca (${prevLabel}). Wiersze z już wpisanymi godzinami zostaną bez zmian, urlop i chorobowe też.`,
      destructive: false,
      confirmLabel: "Skopiuj",
      onConfirm: async () => {
        if (!(await lock.ensure())) return;
        setBulkError(null);
        // Paczki po 500 — tyle przyjmuje `PUT /hr/hours/bulk` w jednej
        // transakcji, a duży miesiąc OFI potrafi mieć więcej wierszy.
        for (let i = 0; i < copyTargets.length; i += 500) {
          const chunk = copyTargets.slice(i, i + 500);
          await bulkSaveHrHours(
            {
              year,
              month,
              rows: chunk.map((r) => ({
                id: r.id,
                workedHours: prevOf(r, "workedHours"),
              })),
              expected: Object.fromEntries(chunk.map((r) => [r.id, r.updatedAt])),
            },
            portal,
          );
        }
        onChanged();
      },
    });
  };

  const summaryLine = [
    `${visible.length}${visible.length === rows.length ? "" : ` z ${rows.length}`} wpisów`,
    `${hrs(sum((r) => r.workedHours))} h wypracowanych`,
    emptyCount > 0 ? `${emptyCount} pustych` : null,
    warnCount > 0 ? `${warnCount} z ostrzeżeniami` : null,
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
    const textField =
      field === "department" || field === "object" || field === "notes";
    const normalized = textField ? value.trim() : numToField(fieldToNum(value));
    const beforeNormalized = textField
      ? before.trim()
      : numToField(fieldToNum(before));
    if (normalized === beforeNormalized) {
      dropDraft(r, field);
      return;
    }

    // Niepoprawna liczba NIE jedzie do backendu: brudnopis zostaje (czerwona
    // ramka z `numCell`), a wiersz dostaje komunikat. Wcześniej `fieldToNum`
    // czytał prefiks, więc „3 200,00” zapisywało się jako 3 — z ptaszkiem.
    if (!textField && !isNumFieldValid(value)) {
      setErrors((p) => ({ ...p, [r.id]: NUM_FIELD_ERROR }));
      return;
    }

    const payload = rowToInput(r);
    if (field === "notes") payload.notes = value;
    else if (field === "department") {
      payload.departmentId = value === "" ? null : Number(value);
      // Dział bez obiektów nie może ciągnąć za sobą posterunku — obiekt znika
      // razem ze zmianą działu, zamiast czekać na 400 z backendu.
      if (!isObjectDept(rowDepartment(r, value))) payload.objectId = null;
    } else if (field === "object") {
      payload.objectId = value === "" ? null : Number(value);
      // Obiekt bez działu: podstawiamy jedyny dział obiektowy (OFI). Backend
      // robi to samo, ale wtedy tabela pokazywałaby pusty dział do odświeżenia.
      if (payload.objectId != null && payload.departmentId == null && objectDepartments.length === 1) {
        payload.departmentId = objectDepartments[0].id;
      }
    } else payload[field] = fieldToNum(value);

    setSaving((p) => ({ ...p, [r.id]: true }));
    setErrors((p) => {
      const next = { ...p };
      delete next[r.id];
      return next;
    });
    try {
      const res = await updateHrHours(
        r.id,
        { ...payload, expectedUpdatedAt: r.updatedAt },
        portal,
      );
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
    // Ctrl+D — „skopiuj z góry" z arkuszy kalkulacyjnych, tyle że u nas z góry
    // znaczy Z POPRZEDNIEGO MIESIĄCA: to jego wartość jest tu punktem odniesienia
    // (wiersz wyżej należy do innej osoby). Działa na polu, w którym stoi kursor
    // — osobno dla wypracowanych, urlopu, chorobowego i godzin nocnych.
    if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
      if (!isPrevField(field)) return;
      const prev = prevOf(r, field);
      // Nie ma czego wstawić — nie przechwytujemy skrótu (w Chrome to „dodaj
      // zakładkę”, ale obiecywanie akcji, która nic nie zrobi, jest gorsze).
      if (prev == null) return;
      e.preventDefault();
      const value = numToField(prev);
      setDraft(r, field, value);
      void commit(r, field, value);
      return;
    }
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

  /**
   * „pop. 168" pod wartością wypracowanych — ten sam znacznik, co przy kwotach
   * w Wynagrodzeniach. Przy kilkuset przepisywanych liczbach zmiana rzędu
   * wielkości (168 → 1680) jest kwestią czasu, a w tabeli samych liczb niczego
   * nie widać; poprzedni miesiąc daje punkt odniesienia w tej samej linii wzroku.
   */
  const prevHint = (prev: number) => (
    <p
      className={cn("cursor-help text-right text-[11px] leading-tight", TEXT_TONE.muted)}
      data-testid="hours-prev-hint"
      {...tip(`Wypracowane w poprzednim miesiącu (${prevLabel}): ${hrs(prev)} h`)}
    >
      pop. {hrs(prev)}
    </p>
  );

  /** Ikona ostrzeżeń wiersza — dymek niesie pełną listę, po jednej na linię. */
  const rowWarning = (r: HrHoursEntry) => {
    const list = warnings.get(r.id);
    if (!list || list.length === 0) return null;
    return (
      <span
        className="ml-1 inline-flex cursor-help align-text-bottom"
        data-testid="hours-row-warning"
        {...tip(list.join("\n"))}
      >
        <AlertTriangle
          className={cn("h-3.5 w-3.5 shrink-0", TEXT_TONE.warn)}
          aria-label={list.join("; ")}
        />
      </span>
    );
  };

  const numCell = (
    r: HrHoursEntry,
    rowIndex: number,
    field: NumericField,
    className?: string,
  ) => {
    // Ocena „na żywo”, z brudnopisu: pole robi się czerwone już przy pisaniu,
    // a nie dopiero po nieudanej próbie zapisu.
    const raw = shown(r, field);
    const invalid = !isNumFieldValid(raw);
    // Poprzedni miesiąc: w PUSTYM polu jako placeholder (widać, co się wpisze
    // Ctrl+D, a mimo to pole zostaje puste), pod polem — tylko przy
    // wypracowanych, bo cztery szare linijki w wierszu to już nie podpowiedź,
    // tylko druga tabela.
    const prev = isPrevField(field) ? prevOf(r, field) : null;
    return (
    <td className="px-1.5 py-1 text-right">
      <Input
        data-cell={`${rowIndex}:${field}`}
        className={cn(
          "ml-auto h-8 w-[74px] text-right tabular-nums",
          invalid && "border-destructive text-destructive focus-visible:ring-destructive",
          className,
        )}
        aria-invalid={invalid || undefined}
        {...(invalid ? tip(NUM_FIELD_ERROR) : {})}
        inputMode="decimal"
        value={raw}
        placeholder={raw === "" && prev != null ? hrs(prev) : undefined}
        onChange={(e) => setDraft(r, field, e.target.value)}
        onBlur={(e) => onCellBlur(e, r, field)}
        onKeyDown={(e) => onCellKey(e, r, rowIndex, field)}
        onFocus={(e) => e.currentTarget.select()}
      />
      {/* Pole PUSTE mówi to samo placeholderem — dwie te same liczby jedna pod
          drugą byłyby tylko szumem. Linijka „pop." wraca, gdy w komórce już coś
          stoi: wtedy jest porównaniem, a nie powtórzeniem. */}
      {field === "workedHours" && prev != null && raw !== "" && prevHint(prev)}
    </td>
    );
  };

  /** Ikona stanu zapisu wiersza — zamiast toastów przy każdej komórce. */
  const rowStatus = (r: HrHoursEntry) => {
    if (saving[r.id])
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    if (errors[r.id])
      return (
        <span {...tip(errors[r.id])} className="cursor-help">
          <AlertTriangle className="h-4 w-4 text-destructive" />
        </span>
      );
    if (savedAt[r.id])
      return (
        <Check
          className={cn("h-4 w-4", TEXT_TONE.good)}
          role="status"
          aria-label="Zapisano"
        />
      );
    return null;
  };

  // Kolumny liczone, a nie wpisane na sztywno: sekcja z jednym działem chowa
  // „Dział”, a sekcja bez posterunków — „Obiekt”. Zły `colSpan` w pustym
  // wierszu i w stopce rozjeżdża całą tabelę, więc obie liczby biorą się stąd.
  const assignmentCols = (showDepartment ? 1 : 0) + (showObject ? 1 : 0);
  const colCount = 10 + assignmentCols;

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

        {/* Dział i obiekt osobno: obiekt należy DO działu (OFI), więc wspólna
            lista „wszystkie przypisania" mieszała dwa różne poziomy.
            W sekcji z jednym działem (CMA, Handlowy, Techniczny) oba filtry
            znikają razem z kolumnami — nie ma czego zawężać. */}
        {showDepartment && (
        <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
          <SelectTrigger
            className="w-[200px]"
            data-testid="kadry-godziny-filter-department"
          >
            <SelectValue placeholder="Dział" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie działy</SelectItem>
            <SelectItem value="none">Bez działu</SelectItem>
            {assignmentOptions.departments.map((d) => (
              <SelectItem key={d.token} value={d.token}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        )}

        {showObject && (
        <Select value={objectFilter} onValueChange={setObjectFilter}>
          <SelectTrigger
            className="w-[210px]"
            data-testid="kadry-godziny-filter-object"
          >
            <SelectValue placeholder="Obiekt" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie obiekty</SelectItem>
            <SelectItem value="none">Bez obiektu</SelectItem>
            {assignmentOptions.objects.map((o) => (
              <SelectItem key={o.token} value={o.token}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        )}

        <Select value={fillFilter} onValueChange={(v) => setFillFilter(v as FillFilter)}>
          <SelectTrigger className="w-[210px]" data-testid="hours-filter-fill">
            <SelectValue placeholder="Wypełnienie" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie wpisy</SelectItem>
            <SelectItem value="filled">Z godzinami</SelectItem>
            <SelectItem value="empty">Bez godzin</SelectItem>
            <SelectItem value="uncertain">Przypisanie do potwierdzenia</SelectItem>
            <SelectItem value="warn">Z ostrzeżeniami</SelectItem>
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
            {/* Kto trzyma listę — widoczne TAKŻE w podglądzie, żeby odmowa
                przy kliknięciu „Edycja” nie była zaskoczeniem. */}
            <LockHolderPill lock={lock} testId="hours-lock-pill" />
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

      {/* Pasek rezerwacji: „edytujesz tę listę”, prośba o zwolnienie i okno
          konfliktu. Sam decyduje, czy się pokazać. */}
      <EditLockBar
        lock={lock}
        onRelease={() => rememberMode(false)}
        testId="hours-lock-bar"
      />

      {editable &&
        (visibleUncertain.length > 0 ||
          rows.length === 0 ||
          copyTargets.length > 0 ||
          editMode) && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Kopiowanie z poprzedniego miesiąca: wypełnia SAME puste wiersze,
              więc nie ma czym nadpisać już wpisanej pracy. Wymaga rezerwacji
              listy — bierze ją dopiero po potwierdzeniu w oknie. */}
          {copyTargets.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className={TOOLBAR_BTN_CLS}
              disabled={bulkBusy}
              onClick={copyFromPrevMonth}
              data-testid="hours-copy-prev"
              {...tip(
                `Wypracowane z poprzedniego miesiąca (${prevLabel}) wpiszą się tam, gdzie ta kolumna jest pusta — te same osoby na tych samych przypisaniach. Wpisane godziny, urlop i chorobowe zostają bez zmian.`,
              )}
            >
              <CornerRightDown className="mr-1 h-4 w-4" />
              Skopiuj z poprzedniego miesiąca ({copyTargets.length} pustych)
            </Button>
          )}
          {editMode && (
            <Button
              variant="outline"
              size="sm"
              className={TOOLBAR_BTN_CLS}
              disabled={bulkBusy}
              onClick={() => {
                void lock.ensure().then((ok) => {
                  if (ok) setPasteOpen(true);
                });
              }}
              data-testid="hours-paste-open"
              {...tip(
                "Wklej kolumny z grafiku (nazwisko, opcjonalnie obiekt/dział, godziny) — przed zapisem zobaczysz, co się dopasowało",
              )}
            >
              <ClipboardPaste className="mr-1 h-4 w-4" />
              Wklej z arkusza
            </Button>
          )}
          {visibleUncertain.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={bulkBusy}
              onClick={confirmAssignments}
              data-testid="hours-confirm-assignments"
              {...tip("Zdejmuje znak zapytania z przypisań przeniesionych z poprzedniego miesiąca")}
            >
              <Check className="mr-1 h-4 w-4" />
              Potwierdź przypisania ({visibleUncertain.length})
            </Button>
          )}
          {rows.length === 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={bulkBusy || loading}
              onClick={carryOver}
              data-testid="hours-carry-over"
            >
              {bulkBusy
                ? "Przenoszenie…"
                : "Przenieś pracowników z poprzedniego miesiąca"}
            </Button>
          )}
          {bulkError && <span className="text-sm text-destructive">{bulkError}</span>}
        </div>
      )}

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
          <table
            className={cn(
              "w-full text-sm",
              // Ukryte kolumny przypisania zwężają tabelę — inaczej sekcja
              // z jednym działem miałaby poziomy pasek przewijania bez powodu.
              editMode
                ? assignmentCols === 2
                  ? "min-w-[1400px]"
                  : assignmentCols === 1
                    ? "min-w-[1200px]"
                    : "min-w-[1000px]"
                : assignmentCols === 2
                  ? "min-w-[1240px]"
                  : assignmentCols === 1
                    ? "min-w-[1060px]"
                    : "min-w-[880px]",
            )}
          >
            <thead className={THEAD_CLS}>
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
                {showDepartment && (
                <SortTh
                  label="Dział"
                  sortKey="department"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="kadry-godziny-sort"
                  tip="Dział firmy, w którym rozlicza się wpis. Pracownicy obiektowi należą do działu OFI — to w nim wskazuje się dodatkowo obiekt."
                />
                )}
                {showObject && (
                <SortTh
                  label="Obiekt"
                  sortKey="object"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="kadry-godziny-sort"
                  tip="Posterunek, na którym przepracowano godziny. Dostępny tylko w dziale obiektowym (OFI); w pozostałych działach godziny są kosztem ogólnym firmy."
                />
                )}
                <SortTh
                  label="Godziny nocne"
                  sortKey="nightHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Godziny nocne — informacyjne, nie wchodzą do kalkulacji"
                  align="right"
                />
                <SortTh
                  label="Wypracowane"
                  sortKey="workedHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Godziny wypracowane — podstawa fakt godzin i nadwyżki dodatku"
                  align="right"
                />
                <SortTh
                  label="Urlop (UW)"
                  sortKey="uwHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Urlop wypoczynkowy (h) — wlicza się do godzin rozliczanych"
                  align="right"
                />
                <SortTh
                  label="Chorobowe (L4)"
                  sortKey="l4Hours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Chorobowe (h) — wlicza się przy umowie o pracę (oraz do nadwyżki dodatku przy zleceniu w ALFA)"
                  align="right"
                />
                <SortTh
                  label="Godziny maks"
                  sortKey="maxHours"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Indywidualny limit godzin — przy UoP zastępuje normę miesiąca (brany największy wpis z miesiąca)"
                  align="right"
                />
                <SortTh
                  label="Potrącenia netto"
                  sortKey="deductions"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Potrącenia (zł netto) — pomniejszają premię/potrącenie w wynagrodzeniu"
                  align="right"
                />
                <SortTh
                  label="Dodatki netto"
                  sortKey="bonuses"
                  sort={sort}
                  dir={dir}
                  onSort={toggleSort}
                  testIdPrefix="hours-sort"
                  tip="Dodatki i premie (zł netto) — powiększają premię/potrącenie w wynagrodzeniu"
                  align="right"
                />
                <Th>Notatka</Th>
                <Th className="w-24" />
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {visible.length === 0 ? (
                <EmptyRow
                  colSpan={colCount}
                  loading={loading}
                  icon={Clock}
                  title={
                    filtersActive
                      ? "Brak wpisów dla wybranych filtrów"
                      : "Brak wpisów godzin w tym miesiącu"
                  }
                  description={
                    filtersActive
                      ? "Zdejmij filtry albo zmień szukajkę."
                      : "Wpisy można przenieść z poprzedniego miesiąca przyciskiem u góry — wtedy zostaje samo uzupełnienie godzin."
                  }
                />
              ) : editMode ? (
                visible.map((r, idx) => {
                  // Wiersz działu, którego sekcja trzyma rezerwację: pola są
                  // wygaszone i nieklikalne, a kliknięcie proponuje prośbę
                  // o zwolnienie TEGO działu. Bez tego jedyną informacją byłby
                  // 423 po wpisaniu liczby — czyli po pracy do wyrzucenia.
                  const rowLock = rowLockOf(r);
                  return (
                  <tr
                    key={r.id}
                    aria-disabled={rowLock ? true : undefined}
                    {...(rowLock
                      ? tip(
                          `Edytuje: ${rowLock.userLabel}${rowLock.portalLabel ? ` (${rowLock.portalLabel})` : ""} do ${lockUntil(rowLock.expiresAt)} · kliknij, aby poprosić o zwolnienie`,
                        )
                      : {})}
                    onPointerDownCapture={
                      rowLock
                        ? (e) => {
                            // `capture` + `preventDefault` ubiega fokus w polu:
                            // klik w zajęty wiersz ma pytać o zwolnienie, a nie
                            // wpuszczać kursor do komórki, której nie da się zapisać.
                            e.preventDefault();
                            e.stopPropagation();
                            lock.askFor(rowLock.portal);
                          }
                        : undefined
                    }
                    className={cn(
                      "group border-b",
                      errors[r.id] && "bg-destructive/5",
                      !errors[r.id] && savedAt[r.id] && "bg-emerald-500/5",
                      rowLock &&
                        "cursor-not-allowed opacity-50 [&_button]:pointer-events-none [&_input]:pointer-events-none [&_select]:pointer-events-none",
                    )}
                  >
                    <td className="whitespace-nowrap px-3 py-1 font-medium">
                      {r.employeeName}
                      {rowWarning(r)}
                    </td>
                    {showDepartment && (
                    <td className="px-1.5 py-1">
                      {/* Najpierw dział — on decyduje, czy obiekt w ogóle jest
                          do wyboru (obiekty istnieją tylko w dziale OFI). */}
                      <select
                        data-cell={`${idx}:department`}
                        data-testid="kadry-godziny-cell-department"
                        className={cn(
                          TABLE_SELECT_CLS,
                          "h-8",
                          r.objectUncertain &&
                            "border-amber-500 text-amber-700 dark:text-amber-300",
                        )}
                        {...(r.objectUncertain
                          ? tip(
                              "Przeniesione z poprzedniego miesiąca — zapis wpisu potwierdza przypisanie",
                            )
                          : {})}
                        value={shown(r, "department")}
                        onChange={(e) => {
                          setDraft(r, "department", e.target.value);
                          void commit(r, "department", e.target.value);
                        }}
                      >
                        <option value="">—</option>
                        {departmentChoices(r).map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    )}
                    {showObject && (
                    <td className="px-1.5 py-1">
                      {(() => {
                        const dept = rowDepartment(r, shown(r, "department"));
                        const allowed = isObjectDept(dept);
                        return (
                          <select
                            data-cell={`${idx}:object`}
                            data-testid="kadry-godziny-cell-object"
                            disabled={!allowed}
                            className={cn(
                              TABLE_SELECT_CLS,
                              "h-8",
                              !allowed && "cursor-not-allowed opacity-50",
                            )}
                            title={
                              allowed
                                ? undefined
                                : "Obiekty rozliczają się tylko w dziale obiektowym (OFI)"
                            }
                            value={allowed ? shown(r, "object") : ""}
                            onChange={(e) => {
                              setDraft(r, "object", e.target.value);
                              void commit(r, "object", e.target.value);
                            }}
                          >
                            <option value="">—</option>
                            {objectChoices(r).map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </select>
                        );
                      })()}
                    </td>
                    )}
                    {numCell(r, idx, "nightHours")}
                    {numCell(r, idx, "workedHours", "font-medium")}
                    {numCell(r, idx, "uwHours")}
                    {numCell(r, idx, "l4Hours")}
                    {numCell(r, idx, "maxHours")}
                    {numCell(r, idx, "deductions", TEXT_TONE.bad)}
                    {numCell(r, idx, "bonuses", TEXT_TONE.good)}
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
                        {/* Znacznik zapisu stoi POZA `RowActions`: to jedyna
                            informacja zwrotna po wpisaniu komórki, więc nie
                            może znikać, gdy kursor zjedzie z wiersza. */}
                        {rowStatus(r)}
                        <RowActions>
                          <EntityHistory
                            entityType="hr_hours"
                            entityId={r.id}
                            period={`${r.year}-${String(r.month).padStart(2, "0")}`}
                            title={r.employeeName}
                            portal={portal}
                          />
                          {rowExtras?.(r)}
                          <IconButton
                            icon={Pencil}
                            label="Otwórz formularz wpisu"
                            onClick={() => onEdit(r)}
                          />
                          <IconButton
                            icon={Trash2}
                            danger
                            label="Usuń wpis"
                            onClick={() => onDelete(r)}
                          />
                        </RowActions>
                      </div>
                    </td>
                  </tr>
                  );
                })
              ) : (
                visible.map((r) => (
                  <tr
                    key={r.id}
                    className={cn(
                      "group border-b hover:bg-accent/50",
                      editable && "cursor-pointer",
                    )}
                    onClick={editable ? () => onEdit(r) : undefined}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-medium">
                      {r.employeeName}
                      {rowWarning(r)}
                    </td>
                    {showDepartment && (
                    <td className="px-3 py-2">
                      {r.departmentName ? (
                        // Kolor działu (kolumna `hr_departments.color`) — przy
                        // kilkuset wierszach miesiąca rozpoznanie działu ma iść
                        // spojrzeniem, a nie czytaniem każdej komórki.
                        <KadryBadge
                          tone={departmentTone(
                            departments.find((d) => d.id === r.departmentId),
                          )}
                        >
                          {r.departmentName}
                        </KadryBadge>
                      ) : (
                        "—"
                      )}
                    </td>
                    )}
                    {showObject && (
                    <td className="px-3 py-2">
                      {r.objectName || "—"}
                      {r.objectUncertain && (
                        <KadryBadge
                          tone="ostrzezenie"
                          compact
                          className="ml-1.5 cursor-help"
                          hint="Przeniesione z poprzedniego miesiąca — potwierdź przypisanie, zapisując wpis"
                        >
                          ?
                        </KadryBadge>
                      )}
                    </td>
                    )}
                    <td className="px-3 py-2 text-right">
                      {r.nightHours != null ? hrs(r.nightHours) : ""}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">
                      {r.workedHours != null ? hrs(r.workedHours) : ""}
                      {/* Poprzedni miesiąc także w podglądzie: to tu czyta się
                          listę przed zamknięciem okresu i tu widać, komu nagle
                          ubyło albo przybyło pół etatu. */}
                      {prevOf(r, "workedHours") != null &&
                        prevHint(prevOf(r, "workedHours") as number)}
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
                    <td className={cn(NUM_CELL_CLS, TEXT_TONE.bad)}>
                      {r.deductions != null ? money(r.deductions) : ""}
                    </td>
                    <td className={cn(NUM_CELL_CLS, TEXT_TONE.good)}>
                      {r.bonuses != null ? money(r.bonuses) : ""}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-xs text-muted-foreground">
                      {r.notes}
                    </td>
                    <td className="px-3 py-2">
                      <RowActions>
                        {/* Historia wpisu: odczyt, więc bez bramki `editable`. */}
                        <EntityHistory
                          entityType="hr_hours"
                          entityId={r.id}
                          period={`${r.year}-${String(r.month).padStart(2, "0")}`}
                          title={r.employeeName}
                          portal={portal}
                        />
                        {rowExtras?.(r)}
                        {editable && (
                          <>
                            <IconButton
                              icon={Pencil}
                              label="Edytuj wpis"
                              onClick={() => onEdit(r)}
                            />
                            <IconButton
                              icon={Trash2}
                              danger
                              label="Usuń wpis"
                              onClick={() => onDelete(r)}
                            />
                          </>
                        )}
                      </RowActions>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className={TFOOT_ROW_CLS}>
                  <td className="px-3 py-2" colSpan={1 + assignmentCols}>
                    Razem ({visible.length})
                  </td>
                  <td className={NUM_CELL_CLS}>{hrs(sum((r) => r.nightHours))}</td>
                  <td className={NUM_CELL_CLS}>{hrs(sum((r) => r.workedHours))}</td>
                  <td className={NUM_CELL_CLS}>{hrs(sum((r) => r.uwHours))}</td>
                  <td className={NUM_CELL_CLS}>{hrs(sum((r) => r.l4Hours))}</td>
                  <td />
                  <td className={cn(NUM_CELL_CLS, TEXT_TONE.bad)}>
                    {money(sum((r) => r.deductions))}
                  </td>
                  <td className={cn(NUM_CELL_CLS, TEXT_TONE.good)}>
                    {money(sum((r) => r.bonuses))}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </CardContent>
      </Card>

      {/* Wklejka z grafiku — dopasowanie i podgląd robi dialog, zapis idzie
          przez ten sam `PUT /hr/hours/bulk`, co kopiowanie z poprzedniego
          miesiąca. Rezerwację wzięliśmy już przy otwieraniu okna. */}
      {pasteOpen && (
        <PasteHoursDialog
          open={pasteOpen}
          onClose={() => setPasteOpen(false)}
          rows={rows}
          year={year}
          month={month}
          portal={portal}
          onSaved={() => onChanged()}
        />
      )}
      {confirm.dialog}
    </>
  );
}
