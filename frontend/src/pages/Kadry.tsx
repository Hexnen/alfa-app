// Moduł Kadry — odwzorowanie skoroszytu "MASTER": godziny → zestawienie dla
// księgowości → kwoty od księgowości → wynagrodzenia (przelew/gotówka).
// Każdy nagłówek kolumny ma tooltip (hover) z opisem, z czego się kalkuluje.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  HrContractForm,
  HrEmployeeForm,
  HrHoursForm,
  HrOfficeForm,
  HrPayrollForm,
} from "@/components/KadryForms";
import { HrHoursTab } from "@/components/kadry/HoursTab";
import { DepartmentsTab } from "@/components/kadry/DepartmentsTab";
import { TABLE_SELECT_CLS, hrs, money } from "@/components/kadry/shared";
import { SortTh, Th, type SortDir } from "@/components/kadry/parts";
import { catalogLabel } from "@/lib/labels";
import { printHrStatement } from "@/lib/hrPrint";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { cn } from "@/lib/utils";
import {
  Plus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Printer,
  AlertTriangle,
  Search,
  X,
} from "lucide-react";
import {
  getCompanies,
  getHrSummary,
  getHrPayroll,
  saveHrPayroll,
  getHrHours,
  createHrHours,
  updateHrHours,
  deleteHrHours,
  carryOverHrHours,
  getHrEmployees,
  createHrEmployee,
  updateHrEmployee,
  deleteHrEmployee,
  getHrObjects,
  createHrObject,
  updateHrObject,
  deleteHrObject,
  getHrObjectCatalog,
  setHrObjectMapping,
  getHrDepartments,
  getHrContracts,
  createHrContract,
  updateHrContract,
  deleteHrContract,
  getHrNorms,
  saveHrNorm,
  getHrOffice,
  createHrOffice,
  updateHrOffice,
  deleteHrOffice,
  type HrSummary,
  type HrPayrollRow,
  type HrPayrollSaveInput,
  type HrHoursEntry,
  type HrHoursInput,
  type HrEmployee,
  type HrEmployeeInput,
  type HrObject,
  type HrObjectRef,
  type HrDepartment,
  type HrContract,
  type HrContractInput,
  type HrMonthNorm,
  type HrOfficeRow,
  type HrOfficeInput,
  type Company,
} from "@/lib/api";

const MONTH_NAMES = [
  "Styczeń",
  "Luty",
  "Marzec",
  "Kwiecień",
  "Maj",
  "Czerwiec",
  "Lipiec",
  "Sierpień",
  "Wrzesień",
  "Październik",
  "Listopad",
  "Grudzień",
];

const BONUS_SHORT: Record<string, string> = {
  brak: "—",
  gotowka: "Gotówka",
  delegacja_przelew: "Deleg. przelew",
  delegacja_gotowka: "Deleg. gotówka",
};

/**
 * Pozycje słownika kadrowego, które NIE są obiektem chronionym, tylko kosztem
 * technicznym firmy: `#BIURO`, `#zlecenie`. Mapowanie ich na pojedynczy obiekt
 * zrzuciłoby koszt centrali na jednego klienta, więc zostają niezmapowane
 * celowo.
 *
 * Praca działowa (dawna pozycja `CMA` i reszta) NIE należy już tutaj — ma
 * własny słownik w Kadry → Działy. Rozpoznawanie po nazwie było zresztą pułapką:
 * nowa pozycja nazwana „CMA" dostawałaby etykietę „koszt wspólny", mimo że pula
 * kosztów siedzi teraz przy dziale i jest oznaczona flagą, a nie nazwą.
 */
function overheadKind(name: string): "techniczna" | null {
  return name.trim().startsWith("#") ? "techniczna" : null;
}

// --- sortowanie list: wspólne porównania (wzorzec z Obiektów i Spółek) ---

/**
 * Teksty po polsku (żeby Ł nie lądowało za Z), a puste na końcu w OBU
 * kierunkach — jak NULLS LAST w SQL. Inaczej „sortuj po dziale” zaczynałoby się
 * od osób bez działu, czyli od wierszy, które w tej kolumnie nic nie mówią.
 */
const cmpText = (
  a: string | null | undefined,
  b: string | null | undefined,
  mul: number,
): number => {
  const as = (a ?? "").trim();
  const bs = (b ?? "").trim();
  if (!as || !bs) return !as && !bs ? 0 : as ? -1 : 1;
  return as.localeCompare(bs, "pl") * mul;
};

/** Liczby — ta sama reguła: brak wartości zawsze na końcu. */
const cmpNum = (
  a: number | null | undefined,
  b: number | null | undefined,
  mul: number,
): number => {
  if (a == null || b == null)
    return a == null && b == null ? 0 : a == null ? 1 : -1;
  return (a - b) * mul;
};

/**
 * Kwoty, które tabela rysuje pustą komórką przy zerze (przelew/gotówka/wypłata,
 * kwota biura) — zero znaczy tu „nic nie ma”, więc sortuje się jak brak.
 */
const cmpMoney = (a: number, b: number, mul: number) =>
  cmpNum(a || null, b || null, mul);

/** Kwota z pola widełek — przecinek jak kropka, śmieci znaczą „bez ograniczenia”. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Kartoteka pracowników — kolumny, po których wolno sortować. */
type EmployeeSortKey =
  | "fullName"
  | "code"
  | "kind"
  | "departmentName"
  | "contracts"
  | "active"
  | "updatedAt";

/** Domyślny kierunek: teksty alfabetycznie, liczniki i daty od największych. */
const EMPLOYEE_DIR: Record<EmployeeSortKey, SortDir> = {
  fullName: "asc",
  code: "asc",
  kind: "asc",
  departmentName: "asc",
  contracts: "desc",
  active: "desc",
  updatedAt: "desc",
};

type PayrollSortKey =
  | "employeeName"
  | "company"
  | "contractType"
  | "maksGodziny"
  | "faktGodziny"
  | "stawkaNetto"
  | "kwotaGlowna"
  | "kwotaWyrownania"
  | "dodatekFinalny"
  | "przelew"
  | "gotowka"
  | "wyplata";

const PAYROLL_DIR: Record<PayrollSortKey, SortDir> = {
  employeeName: "asc",
  company: "asc",
  contractType: "asc",
  maksGodziny: "desc",
  faktGodziny: "desc",
  stawkaNetto: "desc",
  kwotaGlowna: "desc",
  kwotaWyrownania: "desc",
  dodatekFinalny: "desc",
  przelew: "desc",
  gotowka: "desc",
  wyplata: "desc",
};

type OfficeSortKey =
  | "employeeName"
  | "company"
  | "hoursForAccounting"
  | "rate"
  | "total";

const OFFICE_DIR: Record<OfficeSortKey, SortDir> = {
  employeeName: "asc",
  company: "asc",
  hoursForAccounting: "desc",
  rate: "desc",
  total: "desc",
};

type ObjectSortKey = "name" | "hoursTotal" | "employeesCount" | "mapping";

const OBJECT_DIR: Record<ObjectSortKey, SortDir> = {
  name: "asc",
  hoursTotal: "desc",
  employeesCount: "desc",
  mapping: "asc",
};

/**
 * Tryb „Braki” w wynagrodzeniach. `braki` odpowiada dokładnie liczbie z kafla
 * (`summary.gaps` — wiersze z którymkolwiek brakiem, każdy liczony raz), a dwa
 * kolejne tryby rozbijają go na składniki z podpisu kafla — dzięki temu z liczby
 * na kaflu da się dojść do konkretnych wierszy, zamiast szukać ich po tabeli
 * okiem. Składniki mogą sumować się do więcej niż `gaps`, bo jedna umowa bywa
 * jednocześnie bez kwoty i z dodatkiem do przeliczenia.
 */
type PayrollGapMode = "all" | "braki" | "missing" | "pending" | "warnings";

/**
 * Wiersz bez kwoty od księgowości — ten sam warunek, którym backend liczy
 * `summary.missingMain` (`src/routes/hr.ts`). Rozjechanie się tych dwóch reguł
 * dałoby kafel z liczbą, której filtr nie potrafi odtworzyć.
 */
const payrollMissingMain = (r: HrPayrollRow) =>
  r.faktGodziny != null && r.faktGodziny > 0 && r.kwotaGlowna == null;

/** Filtr aktywności — wspólny kształt dla kartoteki i słownika obiektów. */
type ActiveFilter = "all" | "active" | "inactive";

const KADRY_TABS = [
  "wynagrodzenia",
  "godziny",
  "pracownicy",
  "obiekty",
  "dzialy",
  "normy",
] as const;

// Dawne podzakładki scalone w „Pracownicy" — stare adresy (zakładki w
// przeglądarce, linki w mailach) mają dalej dowozić na właściwy ekran.
const MERGED_TABS: Record<string, string> = {
  umowy: "pracownicy",
  // Rozliczenie biura przeniosło się pod wypłaty miesiąca.
  biuro: "wynagrodzenia",
};

export function Kadry() {
  const { tab } = useParams<{ tab: string }>();
  const { canEdit } = usePerms();
  const editable = canEdit(`kadry/${tab}`);
  const hoursEditable = canEdit("kadry/godziny");
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [summary, setSummary] = useState<HrSummary | null>(null);
  const [payroll, setPayroll] = useState<HrPayrollRow[]>([]);
  const [hours, setHours] = useState<HrHoursEntry[]>([]);
  const [office, setOffice] = useState<HrOfficeRow[]>([]);
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [objects, setObjects] = useState<HrObject[]>([]);
  /** Kartoteka obiektów — lista wyboru przy mapowaniu pozycji kadrowych. */
  const [objectCatalog, setObjectCatalog] = useState<HrObjectRef[]>([]);
  /** Działy firmy — druga grupa w selekcie przypisania godzin + zakładka Działy. */
  const [departments, setDepartments] = useState<HrDepartment[]>([]);
  const [contracts, setContracts] = useState<HrContract[]>([]);
  /** Słownik spółek — źródło listy wyboru w umowie i podpowiedzi w biurze. */
  const [companies, setCompanies] = useState<Company[]>([]);
  const [norms, setNorms] = useState<HrMonthNorm[]>([]);
  const [loading, setLoading] = useState(true);

  const [payrollEdit, setPayrollEdit] = useState<HrPayrollRow | null>(null);
  const [hoursFormOpen, setHoursFormOpen] = useState(false);
  const [hoursEdit, setHoursEdit] = useState<HrHoursEntry | null>(null);
  const [employeeFormOpen, setEmployeeFormOpen] = useState(false);
  const [employeeEdit, setEmployeeEdit] = useState<HrEmployee | null>(null);
  const [contractFormOpen, setContractFormOpen] = useState(false);
  const [contractEdit, setContractEdit] = useState<HrContract | null>(null);
  const [officeFormOpen, setOfficeFormOpen] = useState(false);
  const [officeEdit, setOfficeEdit] = useState<HrOfficeRow | null>(null);

  /**
   * Szukajka wypłat — obejmuje TEŻ sekcję Biuro pod tabelą. Obie listy są
   * rozliczeniem tego samego miesiąca, więc filtr, który zawężał tylko górną
   * połowę ekranu, pokazywał „wypłaty Kowalskiego” razem z całym biurem.
   */
  const [payrollFilter, setPayrollFilter] = useState("");
  /** Spółka — wspólna dla wypłat ochrony i biura (jedna lista wyboru na oba). */
  const [payrollCompany, setPayrollCompany] = useState<string>("all");
  const [payrollContractType, setPayrollContractType] = useState<
    "all" | "praca" | "zlecenie"
  >("all");
  /** Zgłoszenie: `none` = wiersz bez ZUA i bez ZZA (umowa nieprzypisana do gałęzi). */
  const [payrollRegistration, setPayrollRegistration] = useState<
    "all" | "zua" | "zza" | "none"
  >("all");
  const [payrollBonusType, setPayrollBonusType] = useState<string>("all");
  const [payrollMainChannel, setPayrollMainChannel] = useState<
    "all" | "przelew" | "gotowka"
  >("all");
  const [payrollMaxSource, setPayrollMaxSource] = useState<
    "all" | "override" | "individual" | "norm"
  >("all");
  const [payrollGaps, setPayrollGaps] = useState<PayrollGapMode>("all");
  const [payrollMin, setPayrollMin] = useState("");
  const [payrollMax, setPayrollMax] = useState("");
  const [payrollSort, setPayrollSort] = useState<PayrollSortKey>("employeeName");
  const [payrollDir, setPayrollDir] = useState<SortDir>("asc");
  const [officeSort, setOfficeSort] = useState<OfficeSortKey>("employeeName");
  const [officeDir, setOfficeDir] = useState<SortDir>("asc");

  const [employeeFilter, setEmployeeFilter] = useState("");
  /** Kartoteka: wszyscy / tylko ochrona (umowy) / tylko biuro — dawne podzakładki. */
  const [employeeKind, setEmployeeKind] = useState<"all" | "ochrona" | "biuro">(
    "all",
  );
  /**
   * Kartoteka: filtr po dziale. `all` = bez filtra, `none` = osoby BEZ działu
   * (to one wymagają uzupełnienia), liczba = id konkretnego działu.
   */
  const [employeeDept, setEmployeeDept] = useState<"all" | "none" | number>(
    "all",
  );
  /**
   * Kartoteka domyślnie pokazuje AKTYWNYCH. Wcześniej zwolnieni mieszali się
   * z pracującymi i lista rosła w nieskończoność (kartoteka nie jest czyszczona
   * — pracownika się dezaktywuje, nie usuwa). Zwolnionych wciąż widać po
   * przełączeniu filtra albo przez „Wyczyść filtry”.
   */
  const [employeeActive, setEmployeeActive] = useState<ActiveFilter>("active");
  /** Spółka z umów LUB z rozliczenia biura (`all` = bez filtra). */
  const [employeeCompany, setEmployeeCompany] = useState<string>("all");
  /**
   * „Ochrona bez umów”: `none` = tylko osoby bez ani jednej umowy (to one nie
   * pojawią się w wynagrodzeniach), `with` = tylko z umowami.
   */
  const [employeeContracts, setEmployeeContracts] = useState<
    "all" | "none" | "with"
  >("all");
  const [employeeSort, setEmployeeSort] = useState<EmployeeSortKey>("fullName");
  const [employeeDir, setEmployeeDir] = useState<SortDir>("asc");

  const [objectSearch, setObjectSearch] = useState("");
  const [objectMapping, setObjectMapping] = useState<
    "all" | "mapped" | "unmapped"
  >("all");
  const [objectActive, setObjectActive] = useState<ActiveFilter>("all");
  /** Pozycje techniczne (#BIURO, #zlecenie): ukryj / tylko one / wszystkie. */
  const [objectTech, setObjectTech] = useState<"all" | "hide" | "only">("all");
  const [objectWithHours, setObjectWithHours] = useState(false);
  const [objectSort, setObjectSort] = useState<ObjectSortKey>("hoursTotal");
  const [objectDir, setObjectDir] = useState<SortDir>("desc");

  /** Rozwinięci pracownicy w kartotece (umowy + biuro pod wierszem). */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** Pracownik podstawiany w nowej umowie / nowym wpisie biura. */
  const [formEmployeeId, setFormEmployeeId] = useState<number | undefined>();
  const [newObjectName, setNewObjectName] = useState("");
  const [normDraft, setNormDraft] = useState<
    Record<number, { workNorm: string; contractNorm: string }>
  >({});

  // Carry-over: jedna próba na parę (year, month) w tej sesji + ochrona przed
  // zapisem stanu po szybkiej zmianie miesiąca (klucz ostatniego żądania)
  const carryTriedRef = useRef<Set<string>>(new Set());
  const monthKeyRef = useRef("");
  // Zbiorcze odświeżenie miesiąca po serii zapisów inline (debounce).
  const hoursRefreshRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (hoursRefreshRef.current) window.clearTimeout(hoursRefreshRef.current);
    },
    [],
  );

  // `silent` — odświeżenie w tle po zapisie inline: dane mają się przeliczyć
  // (godziny karmią wynagrodzenia i kafle), ale tabela nie ma migotać
  // komunikatem „Ładowanie…" pod palcami wpisującego.
  const loadMonth = useCallback(async (opts?: { silent?: boolean }) => {
    const key = `${year}-${month}`;
    monthKeyRef.current = key;
    if (!opts?.silent) setLoading(true);
    try {
      const fetchAll = () =>
        Promise.all([
          getHrSummary(year, month),
          getHrPayroll(year, month),
          getHrHours(year, month),
          getHrOffice(year, month),
        ]);
      let [s, p, h, o] = await fetchAll();
      // Auto-przeniesienie aktywnych pracowników z poprzedniego miesiąca:
      // tylko gdy miesiąc pusty, użytkownik ma edycję godzin, miesiąc nie jest
      // dalej niż 1 w przód (przewijanie w przyszłość nie tworzy kaskady
      // pustych miesięcy) i nie próbowano jeszcze w tej sesji.
      const nowIdx =
        new Date().getFullYear() * 12 + new Date().getMonth() + 1;
      if (
        (h.data ?? []).length === 0 &&
        hoursEditable &&
        year * 12 + month - nowIdx <= 1 &&
        !carryTriedRef.current.has(key)
      ) {
        carryTriedRef.current.add(key);
        try {
          const res = await carryOverHrHours(year, month);
          if ((res.data?.inserted ?? 0) > 0) {
            [s, p, h, o] = await fetchAll();
          }
        } catch {
          // Błąd carry-over (np. sieć) nie blokuje widoku pustego miesiąca
        }
      }
      if (monthKeyRef.current !== key) return; // zmieniono miesiąc w trakcie
      setSummary(s.data ?? null);
      setPayroll(p.data ?? []);
      setHours(h.data ?? []);
      setOffice(o.data ?? []);
    } finally {
      if (monthKeyRef.current === key && !opts?.silent) setLoading(false);
    }
  }, [year, month, hoursEditable]);

  const loadDictionaries = useCallback(async () => {
    const [e, o, c, comp, cat, dep] = await Promise.all([
      getHrEmployees(),
      getHrObjects(),
      getHrContracts(),
      getCompanies(),
      getHrObjectCatalog(),
      getHrDepartments(),
    ]);
    setEmployees(e.data ?? []);
    setObjects(o.data ?? []);
    setContracts(c.data ?? []);
    setCompanies(comp.data ?? []);
    setObjectCatalog(cat.data ?? []);
    setDepartments(dep.data ?? []);
  }, []);

  const loadNorms = useCallback(async () => {
    const n = await getHrNorms(year);
    setNorms(n.data ?? []);
    setNormDraft({});
  }, [year]);

  useEffect(() => {
    loadMonth();
  }, [loadMonth]);
  useEffect(() => {
    loadDictionaries();
  }, [loadDictionaries]);
  useEffect(() => {
    loadNorms();
  }, [loadNorms]);

  const shiftMonth = (delta: number) => {
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    if (m > 12) {
      m = 1;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  };

  const activeEmployees = useMemo(
    () => employees.filter((e) => e.active),
    [employees],
  );

  /**
   * Pozycje kadrowe: filtr + sortowanie w jednym przebiegu. Domyślnie od
   * najcięższych — mapuje się je ręcznie i po kolei, więc na górze mają stać
   * te, na których wisi najwięcej godzin: to one przeniosą do Analityki
   * największy kawałek kosztu osobowego.
   */
  const objectsVisible = useMemo(() => {
    const q = objectSearch.trim().toLowerCase();
    const list = objects.filter((o) => {
      if (q && !o.name.toLowerCase().includes(q)) return false;
      if (objectMapping === "mapped" && o.objectId == null) return false;
      if (objectMapping === "unmapped" && o.objectId != null) return false;
      if (objectActive === "active" && !o.active) return false;
      if (objectActive === "inactive" && o.active) return false;
      const tech = overheadKind(o.name) != null;
      if (objectTech === "hide" && tech) return false;
      if (objectTech === "only" && !tech) return false;
      if (objectWithHours && o.hoursTotal <= 0) return false;
      return true;
    });

    const mul = objectDir === "asc" ? 1 : -1;
    const mappingLabel = (o: HrObject) =>
      o.object ? catalogLabel(o.object) : "";
    const cmp = (a: HrObject, b: HrObject) => {
      switch (objectSort) {
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
  }, [
    objects,
    objectSearch,
    objectMapping,
    objectActive,
    objectTech,
    objectWithHours,
    objectSort,
    objectDir,
  ]);

  const objectFiltersActive =
    objectSearch !== "" ||
    objectMapping !== "all" ||
    objectActive !== "all" ||
    objectTech !== "all" ||
    objectWithHours;

  const clearObjectFilters = () => {
    setObjectSearch("");
    setObjectMapping("all");
    setObjectActive("all");
    setObjectTech("all");
    setObjectWithHours(false);
  };

  /**
   * Postęp mapowania liczymy TYLKO z pozycji, które mają godziny i nie są
   * kosztem ogólnym: pozycja bez godzin nic do Analityki nie wniesie, a
   * #BIURO / CMA nie mają być mapowane — w mianowniku zaniżałyby wynik na stałe.
   */
  const mappingProgress = useMemo(() => {
    const relevant = objects.filter(
      (o) => o.hoursTotal > 0 && !overheadKind(o.name),
    );
    const mapped = relevant.filter((o) => o.objectId != null);
    const sum = (list: HrObject[]) =>
      list.reduce((acc, o) => acc + o.hoursTotal, 0);
    return {
      total: relevant.length,
      mapped: mapped.length,
      hoursTotal: sum(relevant),
      hoursMapped: sum(mapped),
    };
  }, [objects]);

  // Kartoteka: umowy podpięte pod pracownika (wiersz rozwijany).
  const contractsByEmployee = useMemo(() => {
    const m = new Map<number, HrContract[]>();
    for (const c of contracts) {
      const list = m.get(c.employeeId);
      if (list) list.push(c);
      else m.set(c.employeeId, [c]);
    }
    return m;
  }, [contracts]);

  /** Spółki widziane przez kartotekę — z umów i z rozliczeń biura (cała historia). */
  const employeeCompanyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of contracts) if (c.company) set.add(c.company);
    for (const e of employees)
      for (const c of e.officeCompanies ?? []) if (c) set.add(c);
    return [...set].sort((a, b) => a.localeCompare(b, "pl"));
  }, [contracts, employees]);

  // Rodzaj rozliczenia to cecha pracownika (ochrona / biuro). Szukajka obejmuje
  // też spółki, żeby dało się wyciągnąć „ludzi z GUARD 21".
  const employeesVisible = useMemo(() => {
    const q = employeeFilter.trim().toLowerCase();
    const companiesOf = (e: HrEmployee) => [
      ...(contractsByEmployee.get(e.id) ?? []).map((c) => c.company),
      ...(e.officeCompanies ?? []),
    ];
    const list = employees.filter((e) => {
      const ctrs = contractsByEmployee.get(e.id) ?? [];
      if (employeeKind !== "all" && e.kind !== employeeKind) return false;
      if (employeeDept === "none" && e.departmentId != null) return false;
      if (typeof employeeDept === "number" && e.departmentId !== employeeDept)
        return false;
      if (employeeActive === "active" && !e.active) return false;
      if (employeeActive === "inactive" && e.active) return false;
      if (employeeContracts === "none" && ctrs.length > 0) return false;
      if (employeeContracts === "with" && ctrs.length === 0) return false;
      if (
        employeeCompany !== "all" &&
        !companiesOf(e).some((c) => c === employeeCompany)
      )
        return false;
      if (!q) return true;
      const haystack = [
        e.fullName,
        e.code,
        e.notes,
        e.departmentName,
        ...companiesOf(e),
      ];
      return haystack.some((v) => (v ?? "").toLowerCase().includes(q));
    });

    const mul = employeeDir === "asc" ? 1 : -1;
    const cmp = (a: HrEmployee, b: HrEmployee) => {
      switch (employeeSort) {
        case "code":
          return cmpText(a.code, b.code, mul);
        case "kind":
          return cmpText(a.kind, b.kind, mul);
        case "departmentName":
          return cmpText(a.departmentName, b.departmentName, mul);
        case "contracts":
          // Zero umów to informacja (kolumna pisze „brak umów”), a nie brak
          // danych — sortuje się jak liczba, nie jak wartość pusta.
          return cmpNum(
            contractsByEmployee.get(a.id)?.length ?? 0,
            contractsByEmployee.get(b.id)?.length ?? 0,
            mul,
          );
        case "active":
          return cmpNum(Number(a.active), Number(b.active), mul);
        case "updatedAt":
          return cmpText(a.updatedAt, b.updatedAt, mul);
        default:
          return cmpText(a.fullName, b.fullName, mul);
      }
    };
    return list.sort(
      (a, b) =>
        cmp(a, b) || a.fullName.localeCompare(b.fullName, "pl") || a.id - b.id,
    );
  }, [
    employees,
    employeeFilter,
    employeeKind,
    employeeDept,
    employeeActive,
    employeeCompany,
    employeeContracts,
    employeeSort,
    employeeDir,
    contractsByEmployee,
  ]);

  const employeeFiltersActive =
    employeeFilter !== "" ||
    employeeKind !== "all" ||
    employeeDept !== "all" ||
    // Domyślnie kartoteka pokazuje aktywnych, więc „aktywni” nie liczy się jako
    // filtr — inaczej przycisk „Wyczyść filtry” stałby na ekranie na stałe.
    employeeActive !== "active" ||
    employeeCompany !== "all" ||
    employeeContracts !== "all";

  const clearEmployeeFilters = () => {
    setEmployeeFilter("");
    setEmployeeKind("all");
    setEmployeeDept("all");
    setEmployeeActive("active");
    setEmployeeCompany("all");
    setEmployeeContracts("all");
  };

  const visibleContractsCount = employeesVisible.reduce(
    (s, e) => s + (contractsByEmployee.get(e.id)?.length ?? 0),
    0,
  );

  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Spółki z rozliczenia miesiąca — jedna lista wyboru na wypłaty i biuro. */
  const payrollCompanyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of payroll) if (r.company) set.add(r.company);
    for (const r of office) if (r.company) set.add(r.company);
    return [...set].sort((a, b) => a.localeCompare(b, "pl"));
  }, [payroll, office]);

  const payrollVisible = useMemo(() => {
    const q = payrollFilter.trim().toLowerCase();
    const min = parseAmount(payrollMin);
    const max = parseAmount(payrollMax);
    const list = payroll.filter((r) => {
      if (q && !`${r.employeeName} ${r.company}`.toLowerCase().includes(q))
        return false;
      if (payrollCompany !== "all" && r.company !== payrollCompany) return false;
      if (
        payrollContractType !== "all" &&
        r.contractType !== payrollContractType
      )
        return false;
      if (
        payrollRegistration !== "all" &&
        (r.registration ?? "none") !== payrollRegistration
      )
        return false;
      if (payrollBonusType !== "all" && r.bonusType !== payrollBonusType)
        return false;
      if (payrollMainChannel !== "all" && r.mainChannel !== payrollMainChannel)
        return false;
      if (payrollMaxSource !== "all" && r.maxHoursSource !== payrollMaxSource)
        return false;
      if (payrollGaps === "missing" && !payrollMissingMain(r)) return false;
      if (payrollGaps === "pending" && !r.bonusPending) return false;
      if (payrollGaps === "braki" && !payrollMissingMain(r) && !r.bonusPending)
        return false;
      if (payrollGaps === "warnings" && r.warnings.length === 0) return false;
      if (min !== undefined && r.wyplata < min) return false;
      if (max !== undefined && r.wyplata > max) return false;
      return true;
    });

    const mul = payrollDir === "asc" ? 1 : -1;
    const cmp = (a: HrPayrollRow, b: HrPayrollRow) => {
      switch (payrollSort) {
        case "company":
          return cmpText(a.company, b.company, mul);
        case "contractType":
          return cmpText(a.contractType, b.contractType, mul);
        case "maksGodziny":
          return cmpNum(a.maksGodziny, b.maksGodziny, mul);
        case "faktGodziny":
          return cmpNum(a.faktGodziny, b.faktGodziny, mul);
        case "stawkaNetto":
          return cmpNum(a.stawkaNetto, b.stawkaNetto, mul);
        case "kwotaGlowna":
          return cmpNum(a.kwotaGlowna, b.kwotaGlowna, mul);
        case "kwotaWyrownania":
          return cmpNum(a.kwotaWyrownania, b.kwotaWyrownania, mul);
        case "dodatekFinalny":
          return cmpNum(a.dodatekFinalny, b.dodatekFinalny, mul);
        case "przelew":
          return cmpMoney(a.przelew, b.przelew, mul);
        case "gotowka":
          return cmpMoney(a.gotowka, b.gotowka, mul);
        case "wyplata":
          return cmpMoney(a.wyplata, b.wyplata, mul);
        default:
          return cmpText(a.employeeName, b.employeeName, mul);
      }
    };
    // Remis rozstrzyga nazwisko i id umowy — czyli dokładnie kolejność, w
    // której backend oddaje wiersze; jedna osoba miewa kilka umów w miesiącu.
    return list.sort(
      (a, b) =>
        cmp(a, b) ||
        a.employeeName.localeCompare(b.employeeName, "pl") ||
        a.contractId - b.contractId,
    );
  }, [
    payroll,
    payrollFilter,
    payrollCompany,
    payrollContractType,
    payrollRegistration,
    payrollBonusType,
    payrollMainChannel,
    payrollMaxSource,
    payrollGaps,
    payrollMin,
    payrollMax,
    payrollSort,
    payrollDir,
  ]);

  /**
   * Biuro dzieli z wypłatami szukajkę i filtr spółki (to jedno rozliczenie
   * miesiąca w dwóch tabelach), ale ma własne sortowanie — kolumny są inne.
   */
  const officeVisible = useMemo(() => {
    const q = payrollFilter.trim().toLowerCase();
    const list = office.filter((r) => {
      if (q && !`${r.employeeName} ${r.company}`.toLowerCase().includes(q))
        return false;
      if (payrollCompany !== "all" && r.company !== payrollCompany) return false;
      return true;
    });
    const mul = officeDir === "asc" ? 1 : -1;
    const cmp = (a: HrOfficeRow, b: HrOfficeRow) => {
      switch (officeSort) {
        case "company":
          return cmpText(a.company, b.company, mul);
        case "hoursForAccounting":
          return cmpNum(a.hoursForAccounting, b.hoursForAccounting, mul);
        case "rate":
          return cmpNum(a.rate, b.rate, mul);
        case "total":
          return cmpMoney(a.total, b.total, mul);
        default:
          return cmpText(a.employeeName, b.employeeName, mul);
      }
    };
    return list.sort(
      (a, b) =>
        cmp(a, b) ||
        a.employeeName.localeCompare(b.employeeName, "pl") ||
        a.id - b.id,
    );
  }, [office, payrollFilter, payrollCompany, officeSort, officeDir]);

  const payrollFiltersActive =
    payrollFilter !== "" ||
    payrollCompany !== "all" ||
    payrollContractType !== "all" ||
    payrollRegistration !== "all" ||
    payrollBonusType !== "all" ||
    payrollMainChannel !== "all" ||
    payrollMaxSource !== "all" ||
    payrollGaps !== "all" ||
    payrollMin !== "" ||
    payrollMax !== "";

  const clearPayrollFilters = () => {
    setPayrollFilter("");
    setPayrollCompany("all");
    setPayrollContractType("all");
    setPayrollRegistration("all");
    setPayrollBonusType("all");
    setPayrollMainChannel("all");
    setPayrollMaxSource("all");
    setPayrollGaps("all");
    setPayrollMin("");
    setPayrollMax("");
  };

  /**
   * Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego
   * domyślnego (teksty rosnąco, kwoty i liczniki malejąco).
   */
  const makeToggleSort =
    <K extends string>(
      sort: K,
      setSort: (k: K) => void,
      setDir: React.Dispatch<React.SetStateAction<SortDir>>,
      defaults: Record<K, SortDir>,
    ) =>
    (key: K) => {
      if (sort === key) {
        setDir((d) => (d === "asc" ? "desc" : "asc"));
        return;
      }
      setSort(key);
      setDir(defaults[key]);
    };

  const togglePayrollSort = makeToggleSort(
    payrollSort,
    setPayrollSort,
    setPayrollDir,
    PAYROLL_DIR,
  );
  const toggleOfficeSort = makeToggleSort(
    officeSort,
    setOfficeSort,
    setOfficeDir,
    OFFICE_DIR,
  );
  const toggleEmployeeSort = makeToggleSort(
    employeeSort,
    setEmployeeSort,
    setEmployeeDir,
    EMPLOYEE_DIR,
  );
  const toggleObjectSort = makeToggleSort(
    objectSort,
    setObjectSort,
    setObjectDir,
    OBJECT_DIR,
  );

  // --- handlery CRUD (wzorzec: zapis → przeładowanie miesiąca/słowników) ---

  const handlePayrollSave = async (data: HrPayrollSaveInput) => {
    if (!editable) return;
    await saveHrPayroll(data);
    await loadMonth();
  };

  const handleHoursSubmit = async (data: HrHoursInput) => {
    if (!editable) return;
    if (hoursEdit) await updateHrHours(hoursEdit.id, data);
    else await createHrHours(data);
    await loadMonth();
  };

  /**
   * Zapis pojedynczej komórki w trybie edycji. Wiersz podmieniamy od razu
   * (PUT zwraca sam rekord godzin — nazwy dokładamy z ekranu), a przeliczenie
   * wynagrodzeń i kafli dociągamy raz na serię zmian, nie po każdym polu.
   */
  const handleHoursRowSaved = (id: number, saved: HrHoursEntry) => {
    setHours((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              ...saved,
              employeeName: r.employeeName,
              // Obie etykiety liczymy od nowa (nie doklejamy do starych):
              // przypisanie jest rozłączne, więc po przepięciu obiekt→dział
              // to drugie MUSI wyzerować się od razu. Zostawienie starej
              // wartości pokazywałoby obie naraz aż do cichego odświeżenia.
              objectName:
                objects.find((o) => o.id === saved.objectId)?.name ?? "",
              departmentName:
                departments.find((d) => d.id === saved.departmentId)?.label ??
                "",
            }
          : r,
      ),
    );
    if (hoursRefreshRef.current) window.clearTimeout(hoursRefreshRef.current);
    hoursRefreshRef.current = window.setTimeout(() => {
      void loadMonth({ silent: true });
    }, 1500);
  };

  const handleHoursDelete = async (row: HrHoursEntry) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć wpis godzin: ${row.employeeName}?`)) return;
    try {
      await deleteHrHours(row.id);
      await loadMonth();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd usuwania");
    }
  };

  const handleEmployeeSubmit = async (data: HrEmployeeInput) => {
    if (!editable) return;
    if (employeeEdit) await updateHrEmployee(employeeEdit.id, data);
    else await createHrEmployee(data);
    await loadDictionaries();
  };

  const handleEmployeeDelete = async (row: HrEmployee) => {
    if (!editable) return;
    if (
      !window.confirm(
        `Usunąć pracownika ${row.fullName}? Usunie to też jego godziny i umowy.`,
      )
    )
      return;
    try {
      await deleteHrEmployee(row.id);
      await Promise.all([loadDictionaries(), loadMonth()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd usuwania");
    }
  };

  const handleContractSubmit = async (data: HrContractInput) => {
    if (!editable) return;
    if (contractEdit) await updateHrContract(contractEdit.id, data);
    else await createHrContract(data);
    await Promise.all([loadDictionaries(), loadMonth()]);
  };

  const handleContractDelete = async (row: HrContract) => {
    if (!editable) return;
    if (
      !window.confirm(
        `Usunąć umowę ${row.employeeName} — ${row.company}? Usunie to też jej dane płacowe.`,
      )
    )
      return;
    try {
      await deleteHrContract(row.id);
      await Promise.all([loadDictionaries(), loadMonth()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd usuwania");
    }
  };

  const handleOfficeSubmit = async (data: HrOfficeInput) => {
    if (!editable) return;
    if (officeEdit) await updateHrOffice(officeEdit.id, data);
    else await createHrOffice(data);
    await loadMonth();
  };

  const handleOfficeDelete = async (row: HrOfficeRow) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć wpis biura: ${row.employeeName}?`)) return;
    try {
      await deleteHrOffice(row.id);
      await loadMonth();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd usuwania");
    }
  };

  const handleObjectAdd = async () => {
    if (!editable) return;
    const name = newObjectName.trim();
    if (!name) return;
    try {
      await createHrObject({ name });
      setNewObjectName("");
      await loadDictionaries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd dodawania obiektu");
    }
  };

  const handleObjectRename = async (row: HrObject) => {
    if (!editable) return;
    const name = window.prompt("Nazwa obiektu:", row.name);
    if (!name || name.trim() === row.name) return;
    try {
      await updateHrObject(row.id, { name: name.trim(), active: row.active });
      await loadDictionaries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd zapisu obiektu");
    }
  };

  const handleObjectToggle = async (row: HrObject) => {
    if (!editable) return;
    try {
      await updateHrObject(row.id, { name: row.name, active: !row.active });
      await loadDictionaries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd zapisu obiektu");
    }
  };

  const handleObjectDelete = async (row: HrObject) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć obiekt ${row.name}?`)) return;
    try {
      await deleteHrObject(row.id);
      await loadDictionaries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd usuwania");
    }
  };

  /** Przypisanie pozycji kadrowej do obiektu z kartoteki (null = zdejmij). */
  const handleObjectMapping = async (row: HrObject, objectId: number | null) => {
    if (!editable) return;
    try {
      await setHrObjectMapping(row.id, objectId);
      await loadDictionaries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd zapisu mapowania");
    }
  };

  const handleNormSave = async (m: number) => {
    if (!editable) return;
    const existing = norms.find((n) => n.month === m);
    const draft = normDraft[m];
    const workNorm = draft?.workNorm ?? String(existing?.workNorm ?? "");
    const contractNorm =
      draft?.contractNorm ?? String(existing?.contractNorm ?? "");
    try {
      await saveHrNorm({ year, month: m, workNorm, contractNorm });
      await Promise.all([loadNorms(), loadMonth()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Błąd zapisu normy");
    }
  };

  // --- kafelki podsumowania ---
  const tiles = summary
    ? [
        {
          label: "Godziny (suma)",
          value: hrs(summary.totalHours),
          sub: `${summary.employeesWithHours} pracowników, ${summary.hoursEntries} wpisów`,
          tip: "Suma godzin wypracowanych + UW + L4 ze wszystkich wpisów miesiąca",
        },
        {
          label: "Przelewy",
          value: money(summary.przelew),
          sub: "wypłaty na konto",
          tip: "Suma części przelewowych wypłat ochrony (kwoty główne + dodatki kanałem przelew)",
        },
        {
          label: "Gotówka",
          value: money(summary.gotowka),
          sub: "wypłaty gotówką",
          tip: "Suma części gotówkowych wypłat ochrony (kwoty główne + dodatki kanałem gotówka)",
        },
        {
          label: "Wypłaty razem",
          value: money(summary.wyplaty),
          sub: `${summary.contractsCount} umów`,
          tip: "Przelewy + gotówka (ochrona, bez biura)",
        },
        {
          label: "Braki",
          value: String(summary.gaps),
          sub: `${summary.missingMain} bez kwoty, ${summary.pendingBonus} do przeliczenia`,
          tip: "Wiersze z godzinami bez kwoty od księgowości albo z dodatkiem czekającym na stawkę (umowa z oboma brakami liczona raz)",
          accent: summary.gaps > 0 ? "text-amber-600" : undefined,
        },
        {
          label: "Biuro",
          value: money(summary.officeTotal),
          sub: `${summary.officeCount} wpisów`,
          tip: "Suma wypłat biura: podstawy ROR + delegacje/gotówka",
        },
      ]
    : [];

  const sumPrzelew = payrollVisible.reduce((s, r) => s + r.przelew, 0);
  const sumGotowka = payrollVisible.reduce((s, r) => s + r.gotowka, 0);

  if (tab && MERGED_TABS[tab]) {
    return <Navigate to={`/kadry/${MERGED_TABS[tab]}`} replace />;
  }
  if (!tab || !KADRY_TABS.includes(tab as (typeof KADRY_TABS)[number])) {
    return <Navigate to="/kadry/wynagrodzenia" replace />;
  }

  // Wybór miesiąca dotyczy całej zakładki — wstawiamy go w pasek narzędzi
  // każdej podzakładki, zamiast zajmować osobny rząd nad kaflami.
  const monthNav = (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon" onClick={() => shiftMonth(-1)}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[150px] text-center font-medium">
        {MONTH_NAMES[month - 1]} {year}
      </span>
      <Button variant="outline" size="icon" onClick={() => shiftMonth(1)}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Card key={t.label} title={t.tip} className="cursor-help">
            <CardContent className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t.label}
              </p>
              <p className={cn("mt-1 text-xl font-bold", t.accent)}>
                {t.value}
              </p>
              <p className="text-xs text-muted-foreground">{t.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={tab}>
        {/* ==================== WYNAGRODZENIA ==================== */}
        <TabsContent value="wynagrodzenia" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {monthNav}
            <div className="relative min-w-[200px] max-w-xs flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={payrollFilter}
                onChange={(e) => setPayrollFilter(e.target.value)}
                placeholder="Szukaj: pracownik / spółka…"
                className="pl-10"
                data-testid="kadry-wynagrodzenia-filter-search"
              />
            </div>
            <Select value={payrollCompany} onValueChange={setPayrollCompany}>
              <SelectTrigger
                className="w-[190px]"
                data-testid="kadry-wynagrodzenia-filter-company"
              >
                <SelectValue placeholder="Spółka" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie spółki</SelectItem>
                {payrollCompanyOptions.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={payrollContractType}
              onValueChange={(v) =>
                setPayrollContractType(v as typeof payrollContractType)
              }
            >
              <SelectTrigger
                className="w-[160px]"
                data-testid="kadry-wynagrodzenia-filter-contract-type"
              >
                <SelectValue placeholder="Umowa" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Umowa: wszystkie</SelectItem>
                <SelectItem value="praca">Praca (UoP)</SelectItem>
                <SelectItem value="zlecenie">Zlecenie</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={payrollRegistration}
              onValueChange={(v) =>
                setPayrollRegistration(v as typeof payrollRegistration)
              }
            >
              <SelectTrigger
                className="w-[170px]"
                data-testid="kadry-wynagrodzenia-filter-registration"
              >
                <SelectValue placeholder="Zgłoszenie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Zgłoszenie: wszystkie</SelectItem>
                <SelectItem value="zua">ZUA (umowa główna)</SelectItem>
                <SelectItem value="zza">ZZA (nadwyżka)</SelectItem>
                <SelectItem value="none">Bez zgłoszenia</SelectItem>
              </SelectContent>
            </Select>
            <Select value={payrollBonusType} onValueChange={setPayrollBonusType}>
              <SelectTrigger
                className="w-[180px]"
                data-testid="kadry-wynagrodzenia-filter-bonus-type"
              >
                <SelectValue placeholder="Dodatek" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Dodatek: wszystkie</SelectItem>
                <SelectItem value="brak">Bez dodatku</SelectItem>
                <SelectItem value="gotowka">Gotówka</SelectItem>
                <SelectItem value="delegacja_przelew">Deleg. przelew</SelectItem>
                <SelectItem value="delegacja_gotowka">Deleg. gotówka</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={payrollMainChannel}
              onValueChange={(v) =>
                setPayrollMainChannel(v as typeof payrollMainChannel)
              }
            >
              <SelectTrigger
                className="w-[170px]"
                data-testid="kadry-wynagrodzenia-filter-main-channel"
              >
                <SelectValue placeholder="Kanał głównej" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Główna: oba kanały</SelectItem>
                <SelectItem value="przelew">Główna: przelew</SelectItem>
                <SelectItem value="gotowka">Główna: gotówka</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={payrollMaxSource}
              onValueChange={(v) =>
                setPayrollMaxSource(v as typeof payrollMaxSource)
              }
            >
              <SelectTrigger
                className="w-[190px]"
                data-testid="kadry-wynagrodzenia-filter-max-source"
              >
                <SelectValue placeholder="Źródło maks" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Maks: dowolne źródło</SelectItem>
                <SelectItem value="norm">Maks: norma miesiąca</SelectItem>
                <SelectItem value="individual">Maks: indywidualne</SelectItem>
                <SelectItem value="override">Maks: nadpisane ręcznie</SelectItem>
              </SelectContent>
            </Select>
            {/* Tryby odpowiadają kaflowi „Braki”: `braki` to jego liczba,
                dwa kolejne — jego składniki z podpisu kafla. */}
            <Select
              value={payrollGaps}
              onValueChange={(v) => setPayrollGaps(v as PayrollGapMode)}
            >
              <SelectTrigger
                className="w-[200px]"
                data-testid="kadry-wynagrodzenia-filter-gaps"
              >
                <SelectValue placeholder="Braki" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Braki: wszystkie wiersze</SelectItem>
                <SelectItem value="braki">Braki (jak na kaflu)</SelectItem>
                <SelectItem value="missing">Kwota główna pusta</SelectItem>
                <SelectItem value="pending">Dodatek do przeliczenia</SelectItem>
                <SelectItem value="warnings">Z ostrzeżeniami</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Input
                value={payrollMin}
                onChange={(e) => setPayrollMin(e.target.value)}
                placeholder="Wypłata od"
                inputMode="decimal"
                className="w-[110px]"
                data-testid="kadry-wynagrodzenia-filter-min"
              />
              <span className="text-muted-foreground">–</span>
              <Input
                value={payrollMax}
                onChange={(e) => setPayrollMax(e.target.value)}
                placeholder="do"
                inputMode="decimal"
                className="w-[90px]"
                data-testid="kadry-wynagrodzenia-filter-max"
              />
            </div>
            {payrollFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearPayrollFilters}
                data-testid="kadry-wynagrodzenia-filters-clear"
              >
                <X className="mr-1 h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
            {/* Wydruk bierze to, co widać w tabeli — inaczej „zestawienie dla
                księgowości” po zawężeniu do jednej spółki dowoziłoby wszystkie. */}
            <Button
              variant="outline"
              className="ml-auto"
              onClick={() => printHrStatement(payrollVisible, year, month)}
            >
              <Printer className="mr-2 h-4 w-4" />
              Zestawienie dla księgowości
            </Button>
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[1280px] text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <SortTh
                      label="Pracownik"
                      sortKey="employeeName"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      tip="Pracownik z umowy — kliknij wiersz, aby wpisać kwoty i nadpisania"
                    />
                    <SortTh
                      label="Spółka"
                      sortKey="company"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      tip="Spółka zatrudniająca (z umowy)"
                    />
                    <SortTh
                      label="Umowa"
                      sortKey="contractType"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      tip="Typ umowy: Praca (UoP) / Zlecenie — decyduje o normie godzin i wliczaniu L4"
                    />
                    <Th tip="Zgłoszenie decydujące o gałęzi kalkulacji: ZUA = umowa główna (godziny do maks), ZZA = nadwyżka ponad normę umowy głównej">
                      Rej.
                    </Th>
                    <SortTh
                      label="Maks"
                      sortKey="maksGodziny"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Limit godzin: ręczne nadpisanie → indywidualne GODZINY MAKS z wpisów godzin (przy UoP, największy wpis) → norma miesiąca z zakładki Normy"
                    />
                    <SortTh
                      label="Fakt"
                      sortKey="faktGodziny"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Godziny do rozliczenia: ZUA = min(wypracowane + UW (+ L4 przy UoP), maks); ZZA = nadwyżka ponad normę UoP (gdy pracownik ma umowę o pracę) albo ponad maks. Ręczne nadpisanie ma pierwszeństwo"
                    />
                    <Th
                      tip="Godziny dodatku = wypracowane + UW (+ L4 przy UoP lub zleceniu w ALFA) − maks godziny; liczone tylko gdy umowa ma ustawiony dodatek"
                      className="text-right"
                    >
                      Godz. dod.
                    </Th>
                    <SortTh
                      label="Stawka"
                      sortKey="stawkaNetto"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Stawka netto = kwota główna NETTO ÷ fakt godziny"
                    />
                    <SortTh
                      label="Kwota główna"
                      sortKey="kwotaGlowna"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Kwota główna NETTO — wpisywana ręcznie na podstawie zestawienia od księgowości (kanał: kolumna Główna)"
                    />
                    <SortTh
                      label="Wyrówn."
                      sortKey="kwotaWyrownania"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Kwota wyrównania = wyrównanie stawki (zł/h, wpisywane ręcznie) × fakt godziny"
                    />
                    <Th
                      tip="Kwota dodatku = godziny dodatku × stawka dodatku (gdy brak stawki dodatku — stawka netto z wypłaty głównej); ręczne nadpisanie ma pierwszeństwo"
                      className="text-right"
                    >
                      Kwota dod.
                    </Th>
                    <Th
                      tip="Premia/potrącenie = suma DODATKI − POTRĄCENIA z wpisów godzin miesiąca; przypisywana raz na pracownika (do pierwszej umowy nie-ZZA)"
                      className="text-right"
                    >
                      Premia/potr.
                    </Th>
                    <SortTh
                      label="Dod. finalny"
                      sortKey="dodatekFinalny"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Dodatek finalny = kwota dodatku + premia/potrącenie + kwota wyrównania"
                    />
                    <SortTh
                      label="Przelew"
                      sortKey="przelew"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Przelew = kwota główna (gdy Główna=przelew) + dodatek finalny (gdy kanał dodatku=przelew; przy braku dodatku — kanałem wypłaty głównej). Poprawka względem Excela: premia bez dodatku nie przepada"
                    />
                    <SortTh
                      label="Gotówka"
                      sortKey="gotowka"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Gotówka = kwota główna (gdy Główna=gotówka) + dodatek finalny (gdy kanał dodatku=gotówka; przy braku dodatku — kanałem wypłaty głównej)"
                    />
                    <SortTh
                      label="Wypłata"
                      sortKey="wyplata"
                      sort={payrollSort}
                      dir={payrollDir}
                      onSort={togglePayrollSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Wypłata całkowita = przelew + gotówka"
                    />
                    <Th tip="Rodzaj dodatku z umowy — decyduje o godzinach dodatku i kanale ich wypłaty">
                      Dodatek
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td
                        colSpan={17}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        Ładowanie…
                      </td>
                    </tr>
                  ) : payrollVisible.length === 0 ? (
                    <tr>
                      <td
                        colSpan={17}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        {payrollFiltersActive
                          ? "Brak wypłat dla wybranych filtrów"
                          : "Brak umów — dodaj je w zakładce Pracownicy"}
                      </td>
                    </tr>
                  ) : (
                    payrollVisible.map((r) => (
                      <tr
                        key={r.contractId}
                        className={cn(
                          "border-b hover:bg-accent/50",
                          editable && "cursor-pointer",
                        )}
                        onClick={
                          editable ? () => setPayrollEdit(r) : undefined
                        }
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-medium">
                          {r.employeeName}
                          {(r.warnings.length > 0 || r.bonusPending) && (
                            <AlertTriangle
                              className="ml-1 inline h-3.5 w-3.5 text-amber-500"
                              aria-label={r.warnings.join("; ")}
                            />
                          )}
                        </td>
                        <td className="px-3 py-2">{r.company}</td>
                        <td className="px-3 py-2">
                          {r.contractType === "praca" ? "Praca" : "Zlecenie"}
                        </td>
                        <td className="px-3 py-2 uppercase">
                          {r.registration ?? "—"}
                        </td>
                        <td
                          className="px-3 py-2 text-right"
                          title={
                            r.maxHoursSource === "override"
                              ? "Nadpisane ręcznie"
                              : r.maxHoursSource === "individual"
                                ? "Indywidualne GODZINY MAKS z wpisów godzin"
                                : "Norma miesiąca"
                          }
                        >
                          {hrs(r.maksGodziny)}
                          {r.maxHoursSource !== "norm" && "*"}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {hrs(r.faktGodziny)}
                          {r.inputs.actualHoursOverride != null && "*"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.godzinyDodatek ? hrs(r.godzinyDodatek) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.stawkaNetto != null ? hrs(r.stawkaNetto) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.kwotaGlowna != null ? money(r.kwotaGlowna) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.kwotaWyrownania != null
                            ? money(r.kwotaWyrownania)
                            : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.bonusPending ? (
                            <span className="text-amber-600">do przelicz.</span>
                          ) : r.kwotaDodatku != null ? (
                            money(r.kwotaDodatku)
                          ) : (
                            ""
                          )}
                          {r.inputs.bonusAmountOverride != null && "*"}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right",
                            (r.premiaPotracenie ?? 0) < 0 && "text-red-600",
                          )}
                        >
                          {r.premiaPotracenie != null
                            ? money(r.premiaPotracenie)
                            : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.dodatekFinalny != null
                            ? money(r.dodatekFinalny)
                            : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.przelew ? money(r.przelew) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.gotowka ? money(r.gotowka) : ""}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold">
                          {r.wyplata ? money(r.wyplata) : ""}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {BONUS_SHORT[r.bonusType]}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {payrollVisible.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 bg-muted/40 font-semibold">
                      <td className="px-3 py-2" colSpan={13}>
                        Razem ({payrollVisible.length})
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(sumPrzelew)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(sumGotowka)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(sumPrzelew + sumGotowka)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            * — wartość nadpisana ręcznie. Kliknij wiersz, aby wpisać kwotę od
            księgowości, stawkę dodatku lub nadpisania.
          </p>

          {/* ---------- BIURO ---------- */}
          {/* Rozliczenie pracowników biura tego samego miesiąca — osobna
              tabela, bo liczy się inaczej (kwota z godzin×stawki, rozbicie
              ROR/gotówka), ale to wciąż „pieniądze za miesiąc”, więc siedzi
              obok wypłat ochrony zamiast we własnej podzakładce. */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Biuro — {MONTH_NAMES[month - 1]} {year}
            </h2>
            {/* Licznik po filtrach: szukajka i spółka z paska nad wypłatami
                obejmują też tę tabelę, więc trzeba widać, ile z ilu zostało. */}
            <span
              className="text-xs text-muted-foreground"
              data-testid="kadry-biuro-count"
            >
              {officeVisible.length}
              {officeVisible.length === office.length
                ? ""
                : ` z ${office.length}`}{" "}
              wpisów
            </span>
            {editable && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => {
                  setOfficeEdit(null);
                  setOfficeFormOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Dodaj wpis biura
              </Button>
            )}
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[1080px] text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <SortTh
                      label="Pracownik"
                      sortKey="employeeName"
                      sort={officeSort}
                      dir={officeDir}
                      onSort={toggleOfficeSort}
                      testIdPrefix="kadry-biuro-sort"
                      tip="Pracownik biura — osobne rozliczenie, poza kalkulacją ochrony"
                    />
                    <SortTh
                      label="Spółka"
                      sortKey="company"
                      sort={officeSort}
                      dir={officeDir}
                      onSort={toggleOfficeSort}
                      testIdPrefix="kadry-biuro-sort"
                      tip="Spółka i forma zatrudnienia (ALFA ETAT / ALFA UZ / …)"
                    />
                    <Th tip="Nominalne godziny etatu" className="text-right">
                      Etat
                    </Th>
                    <Th tip="Urlop / chorobowe (h)" className="text-right">
                      UW/L4
                    </Th>
                    <SortTh
                      label="Godz. do księg."
                      sortKey="hoursForAccounting"
                      sort={officeSort}
                      dir={officeDir}
                      onSort={toggleOfficeSort}
                      testIdPrefix="kadry-biuro-sort"
                      align="right"
                      tip="Godziny do księgowej — dla rozliczanych godzinowo (UZ)"
                    />
                    <SortTh
                      label="Stawka"
                      sortKey="rate"
                      sort={officeSort}
                      dir={officeDir}
                      onSort={toggleOfficeSort}
                      testIdPrefix="kadry-biuro-sort"
                      align="right"
                      tip="Stawka godzinowa (zł/h)"
                    />
                    <Th
                      tip="Kwota wypłaty: ręczna, a gdy pusta — godziny do księgowej × stawka"
                      className="text-right"
                    >
                      Kwota
                    </Th>
                    <Th
                      tip="Podstawa ROR — część na przelew (podaje księgowość)"
                      className="text-right"
                    >
                      Podstawa ROR
                    </Th>
                    <Th
                      tip="Delegacje/gotówka: ręczna, a gdy pusta — kwota − podstawa ROR (gdy dodatnia)"
                      className="text-right"
                    >
                      Deleg./gotówka
                    </Th>
                    <SortTh
                      label="Razem"
                      sortKey="total"
                      sort={officeSort}
                      dir={officeDir}
                      onSort={toggleOfficeSort}
                      testIdPrefix="kadry-biuro-sort"
                      align="right"
                      tip="Razem = podstawa ROR + delegacje/gotówka"
                    />
                    <Th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {officeVisible.length === 0 ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        {loading
                          ? "Ładowanie…"
                          : payrollFiltersActive
                            ? "Brak wpisów biura dla wybranych filtrów"
                            : "Brak wpisów biura w tym miesiącu"}
                      </td>
                    </tr>
                  ) : (
                    officeVisible.map((r) => (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b hover:bg-accent/50",
                          editable && "cursor-pointer",
                        )}
                        onClick={
                          editable
                            ? () => {
                                setOfficeEdit(r);
                                setOfficeFormOpen(true);
                              }
                            : undefined
                        }
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-medium">
                          {r.employeeName}
                        </td>
                        <td className="px-3 py-2">{r.company || "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {r.etatHours != null ? hrs(r.etatHours) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.uwL4 != null ? hrs(r.uwL4) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.hoursForAccounting != null
                            ? hrs(r.hoursForAccounting)
                            : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.rate != null ? hrs(r.rate) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.amountComputed != null
                            ? money(r.amountComputed)
                            : ""}
                          {r.amount == null && r.amountComputed != null && "*"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.rorBase != null ? money(r.rorBase) : ""}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.cash != null ? money(r.cash) : ""}
                          {r.cashOverride == null && r.cash != null && "*"}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold">
                          {r.total ? money(r.total) : ""}
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
                                onClick={() => {
                                  setOfficeEdit(r);
                                  setOfficeFormOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleOfficeDelete(r)}
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
                {/* Sumy liczą PRZEFILTROWANY zbiór — stopka ma podsumowywać to,
                    co widać nad nią, a nie cały miesiąc. */}
                {officeVisible.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 bg-muted/40 font-semibold">
                      <td className="px-3 py-2" colSpan={7}>
                        Razem ({officeVisible.length})
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(
                          officeVisible.reduce((s, r) => s + (r.rorBase ?? 0), 0),
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(
                          officeVisible.reduce((s, r) => s + (r.cash ?? 0), 0),
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(officeVisible.reduce((s, r) => s + r.total, 0))}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            * — wartość wyliczona automatycznie (kwota z godzin × stawki,
            gotówka z kwoty − podstawy ROR).
          </p>
        </TabsContent>

        {/* ==================== GODZINY ==================== */}
        {/* Cały ekran (filtry, przełącznik trybu, tabela) siedzi w HrHoursTab —
            edycja inline ma własny stan brudnopisów, który nie ma po co
            mieszać się ze stanem całego modułu. */}
        <TabsContent value="godziny" className="space-y-4">
          <HrHoursTab
            rows={hours}
            objects={objects}
            departments={departments}
            editable={editable}
            loading={loading}
            monthNav={monthNav}
            onRowSaved={handleHoursRowSaved}
            onAdd={() => {
              setHoursEdit(null);
              setHoursFormOpen(true);
            }}
            onEdit={(row) => {
              setHoursEdit(row);
              setHoursFormOpen(true);
            }}
            onDelete={handleHoursDelete}
          />
        </TabsContent>

        {/* ==================== BIURO ==================== */}
        {/* ============ PRACOWNICY (kartoteka + umowy + biuro) ============ */}
        {/* Jedna zakładka zamiast trzech: wiersz = osoba, a po rozwinięciu jej
            umowy (słownikowe, niezależne od miesiąca) i wpisy biura z miesiąca
            wybranego w pasku. Dzięki temu „kto, w jakiej spółce, za ile” widać
            bez skakania między podzakładkami. */}
        <TabsContent value="pracownicy" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {monthNav}
            <div className="relative min-w-[200px] max-w-xs flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                placeholder="Szukaj: pracownik, kod, spółka…"
                className="pl-10"
                data-testid="kadry-pracownicy-filter-search"
              />
            </div>
            {/* Dawne podzakładki jako filtr jednej listy: ochrona = osoby z
                umowami, biuro = osoby z wpisami biura w tym miesiącu. */}
            <div className="flex overflow-hidden rounded-md border">
              {(
                [
                  ["all", "Wszyscy"],
                  ["ochrona", "Ochrona"],
                  ["biuro", "Biuro"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setEmployeeKind(k)}
                  data-testid={`kadry-pracownicy-filter-kind-${k}`}
                  className={cn(
                    "px-3 py-2 text-sm",
                    employeeKind === k
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Dział pracownika: „bez działu" jest osobną opcją, bo to ona
                wskazuje kartoteki do uzupełnienia. */}
            <Select
              value={employeeDept === "all" ? "all" : String(employeeDept)}
              onValueChange={(v) =>
                setEmployeeDept(v === "all" || v === "none" ? v : Number(v))
              }
            >
              <SelectTrigger
                className="w-[190px]"
                title="Filtr po dziale z kartoteki pracownika"
                data-testid="kadry-pracownicy-filter-dept"
              >
                <SelectValue placeholder="Dział" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie działy</SelectItem>
                <SelectItem value="none">Bez działu</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={employeeActive}
              onValueChange={(v) => setEmployeeActive(v as ActiveFilter)}
            >
              <SelectTrigger
                className="w-[170px]"
                data-testid="kadry-pracownicy-filter-active"
              >
                <SelectValue placeholder="Aktywność" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Tylko aktywni</SelectItem>
                <SelectItem value="inactive">Tylko nieaktywni</SelectItem>
                <SelectItem value="all">Aktywni i nieaktywni</SelectItem>
              </SelectContent>
            </Select>
            <Select value={employeeCompany} onValueChange={setEmployeeCompany}>
              <SelectTrigger
                className="w-[190px]"
                title="Spółka z umowy albo z rozliczenia biura"
                data-testid="kadry-pracownicy-filter-company"
              >
                <SelectValue placeholder="Spółka" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie spółki</SelectItem>
                {employeeCompanyOptions.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Bez umowy = osoba, która nie pojawi się w wynagrodzeniach —
                w ochronie to błąd do naprawienia, nie stan docelowy. */}
            <Select
              value={employeeContracts}
              onValueChange={(v) =>
                setEmployeeContracts(v as typeof employeeContracts)
              }
            >
              <SelectTrigger
                className="w-[180px]"
                data-testid="kadry-pracownicy-filter-contracts"
              >
                <SelectValue placeholder="Umowy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Umowy: wszyscy</SelectItem>
                <SelectItem value="none">Tylko bez umowy</SelectItem>
                <SelectItem value="with">Tylko z umową</SelectItem>
              </SelectContent>
            </Select>
            {employeeFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearEmployeeFilters}
                data-testid="kadry-pracownicy-filters-clear"
              >
                <X className="mr-1 h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() =>
                setExpanded(
                  expanded.size === employeesVisible.length
                    ? new Set()
                    : new Set(employeesVisible.map((e) => e.id)),
                )
              }
            >
              {expanded.size === employeesVisible.length && employeesVisible.length > 0
                ? "Zwiń wszystkie"
                : "Rozwiń wszystkie"}
            </Button>
            {editable && (
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setContractEdit(null);
                    setFormEmployeeId(undefined);
                    setContractFormOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Umowa
                </Button>
                <Button
                  onClick={() => {
                    setEmployeeEdit(null);
                    setEmployeeFormOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Dodaj pracownika
                </Button>
              </div>
            )}
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[1120px] text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th className="w-8" />
                    <SortTh
                      label="Nazwisko i imię"
                      sortKey="fullName"
                      sort={employeeSort}
                      dir={employeeDir}
                      onSort={toggleEmployeeSort}
                      testIdPrefix="kadry-pracownicy-sort"
                      tip="Nazwisko i imię — klucz łączący godziny, umowy i wynagrodzenia"
                    />
                    <SortTh
                      label="Kod"
                      sortKey="code"
                      sort={employeeSort}
                      dir={employeeDir}
                      onSort={toggleEmployeeSort}
                      testIdPrefix="kadry-pracownicy-sort"
                      tip="Kod statusu (Emeryt / Rencista / Student <26 lat) — informacyjny"
                    />
                    {/* Jedna kolumna, dwa sortowania: „Rodzaj” układa ochronę
                        przed biurem, „umowy” — po ich liczbie w wierszu. */}
                    <SortTh
                      label="Rodzaj"
                      sortKey="kind"
                      sort={employeeSort}
                      dir={employeeDir}
                      onSort={toggleEmployeeSort}
                      testIdPrefix="kadry-pracownicy-sort"
                      tip="Ochrona = osoba z umową kadrową; Biuro = osoba rozliczana w zestawieniu biura (wybrany miesiąc)"
                    />
                    <SortTh
                      label="Umowy"
                      sortKey="contracts"
                      sort={employeeSort}
                      dir={employeeDir}
                      onSort={toggleEmployeeSort}
                      testIdPrefix="kadry-pracownicy-sort"
                      align="right"
                      tip="Liczba umów kadrowych pracownika — bez żadnej nie pojawi się w wynagrodzeniach"
                    />
                    <SortTh
                      label="Dział"
                      sortKey="departmentName"
                      sort={employeeSort}
                      dir={employeeDir}
                      onSort={toggleEmployeeSort}
                      testIdPrefix="kadry-pracownicy-sort"
                      tip="Macierzysty dział z kartoteki — podpowiadany przy nowym wpisie godzin, ale wpis można rozliczyć na obiekcie"
                    />
                    <Th tip="Spółki z umów i z rozliczenia biura — rozwiń wiersz, aby wejść w szczegóły">
                      Spółki
                    </Th>
                    <SortTh
                      label="Status"
                      sortKey="active"
                      sort={employeeSort}
                      dir={employeeDir}
                      onSort={toggleEmployeeSort}
                      testIdPrefix="kadry-pracownicy-sort"
                      tip="Nieaktywny pracownik nie jest podpowiadany w formularzach"
                    />
                    <Th>Notatka</Th>
                    <SortTh
                      label="Zmiana"
                      sortKey="updatedAt"
                      sort={employeeSort}
                      dir={employeeDir}
                      onSort={toggleEmployeeSort}
                      testIdPrefix="kadry-pracownicy-sort"
                      tip="Ostatnia zmiana w kartotece tego pracownika"
                    />
                    <Th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {employeesVisible.length === 0 ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        {loading
                          ? "Ładowanie…"
                          : employeeFiltersActive
                            ? "Brak pracowników dla wybranych filtrów"
                            : "Brak pracowników"}
                      </td>
                    </tr>
                  ) : (
                    employeesVisible.map((r) => {
                      const rowContracts = contractsByEmployee.get(r.id) ?? [];
                      const isOpen = expanded.has(r.id);
                      return (
                        <Fragment key={r.id}>
                          <tr
                            className={cn(
                              "cursor-pointer border-b hover:bg-accent/50",
                              isOpen && "bg-accent/30",
                            )}
                            onClick={() => toggleExpanded(r.id)}
                          >
                            <td className="px-3 py-2 text-muted-foreground">
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </td>
                            <td className="px-3 py-2 font-medium">{r.fullName}</td>
                            <td className="px-3 py-2">{r.code}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap items-center gap-1">
                                {r.kind === "biuro" ? (
                                  <span
                                    className="inline-flex rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700"
                                    title="Pracownik biura — rozliczany w zakładce Wynagrodzenia, sekcja Biuro"
                                  >
                                    Biuro
                                  </span>
                                ) : (
                                  <span
                                    className="inline-flex rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700"
                                    title="Ochrona — rozliczana z umów kadrowych"
                                  >
                                    Ochrona
                                  </span>
                                )}
                              </div>
                            </td>
                            {/* Liczba umów wyszła z kolumny „Rodzaj” do
                                własnej, żeby dało się po niej sortować —
                                „ochrona bez umów” to lista do naprawienia. */}
                            <td className="px-3 py-2 text-right tabular-nums">
                              {rowContracts.length > 0 ? (
                                <span className="text-xs text-muted-foreground">
                                  {rowContracts.length}
                                </span>
                              ) : r.kind === "ochrona" ? (
                                <span className="text-xs text-amber-600">
                                  brak umów
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {r.departmentName || "—"}
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {[
                                ...new Set([
                                  ...rowContracts.map((c) => c.company),
                                  ...(r.officeCompanies ?? []),
                                ]),
                              ]
                                .filter(Boolean)
                                .join(", ") || "—"}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={cn(
                                  "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
                                  r.active
                                    ? "bg-emerald-100 text-emerald-700"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {r.active ? "aktywny" : "nieaktywny"}
                              </span>
                            </td>
                            <td className="max-w-[240px] truncate px-3 py-2 text-xs text-muted-foreground">
                              {r.notes}
                            </td>
                            <td
                              className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground"
                              title={r.updatedAt}
                            >
                              {r.updatedAt ? r.updatedAt.slice(0, 10) : "—"}
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
                                    title="Edytuj pracownika"
                                    onClick={() => {
                                      setEmployeeEdit(r);
                                      setEmployeeFormOpen(true);
                                    }}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title="Usuń pracownika"
                                    onClick={() => handleEmployeeDelete(r)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="border-b bg-muted/20">
                              <td colSpan={11} className="px-3 py-3">
                                <div className="space-y-4">
                                  {/* --- UMOWY pracownika --- */}
                                  <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        Umowy
                                      </h3>
                                      {editable && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => {
                                            setContractEdit(null);
                                            setFormEmployeeId(r.id);
                                            setContractFormOpen(true);
                                          }}
                                        >
                                          <Plus className="mr-1 h-3.5 w-3.5" />
                                          Dodaj umowę
                                        </Button>
                                      )}
                                    </div>
                                    {rowContracts.length === 0 ? (
                                      <p className="text-xs text-muted-foreground">
                                        Brak umów — bez nich pracownik nie pojawi
                                        się w wynagrodzeniach.
                                      </p>
                                    ) : (
                                      <div className="overflow-x-auto rounded-md border bg-background">
                                        <table className="w-full min-w-[760px] text-sm">
                                          <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                                            <tr>
                                              <Th tip="Spółka zatrudniająca — ze słownika Spółki">
                                                Spółka
                                              </Th>
                                              <Th tip="Praca (UoP) / Zlecenie — decyduje o normie i wliczaniu L4">
                                                Umowa
                                              </Th>
                                              <Th tip="Ubezpieczenie chorobowe — informacyjne">
                                                chor.
                                              </Th>
                                              <Th tip="Zgłoszenie ZUA — niepuste włącza rozliczanie godzin do maks">
                                                ZUA
                                              </Th>
                                              <Th tip="Zgłoszenie ZZA — wiersz dostaje nadwyżkę godzin ponad normę umowy głównej">
                                                ZZA
                                              </Th>
                                              <Th tip="Kanał wypłaty głównej">
                                                Główna
                                              </Th>
                                              <Th tip="Rodzaj dodatku — decyduje o godzinach nadwyżki i kanale ich wypłaty">
                                                Dodatek
                                              </Th>
                                              <Th tip="Nieaktywna umowa nie pojawia się w wynagrodzeniach (poza miesiącami z zapisanymi danymi)">
                                                Status
                                              </Th>
                                              <Th className="w-20" />
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {rowContracts.map((ct) => (
                                              <tr
                                                key={ct.id}
                                                className={cn(
                                                  "border-b last:border-0 hover:bg-accent/50",
                                                  editable && "cursor-pointer",
                                                )}
                                                onClick={
                                                  editable
                                                    ? () => {
                                                        setContractEdit(ct);
                                                        setFormEmployeeId(undefined);
                                                        setContractFormOpen(true);
                                                      }
                                                    : undefined
                                                }
                                              >
                                                <td className="px-3 py-2 font-medium">
                                                  {ct.company}
                                                </td>
                                                <td className="px-3 py-2">
                                                  {ct.contractType === "praca"
                                                    ? "Praca"
                                                    : "Zlecenie"}
                                                </td>
                                                <td className="px-3 py-2">
                                                  {ct.chor ? "tak" : ""}
                                                </td>
                                                <td className="px-3 py-2">{ct.zua}</td>
                                                <td className="px-3 py-2">{ct.zza}</td>
                                                <td className="px-3 py-2">
                                                  {ct.mainChannel === "przelew"
                                                    ? "Przelew"
                                                    : "Gotówka"}
                                                </td>
                                                <td className="px-3 py-2">
                                                  {BONUS_SHORT[ct.bonusType]}
                                                </td>
                                                <td className="px-3 py-2">
                                                  <span
                                                    className={cn(
                                                      "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
                                                      ct.active
                                                        ? "bg-emerald-100 text-emerald-700"
                                                        : "bg-muted text-muted-foreground",
                                                    )}
                                                  >
                                                    {ct.active
                                                      ? "aktywna"
                                                      : "nieaktywna"}
                                                  </span>
                                                </td>
                                                <td className="px-3 py-2">
                                                  {editable && (
                                                    <div
                                                      className="flex justify-end gap-1"
                                                      onClick={(e) =>
                                                        e.stopPropagation()
                                                      }
                                                    >
                                                      <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        title="Edytuj umowę"
                                                        onClick={() => {
                                                          setContractEdit(ct);
                                                          setFormEmployeeId(undefined);
                                                          setContractFormOpen(true);
                                                        }}
                                                      >
                                                        <Pencil className="h-4 w-4" />
                                                      </Button>
                                                      <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        title="Usuń umowę"
                                                        onClick={() =>
                                                          handleContractDelete(ct)
                                                        }
                                                      >
                                                        <Trash2 className="h-4 w-4" />
                                                      </Button>
                                                    </div>
                                                  )}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>

                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
                {employeesVisible.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 bg-muted/40 font-semibold">
                      <td className="px-3 py-2" colSpan={4}>
                        Razem ({employeesVisible.length}
                        {employeesVisible.length === employees.length
                          ? ""
                          : ` z ${employees.length}`}{" "}
                        prac.)
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-normal tabular-nums text-muted-foreground">
                        {visibleContractsCount}
                      </td>
                      <td colSpan={6} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            Kartoteka jest niezależna od miesiąca. Miesięczne rozliczenie
            pracowników biura znajdziesz w zakładce Wynagrodzenia.
          </p>
        </TabsContent>


        {/* ==================== OBIEKTY ==================== */}
        <TabsContent value="obiekty" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {monthNav}
            <div className="relative min-w-[180px] max-w-xs flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={objectSearch}
                onChange={(e) => setObjectSearch(e.target.value)}
                placeholder="Szukaj: nazwa pozycji…"
                className="pl-10"
                data-testid="kadry-obiekty-filter-search"
              />
            </div>
            <Select
              value={objectMapping}
              onValueChange={(v) => setObjectMapping(v as typeof objectMapping)}
            >
              <SelectTrigger
                className="w-[190px]"
                data-testid="kadry-obiekty-filter-mapping"
              >
                <SelectValue placeholder="Mapowanie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Mapowanie: wszystkie</SelectItem>
                <SelectItem value="unmapped">Tylko niezmapowane</SelectItem>
                <SelectItem value="mapped">Tylko zmapowane</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={objectActive}
              onValueChange={(v) => setObjectActive(v as ActiveFilter)}
            >
              <SelectTrigger
                className="w-[170px]"
                data-testid="kadry-obiekty-filter-active"
              >
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
            <Select
              value={objectTech}
              onValueChange={(v) => setObjectTech(v as typeof objectTech)}
            >
              <SelectTrigger
                className="w-[220px]"
                data-testid="kadry-obiekty-filter-tech"
              >
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
                checked={objectWithHours}
                onCheckedChange={(checked) =>
                  setObjectWithHours(checked === true)
                }
                data-testid="kadry-obiekty-filter-with-hours"
              />
              <label
                htmlFor="kadry-obiekty-with-hours"
                className="cursor-pointer text-sm"
              >
                Tylko z godzinami
              </label>
            </div>
            {objectFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearObjectFilters}
                data-testid="kadry-obiekty-filters-clear"
              >
                <X className="mr-1 h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
            {editable && (
              <div className="ml-auto flex max-w-md gap-2">
                <Input
                  value={newObjectName}
                  onChange={(e) => setNewObjectName(e.target.value)}
                  placeholder="Nazwa nowego obiektu…"
                  onKeyDown={(e) => e.key === "Enter" && handleObjectAdd()}
                />
                <Button onClick={handleObjectAdd} disabled={!newObjectName.trim()}>
                  <Plus className="mr-2 h-4 w-4" />
                  Dodaj
                </Button>
              </div>
            )}
          </div>
          {/* Postęp mapowania — od niego zależy, ile kosztu osobowego w ogóle
              trafi do Analityki obiektów; niezmapowana pozycja zostaje kosztem
              nieprzypisanym do nikogo. */}
          <Card>
            <CardContent className="space-y-2 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  Zmapowano {mappingProgress.mapped} z {mappingProgress.total}{" "}
                  pozycji z godzinami
                </span>
                <span className="text-xs text-muted-foreground">
                  {hrs(mappingProgress.hoursMapped)} z{" "}
                  {hrs(mappingProgress.hoursTotal)} godz. trafi do kosztu
                  obiektów w Analityce
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{
                    width: `${
                      mappingProgress.total
                        ? Math.round(
                            (mappingProgress.mapped / mappingProgress.total) *
                              100,
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Słownik kadrowy powstał niezależnie od kartoteki i nazwy się nie
                pokrywają, więc powiązanie ustawia się ręcznie. Pozycje
                techniczne (#BIURO, #zlecenie) zostaw niezmapowane — to koszt
                ogólny firmy, nie koszt obiektu. Praca działowa (CMA, Handlowy,
                Księgowość…) ma własny słownik w Kadry → Działy i we wpisie
                godzin wybiera się ją zamiast obiektu.
              </p>
            </CardContent>
          </Card>
          {/* Postęp mapowania powyżej liczy CAŁY słownik (to miara roboty do
              wykonania), więc licznik listy stoi osobno — pokazuje, ile pozycji
              zostało po filtrach. */}
          <p
            className="text-sm text-muted-foreground"
            data-testid="kadry-obiekty-count"
          >
            {objectsVisible.length}
            {objectsVisible.length === objects.length
              ? ""
              : ` z ${objects.length}`}{" "}
            pozycji · {hrs(objectsVisible.reduce((s, o) => s + o.hoursTotal, 0))} h
          </p>
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <SortTh
                      label="Obiekt kadrowy"
                      sortKey="name"
                      sort={objectSort}
                      dir={objectDir}
                      onSort={toggleObjectSort}
                      testIdPrefix="kadry-obiekty-sort"
                      tip="Nazwa obiektu (posterunku) — słownik do wpisów godzin"
                    />
                    <SortTh
                      label="Godziny"
                      sortKey="hoursTotal"
                      sort={objectSort}
                      dir={objectDir}
                      onSort={toggleObjectSort}
                      testIdPrefix="kadry-obiekty-sort"
                      align="right"
                      tip="Suma godzin wypracowanych na tej pozycji z całej historii — im więcej, tym ważniejsze mapowanie"
                    />
                    <SortTh
                      label="Pracownicy"
                      sortKey="employeesCount"
                      sort={objectSort}
                      dir={objectDir}
                      onSort={toggleObjectSort}
                      testIdPrefix="kadry-obiekty-sort"
                      align="right"
                      tip="Ilu różnych pracowników kiedykolwiek księgowało godziny na tej pozycji"
                    />
                    <SortTh
                      label="Obiekt w kartotece"
                      sortKey="mapping"
                      sort={objectSort}
                      dir={objectDir}
                      onSort={toggleObjectSort}
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
                  {objectsVisible.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        {loading
                          ? "Ładowanie…"
                          : objectFiltersActive
                            ? "Brak pozycji dla wybranych filtrów"
                            : "Brak pozycji w słowniku kadrowym"}
                      </td>
                    </tr>
                  )}
                  {objectsVisible.map((r) => {
                    const overhead = overheadKind(r.name);
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b hover:bg-accent/50",
                          overhead && "bg-muted/30 text-muted-foreground",
                        )}
                      >
                        <td className="px-3 py-2 font-medium">
                          {r.name}
                          {overhead && (
                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal">
                              pozycja techniczna
                            </span>
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
                              className="text-xs italic"
                              title="Koszt ogólny firmy — przypisanie go do jednego obiektu obciążyłoby jednego klienta kosztem wszystkich"
                            >
                              koszt ogólny, nie mapuj
                            </span>
                          ) : (
                            <select
                              className={TABLE_SELECT_CLS}
                              value={r.objectId ?? ""}
                              disabled={!editable}
                              aria-label={`Obiekt w kartotece dla pozycji ${r.name}`}
                              title={
                                r.object
                                  ? catalogLabel(r.object)
                                  : "Wskaż obiekt z kartoteki, którego dotyczą godziny tej pozycji"
                              }
                              onChange={(e) =>
                                handleObjectMapping(
                                  r,
                                  e.target.value ? Number(e.target.value) : null,
                                )
                              }
                            >
                              <option value="">— nie mapuj —</option>
                              {objectCatalog.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {catalogLabel(o)}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => handleObjectToggle(r)}
                            disabled={!editable}
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
                        <td className="px-3 py-2">
                          {editable && (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleObjectRename(r)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleObjectDelete(r)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ==================== DZIAŁY ==================== */}
        {/* Słownik działów firmy — druga (obok obiektów) możliwość przypisania
            wiersza godzin. Cała tabela siedzi w DepartmentsTab: ten plik ma
            już swoje 1900 linii. */}
        <TabsContent value="dzialy" className="space-y-4">
          <DepartmentsTab
            departments={departments}
            editable={editable}
            loading={loading}
            // Miesiąc odświeżamy razem ze słownikiem: zmiana nazwy działu
            // zmienia etykiety już wpisanych wierszy godzin, a usunięcie
            // działu z `force` zdejmuje im przypisanie.
            onChanged={async () => {
              await Promise.all([loadDictionaries(), loadMonth()]);
            }}
          />
        </TabsContent>

        {/* ==================== NORMY ==================== */}
        <TabsContent value="normy" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">{monthNav}</div>
          <Card>
            <CardContent className="p-0">
              <table className="w-full max-w-2xl text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th tip={`Miesiąc roku ${year}`}>Miesiąc</Th>
                    <Th
                      tip="Norma godzin dla umów o pracę — limit 'maks godziny', gdy pracownik nie ma indywidualnych GODZIN MAKS"
                      className="text-right"
                    >
                      Norma — Praca
                    </Th>
                    <Th
                      tip="Norma godzin dla zleceń — limit 'maks godziny' wierszy zleceniowych (w arkuszu stałe 158)"
                      className="text-right"
                    >
                      Norma — Zlecenie
                    </Th>
                    <Th className="w-24" />
                  </tr>
                </thead>
                <tbody>
                  {MONTH_NAMES.map((name, idx) => {
                    const m = idx + 1;
                    const row = norms.find((n) => n.month === m);
                    const draft = normDraft[m];
                    return (
                      <tr key={m} className="border-b">
                        <td className="px-3 py-2 font-medium">{name}</td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            className="ml-auto h-8 w-24 text-right"
                            inputMode="decimal"
                            readOnly={!editable}
                            value={draft?.workNorm ?? String(row?.workNorm ?? "")}
                            onChange={(e) =>
                              setNormDraft((p) => ({
                                ...p,
                                [m]: {
                                  workNorm: e.target.value,
                                  contractNorm:
                                    p[m]?.contractNorm ??
                                    String(row?.contractNorm ?? ""),
                                },
                              }))
                            }
                            placeholder="160"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            className="ml-auto h-8 w-24 text-right"
                            inputMode="decimal"
                            readOnly={!editable}
                            value={
                              draft?.contractNorm ??
                              String(row?.contractNorm ?? "")
                            }
                            onChange={(e) =>
                              setNormDraft((p) => ({
                                ...p,
                                [m]: {
                                  workNorm:
                                    p[m]?.workNorm ??
                                    String(row?.workNorm ?? ""),
                                  contractNorm: e.target.value,
                                },
                              }))
                            }
                            placeholder="158"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {editable && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleNormSave(m)}
                              disabled={!draft && !row}
                            >
                              Zapisz
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            Brak zapisanej normy = domyślnie 160 h (praca) / 158 h (zlecenie).
          </p>
        </TabsContent>
      </Tabs>

      {/* ==================== DIALOGI ==================== */}
      {payrollEdit && (
        <HrPayrollForm
          key={payrollEdit.contractId}
          open
          onClose={() => setPayrollEdit(null)}
          onSubmit={handlePayrollSave}
          row={payrollEdit}
          year={year}
          month={month}
        />
      )}
      {hoursFormOpen && (
        <HrHoursForm
          key={hoursEdit?.id ?? "new"}
          open
          onClose={() => setHoursFormOpen(false)}
          onSubmit={handleHoursSubmit}
          entry={hoursEdit}
          employees={hoursEdit ? employees : activeEmployees}
          objects={objects.filter((o) => o.active || o.id === hoursEdit?.objectId)}
          departments={departments.filter(
            (d) => d.active || d.id === hoursEdit?.departmentId,
          )}
          year={year}
          month={month}
        />
      )}
      {employeeFormOpen && (
        <HrEmployeeForm
          key={employeeEdit?.id ?? "new"}
          open
          onClose={() => setEmployeeFormOpen(false)}
          onSubmit={handleEmployeeSubmit}
          employee={employeeEdit}
          departments={departments}
        />
      )}
      {contractFormOpen && (
        <HrContractForm
          key={contractEdit?.id ?? `new-${formEmployeeId ?? ""}`}
          open
          onClose={() => setContractFormOpen(false)}
          onSubmit={handleContractSubmit}
          contract={contractEdit}
          employees={contractEdit ? employees : activeEmployees}
          companies={companies}
          defaultEmployeeId={formEmployeeId}
        />
      )}
      {officeFormOpen && (
        <HrOfficeForm
          key={officeEdit?.id ?? "new"}
          open
          onClose={() => setOfficeFormOpen(false)}
          onSubmit={handleOfficeSubmit}
          row={officeEdit}
          employees={
            officeEdit
              ? employees
              : activeEmployees.filter((e) => e.kind === "biuro")
          }
          companies={companies}
          year={year}
          month={month}
        />
      )}
    </div>
  );
}
