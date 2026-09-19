// Moduł Kadry — odwzorowanie skoroszytu "MASTER": godziny → zestawienie dla
// księgowości → kwoty od księgowości → wynagrodzenia (przelew/gotówka).
// Każdy nagłówek kolumny ma tooltip (hover) z opisem, z czego się kalkuluje.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
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
import { PayrollTab, type PayrollGapMode } from "@/components/kadry/PayrollTab";
import { ObjectsTab } from "@/components/kadry/ObjectsTab";
import { NormsTab } from "@/components/kadry/NormsTab";
import { HistoryTab } from "@/components/kadry/HistoryTab";
import { EmployeeHistory } from "@/components/kadry/EmployeeHistory";
import { EntityHistory } from "@/components/kadry/EntityHistory";
import { MonthNav } from "@/components/kadry/MonthNav";
import { KadryHelp, type KadryHelpTab } from "@/components/kadry/KadryHelp";
import { MonthStatusBar } from "@/components/kadry/MonthStatusBar";
import { useConfirm } from "@/components/kadry/useConfirm";
// Kadry „na żywo” (SSE) + rezerwacja list do edycji: sygnał o cudzej zmianie
// przeładowuje miesiąc w tle, a `useEditLock` pilnuje, kto ma prawo pisać.
import { hrChangeHitsMonth, useHrLive } from "@/lib/hrLive";
import { useEditLock } from "@/components/kadry/useEditLock";
import { cmpNum, cmpText, hrs, money } from "@/components/kadry/shared";
import { monthYearLabel } from "@/lib/plDates";
import { KpiDelta } from "@/components/kadry/monthCompare";
import { MoreFiltersButton, SortTh, Th, type SortDir } from "@/components/kadry/parts";
import {
  EmptyRow,
  IconButton,
  KadryBadge,
  KpiTile,
  NUM_CELL_CLS,
  RowActions,
  SectionHeading,
  SegmentedControl,
  departmentTone,
  TEXT_TONE,
  TFOOT_ROW_CLS,
  THEAD_CLS,
} from "@/components/kadry/ui";
import { tip } from "@/components/ui/tooltip";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { cn } from "@/lib/utils";
import {
  Plus,
  ChevronDown,
  ChevronRight,
  CalendarPlus,
  Pencil,
  Trash2,
  FileText,
  Search,
  Users,
  X,
} from "lucide-react";
// Okres obowiązywania umowy (migracja 0112): formatowanie kolumny „Obowiązuje”
// i tony pigułki statusu — wspólne z formularzem umowy.
import {
  CONTRACT_STATUS_HINT,
  CONTRACT_STATUS_TONE,
  CONTRACT_SUPERSEDABLE,
  contractPeriodLabel,
} from "@/components/kadry/contract-period";
import {
  getCompanies,
  // Komplet miesiąca jednym żądaniem — patrz `loadMonth` (backend liczy
  // wypłaty RAZ, zamiast trzech przebiegów na kafle i poprzedni miesiąc).
  getHrMonth,
  type HrMonthStatus,
  saveHrPayroll,
  createHrHours,
  updateHrHours,
  deleteHrHours,
  carryOverHrHours,
  getHrEmployees,
  createHrEmployee,
  updateHrEmployee,
  deleteHrEmployee,
  getHrObjects,
  getHrObjectCatalog,
  getHrDepartments,
  getHrContracts,
  getHrExpiringContracts,
  createHrContract,
  updateHrContract,
  supersedeHrContract,
  deleteHrContract,
  getHrNorms,
  createHrOffice,
  updateHrOffice,
  deleteHrOffice,
  type HrSummary,
  type HrPrevSummary,
  type HrPrevPayrollRow,
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
  type HrExpiringContract,
  type HrMonthNorm,
  type HrOfficeRow,
  type HrOfficeInput,
  type Company,
} from "@/lib/api";

const BONUS_SHORT: Record<string, string> = {
  brak: "—",
  gotowka: "Gotówka",
  delegacja_przelew: "Deleg. przelew",
  delegacja_gotowka: "Deleg. gotówka",
};

/**
 * Filtr „Umowy” w kartotece. Dwie ostatnie wartości to przypomnienia o okresie
 * obowiązywania (migracja 0112) — lista bierze się z `GET /hr/contracts/expiring`,
 * a nie z liczenia dat w przeglądarce: „dziś” liczy serwer.
 */
/**
 * Okno przypomnień o końcu umowy. 30 dni to okres wypowiedzenia liczony
 * w miesiącach — tyle trzeba, żeby zdążyć przygotować aneks albo nową umowę.
 */
const EXPIRING_DAYS = 30;

const EMPLOYEE_CONTRACT_FILTERS = [
  "all",
  "none",
  "with",
  "konczace",
  "zakonczone",
] as const;
type EmployeeContractsFilter = (typeof EMPLOYEE_CONTRACT_FILTERS)[number];

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

/** Filtr aktywności kartoteki pracowników. */
type ActiveFilter = "all" | "active" | "inactive";

/**
 * Kolejność zakładek idzie od danych STAŁYCH do ROBOTY MIESIĄCA: normy i
 * słowniki ustawia się raz, godziny i wynagrodzenia wypełnia co miesiąc —
 * więc to one stoją na końcu, najbliżej miejsca, w którym kadrowa spędza czas.
 * Domyślne przekierowanie `/kadry` zostaje na wynagrodzeniach.
 */
const KADRY_TABS = [
  "normy",
  "dzialy",
  "obiekty",
  "pracownicy",
  "godziny",
  "wynagrodzenia",
  // Dziennik zmian modułu — ostatnia zakładka, bo to widok wsteczny.
  "historia",
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
  const navigate = useNavigate();
  /**
   * Miesiąc siedzi w adresie (`?m=2026-09`). Przedtem żył tylko w stanie
   * komponentu: odświeżenie strony wracało do bieżącego miesiąca, a link
   * wysłany księgowej („zobacz sierpień”) otwierał u niej wrzesień.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const now = new Date();
  const monthParam = searchParams.get("m") ?? "";
  const parsed = /^(\d{4})-(\d{1,2})$/.exec(monthParam);
  const year =
    parsed && Number(parsed[2]) >= 1 && Number(parsed[2]) <= 12
      ? Number(parsed[1])
      : now.getFullYear();
  const month =
    parsed && Number(parsed[2]) >= 1 && Number(parsed[2]) <= 12
      ? Number(parsed[2])
      : now.getMonth() + 1;

  const setYearMonth = useCallback(
    (y: number, m: number) => {
      const next = new URLSearchParams(searchParams);
      next.set("m", `${y}-${String(m).padStart(2, "0")}`);
      // `replace`: przewijanie miesięcy nie ma zapychać historii przeglądarki
      // (dziesięć kliknięć strzałką = dziesięć wciśnięć „wstecz”).
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const [summary, setSummary] = useState<HrSummary | null>(null);
  /** Stan miesiąca (otwarty/zamknięty) — pasek nad tabelą i blokada edycji. */
  const [monthStatus, setMonthStatus] = useState<HrMonthStatus | null>(null);
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
  /**
   * Umowy do przedłużenia (`GET /hr/contracts/expiring`): kończące się w ciągu
   * 30 dni i już zakończone bez następczyni. Liczy je serwer — inaczej „za ile
   * dni” zależałoby od zegara i strefy przeglądarki.
   */
  const [expiring, setExpiring] = useState<HrExpiringContract[]>([]);
  /** Słownik spółek — źródło listy wyboru w umowie i podpowiedzi w biurze. */
  const [companies, setCompanies] = useState<Company[]>([]);
  const [norms, setNorms] = useState<HrMonthNorm[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * Kwoty główne z POPRZEDNIEGO miesiąca (umowa → kwota). Wpisywanie 147 liczb
   * z kartki to idealne warunki na literówkę o rząd wielkości; wartość obok
   * pola daje punkt odniesienia bez przełączania miesiąca.
   */
  const [prevAmounts, setPrevAmounts] = useState<Map<number, number>>(new Map());
  /**
   * Poprzedni miesiąc do porównania: sumy pod kaflami i wypłaty per umowa dla
   * sekcji „Największe zmiany". Zawsze miesiąc BEZPOŚREDNIO poprzedni — pusty
   * lipiec zostaje pusty, zamiast po cichu ustąpić miejsca czerwcowi.
   */
  const [prevSummary, setPrevSummary] = useState<HrPrevSummary | null>(null);
  const [prevPayroll, setPrevPayroll] = useState<HrPrevPayrollRow[]>([]);

  const [hoursFormOpen, setHoursFormOpen] = useState(false);
  const [hoursEdit, setHoursEdit] = useState<HrHoursEntry | null>(null);
  const [employeeFormOpen, setEmployeeFormOpen] = useState(false);
  const [employeeEdit, setEmployeeEdit] = useState<HrEmployee | null>(null);
  const [contractFormOpen, setContractFormOpen] = useState(false);
  const [contractEdit, setContractEdit] = useState<HrContract | null>(null);
  /**
   * Umowa, którą nowa ma ZASTĄPIĆ („Nowa umowa od…”). Zapis idzie wtedy przez
   * `POST /hr/contracts/:id/supersede`: bieżąca dostaje datę zakończenia dzień
   * przed startem nowej, w jednej transakcji.
   */
  const [supersedeContract, setSupersedeContract] = useState<HrContract | null>(
    null,
  );
  const [officeFormOpen, setOfficeFormOpen] = useState(false);
  const [officeEdit, setOfficeEdit] = useState<HrOfficeRow | null>(null);

  /**
   * Wiersz otwarty w dialogu wypłaty razem z listą, po której chodzą przyciski
   * „Poprzedni / Następny” — lista pochodzi z tabeli (po filtrach i sortowaniu),
   * więc nawigacja idzie dokładnie tak, jak widać na ekranie.
   */
  const [payrollDialog, setPayrollDialog] = useState<{
    list: HrPayrollRow[];
    index: number;
  } | null>(null);
  /** Żądanie z kafla „Braki” — PayrollTab ustawia sobie filtr po zmianie nonce. */
  const [gapsRequest, setGapsRequest] = useState<{
    mode: PayrollGapMode;
    nonce: number;
  } | null>(null);
  /** Filtry kartoteki schowane pod „Filtry (n)". */
  const [showEmployeeFilters, setShowEmployeeFilters] = useState(false);

  /**
   * Szukajka kartoteki. Stan początkowy z `?q=` — dziennik zmian („Historia”)
   * linkuje nazwiskiem do `/kadry/pracownicy?q=Nazwisko Imię`, żeby kliknięcie
   * wpisu prowadziło prosto do tej osoby, a nie do listy wszystkich.
   */
  const [employeeFilter, setEmployeeFilter] = useState(
    () => searchParams.get("q") ?? "",
  );
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
   * Filtr umów w kartotece: `none` = osoby bez ani jednej umowy (to one nie
   * pojawią się w wynagrodzeniach), `with` = tylko z umowami, `konczace` /
   * `zakonczone` = lista z przypomnień o okresie obowiązywania (migracja 0112).
   *
   * Stan początkowy z adresu (`?umowy=konczace`), bo kafel „Umowy do
   * przedłużenia” prowadzi tu linkiem — po odświeżeniu strony filtr ma zostać.
   */
  const [employeeContracts, setEmployeeContracts] = useState<EmployeeContractsFilter>(
    () => {
      const raw = searchParams.get("umowy") ?? "all";
      return (
        EMPLOYEE_CONTRACT_FILTERS as readonly string[]
      ).includes(raw)
        ? (raw as EmployeeContractsFilter)
        : "all";
    },
  );
  const [employeeSort, setEmployeeSort] = useState<EmployeeSortKey>("fullName");
  const [employeeDir, setEmployeeDir] = useState<SortDir>("asc");

  /** Rozwinięci pracownicy w kartotece (umowy pod wierszem). */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** Pracownik podstawiany w nowej umowie / nowym wpisie biura. */
  const [formEmployeeId, setFormEmployeeId] = useState<number | undefined>();
  /** Wspólne okno potwierdzenia modułu (zamiast `window.confirm`). */
  const confirm = useConfirm();

  /**
   * REZERWACJE TRZECH LIST MIESIĄCA (wypłaty, godziny, biuro).
   *
   * Stoją TUTAJ, a nie w zakładkach, bo dialogi wiersza (godziny, biuro,
   * wypłata) i automatyczne przeniesienie z poprzedniego miesiąca też zapisują
   * — a backend od migracji 0109 żąda rezerwacji przy KAŻDYM zapisie danych
   * miesięcznych. Zakładki dostają je propsem: tam są przełącznikiem trybu
   * i paskiem „kto edytuje”, tutaj — warunkiem zapisu z okna dialogowego
   * (`ensure()` bierze listę na czas zapisu i oddaje ją po chwili).
   *
   * Prawo edycji liczymy z KLUCZA ZAKŁADKI, nie z `editable` (to ostatnie
   * dotyczy zakładki akurat otwartej): wpis biura zapisuje się z Wynagrodzeń,
   * a wpis godzin z dialogu otwartego nad Godzinami.
   */
  const payrollEditable = canEdit("kadry/wynagrodzenia");
  const payrollLock = useEditLock({ scope: "payroll", year, month, enabled: payrollEditable });
  const officeLock = useEditLock({ scope: "office", year, month, enabled: payrollEditable });
  const hoursLock = useEditLock({ scope: "hours", year, month, enabled: hoursEditable });
  /**
   * Świeży uchwyt rezerwacji godzin dla `loadMonth`. Przez ref, a nie wprost:
   * `loadMonth` jest `useCallback`, a wciągnięcie w jego zależności stanu,
   * który zmienia się przy każdym heartbeacie, przeładowywałoby miesiąc
   * w kółko (efekt niżej woła `loadMonth` po każdej zmianie tożsamości).
   */
  const hoursLockRef = useRef(hoursLock);
  useEffect(() => {
    hoursLockRef.current = hoursLock;
  });

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

  /**
   * Ciche przeliczenie miesiąca po serii zapisów inline: wiersz podmienia się
   * od razu (odpowiedź PUT-a), ale kafle i sumy liczy backend — raz na serię,
   * nie po każdej wpisanej liczbie.
   */
  const scheduleSilentReload = () => {
    if (hoursRefreshRef.current) window.clearTimeout(hoursRefreshRef.current);
    hoursRefreshRef.current = window.setTimeout(() => {
      void loadMonth({ silent: true });
    }, 1500);
  };

  // `silent` — odświeżenie w tle po zapisie inline: dane mają się przeliczyć
  // (godziny karmią wynagrodzenia i kafle), ale tabela nie ma migotać
  // komunikatem „Ładowanie…" pod palcami wpisującego.
  const loadMonth = useCallback(async (opts?: { silent?: boolean }) => {
    const key = `${year}-${month}`;
    monthKeyRef.current = key;
    if (!opts?.silent) setLoading(true);
    try {
      // JEDNO żądanie na komplet miesiąca (kafle + wypłaty + godziny + biuro +
      // stan + kwoty z poprzedniego miesiąca). Wcześniej sześć równoległych
      // żądań, z czego TRZY uruchamiały pełną kalkulację płac na 147 umowach —
      // także przy cichym odświeżeniu po każdej serii zapisów inline.
      const fetchAll = () => getHrMonth(year, month);
      let bundle = (await fetchAll()).data ?? null;
      // Auto-przeniesienie aktywnych pracowników z poprzedniego miesiąca:
      // tylko gdy miesiąc pusty, użytkownik ma edycję godzin, miesiąc nie jest
      // dalej niż 1 w przód (przewijanie w przyszłość nie tworzy kaskady
      // pustych miesięcy) i nie próbowano jeszcze w tej sesji.
      const nowIdx =
        new Date().getFullYear() * 12 + new Date().getMonth() + 1;
      if (
        (bundle?.hours ?? []).length === 0 &&
        hoursEditable &&
        // W zamkniętym miesiącu backend i tak odmówi (423) — nie ma po co
        // wołać przeniesienia i czekać na błąd przy każdym wejściu.
        bundle?.monthStatus.status !== "closed" &&
        year * 12 + month - nowIdx <= 1 &&
        !carryTriedRef.current.has(key)
      ) {
        try {
          // Przeniesienie to ZAPIS, więc wymaga rezerwacji listy godzin —
          // `ensure` bierze ją po cichu i oddaje po chwili. Gdy listę trzyma
          // ktoś inny (właśnie wypełnia ten miesiąc), przeniesienia po prostu
          // nie robimy: i tak zrobi je on, a dwie serie stubów naraz to ostatnie,
          // czego ten ekran potrzebuje.
          //
          // „Próbowano w tej sesji” zapisujemy DOPIERO po faktycznej próbie:
          // odmowa rezerwacji nie jest odpowiedzią „nie ma czego przenosić”,
          // a oznaczona z góry blokowałaby ponowienie do końca sesji — także
          // wtedy, gdy tamta osoba zwolni listę pięć sekund później.
          if (await hoursLockRef.current.ensure(true)) {
            carryTriedRef.current.add(key);
            const res = await carryOverHrHours(year, month);
            if ((res.data?.inserted ?? 0) > 0) {
              bundle = (await fetchAll()).data ?? bundle;
            }
          }
        } catch {
          // Błąd carry-over (np. sieć) nie blokuje widoku pustego miesiąca;
          // próba jest już odnotowana, więc nie powtarza się w kółko.
          carryTriedRef.current.add(key);
        }
      }
      if (monthKeyRef.current !== key) return; // zmieniono miesiąc w trakcie
      setSummary(bundle?.summary ?? null);
      setMonthStatus(bundle?.monthStatus ?? null);
      setPayroll(bundle?.payroll ?? []);
      setHours(bundle?.hours ?? []);
      setOffice(bundle?.office ?? []);
      setPrevAmounts(
        new Map((bundle?.prevAmounts ?? []).map((r) => [r.contractId, r.mainAmount])),
      );
      setPrevSummary(bundle?.prevSummary ?? null);
      setPrevPayroll(bundle?.prevPayroll ?? []);
    } finally {
      if (monthKeyRef.current === key && !opts?.silent) setLoading(false);
    }
  }, [year, month, hoursEditable]);

  const loadDictionaries = useCallback(async () => {
    const [e, o, c, comp, cat, dep, exp] = await Promise.all([
      getHrEmployees(),
      getHrObjects(),
      getHrContracts(),
      getCompanies(),
      getHrObjectCatalog(),
      getHrDepartments(),
      // Ta sama lista zasila kafel „Umowy do przedłużenia” i filtr kartoteki,
      // więc jedzie razem ze słownikami — jedno odświeżenie po każdym zapisie.
      getHrExpiringContracts(EXPIRING_DAYS),
    ]);
    setEmployees(e.data ?? []);
    setObjects(o.data ?? []);
    setContracts(c.data ?? []);
    setCompanies(comp.data ?? []);
    setObjectCatalog(cat.data ?? []);
    setDepartments(dep.data ?? []);
    setExpiring(exp.data ?? []);
  }, []);

  const loadNorms = useCallback(async () => {
    const n = await getHrNorms(year);
    setNorms(n.data ?? []);
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

  /**
   * NA ŻYWO. Sygnał z `/api/hr/live` mówi tylko „coś się zmieniło” — dane
   * dociągamy zwykłymi zapytaniami, więc uprawnień pilnuje backend jak dotąd.
   * Odświeżenie jest CICHE (`silent`): tabela nie ma migotać „Ładowanie…” pod
   * palcami osoby, która akurat wpisuje kwoty, a brudnopisy komórek żyją
   * w stanie zakładek i cudzy zapis ich nie dotyka.
   *
   * Własnych zapisów tu nie ma — pomija je serwer po identyfikatorze karty
   * (`?client=`), a karta i tak odświeża się po odpowiedzi API.
   */
  const liveRefreshRef = useRef<number | null>(null);
  useHrLive((change) => {
    if (change.scope === "locks") return; // stan rezerwacji ogarnia `useEditLock`
    if (!hrChangeHitsMonth(change, year, month)) return;
    if (liveRefreshRef.current) window.clearTimeout(liveRefreshRef.current);
    // Jedna operacja w Kadrach potrafi wypuścić kilka sygnałów w ułamku sekundy
    // (wklejka kwot, przeniesienie z poprzedniego miesiąca) — stąd zebranie ich
    // w jedno przeładowanie.
    liveRefreshRef.current = window.setTimeout(() => {
      liveRefreshRef.current = null;
      void loadMonth({ silent: true });
      if (change.scope === "dictionary" || change.resync) void loadDictionaries();
      if (change.scope === "norms" || change.resync) void loadNorms();
    }, 300);
  });
  useEffect(
    () => () => {
      if (liveRefreshRef.current) window.clearTimeout(liveRefreshRef.current);
    },
    [],
  );

  const activeEmployees = useMemo(
    () => employees.filter((e) => e.active),
    [employees],
  );

  /**
   * Pracownik → PORTAL jego działu (`hr_departments.portal`). Po tym tabela
   * wypłat i biura poznaje, że wiersz należy do sekcji, którą rezerwuje ktoś
   * inny — takie wiersze są wyszarzone i nie dają się zapisać (backend i tak
   * odrzuci je 423). Wpisy godzin mają własny dział, więc pytają o portal
   * wprost słownika działów.
   */
  const portalOfEmployee = useCallback(
    (employeeId: number | null | undefined): string | null => {
      if (employeeId == null) return null;
      const e = employees.find((x) => x.id === employeeId);
      if (e?.departmentId == null) return null;
      return departments.find((d) => d.id === e.departmentId)?.portal ?? null;
    },
    [employees, departments],
  );


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

  /** Umowy do przedłużenia w rozbiciu na osoby — filtr kartoteki i znacznik w wierszu umowy. */
  const expiringByEmployee = useMemo(() => {
    const m = new Map<number, HrExpiringContract[]>();
    for (const c of expiring) {
      const list = m.get(c.employeeId);
      if (list) list.push(c);
      else m.set(c.employeeId, [c]);
    }
    return m;
  }, [expiring]);

  /** Szybkie „czy ta umowa jest na liście do przedłużenia” (ikona w wierszu). */
  const expiringById = useMemo(
    () => new Map(expiring.map((c) => [c.id, c])),
    [expiring],
  );

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
      // Przypomnienia o okresie: pokazujemy OSOBY, których dotyczy wpis z listy
      // `expiring` — kartoteka jest listą ludzi, a umowę widać po rozwinięciu.
      if (
        (employeeContracts === "konczace" ||
          employeeContracts === "zakonczone") &&
        !expiringByEmployee
          .get(e.id)
          ?.some((x) =>
            employeeContracts === "konczace"
              ? x.reason === "konczaca"
              : x.reason === "zakonczona",
          )
      )
        return false;
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
    expiringByEmployee,
  ]);

  /** Ile ze SCHOWANYCH filtrów kartoteki jest aktywnych (licznik na przycisku). */
  const hiddenEmployeeFilters = [
    employeeDept !== "all",
    employeeCompany !== "all",
    employeeContracts !== "all",
  ].filter(Boolean).length;

  const employeeFiltersActive =
    employeeFilter !== "" ||
    employeeKind !== "all" ||
    employeeDept !== "all" ||
    // Domyślnie kartoteka pokazuje aktywnych, więc „aktywni” nie liczy się jako
    // filtr — inaczej przycisk „Wyczyść filtry” stałby na ekranie na stałe.
    employeeActive !== "active" ||
    employeeCompany !== "all" ||
    employeeContracts !== "all";

  /** Ile umów czeka na przedłużenie — podpis kafla i liczniki w selekcie. */
  const expiringCounts = useMemo(
    () => ({
      konczace: expiring.filter((c) => c.reason === "konczaca").length,
      zakonczone: expiring.filter((c) => c.reason === "zakonczona").length,
      razem: expiring.length,
    }),
    [expiring],
  );

  /**
   * Filtr umów zostaje w adresie (`?umowy=konczace`) — kafel „Umowy do
   * przedłużenia” linkuje tu z Wynagrodzeń, a listę trzeba dać się wysłać
   * dalej („zobacz, komu kończą się umowy”).
   */
  const changeEmployeeContracts = useCallback(
    (v: EmployeeContractsFilter) => {
      setEmployeeContracts(v);
      const next = new URLSearchParams(searchParams);
      if (v === "all") next.delete("umowy");
      else next.set("umowy", v);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const clearEmployeeFilters = () => {
    setEmployeeFilter("");
    setEmployeeKind("all");
    setEmployeeDept("all");
    setEmployeeActive("active");
    setEmployeeCompany("all");
    changeEmployeeContracts("all");
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

  const toggleEmployeeSort = makeToggleSort(
    employeeSort,
    setEmployeeSort,
    setEmployeeDir,
    EMPLOYEE_DIR,
  );

  // --- handlery CRUD (wzorzec: zapis → przeładowanie miesiąca/słowników) ---

  /**
   * Zapis z dialogu wypłaty. PUT oddaje PRZELICZONY wiersz, więc podmieniamy go
   * na miejscu (dialog nawiguje po liście i nie może jej pod sobą przeładować),
   * a kafle podsumowania dociągamy w tle raz na serię zmian.
   */
  const handlePayrollSave = async (data: HrPayrollSaveInput) => {
    if (!editable) return;
    // Zapis z dialogu idzie także z PODGLĄDU, a backend żąda rezerwacji listy
    // przy każdym zapisie — `ensure` bierze ją na czas zapisu (i pokazuje okno
    // „poprosić o zwolnienie?”, jeśli trzyma ją ktoś inny).
    if (!(await payrollLock.ensure())) return;
    const res = await saveHrPayroll(data);
    if (res.data) handlePayrollRowSaved(res.data);
    else await loadMonth({ silent: true });
  };

  /** Wiersz zapisany (inline albo z dialogu) — podmiana + ciche przeliczenie kafli. */
  const handlePayrollRowSaved = (saved: HrPayrollRow) => {
    setPayroll((prev) =>
      prev.map((r) => (r.contractId === saved.contractId ? saved : r)),
    );
    setPayrollDialog((d) =>
      d
        ? {
            ...d,
            list: d.list.map((r) =>
              r.contractId === saved.contractId ? saved : r,
            ),
          }
        : d,
    );
    scheduleSilentReload();
  };

  const handleOfficeRowSaved = (saved: HrOfficeRow) => {
    setOffice((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
    scheduleSilentReload();
  };

  const handleHoursSubmit = async (data: HrHoursInput) => {
    if (!editable) return;
    if (!(await hoursLock.ensure())) return;
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
    scheduleSilentReload();
  };

  const handleHoursDelete = (row: HrHoursEntry) => {
    if (!editable) return;
    confirm.ask({
      title: `Usunąć wpis godzin: ${row.employeeName}?`,
      description:
        "Wpis zniknie z miesiąca, a jego godziny przestaną wchodzić do wynagrodzeń.",
      onConfirm: async () => {
        if (!(await hoursLock.ensure())) return;
        await deleteHrHours(row.id);
        await loadMonth();
      },
    });
  };

  /**
   * Nowy pracownik OCHRONY prowadzi prosto do umowy: bez niej osoba nie pojawi
   * się w wynagrodzeniach, a dotąd trzeba było pamiętać o drugim kroku (lista
   * „ochrona bez umów” regularnie o tym przypominała). Dialog umowy otwiera się
   * z podstawioną osobą; przy edycji i przy biurze nic się nie dzieje.
   */
  const handleEmployeeSubmit = async (data: HrEmployeeInput) => {
    if (!editable) return;
    if (employeeEdit) {
      await updateHrEmployee(employeeEdit.id, data);
      await loadDictionaries();
      return;
    }
    const created = await createHrEmployee(data);
    await loadDictionaries();
    if (created.data && created.data.kind === "ochrona") {
      setContractEdit(null);
      setSupersedeContract(null);
      setFormEmployeeId(created.data.id);
      setContractFormOpen(true);
    }
  };

  const handleEmployeeDelete = (row: HrEmployee) => {
    if (!editable) return;
    confirm.ask({
      title: `Usunąć pracownika ${row.fullName}?`,
      description:
        "Razem z kartoteką znikną jego wpisy godzin, umowy i dane płacowe ze wszystkich miesięcy. Jeśli osoba tylko odeszła z firmy — ustaw ją jako nieaktywną zamiast usuwać.",
      onConfirm: async () => {
        await deleteHrEmployee(row.id);
        await Promise.all([loadDictionaries(), loadMonth()]);
      },
    });
  };

  const handleContractSubmit = async (data: HrContractInput) => {
    if (!editable) return;
    if (supersedeContract) {
      // Data startu jest wymuszona przez formularz (przycisk zapisu bez niej
      // jest wyłączony), więc tu wystarczy ją przekazać dalej.
      await supersedeHrContract(supersedeContract.id, {
        ...data,
        validFrom: data.validFrom as string,
      });
    } else if (contractEdit) await updateHrContract(contractEdit.id, data);
    else await createHrContract(data);
    await Promise.all([loadDictionaries(), loadMonth()]);
  };

  const handleContractDelete = (row: HrContract) => {
    if (!editable) return;
    confirm.ask({
      title: `Usunąć umowę ${row.employeeName} — ${row.company}?`,
      description:
        "Usunie to też dane płacowe tej umowy ze wszystkich miesięcy (kwoty od księgowości, stawki, nadpisania).",
      onConfirm: async () => {
        await deleteHrContract(row.id);
        await Promise.all([loadDictionaries(), loadMonth()]);
      },
    });
  };

  const handleOfficeSubmit = async (data: HrOfficeInput) => {
    if (!editable) return;
    if (!(await officeLock.ensure())) return;
    if (officeEdit) await updateHrOffice(officeEdit.id, data);
    else await createHrOffice(data);
    await loadMonth();
  };

  const handleOfficeDelete = (row: HrOfficeRow) => {
    if (!editable) return;
    confirm.ask({
      title: `Usunąć wpis biura: ${row.employeeName}?`,
      description: "Wpis zniknie z rozliczenia tego miesiąca.",
      onConfirm: async () => {
        if (!(await officeLock.ensure())) return;
        await deleteHrOffice(row.id);
        await loadMonth();
      },
    });
  };

  // --- kafelki podsumowania ---
  // Kafle opisują MIESIĄC, więc stoją tylko tam, gdzie miesiąc coś znaczy:
  // w Wynagrodzeniach i Godzinach. W kartotece, słownikach i normach zabierały
  // 120 px wysokości na liczby, o których te ekrany nie są.
  const monthlyTab = tab === "wynagrodzenia" || tab === "godziny";
  /**
   * Zamknięty miesiąc = tryb tylko do odczytu dla DANYCH MIESIĘCZNYCH. Zamiast
   * osobnej flagi w każdej tabeli zdejmujemy `editable` tam, gdzie rysują się
   * godziny, wypłaty i biuro — to ta sama ścieżka, którą UI wygasza konto bez
   * prawa edycji (chowa dodawanie, kosze i tryb wpisywania). Powód blokady
   * mówi pasek `MonthStatusBar` nad tabelą. Słowniki (Pracownicy, Obiekty,
   * Działy, Normy) zostają edytowalne — nie należą do miesiąca.
   */
  const monthClosed = monthStatus?.status === "closed";

  /** Skok do wynagrodzeń z ustawionym filtrem braków (kafel „Braki"). */
  const goToPayrollGaps = (mode: PayrollGapMode) => {
    setGapsRequest({ mode, nonce: Date.now() });
    if (tab !== "wynagrodzenia")
      navigate({ pathname: "/kadry/wynagrodzenia", search: searchParams.toString() });
  };
  const goToHours = () =>
    navigate({ pathname: "/kadry/godziny", search: searchParams.toString() });

  /**
   * Kafel „Biuro" prowadzi do listy, którą podsumowuje. Podzakładka Wynagrodzeń
   * siedzi w adresie (`?lista=stale`), więc wystarczy dołożyć parametr — nie
   * ma osobnej ścieżki „powiedz PayrollTabowi, żeby przełączył listę".
   */
  const goToOffice = () => {
    const next = new URLSearchParams(searchParams);
    next.set("lista", "stale");
    navigate(
      { pathname: "/kadry/wynagrodzenia", search: next.toString() },
      { replace: true },
    );
  };

  /**
   * Kafel „Umowy do przedłużenia” prowadzi do kartoteki z gotowym filtrem —
   * przypomnienie bez drogi do listy byłoby samym wyrzutem sumienia.
   */
  const goToExpiring = () => {
    setEmployeeContracts("konczace");
    navigate({
      pathname: "/kadry/pracownicy",
      search: new URLSearchParams({ umowy: "konczace" }).toString(),
    });
  };

  /**
   * Różnica pod wartością kafla. Punktem odniesienia jest miesiąc
   * BEZPOŚREDNIO poprzedni — także gdy jest pusty; wtedy zamiast „−100%"
   * (spadku, którego nie było) stoi „brak danych za lipiec".
   */
  const prevMonthLabel = prevSummary
    ? monthYearLabel(prevSummary.year, prevSummary.month)
    : "";
  const tileDelta = (
    value: number,
    prev: number | undefined,
    testId: string,
    /**
     * Czy poprzedni miesiąc ma TO rozliczenie. Osobno dla każdej rodziny
     * kafli: lipiec z godzinami, ale bez kwot, ma z czym porównać godziny
     * i nie ma z czym — przelewów.
     */
    prevHasData: boolean,
    format?: (v: number) => string,
    prevNote?: string,
  ) =>
    prevSummary ? (
      <KpiDelta
        value={value}
        prev={prev}
        prevMonthLabel={prevMonthLabel}
        prevHasData={prevHasData}
        prevNote={prevNote}
        format={format}
        testId={testId}
      />
    ) : null;

  /**
   * Zastrzeżenie do kafli kwotowych: poprzedni miesiąc bez ani jednej kwoty od
   * księgowości ma wypłaty złożone z samych premii i wyrównań. Różnica jest
   * wtedy prawdziwa, ale mówi o stanie tamtego miesiąca, nie o wzroście płac.
   */
  const unsettledNote =
    prevSummary && !prevSummary.payrollSettled
      ? "miesiąc nierozliczony: same premie i wyrównania z godzin, bez kwot od księgowości"
      : undefined;

  const tiles = summary
    ? [
        {
          label: "Godziny (suma)",
          value: hrs(summary.totalHours),
          delta: tileDelta(
            summary.totalHours,
            prevSummary?.totalHours,
            "kadry-tile-godziny-delta",
            prevSummary?.hasHours ?? false,
            (v) => `${hrs(v)} h`,
          ),
          sub: `${summary.employeesWithHours} pracowników, ${summary.hoursEntries} wpisów`,
          tip: "Suma godzin wypracowanych + UW + L4 ze wszystkich wpisów miesiąca — kliknij, aby przejść do Godzin",
          onClick: goToHours,
        },
        {
          label: "Przelewy netto",
          value: money(summary.przelew),
          delta: tileDelta(
            summary.przelew,
            prevSummary?.przelew,
            "kadry-tile-przelewy-delta",
            prevSummary?.hasPayroll ?? false,
            undefined,
            unsettledNote,
          ),
          sub: "wypłaty na konto",
          tip: "Suma części przelewowych wypłat ochrony (kwoty główne + dodatki kanałem przelew). Wszystkie kwoty w Kadrach są NETTO — księgowość podaje tu wyłącznie kwoty do wypłaty, kwot brutto aplikacja nie zna.",
        },
        {
          label: "Gotówka netto",
          value: money(summary.gotowka),
          delta: tileDelta(
            summary.gotowka,
            prevSummary?.gotowka,
            "kadry-tile-gotowka-delta",
            prevSummary?.hasPayroll ?? false,
            undefined,
            unsettledNote,
          ),
          sub: "wypłaty gotówką",
          tip: "Suma części gotówkowych wypłat ochrony NETTO (kwoty główne + dodatki kanałem gotówka)",
        },
        {
          label: "Wypłaty razem netto",
          value: money(summary.wyplaty),
          delta: tileDelta(
            summary.wyplaty,
            prevSummary?.wyplaty,
            "kadry-tile-wyplaty-delta",
            prevSummary?.hasPayroll ?? false,
            undefined,
            unsettledNote,
          ),
          sub: `${summary.contractsCount} umów`,
          tip: "Przelewy + gotówka na rękę (ochrona, bez biura) — kwoty NETTO",
        },
        {
          label: "Braki",
          value: String(summary.gaps),
          // Jedyny kafel BEZ porównania: „braki" to robota do zrobienia w tym
          // miesiącu, a nie wielkość, która rośnie albo maleje — „+3 braki
          // (+150%)" nie znaczy nic poza tym, że miesiąc jest w trakcie.
          delta: null,
          sub: `${summary.missingMain} bez kwoty, ${summary.pendingBonus} do przeliczenia`,
          tip: "Wiersze z godzinami bez kwoty NETTO od księgowości albo z dodatkiem czekającym na stawkę — kliknij, aby zobaczyć właśnie te wiersze",
          accent: summary.gaps > 0 ? TEXT_TONE.warn : undefined,
          onClick: () => goToPayrollGaps("braki"),
        },
        {
          label: "Biuro netto",
          value: money(summary.officeTotal),
          delta: tileDelta(
            summary.officeTotal,
            prevSummary?.officeTotal,
            "kadry-tile-biuro-delta",
            prevSummary?.hasOffice ?? false,
          ),
          sub: `${summary.officeCount} wpisów`,
          tip: "Suma wypłat biura na rękę: podstawy ROR + delegacje/gotówka (kwoty NETTO) — kliknij, aby otworzyć listę „Stałe”",
          onClick: goToOffice,
        },
      ]
    : [];

  if (tab && MERGED_TABS[tab]) {
    return <Navigate to={`/kadry/${MERGED_TABS[tab]}`} replace />;
  }
  if (!tab || !KADRY_TABS.includes(tab as (typeof KADRY_TABS)[number])) {
    return <Navigate to="/kadry/wynagrodzenia" replace />;
  }

  // Wybór miesiąca dotyczy całej zakładki — wstawiamy go w pasek narzędzi
  // każdej podzakładki, zamiast zajmować osobny rząd nad kaflami.
  // Wraz z miesiącem jedzie „?” — legenda ma stać w pasku każdej zakładki,
  // a to jedyny element paska, który wszystkie trzy zakładki miesięczne
  // (wynagrodzenia, godziny, kartoteka) dostają z tego pliku.
  const monthNav = (
    <>
      <MonthNav year={year} month={month} onChange={setYearMonth} />
      <KadryHelp tab={tab as KadryHelpTab} />
    </>
  );

  /** Przypomnienie o umowach — tam, gdzie jest co z nim zrobić, i tylko gdy jest. */
  const showExpiringTile =
    expiringCounts.razem > 0 && (monthlyTab || tab === "pracownicy");

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      {(monthlyTab || showExpiringTile) && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {monthlyTab &&
            tiles.map((t) => (
              <KpiTile
                key={t.label}
                label={t.label}
                value={t.value}
                // Różnica idzie NAD podpis: pod liczbą czyta się ją jako jej
                // ciąg dalszy, pod „147 umów" — jako komentarz do umów.
                sub={
                  <>
                    {t.delta}
                    <div>{t.sub}</div>
                  </>
                }
                hint={t.tip}
                tone={t.accent}
                onClick={t.onClick}
                testId={`kadry-tile-${t.label.split(" ")[0].toLowerCase()}`}
              />
            ))}
          {/* Jedyny kafel, który NIE opisuje miesiąca: termin umowy nie ma nic
              wspólnego z wybranym okresem, a przypomnieć trzeba zanim minie.
              Dlatego stoi i w Wynagrodzeniach, i w kartotece — i tylko wtedy,
              gdy naprawdę jest o czym mówić. */}
          {showExpiringTile && (
            <KpiTile
              label="Umowy do przedłużenia"
              value={String(expiringCounts.razem)}
              sub={
                expiringCounts.zakonczone > 0
                  ? `${expiringCounts.konczace} kończy się, ${expiringCounts.zakonczone} po terminie`
                  : `w ciągu ${EXPIRING_DAYS} dni`
              }
              hint={`Umowy z datą „obowiązuje do” w ciągu ${EXPIRING_DAYS} dni oraz te, którym termin już minął, a nikt nie podpisał następnej w tej samej spółce. Kliknij, aby zobaczyć te osoby w kartotece.`}
              tone={TEXT_TONE.warn}
              active={employeeContracts === "konczace"}
              onClick={goToExpiring}
              testId="kadry-tile-umowy"
            />
          )}
        </div>
      )}

      {/* Stan miesiąca: lista kontrolna i „Zamknij miesiąc", a po zamknięciu —
          baner z podpisem i „Otwórz ponownie". Stoi nad tabelą Wynagrodzeń
          i Godzin, bo dotyczy obu (zamknięty miesiąc blokuje jedno i drugie). */}
      {monthlyTab && (
        <MonthStatusBar
          status={monthStatus}
          year={year}
          month={month}
          canClose={canEdit("kadry/wynagrodzenia")}
          onChanged={() => void loadMonth()}
        />
      )}

      <Tabs value={tab}>
        {/* ==================== WYNAGRODZENIA ==================== */}
        {/* Tabela wypłat, rozliczenie biura i tryb edycji inline siedzą
            w PayrollTab: to ekran WPISYWANIA (147 kwot miesięcznie), więc ma
            własny stan brudnopisów i filtrów, tak jak Godziny. */}
        <TabsContent value="wynagrodzenia" className="space-y-4">
          <PayrollTab
            rows={payroll}
            office={office}
            hours={hours}
            editable={editable && !monthClosed}
            // Rezerwacje: wypłaty i biuro to dwie osobne listy (i dwie osobne
            // blokady), choć mieszkają na jednym ekranie.
            lock={payrollLock}
            officeLock={officeLock}
            portalOfEmployee={portalOfEmployee}
            loading={loading}
            monthNav={monthNav}
            year={year}
            month={month}
            gapsRequest={gapsRequest}
            prevAmounts={prevAmounts}
            // Porównanie z poprzednim miesiącem: sekcja „Największe zmiany".
            prevPayroll={prevPayroll}
            prevSummary={prevSummary}
            // Dane wystawcy na wydrukach — z bazy, nie z literału w szablonie.
            companies={companies}
            // Pasek postępu bierze liczby z listy kontrolnej backendu — tej
            // samej, którą pokazuje pasek stanu miesiąca nad tabelą.
            checklist={summary?.checklist ?? monthStatus?.checklist}
            onRowSaved={handlePayrollRowSaved}
            onOfficeRowSaved={handleOfficeRowSaved}
            onOpenPayrollDialog={(row, list) =>
              setPayrollDialog({
                list,
                index: list.findIndex((r) => r.contractId === row.contractId),
              })
            }
            onOfficeAdd={() => {
              setOfficeEdit(null);
              setOfficeFormOpen(true);
            }}
            onOfficeEdit={(row) => {
              setOfficeEdit(row);
              setOfficeFormOpen(true);
            }}
            onOfficeDelete={handleOfficeDelete}
            onOfficeCarriedOver={() => void loadMonth()}
            onGoToHours={goToHours}
          />
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
            editable={editable && !monthClosed}
            lock={hoursLock}
            loading={loading}
            monthNav={monthNav}
            year={year}
            month={month}
            onRowSaved={handleHoursRowSaved}
            onChanged={() => void loadMonth()}
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
                umowami, biuro = osoby z wpisami biura w tym miesiącu.
                Ten sam klocek, co podzakładki Wynagrodzeń — jeden przełącznik
                segmentowy w module, nie trzy jego kopie o trzech wysokościach. */}
            <SegmentedControl<"all" | "ochrona" | "biuro">
              value={employeeKind}
              onChange={setEmployeeKind}
              ariaLabel="Rodzaj pracowników"
              options={[
                {
                  value: "all",
                  label: "Wszyscy",
                  hint: "Cała kartoteka",
                  testId: "kadry-pracownicy-filter-kind-all",
                },
                {
                  value: "ochrona",
                  label: "Ochrona",
                  hint: "Osoby z umową kadrową — rozliczane w liście „Godzinowe”",
                  testId: "kadry-pracownicy-filter-kind-ochrona",
                },
                {
                  value: "biuro",
                  label: "Biuro",
                  hint: "Osoby z wpisem biura w wybranym miesiącu — lista „Stałe”",
                  testId: "kadry-pracownicy-filter-kind-biuro",
                },
              ]}
            />
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
            <MoreFiltersButton
              open={showEmployeeFilters}
              onToggle={() => setShowEmployeeFilters((v) => !v)}
              count={hiddenEmployeeFilters}
              testId="kadry-pracownicy-filters-more"
            />
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
                    setSupersedeContract(null);
                    setFormEmployeeId(undefined);
                    setContractFormOpen(true);
                  }}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Umowa
                </Button>
                <Button
                  onClick={() => {
                    setEmployeeEdit(null);
                    setEmployeeFormOpen(true);
                  }}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Dodaj pracownika
                </Button>
              </div>
            )}
          </div>
          {showEmployeeFilters && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2"
              data-testid="kadry-pracownicy-filters-row2"
            >
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
                  {...tip("Filtr po dziale z kartoteki pracownika")}
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
              <Select value={employeeCompany} onValueChange={setEmployeeCompany}>
                <SelectTrigger
                  className="w-[190px]"
                  {...tip("Spółka z umowy albo z rozliczenia biura")}
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
                  changeEmployeeContracts(v as EmployeeContractsFilter)
                }
              >
                <SelectTrigger
                  className="w-[260px]"
                  {...tip(
                    "Bez umowy = osoba, która nie pojawi się w wynagrodzeniach. Dwie ostatnie pozycje to przypomnienia o okresie obowiązywania — kończące się i te po terminie, którym nikt nie podpisał następnej.",
                  )}
                  data-testid="kadry-pracownicy-filter-contracts"
                >
                  <SelectValue placeholder="Umowy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Umowy: wszyscy</SelectItem>
                  <SelectItem value="none">Tylko bez umowy</SelectItem>
                  <SelectItem value="with">Tylko z umową</SelectItem>
                  <SelectItem value="konczace">
                    Kończące się w {EXPIRING_DAYS} dni
                    {expiringCounts.konczace > 0
                      ? ` (${expiringCounts.konczace})`
                      : ""}
                  </SelectItem>
                  <SelectItem value="zakonczone">
                    Zakończone bez następczyni
                    {expiringCounts.zakonczone > 0
                      ? ` (${expiringCounts.zakonczone})`
                      : ""}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
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
                    <EmptyRow
                      colSpan={11}
                      loading={loading}
                      icon={Users}
                      title={
                        employeeFiltersActive
                          ? "Brak pracowników dla wybranych filtrów"
                          : "Kartoteka jest pusta"
                      }
                      description={
                        employeeFiltersActive
                          ? "Zdejmij filtry albo zmień szukajkę — nieaktywni też są na liście."
                          : "Pracownicy trafiają tu ręcznie; dopiero po dodaniu umowy pojawią się w Wynagrodzeniach."
                      }
                      action={
                        employeeFiltersActive ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={clearEmployeeFilters}
                          >
                            <X className="mr-1 h-4 w-4" /> Wyczyść filtry
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    employeesVisible.map((r) => {
                      const rowContracts = contractsByEmployee.get(r.id) ?? [];
                      const isOpen = expanded.has(r.id);
                      return (
                        <Fragment key={r.id}>
                          <tr
                            className={cn(
                              // `group` — akcje po prawej wyłażą pod kursorem.
                              "group cursor-pointer border-b hover:bg-accent/50",
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
                                  <KadryBadge
                                    tone="biuro"
                                    hint="Pracownik biura — rozliczany w zakładce Wynagrodzenia, sekcja Biuro"
                                  >
                                    Biuro
                                  </KadryBadge>
                                ) : (
                                  <KadryBadge
                                    tone="ochrona"
                                    hint="Ochrona — rozliczana z umów kadrowych"
                                  >
                                    Ochrona
                                  </KadryBadge>
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
                                // „Brak umów" to lista do naprawienia, więc jest
                                // od razu drogą do naprawy: klik otwiera pustą
                                // umowę tej osoby, zamiast zostawiać ostrzeżenie,
                                // z którym trzeba iść gdzie indziej.
                                editable ? (
                                  <button
                                    type="button"
                                    className={cn(
                                      "rounded px-1 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                      TEXT_TONE.warn,
                                    )}
                                    data-testid="kadry-pracownicy-add-contract"
                                    {...tip(
                                      `${r.fullName} nie ma żadnej umowy, więc nie pojawi się w Wynagrodzeniach. Kliknij, aby dodać pierwszą.`,
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setContractEdit(null);
                                      setSupersedeContract(null);
                                      setFormEmployeeId(r.id);
                                      setContractFormOpen(true);
                                    }}
                                  >
                                    brak umów
                                  </button>
                                ) : (
                                  <span className={cn("text-xs", TEXT_TONE.warn)}>
                                    brak umów
                                  </span>
                                )
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {r.departmentName ? (
                                <KadryBadge
                                  tone={departmentTone(
                                    departments.find(
                                      (d) => d.id === r.departmentId,
                                    ),
                                  )}
                                >
                                  {r.departmentName}
                                </KadryBadge>
                              ) : (
                                "—"
                              )}
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
                              <KadryBadge
                                tone={r.active ? "aktywny" : "nieaktywny"}
                              >
                                {r.active ? "aktywny" : "nieaktywny"}
                              </KadryBadge>
                            </td>
                            <td className="max-w-[240px] truncate px-3 py-2 text-xs text-muted-foreground">
                              {r.notes}
                            </td>
                            <td
                              className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground"
                              {...(r.updatedAt ? tip(r.updatedAt) : {})}
                            >
                              {r.updatedAt ? r.updatedAt.slice(0, 10) : "—"}
                            </td>
                            <td className="px-3 py-2">
                              {editable && (
                                <RowActions>
                                  <IconButton
                                    icon={Pencil}
                                    label="Edytuj pracownika"
                                    onClick={() => {
                                      setEmployeeEdit(r);
                                      setEmployeeFormOpen(true);
                                    }}
                                  />
                                  <IconButton
                                    icon={Trash2}
                                    danger
                                    label="Usuń pracownika"
                                    onClick={() => handleEmployeeDelete(r)}
                                  />
                                </RowActions>
                              )}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="border-b bg-muted/20">
                              <td colSpan={11} className="px-3 py-3">
                                <div className="space-y-4">
                                  {/* --- UMOWY pracownika --- */}
                                  <div className="space-y-2">
                                    <SectionHeading
                                      icon={FileText}
                                      title="Umowy"
                                      summary={
                                        rowContracts.length || undefined
                                      }
                                      action={
                                        editable ? (
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                              setContractEdit(null);
                                              setSupersedeContract(null);
                                              setFormEmployeeId(r.id);
                                              setContractFormOpen(true);
                                            }}
                                          >
                                            <Plus className="mr-1 h-3.5 w-3.5" />
                                            Dodaj umowę
                                          </Button>
                                        ) : undefined
                                      }
                                    />
                                    {rowContracts.length === 0 ? (
                                      <p className="text-xs text-muted-foreground">
                                        Brak umów — bez nich pracownik nie pojawi
                                        się w wynagrodzeniach.
                                      </p>
                                    ) : (
                                      <div className="overflow-x-auto rounded-md border bg-background">
                                        <table className="w-full min-w-[760px] text-sm">
                                          <thead className={THEAD_CLS}>
                                            <tr>
                                              <Th tip="Spółka zatrudniająca — ze słownika Spółki">
                                                Spółka
                                              </Th>
                                              <Th tip="Praca (UoP) / Zlecenie — decyduje o normie i wliczaniu L4">
                                                Umowa
                                              </Th>
                                              <Th tip="Ubezpieczenie chorobowe — informacyjne">
                                                Chorobowe
                                              </Th>
                                              <Th tip="Zgłoszenie ZUA — niepuste włącza rozliczanie godzin do maks">
                                                ZUA
                                              </Th>
                                              <Th tip="Zgłoszenie ZZA — wiersz dostaje nadwyżkę godzin ponad normę umowy głównej">
                                                ZZA
                                              </Th>
                                              <Th
                                                tip="Kanał wypłaty kwoty głównej: przelew / gotówka. To ustawienie umowy, nie kwota — samą kwotę wpisuje się co miesiąc w Wynagrodzeniach."
                                                wrap
                                              >
                                                Kanał wypłaty
                                              </Th>
                                              <Th tip="Rodzaj dodatku — decyduje o godzinach nadwyżki i kanale ich wypłaty">
                                                Dodatek
                                              </Th>
                                              <Th tip="Okres obowiązywania umowy. Miesiąc jest najmniejszą jednostką rozliczenia: umowa od 15.09 liczy się we wrześniu w całości, a zakończona 31.08 nie wchodzi do września. Puste daty = bezterminowo.">
                                                Obowiązuje
                                              </Th>
                                              <Th tip="Status liczony z dat i z ręcznego wyłącznika: przyszła / aktywna / zakończona / nieaktywna. Umowa, która nie obowiązuje, nie pojawia się w wynagrodzeniach (poza miesiącami z zapisanymi danymi)">
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
                                                  "group border-b last:border-0 hover:bg-accent/50",
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
                                                {/* Okres: „bezterminowo” to pełnoprawna
                                                    wartość, nie brak danych — dlatego
                                                    nigdy nie stoi tu myślnik. */}
                                                <td
                                                  className="whitespace-nowrap px-3 py-2 tabular-nums"
                                                  data-testid="kadry-umowa-okres"
                                                >
                                                  {contractPeriodLabel(ct)}
                                                  {expiringById.has(ct.id) && (
                                                    <span
                                                      className={cn(
                                                        "ml-2 text-xs",
                                                        TEXT_TONE.warn,
                                                      )}
                                                      {...tip(
                                                        expiringById.get(ct.id)!
                                                          .reason === "konczaca"
                                                          ? `Kończy się za ${expiringById.get(ct.id)!.daysLeft} dni — nikt nie podpisał następnej w tej spółce`
                                                          : `Termin minął ${-expiringById.get(ct.id)!.daysLeft} dni temu — nikt nie podpisał następnej w tej spółce`,
                                                      )}
                                                    >
                                                      do przedłużenia
                                                    </span>
                                                  )}
                                                </td>
                                                <td className="px-3 py-2">
                                                  <KadryBadge
                                                    tone={
                                                      CONTRACT_STATUS_TONE[
                                                        ct.status
                                                      ] ?? "neutral"
                                                    }
                                                    hint={
                                                      CONTRACT_STATUS_HINT[
                                                        ct.status
                                                      ]
                                                    }
                                                  >
                                                    {ct.status}
                                                  </KadryBadge>
                                                </td>
                                                <td className="px-3 py-2">
                                                  {editable && (
                                                    <RowActions>
                                                      <EntityHistory
                                                        entityType="hr_contract"
                                                        entityId={ct.id}
                                                        title={`${r.fullName} — umowa ${ct.company}`}
                                                      />
                                                      {/* ZMIANA WARUNKÓW: nowe stawki
                                                          od konkretnego dnia to nowa
                                                          umowa, a nie poprawka w tej —
                                                          edycja przeliczyłaby wstecz
                                                          zamknięte miesiące.
                                                          Tylko dla umów, które jeszcze
                                                          coś znaczą (aktywna, także
                                                          bezterminowa, i przyszła):
                                                          zakończonej ani wyłączonej nie
                                                          ma czego zamykać dzień
                                                          wcześniej — tam nowa umowa
                                                          powstaje przyciskiem „Nowa
                                                          umowa" nad listą. */}
                                                      {CONTRACT_SUPERSEDABLE.has(
                                                        ct.status,
                                                      ) && (
                                                      <IconButton
                                                        icon={CalendarPlus}
                                                        label="Nowa umowa od… (zmiana warunków — bieżąca zostanie zamknięta dzień wcześniej)"
                                                        testId="kadry-umowa-supersede"
                                                        onClick={() => {
                                                          setContractEdit(null);
                                                          setSupersedeContract(ct);
                                                          setFormEmployeeId(undefined);
                                                          setContractFormOpen(true);
                                                        }}
                                                      />
                                                      )}
                                                      <IconButton
                                                        icon={Pencil}
                                                        label="Edytuj umowę"
                                                        onClick={() => {
                                                          setContractEdit(ct);
                                                          setSupersedeContract(null);
                                                          setFormEmployeeId(undefined);
                                                          setContractFormOpen(true);
                                                        }}
                                                      />
                                                      <IconButton
                                                        icon={Trash2}
                                                        danger
                                                        label="Usuń umowę"
                                                        onClick={() =>
                                                          handleContractDelete(ct)
                                                        }
                                                      />
                                                    </RowActions>
                                                  )}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>

                                  {/* --- HISTORIA zmian pracownika (leniwa) --- */}
                                  <EmployeeHistory employeeId={r.id} />
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
                    <tr className={TFOOT_ROW_CLS}>
                      <td className="px-3 py-2" colSpan={4}>
                        Razem ({employeesVisible.length}
                        {employeesVisible.length === employees.length
                          ? ""
                          : ` z ${employees.length}`}{" "}
                        pracowników)
                      </td>
                      <td
                        className={cn(
                          NUM_CELL_CLS,
                          "text-xs font-normal text-muted-foreground",
                        )}
                      >
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
        {/* Słownik pozycji kadrowych i mapowanie na kartotekę — w osobnym
            komponencie, bo ma własne filtry i edycję nazwy w wierszu. */}
        <TabsContent value="obiekty" className="space-y-4">
          <ObjectsTab
            objects={objects}
            catalog={objectCatalog}
            editable={editable}
            loading={loading}
            onChanged={loadDictionaries}
          />
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
        {/* Normy chodzą po ROKU, nie po miesiącu — tabela pokazuje cały rok. */}
        <TabsContent value="normy" className="space-y-4">
          <NormsTab
            year={year}
            month={month}
            norms={norms}
            editable={editable}
            onYearChange={(y) => setYearMonth(y, month)}
            onSaved={() => {
              void loadNorms();
              void loadMonth({ silent: true });
            }}
          />
        </TabsContent>

        {/* ==================== HISTORIA (dziennik zmian) ==================== */}
        <TabsContent value="historia" className="space-y-4">
          <HistoryTab />
        </TabsContent>
      </Tabs>

      {/* ==================== DIALOGI ==================== */}
      {payrollDialog && payrollDialog.index >= 0 && (
        <HrPayrollForm
          key={payrollDialog.list[payrollDialog.index].contractId}
          open
          onClose={() => setPayrollDialog(null)}
          onSubmit={handlePayrollSave}
          row={payrollDialog.list[payrollDialog.index]}
          year={year}
          month={month}
          position={{
            index: payrollDialog.index,
            total: payrollDialog.list.length,
          }}
          hasPrev={payrollDialog.index > 0}
          hasNext={payrollDialog.index < payrollDialog.list.length - 1}
          onNavigate={(dir) =>
            setPayrollDialog((d) =>
              d
                ? {
                    ...d,
                    index: Math.min(
                      Math.max(d.index + dir, 0),
                      d.list.length - 1,
                    ),
                  }
                : d,
            )
          }
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
          key={
            contractEdit?.id ??
            (supersedeContract
              ? `supersede-${supersedeContract.id}`
              : `new-${formEmployeeId ?? ""}`)
          }
          open
          onClose={() => {
            setContractFormOpen(false);
            setSupersedeContract(null);
          }}
          onSubmit={handleContractSubmit}
          contract={contractEdit}
          supersede={supersedeContract}
          employees={contractEdit || supersedeContract ? employees : activeEmployees}
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
