// Podzakładka Kadry → Wynagrodzenia: wypłaty ochrony + rozliczenie biura.
//
// To jest ekran WPISYWANIA, nie raport: raz w miesiącu trzeba wklepać ~147
// kwot głównych od księgowości (po jednej na umowę) i ~14 wierszy biura.
// Dialog na każdy wiersz był tu wąskim gardłem — klik, modal, zapis,
// zamknięcie, i tak 147 razy. Dlatego tabela ma dwa tryby, jak Godziny:
//   • Podgląd — czytelna tabela, wiersz otwiera dialog (dawne zachowanie),
//   • Edycja — kwoty są polami; zapis po wyjściu z pola, Enter przeskakuje
//     na tę samą kolumnę w kolejnym wierszu, Esc cofa.
//
// PUT /hr/payroll oddaje PRZELICZONY wiersz, więc po wpisaniu kwoty stawka
// netto, dodatek i wypłata pojawiają się w tym samym wierszu bez ciągnięcia
// całego miesiąca; kafle podsumowania dociągamy raz na serię zmian (rodzic).
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  ArrowLeftRight,
  ArrowRight,
  Banknote,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Eye,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  PencilLine,
  Plus,
  ClipboardPaste,
  Printer,
  Search,
  Trash2,
  Users,
  Wallet,
  FilterX,
  type LucideIcon,
} from "lucide-react";
import { EntityHistory } from "./EntityHistory";
// Rezerwacja listy do edycji: pasek właściciela + pigułka „kto edytuje”.
import { EditLockBar, LockHolderPill } from "./EditLockBar";
import { lockUntil, type HrLockDto } from "@/lib/hrLive";
import type { HrEditLock } from "./useEditLock";
import {
  carryOverHrOffice,
  saveHrPayroll,
  updateHrOffice,
  type HrHoursEntry,
  type HrMonthChecklist,
  type HrOfficeInput,
  type HrOfficeRow,
  type HrPayrollRow,
  type HrPayrollSaveInput,
  type HrPrevPayrollRow,
  type HrPrevSummary,
  type Company,
} from "@/lib/api";
import { PayrollChangesSection } from "./monthCompare";
import { monthYearLabel } from "@/lib/plDates";
import { printHrStatement, joinFilters } from "@/lib/hrPrint";
import {
  EmptyRow,
  IconButton,
  KadryBadge,
  RowActions,
  SegmentedControl,
  TEXT_TONE,
  TFOOT_ROW_CLS,
  ToneLegend,
  TOOLBAR_BTN_CLS,
} from "./ui";
import { tip } from "@/components/ui/tooltip";
import {
  printHrCashList,
  printHrTransferList,
  downloadHrTransferCsv,
  hrCashCount,
  hrTransferCount,
  HR_CASH_EMPTY,
  HR_TRANSFER_EMPTY,
} from "@/lib/hrPrintCash";
import { PasteAmountsDialog } from "./PasteAmountsDialog";
import { SortTh, Th, MoreFiltersButton, type SortDir } from "./parts";
import {
  cmpMoney,
  cmpNum,
  cmpText,
  fieldToNum,
  hrs,
  isNumFieldValid,
  money,
  numToField,
  parseAmount,
  MONTH_NAMES,
  NUM_FIELD_ERROR,
} from "./shared";

const EDIT_MODE_KEY = "kadry:wynagrodzenia:tryb-edycji";
/**
 * Tryb edycji listy „Stałe" (biuro) trzyma się OSOBNO od listy „Godzinowe":
 * to dwa różne rozliczenia, robione w różnych momentach miesiąca, i — od
 * czasu rezerwacji list — dwa osobne zakresy blokady (`payroll` / `office`).
 */
const OFFICE_EDIT_MODE_KEY = "kadry:wynagrodzenia:tryb-edycji-biuro";

/**
 * Wybrana podzakładka Wynagrodzeń.
 *
 * Wcześniej biuro wisiało jako druga tabela POD tabelą wypłat: żeby je
 * zobaczyć, trzeba było przewinąć 147 wierszy, a przyciski „Dodaj wpis biura"
 * i „Wklej z arkusza" stały w dwóch różnych paskach tego samego ekranu.
 * „Godzinowe" (ochrona, rozliczana z godzin) i „Stałe" (biuro, kwota z etatu)
 * to dwie listy tego samego miesiąca — dzielą miesiąc, kafle, szukajkę,
 * spółkę i wydruki, a mają własny tryb edycji, filtry i stopkę.
 */
type PayrollList = "godzinowe" | "stale";

/**
 * Układ listy „Godzinowe": wiersz = UMOWA czy wiersz = OSOBA.
 *
 * W bazie jednostką rozliczenia jest umowa i tak wygląda tabela — ale człowiek
 * z ZUA w jednej spółce i ZZA w drugiej widnieje wtedy dwa razy, a ile
 * naprawdę dostanie do ręki, trzeba dodać w głowie (i dodaje się przy każdym
 * pytaniu „ile wyszło Kowalskiemu"). Widok „Osoby" sumuje umowy jednej osoby
 * w jeden wiersz, a umowy chowa pod strzałką — te same liczby, ta sama stopka,
 * inna jednostka czytania. Wpisywanie kwot zostaje w wierszach umów, bo tam
 * jest ich miejsce w bazie.
 */
type PayrollView = "umowy" | "osoby";
const VIEW_KEY = "kadry:wynagrodzenia:widok";
const isPayrollView = (v: string | null): v is PayrollView =>
  v === "umowy" || v === "osoby";

/** Pracownik z policzonymi sumami swoich umów — wiersz nadrzędny widoku „Osoby". */
type PayrollPersonGroup = {
  employeeId: number;
  employeeName: string;
  rows: HrPayrollRow[];
  maksGodziny: number;
  faktGodziny: number;
  /** `null` = żadna z umow nie ma jeszcze kwoty od księgowości. */
  kwotaGlowna: number | null;
  dodatekFinalny: number;
  przelew: number;
  gotowka: number;
  wyplata: number;
  bonusPending: boolean;
  warnings: string[];
  byCompany: { company: string; wyplata: number }[];
};

/**
 * Jeden wiersz do wyrenderowania w tabeli „Godzinowe”. W widoku umów są to
 * same umowy, w widoku osób — wiersz osoby i (po rozwinięciu) jej umowy.
 *
 * `cellIndex` numeruje WYŁĄCZNIE wiersze umów, bo to po nich chodzi Enter
 * w trybie edycji (`data-cell="idx:pole"`); gdyby liczył też wiersze osób,
 * Enter wpadałby w numery, pod którymi nie ma żadnego pola.
 */
type PayrollRenderItem =
  | { kind: "person"; group: PayrollPersonGroup }
  | {
      kind: "contract";
      row: HrPayrollRow;
      cellIndex: number;
      grouped: boolean;
      nested: boolean;
    };

const LIST_KEY = "kadry:wynagrodzenia:lista";
const LIST_PARAM = "lista";
const isPayrollList = (v: string | null): v is PayrollList =>
  v === "godzinowe" || v === "stale";

/*
 * Ikony akcji wiersza (ołówek, historia, kosz) wchodzą pod kursorem — przy 147
 * wierszach stale widoczna kolumna ikon przykuwała wzrok mocniej niż kwoty,
 * o które w tej tabeli chodzi. Regułę trzyma wspólne `RowActions`
 * (`kadry/ui.tsx`): razem z dostępem z klawiatury i widocznością na dotyku.
 */

/**
 * Polska liczba mnoga: „1 osoba", „2 osoby", „5 osób", „22 osoby".
 *
 * Liczniki w tym ekranie zmieniają się przy każdym filtrze, więc „1 osób"
 * pojawiłoby się przy pierwszym zawężeniu szukajką do jednego nazwiska.
 */
const plForm = (n: number, one: string, few: string, many: string) => {
  const last = n % 10;
  const twoLast = n % 100;
  if (n === 1) return one;
  if (last >= 2 && last <= 4 && (twoLast < 12 || twoLast > 14)) return few;
  return many;
};
const peopleLabel = (n: number) => `${n} ${plForm(n, "osoba", "osoby", "osób")}`;
const contractsLabel = (n: number) =>
  `${n} ${plForm(n, "umowa", "umowy", "umów")}`;

/** Rok i miesiąc → „2026-09” (klucz okresu wpisu w dzienniku zmian Kadr). */
const ymKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** Skąd wzięłyby się godziny maks, gdyby nikt ich nie nadpisał — do dymka. */
const MAX_SOURCE_LABEL: Record<"individual" | "norm", string> = {
  individual: "indywidualne godziny maks z wpisów godzin",
  norm: "norma miesiąca",
};

/** Która gałąź policzyłaby godziny faktyczne — do dymka przy nadpisaniu. */
const FAKT_BASIS_LABEL: Record<"zua" | "zza" | "none", string> = {
  zua: "godziny wypracowane, capowane do maks",
  zza: "nadwyżka ponad normę umowy głównej",
  none: "brak ZUA/ZZA — godziny nierozliczane",
};

const BONUS_SHORT: Record<string, string> = {
  brak: "—",
  gotowka: "Gotówka",
  delegacja_przelew: "Deleg. przelew",
  delegacja_gotowka: "Deleg. gotówka",
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

/**
 * Tryb „Braki”. `braki` odpowiada dokładnie liczbie z kafla (`summary.gaps`),
 * a dwa kolejne tryby rozbijają go na składniki z podpisu kafla — dzięki temu
 * z liczby na kaflu da się dojść do konkretnych wierszy.
 */
export type PayrollGapMode = "all" | "braki" | "missing" | "pending" | "warnings";

/**
 * Wiersz bez kwoty od księgowości — ten sam warunek, którym backend liczy
 * `summary.missingMain` (`src/routes/hr.ts`).
 */
const payrollMissingMain = (r: HrPayrollRow) =>
  r.faktGodziny != null && r.faktGodziny > 0 && r.kwotaGlowna == null;

/** Pola wypłaty edytowalne wprost w tabeli — kolejność zgodna z kolumnami. */
type PayrollField =
  | "mainAmount"
  | "bonusRate"
  | "rateAdjustment"
  | "bonusAmountOverride";

/** Pola biura edytowalne wprost w tabeli. */
type OfficeField =
  | "hoursForAccounting"
  | "rate"
  | "amount"
  | "rorBase"
  | "cashOverride";

const payrollCellValue = (r: HrPayrollRow, field: PayrollField) =>
  numToField(r.inputs[field]);

const officeCellValue = (r: HrOfficeRow, field: OfficeField) =>
  numToField(r[field]);

/** Wiersz godzin ma cokolwiek wpisane — ta sama reguła co w zakładce Godziny. */
const hoursFilled = (r: HrHoursEntry) =>
  (r.workedHours ?? 0) > 0 || (r.uwHours ?? 0) > 0 || (r.l4Hours ?? 0) > 0;

export function PayrollTab({
  rows,
  office,
  hours,
  editable,
  lock,
  officeLock,
  portalOfEmployee,
  loading,
  monthNav,
  year,
  month,
  gapsRequest,
  prevAmounts,
  prevPayroll,
  prevSummary,
  companies,
  checklist,
  onRowSaved,
  onOfficeRowSaved,
  onOpenPayrollDialog,
  onOfficeAdd,
  onOfficeEdit,
  onOfficeDelete,
  onOfficeCarriedOver,
  onGoToHours,
}: {
  rows: HrPayrollRow[];
  office: HrOfficeRow[];
  /** Wpisy godzin miesiąca — tylko do paska postępu i stanu pustego. */
  hours: HrHoursEntry[];
  editable: boolean;
  /**
   * Rezerwacje list do edycji (`useEditLock` w Kadry.tsx). DWIE, bo ekran
   * pokazuje dwie listy: wypłaty ochrony („Godzinowe") i rozliczenie biura
   * („Stałe"). Wypełnia je zwykle kto inny, więc jedna wspólna blokada kazałaby
   * księgowej czekać na kogoś, kto poprawia zupełnie inną tabelę.
   *
   * Bez rezerwacji backend odrzuca zapis (423), więc tryb edycji każdej listy
   * wymaga `mine` — pola bez tego byłyby obietnicą bez pokrycia.
   */
  lock: HrEditLock;
  officeLock: HrEditLock;
  /**
   * Pracownik → portal jego działu. Wypłata i wpis biura należą do sekcji
   * pracownika, więc gdy tę sekcję rezerwuje ktoś inny, wiersz jest wygaszony
   * (backend i tak odmówiłby zapisu 423). Wiersze osób bez działu należą
   * wyłącznie do pełnych Kadr.
   */
  portalOfEmployee?: (employeeId: number | null | undefined) => string | null;
  loading: boolean;
  monthNav: React.ReactNode;
  year: number;
  month: number;
  /** Żądanie z kafla „Braki" — ustawia filtr braków (nonce wymusza powtórki). */
  gapsRequest?: { mode: PayrollGapMode; nonce: number } | null;
  /** Kwoty główne poprzedniego miesiąca (umowa → kwota) — punkt odniesienia. */
  prevAmounts?: Map<number, number>;
  /**
   * Wypłaty poprzedniego miesiąca per umowa i jego sumy — sekcja „Największe
   * zmiany". Poprzedni znaczy BEZPOŚREDNIO poprzedni, także gdy jest pusty:
   * przeskok nad pustym lipcem robiłby z porównania sierpień–czerwiec coś, co
   * wygląda jak różnica miesiąc do miesiąca.
   */
  prevPayroll?: HrPrevPayrollRow[];
  prevSummary?: HrPrevSummary | null;
  /**
   * Słownik spółek — wydruki biorą stąd dane wystawcy (NIP, adres) zamiast
   * trzymać je na sztywno w szablonie.
   */
  companies?: Company[];
  /**
   * Lista kontrolna miesiąca z backendu (`/hr/summary`, `/hr/month-status`) —
   * te same liczby, na których stoi „Zamknij miesiąc". Pasek postępu liczył je
   * wcześniej u siebie z `rows`/`hours` i po każdej zmianie reguł rozjeżdżał
   * się z paskiem stanu miesiąca stojącym dwa centymetry wyżej.
   */
  checklist?: HrMonthChecklist;
  onRowSaved: (row: HrPayrollRow) => void;
  onOfficeRowSaved: (row: HrOfficeRow) => void;
  /** Otwarcie dialogu wypłaty — rodzic trzyma formularz i listę do nawigacji. */
  onOpenPayrollDialog: (row: HrPayrollRow, visible: HrPayrollRow[]) => void;
  onOfficeAdd: () => void;
  onOfficeEdit: (row: HrOfficeRow) => void;
  onOfficeDelete: (row: HrOfficeRow) => void;
  onOfficeCarriedOver: () => void;
  onGoToHours: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [company, setCompany] = useState<string>("all");
  const [contractType, setContractType] = useState<"all" | "praca" | "zlecenie">(
    "all",
  );
  const [registration, setRegistration] = useState<
    "all" | "zua" | "zza" | "none"
  >("all");
  const [bonusType, setBonusType] = useState<string>("all");
  const [mainChannel, setMainChannel] = useState<"all" | "przelew" | "gotowka">(
    "all",
  );
  const [maxSource, setMaxSource] = useState<
    "all" | "override" | "individual" | "norm"
  >("all");
  const [gaps, setGaps] = useState<PayrollGapMode>("all");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [sort, setSort] = useState<PayrollSortKey>("employeeName");
  const [dir, setDir] = useState<SortDir>("asc");
  const [officeSort, setOfficeSort] = useState<OfficeSortKey>("employeeName");
  const [officeDir, setOfficeDir] = useState<SortDir>("asc");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  /** Okno wklejania kwot z arkusza księgowości. */
  const [pasteOpen, setPasteOpen] = useState(false);
  /** Podsumowanie ostatniej wklejki — znika przy kolejnej zmianie miesiąca. */
  const [pasteInfo, setPasteInfo] = useState<string | null>(null);
  /** Powód, dla którego wydruk się nie otworzył (pusta lista) — pod paskiem. */
  const [printInfo, setPrintInfo] = useState<string | null>(null);
  /** Miesiąc bez godzin: tabela 147 zerowych wierszy chowa się za przyciskiem. */
  const [showEmptyTable, setShowEmptyTable] = useState(false);
  const [carrying, setCarrying] = useState(false);
  const [barError, setBarError] = useState<string | null>(null);
  /**
   * Widok listy „Godzinowe": umowy (domyślnie, tak jak w bazie) albo osoby.
   * Trzymany w localStorage, nie w adresie — to preferencja czytania, a nie
   * to, co się komuś wysyła linkiem (od tego jest miesiąc i lista).
   */
  const [view, setViewPref] = useState<PayrollView>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      return isPayrollView(saved) ? saved : "umowy";
    } catch {
      return "umowy";
    }
  });
  const setView = (next: PayrollView) => {
    setViewPref(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // tryb prywatny — preferencja tylko na sesję
    }
  };
  /** Rozwinięci pracownicy w widoku „Osoby" (po `employeeId`). */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (employeeId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  /** Sekcja „Największe zmiany" — domyślnie zwinięta. */
  const [changesOpen, setChangesOpen] = useState(false);

  // Kafel „Braki" ustawia filtr i przewija na tabelę. Braki dotyczą wyłącznie
  // wypłat ochrony, więc kafel przy okazji wraca na listę „Godzinowe" — inaczej
  // filtr ustawiłby się na liście, której akurat nie widać.
  useEffect(() => {
    if (!gapsRequest) return;
    setGaps(gapsRequest.mode);
    setShowEmptyTable(true);
    setList("godzinowe");
    // `setList` jest stabilne w obrębie renderu — zależność trzymamy na żądaniu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapsRequest]);

  const [editModePref, setEditModePref] = useState(() => {
    try {
      return localStorage.getItem(EDIT_MODE_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Tryb edycji = preferencja ORAZ rezerwacja listy. Bez `lock.mine` pola
  // byłyby otwarte, a każdy zapis wracał z 423 „listę edytuje ktoś inny”.
  const editMode = editable && editModePref && lock.mine;
  const rememberEditMode = (on: boolean) => {
    setEditModePref(on);
    try {
      localStorage.setItem(EDIT_MODE_KEY, on ? "1" : "0");
    } catch {
      // tryb prywatny / zablokowane dane witryny — preferencja tylko na sesję
    }
  };
  /**
   * Przełącznik trybu: „Edycja” najpierw REZERWUJE listę na 15 minut. Odmowa
   * (trzyma ją ktoś inny) otwiera okno „poprosić o zwolnienie?” i zostawia
   * ekran w podglądzie — preferencji nie zapisujemy, bo tryb się nie zmienił.
   */
  const setEditMode = (on: boolean) => {
    if (!on) {
      rememberEditMode(false);
      void lock.disable();
      return;
    }
    void lock.enable().then((ok) => {
      if (ok) rememberEditMode(true);
    });
  };

  // Ten sam przełącznik dla listy „Stałe" — własny stan i własny klucz,
  // bo edycja biura i edycja wypłat to dwie różne czynności (i dwie różne
  // rezerwacje listy).
  const [officeEditModePref, setOfficeEditModePref] = useState(() => {
    try {
      return localStorage.getItem(OFFICE_EDIT_MODE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const officeEditMode = editable && officeEditModePref && officeLock.mine;
  const rememberOfficeEditMode = (on: boolean) => {
    setOfficeEditModePref(on);
    try {
      localStorage.setItem(OFFICE_EDIT_MODE_KEY, on ? "1" : "0");
    } catch {
      // jw. — preferencja tylko na sesję
    }
  };
  const setOfficeEditMode = (on: boolean) => {
    if (!on) {
      rememberOfficeEditMode(false);
      void officeLock.disable();
      return;
    }
    void officeLock.enable().then((ok) => {
      if (ok) rememberOfficeEditMode(true);
    });
  };

  // Zapamiętany tryb „Edycja” odtwarzamy po cichu przy wejściu i przy zmianie
  // miesiąca (rezerwacja jest na listę I miesiąc). Nieudana próba zostawia
  // ekran w podglądzie z pigułką „Edytuje: …” — bez okna, którego nikt nie
  // wywołał otwarciem strony.
  useEffect(() => {
    if (!editable) return;
    if (editModePref && !lock.mine) void lock.enable(true);
    if (officeEditModePref && !officeLock.mine) void officeLock.enable(true);
    // Tylko wejście i zmiana okresu — na kliknięcia odpowiadają `setEditMode`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, editable]);

  // Lista przyszła SAMA po czekaniu (właściciel zwolnił po naszej prośbie) —
  // przełącznik wchodzi wtedy w tryb edycji bez drugiego kliknięcia.
  useEffect(() => {
    if (lock.granted > 0) rememberEditMode(true);
  }, [lock.granted]);
  useEffect(() => {
    if (officeLock.granted > 0) rememberOfficeEditMode(true);
  }, [officeLock.granted]);

  /**
   * Wybrana lista. Adres jest źródłem prawdy (`?lista=stale` obok `?m=`), żeby
   * odświeżenie i link wysłany księgowej trafiały tam, gdzie się patrzyło;
   * localStorage podpowiada tylko wtedy, gdy w adresie nic nie ma. Kafel
   * „Biuro" nad tabelą dokłada ten sam parametr — dlatego przełącza listę bez
   * żadnej dodatkowej ścieżki w drugą stronę.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [listPref, setListPref] = useState<PayrollList>(() => {
    try {
      const saved = localStorage.getItem(LIST_KEY);
      return isPayrollList(saved) ? saved : "godzinowe";
    } catch {
      return "godzinowe";
    }
  });
  const listParam = searchParams.get(LIST_PARAM);
  const list: PayrollList = isPayrollList(listParam) ? listParam : listPref;
  const setList = (next: PayrollList) => {
    setListPref(next);
    try {
      localStorage.setItem(LIST_KEY, next);
    } catch {
      // jw.
    }
    const params = new URLSearchParams(searchParams);
    params.set(LIST_PARAM, next);
    // `replace` jak przy miesiącu: przełączanie list nie ma zapychać historii.
    setSearchParams(params, { replace: true });
  };

  // --- brudnopisy i stan zapisu komórek (wzorzec z HoursTab) ---
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const payrollBodyRef = useRef<HTMLTableSectionElement>(null);
  const officeBodyRef = useRef<HTMLTableSectionElement>(null);
  const skipBlurRef = useRef<string | null>(null);
  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
    },
    [],
  );

  const companyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.company) set.add(r.company);
    for (const r of office) if (r.company) set.add(r.company);
    return [...set].sort((a, b) => a.localeCompare(b, "pl"));
  }, [rows, office]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const minV = parseAmount(min);
    const maxV = parseAmount(max);
    const list = rows.filter((r) => {
      if (q && !`${r.employeeName} ${r.company}`.toLowerCase().includes(q))
        return false;
      if (company !== "all" && r.company !== company) return false;
      if (contractType !== "all" && r.contractType !== contractType) return false;
      if (registration !== "all" && (r.registration ?? "none") !== registration)
        return false;
      if (bonusType !== "all" && r.bonusType !== bonusType) return false;
      if (mainChannel !== "all" && r.mainChannel !== mainChannel) return false;
      if (maxSource !== "all" && r.maxHoursSource !== maxSource) return false;
      if (gaps === "missing" && !payrollMissingMain(r)) return false;
      if (gaps === "pending" && !r.bonusPending) return false;
      if (gaps === "braki" && !payrollMissingMain(r) && !r.bonusPending)
        return false;
      if (gaps === "warnings" && r.warnings.length === 0) return false;
      if (minV !== undefined && r.wyplata < minV) return false;
      if (maxV !== undefined && r.wyplata > maxV) return false;
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;
    const cmp = (a: HrPayrollRow, b: HrPayrollRow) => {
      switch (sort) {
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
    rows,
    filter,
    company,
    contractType,
    registration,
    bonusType,
    mainChannel,
    maxSource,
    gaps,
    min,
    max,
    sort,
    dir,
  ]);

  // Zmiana miesiąca zwija rozwinięte osoby: rozwinięcia dotyczyły umów
  // tamtego miesiąca, a te same nazwiska mogą mieć teraz inny ich zestaw.
  useEffect(() => setExpanded(new Set()), [year, month]);

  /**
   * Widok „Osoby": wiersze umów zwinięte do jednego wiersza na pracownika.
   *
   * Grupujemy PO `employeeId`, nie po nazwisku — imiennicy to w kadrach rzecz
   * normalna, a scalona wypłata dwóch różnych osób byłaby błędem, którego nikt
   * by nie zobaczył. Sumujemy z `visible`, czyli PO FILTRACH: kafel „Braki"
   * i filtr spółki mają zawężać tak samo w obu widokach, a stopka ma pokazać
   * to samo, co w widoku umów.
   */
  const personGroups = useMemo<PayrollPersonGroup[]>(() => {
    const byEmployee = new Map<
      number,
      { employeeId: number; employeeName: string; rows: HrPayrollRow[] }
    >();
    for (const r of visible) {
      let g = byEmployee.get(r.employeeId);
      if (!g) {
        g = { employeeId: r.employeeId, employeeName: r.employeeName, rows: [] };
        byEmployee.set(r.employeeId, g);
      }
      g.rows.push(r);
    }
    const groups = [...byEmployee.values()].map((g) => {
      const sum = (pick: (r: HrPayrollRow) => number | null | undefined) =>
        g.rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
      // Kwota główna: `null` znaczy „księgowość jeszcze nie podała", więc suma
      // z samych pustych też ma zostać pusta — zero byłoby kwotą, której nikt
      // nie wpisał.
      const anyMain = g.rows.some((r) => r.kwotaGlowna != null);
      return {
        ...g,
        maksGodziny: sum((r) => r.maksGodziny),
        faktGodziny: sum((r) => r.faktGodziny),
        kwotaGlowna: anyMain ? sum((r) => r.kwotaGlowna) : null,
        dodatekFinalny: sum((r) => r.dodatekFinalny),
        przelew: sum((r) => r.przelew),
        gotowka: sum((r) => r.gotowka),
        wyplata: sum((r) => r.wyplata),
        bonusPending: g.rows.some((r) => r.bonusPending),
        // Ostrzeżenia ze wszystkich umów osoby, bez powtórek — wiersz osoby ma
        // mówić, że JEST co sprawdzić, zanim się go rozwinie.
        warnings: [...new Set(g.rows.flatMap((r) => r.warnings))],
        /** Rozbicie wypłaty na spółki — pigułki bez rozwijania wiersza. */
        byCompany: g.rows
          .map((r) => ({ company: r.company, wyplata: r.wyplata }))
          .filter((c) => c.wyplata !== 0),
      };
    });

    const mul = dir === "asc" ? 1 : -1;
    const cmp = (a: PayrollPersonGroup, b: PayrollPersonGroup) => {
      switch (sort) {
        case "maksGodziny":
          return cmpNum(a.maksGodziny, b.maksGodziny, mul);
        case "faktGodziny":
          return cmpNum(a.faktGodziny, b.faktGodziny, mul);
        case "kwotaGlowna":
          return cmpNum(a.kwotaGlowna, b.kwotaGlowna, mul);
        case "dodatekFinalny":
          return cmpNum(a.dodatekFinalny, b.dodatekFinalny, mul);
        case "przelew":
          return cmpMoney(a.przelew, b.przelew, mul);
        case "gotowka":
          return cmpMoney(a.gotowka, b.gotowka, mul);
        case "wyplata":
          return cmpMoney(a.wyplata, b.wyplata, mul);
        // Spółka, typ umowy, stawka i wyrównanie są CECHĄ UMOWY, nie osoby —
        // osoba z dwiema spółkami nie ma jednej wartości do porównania.
        // Sortowanie po nich zostaje wtedy przy nazwisku.
        default:
          return cmpText(a.employeeName, b.employeeName, mul);
      }
    };
    return groups.sort(
      (a, b) => cmp(a, b) || a.employeeName.localeCompare(b.employeeName, "pl"),
    );
  }, [visible, sort, dir]);

  /**
   * Płaska lista wierszy tabeli — jedna dla obu widoków, żeby wiersz umowy
   * renderował się w JEDNYM miejscu (te same kolumny, te same dymki, ta sama
   * edycja inline), niezależnie od tego, czy stoi sam, czy pod osobą.
   */
  const renderRows = useMemo<PayrollRenderItem[]>(() => {
    if (view === "umowy") {
      return visible.map((row, i) => ({
        kind: "contract" as const,
        row,
        cellIndex: i,
        // Druga umowa tej samej osoby pod rząd (typowo ZZA) dostaje lżejsze
        // nazwisko — widać wtedy, że to nadal ten sam człowiek. Tylko przy
        // sortowaniu po nazwisku: inaczej sąsiedztwo jest przypadkiem.
        grouped:
          sort === "employeeName" &&
          i > 0 &&
          visible[i - 1].employeeName === row.employeeName,
        nested: false,
      }));
    }
    const items: PayrollRenderItem[] = [];
    let cellIndex = 0;
    for (const group of personGroups) {
      items.push({ kind: "person", group });
      if (!expanded.has(group.employeeId)) continue;
      for (const row of group.rows) {
        items.push({
          kind: "contract",
          row,
          cellIndex: cellIndex++,
          grouped: false,
          nested: true,
        });
      }
    }
    return items;
  }, [view, visible, personGroups, expanded, sort]);

  /**
   * Biuro dzieli z wypłatami szukajkę i filtr spółki (to jedno rozliczenie
   * miesiąca w dwóch tabelach), ale ma własne sortowanie — kolumny są inne.
   */
  const officeVisible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = office.filter((r) => {
      if (q && !`${r.employeeName} ${r.company}`.toLowerCase().includes(q))
        return false;
      if (company !== "all" && r.company !== company) return false;
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
  }, [office, filter, company, officeSort, officeDir]);

  // Filtry schowane pod „Filtry (n)” — licznik pilnuje, żeby ukryty filtr nie
  // zawężał tabeli po cichu.
  const hiddenFiltersCount = [
    contractType !== "all",
    registration !== "all",
    bonusType !== "all",
    mainChannel !== "all",
    maxSource !== "all",
    min !== "" || max !== "",
  ].filter(Boolean).length;

  const filtersActive =
    filter !== "" || company !== "all" || gaps !== "all" || hiddenFiltersCount > 0;

  /**
   * Ile wierszy trafi na listę gotówkową i przelewową PO FILTRACH — menu
   * wydruków musi wiedzieć, zanim ktoś kliknie: pusta lista nie otwiera
   * kartki, tylko wyszarza pozycję z powodem w dymku.
   */
  const cashCount = useMemo(
    () => hrCashCount(visible, officeVisible),
    [visible, officeVisible],
  );
  const transferCount = useMemo(
    () => hrTransferCount(visible, officeVisible),
    [visible, officeVisible],
  );

  /**
   * Opis filtrów wędruje NA WYDRUK. Zestawienie zawężone do jednej spółki
   * wygląda na papierze identycznie jak pełne — a niekompletne wraca
   * z księgowości po tygodniu, nie po minucie. Dane spółki idą stąd, a nie
   * z literału w szablonie, żeby NIP na dokumencie zgadzał się z wystawcą.
   */
  const printOpts = useMemo(
    () => ({
      companies,
      filtersLabel: joinFilters([
        company !== "all" && `Spółka: ${company}`,
        contractType !== "all" &&
          (contractType === "praca" ? "tylko umowy o pracę" : "tylko zlecenia"),
        registration !== "all" && `Zgłoszenie: ${registration.toUpperCase()}`,
        gaps !== "all" && "tylko braki",
        filter.trim() && `Szukaj: ${filter.trim()}`,
        visible.length !== rows.length &&
          `${visible.length} z ${rows.length} wierszy`,
      ]),
    }),
    [companies, company, contractType, registration, gaps, filter, visible, rows],
  );

  const clearFilters = () => {
    setFilter("");
    setCompany("all");
    setContractType("all");
    setRegistration("all");
    setBonusType("all");
    setMainChannel("all");
    setMaxSource("all");
    setGaps("all");
    setMin("");
    setMax("");
  };

  const toggleSort = (key: PayrollSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(PAYROLL_DIR[key]);
  };

  const toggleOfficeSort = (key: OfficeSortKey) => {
    if (officeSort === key) {
      setOfficeDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setOfficeSort(key);
    setOfficeDir(OFFICE_DIR[key]);
  };

  const sumPrzelew = visible.reduce((s, r) => s + r.przelew, 0);
  const sumGotowka = visible.reduce((s, r) => s + r.gotowka, 0);

  // --- postęp miesiąca ---
  // Liczby bierzemy z listy kontrolnej backendu (`summary.checklist`) — tej
  // samej, na której stoi „Zamknij miesiąc" w pasku stanu. Powtórzone tu
  // wyliczenie dawało dwie prawdy o jednym miesiącu na jednym ekranie:
  // wystarczyła drobna różnica w regule „wpis wypełniony", żeby pasek postępu
  // mówił „140 z 147", a pasek stanu miesiąca o centymetr wyżej — „142 z 147".
  // Zapasowe liczenie lokalne zostaje na czas, gdy podsumowanie się wczytuje.
  const monthHours = hours.reduce(
    (s, r) => s + (r.workedHours ?? 0) + (r.uwHours ?? 0) + (r.l4Hours ?? 0),
    0,
  );
  const hoursTotal = checklist?.hoursEntries ?? hours.length;
  const hoursDone = checklist?.hoursFilled ?? hours.filter(hoursFilled).length;
  const withHoursCount =
    checklist?.contractsWithHours ??
    rows.filter((r) => (r.faktGodziny ?? 0) > 0).length;
  const amountsDone =
    checklist?.contractsWithAmount ??
    rows.filter((r) => (r.faktGodziny ?? 0) > 0 && r.kwotaGlowna != null).length;
  const officeCount = checklist?.officeEntries ?? office.length;
  const monthEmpty = !loading && monthHours === 0 && rows.length > 0;

  // --- edycja inline ---

  const key = (id: number, field: string) => `${id}:${field}`;

  const shownPayroll = (r: HrPayrollRow, field: PayrollField) =>
    drafts[key(r.contractId, field)] ?? payrollCellValue(r, field);

  const shownOffice = (r: HrOfficeRow, field: OfficeField) =>
    drafts[key(-r.id, field)] ?? officeCellValue(r, field);

  const setDraft = (k: string, value: string) =>
    setDrafts((p) => ({ ...p, [k]: value }));

  const dropDraft = (k: string) =>
    setDrafts((p) => {
      const next = { ...p };
      delete next[k];
      return next;
    });

  const markSaved = (k: string) => {
    setSavedAt((p) => ({ ...p, [k]: Date.now() }));
    timersRef.current.push(
      window.setTimeout(
        () =>
          setSavedAt((p) => {
            const next = { ...p };
            delete next[k];
            return next;
          }),
        2000,
      ),
    );
  };

  const setError = (k: string, message: string | null) =>
    setErrors((p) => {
      const next = { ...p };
      if (message) next[k] = message;
      else delete next[k];
      return next;
    });

  /**
   * Zapis jednej komórki wypłaty. Wysyłamy KOMPLET wejść wiersza (PUT robi
   * upsert całego rekordu), więc pominięcie reszty pól wyzerowałoby np. stawkę
   * dodatku przy wpisaniu samej kwoty głównej. Brak zmiany = brak żądania:
   * przejście Tabem przez tabelę nie ma generować 147 zapisów.
   */
  const commitPayroll = async (
    r: HrPayrollRow,
    field: PayrollField,
    value: string,
  ) => {
    const k = key(r.contractId, field);
    // Niepoprawna liczba nie jedzie do backendu — brudnopis zostaje, komórka
    // pokazuje błąd („3 200,00" zapisywało się kiedyś jako 3, z ptaszkiem).
    if (!isNumFieldValid(value)) {
      setError(k, NUM_FIELD_ERROR);
      return;
    }
    const before = numToField(fieldToNum(payrollCellValue(r, field)));
    const after = numToField(fieldToNum(value));
    if (before === after) {
      dropDraft(k);
      return;
    }
    setSaving((p) => ({ ...p, [k]: true }));
    setError(k, null);
    try {
      const payload: HrPayrollSaveInput = {
        contractId: r.contractId,
        year,
        month,
        ...r.inputs,
      };
      payload[field] = fieldToNum(value);
      const res = await saveHrPayroll(payload);
      dropDraft(k);
      if (res.data) onRowSaved(res.data);
      markSaved(k);
    } catch (err) {
      // Brudnopis zostaje — wpisana wartość nie ma zniknąć razem z błędem.
      setError(k, err instanceof Error ? err.message : "Błąd zapisu");
    } finally {
      setSaving((p) => {
        const next = { ...p };
        delete next[k];
        return next;
      });
    }
  };

  const commitOffice = async (
    r: HrOfficeRow,
    field: OfficeField,
    value: string,
  ) => {
    const k = key(-r.id, field);
    if (!isNumFieldValid(value)) {
      setError(k, NUM_FIELD_ERROR);
      return;
    }
    const before = numToField(fieldToNum(officeCellValue(r, field)));
    const after = numToField(fieldToNum(value));
    if (before === after) {
      dropDraft(k);
      return;
    }
    setSaving((p) => ({ ...p, [k]: true }));
    setError(k, null);
    try {
      const payload: HrOfficeInput = {
        employeeId: r.employeeId,
        // Jak w godzinach: zapis przechodzi tylko, gdy wiersz się nie zmienił
        // od wczytania (rezerwacja listy jest per użytkownik, więc dwie karty
        // tej samej osoby wciąż mogą się ścigać).
        expectedUpdatedAt: r.updatedAt,
        year: r.year,
        month: r.month,
        company: r.company,
        etatHours: r.etatHours,
        uwL4: r.uwL4,
        deductions: r.deductions,
        bonuses: r.bonuses,
        hoursForAccounting: r.hoursForAccounting,
        rate: r.rate,
        amount: r.amount,
        rorBase: r.rorBase,
        cashOverride: r.cashOverride,
        notes: r.notes,
      };
      payload[field] = fieldToNum(value);
      const res = await updateHrOffice(r.id, payload);
      dropDraft(k);
      if (res.data) onOfficeRowSaved({ ...res.data, employeeName: r.employeeName });
      markSaved(k);
    } catch (err) {
      setError(k, err instanceof Error ? err.message : "Błąd zapisu");
    } finally {
      setSaving((p) => {
        const next = { ...p };
        delete next[k];
        return next;
      });
    }
  };

  /**
   * Enter → ta sama kolumna niżej (Shift+Enter wyżej), Esc → cofnij wpis.
   * Enter sam niczego nie zapisuje — przenosi focus, a zapis robi `onBlur`
   * opuszczanego pola (jedno żądanie na komórkę, nie dwa).
   */
  const cellKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    body: React.RefObject<HTMLTableSectionElement | null>,
    rowIndex: number,
    field: string,
    draftKey: string,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const target = body.current?.querySelector<HTMLElement>(
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
      skipBlurRef.current = draftKey;
      dropDraft(draftKey);
      e.currentTarget.blur();
    }
  };

  /** Ikona stanu zapisu komórki — zamiast toasta przy każdej wpisanej kwocie. */
  const cellStatus = (k: string) => {
    if (saving[k])
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
    if (savedAt[k])
      return (
        <Check
          className={cn("h-3.5 w-3.5", TEXT_TONE.good)}
          role="status"
          aria-label="Zapisano"
        />
      );
    return null;
  };

  const payrollCell = (
    r: HrPayrollRow,
    rowIndex: number,
    field: PayrollField,
    className?: string,
    /** Dopisek pod polem (np. kwota z poprzedniego miesiąca). */
    footer?: React.ReactNode,
  ) => {
    const k = key(r.contractId, field);
    return (
      <td className="px-1.5 py-1 text-right align-top">
        <div className="relative">
          <Input
            data-cell={`${rowIndex}:${field}`}
            data-testid={`kadry-wynagrodzenia-cell-${field}`}
            className={cn(
              "ml-auto h-8 w-[96px] pr-5 text-right tabular-nums",
              errors[k] && "border-destructive",
              className,
            )}
            inputMode="decimal"
            value={shownPayroll(r, field)}
            onChange={(e) => setDraft(k, e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              if (skipBlurRef.current === k) {
                skipBlurRef.current = null;
                return;
              }
              void commitPayroll(r, field, e.currentTarget.value);
            }}
            onKeyDown={(e) => cellKeyDown(e, payrollBodyRef, rowIndex, field, k)}
          />
          <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2">
            {cellStatus(k)}
          </span>
        </div>
        {errors[k] && (
          <p className="max-w-[140px] text-right text-[11px] leading-tight text-destructive">
            {errors[k]}
          </p>
        )}
        {footer}
      </td>
    );
  };

  const officeCell = (
    r: HrOfficeRow,
    rowIndex: number,
    field: OfficeField,
    className?: string,
  ) => {
    const k = key(-r.id, field);
    return (
      <td className="px-1.5 py-1 text-right align-top">
        <div className="relative">
          <Input
            data-cell={`${rowIndex}:${field}`}
            data-testid={`kadry-biuro-cell-${field}`}
            className={cn(
              "ml-auto h-8 w-[96px] pr-5 text-right tabular-nums",
              errors[k] && "border-destructive",
              className,
            )}
            inputMode="decimal"
            value={shownOffice(r, field)}
            onChange={(e) => setDraft(k, e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              if (skipBlurRef.current === k) {
                skipBlurRef.current = null;
                return;
              }
              void commitOffice(r, field, e.currentTarget.value);
            }}
            onKeyDown={(e) => cellKeyDown(e, officeBodyRef, rowIndex, field, k)}
          />
          <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2">
            {cellStatus(k)}
          </span>
        </div>
        {errors[k] && (
          <p className="max-w-[140px] text-right text-[11px] leading-tight text-destructive">
            {errors[k]}
          </p>
        )}
      </td>
    );
  };

  const handleCarryOverOffice = async () => {
    setCarrying(true);
    setBarError(null);
    try {
      const res = await carryOverHrOffice(year, month);
      if ((res.data?.inserted ?? 0) > 0) onOfficeCarriedOver();
    } catch (err) {
      setBarError(
        err instanceof Error ? err.message : "Nie udało się przenieść wpisów biura",
      );
    } finally {
      setCarrying(false);
    }
  };

  /**
   * Kwota z poprzedniego miesiąca pod polem: przy 147 przepisywanych liczbach
   * literówka o rząd wielkości (3 583 → 35 830) jest kwestią czasu, a w tabeli
   * z zerami niczego nie widać. Flaga zapala się przy różnicy > 25% — to próg
   * znacznie powyżej normalnych wahań nadgodzin z miesiąca na miesiąc.
   */
  const prevHint = (r: HrPayrollRow) => {
    const prev = prevAmounts?.get(r.contractId);
    if (prev == null || prev === 0) return null;
    const cur = r.kwotaGlowna;
    const off = cur != null && Math.abs(cur - prev) / prev > 0.25;
    return (
      <p
        className={cn(
          "cursor-help text-right text-[11px] leading-tight",
          off ? cn("font-medium", TEXT_TONE.warn) : "text-muted-foreground",
        )}
        {...tip(
          off
            ? `W poprzednim miesiącu: ${money(prev)} — różnica ponad 25%, sprawdź kwotę`
            : `Kwota główna w poprzednim miesiącu: ${money(prev)}`,
        )}
      >
        {off ? "⚠ " : ""}pop. {money(prev)}
      </p>
    );
  };

  /**
   * Komórka z wartością, której NIE wpisano w tej kolumnie wprost: nadpisaną
   * ręcznie (indygo) albo wyliczoną automatycznie (morska).
   *
   * Przedtem znaczyła to gwiazdka za liczbą. Gwiazdka nie mówiła, ile wyszłoby
   * z wyliczenia, w kolumnie kwot myliła się z przypisem, a w trybie edycji
   * znikała razem z wartością — kolor i dymek robią jedno i drugie naraz.
   */
  const markedCell = (
    value: React.ReactNode,
    mark: "override" | "computed" | null,
    hint: React.ReactNode,
    className?: string,
  ) => (
    <td className={cn("px-3 py-2 text-right tabular-nums", className)}>
      <span className={cn(mark && TEXT_TONE[mark], "cursor-help")} {...tip(hint)}>
        {value}
      </span>
    </td>
  );

  /**
   * Dymek przy spółce w rozliczeniu biura.
   *
   * Biuro trzyma tam nie samą spółkę, tylko spółkę RAZEM Z FORMĄ zatrudnienia:
   * „ALFA ETAT”, „ALFA UZ”, „CONTROL ETAT”. Tak podaje je księgowość i tak
   * stoją w bazie — ale w słowniku Spółki (`/companies`, skąd wydruki biorą
   * NIP i adres) takich pozycji nie ma. Bez wyjaśnienia wygląda to na
   * literówkę albo spółkę-widmo, więc UI nazywa rzecz po imieniu, zamiast
   * po cichu podmieniać wartość na „ALFA”.
   */
  /**
   * Rezerwacja blokująca wiersz danego pracownika — albo `null`, gdy wiersz
   * jest nasz. Wypłata i wpis biura należą do sekcji działu pracownika, więc
   * gdy OFI rozlicza swoich, reszta listy zostaje do pisania, a te wiersze są
   * wygaszone. Liczymy tylko wtedy, gdy w ogóle jest co blokować.
   */
  const rowLockOf = (l: HrEditLock, employeeId: number | null | undefined) =>
    l.excluded.length === 0 ? null : l.lockedBy(portalOfEmployee?.(employeeId) ?? null);

  /** Dymek wygaszonego wiersza — kto, do kiedy i co z tym zrobić. */
  const rowLockHint = (l: HrLockDto) =>
    `Edytuje: ${l.userLabel}${l.portalLabel ? ` (${l.portalLabel})` : ""} do ${lockUntil(l.expiresAt)} · kliknij, aby poprosić o zwolnienie`;

  const companyHint = (name: string) => {
    const dict = companies?.find((c) => c.name === name);
    // Pozycja z danymi z KRS — normalna spółka, nie ma czego tłumaczyć.
    if (dict?.nip || dict?.fullName)
      return `Spółka zatrudniająca: ${dict.fullName ?? name}${
        dict.nip ? ` (NIP ${dict.nip})` : ""
      }`;
    // „ALFA ETAT" = spółka ALFA + forma zatrudnienia. W słowniku taka pozycja
    // jest, ale pusta: bez NIP-u i pełnej nazwy, bo nie jest osobnym podmiotem.
    const base = companies?.find(
      (c) => c.nip && name.toUpperCase().startsWith(`${c.name.toUpperCase()} `),
    )?.name;
    if (base)
      return `${base} + forma zatrudnienia (${name
        .slice(base.length)
        .trim()
        .toLowerCase()}) — tak nazywa to zestawienie księgowości i tak zostaje. To nie jest osobny podmiot, więc w słowniku Spółki nie ma przy niej NIP-u ani pełnej nazwy: wydruk pokaże sam ten skrót.`;
    return `Spółka z zestawienia biura: ${name}. W słowniku Spółki nie ma przy niej NIP-u ani pełnej nazwy, więc wydruk pokaże sam skrót.`;
  };

  /**
   * Wiersz nadrzędny widoku „Osoby": sumy pracownika w tych samych kolumnach,
   * co jego umowy.
   *
   * Sumujemy tylko to, co się sumuje. Stawka netto, wyrównanie (zł/h) i maks
   * godzin są PARAMETRAMI umowy, nie wielkościami do dodania — „stawka osoby"
   * z dwóch różnych umów nie znaczy nic, a postawiona w kolumnie liczb
   * wyglądałaby na fakt. Te komórki zostają puste, a wartości są w wierszach
   * umów pod strzałką.
   */
  const personRow = (g: PayrollPersonGroup) => {
    const isOpen = expanded.has(g.employeeId);
    const empty = <td className="px-3 py-2" />;
    return (
      <tr
        key={`osoba-${g.employeeId}`}
        className={cn(
          "cursor-pointer border-b bg-background font-medium hover:bg-accent/50",
          isOpen && "bg-accent/30",
        )}
        data-testid="kadry-wynagrodzenia-osoba"
        onClick={() => toggleExpanded(g.employeeId)}
      >
        <td className={cn("whitespace-nowrap px-3 py-2", stickyName)}>
          <span className="flex items-center gap-1.5">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            {g.employeeName}
            {(g.warnings.length > 0 || g.bonusPending) && (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-amber-500"
                aria-label={
                  g.warnings.length > 0
                    ? g.warnings.join("; ")
                    : "Dodatek do przeliczenia"
                }
              />
            )}
            <span className="font-normal text-muted-foreground">
              {contractsLabel(g.rows.length)}
            </span>
          </span>
        </td>
        {/* Rozbicie na spółki w miejscu kolumny „Spółka" — po to, żeby
            „ile w ALFIE, ile w GUARD" dało się przeczytać bez rozwijania. */}
        <td className="px-3 py-2" colSpan={3}>
          <span className="flex flex-wrap items-center gap-1">
            {g.byCompany.map((c, i) => (
              <KadryBadge
                key={`${c.company}-${i}`}
                tone="neutral"
                compact
                hint={`Wypłata netto z umowy w spółce ${c.company}: ${money(c.wyplata)}`}
              >
                {c.company} {money(c.wyplata)}
              </KadryBadge>
            ))}
          </span>
        </td>
        {empty}
        <td className="px-3 py-2 text-right tabular-nums">
          {hrs(g.faktGodziny)}
        </td>
        {empty}
        {empty}
        <td className="px-3 py-2 text-right tabular-nums">
          {g.kwotaGlowna != null ? money(g.kwotaGlowna) : ""}
        </td>
        {editMode && empty}
        {empty}
        {empty}
        {empty}
        <td className="px-3 py-2 text-right tabular-nums">
          {g.dodatekFinalny ? money(g.dodatekFinalny) : ""}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {g.przelew ? money(g.przelew) : ""}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {g.gotowka ? money(g.gotowka) : ""}
        </td>
        <td className="px-3 py-2 text-right font-semibold tabular-nums">
          {g.wyplata ? money(g.wyplata) : ""}
        </td>
        {empty}
        {editMode && empty}
      </tr>
    );
  };

  const colCount = editMode ? 19 : 17;
  /** Pierwsza kolumna zostaje przy przewijaniu — 17 kolumn nie mieści się na ekranie. */
  const stickyName = "sticky left-0 z-10 bg-inherit";

  return (
    <>
      {/* RZĄD 1 — wszystko, co ZAWĘŻA miesiąc: wybór okresu, legenda, szukajka,
          spółka, braki i schowane filtry. Wcześniej „Braki" i „Filtry" stały
          rząd niżej, przy przyciskach trybu, więc przy 1366 px pasek łamał się
          na trzy rzędy i odpowiedź na „co ja właściwie widzę" była w dwóch
          miejscach. Po prawej wydruki — biorą to, co zostało po filtrach. */}
      <div className="flex flex-wrap items-center gap-2">
        {monthNav}
        <div className="relative min-w-[150px] max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Szukaj: pracownik / spółka…"
            className="pl-10"
            data-testid="kadry-wynagrodzenia-filter-search"
          />
        </div>
        <Select value={company} onValueChange={setCompany}>
          <SelectTrigger
            className="w-[130px]"
            data-testid="kadry-wynagrodzenia-filter-company"
            {...tip("Spółka — zawęża obie listy miesiąca")}
          >
            <SelectValue placeholder="Spółka" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie</SelectItem>
            {companyOptions.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {list === "godzinowe" && (
          <>
            {/* Tryby odpowiadają kaflowi „Braki”: `braki` to jego liczba,
                dwa kolejne — jego składniki z podpisu kafla. Filtr dotyczy
                wyłącznie wypłat ochrony, więc znika przy liście „Stałe". */}
            <Select value={gaps} onValueChange={(v) => setGaps(v as PayrollGapMode)}>
              <SelectTrigger
                className="w-[150px]"
                data-testid="kadry-wynagrodzenia-filter-gaps"
                {...tip("Braki — te same, które liczy kafel „Braki” nad tabelą")}
              >
                <SelectValue placeholder="Braki" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Braki: wszystkie</SelectItem>
                <SelectItem value="braki">Braki (jak na kaflu)</SelectItem>
                <SelectItem value="missing">Kwota główna pusta</SelectItem>
                <SelectItem value="pending">Dodatek do przeliczenia</SelectItem>
                <SelectItem value="warnings">Z ostrzeżeniami</SelectItem>
              </SelectContent>
            </Select>
            <MoreFiltersButton
              open={showMoreFilters}
              onToggle={() => setShowMoreFilters((v) => !v)}
              count={hiddenFiltersCount}
              testId="kadry-wynagrodzenia-filters-more"
            />
            {/* Ikona, nie przycisk z podpisem: „Wyczyść filtry" pojawia się
                dopiero, gdy filtr działa, i wtedy 140 px podpisu wypychało
                cały rząd filtrów do drugiej linii przy 1366 px. Dymek
                i `aria-label` niosą pełną nazwę. */}
            {filtersActive && (
              <IconButton
                icon={FilterX}
                size="md"
                label="Wyczyść filtry"
                onClick={clearFilters}
                testId="kadry-wynagrodzenia-filters-clear"
              />
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Cztery wydruki pod jednym przyciskiem, nie cztery przyciski
              w pasku: z miesiąca na miesiąc używa się jednego, a pasek i tak
              zawijał się już na dwa rzędy. Każdy wydruk bierze to, CO WIDAĆ
              w tabeli — dlatego licznik „(N z M)" stoi wprost na przycisku,
              a ostatnia pozycja menu daje wyjście na pełne zestawienie. */}
          <PrintMenu
            visibleCount={visible.length}
            totalCount={rows.length}
            items={[
              {
                key: "statement",
                icon: Printer,
                label: "Zestawienie dla księgowości",
                hint: "Godziny i kwoty — to, co widać w tabeli",
                onSelect: () => printHrStatement(visible, year, month, printOpts),
              },
              {
                key: "cash",
                icon: Banknote,
                label: "Lista wypłat gotówkowych",
                hint: "Strona na spółkę, rubryki na datę i podpis",
                // Pusta lista nie ma prawa otworzyć kartki — pozycja jest
                // wyszarzona, a dymek mówi wprost, czego brakuje.
                disabled: cashCount === 0,
                disabledHint: `${HR_CASH_EMPTY} — nie ma czego drukować`,
                onSelect: () =>
                  setPrintInfo(
                    printHrCashList(visible, officeVisible, year, month, printOpts),
                  ),
              },
              {
                key: "transfer",
                icon: ArrowLeftRight,
                label: "Lista przelewów",
                hint: "Do bankowości, pogrupowana po spółkach",
                disabled: transferCount === 0,
                disabledHint: `${HR_TRANSFER_EMPTY} — nie ma czego drukować`,
                onSelect: () =>
                  setPrintInfo(
                    printHrTransferList(
                      visible,
                      officeVisible,
                      year,
                      month,
                      printOpts,
                    ),
                  ),
              },
              {
                key: "csv",
                icon: Download,
                label: "Lista przelewów — CSV",
                hint: `przelewy-${year}-${String(month).padStart(2, "0")}.csv, średnik + BOM`,
                disabled: transferCount === 0,
                disabledHint: `${HR_TRANSFER_EMPTY} — plik miałby sam nagłówek`,
                onSelect: () =>
                  setPrintInfo(
                    downloadHrTransferCsv(visible, officeVisible, year, month),
                  ),
              },
              ...(visible.length !== rows.length
                ? [
                    {
                      key: "statement-all",
                      icon: Printer,
                      label: "Zestawienie — wszystkie umowy",
                      hint: `Z pominięciem filtrów: ${rows.length} wierszy`,
                      onSelect: () =>
                        printHrStatement(rows, year, month, { companies }),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>

      {/* RZĄD 2 — którą listę czytam i JAK. Po lewej wybór listy z licznikiem
          i jednostka wiersza (umowa / osoba), po prawej to, czym się w tej
          liście PISZE: wklejka z arkusza i przełącznik podgląd / edycja. */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<PayrollList>
          value={list}
          onChange={setList}
          ariaLabel="Lista wynagrodzeń"
          testId="kadry-wynagrodzenia-lista"
          options={[
            {
              value: "godzinowe",
              label: "Godzinowe",
              icon: Clock,
              count: rows.length,
              hint: "Ochrona — wypłaty liczone z godzin miesiąca i kwot od księgowości",
              testId: "kadry-wynagrodzenia-lista-godzinowe",
            },
            {
              value: "stale",
              label: "Stałe",
              icon: Building2,
              count: office.length,
              hint: "Biuro — kwoty z etatu albo z godzin do księgowej, rozbite na ROR i gotówkę",
              testId: "kadry-wynagrodzenia-lista-stale",
            },
          ]}
        />
        {/* Licznik po filtrach: szukajka i spółka z paska wyżej zawężają OBIE
            listy, więc przy każdej trzeba widzieć, ile z ilu zostało. */}
        {list === "godzinowe" ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid="kadry-wynagrodzenia-count"
          >
            {visible.length}
            {visible.length === rows.length ? "" : ` z ${rows.length}`} umów
            {view === "osoby" && ` · ${peopleLabel(personGroups.length)}`}
          </span>
        ) : (
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
        )}

        {/* Jednostka wiersza: umowa (jak w bazie) albo osoba (jak przy
            wypłacie). Stoi przy wyborze listy, bo razem z nim odpowiada na
            pytanie „co jest wierszem tej tabeli". */}
        {list === "godzinowe" && (
          <SegmentedControl<PayrollView>
            value={view}
            onChange={setView}
            ariaLabel="Widok listy godzinowej"
            testId="kadry-wynagrodzenia-widok"
            options={[
              {
                value: "umowy",
                label: "Umowy",
                icon: FileText,
                hint: "Wiersz = umowa, tak jak w bazie i na zestawieniu od księgowości",
                testId: "kadry-wynagrodzenia-widok-umowy",
              },
              {
                value: "osoby",
                label: "Osoby",
                icon: Users,
                hint: "Wiersz = pracownik z sumą wszystkich swoich umów; strzałka rozwija umowy",
                testId: "kadry-wynagrodzenia-widok-osoby",
              },
            ]}
          />
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {list === "godzinowe" ? (
            <>
              {editable && (
                /* Kto trzyma listę — widoczne TAKŻE w podglądzie, żeby odmowa
                   przy kliknięciu „Edycja" nie była zaskoczeniem. */
                <LockHolderPill lock={lock} testId="kadry-wynagrodzenia-lock-pill" />
              )}
              {editable && (
                /* Kwoty przychodzą od księgowości listą — wklejenie kolumny jest
                   jednym ruchem zamiast 147 wejść w komórki. */
                <Button
                  variant="outline"
                  size="sm"
                  className={TOOLBAR_BTN_CLS}
                  onClick={() => setPasteOpen(true)}
                  data-testid="kadry-wynagrodzenia-paste"
                  {...tip("Wklej kwoty główne z arkusza (nazwisko, spółka, kwota)")}
                >
                  <ClipboardPaste className="mr-1 h-4 w-4" />
                  Wklej z arkusza
                </Button>
              )}
              {editable && (
                /* Przełącznik trybu: podgląd czyta się lepiej, edycja pozwala
                   wpisywać kwoty bez otwierania dialogu na każdą umowę.
                   Osobny dla każdej listy — wpisywanie kwot ochrony i
                   rozliczanie biura to dwie różne czynności. */
                <SegmentedControl<"view" | "edit">
                  value={editMode ? "edit" : "view"}
                  onChange={(v) => setEditMode(v === "edit")}
                  ariaLabel="Tryb listy godzinowej"
                  options={[
                    {
                      value: "view",
                      label: "Podgląd",
                      icon: Eye,
                      hint: "Tabela do czytania; kliknięcie wiersza otwiera dialog wypłaty",
                      testId: "kadry-wynagrodzenia-mode-view",
                    },
                    {
                      value: "edit",
                      label: "Edycja",
                      icon: PencilLine,
                      hint: "Kwoty wpisujesz wprost w tabeli — zapis po wyjściu z pola",
                      testId: "kadry-wynagrodzenia-mode-edit",
                    },
                  ]}
                />
              )}
            </>
          ) : (
            <>
              {editable && (
                <LockHolderPill lock={officeLock} testId="kadry-biuro-lock-pill" />
              )}
              {editable && office.length === 0 && (
                /* Biuro to te same kilkanaście osób miesiąc w miesiąc —
                   przepisywanie ich ręcznie było najgłupszą częścią
                   zamykania miesiąca. */
                <Button
                  variant="outline"
                  size="sm"
                  className={TOOLBAR_BTN_CLS}
                  disabled={carrying}
                  onClick={handleCarryOverOffice}
                  data-testid="kadry-biuro-carry-over"
                  {...tip(
                    "Skopiuj wpisy biura z poprzedniego miesiąca (osoby, spółki i stawki — bez kwot)",
                  )}
                >
                  {carrying
                    ? "Przenoszenie…"
                    : "Przenieś wpisy z poprzedniego miesiąca"}
                </Button>
              )}
              {editable && (
                <Button
                  variant="outline"
                  size="sm"
                  className={TOOLBAR_BTN_CLS}
                  onClick={onOfficeAdd}
                  data-testid="kadry-biuro-add"
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Dodaj wpis biura
                </Button>
              )}
              {editable && (
                <SegmentedControl<"view" | "edit">
                  value={officeEditMode ? "edit" : "view"}
                  onChange={(v) => setOfficeEditMode(v === "edit")}
                  ariaLabel="Tryb listy stałej"
                  options={[
                    {
                      value: "view",
                      label: "Podgląd",
                      icon: Eye,
                      hint: "Tabela do czytania; kliknięcie wiersza otwiera formularz wpisu",
                      testId: "kadry-biuro-mode-view",
                    },
                    {
                      value: "edit",
                      label: "Edycja",
                      icon: PencilLine,
                      hint: "Kwoty i godziny wpisujesz wprost w tabeli — zapis po wyjściu z pola",
                      testId: "kadry-biuro-mode-edit",
                    },
                  ]}
                />
              )}
            </>
          )}
        </div>
      </div>

      {list === "godzinowe" && showMoreFilters && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2"
          data-testid="kadry-wynagrodzenia-filters-row2"
        >
          <Select
            value={contractType}
            onValueChange={(v) => setContractType(v as typeof contractType)}
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
            value={registration}
            onValueChange={(v) => setRegistration(v as typeof registration)}
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
          <Select value={bonusType} onValueChange={setBonusType}>
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
            value={mainChannel}
            onValueChange={(v) => setMainChannel(v as typeof mainChannel)}
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
            value={maxSource}
            onValueChange={(v) => setMaxSource(v as typeof maxSource)}
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
          <div className="flex items-center gap-1">
            <Input
              value={min}
              onChange={(e) => setMin(e.target.value)}
              placeholder="Wypłata od"
              inputMode="decimal"
              className="w-[110px]"
              data-testid="kadry-wynagrodzenia-filter-min"
            />
            <span className="text-muted-foreground">–</span>
            <Input
              value={max}
              onChange={(e) => setMax(e.target.value)}
              placeholder="do"
              inputMode="decimal"
              className="w-[90px]"
              data-testid="kadry-wynagrodzenia-filter-max"
            />
          </div>
        </div>
      )}

      {/* Pasek postępu miesiąca: trzy liczby, od których zależy, czy miesiąc
          da się zamknąć — i skrót do miejsca, gdzie się je uzupełnia. */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"
        data-testid="kadry-wynagrodzenia-progress"
      >
        <span className="font-medium text-foreground">Postęp miesiąca:</span>
        <button
          type="button"
          onClick={onGoToHours}
          className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...tip("Przejdź do zakładki Godziny — stamtąd biorą się kwoty")}
        >
          godziny {hoursDone} z {hoursTotal} wpisów
        </button>
        <button
          type="button"
          onClick={() => {
            setList("godzinowe");
            setGaps("missing");
          }}
          className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...tip("Pokaż umowy z godzinami, ale bez kwoty NETTO od księgowości")}
        >
          kwoty {amountsDone} z {withHoursCount} umów z godzinami
        </button>
        <button
          type="button"
          onClick={() => setList("stale")}
          className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...tip("Pokaż listę „Stałe” — rozliczenie biura za ten miesiąc")}
        >
          biuro {officeCount} wpisów
        </button>
        {(list === "godzinowe" ? editMode : officeEditMode) && (
          <span className="text-xs">
            Tryb edycji: zapis po wyjściu z pola · Enter — niżej · Shift+Enter —
            wyżej · Esc — cofnij
          </span>
        )}
      </div>

      {/* Lista kontrolna „co się zmieniło od zeszłego miesiąca". Stoi pod
          postępem miesiąca, bo odpowiada na to samo pytanie — czy miesiąc jest
          gotowy — tylko z drugiej strony: nie „czego brakuje", a „co wygląda
          inaczej niż ostatnio". Zwinięta, bo w normalnym miesiącu nie ma o niej
          co czytać; nagłówek i tak mówi, ile pozycji w środku. */}
      {list === "godzinowe" && prevSummary && (
        <Card>
          <CardContent className="p-3">
            <PayrollChangesSection
              rows={rows}
              prev={prevPayroll ?? []}
              prevMonthLabel={monthYearLabel(prevSummary.year, prevSummary.month)}
              prevHasData={prevSummary.hasPayroll}
              prevSettled={prevSummary.payrollSettled}
              open={changesOpen}
              onToggle={() => setChangesOpen((v) => !v)}
              onPick={(name) => {
                setFilter(name);
                setList("godzinowe");
              }}
            />
          </CardContent>
        </Card>
      )}

      {barError && <p className="text-sm text-destructive">{barError}</p>}
      {pasteInfo && (
        <p className="text-sm text-emerald-700" data-testid="kadry-paste-info">
          {pasteInfo}
        </p>
      )}
      {/* Wydruk, który się nie otworzył, musi powiedzieć dlaczego — inaczej
          kliknięcie w wyszarzoną pozycję wygląda na zepsuty przycisk. */}
      {printInfo && (
        <p className={cn("text-sm", TEXT_TONE.warn)} data-testid="kadry-print-info">
          {printInfo}
        </p>
      )}

      {/* ---------- GODZINOWE (ochrona) ---------- */}
      {/* Miesiąc bez godzin: 147 wierszy z zerami udaje pracę do zrobienia,
          choć nie ma z czego liczyć ani jednej wypłaty. */}
      {list === "godzinowe" && monthEmpty && !showEmptyTable && (
        <Card data-testid="kadry-wynagrodzenia-empty">
          <CardContent className="flex flex-wrap items-center gap-3 p-6">
            <div className="min-w-[260px] flex-1">
              <p className="font-medium">
                Brak godzin za {MONTH_NAMES[month - 1].toLowerCase()} {year}
              </p>
              <p className="text-sm text-muted-foreground">
                Wypłaty liczą się z godzin — dopóki ich nie ma, wszystkie{" "}
                {rows.length} umów pokaże zera. Zacznij od zakładki Godziny.
              </p>
            </div>
            <Button onClick={onGoToHours}>
              Wpisz godziny
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button variant="outline" onClick={() => setShowEmptyTable(true)}>
              Pokaż umowy mimo to
            </Button>
          </CardContent>
        </Card>
      )}

      {list === "godzinowe" && (!monthEmpty || showEmptyTable) && (
        <>
          {/* Pasek rezerwacji listy wypłat: „edytujesz tę listę”, prośba
              o zwolnienie i okno konfliktu. Sam decyduje, czy się pokazać. */}
          <EditLockBar
            lock={lock}
            onRelease={() => rememberEditMode(false)}
            testId="kadry-wynagrodzenia-lock-bar"
          />
          <Card>
            <CardContent className="max-h-[70vh] overflow-auto p-0">
              <table
                className={cn(
                  "w-full text-sm",
                  editMode ? "min-w-[1760px]" : "min-w-[1460px]",
                )}
              >
                <thead className="sticky top-0 z-20 border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <SortTh
                      label="Pracownik"
                      sortKey="employeeName"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      className="sticky left-0 z-30 bg-muted"
                      tip="Pracownik z umowy — w trybie edycji kwoty wpisuje się wprost w tabeli"
                    />
                    <SortTh
                      label="Spółka"
                      sortKey="company"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      tip="Spółka zatrudniająca (z umowy)"
                    />
                    <SortTh
                      label="Umowa"
                      sortKey="contractType"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      tip="Typ umowy: Praca (UoP) / Zlecenie — decyduje o normie godzin i wliczaniu L4"
                    />
                    <Th tip="Zgłoszenie decydujące o gałęzi kalkulacji: ZUA = umowa główna (godziny do maks), ZZA = nadwyżka ponad normę umowy głównej">
                      Zgłoszenie
                    </Th>
                    <SortTh
                      label="Maks godzin"
                      sortKey="maksGodziny"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Limit godzin: ręczne nadpisanie → indywidualne GODZINY MAKS z wpisów godzin (przy UoP, największy wpis) → norma miesiąca z zakładki Normy"
                    />
                    <SortTh
                      label="Faktyczne godziny"
                      sortKey="faktGodziny"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Godziny do rozliczenia: ZUA = min(wypracowane + UW (+ L4 przy UoP), maks); ZZA = nadwyżka ponad normę UoP (gdy pracownik ma umowę o pracę) albo ponad maks. Ręczne nadpisanie ma pierwszeństwo"
                    />
                    <Th
                      tip="Godziny dodatku = wypracowane + UW (+ L4 przy UoP lub zleceniu w ALFA) − maks godziny; liczone tylko gdy umowa ma ustawiony dodatek"
                      className="text-right"
                    >
                      Godziny dodatku
                    </Th>
                    <SortTh
                      label="Stawka netto"
                      sortKey="stawkaNetto"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Stawka netto = kwota główna NETTO ÷ fakt godziny"
                    />
                    <SortTh
                      label="Kwota główna netto"
                      sortKey="kwotaGlowna"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Kwota główna NETTO (na rękę) — wpisywana ręcznie z zestawienia od księgowości. Kadry nie znają kwot brutto: księgowość podaje tu wyłącznie kwoty do wypłaty. Kanał wypłaty ustawia umowa."
                    />
                    {editMode && (
                      <Th
                        tip="Stawka NETTO za godzinę dodatku (zł/h na rękę); pusta → używana stawka netto z wypłaty głównej"
                        className="text-right"
                      >
                        Stawka dodatku netto
                      </Th>
                    )}
                    <SortTh
                      label="Wyrównanie netto"
                      sortKey="kwotaWyrownania"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip={
                        editMode
                          ? "Wyrównanie stawki (zł/h) — kwota wyrównania = wyrównanie × fakt godziny"
                          : "Kwota wyrównania = wyrównanie stawki (zł/h, wpisywane ręcznie) × fakt godziny"
                      }
                    />
                    <Th
                      tip="Kwota dodatku = godziny dodatku × stawka dodatku (gdy brak stawki dodatku — stawka netto z wypłaty głównej); ręczne nadpisanie ma pierwszeństwo"
                      className="text-right"
                    >
                      Kwota dodatku netto
                    </Th>
                    <Th
                      tip="Premia/potrącenie = suma DODATKI − POTRĄCENIA z wpisów godzin miesiąca; przypisywana raz na pracownika (do pierwszej umowy nie-ZZA)"
                      className="text-right"
                    >
                      Premia / potrącenie netto
                    </Th>
                    <SortTh
                      label="Dodatek finalny netto"
                      sortKey="dodatekFinalny"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Dodatek finalny = kwota dodatku + premia/potrącenie + kwota wyrównania"
                    />
                    <SortTh
                      label="Przelew netto"
                      sortKey="przelew"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Przelew = kwota główna (gdy Główna=przelew) + dodatek finalny (gdy kanał dodatku=przelew; przy braku dodatku — kanałem wypłaty głównej). Poprawka względem Excela: premia bez dodatku nie przepada"
                    />
                    <SortTh
                      label="Gotówka netto"
                      sortKey="gotowka"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Gotówka = kwota główna (gdy Główna=gotówka) + dodatek finalny (gdy kanał dodatku=gotówka; przy braku dodatku — kanałem wypłaty głównej)"
                    />
                    <SortTh
                      label="Wypłata netto"
                      sortKey="wyplata"
                      sort={sort}
                      dir={dir}
                      onSort={toggleSort}
                      testIdPrefix="kadry-wynagrodzenia-sort"
                      align="right"
                      tip="Wypłata całkowita = przelew + gotówka"
                    />
                    <Th tip="Rodzaj dodatku z umowy — decyduje o godzinach dodatku i kanale ich wypłaty">
                      Rodzaj dodatku
                    </Th>
                    {editMode && <Th className="w-12" />}
                  </tr>
                </thead>
                <tbody ref={payrollBodyRef}>
                  {loading || visible.length === 0 ? (
                    <EmptyRow
                      colSpan={colCount}
                      loading={loading}
                      icon={Wallet}
                      title={
                        filtersActive
                          ? "Brak wypłat dla wybranych filtrów"
                          : "Brak umów w tym miesiącu"
                      }
                      description={
                        filtersActive
                          ? "Zdejmij filtry albo zmień szukajkę."
                          : "Wypłaty liczą się z umów — dodaj je w zakładce Pracownicy."
                      }
                    />
                  ) : (
                    renderRows.map((item) => {
                      if (item.kind === "person") return personRow(item.group);
                      const { row: r, cellIndex: idx, grouped, nested } = item;
                      // Wiersz osoby z działu, którego sekcja trzyma
                      // rezerwację: wygaszony i nieklikalny, a kliknięcie
                      // proponuje prośbę o zwolnienie TEGO działu.
                      const rowLock = rowLockOf(lock, r.employeeId);
                      return (
                        <tr
                          key={r.contractId}
                          aria-disabled={rowLock ? true : undefined}
                          {...(rowLock ? tip(rowLockHint(rowLock)) : {})}
                          onPointerDownCapture={
                            rowLock
                              ? (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  lock.askFor(rowLock.portal);
                                }
                              : undefined
                          }
                          className={cn(
                            "group border-b bg-background hover:bg-accent/50",
                            grouped && "border-t-0",
                            nested && "bg-muted/30",
                            !editMode && editable && !rowLock && "cursor-pointer",
                            rowLock &&
                              "cursor-not-allowed opacity-50 [&_button]:pointer-events-none [&_input]:pointer-events-none [&_select]:pointer-events-none",
                          )}
                          onClick={
                            !editMode && editable && !rowLock
                              ? () => onOpenPayrollDialog(r, visible)
                              : undefined
                          }
                        >
                          <td
                            className={cn(
                              "whitespace-nowrap px-3 py-2 font-medium",
                              stickyName,
                              grouped && "font-normal text-muted-foreground",
                              // Umowa pod rozwiniętą osobą: wcięcie i lżejszy
                              // tekst, bo nazwisko stoi już w wierszu wyżej.
                              nested && "pl-9 font-normal text-muted-foreground",
                            )}
                          >
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
                          {markedCell(
                            hrs(r.maksGodziny),
                            r.maxHoursSource === "override"
                              ? "override"
                              : r.maxHoursSource === "individual"
                                ? "computed"
                                : null,
                            r.maxHoursSource === "override"
                              ? `Nadpisane ręcznie: ${hrs(r.maksGodziny)} h · wyliczone: ${hrs(
                                  r.computedMaksGodziny,
                                )} h (${MAX_SOURCE_LABEL[r.computedMaxHoursSource]})`
                              : r.maxHoursSource === "individual"
                                ? `Wyliczone automatycznie: ${hrs(r.maksGodziny)} h (indywidualne godziny maks z wpisów godzin)`
                                : `Norma miesiąca: ${hrs(r.maksGodziny)} h`,
                          )}
                          {markedCell(
                            hrs(r.faktGodziny),
                            r.inputs.actualHoursOverride != null ? "override" : null,
                            r.inputs.actualHoursOverride != null
                              ? `Nadpisane ręcznie: ${hrs(r.faktGodziny)} h · wyliczone: ${
                                  r.computedFaktGodziny != null
                                    ? `${hrs(r.computedFaktGodziny)} h`
                                    : "—"
                                } (${FAKT_BASIS_LABEL[r.registration ?? "none"]})`
                              : `Godziny do rozliczenia: ${hrs(r.faktGodziny)} h (${
                                  FAKT_BASIS_LABEL[r.registration ?? "none"]
                                })`,
                            "font-medium",
                          )}
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.godzinyDodatek ? hrs(r.godzinyDodatek) : ""}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.stawkaNetto != null ? hrs(r.stawkaNetto) : ""}
                          </td>
                          {editMode ? (
                            payrollCell(
                              r,
                              idx,
                              "mainAmount",
                              "font-medium",
                              prevHint(r),
                            )
                          ) : (
                            <td className="px-3 py-2 text-right tabular-nums">
                              {r.kwotaGlowna != null ? money(r.kwotaGlowna) : ""}
                              {prevHint(r)}
                            </td>
                          )}
                          {editMode && payrollCell(r, idx, "bonusRate")}
                          {editMode ? (
                            payrollCell(r, idx, "rateAdjustment")
                          ) : (
                            <td className="px-3 py-2 text-right tabular-nums">
                              {r.kwotaWyrownania != null
                                ? money(r.kwotaWyrownania)
                                : ""}
                            </td>
                          )}
                          {editMode ? (
                            payrollCell(r, idx, "bonusAmountOverride")
                          ) : r.bonusPending ? (
                            <td className="px-3 py-2 text-right tabular-nums">
                              <span className={TEXT_TONE.warn}>
                                do przeliczenia
                              </span>
                            </td>
                          ) : r.inputs.bonusAmountOverride != null ? (
                            markedCell(
                              money(r.kwotaDodatku),
                              "override",
                              `Nadpisane ręcznie: ${money(r.kwotaDodatku)} · wyliczone: ${
                                r.computedKwotaDodatku != null
                                  ? money(r.computedKwotaDodatku)
                                  : "—"
                              } (godziny dodatku × stawka dodatku)`,
                            )
                          ) : (
                            <td className="px-3 py-2 text-right tabular-nums">
                              {r.kwotaDodatku != null ? money(r.kwotaDodatku) : ""}
                            </td>
                          )}
                          <td
                            className={cn(
                              "px-3 py-2 text-right tabular-nums",
                              (r.premiaPotracenie ?? 0) < 0 && TEXT_TONE.bad,
                            )}
                          >
                            {r.premiaPotracenie != null
                              ? money(r.premiaPotracenie)
                              : ""}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.dodatekFinalny != null
                              ? money(r.dodatekFinalny)
                              : ""}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.przelew ? money(r.przelew) : ""}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.gotowka ? money(r.gotowka) : ""}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {r.wyplata ? money(r.wyplata) : ""}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {BONUS_SHORT[r.bonusType]}
                          </td>
                          {editMode && (
                            <td className="px-1 py-1">
                              <RowActions className="gap-0.5">
                                <IconButton
                                  icon={MoreHorizontal}
                                  label="Nadpisania, notatka i podgląd kalkulacji"
                                  testId="kadry-wynagrodzenia-row-more"
                                  onClick={() => onOpenPayrollDialog(r, visible)}
                                />
                                {/* Wypłaty: encją jest UMOWA, wpisy są per miesiąc. */}
                                <EntityHistory
                                  entityType="hr_payroll"
                                  entityId={r.contractId}
                                  period={ymKey(year, month)}
                                  title={r.employeeName}
                                />
                              </RowActions>
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
                {visible.length > 0 && (
                  <tfoot>
                    <tr className={TFOOT_ROW_CLS}>
                      <td className="px-3 py-2" colSpan={editMode ? 14 : 13}>
                        {/* Te same liczby w obu widokach — zmienia się tylko
                            to, ILE WIERSZY je daje. */}
                        {view === "osoby"
                          ? `Razem (${peopleLabel(personGroups.length)}, ${contractsLabel(visible.length)})`
                          : `Razem (${visible.length})`}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(sumPrzelew)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(sumGotowka)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(sumPrzelew + sumGotowka)}
                      </td>
                      <td colSpan={editMode ? 2 : 1} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </CardContent>
          </Card>
          {/* Legenda kolorów zamiast legendy gwiazdki: kropka w tym samym
              kolorze, co liczba w tabeli, a „ile wyszłoby z wyliczenia" mówi
              dymek przy samej liczbie. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <ToneLegend
              testId="kadry-wynagrodzenia-legenda"
              items={[
                {
                  tone: TEXT_TONE.override,
                  label: "nadpisane ręcznie",
                  hint: "Ktoś wpisał tę wartość wbrew wyliczeniu — dymek przy liczbie pokazuje obie",
                },
                {
                  tone: TEXT_TONE.computed,
                  label: "wyliczone automatycznie",
                  hint: "Wartość spoza tej kolumny — indywidualne godziny maks z wpisów godzin",
                },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {editMode
                ? "Kwoty wpisujesz wprost w tabeli; przycisk „…” w wierszu otwiera nadpisania i notatkę."
                : "Kliknij wiersz, aby wpisać kwotę od księgowości, stawkę dodatku lub nadpisania."}
            </p>
          </div>
        </>
      )}

      {/* ---------- STAŁE (biuro) ---------- */}
      {/* Rozliczenie pracowników biura tego samego miesiąca. Liczy się inaczej
          niż ochrona (kwota z godzin × stawki, rozbicie ROR/gotówka), więc ma
          własną tabelę — a od czasu podzakładek własny ekran, zamiast wisieć
          pod 147 wierszami wypłat. */}
      {list === "stale" && (
        <>
        {/* Rezerwacja rozliczenia biura — osobna od listy wypłat, bo wypełnia je
            zwykle kto inny (i nie ma powodu, żeby czekali na siebie). */}
        <EditLockBar
          lock={officeLock}
          onRelease={() => rememberOfficeEditMode(false)}
          testId="kadry-biuro-lock-bar"
        />
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table
              className={cn(
                "w-full text-sm",
                officeEditMode ? "min-w-[1280px]" : "min-w-[1180px]",
              )}
            >
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
                    Godziny etatu
                  </Th>
                  <Th tip="Urlop wypoczynkowy i chorobowe (godziny)" className="text-right">
                    Urlop / chorobowe
                  </Th>
                  <SortTh
                    label="Godziny do księgowej"
                    sortKey="hoursForAccounting"
                    sort={officeSort}
                    dir={officeDir}
                    onSort={toggleOfficeSort}
                    testIdPrefix="kadry-biuro-sort"
                    align="right"
                    tip="Godziny do księgowej — dla rozliczanych godzinowo (UZ)"
                  />
                  <SortTh
                    label="Stawka netto"
                    sortKey="rate"
                    sort={officeSort}
                    dir={officeDir}
                    onSort={toggleOfficeSort}
                    testIdPrefix="kadry-biuro-sort"
                    align="right"
                    tip="Stawka godzinowa NETTO (zł/h na rękę) — kwoty biura, jak cała kartoteka, przychodzą od księgowości jako netto"
                  />
                  <Th
                    tip="Kwota wypłaty NETTO: ręczna, a gdy pusta — godziny do księgowej × stawka netto"
                    className="text-right"
                  >
                    Kwota netto
                  </Th>
                  <Th
                    tip="Podstawa ROR — część kwoty netto idąca przelewem na rachunek (podaje księgowość)"
                    className="text-right"
                  >
                    Podstawa ROR netto
                  </Th>
                  <Th
                    tip="Delegacje/gotówka NETTO: ręczna, a gdy pusta — kwota netto − podstawa ROR (gdy dodatnia)"
                    className="text-right"
                  >
                    Delegacje / gotówka netto
                  </Th>
                  <SortTh
                    label="Razem netto"
                    sortKey="total"
                    sort={officeSort}
                    dir={officeDir}
                    onSort={toggleOfficeSort}
                    testIdPrefix="kadry-biuro-sort"
                    align="right"
                    tip="Razem netto = podstawa ROR + delegacje/gotówka — kwota, którą pracownik biura dostaje na rękę"
                  />
                  <Th className="w-20" />
                </tr>
              </thead>
              <tbody ref={officeBodyRef}>
                {officeVisible.length === 0 ? (
                  <EmptyRow
                    colSpan={11}
                    loading={loading}
                    icon={Building2}
                    title={
                      filtersActive
                        ? "Brak wpisów biura dla wybranych filtrów"
                        : "Brak wpisów biura w tym miesiącu"
                    }
                    description={
                      filtersActive
                        ? "Zdejmij filtry albo zmień szukajkę."
                        : "Wpisy biura można przenieść z poprzedniego miesiąca przyciskiem nad tabelą."
                    }
                  />
                ) : (
                  officeVisible.map((r, idx) => {
                    const rowLock = rowLockOf(officeLock, r.employeeId);
                    return (
                    <tr
                      key={r.id}
                      aria-disabled={rowLock ? true : undefined}
                      {...(rowLock ? tip(rowLockHint(rowLock)) : {})}
                      onPointerDownCapture={
                        rowLock
                          ? (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              officeLock.askFor(rowLock.portal);
                            }
                          : undefined
                      }
                      className={cn(
                        "group border-b hover:bg-accent/50",
                        !officeEditMode && editable && !rowLock && "cursor-pointer",
                        rowLock &&
                          "cursor-not-allowed opacity-50 [&_button]:pointer-events-none [&_input]:pointer-events-none [&_select]:pointer-events-none",
                      )}
                      onClick={
                        !officeEditMode && editable && !rowLock
                          ? () => onOfficeEdit(r)
                          : undefined
                      }
                    >
                      <td className="whitespace-nowrap px-3 py-2 font-medium">
                        {r.employeeName}
                      </td>
                      {/* „ALFA ETAT”, „ALFA UZ”, „CONTROL ETAT” to spółka
                          RAZEM Z FORMĄ zatrudnienia — tak podaje je księgowość
                          i tak są zapisane w bazie. W słowniku /companies takich
                          pozycji nie ma, więc bez wyjaśnienia wyglądają jak
                          literówka albo nieistniejąca spółka. */}
                      <td className="px-3 py-2">
                        {r.company ? (
                          <span className="cursor-help" {...tip(companyHint(r.company))}>
                            {r.company}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.etatHours != null ? hrs(r.etatHours) : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.uwL4 != null ? hrs(r.uwL4) : ""}
                      </td>
                      {officeEditMode ? (
                        officeCell(r, idx, "hoursForAccounting")
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.hoursForAccounting != null
                            ? hrs(r.hoursForAccounting)
                            : ""}
                        </td>
                      )}
                      {officeEditMode ? (
                        officeCell(r, idx, "rate")
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.rate != null ? hrs(r.rate) : ""}
                        </td>
                      )}
                      {officeEditMode ? (
                        officeCell(r, idx, "amount")
                      ) : r.amount == null && r.amountComputed != null ? (
                        markedCell(
                          money(r.amountComputed),
                          "computed",
                          `Wyliczone automatycznie: ${money(r.amountComputed)} (godziny do księgowej × stawka netto)`,
                        )
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.amountComputed != null ? money(r.amountComputed) : ""}
                        </td>
                      )}
                      {officeEditMode ? (
                        officeCell(r, idx, "rorBase")
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.rorBase != null ? money(r.rorBase) : ""}
                        </td>
                      )}
                      {officeEditMode ? (
                        officeCell(r, idx, "cashOverride")
                      ) : r.cashOverride == null && r.cash != null ? (
                        markedCell(
                          money(r.cash),
                          "computed",
                          `Wyliczone automatycznie: ${money(r.cash)} (kwota netto − podstawa ROR)`,
                        )
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.cash != null ? money(r.cash) : ""}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {r.total ? money(r.total) : ""}
                      </td>
                      <td className="px-3 py-2">
                        <RowActions>
                          {/* Historia wiersza: odczyt, więc bez bramki `editable`. */}
                          <EntityHistory
                            entityType="hr_office"
                            entityId={r.id}
                            period={ymKey(year, month)}
                            title={` — `}
                          />
                          {editable && (
                            <>
                              <IconButton
                                icon={Pencil}
                                label="Otwórz formularz wpisu"
                                onClick={() => onOfficeEdit(r)}
                              />
                              <IconButton
                                icon={Trash2}
                                danger
                                label="Usuń wpis"
                                onClick={() => onOfficeDelete(r)}
                              />
                            </>
                          )}
                        </RowActions>
                      </td>
                    </tr>
                    );
                  })
                )}
              </tbody>
              {/* Sumy liczą PRZEFILTROWANY zbiór — stopka ma podsumowywać to,
                  co widać nad nią, a nie cały miesiąc. */}
              {officeVisible.length > 0 && (
                <tfoot>
                  <tr className={TFOOT_ROW_CLS}>
                    <td className="px-3 py-2" colSpan={7}>
                      Razem ({officeVisible.length})
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(officeVisible.reduce((s, r) => s + (r.rorBase ?? 0), 0))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(officeVisible.reduce((s, r) => s + (r.cash ?? 0), 0))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(officeVisible.reduce((s, r) => s + r.total, 0))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <ToneLegend
            testId="kadry-biuro-legenda"
            items={[
              {
                tone: TEXT_TONE.computed,
                label: "wyliczone automatycznie",
                hint: "Kwota z godzin × stawki, gotówka z kwoty − podstawy ROR; dymek przy liczbie pokazuje, z czego wyszła",
              },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {officeEditMode
              ? "Godziny, stawki i kwoty wpisujesz wprost w tabeli — pusta kwota liczy się z godzin i stawki."
              : "Kliknij wiersz, aby otworzyć formularz wpisu biura."}
          </p>
        </div>
        </>
      )}

      {pasteOpen && (
        <PasteAmountsDialog
          open
          onClose={() => setPasteOpen(false)}
          rows={rows}
          year={year}
          month={month}
          onSaved={(saved, savedRows) => {
            setPasteInfo(
              saved === 0
                ? "Wklejone kwoty niczego nie zmieniły — były już zapisane."
                : `Zapisano kwoty dla ${saved} umów.`,
            );
            for (const row of savedRows) onRowSaved(row);
          }}
        />
      )}
    </>
  );
}

/**
 * Menu wydruków — jeden przycisk w pasku zamiast czterech.
 *
 * Własny panel, a nie komponent z `ui/`: w bibliotece nie ma `dropdown-menu`,
 * a dokładanie zależności Radiksa pod pięć pozycji byłoby nieproporcjonalne.
 * Zachowanie jak w popoverach kalendarza: zamyka się kliknięciem poza panelem
 * i Escape, pozycja `absolute` względem przycisku, `role="menu"`.
 *
 * Licznik „(N z M)" stoi na PRZYCISKU, nie w menu: informacja „wydruk obejmie
 * mniej niż całość" musi być widoczna, zanim ktoś otworzy listę wydruków.
 */
function PrintMenu({
  visibleCount,
  totalCount,
  items,
}: {
  visibleCount: number;
  totalCount: number;
  items: {
    key: string;
    icon: LucideIcon;
    label: string;
    hint: string;
    /** Pozycja bez treści do wydrukowania — wyszarzona, ale wciąż z powodem. */
    disabled?: boolean;
    /** Powód wyszarzenia; pokazuje się i w dymku, i po kliknięciu (inline). */
    disabledHint?: string;
    onSelect: () => void;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const partial = visibleCount !== totalCount;

  return (
    <div className="relative" ref={boxRef}>
      <Button
        variant={open ? "secondary" : "outline"}
        size="sm"
        className={TOOLBAR_BTN_CLS}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        data-testid="kadry-wynagrodzenia-print"
        {...tip(
          partial
            ? `Filtry aktywne — wydruki obejmą ${visibleCount} z ${totalCount} wierszy`
            : "Wydruki miesiąca: zestawienie dla księgowości, listy wypłat, CSV do bankowości",
        )}
      >
        <Printer className="mr-1 h-4 w-4" />
        Wydruki
        {partial && (
          <span className={cn("ml-1 tabular-nums", TEXT_TONE.warn)}>
            ({visibleCount}/{totalCount})
          </span>
        )}
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-80 rounded-md border bg-popover p-1 shadow-lg"
          data-testid="kadry-wynagrodzenia-print-menu"
        >
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                data-testid={`kadry-wynagrodzenia-print-${it.key}`}
                // `aria-disabled`, nie `disabled`: wyłączony przycisk nie
                // przyjmuje kursora, więc dymek z powodem — jedyne miejsce,
                // gdzie piszemy DLACZEGO nie da się kliknąć — nigdy by się
                // nie pokazał. Kliknięcie i tak kończy się komunikatem.
                aria-disabled={it.disabled || undefined}
                data-disabled={it.disabled ? "true" : undefined}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={cn(
                  "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  it.disabled && "opacity-50",
                )}
                {...(it.disabled && it.disabledHint ? tip(it.disabledHint) : {})}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{it.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {it.disabled && it.disabledHint ? it.disabledHint : it.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
