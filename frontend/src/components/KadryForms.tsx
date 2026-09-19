// Formularze dialogowe modułu Kadry: pracownik, wpis godzin, umowa,
// dane płacowe miesiąca (kwoty od księgowości + nadpisania) i biuro.
//
// Błędy zapisu lądują W OKNIE (czerwony tekst nad stopką), nie w `alert()`:
// natywny alert zasłaniał formularz, gubił wpisane dane z pola widzenia i nie
// dało się z niego skopiować komunikatu.
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { tip } from "./ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { previewHrPayroll } from "@/lib/api";
import { EntityHistory } from "@/components/kadry/EntityHistory";

/** Rok i miesiąc → „2026-09” (klucz okresu wpisu w dzienniku zmian). */
const ymKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;
import type {
  Company,
  HrBonusType,
  HrDepartment,
  HrEmployeeKind,
  HrChannel,
  HrContract,
  HrContractInput,
  HrContractType,
  HrEmployee,
  HrEmployeeInput,
  HrHoursEntry,
  HrHoursInput,
  HrObject,
  HrOfficeInput,
  HrOfficeRow,
  HrPayrollRow,
  HrPayrollSaveInput,
} from "@/lib/api";
// pola liczbowe (puste = null, przecinek dozwolony) oraz kodowanie przypisania
// wiersza godzin (obiekt albo dział) — wspólne z tabelami Kadr
import {
  NUM_FIELD_ERROR,
  fieldToNum,
  hrs,
  isNumFieldValid,
  money,
  numToField,
} from "./kadry/shared";
import { EmployeePicker } from "./kadry/EmployeePicker";
// Okres obowiązywania umowy (migracja 0112) — formatowanie wspólne z kartoteką.
import { datePl, shiftIsoDate } from "./kadry/contract-period";
import { cn } from "@/lib/utils";

const SELECT_CLS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/** Ten sam select, tylko wygaszony — pole nieczynne ma to widać po sobie. */
const cnSelect = (disabled: boolean) =>
  disabled ? `${SELECT_CLS} cursor-not-allowed opacity-50` : SELECT_CLS;

/** Komunikat błędu zapisu w stopce formularza — zamiast `alert()`. */
function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="text-sm text-destructive" data-testid="kadry-form-error">
      {message}
    </p>
  );
}

/** Opis pod polem: co wpisać i co to zmienia w kalkulacji. */
function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/**
 * Nazwy spółek do wyboru: aktywne ze słownika + wartość już zapisana w wierszu,
 * choćby spółka była zarchiwizowana albo (dane historyczne) spoza słownika —
 * inaczej edycja innego pola po cichu podmieniałaby spółkę.
 */
function companyOptions(companies: Company[], current?: string | null): string[] {
  const names = companies.filter((c) => c.active).map((c) => c.name);
  const cur = (current ?? "").trim();
  if (cur && !names.includes(cur)) names.push(cur);
  return names.sort((a, b) => a.localeCompare(b, "pl"));
}

/**
 * Działy do wyboru: aktywne + ten już przypisany, choćby był zarchiwizowany —
 * inaczej edycja dowolnego innego pola kartoteki po cichu kasowałaby dział.
 */
function departmentOptions(
  departments: HrDepartment[],
  currentId?: number | null,
): HrDepartment[] {
  const list = departments.filter(
    (d) => d.active || (currentId != null && d.id === currentId),
  );
  return [...list].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, "pl"),
  );
}

function NumField({
  id,
  label,
  value,
  onChange,
  hint,
  prev,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  /**
   * Wartość z POPRZEDNIEGO MIESIĄCA, gotowa do wyświetlenia („168"). W pustym
   * polu jest podpowiedzią (placeholder), pod polem — punktem odniesienia,
   * dokładnie jak kolumna „pop." w tabeli Godzin.
   */
  prev?: string;
}) {
  // „3 200,00” i „3200.50” są poprawne, „12h” i „3,2,1” — nie. Pole mówi to od
  // razu (czerwona ramka + komunikat), a `hasInvalidNums` niżej nie pozwala
  // wysłać takiego formularza: `fieldToNum` zwróciłby `null`, czyli po cichu
  // wyczyściłby kwotę.
  const invalid = !isNumFieldValid(value);
  return (
    <div className="space-y-2">
      <Label
        htmlFor={id}
        {...(hint ? tip(hint) : {})}
        className={hint ? "cursor-help" : ""}
      >
        {label}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={value === "" && prev ? prev : "—"}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        className={cn(
          invalid && "border-destructive text-destructive focus-visible:ring-destructive",
        )}
      />
      {prev && (
        <p className="text-[11px] leading-tight text-muted-foreground">
          pop. {prev}
        </p>
      )}
      {invalid && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {NUM_FIELD_ERROR}
        </p>
      )}
    </div>
  );
}

/**
 * Czy którekolwiek z pól liczbowych formularza jest niepoprawne.
 *
 * Stan `fields` każdego z tych formularzy trzyma WYŁĄCZNIE pola liczbowe
 * (teksty — uwagi, spółka — mają własne `useState`), więc wystarczy przejść po
 * wartościach. Blokada jest konieczna, bo `fieldToNum` zwraca `null` i dla
 * pustego pola, i dla śmiecia: bez niej „12h” zapisywałoby się jako brak kwoty.
 */
const hasInvalidNums = (fields: Record<string, string>): boolean =>
  Object.values(fields).some((v) => !isNumFieldValid(v));

/** Komunikat pod przyciskiem „Zapisz”, gdy formularz ma niepoprawną liczbę. */
const INVALID_NUMS_ERROR =
  "Popraw pola oznaczone na czerwono — wpisz liczbę (np. 3 200,00 albo 3200.50)";

// ==================== PRACOWNIK ====================

export function HrEmployeeForm({
  open,
  onClose,
  onSubmit,
  employee,
  departments,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrEmployeeInput) => Promise<void>;
  employee?: HrEmployee | null;
  /** Działy firmy — lista wyboru macierzystego działu pracownika. */
  departments: HrDepartment[];
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Dział obiektowy (`hasObjects`, u nas OFI) — do niego należą wszyscy
   * pracownicy ochrony, więc NOWA kartoteka ochrony startuje z nim wpisanym.
   * To podpowiedź przy zakładaniu, nie reguła: pole zostaje do zmiany, a osób
   * już istniejących nie ruszamy (ich dział ustalono kiedyś świadomie).
   * Dopóki backend nie odda flagi, rozpoznajemy dział po nazwie „OFI".
   */
  const objectDept = departments.find(
    (d) => d.hasObjects === true || (d.hasObjects == null && d.name === "OFI"),
  );
  const [formData, setFormData] = useState<HrEmployeeInput>({
    fullName: employee?.fullName || "",
    code: employee?.code || "",
    kind: employee?.kind || "ochrona",
    departmentId:
      employee?.departmentId ?? (employee ? null : (objectDept?.id ?? null)),
    notes: employee?.notes || "",
    active: employee?.active ?? true,
  });
  const deptChoices = departmentOptions(departments, employee?.departmentId);

  /**
   * Przełączenie rodzaju na „ochrona" przy PUSTYM dziale podpowiada dział
   * obiektowy; przełączenie na „biuro" zdejmuje tę podpowiedź (biuro nie
   * rozlicza się na obiektach), ale nie rusza działu wybranego ręcznie.
   */
  const handleKindChange = (kind: HrEmployeeKind) =>
    setFormData((p) => ({
      ...p,
      kind,
      departmentId:
        kind === "ochrona"
          ? (p.departmentId ?? objectDept?.id ?? null)
          : p.departmentId === objectDept?.id
            ? null
            : p.departmentId,
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await onSubmit(formData);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu pracownika");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {employee ? "Edytuj pracownika" : "Nowy pracownik"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="hre-name">Nazwisko i imię *</Label>
            <Input
              id="hre-name"
              value={formData.fullName}
              onChange={(e) =>
                setFormData((p) => ({ ...p, fullName: e.target.value }))
              }
              placeholder="np. Kowalski Jan"
              required
            />
          </div>
          <div className="space-y-2">
            <Label
              htmlFor="hre-kind"
              {...tip("Ochrona rozlicza się z umów kadrowych; biuro — z zestawienia biura w Wynagrodzeniach")}
              className="cursor-help"
            >
              Rodzaj rozliczenia
            </Label>
            <select
              id="hre-kind"
              value={formData.kind || "ochrona"}
              onChange={(e) => handleKindChange(e.target.value as HrEmployeeKind)}
              className={SELECT_CLS}
            >
              <option value="ochrona">Ochrona (umowy)</option>
              <option value="biuro">Biuro</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label
              htmlFor="hre-dept"
              {...tip("Macierzysty dział pracownika — podpowiadany przy nowym wpisie godzin")}
              className="cursor-help"
            >
              Dział
            </Label>
            <select
              id="hre-dept"
              value={
                formData.departmentId == null ? "" : String(formData.departmentId)
              }
              onChange={(e) =>
                setFormData((p) => ({
                  ...p,
                  // Pusta opcja = jawny null, nie `undefined`: PUT nadpisuje
                  // rekord, więc pominięcie pola zostawiłoby stary dział.
                  departmentId: e.target.value ? Number(e.target.value) : null,
                }))
              }
              className={SELECT_CLS}
            >
              <option value="">— brak —</option>
              {deptChoices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            {!employee && formData.kind === "ochrona" && objectDept && (
              <FieldHint>
                Ochrona rozlicza się na obiektach, a te istnieją w dziale{" "}
                {objectDept.label} — dlatego jest podpowiedziany. Możesz zmienić.
              </FieldHint>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="hre-code">Kod (status)</Label>
            <select
              id="hre-code"
              value={formData.code || ""}
              onChange={(e) =>
                setFormData((p) => ({ ...p, code: e.target.value }))
              }
              className={SELECT_CLS}
            >
              <option value="">—</option>
              <option value="Emeryt">Emeryt</option>
              <option value="Rencista">Rencista</option>
              <option value="Student <26 lat">Student &lt;26 lat</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="hre-notes">Notatka</Label>
            <Textarea
              id="hre-notes"
              value={formData.notes || ""}
              onChange={(e) =>
                setFormData((p) => ({ ...p, notes: e.target.value }))
              }
              rows={2}
            />
          </div>
          {employee && (
            <EntityHistory
              variant="section"
              entityType="hr_employee"
              entityId={employee.id}
              title={employee.fullName}
            />
          )}
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={formData.active ?? true}
              onChange={(e) =>
                setFormData((p) => ({ ...p, active: e.target.checked }))
              }
              className="h-4 w-4 accent-primary"
            />
            Aktywny
          </label>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              type="submit"
              disabled={loading || !formData.fullName.trim()}
            >
              {loading ? "Zapisywanie…" : employee ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ==================== WPIS GODZIN ====================

export function HrHoursForm({
  open,
  onClose,
  onSubmit,
  entry,
  employees,
  objects,
  departments,
  year,
  month,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrHoursInput) => Promise<void>;
  entry?: HrHoursEntry | null;
  employees: HrEmployee[];
  objects: HrObject[];
  /** Działy — pierwszy wybór wpisu; obiekt jest dostępny tylko w dziale obiektowym. */
  departments: HrDepartment[];
  year: number;
  month: number;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState(
    entry ? String(entry.employeeId) : "",
  );
  /**
   * Dział i obiekt to dwa pola z JEDNĄ zależnością: obiekt (posterunek) istnieje
   * wyłącznie w dziale obiektowym — u nas OFI, bo tam należą wszyscy pracownicy
   * obiektowi. Dział bez obiektów rozlicza pracę działową i blokuje drugie pole.
   */
  const [departmentId, setDepartmentId] = useState(
    entry?.departmentId == null ? "" : String(entry.departmentId),
  );
  const [objectId, setObjectId] = useState(
    entry?.objectId == null ? "" : String(entry.objectId),
  );
  const [fields, setFields] = useState({
    nightHours: numToField(entry?.nightHours),
    workedHours: numToField(entry?.workedHours),
    uwHours: numToField(entry?.uwHours),
    l4Hours: numToField(entry?.l4Hours),
    maxHours: numToField(entry?.maxHours),
    deductions: numToField(entry?.deductions),
    bonuses: numToField(entry?.bonuses),
  });
  const [notes, setNotes] = useState(entry?.notes || "");

  const set = (k: keyof typeof fields) => (v: string) =>
    setFields((p) => ({ ...p, [k]: v }));

  /**
   * Godziny z POPRZEDNIEGO MIESIĄCA (ta sama osoba, to samo przypisanie) —
   * backend dokłada je do wpisu jako `prev`. Ten sam punkt odniesienia, co
   * kolumna „pop." w tabeli Godzin: formularz i tabela mają mówić to samo,
   * niezależnie od tego, którędy ktoś wpisuje miesiąc. Nowy wpis nie ma czego
   * porównywać (nie wiadomo jeszcze, kogo dotyczy), więc tam podpowiedzi nie ma.
   */
  const prevHours = (
    field: "workedHours" | "uwHours" | "l4Hours" | "nightHours",
  ): string | undefined => {
    const v = entry?.prev?.[field];
    return v == null ? undefined : hrs(v);
  };

  /** Dział obiektowy (`hasObjects`); zanim backend odda flagę — dział „OFI". */
  const isObjectDept = (d: HrDepartment | undefined) =>
    d != null && (d.hasObjects === true || (d.hasObjects == null && d.name === "OFI"));
  const objectDepartments = departments.filter(isObjectDept);
  const currentDept = departments.find((d) => String(d.id) === departmentId);
  const objectsAllowed = isObjectDept(currentDept);

  /**
   * Wybór pracownika PODPOWIADA dział: macierzysty z kartoteki, a przy ochronie
   * bez działu — dział obiektowy (OFI), bo tam siedzą wszyscy pracownicy
   * obiektowi. To tylko podpowiedź przy NOWYM wpisie i tylko na puste pole:
   * istniejącego wiersza nie ruszamy, bo tam dział ustalono kiedyś świadomie.
   */
  const handleEmployeeChange = (value: string) => {
    setEmployeeId(value);
    if (entry) return;
    const emp = employees.find((e) => String(e.id) === value);
    const own = emp?.departmentId ?? null;
    const suggested =
      own != null && departments.some((d) => d.id === own)
        ? own
        : emp?.kind === "ochrona" && objectDepartments.length === 1
          ? objectDepartments[0].id
          : null;
    if (suggested == null) return;
    setDepartmentId((prev) => (prev === "" ? String(suggested) : prev));
  };

  /** Zmiana działu: dział bez obiektów nie może ciągnąć za sobą posterunku. */
  const handleDepartmentChange = (value: string) => {
    setDepartmentId(value);
    const dept = departments.find((d) => String(d.id) === value);
    if (!isObjectDept(dept)) setObjectId("");
  };

  /** Obiekt bez działu podstawia dział obiektowy — tak samo jak backend. */
  const handleObjectChange = (value: string) => {
    setObjectId(value);
    if (value !== "" && departmentId === "" && objectDepartments.length === 1) {
      setDepartmentId(String(objectDepartments[0].id));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasInvalidNums(fields)) {
      setError(INVALID_NUMS_ERROR);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Oba id lecą zawsze (jedno bywa null): zapis nadpisuje cały wiersz, więc
      // zdjęcie obiektu musi jawnie wyzerować pole.
      await onSubmit({
        employeeId,
        objectId: objectId === "" ? null : Number(objectId),
        departmentId: departmentId === "" ? null : Number(departmentId),
        year: entry?.year ?? year,
        month: entry?.month ?? month,
        nightHours: fieldToNum(fields.nightHours),
        workedHours: fieldToNum(fields.workedHours),
        uwHours: fieldToNum(fields.uwHours),
        l4Hours: fieldToNum(fields.l4Hours),
        maxHours: fieldToNum(fields.maxHours),
        deductions: fieldToNum(fields.deductions),
        bonuses: fieldToNum(fields.bonuses),
        notes,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu godzin");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {entry ? "Edytuj wpis godzin" : "Nowy wpis godzin"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hrh-emp">Pracownik *</Label>
              {/* Kartoteka to ~150 osób — natywna lista wymagała przewijania,
                  więc pole jest wyszukiwarką (wpisz fragment nazwiska). */}
              <EmployeePicker
                id="hrh-emp"
                employees={employees}
                value={employeeId}
                onChange={handleEmployeeChange}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hrh-dept">Dział</Label>
              <select
                id="hrh-dept"
                value={departmentId}
                onChange={(e) => handleDepartmentChange(e.target.value)}
                className={SELECT_CLS}
              >
                <option value="">— brak —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              <FieldHint>
                Dział, w którym rozlicza się wpis. Obiekty (posterunki) są tylko
                w dziale obiektowym{objectDepartments.length === 1
                  ? ` (${objectDepartments[0].label})`
                  : ""}.
              </FieldHint>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hrh-obj">Obiekt</Label>
              <select
                id="hrh-obj"
                value={objectsAllowed ? objectId : ""}
                disabled={!objectsAllowed}
                onChange={(e) => handleObjectChange(e.target.value)}
                className={cnSelect(!objectsAllowed)}
              >
                <option value="">— brak —</option>
                {objects.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              {!objectsAllowed ? (
                <FieldHint>
                  Wybierz najpierw dział obiektowy — w pozostałych działach
                  godziny są kosztem ogólnym firmy i obiektu się nie wskazuje.
                </FieldHint>
              ) : (
                <FieldHint>
                  Posterunek, na którym przepracowano godziny. Możesz zostawić
                  pusty — wtedy wpis jest pracą działową bez obiektu.
                </FieldHint>
              )}
              {entry?.objectUncertain && (
                <p className="text-xs text-amber-600">
                  Przypisanie przeniesione z poprzedniego miesiąca — potwierdź
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <NumField
              id="hrh-worked"
              label="Wypracowane"
              value={fields.workedHours}
              onChange={set("workedHours")}
              prev={prevHours("workedHours")}
              hint="Godziny wypracowane na obiekcie albo w dziale w miesiącu"
            />
            <NumField
              id="hrh-night"
              label="Nocne"
              value={fields.nightHours}
              onChange={set("nightHours")}
              prev={prevHours("nightHours")}
              hint="Godziny nocne — informacyjne, nie wchodzą do kalkulacji wypłaty"
            />
            <NumField
              id="hrh-max"
              label="Godziny maks"
              value={fields.maxHours}
              onChange={set("maxHours")}
              hint="Indywidualny limit godzin — przy umowie o pracę zastępuje normę miesiąca (brany największy wpis z miesiąca)"
            />
            <NumField
              id="hrh-uw"
              label="UW"
              value={fields.uwHours}
              onChange={set("uwHours")}
              prev={prevHours("uwHours")}
              hint="Urlop wypoczynkowy (godziny) — wlicza się do godzin rozliczanych"
            />
            <NumField
              id="hrh-l4"
              label="L4"
              value={fields.l4Hours}
              onChange={set("l4Hours")}
              prev={prevHours("l4Hours")}
              hint="Chorobowe (godziny) — wlicza się do godzin przy umowie o pracę"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <NumField
              id="hrh-ded"
              label="Potrącenia netto (zł)"
              value={fields.deductions}
              onChange={set("deductions")}
              hint="Kwota potrąceń NETTO — pomniejsza premię/potrącenie w wynagrodzeniu"
            />
            <NumField
              id="hrh-bon"
              label="Dodatki / premie netto (zł)"
              value={fields.bonuses}
              onChange={set("bonuses")}
              hint="Kwota premii NETTO — powiększa premię/potrącenie w wynagrodzeniu"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hrh-notes">Notatka</Label>
            <Textarea
              id="hrh-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
          {entry && (
            <EntityHistory
              variant="section"
              entityType="hr_hours"
              entityId={entry.id}
              period={ymKey(entry.year, entry.month)}
              title={entry.employeeName}
            />
          )}

          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading || !employeeId}>
              {loading ? "Zapisywanie…" : entry ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ==================== UMOWA ====================

const BONUS_LABELS: Record<HrBonusType, string> = {
  brak: "— brak —",
  gotowka: "Gotówka",
  delegacja_przelew: "Delegacja — przelew",
  delegacja_gotowka: "Delegacja — gotówka",
};

export function HrContractForm({
  open,
  onClose,
  onSubmit,
  contract,
  employees,
  companies,
  defaultEmployeeId,
  supersede,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrContractInput) => Promise<void>;
  contract?: HrContract | null;
  employees: HrEmployee[];
  /** Słownik spółek (zakładka Spółki) — spółka umowy jest z niego wybierana. */
  companies: Company[];
  /** Pracownik podstawiany w nowej umowie (dodawanie z wiersza kartoteki). */
  defaultEmployeeId?: number;
  /**
   * ZMIANA WARUNKÓW: umowa, którą nowa ma zastąpić. Formularz startuje z jej
   * danymi, wymaga daty „obowiązuje od”, a zapis idzie przez
   * `POST /hr/contracts/:id/supersede` — poprzednia dostaje w tej samej
   * transakcji datę zakończenia dzień wcześniej.
   */
  supersede?: HrContract | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Przy zmianie warunków wzorem jest umowa zastępowana; pusty zostaje wyłącznie
  // okres — to jedyna rzecz, którą trzeba podjąć świadomie.
  const base = contract ?? supersede ?? null;
  const [formData, setFormData] = useState<HrContractInput>({
    employeeId: base
      ? String(base.employeeId)
      : defaultEmployeeId
        ? String(defaultEmployeeId)
        : "",
    company: base?.company || "",
    contractType: base?.contractType || "zlecenie",
    chor: base?.chor ?? false,
    zua: base?.zua || "",
    zza: base?.zza || "",
    zwua: base?.zwua || "",
    objectName: base?.objectName || "",
    mainChannel: base?.mainChannel || "przelew",
    bonusType: base?.bonusType || "brak",
    validFrom: supersede ? "" : contract?.validFrom || "",
    validTo: supersede ? "" : contract?.validTo || "",
    active: supersede ? true : contract?.active ?? true,
    notes: base?.notes || "",
  });

  /** Data zakończenia, którą dostanie umowa zastępowana (podgląd w oknie). */
  const cutoff =
    supersede && formData.validFrom
      ? shiftIsoDate(formData.validFrom, -1)
      : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await onSubmit(formData);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu umowy");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {supersede
              ? `Zmiana warunków — nowa umowa (${supersede.company})`
              : contract
                ? "Edytuj umowę"
                : "Nowa umowa"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {supersede && (
            // Co się stanie po zapisie — powiedziane ZANIM, bo operacja rusza
            // dwie umowy naraz, a widać tylko formularz jednej.
            <div
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
              data-testid="hrc-supersede-note"
            >
              Nowa umowa przejmuje dane bieżącej ({supersede.company},{" "}
              {supersede.contractType === "praca" ? "praca" : "zlecenie"}).
              Bieżąca umowa dostanie datę zakończenia{" "}
              <strong>{cutoff ? datePl(cutoff) : "dzień przed startem nowej"}</strong>
              {" — "}w jednym zapisie, z dwoma wpisami w dzienniku zmian.
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hrc-emp">Pracownik *</Label>
              <EmployeePicker
                id="hrc-emp"
                employees={employees}
                value={String(formData.employeeId)}
                onChange={(v) => setFormData((p) => ({ ...p, employeeId: v }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="hrc-company"
                {...tip("Spółka zatrudniająca ze słownika (zakładka Spółki) — nazwa wiąże umowę ze spółką w zestawieniach")}
                className="cursor-help"
              >
                Spółka *
              </Label>
              <select
                id="hrc-company"
                value={formData.company}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, company: e.target.value }))
                }
                className={SELECT_CLS}
                required
              >
                <option value="">— wybierz —</option>
                {companyOptions(companies, contract?.company).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              {companies.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Słownik spółek jest pusty — dodaj spółkę w zakładce Spółki.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="hrc-type"
                {...tip("Praca: godziny + UW + L4, norma UoP; Zlecenie: godziny + UW, norma zlecenia")}
                className="cursor-help"
              >
                Umowa
              </Label>
              <select
                id="hrc-type"
                value={formData.contractType}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    contractType: e.target.value as HrContractType,
                  }))
                }
                className={SELECT_CLS}
              >
                <option value="praca">Praca</option>
                <option value="zlecenie">Zlecenie</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="hrc-zua"
                {...tip("Zgłoszenie ZUA (umowa główna) — wpisz 'tak' lub datę; niepuste włącza rozliczanie godzin do maks")}
                className="cursor-help"
              >
                ZUA
              </Label>
              <Input
                id="hrc-zua"
                value={formData.zua || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, zua: e.target.value }))
                }
                placeholder="tak / 01.06.2026"
              />
              {/* Pole jest tekstowe, bo w kartotece siedzą i „tak", i daty
                  zgłoszenia — liczy się wyłącznie to, czy jest NIEPUSTE. */}
              <FieldHint>
                Wpisz <strong>tak</strong> albo datę zgłoszenia. Niepuste =
                umowa główna: godziny liczą się do limitu „maks".
              </FieldHint>
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="hrc-zza"
                {...tip("Zgłoszenie ZZA (druga spółka) — wiersz dostaje nadwyżkę godzin ponad normę umowy głównej")}
                className="cursor-help"
              >
                ZZA
              </Label>
              <Input
                id="hrc-zza"
                value={formData.zza || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, zza: e.target.value }))
                }
                placeholder="tak / 01.06.2026"
              />
              <FieldHint>
                Wpisz <strong>tak</strong> albo datę. Działa tylko przy PUSTYM
                ZUA: wtedy umowa dostaje nadwyżkę godzin ponad normę umowy
                głównej. Oba pola puste = godziny nierozliczane.
              </FieldHint>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="hrc-main"
                {...tip("Kanał wypłaty głównej (kwoty NETTO od księgowości)")}
                className="cursor-help"
              >
                Wypłata główna
              </Label>
              <select
                id="hrc-main"
                value={formData.mainChannel}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    mainChannel: e.target.value as HrChannel,
                  }))
                }
                className={SELECT_CLS}
              >
                <option value="przelew">Przelew</option>
                <option value="gotowka">Gotówka</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="hrc-bonus"
                {...tip("Rodzaj dodatku decyduje o liczeniu godzin nadwyżki i kanale ich wypłaty; 'brak' = premie idą kanałem wypłaty głównej")}
                className="cursor-help"
              >
                Dodatek
              </Label>
              <select
                id="hrc-bonus"
                value={formData.bonusType}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    bonusType: e.target.value as HrBonusType,
                  }))
                }
                className={SELECT_CLS}
              >
                {(Object.keys(BONUS_LABELS) as HrBonusType[]).map((k) => (
                  <option key={k} value={k}>
                    {BONUS_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="hrc-obj">Obiekt (opis)</Label>
              <Input
                id="hrc-obj"
                value={formData.objectName || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, objectName: e.target.value }))
                }
              />
            </div>
          </div>

          {/* OKRES OBOWIĄZYWANIA — decyduje, w których MIESIĄCACH umowa się
              liczy. Pola natywne `type="date"`, jak w Historii i w oknie norm. */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="hrc-valid-from"
                {...tip(
                  "Od kiedy umowa obowiązuje. Miesiąc jest najmniejszą jednostką rozliczenia: umowa od 15.09 liczy się we wrześniu w całości.",
                )}
                className="cursor-help"
              >
                Obowiązuje od{supersede ? " *" : ""}
              </Label>
              <Input
                id="hrc-valid-from"
                type="date"
                data-testid="hrc-valid-from"
                value={formData.validFrom || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, validFrom: e.target.value }))
                }
                required={!!supersede}
              />
              <FieldHint>
                Puste = <strong>bezterminowo</strong> (umowa obowiązuje od zawsze).
              </FieldHint>
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="hrc-valid-to"
                {...tip(
                  "Do kiedy umowa obowiązuje. Po tej dacie nie wchodzi do kolejnych miesięcy, a w Wynagrodzeniach pojawi się przypomnienie „umowy do przedłużenia”.",
                )}
                className="cursor-help"
              >
                Obowiązuje do
              </Label>
              <Input
                id="hrc-valid-to"
                type="date"
                data-testid="hrc-valid-to"
                value={formData.validTo || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, validTo: e.target.value }))
                }
                min={formData.validFrom || undefined}
              />
              <FieldHint>
                Puste = <strong>bezterminowo</strong> (do odwołania).
              </FieldHint>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hrc-zwua" {...tip("Wyrejestrowanie — informacyjne")}>
                ZWUA
              </Label>
              <Input
                id="hrc-zwua"
                value={formData.zwua || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, zwua: e.target.value }))
                }
              />
            </div>
            <div className="flex items-end gap-6 pb-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={formData.chor ?? false}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, chor: e.target.checked }))
                  }
                  className="h-4 w-4 accent-primary"
                />
                chor. (ubezp. chorobowe)
              </label>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={formData.active ?? true}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, active: e.target.checked }))
                  }
                  className="h-4 w-4 accent-primary"
                />
                Aktywna
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="hrc-notes">Notatka</Label>
            <Textarea
              id="hrc-notes"
              value={formData.notes || ""}
              onChange={(e) =>
                setFormData((p) => ({ ...p, notes: e.target.value }))
              }
              rows={2}
            />
          </div>
          {contract && (
            <EntityHistory
              variant="section"
              entityType="hr_contract"
              entityId={contract.id}
              title={`${contract.employeeName} — ${contract.company}`}
            />
          )}

          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              type="submit"
              data-testid="hrc-submit"
              disabled={
                loading ||
                !formData.employeeId ||
                !formData.company.trim() ||
                // Zmiana warunków bez daty startu nie miałaby czym zamknąć
                // umowy poprzedniej.
                (!!supersede && !formData.validFrom)
              }
            >
              {loading
                ? "Zapisywanie…"
                : supersede
                  ? "Zapisz zmianę warunków"
                  : contract
                    ? "Zapisz zmiany"
                    : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ==================== DANE PŁACOWE MIESIĄCA ====================

/** Jedna pozycja panelu kontekstu — etykieta u góry, wartość pod nią. */
function ContextItem({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div {...(hint ? tip(hint) : {})} className={hint ? "cursor-help" : undefined}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>
        {value}
      </p>
    </div>
  );
}

export function HrPayrollForm({
  open,
  onClose,
  onSubmit,
  row,
  year,
  month,
  onNavigate,
  hasPrev,
  hasNext,
  position,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrPayrollSaveInput) => Promise<void>;
  row: HrPayrollRow;
  year: number;
  month: number;
  /** Przejście do sąsiedniego wiersza listy (zapis, jeśli coś zmieniono). */
  onNavigate?: (dir: -1 | 1) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  /** „12 z 147" — bez tego nawigacja po liście gubi poczucie, gdzie się jest. */
  position?: { index: number; total: number };
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState({
    mainAmount: numToField(row.inputs.mainAmount),
    bonusRate: numToField(row.inputs.bonusRate),
    rateAdjustment: numToField(row.inputs.rateAdjustment),
    maxHoursOverride: numToField(row.inputs.maxHoursOverride),
    actualHoursOverride: numToField(row.inputs.actualHoursOverride),
    bonusAmountOverride: numToField(row.inputs.bonusAmountOverride),
  });
  const [pending, setPending] = useState(row.inputs.bonusRatePending);
  const [notes, setNotes] = useState(row.inputs.notes);
  /**
   * Podgląd kalkulacji dla WPISYWANYCH wartości — liczy backend (`/hr/payroll/
   * preview`) tą samą funkcją, co przy zapisie. Odwzorowanie wzorów w formularzu
   * rozjechałoby się z kalkulacją przy pierwszej zmianie reguły, a reguł jest tu
   * kilkanaście (maks, ZZA, kanały, premia).
   */
  const [preview, setPreview] = useState<HrPayrollRow | null>(null);
  const previewSeq = useRef(0);

  const set = (k: keyof typeof fields) => (v: string) =>
    setFields((p) => ({ ...p, [k]: v }));

  const payload = (): HrPayrollSaveInput => ({
    contractId: row.contractId,
    year,
    month,
    mainAmount: fieldToNum(fields.mainAmount),
    bonusRate: fieldToNum(fields.bonusRate),
    bonusRatePending: pending,
    rateAdjustment: fieldToNum(fields.rateAdjustment),
    maxHoursOverride: fieldToNum(fields.maxHoursOverride),
    actualHoursOverride: fieldToNum(fields.actualHoursOverride),
    bonusAmountOverride: fieldToNum(fields.bonusAmountOverride),
    notes,
  });

  const dirty =
    fieldToNum(fields.mainAmount) !== row.inputs.mainAmount ||
    fieldToNum(fields.bonusRate) !== row.inputs.bonusRate ||
    fieldToNum(fields.rateAdjustment) !== row.inputs.rateAdjustment ||
    fieldToNum(fields.maxHoursOverride) !== row.inputs.maxHoursOverride ||
    fieldToNum(fields.actualHoursOverride) !== row.inputs.actualHoursOverride ||
    fieldToNum(fields.bonusAmountOverride) !== row.inputs.bonusAmountOverride ||
    pending !== row.inputs.bonusRatePending ||
    notes !== row.inputs.notes;

  // Podgląd po chwili bezruchu (nie po każdej cyfrze) i tylko gdy coś zmieniono
  // — przy otwartym, nieruszonym wierszu liczby z tabeli są już aktualne.
  useEffect(() => {
    // Niepoprawna liczba w polu → żadnego podglądu: `fieldToNum` zwróciłby
    // `null`, czyli policzylibyśmy wypłatę „bez tej kwoty” i pokazali ją jako
    // wynik tego, co ktoś właśnie wpisuje.
    if (!dirty || hasInvalidNums(fields)) {
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    const t = window.setTimeout(() => {
      previewHrPayroll(payload())
        .then((res) => {
          // Odpowiedź starszego żądania nie ma nadpisywać nowszej.
          if (seq === previewSeq.current && res.data) setPreview(res.data);
        })
        .catch(() => {
          // Podgląd jest wygodą, nie zapisem — błąd zostawia stare liczby.
        });
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, pending, notes, dirty]);

  const save = async (): Promise<boolean> => {
    if (hasInvalidNums(fields)) {
      setError(INVALID_NUMS_ERROR);
      return false;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit(payload());
      return true;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Błąd zapisu danych płacowych",
      );
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await save()) onClose();
  };

  /** Zapisz (jeśli trzeba) i przejdź dalej — zapis nieudany zostawia okno. */
  const go = async (dir: -1 | 1) => {
    if (dirty && !(await save())) return;
    onNavigate?.(dir);
  };

  const shown = preview ?? row;
  const maxSourceHint =
    row.maxHoursSource === "override"
      ? "Nadpisane ręcznie w tym oknie"
      : row.maxHoursSource === "individual"
        ? "Indywidualne GODZINY MAKS z wpisów godzin"
        : "Norma miesiąca z zakładki Normy";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {row.employeeName} — {row.company} (
            {row.contractType === "praca" ? "Praca" : "Zlecenie"})
            {position && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {position.index + 1} z {position.total}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Kontekst wiersza: liczby, z których bierze się kwota do wpisania.
            Bez nich trzeba było zamknąć okno, spojrzeć w tabelę i otworzyć
            je z powrotem. */}
        <div className="grid grid-cols-3 gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4">
          <ContextItem
            label="Fakt godz."
            value={hrs(row.faktGodziny)}
            hint="Godziny do rozliczenia — dzielnik stawki netto"
            strong
          />
          <ContextItem
            label="Maks godz."
            value={`${hrs(row.maksGodziny)}${row.maxHoursSource !== "norm" ? "*" : ""}`}
            hint={maxSourceHint}
          />
          <ContextItem
            label="Godz. dodatku"
            value={row.godzinyDodatek ? hrs(row.godzinyDodatek) : "—"}
            hint="Nadwyżka ponad maks — liczona tylko przy ustawionym dodatku"
          />
          <ContextItem
            label="Rej."
            value={(row.registration ?? "—").toUpperCase()}
            hint="ZUA = umowa główna, ZZA = nadwyżka ponad normę umowy głównej"
          />
          <ContextItem
            label="Stawka netto"
            value={shown.stawkaNetto != null ? `${hrs(shown.stawkaNetto)} zł/h` : "—"}
            hint="Kwota główna netto ÷ faktyczne godziny"
            strong
          />
          <ContextItem label="Przelew" value={money(shown.przelew)} />
          <ContextItem label="Gotówka" value={money(shown.gotowka)} />
          <ContextItem label="Wypłata" value={money(shown.wyplata)} strong />
        </div>
        {preview && (
          <p className="-mt-2 text-xs text-emerald-700">
            Podgląd po zapisaniu: stawka{" "}
            {preview.stawkaNetto != null ? `${hrs(preview.stawkaNetto)} zł/h` : "—"}{" "}
            · wypłata {money(preview.wyplata)}
            {preview.bonusPending && " · dodatek czeka na stawkę"}
          </p>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-4"
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter: zapisz i od razu następna umowa — kwoty wpisuje
            // się seriami, więc ręka nie musi wracać do myszy.
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void go(1);
            }
          }}
        >
          <div className="grid grid-cols-3 gap-4">
            <NumField
              id="hrp-main"
              label="Kwota główna netto (zł)"
              value={fields.mainAmount}
              onChange={set("mainAmount")}
              hint="Kwota wypłaty głównej NETTO (na rękę) od księgowości — z niej liczy się stawka netto (kwota ÷ faktyczne godziny). Kadry nie operują kwotami brutto."
            />
            <NumField
              id="hrp-rate"
              label="Stawka dodatku netto (zł/h)"
              value={fields.bonusRate}
              onChange={set("bonusRate")}
              hint="Stawka netto za godziny dodatku; pusta → używana stawka netto z wypłaty głównej"
            />
            <NumField
              id="hrp-adj"
              label="Wyrównanie stawki (zł/h)"
              value={fields.rateAdjustment}
              onChange={set("rateAdjustment")}
              hint="Dopłata do stawki: kwota wyrównania = wyrównanie × fakt godziny"
            />
          </div>

          <label
            className="flex items-center gap-2 text-sm font-medium"
            {...tip("Zaznacz, gdy stawka dodatku czeka na przeliczenie — wiersz będzie oznaczony, dodatek nie wejdzie do wypłaty")}
          >
            <input
              type="checkbox"
              checked={pending}
              onChange={(e) => setPending(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Dodatek do przeliczenia
          </label>

          <div className="rounded-md border border-dashed p-3">
            <p
              className="mb-3 text-xs text-muted-foreground"
              {...tip("Wypełnij tylko wyjątkowo — puste pola liczą się automatycznie z godzin i norm")}
            >
              Ręczne nadpisania (puste = liczone automatycznie)
            </p>
            <div className="grid grid-cols-3 gap-4">
              <NumField
                id="hrp-max"
                label="Maks godziny"
                value={fields.maxHoursOverride}
                onChange={set("maxHoursOverride")}
                hint="Nadpisuje limit: normę miesiąca lub indywidualny GODZINY MAKS z wpisów godzin"
              />
              <NumField
                id="hrp-fakt"
                label="Fakt godziny"
                value={fields.actualHoursOverride}
                onChange={set("actualHoursOverride")}
                hint="Nadpisuje godziny do rozliczenia liczone z wpisów godzin"
              />
              <NumField
                id="hrp-bonus"
                label="Kwota dodatku (zł)"
                value={fields.bonusAmountOverride}
                onChange={set("bonusAmountOverride")}
                hint="Nadpisuje kwotę dodatku (godziny dodatku × stawka)"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="hrp-notes">Notatka</Label>
            <Textarea
              id="hrp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
          {/* Wypłaty: encją jest UMOWA, a wpisy są per miesiąc — stąd `period`. */}
          <EntityHistory
            variant="section"
            entityType="hr_payroll"
            entityId={row.contractId}
            period={ymKey(year, month)}
            title={row.employeeName}
          />

          <FormError message={error} />
          {/* Kwoty od księgowości przychodzą listą po kolei, więc okno musi
              umieć przejść do następnej umowy bez zamykania i szukania
              wiersza w tabeli. Ctrl+Enter = zapisz i dalej. */}
          <DialogFooter className="sm:justify-between">
            {onNavigate ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading || !hasPrev}
                  onClick={() => void go(-1)}
                  data-testid="kadry-wynagrodzenia-dialog-prev"
                >
                  ← Poprzedni
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading || !hasNext}
                  onClick={() => void go(1)}
                  data-testid="kadry-wynagrodzenia-dialog-next"
                >
                  Następny →
                </Button>
              </div>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Anuluj
              </Button>
              <Button
                type="submit"
                disabled={loading}
                {...tip("Ctrl+Enter — zapisz i przejdź do następnej umowy")}
              >
                {loading ? "Zapisywanie…" : "Zapisz"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ==================== BIURO ====================

export function HrOfficeForm({
  open,
  onClose,
  onSubmit,
  row,
  employees,
  companies,
  defaultEmployeeId,
  year,
  month,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrOfficeInput) => Promise<void>;
  row?: HrOfficeRow | null;
  employees: HrEmployee[];
  /** Słownik spółek — biuro trzyma tam też formy zatrudnienia (ALFA ETAT / ALFA UZ). */
  companies: Company[];
  defaultEmployeeId?: number;
  year: number;
  month: number;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState(
    row ? String(row.employeeId) : defaultEmployeeId ? String(defaultEmployeeId) : "",
  );
  const [company, setCompany] = useState(row?.company || "");
  const [fields, setFields] = useState({
    etatHours: numToField(row?.etatHours),
    uwL4: numToField(row?.uwL4),
    deductions: numToField(row?.deductions),
    bonuses: numToField(row?.bonuses),
    hoursForAccounting: numToField(row?.hoursForAccounting),
    rate: numToField(row?.rate),
    amount: numToField(row?.amount),
    rorBase: numToField(row?.rorBase),
    cashOverride: numToField(row?.cashOverride),
  });
  const [notes, setNotes] = useState(row?.notes || "");

  const set = (k: keyof typeof fields) => (v: string) =>
    setFields((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasInvalidNums(fields)) {
      setError(INVALID_NUMS_ERROR);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit({
        employeeId,
        // Optymistyczna kontrola współbieżności: zapis przejdzie tylko, gdy
        // wiersz nie zmienił się od wczytania (backend odbija 409). Rezerwacja
        // listy jest per UŻYTKOWNIK, więc bez tego dwie karty TEJ SAMEJ osoby
        // dalej gubiły zmianę — w godzinach ten znacznik był od początku.
        expectedUpdatedAt: row?.updatedAt,
        year: row?.year ?? year,
        month: row?.month ?? month,
        company,
        etatHours: fieldToNum(fields.etatHours),
        uwL4: fieldToNum(fields.uwL4),
        deductions: fieldToNum(fields.deductions),
        bonuses: fieldToNum(fields.bonuses),
        hoursForAccounting: fieldToNum(fields.hoursForAccounting),
        rate: fieldToNum(fields.rate),
        amount: fieldToNum(fields.amount),
        rorBase: fieldToNum(fields.rorBase),
        cashOverride: fieldToNum(fields.cashOverride),
        notes,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu wpisu biura");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {row ? "Edytuj wpis biura" : "Nowy wpis biura"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hro-emp">Pracownik *</Label>
              <EmployeePicker
                id="hro-emp"
                employees={employees}
                value={employeeId}
                onChange={setEmployeeId}
                required
              />
            </div>
            <div className="space-y-2">
              {/* Biuro rozlicza się na spółce razem z formą zatrudnienia
                  ("ALFA ETAT", "ALFA UZ") — te warianty są pozycjami słownika
                  spółek, więc pole jest zwykłym wyborem z listy. */}
              <Label
                htmlFor="hro-company"
                {...tip("Spółka / forma zatrudnienia ze słownika (zakładka Spółki)")}
                className="cursor-help"
              >
                Spółka / forma
              </Label>
              <select
                id="hro-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className={SELECT_CLS}
              >
                <option value="">— wybierz —</option>
                {companyOptions(companies, row?.company).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <NumField
              id="hro-etat"
              label="Etat (h)"
              value={fields.etatHours}
              onChange={set("etatHours")}
              hint="Nominalne godziny etatu w miesiącu"
            />
            <NumField
              id="hro-uwl4"
              label="UW / L4 (h)"
              value={fields.uwL4}
              onChange={set("uwL4")}
            />
            <NumField
              id="hro-hours"
              label="Godziny do księgowej"
              value={fields.hoursForAccounting}
              onChange={set("hoursForAccounting")}
              hint="Dla rozliczanych godzinowo (UZ): kwota = godziny × stawka"
            />
            <NumField
              id="hro-rate"
              label="Stawka netto (zł/h)"
              value={fields.rate}
              onChange={set("rate")}
              hint="Stawka godzinowa NETTO — używana z godzinami do księgowej"
            />
            <NumField
              id="hro-ded"
              label="Potrącenia (zł)"
              value={fields.deductions}
              onChange={set("deductions")}
            />
            <NumField
              id="hro-bon"
              label="Dodatki netto (zł)"
              value={fields.bonuses}
              onChange={set("bonuses")}
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <NumField
              id="hro-amount"
              label="Kwota netto (zł)"
              value={fields.amount}
              onChange={set("amount")}
              hint="Pełna kwota wypłaty NETTO; pusta → liczona jako godziny do księgowej × stawka netto"
            />
            <NumField
              id="hro-ror"
              label="Podstawa ROR netto (zł)"
              value={fields.rorBase}
              onChange={set("rorBase")}
              hint="Część kwoty netto idąca przelewem na rachunek (podaje księgowość)"
            />
            <NumField
              id="hro-cash"
              label="Delegacje / gotówka netto (zł)"
              value={fields.cashOverride}
              onChange={set("cashOverride")}
              hint="Pusta → liczona jako kwota netto − podstawa ROR (gdy dodatnia)"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hro-notes">Notatka</Label>
            <Textarea
              id="hro-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
          {row && (
            <EntityHistory
              variant="section"
              entityType="hr_office"
              entityId={row.id}
              period={ymKey(row.year, row.month)}
              title={`${row.employeeName} — ${row.company}`}
            />
          )}

          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading || !employeeId}>
              {loading ? "Zapisywanie…" : row ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
