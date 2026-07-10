// Formularze dialogowe modułu Kadry: pracownik, wpis godzin, umowa,
// dane płacowe miesiąca (kwoty od księgowości + nadpisania) i biuro.
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import type {
  HrBonusType,
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

const SELECT_CLS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

// pole liczbowe: puste = brak wartości (null), przecinek dozwolony
type NumVal = number | string | null | undefined;
const numToField = (v: NumVal) => (v == null ? "" : String(v));
const fieldToNum = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

function NumField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} title={hint} className={hint ? "cursor-help" : ""}>
        {label}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
    </div>
  );
}

// ==================== PRACOWNIK ====================

export function HrEmployeeForm({
  open,
  onClose,
  onSubmit,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrEmployeeInput) => Promise<void>;
  employee?: HrEmployee | null;
}) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<HrEmployeeInput>({
    fullName: employee?.fullName || "",
    code: employee?.code || "",
    notes: employee?.notes || "",
    active: employee?.active ?? true,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu pracownika");
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
  year,
  month,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrHoursInput) => Promise<void>;
  entry?: HrHoursEntry | null;
  employees: HrEmployee[];
  objects: HrObject[];
  year: number;
  month: number;
}) {
  const [loading, setLoading] = useState(false);
  const [employeeId, setEmployeeId] = useState(
    entry ? String(entry.employeeId) : "",
  );
  const [objectId, setObjectId] = useState(
    entry?.objectId ? String(entry.objectId) : "",
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit({
        employeeId,
        objectId: objectId || null,
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
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu godzin");
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
              <select
                id="hrh-emp"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className={SELECT_CLS}
                required
              >
                <option value="">— wybierz —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="hrh-obj">Obiekt</Label>
              <select
                id="hrh-obj"
                value={objectId}
                onChange={(e) => setObjectId(e.target.value)}
                className={SELECT_CLS}
              >
                <option value="">—</option>
                {objects.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <NumField
              id="hrh-worked"
              label="Wypracowane"
              value={fields.workedHours}
              onChange={set("workedHours")}
              hint="Godziny wypracowane na obiekcie w miesiącu"
            />
            <NumField
              id="hrh-night"
              label="Nocne"
              value={fields.nightHours}
              onChange={set("nightHours")}
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
              hint="Urlop wypoczynkowy (godziny) — wlicza się do godzin rozliczanych"
            />
            <NumField
              id="hrh-l4"
              label="L4"
              value={fields.l4Hours}
              onChange={set("l4Hours")}
              hint="Chorobowe (godziny) — wlicza się do godzin przy umowie o pracę"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <NumField
              id="hrh-ded"
              label="Potrącenia (zł)"
              value={fields.deductions}
              onChange={set("deductions")}
              hint="Kwota potrąceń — pomniejsza premię/potrącenie w wynagrodzeniu"
            />
            <NumField
              id="hrh-bon"
              label="Dodatki / premie (zł)"
              value={fields.bonuses}
              onChange={set("bonuses")}
              hint="Kwota premii — powiększa premię/potrącenie w wynagrodzeniu"
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
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrContractInput) => Promise<void>;
  contract?: HrContract | null;
  employees: HrEmployee[];
  companies: string[];
}) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<HrContractInput>({
    employeeId: contract ? String(contract.employeeId) : "",
    company: contract?.company || "",
    contractType: contract?.contractType || "zlecenie",
    chor: contract?.chor ?? false,
    zua: contract?.zua || "",
    zza: contract?.zza || "",
    zwua: contract?.zwua || "",
    objectName: contract?.objectName || "",
    mainChannel: contract?.mainChannel || "przelew",
    bonusType: contract?.bonusType || "brak",
    active: contract?.active ?? true,
    notes: contract?.notes || "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu umowy");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{contract ? "Edytuj umowę" : "Nowa umowa"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hrc-emp">Pracownik *</Label>
              <select
                id="hrc-emp"
                value={String(formData.employeeId)}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, employeeId: e.target.value }))
                }
                className={SELECT_CLS}
                required
              >
                <option value="">— wybierz —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="hrc-company">Spółka *</Label>
              <Input
                id="hrc-company"
                value={formData.company}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, company: e.target.value }))
                }
                list="hrc-companies"
                placeholder="np. ALFA"
                required
              />
              <datalist id="hrc-companies">
                {companies.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="hrc-type"
                title="Praca: godziny + UW + L4, norma UoP; Zlecenie: godziny + UW, norma zlecenia"
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
                title="Zgłoszenie ZUA (umowa główna) — wpisz 'tak' lub datę; niepuste włącza rozliczanie godzin do maks"
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
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="hrc-zza"
                title="Zgłoszenie ZZA (druga spółka) — wiersz dostaje nadwyżkę godzin ponad normę umowy głównej"
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
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="hrc-main"
                title="Kanał wypłaty głównej (kwoty NETTO od księgowości)"
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
                title="Rodzaj dodatku decyduje o liczeniu godzin nadwyżki i kanale ich wypłaty; 'brak' = premie idą kanałem wypłaty głównej"
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

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hrc-zwua" title="Wyrejestrowanie — informacyjne">
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

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              type="submit"
              disabled={
                loading || !formData.employeeId || !formData.company.trim()
              }
            >
              {loading ? "Zapisywanie…" : contract ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ==================== DANE PŁACOWE MIESIĄCA ====================

export function HrPayrollForm({
  open,
  onClose,
  onSubmit,
  row,
  year,
  month,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrPayrollSaveInput) => Promise<void>;
  row: HrPayrollRow;
  year: number;
  month: number;
}) {
  const [loading, setLoading] = useState(false);
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

  const set = (k: keyof typeof fields) => (v: string) =>
    setFields((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit({
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
      onClose();
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Błąd zapisu danych płacowych",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {row.employeeName} — {row.company} (
            {row.contractType === "praca" ? "Praca" : "Zlecenie"})
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <NumField
              id="hrp-main"
              label="Kwota główna NETTO (zł)"
              value={fields.mainAmount}
              onChange={set("mainAmount")}
              hint="Kwota wypłaty głównej od księgowości — z niej liczona jest stawka netto (kwota ÷ fakt godziny)"
            />
            <NumField
              id="hrp-rate"
              label="Stawka dodatku (zł/h)"
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
            title="Zaznacz, gdy stawka dodatku czeka na przeliczenie — wiersz będzie oznaczony, dodatek nie wejdzie do wypłaty"
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
              title="Wypełnij tylko wyjątkowo — puste pola liczą się automatycznie z godzin i norm"
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

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Zapisywanie…" : "Zapisz"}
            </Button>
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
  year,
  month,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: HrOfficeInput) => Promise<void>;
  row?: HrOfficeRow | null;
  employees: HrEmployee[];
  year: number;
  month: number;
}) {
  const [loading, setLoading] = useState(false);
  const [employeeId, setEmployeeId] = useState(
    row ? String(row.employeeId) : "",
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
    setLoading(true);
    try {
      await onSubmit({
        employeeId,
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
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu wpisu biura");
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
              <select
                id="hro-emp"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className={SELECT_CLS}
                required
              >
                <option value="">— wybierz —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="hro-company">Spółka / forma</Label>
              <Input
                id="hro-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="np. ALFA ETAT / ALFA UZ"
                list="hro-companies"
              />
              <datalist id="hro-companies">
                <option value="ALFA ETAT" />
                <option value="ALFA UZ" />
                <option value="ALFA S" />
                <option value="CONTROL ETAT" />
              </datalist>
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
              label="Stawka (zł/h)"
              value={fields.rate}
              onChange={set("rate")}
              hint="Stawka godzinowa — używana z godzinami do księgowej"
            />
            <NumField
              id="hro-ded"
              label="Potrącenia (zł)"
              value={fields.deductions}
              onChange={set("deductions")}
            />
            <NumField
              id="hro-bon"
              label="Dodatki (zł)"
              value={fields.bonuses}
              onChange={set("bonuses")}
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <NumField
              id="hro-amount"
              label="Kwota (zł)"
              value={fields.amount}
              onChange={set("amount")}
              hint="Pełna kwota wypłaty; pusta → liczona jako godziny do księgowej × stawka"
            />
            <NumField
              id="hro-ror"
              label="Podstawa ROR (zł)"
              value={fields.rorBase}
              onChange={set("rorBase")}
              hint="Część wypłaty na przelew (podaje księgowość)"
            />
            <NumField
              id="hro-cash"
              label="Delegacje / gotówka (zł)"
              value={fields.cashOverride}
              onChange={set("cashOverride")}
              hint="Pusta → liczona jako kwota − podstawa ROR (gdy dodatnia)"
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
