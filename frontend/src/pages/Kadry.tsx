// Moduł Kadry — odwzorowanie skoroszytu "MASTER": godziny → zestawienie dla
// księgowości → kwoty od księgowości → wynagrodzenia (przelew/gotówka).
// Każdy nagłówek kolumny ma tooltip (hover) z opisem, z czego się kalkuluje.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Th } from "@/components/kadry/parts";
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

  const [payrollFilter, setPayrollFilter] = useState("");
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
   * Pozycje kadrowe od najcięższych: mapuje się je ręcznie i po kolei, więc
   * na górze mają stać te, na których wisi najwięcej godzin — to one przeniosą
   * do Analityki największy kawałek kosztu osobowego.
   */
  const sortedObjects = useMemo(
    () =>
      [...objects].sort(
        (a, b) =>
          b.hoursTotal - a.hoursTotal || a.name.localeCompare(b.name, "pl"),
      ),
    [objects],
  );

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

  // Rodzaj rozliczenia to cecha pracownika (ochrona / biuro). Szukajka obejmuje
  // też spółki, żeby dało się wyciągnąć „ludzi z GUARD 21".
  const employeesVisible = useMemo(() => {
    const q = employeeFilter.trim().toLowerCase();
    return employees.filter((e) => {
      const ctrs = contractsByEmployee.get(e.id) ?? [];
      if (employeeKind !== "all" && e.kind !== employeeKind) return false;
      if (employeeDept === "none" && e.departmentId != null) return false;
      if (typeof employeeDept === "number" && e.departmentId !== employeeDept)
        return false;
      if (!q) return true;
      const haystack = [
        e.fullName,
        e.code,
        e.notes,
        e.departmentName,
        ...ctrs.map((c) => c.company),
        ...(e.officeCompanies ?? []),
      ];
      return haystack.some((v) => (v ?? "").toLowerCase().includes(q));
    });
  }, [
    employees,
    employeeFilter,
    employeeKind,
    employeeDept,
    contractsByEmployee,
  ]);

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

  const payrollVisible = useMemo(() => {
    const q = payrollFilter.trim().toLowerCase();
    if (!q) return payroll;
    return payroll.filter(
      (r) =>
        r.employeeName.toLowerCase().includes(q) ||
        r.company.toLowerCase().includes(q),
    );
  }, [payroll, payrollFilter]);

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
          value: String(summary.missingMain + summary.pendingBonus),
          sub: `${summary.missingMain} bez kwoty, ${summary.pendingBonus} do przeliczenia`,
          tip: "Wiersze z godzinami bez kwoty od księgowości + dodatki czekające na stawkę",
          accent:
            summary.missingMain + summary.pendingBonus > 0
              ? "text-amber-600"
              : undefined,
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
          <div className="flex flex-wrap items-center gap-3">
            {monthNav}
            <Input
              value={payrollFilter}
              onChange={(e) => setPayrollFilter(e.target.value)}
              placeholder="Szukaj: pracownik / spółka…"
              className="max-w-xs"
            />
            <Button
              variant="outline"
              className="ml-auto"
              onClick={() => printHrStatement(payroll, year, month)}
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
                    <Th tip="Pracownik z umowy — kliknij wiersz, aby wpisać kwoty i nadpisania">
                      Pracownik
                    </Th>
                    <Th tip="Spółka zatrudniająca (z umowy)">Spółka</Th>
                    <Th tip="Typ umowy: Praca (UoP) / Zlecenie — decyduje o normie godzin i wliczaniu L4">
                      Umowa
                    </Th>
                    <Th tip="Zgłoszenie decydujące o gałęzi kalkulacji: ZUA = umowa główna (godziny do maks), ZZA = nadwyżka ponad normę umowy głównej">
                      Rej.
                    </Th>
                    <Th
                      tip="Limit godzin: ręczne nadpisanie → indywidualne GODZINY MAKS z wpisów godzin (przy UoP, największy wpis) → norma miesiąca z zakładki Normy"
                      className="text-right"
                    >
                      Maks
                    </Th>
                    <Th
                      tip="Godziny do rozliczenia: ZUA = min(wypracowane + UW (+ L4 przy UoP), maks); ZZA = nadwyżka ponad normę UoP (gdy pracownik ma umowę o pracę) albo ponad maks. Ręczne nadpisanie ma pierwszeństwo"
                      className="text-right"
                    >
                      Fakt
                    </Th>
                    <Th
                      tip="Godziny dodatku = wypracowane + UW (+ L4 przy UoP lub zleceniu w ALFA) − maks godziny; liczone tylko gdy umowa ma ustawiony dodatek"
                      className="text-right"
                    >
                      Godz. dod.
                    </Th>
                    <Th
                      tip="Stawka netto = kwota główna NETTO ÷ fakt godziny"
                      className="text-right"
                    >
                      Stawka
                    </Th>
                    <Th
                      tip="Kwota główna NETTO — wpisywana ręcznie na podstawie zestawienia od księgowości (kanał: kolumna Główna)"
                      className="text-right"
                    >
                      Kwota główna
                    </Th>
                    <Th
                      tip="Kwota wyrównania = wyrównanie stawki (zł/h, wpisywane ręcznie) × fakt godziny"
                      className="text-right"
                    >
                      Wyrówn.
                    </Th>
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
                    <Th
                      tip="Dodatek finalny = kwota dodatku + premia/potrącenie + kwota wyrównania"
                      className="text-right"
                    >
                      Dod. finalny
                    </Th>
                    <Th
                      tip="Przelew = kwota główna (gdy Główna=przelew) + dodatek finalny (gdy kanał dodatku=przelew; przy braku dodatku — kanałem wypłaty głównej). Poprawka względem Excela: premia bez dodatku nie przepada"
                      className="text-right"
                    >
                      Przelew
                    </Th>
                    <Th
                      tip="Gotówka = kwota główna (gdy Główna=gotówka) + dodatek finalny (gdy kanał dodatku=gotówka; przy braku dodatku — kanałem wypłaty głównej)"
                      className="text-right"
                    >
                      Gotówka
                    </Th>
                    <Th
                      tip="Wypłata całkowita = przelew + gotówka"
                      className="text-right"
                    >
                      Wypłata
                    </Th>
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
                        Brak umów — dodaj je w zakładce Umowy
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
                    <Th tip="Pracownik biura — osobne rozliczenie, poza kalkulacją ochrony">
                      Pracownik
                    </Th>
                    <Th tip="Spółka i forma zatrudnienia (ALFA ETAT / ALFA UZ / …)">
                      Spółka
                    </Th>
                    <Th tip="Nominalne godziny etatu" className="text-right">
                      Etat
                    </Th>
                    <Th tip="Urlop / chorobowe (h)" className="text-right">
                      UW/L4
                    </Th>
                    <Th
                      tip="Godziny do księgowej — dla rozliczanych godzinowo (UZ)"
                      className="text-right"
                    >
                      Godz. do księg.
                    </Th>
                    <Th tip="Stawka godzinowa (zł/h)" className="text-right">
                      Stawka
                    </Th>
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
                    <Th
                      tip="Razem = podstawa ROR + delegacje/gotówka"
                      className="text-right"
                    >
                      Razem
                    </Th>
                    <Th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {office.length === 0 ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        {loading ? "Ładowanie…" : "Brak wpisów biura w tym miesiącu"}
                      </td>
                    </tr>
                  ) : (
                    office.map((r) => (
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
                {office.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 bg-muted/40 font-semibold">
                      <td className="px-3 py-2" colSpan={7}>
                        Razem ({office.length})
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(office.reduce((s, r) => s + (r.rorBase ?? 0), 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(office.reduce((s, r) => s + (r.cash ?? 0), 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {money(office.reduce((s, r) => s + r.total, 0))}
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
          <div className="flex flex-wrap items-center gap-3">
            {monthNav}
            <Input
              value={employeeFilter}
              onChange={(e) => setEmployeeFilter(e.target.value)}
              placeholder="Szukaj: pracownik, kod, spółka…"
              className="w-64"
            />
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
            <select
              value={employeeDept === "all" ? "all" : String(employeeDept)}
              onChange={(e) => {
                const v = e.target.value;
                setEmployeeDept(
                  v === "all" || v === "none" ? v : Number(v),
                );
              }}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
              title="Filtr po dziale z kartoteki pracownika"
            >
              <option value="all">Wszystkie działy</option>
              <option value="none">Bez działu</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
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
              <table className="w-full min-w-[960px] text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th className="w-8" />
                    <Th tip="Nazwisko i imię — klucz łączący godziny, umowy i wynagrodzenia">
                      Nazwisko i imię
                    </Th>
                    <Th tip="Kod statusu (Emeryt / Rencista / Student <26 lat) — informacyjny">
                      Kod
                    </Th>
                    <Th tip="Ochrona = osoba z umową kadrową; Biuro = osoba rozliczana w zestawieniu biura (wybrany miesiąc)">
                      Rodzaj
                    </Th>
                    <Th tip="Macierzysty dział z kartoteki — podpowiadany przy nowym wpisie godzin, ale wpis można rozliczyć na obiekcie">
                      Dział
                    </Th>
                    <Th tip="Spółki z umów i z rozliczenia biura — rozwiń wiersz, aby wejść w szczegóły">
                      Spółki
                    </Th>
                    <Th tip="Nieaktywny pracownik nie jest podpowiadany w formularzach">
                      Status
                    </Th>
                    <Th>Notatka</Th>
                    <Th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {employeesVisible.length === 0 ? (
                    <tr>
                      <td
                        colSpan={9}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        {loading ? "Ładowanie…" : "Brak pracowników"}
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
                                {rowContracts.length > 0 && (
                                  <span className="text-xs text-muted-foreground">
                                    {rowContracts.length} umów
                                  </span>
                                )}
                                {r.kind === "ochrona" &&
                                  rowContracts.length === 0 && (
                                    <span className="text-xs text-amber-600">
                                      brak umów
                                    </span>
                                  )}
                              </div>
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
                              <td colSpan={9} className="px-3 py-3">
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
                      <td className="px-3 py-2" colSpan={3}>
                        Razem ({employeesVisible.length} prac.)
                      </td>
                      <td className="px-3 py-2 text-xs font-normal text-muted-foreground">
                        {visibleContractsCount} umów
                      </td>
                      <td colSpan={4} />
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
          <div className="flex flex-wrap items-center gap-3">
            {monthNav}
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
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th tip="Nazwa obiektu (posterunku) — słownik do wpisów godzin">
                      Obiekt kadrowy
                    </Th>
                    <Th
                      tip="Suma godzin wypracowanych na tej pozycji z całej historii — im więcej, tym ważniejsze mapowanie"
                      className="text-right"
                    >
                      Godziny
                    </Th>
                    <Th
                      tip="Ilu różnych pracowników kiedykolwiek księgowało godziny na tej pozycji"
                      className="text-right"
                    >
                      Pracownicy
                    </Th>
                    <Th tip="Obiekt z kartoteki, na który przeniosą się wynagrodzenia z tej pozycji (Analityka → Obiekty)">
                      Obiekt w kartotece
                    </Th>
                    <Th tip="Nieaktywny obiekt nie jest podpowiadany przy wpisywaniu godzin">
                      Status
                    </Th>
                    <Th className="w-32" />
                  </tr>
                </thead>
                <tbody>
                  {sortedObjects.map((r) => {
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
