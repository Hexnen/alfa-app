// Moduł Kadry — odwzorowanie skoroszytu "MASTER": godziny → zestawienie dla
// księgowości → kwoty od księgowości → wynagrodzenia (przelew/gotówka).
// Każdy nagłówek kolumny ma tooltip (hover) z opisem, z czego się kalkuluje.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { printHrStatement } from "@/lib/hrPrint";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { cn } from "@/lib/utils";
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Printer,
  AlertTriangle,
} from "lucide-react";
import {
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
  type HrContract,
  type HrContractInput,
  type HrMonthNorm,
  type HrOfficeRow,
  type HrOfficeInput,
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

const pln = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});
const money = (v: number | null | undefined) =>
  v == null ? "—" : pln.format(v);
const hrs = (v: number | null | undefined) =>
  v == null ? "—" : String(Math.round(v * 100) / 100).replace(".", ",");

const BONUS_SHORT: Record<string, string> = {
  brak: "—",
  gotowka: "Gotówka",
  delegacja_przelew: "Deleg. przelew",
  delegacja_gotowka: "Deleg. gotówka",
};

// Nagłówek kolumny z tooltipem "z czego się kalkuluje" (wymóg: hover na nagłówku)
function Th({
  tip,
  children,
  className,
}: {
  tip?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      title={tip}
      className={cn(
        "whitespace-nowrap px-3 py-2 text-left font-medium",
        tip && "cursor-help underline decoration-dotted underline-offset-4",
        className,
      )}
    >
      {children}
    </th>
  );
}

const KADRY_TABS = [
  "wynagrodzenia",
  "godziny",
  "biuro",
  "umowy",
  "pracownicy",
  "obiekty",
  "normy",
] as const;

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
  const [contracts, setContracts] = useState<HrContract[]>([]);
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
  const [hoursFilter, setHoursFilter] = useState("");
  const [newObjectName, setNewObjectName] = useState("");
  const [normDraft, setNormDraft] = useState<
    Record<number, { workNorm: string; contractNorm: string }>
  >({});

  // Carry-over: jedna próba na parę (year, month) w tej sesji + ochrona przed
  // zapisem stanu po szybkiej zmianie miesiąca (klucz ostatniego żądania)
  const carryTriedRef = useRef<Set<string>>(new Set());
  const monthKeyRef = useRef("");

  const loadMonth = useCallback(async () => {
    const key = `${year}-${month}`;
    monthKeyRef.current = key;
    setLoading(true);
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
      if (monthKeyRef.current === key) setLoading(false);
    }
  }, [year, month, hoursEditable]);

  const loadDictionaries = useCallback(async () => {
    const [e, o, c] = await Promise.all([
      getHrEmployees(),
      getHrObjects(),
      getHrContracts(),
    ]);
    setEmployees(e.data ?? []);
    setObjects(o.data ?? []);
    setContracts(c.data ?? []);
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

  const companies = useMemo(
    () => [...new Set(contracts.map((c) => c.company))].sort(),
    [contracts],
  );
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.active),
    [employees],
  );

  const payrollVisible = useMemo(() => {
    const q = payrollFilter.trim().toLowerCase();
    if (!q) return payroll;
    return payroll.filter(
      (r) =>
        r.employeeName.toLowerCase().includes(q) ||
        r.company.toLowerCase().includes(q),
    );
  }, [payroll, payrollFilter]);

  const hoursVisible = useMemo(() => {
    const q = hoursFilter.trim().toLowerCase();
    if (!q) return hours;
    return hours.filter(
      (r) =>
        r.employeeName.toLowerCase().includes(q) ||
        r.objectName.toLowerCase().includes(q),
    );
  }, [hours, hoursFilter]);

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

  if (!tab || !KADRY_TABS.includes(tab as (typeof KADRY_TABS)[number])) {
    return <Navigate to="/kadry/wynagrodzenia" replace />;
  }

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-bold">Kadry</h1>
          <p className="text-muted-foreground">
            Godziny, wynagrodzenia i zestawienia dla księgowości
          </p>
        </div>
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
      </div>

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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Input
              value={payrollFilter}
              onChange={(e) => setPayrollFilter(e.target.value)}
              placeholder="Szukaj: pracownik / spółka…"
              className="max-w-xs"
            />
            <Button
              variant="outline"
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
        </TabsContent>

        {/* ==================== GODZINY ==================== */}
        <TabsContent value="godziny" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Input
              value={hoursFilter}
              onChange={(e) => setHoursFilter(e.target.value)}
              placeholder="Szukaj: pracownik / obiekt…"
              className="max-w-xs"
            />
            {editable && (
              <Button
                onClick={() => {
                  setHoursEdit(null);
                  setHoursFormOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Dodaj godziny
              </Button>
            )}
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[1080px] text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th tip="Pracownik, którego dotyczy wpis (jedna osoba może mieć kilka wpisów w miesiącu — sumują się)">
                      Pracownik
                    </Th>
                    <Th tip="Obiekt (posterunek) — informacyjny, nie wpływa na kalkulację wypłaty">
                      Obiekt
                    </Th>
                    <Th
                      tip="Godziny nocne — informacyjne, nie wchodzą do kalkulacji"
                      className="text-right"
                    >
                      Nocne
                    </Th>
                    <Th
                      tip="Godziny wypracowane — podstawa fakt godzin i nadwyżki dodatku"
                      className="text-right"
                    >
                      Wyprac.
                    </Th>
                    <Th
                      tip="Urlop wypoczynkowy (h) — wlicza się do godzin rozliczanych"
                      className="text-right"
                    >
                      UW
                    </Th>
                    <Th
                      tip="Chorobowe (h) — wlicza się przy umowie o pracę (oraz do nadwyżki dodatku przy zleceniu w ALFA)"
                      className="text-right"
                    >
                      L4
                    </Th>
                    <Th
                      tip="Indywidualny limit godzin — przy UoP zastępuje normę miesiąca (brany największy wpis z miesiąca)"
                      className="text-right"
                    >
                      Godz. maks
                    </Th>
                    <Th
                      tip="Potrącenia (zł) — pomniejszają premię/potrącenie w wynagrodzeniu"
                      className="text-right"
                    >
                      Potrącenia
                    </Th>
                    <Th
                      tip="Dodatki/premie (zł) — powiększają premię/potrącenie w wynagrodzeniu"
                      className="text-right"
                    >
                      Dodatki
                    </Th>
                    <Th>Notatka</Th>
                    <Th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {hoursVisible.length === 0 ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        {loading ? "Ładowanie…" : "Brak wpisów godzin w tym miesiącu"}
                      </td>
                    </tr>
                  ) : (
                    hoursVisible.map((r) => (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b hover:bg-accent/50",
                          editable && "cursor-pointer",
                        )}
                        onClick={
                          editable
                            ? () => {
                                setHoursEdit(r);
                                setHoursFormOpen(true);
                              }
                            : undefined
                        }
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-medium">
                          {r.employeeName}
                        </td>
                        <td className="px-3 py-2">
                          {r.objectName || "—"}
                          {r.objectUncertain && (
                            <span
                              title="Przeniesione z poprzedniego miesiąca — potwierdź obiekt zapisując wpis"
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
                                onClick={() => {
                                  setHoursEdit(r);
                                  setHoursFormOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleHoursDelete(r)}
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
        </TabsContent>

        {/* ==================== BIURO ==================== */}
        <TabsContent value="biuro" className="space-y-4">
          {editable && (
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setOfficeEdit(null);
                  setOfficeFormOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Dodaj wpis biura
              </Button>
            </div>
          )}
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

        {/* ==================== UMOWY ==================== */}
        <TabsContent value="umowy" className="space-y-4">
          {editable && (
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setContractEdit(null);
                  setContractFormOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Dodaj umowę
              </Button>
            </div>
          )}
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th tip="Pracownik — jedna osoba może mieć kilka umów (np. ZUA w spółce docelowej + ZZA w źródłowej)">
                      Pracownik
                    </Th>
                    <Th tip="Spółka zatrudniająca">Spółka</Th>
                    <Th tip="Praca (UoP) / Zlecenie — decyduje o normie i wliczaniu L4">
                      Umowa
                    </Th>
                    <Th tip="Ubezpieczenie chorobowe — informacyjne">chor.</Th>
                    <Th tip="Zgłoszenie ZUA — niepuste włącza rozliczanie godzin do maks">
                      ZUA
                    </Th>
                    <Th tip="Zgłoszenie ZZA — wiersz dostaje nadwyżkę godzin ponad normę umowy głównej">
                      ZZA
                    </Th>
                    <Th tip="Kanał wypłaty głównej">Główna</Th>
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
                  {contracts.length === 0 ? (
                    <tr>
                      <td
                        colSpan={10}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        Brak umów
                      </td>
                    </tr>
                  ) : (
                    contracts.map((r) => (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b hover:bg-accent/50",
                          editable && "cursor-pointer",
                        )}
                        onClick={
                          editable
                            ? () => {
                                setContractEdit(r);
                                setContractFormOpen(true);
                              }
                            : undefined
                        }
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-medium">
                          {r.employeeName}
                        </td>
                        <td className="px-3 py-2">{r.company}</td>
                        <td className="px-3 py-2">
                          {r.contractType === "praca" ? "Praca" : "Zlecenie"}
                        </td>
                        <td className="px-3 py-2">{r.chor ? "tak" : ""}</td>
                        <td className="px-3 py-2">{r.zua}</td>
                        <td className="px-3 py-2">{r.zza}</td>
                        <td className="px-3 py-2">
                          {r.mainChannel === "przelew" ? "Przelew" : "Gotówka"}
                        </td>
                        <td className="px-3 py-2">{BONUS_SHORT[r.bonusType]}</td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
                              r.active
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {r.active ? "aktywna" : "nieaktywna"}
                          </span>
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
                                  setContractEdit(r);
                                  setContractFormOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleContractDelete(r)}
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
        </TabsContent>

        {/* ==================== PRACOWNICY ==================== */}
        <TabsContent value="pracownicy" className="space-y-4">
          {editable && (
            <div className="flex justify-end">
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
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th tip="Nazwisko i imię — klucz łączący godziny, umowy i wynagrodzenia">
                      Nazwisko i imię
                    </Th>
                    <Th tip="Kod statusu (Emeryt / Rencista / Student <26 lat) — informacyjny">
                      Kod
                    </Th>
                    <Th tip="Nieaktywny pracownik nie jest podpowiadany w formularzach">
                      Status
                    </Th>
                    <Th>Notatka</Th>
                    <Th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {employees.map((r) => (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b hover:bg-accent/50",
                        editable && "cursor-pointer",
                      )}
                      onClick={
                        editable
                          ? () => {
                              setEmployeeEdit(r);
                              setEmployeeFormOpen(true);
                            }
                          : undefined
                      }
                    >
                      <td className="px-3 py-2 font-medium">{r.fullName}</td>
                      <td className="px-3 py-2">{r.code}</td>
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
                      <td className="max-w-[280px] truncate px-3 py-2 text-xs text-muted-foreground">
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
                              onClick={() => handleEmployeeDelete(r)}
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
            </CardContent>
          </Card>
        </TabsContent>

        {/* ==================== OBIEKTY ==================== */}
        <TabsContent value="obiekty" className="space-y-4">
          {editable && (
            <div className="flex max-w-md gap-2">
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
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <Th tip="Nazwa obiektu (posterunku) — słownik do wpisów godzin">
                      Obiekt
                    </Th>
                    <Th tip="Nieaktywny obiekt nie jest podpowiadany przy wpisywaniu godzin">
                      Status
                    </Th>
                    <Th className="w-32" />
                  </tr>
                </thead>
                <tbody>
                  {objects.map((r) => (
                    <tr key={r.id} className="border-b hover:bg-accent/50">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
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
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ==================== NORMY ==================== */}
        <TabsContent value="normy" className="space-y-4">
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
        />
      )}
      {contractFormOpen && (
        <HrContractForm
          key={contractEdit?.id ?? "new"}
          open
          onClose={() => setContractFormOpen(false)}
          onSubmit={handleContractSubmit}
          contract={contractEdit}
          employees={contractEdit ? employees : activeEmployees}
          companies={companies}
        />
      )}
      {officeFormOpen && (
        <HrOfficeForm
          key={officeEdit?.id ?? "new"}
          open
          onClose={() => setOfficeFormOpen(false)}
          onSubmit={handleOfficeSubmit}
          row={officeEdit}
          employees={officeEdit ? employees : activeEmployees}
          year={year}
          month={month}
        />
      )}
    </div>
  );
}
