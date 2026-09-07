import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RealizationForm } from "@/components/RealizationForm";
import { AutoBadge, AutofillDialog } from "@/components/realization/AutofillDialog";
import { autofillFieldsFor, markAutofilled } from "@/components/realization/autofill-marks";
import { RealizationsMap } from "@/components/realization/RealizationsMap";
import { TechnicianForm } from "@/components/TechnicianForm";
import { TechnicalObjects } from "@/components/TechnicalObjects";
import { PriceListTab } from "@/components/pricelist/PriceListTab";
import { ProtocolForm } from "@/components/ProtocolForm";
import { QuoteForm } from "@/components/QuoteForm";
import { printProtocol } from "@/lib/protocolPrint";
import { printQuote } from "@/lib/quotePrint";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  Plus,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileCheck2,
  FilePlus,
  FileX,
  Pencil,
  Trash2,
  Printer,
  Wand2,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  BILLING_META,
  billingBadgeClass,
  calendarEventHref,
  pillClass,
  protocolBadgeClass,
  protocolHref,
  REALIZATION_BADGE_META,
  realizationBadgeClass,
  REALIZATION_BILLING_ORDER,
  REALIZATION_WORK_TYPE_META,
  REALIZATION_WORK_TYPE_ORDER,
} from "@/lib/calendar-labels";
import { ProtocolBadge } from "@/components/CalendarEventBadges";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  createRealizationProtocol,
  getRealizations,
  getRealizationSummary,
  createRealization,
  updateRealization,
  deleteRealization,
  getTechnicians,
  getHrEmployeeDirectory,
  createTechnician,
  updateTechnician,
  deleteTechnician,
  priceListsApi,
  realizationAutofillApi,
  getProtocols,
  syncProtocols,
  updateProtocol,
  signProtocol,
  unsignProtocol,
  getQuotes,
  createQuote,
  updateQuote,
  deleteQuote,
  type AutofillBulkRow,
  type AutofillMark,
  type AutofillSuggestion,
  type Realization,
  type RealizationBilling,
  type RealizationInput,
  type RealizationSummary,
  type RealizationWorkType,
  type Technician,
  type HrEmployeeRef,
  type TechnicianInput,
  type PriceListGroup,
  type Protocol,
  type ProtocolInput,
  type Quote,
  type QuoteInput,
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

/*
 * FILTRY I SORTOWANIE ZAKŁADEK REALIZACJE / PROTOKOŁY / WYCENY / TECHNICY
 *
 * Wszystko liczymy po stronie klienta: `getRealizations(rok, miesiąc)`,
 * `getProtocols(rok, miesiąc)`, `getQuotes(rok)` i `getTechnicians()` zwracają
 * całe listy (backend ich nie stronicuje), więc nie ma po co dokładać
 * parametrów do API. Z tego samego
 * powodu widełki kwot idą bez debounce'u: nie ma żądania do odciążenia, a
 * lista przelicza się w tym samym renderze co wpisana cyfra.
 */

/** Wartość w selekcie oznaczająca „wiersze bez przypisania” (wykonawca, obiekt). */
const NONE = "none";

/** Kwota z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Data z bazy na liczbę do porównań; brak lub śmieć = wartość pusta (NULLS LAST). */
function parseDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** Filtr wartości wyceny: wszystkie / tylko z kwotą / tylko zerowe. */
type ValueMode = "all" | "with" | "without";

/** Filtr świeżości zmiany — wartość to liczba dni wstecz albo „all”. */
type FreshMode = "all" | "7" | "30" | "90";

/** Kolumny, po których da się sortować listę realizacji (te, które są w tabeli). */
type RealizationSortKey =
  | "date"
  | "site"
  | "workType"
  | "billing"
  | "actualHours"
  | "actualKm"
  | "amountHours"
  | "amountMaterial"
  | "amountKm"
  | "discount"
  | "total"
  | "invoiced"
  | "caretaker";

/**
 * Domyślny kierunek kolumny: daty i kwoty malejąco (najnowsze / najdroższe u
 * góry), teksty alfabetycznie, „Zafakt." malejąco — czyli TAK przed NIE.
 */
const REALIZATION_DEFAULT_DIR: Record<RealizationSortKey, "asc" | "desc"> = {
  date: "desc",
  site: "asc",
  workType: "asc",
  billing: "asc",
  actualHours: "desc",
  actualKm: "desc",
  amountHours: "desc",
  amountMaterial: "desc",
  amountKm: "desc",
  discount: "desc",
  total: "desc",
  invoiced: "desc",
  caretaker: "asc",
};

/** Kolumny realizacji sortowane tekstem; reszta idzie przez porównanie liczb. */
const REALIZATION_TEXT_SORT_KEYS = new Set<RealizationSortKey>([
  "site",
  "workType",
  "billing",
  "caretaker",
]);

/** Wymiar wyłączany przy liczeniu chipów — patrz `realizationView`. */
type RealizationFacet = "workType" | "billing" | "protocol";

/**
 * Wykonawca tak, jak widzi go człowiek: kolumna „Wykonawca" pokazuje
 * `contractor1 || caretaker`, więc filtr i sortowanie muszą patrzeć na to samo.
 * Inaczej wiersz opisany samym opiekunem wpadałby do „Bez wykonawcy" mimo
 * nazwiska widocznego w tabeli.
 */
function realizationContractor(r: Realization): string {
  return (r.contractor1 || r.caretaker || "").trim();
}

/** Kolumny, po których da się sortować listę protokołów. */
type ProtocolSortKey =
  | "number"
  | "date"
  | "site"
  | "workType"
  | "contractor"
  | "signature"
  | "status";

/**
 * Domyślny kierunek sortowania kolumny — daty ludzie czytają od najnowszej,
 * teksty alfabetycznie (jak w kartotece obiektów). Numer protokołu koduje rok
 * i miesiąc, więc malejąco = najnowsze u góry.
 */
const PROTOCOL_DEFAULT_DIR: Record<ProtocolSortKey, "asc" | "desc"> = {
  number: "desc",
  date: "desc",
  site: "asc",
  workType: "asc",
  contractor: "asc",
  signature: "desc",
  status: "asc",
};

/** Kolumny, po których da się sortować listę wycen. */
type QuoteSortKey = "number" | "date" | "site" | "address" | "total";

/** Kwoty i daty malejąco (najdroższe/najnowsze u góry), teksty alfabetycznie. */
const QUOTE_DEFAULT_DIR: Record<QuoteSortKey, "asc" | "desc"> = {
  number: "desc",
  date: "desc",
  site: "asc",
  address: "asc",
  total: "desc",
};

/** Kolumny, po których da się sortować listę techników. */
type TechnicianSortKey =
  | "firstName"
  | "lastName"
  | "type"
  | "priceList"
  | "hr"
  | "phone"
  | "email"
  | "company"
  | "nip";

/** Kartoteka osób — same teksty, więc wszystkie kolumny startują alfabetycznie. */
const TECHNICIAN_DEFAULT_DIR: Record<TechnicianSortKey, "asc" | "desc"> = {
  firstName: "asc",
  lastName: "asc",
  type: "asc",
  priceList: "asc",
  hr: "asc",
  phone: "asc",
  email: "asc",
  company: "asc",
  nip: "asc",
};

/** Etykiety statusu protokołu — te same, co plakietki w tabeli. */
const PROTOCOL_STATUS_LABEL: Record<Protocol["status"], string> = {
  draft: "Szkic",
  final: "Zatwierdzony",
};

/** Etykiety rodzaju technika — te same, co plakietki w tabeli. */
const TECHNICIAN_TYPE_LABEL: Record<Technician["type"], string> = {
  internal: "Wewnętrzny",
  external: "Zewnętrzny",
};

/** Obiekt protokołu tak, jak pokazuje go tabela (adres montażu ma pierwszeństwo). */
const protocolSite = (p: Protocol) => (p.installationAddress || p.site || "").trim();

/**
 * Protokół „do uzupełnienia” — szkic bez danych zleceniodawcy. Dokładnie ten
 * warunek zapala plakietkę w kolumnie „Numer”, więc filtr i plakietka zawsze
 * mówią to samo.
 */
const protocolNeedsPrefill = (p: Protocol) =>
  p.status === "draft" && !(p.clientName || "").trim();

/**
 * Ślad automatu dla POJEDYNCZEGO pola (kolumna `autofill` w kształcie mapy).
 * `autofillFieldsFor` mówi tylko, czy pole jest z automatu — to daje jeszcze źródło.
 */
function autofillMarkFor(row: Realization, field: string): AutofillMark | null {
  let raw: unknown = row.autofill;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || Array.isArray(raw) || typeof raw !== "object") return null;
  const mark = (raw as Record<string, AutofillMark>)[field];
  return mark && typeof mark === "object" ? mark : null;
}

/**
 * Rodzaj prac — ikona + etykieta, dokładnie jak przy wydarzeniu kalendarza.
 * Ten sam badge obsługuje rodzaj pracy protokołu (`serwis|montaz|wizja|inne`
 * to podzbiór rodzajów realizacji), więc obie zakładki wyglądają identycznie.
 */
function RealizationWorkTypeBadge({
  workType,
  testIdPrefix = "realization-worktype",
}: {
  workType: RealizationWorkType;
  testIdPrefix?: string;
}) {
  const meta = REALIZATION_WORK_TYPE_META[workType] ?? REALIZATION_WORK_TYPE_META.inne;
  const Icon = meta.icon;
  return (
    <span
      data-testid={`${testIdPrefix}-${workType}`}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        meta.chip
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

/** Typ rozliczenia — ta sama pigułka co przy wydarzeniu (Płatny / Gwarancyjny / Darmowy). */
function RealizationBillingBadge({ billing }: { billing: RealizationBilling }) {
  const meta = BILLING_META[billing] ?? BILLING_META.paid;
  const Icon = meta.icon;
  return (
    <span
      data-testid={`realization-billing-${billing}`}
      className={billingBadgeClass(billing)}
      {...tip(`Rozliczenie: ${meta.label} — ${meta.hint}`)}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

/** Ikona znacznika realizacji (paragon) — ta sama co w kalendarzu. */
const InvoicedIcon = REALIZATION_BADGE_META.invoiced.icon;

const numFmt = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 });

/**
 * Faktyczne godziny / kilometry. Wartość z automatu dostaje różdżkę i tooltip ze
 * źródłem — tak samo jak badge „auto" przy obiekcie, tylko przy konkretnej liczbie.
 */
function ActualValue({
  row,
  field,
  suffix,
}: {
  row: Realization;
  field: "actualHours" | "actualKm";
  suffix: string;
}) {
  const value = Number(row[field] || 0);
  if (!value) return <span className="text-muted-foreground">—</span>;

  const text = `${numFmt.format(value)} ${suffix}`;
  if (!autofillFieldsFor(row).includes(field)) return <>{text}</>;

  const mark = autofillMarkFor(row, field);
  const detail = mark?.detail ? `\n${mark.detail}` : mark?.source ? `\nźródło: ${mark.source}` : "";
  return (
    <span
      data-testid={`realization-${field}-auto-${row.id}`}
      className="inline-flex items-center gap-1 text-primary"
      {...tip(`Uzupełnione automatem${detail}`)}
    >
      <Wand2 className="h-3 w-3" aria-hidden />
      {text}
    </span>
  );
}

/** Filtr obecności protokołu w tabeli realizacji. */
type RealizationProtocolFilter = "" | "with" | "without";

/**
 * Kształt oczekiwany przez `ProtocolBadge` (wspólny z kalendarzem). Realizacja
 * nie ma typu/statusu wydarzenia — podstawiamy „wykonany serwis", żeby helper
 * `protocolBadgeKind` rozstrzygnął tylko po polu `protocol`.
 */
const protocolBadgeEvent = (protocol: Realization["protocol"]) => ({
  type: "serwis",
  status: "done",
  protocol,
});

const pln = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});
const money = (v: number | null | undefined) => pln.format(Number(v || 0));

const TECH_TABS = [
  "realizacje",
  "protokoly",
  "wyceny",
  "cennik",
  "technicy",
  "obiekty",
] as const;

export function Technical() {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canEdit } = usePerms();
  const editable = canEdit(`technical/${tab}`);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [rows, setRows] = useState<Realization[]>([]);
  const [summary, setSummary] = useState<RealizationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Realization | null>(null);
  /** Wiersz wskazany deep-linkiem `?realization=ID` — podświetlany na chwilę. */
  const [highlightRow, setHighlightRow] = useState<number | null>(null);
  /** Filtr kolumny Protokół (wszystkie / z protokołem / bez protokołu). */
  const [protoFilter, setProtoFilter] = useState<RealizationProtocolFilter>("");
  /** Filtr kolumny Rodzaj (serwis / montaż / …); "" = bez filtra. */
  const [workTypeFilter, setWorkTypeFilter] = useState<RealizationWorkType | "">("");
  /** Filtr kolumny Typ (płatny / gwarancyjny / darmowy); "" = bez filtra. */
  const [billingFilter, setBillingFilter] = useState<RealizationBilling | "">("");
  // Reszta filtrów i sortowanie zakładki Realizacje (client-side, patrz
  // komentarz przy REALIZATION_DEFAULT_DIR).
  const [realSearch, setRealSearch] = useState("");
  const [realInvoicedFilter, setRealInvoicedFilter] = useState("all");
  const [realContractorFilter, setRealContractorFilter] = useState("all");
  const [realSiteFilter, setRealSiteFilter] = useState("all");
  const [realObjectFilter, setRealObjectFilter] = useState("all");
  const [realValueMode, setRealValueMode] = useState<ValueMode>("all");
  const [realMinInput, setRealMinInput] = useState("");
  const [realMaxInput, setRealMaxInput] = useState("");
  const [realSort, setRealSort] = useState<RealizationSortKey>("date");
  const [realDir, setRealDir] = useState<"asc" | "desc">("desc");

  /**
   * Zdejmuje WSZYSTKIE filtry realizacji (także chipy rodzaju/typu/protokołu).
   * Wysoko w pliku, bo korzysta z niej też deep-link `?realization=ID` —
   * wskazany wiersz musi być widoczny, choćby filtry mówiły inaczej.
   */
  const clearRealFilters = useCallback(() => {
    setRealSearch("");
    setWorkTypeFilter("");
    setBillingFilter("");
    setProtoFilter("");
    setRealInvoicedFilter("all");
    setRealContractorFilter("all");
    setRealSiteFilter("all");
    setRealObjectFilter("all");
    setRealValueMode("all");
    setRealMinInput("");
    setRealMaxInput("");
  }, []);
  /** Id realizacji, dla której trwa tworzenie protokołu (spinner w wierszu). */
  const [creatingProtoFor, setCreatingProtoFor] = useState<number | null>(null);
  const [syncProtoOpen, setSyncProtoOpen] = useState(false);
  const [syncingProtos, setSyncingProtos] = useState(false);
  /** Realizacja, dla której otwarto automat prosto z tabeli (bez formularza). */
  const [autofillRow, setAutofillRow] = useState<Realization | null>(null);
  /** Masowe uzupełnianie widocznego miesiąca: podgląd → potwierdzenie. */
  const [bulk, setBulk] = useState<AutofillBulkRow[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState<"preview" | "apply" | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  /** Co automat zrobił po podpisaniu protokołu (uzupełnienie realizacji, wycena z protokołu). */
  const [signNote, setSignNote] = useState<string | null>(null);

  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [techLoading, setTechLoading] = useState(true);
  const [techFormOpen, setTechFormOpen] = useState(false);
  const [editingTech, setEditingTech] = useState<Technician | null>(null);
  const [techView, setTechView] = useState<"active" | "archived">("active");
  // Filtry i sortowanie zakładki Technicy (client-side). Podział na aktywnych
  // i archiwalnych zostaje na zakładkach — filtry działają wewnątrz obu.
  const [techSearch, setTechSearch] = useState("");
  const [techTypeFilter, setTechTypeFilter] = useState("all");
  const [techPriceListFilter, setTechPriceListFilter] = useState("all");
  const [techHrFilter, setTechHrFilter] = useState("all");
  const [techSort, setTechSort] = useState<TechnicianSortKey>("lastName");
  const [techDir, setTechDir] = useState<"asc" | "desc">("asc");

  /** Kartoteka kadrowa — lista wyboru „Pracownik w kadrach" w formularzu technika. */
  const [hrEmployees, setHrEmployees] = useState<HrEmployeeRef[]>([]);

  /** Cenniki — do kolumny „Cennik" w tabeli techników i selecta w formularzu. */
  const [priceLists, setPriceLists] = useState<PriceListGroup[]>([]);
  /** Cennik wybrany do prefillu nowej wyceny (0 = główny). */
  const [quotePriceListId, setQuotePriceListId] = useState(0);

  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [protoLoading, setProtoLoading] = useState(true);
  const [editingProto, setEditingProto] = useState<Protocol | null>(null);
  // Filtry i sortowanie zakładki Protokoły (client-side, patrz komentarz przy
  // PROTOCOL_DEFAULT_DIR).
  const [protoSearch, setProtoSearch] = useState("");
  const [protoStatusFilter, setProtoStatusFilter] = useState("all");
  const [protoWorkTypeFilter, setProtoWorkTypeFilter] = useState("all");
  const [protoSiteFilter, setProtoSiteFilter] = useState("all");
  const [protoContractorFilter, setProtoContractorFilter] = useState("all");
  const [protoSignFilter, setProtoSignFilter] = useState("all");
  const [protoPrefillFilter, setProtoPrefillFilter] = useState("all");
  const [protoSort, setProtoSort] = useState<ProtocolSortKey>("number");
  const [protoDir, setProtoDir] = useState<"asc" | "desc">("desc");

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null);
  // Filtry i sortowanie zakładki Wyceny (client-side).
  const [quoteSearch, setQuoteSearch] = useState("");
  const [quoteSiteFilter, setQuoteSiteFilter] = useState("all");
  const [quoteSourceFilter, setQuoteSourceFilter] = useState("all");
  const [quoteValueMode, setQuoteValueMode] = useState<ValueMode>("all");
  const [quoteMinInput, setQuoteMinInput] = useState("");
  const [quoteMaxInput, setQuoteMaxInput] = useState("");
  const [quoteFreshMode, setQuoteFreshMode] = useState<FreshMode>("all");
  const [quoteSort, setQuoteSort] = useState<QuoteSortKey>("number");
  const [quoteDir, setQuoteDir] = useState<"asc" | "desc">("desc");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, summaryRes] = await Promise.all([
        getRealizations(year, month),
        getRealizationSummary(year, month),
      ]);
      setRows(listRes.data || []);
      setSummary(summaryRes.data || null);
    } catch (error) {
      console.error("Error loading realizations:", error);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    load();
  }, [load]);

  const loadTechnicians = useCallback(async () => {
    setTechLoading(true);
    try {
      const res = await getTechnicians();
      setTechnicians(res.data || []);
    } catch (error) {
      console.error("Error loading technicians:", error);
    } finally {
      setTechLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTechnicians();
  }, [loadTechnicians]);

  // Kartoteka kadrowa do pola „Pracownik w kadrach" w formularzu technika.
  // Brak uprawnień do Kadr nie może wywalić zakładki — lista zostaje pusta.
  useEffect(() => {
    getHrEmployeeDirectory()
      .then((res) => setHrEmployees(res.data ?? []))
      .catch(() => setHrEmployees([]));
  }, []);

  const handleTechCreate = async (data: TechnicianInput) => {
    if (!editable) return;
    await createTechnician(data);
    loadTechnicians();
    loadPriceLists(); // odśwież liczniki techników przy cennikach
  };

  const handleTechUpdate = async (data: TechnicianInput) => {
    if (!editable) return;
    if (editingTech) {
      await updateTechnician(editingTech.id, data);
      loadTechnicians();
      loadPriceLists();
    }
  };

  const handleTechDelete = async (tech: Technician) => {
    if (!editable) return;
    if (
      window.confirm(
        `Usunąć technika "${`${tech.firstName} ${tech.lastName}`.trim()}"?`
      )
    ) {
      try {
        await deleteTechnician(tech.id);
        loadTechnicians();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć technika"
        );
      }
    }
  };

  const closeTechForm = () => {
    setTechFormOpen(false);
    setEditingTech(null);
  };

  const openTechEdit = (tech: Technician) => {
    setEditingTech(tech);
    setTechFormOpen(true);
  };

  const renderTechTable = (list: Technician[], emptyText: string) => {
    if (techLoading) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          Ładowanie…
        </div>
      );
    }
    if (list.length === 0) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {techFiltersActive ? "Brak techników dla wybranych filtrów" : emptyText}
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <TechSortHeader label="Imię" sortKey="firstName" />
              <TechSortHeader label="Nazwisko" sortKey="lastName" />
              <TechSortHeader label="Typ" sortKey="type" />
              <TechSortHeader label="Cennik" sortKey="priceList" />
              <TechSortHeader
                label="Kadry"
                sortKey="hr"
                title="Powiązanie z kartoteką kadrową — technicy spoza listy płac idą na koniec"
              />
              <TechSortHeader label="Telefon" sortKey="phone" />
              <TechSortHeader label="E-mail" sortKey="email" />
              <TechSortHeader label="Firma" sortKey="company" />
              <TechSortHeader label="NIP" sortKey="nip" />
              <th className="px-3 py-2 font-medium">Notatka</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {list.map((tech) => (
              <tr
                key={tech.id}
                className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                onClick={() => openTechEdit(tech)}
              >
                <td className="px-3 py-2">{tech.firstName || "—"}</td>
                <td className="px-3 py-2 font-medium">{tech.lastName}</td>
                <td className="px-3 py-2">
                  {tech.type === "external" ? (
                    <span className={pillClass("sky")}>Zewnętrzny</span>
                  ) : (
                    <span className={pillClass("emerald")}>Wewnętrzny</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {tech.priceListId ? (
                    <span
                      className={pillClass("muted", { className: "max-w-40 truncate" })}
                    >
                      {priceListLabel(tech.priceListId)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Główny</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {tech.employeeId ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs"
                      title={`Na liście płac: ${tech.employeeName ?? "pracownik kadr"}`}
                    >
                      <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                      {tech.employeeName || "powiązany"}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {tech.phone || "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {tech.email ? (
                    <a
                      href={`mailto:${tech.email}`}
                      className="text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {tech.email}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td
                  className="max-w-48 truncate px-3 py-2"
                  title={tech.company || undefined}
                >
                  {tech.company || "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {tech.nip || "—"}
                </td>
                <td
                  className="max-w-72 truncate px-3 py-2 text-muted-foreground"
                  title={tech.notes || undefined}
                >
                  {tech.notes || "—"}
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
                        className="h-8 w-8"
                        onClick={() => openTechEdit(tech)}
                        title="Edytuj"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleTechDelete(tech)}
                        title="Usuń"
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
    );
  };

  // --- Cennik ---
  // Cała zakładka „Cennik" (lista cenników + pozycje + przypisania techników)
  // mieszka w <PriceListTab>; tutaj potrzebne są tylko same cenniki, żeby
  // pokazać kolumnę „Cennik" w tabeli techników i wypełnić select w formularzu.
  const loadPriceLists = useCallback(async () => {
    try {
      const res = await priceListsApi.list();
      setPriceLists(res.data || []);
    } catch (error) {
      console.error("Error loading price lists:", error);
    }
  }, []);

  useEffect(() => {
    loadPriceLists();
  }, [loadPriceLists]);

  /** Nazwa cennika technika („Główny" dla braku przypisania). */
  const priceListLabel = (id: number | null) => {
    if (!id) return "Główny";
    return priceLists.find((l) => l.id === id)?.name ?? "—";
  };

  // --- Technicy: filtry + sortowanie (jeden przebieg, jak w kartotece obiektów) ---
  const visibleTechnicians = useMemo(() => {
    const q = techSearch.trim().toLowerCase();
    const nameOfList = (id: number | null) =>
      id ? (priceLists.find((l) => l.id === id)?.name ?? "—") : "Główny";

    const list = technicians.filter((t) => {
      if (
        q &&
        ![t.firstName, t.lastName, t.phone, t.email, t.company, t.nip, t.notes, t.employeeName]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      ) {
        return false;
      }
      if (techTypeFilter !== "all" && t.type !== techTypeFilter) return false;
      if (techPriceListFilter !== "all") {
        // „main" = technik bez własnego cennika, czyli liczony z cennika głównego.
        if (
          techPriceListFilter === "main"
            ? t.priceListId != null
            : String(t.priceListId ?? "") !== techPriceListFilter
        ) {
          return false;
        }
      }
      if (techHrFilter !== "all") {
        const linked = t.employeeId != null;
        if (techHrFilter === "linked" ? !linked : linked) return false;
      }
      return true;
    });

    const mul = techDir === "asc" ? 1 : -1;
    const text = (t: Technician): string => {
      switch (techSort) {
        case "firstName":
          return t.firstName ?? "";
        case "type":
          return TECHNICIAN_TYPE_LABEL[t.type] ?? "";
        case "priceList":
          return nameOfList(t.priceListId);
        case "hr":
          // Kolumna „Kadry" pokazuje nazwisko z listy płac; brak powiązania to
          // kreska, czyli wartość pusta.
          return t.employeeId ? (t.employeeName || "powiązany") : "";
        case "phone":
          return t.phone ?? "";
        case "email":
          return t.email ?? "";
        case "company":
          return t.company ?? "";
        case "nip":
          return t.nip ?? "";
        default:
          return t.lastName ?? "";
      }
    };

    // Puste teksty lądują na końcu w OBU kierunkach (jak NULLS LAST w sortowaniu
    // obiektów) — inaczej „sortuj po firmie" zaczynałoby się od techników
    // wewnętrznych bez firmy. Remis rozstrzyga nazwisko i imię.
    const compare = (a: Technician, b: Technician): number => {
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };
    const fullName = (t: Technician) => `${t.lastName} ${t.firstName}`.trim();

    return list.sort(
      (a, b) => compare(a, b) || fullName(a).localeCompare(fullName(b), "pl")
    );
  }, [
    technicians,
    priceLists,
    techSearch,
    techTypeFilter,
    techPriceListFilter,
    techHrFilter,
    techSort,
    techDir,
  ]);

  // Liczniki na zakładkach biorą się z tej samej listy, co tabela, więc
  // „Aktywni (3)" zawsze zgadza się z tym, co widać pod spodem.
  const activeTechnicians = visibleTechnicians.filter((t) => t.active);
  const archivedTechnicians = visibleTechnicians.filter((t) => !t.active);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleTechSort = (key: TechnicianSortKey) => {
    if (techSort === key) {
      setTechDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setTechSort(key);
    setTechDir(TECHNICIAN_DEFAULT_DIR[key]);
  };

  const techFiltersActive =
    techSearch !== "" ||
    techTypeFilter !== "all" ||
    techPriceListFilter !== "all" ||
    techHrFilter !== "all";

  const clearTechFilters = () => {
    setTechSearch("");
    setTechTypeFilter("all");
    setTechPriceListFilter("all");
    setTechHrFilter("all");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const TechSortHeader = ({
    label,
    sortKey,
    align = "left",
    title,
  }: {
    label: string;
    sortKey: TechnicianSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = techSort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : techDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`technicy-sort-${sortKey}`}
          onClick={() => toggleTechSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          title={title}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            activeCol ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
        </button>
      </th>
    );
  };

  // --- Protokoły (generowane automatycznie z realizacji) ---
  const loadProtocols = useCallback(async () => {
    setProtoLoading(true);
    try {
      // Bez ukrytego POST /protocols/sync przy każdym wejściu: protokół powstaje
      // razem z realizacją (jedna transakcja), a braki w starszych wpisach
      // uzupełnia się świadomie z tabeli realizacji („Utwórz" / „Utwórz brakujące").
      const res = await getProtocols(year, month);
      setProtocols(res.data || []);
    } catch (error) {
      console.error("Error loading protocols:", error);
    } finally {
      setProtoLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    loadProtocols();
  }, [loadProtocols]);

  /**
   * Obiekty i wykonawcy do selectów budujemy Z DANYCH, a nie ze słownika:
   * protokół trzyma migawkę nazwy z dnia prac, więc tylko lista miesiąca wie,
   * po czym faktycznie da się odfiltrować.
   */
  const protocolSites = useMemo(
    () =>
      Array.from(new Set(protocols.map(protocolSite).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b, "pl")
      ),
    [protocols]
  );

  const protocolContractors = useMemo(
    () =>
      Array.from(
        new Set(protocols.map((p) => (p.contractor || "").trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [protocols]
  );

  /** Jeden przebieg: filtry + sortowanie protokołów. */
  const visibleProtocols = useMemo(() => {
    const q = protoSearch.trim().toLowerCase();

    const list = protocols.filter((p) => {
      if (
        q &&
        ![p.number, p.site, p.installationAddress, p.clientName, p.contractor, p.salesperson]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      ) {
        return false;
      }
      if (protoStatusFilter !== "all" && p.status !== protoStatusFilter) return false;
      if (protoWorkTypeFilter !== "all" && p.workType !== protoWorkTypeFilter) return false;
      if (protoSiteFilter !== "all") {
        const site = protocolSite(p);
        if (protoSiteFilter === NONE ? site !== "" : site !== protoSiteFilter) return false;
      }
      if (protoContractorFilter !== "all") {
        const contractor = (p.contractor || "").trim();
        if (
          protoContractorFilter === NONE
            ? contractor !== ""
            : contractor !== protoContractorFilter
        ) {
          return false;
        }
      }
      if (protoSignFilter !== "all") {
        const signed = !!p.signaturePng;
        if (protoSignFilter === "signed" ? !signed : signed) return false;
      }
      if (protoPrefillFilter !== "all") {
        const todo = protocolNeedsPrefill(p);
        if (protoPrefillFilter === "todo" ? !todo : todo) return false;
      }
      return true;
    });

    const mul = protoDir === "asc" ? 1 : -1;
    const text = (p: Protocol): string => {
      switch (protoSort) {
        case "number":
          return p.number ?? "";
        case "site":
          return protocolSite(p);
        case "workType":
          return (
            REALIZATION_WORK_TYPE_META[p.workType] ?? REALIZATION_WORK_TYPE_META.inne
          ).label;
        case "contractor":
          return p.contractor ?? "";
        default:
          return PROTOCOL_STATUS_LABEL[p.status] ?? "";
      }
    };
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (p: Protocol): number | null => {
      if (protoSort === "date") return parseDate(p.workDate);
      // „Podpis": kolumna pokazuje kreskę, dopóki nikt nie podpisał. Starszy
      // podpis bywa bez znacznika czasu — wtedy bierzemy datę zmiany, żeby
      // podpisany protokół nie wylądował wśród niepodpisanych.
      if (!p.signaturePng) return null;
      return parseDate(p.signedAt) ?? parseDate(p.updatedAt);
    };

    const numeric = protoSort === "date" || protoSort === "signature";

    // Puste teksty i brak daty lądują na końcu w OBU kierunkach (jak NULLS LAST
    // w sortowaniu obiektów) — inaczej „sortuj po wykonawcy" zaczynałoby się od
    // protokołów bez wpisanego wykonawcy. Remis rozstrzyga numer.
    const compare = (a: Protocol, b: Protocol): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    return list.sort((a, b) => compare(a, b) || a.number.localeCompare(b.number, "pl"));
  }, [
    protocols,
    protoSearch,
    protoStatusFilter,
    protoWorkTypeFilter,
    protoSiteFilter,
    protoContractorFilter,
    protoSignFilter,
    protoPrefillFilter,
    protoSort,
    protoDir,
  ]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleProtoSort = (key: ProtocolSortKey) => {
    if (protoSort === key) {
      setProtoDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setProtoSort(key);
    setProtoDir(PROTOCOL_DEFAULT_DIR[key]);
  };

  const protoFiltersActive =
    protoSearch !== "" ||
    protoStatusFilter !== "all" ||
    protoWorkTypeFilter !== "all" ||
    protoSiteFilter !== "all" ||
    protoContractorFilter !== "all" ||
    protoSignFilter !== "all" ||
    protoPrefillFilter !== "all";

  const clearProtoFilters = () => {
    setProtoSearch("");
    setProtoStatusFilter("all");
    setProtoWorkTypeFilter("all");
    setProtoSiteFilter("all");
    setProtoContractorFilter("all");
    setProtoSignFilter("all");
    setProtoPrefillFilter("all");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const ProtoSortHeader = ({
    label,
    sortKey,
    align = "left",
    title,
  }: {
    label: string;
    sortKey: ProtocolSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = protoSort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : protoDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`protokoly-sort-${sortKey}`}
          onClick={() => toggleProtoSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          title={title}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            activeCol ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
        </button>
      </th>
    );
  };

  // Deep-link `?protocol=ID` (np. z kalendarza): otwórz formularz protokołu i przewiń do wiersza.
  const deepLinkBusy = useRef(false);
  useEffect(() => {
    const raw = searchParams.get("protocol");
    const id = raw ? Number(raw) : NaN;
    if (!Number.isFinite(id)) return;
    if (tab !== "protokoly") {
      navigate(`/technical/protokoly?protocol=${id}`, { replace: true });
      return;
    }
    if (protoLoading || deepLinkBusy.current) return;
    const clearParam = () => {
      const next = new URLSearchParams(searchParams);
      next.delete("protocol");
      setSearchParams(next, { replace: true });
    };
    const openProto = (proto: Protocol) => {
      setEditingProto(proto);
      window.setTimeout(() => {
        document
          .querySelector(`[data-protocol-id="${proto.id}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 0);
      clearParam();
    };
    const local = protocols.find((x) => x.id === id);
    if (local) {
      openProto(local);
      return;
    }
    // Protokół z innego miesiąca/roku — pobierz bez filtra i odszukaj po id.
    deepLinkBusy.current = true;
    getProtocols()
      .then((res) => {
        const found = (res.data || []).find((x) => x.id === id);
        if (found) openProto(found);
        else clearParam();
      })
      .catch(() => clearParam())
      .finally(() => {
        deepLinkBusy.current = false;
      });
  }, [searchParams, setSearchParams, tab, navigate, protoLoading, protocols]);

  /**
   * Deep-link `?realization=ID[&date=YYYY-MM-DD]` (z kalendarza): przełącz na
   * właściwy miesiąc, przewiń do wiersza, podświetl i otwórz formularz.
   */
  useEffect(() => {
    const raw = searchParams.get("realization");
    const id = raw ? Number(raw) : NaN;
    if (!Number.isFinite(id)) return;
    if (tab !== "realizacje") {
      navigate(`/technical/realizacje?${searchParams.toString()}`, { replace: true });
      return;
    }
    const date = searchParams.get("date");
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const y = Number(date.slice(0, 4));
      const m = Number(date.slice(5, 7));
      if (y !== year || m !== month) {
        setYear(y);
        setMonth(m);
        return; // po przeładowaniu miesiąca efekt uruchomi się ponownie
      }
    }
    if (loading) return;
    const row = rows.find((r) => r.id === id);
    const next = new URLSearchParams(searchParams);
    next.delete("realization");
    next.delete("date");
    setSearchParams(next, { replace: true });
    if (!row) return;
    // Wiersz z deep-linka ma być WIDOCZNY — bez tego podświetlenie i przewijanie
    // trafiałyby w wiersz odfiltrowany przez ustawienia zakładki.
    clearRealFilters();
    setHighlightRow(id);
    setEditing(row);
    setFormOpen(true);
    window.setTimeout(() => {
      document
        .querySelector(`[data-realization-id="${id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    window.setTimeout(() => setHighlightRow((cur) => (cur === id ? null : cur)), 6000);
  }, [
    searchParams,
    setSearchParams,
    tab,
    navigate,
    loading,
    rows,
    year,
    month,
    clearRealFilters,
  ]);

  // --- Wyceny ---
  const loadQuotes = useCallback(async () => {
    setQuotesLoading(true);
    try {
      const res = await getQuotes(year);
      setQuotes(res.data || []);
    } catch (error) {
      console.error("Error loading quotes:", error);
    } finally {
      setQuotesLoading(false);
    }
  }, [year]);

  useEffect(() => {
    loadQuotes();
  }, [loadQuotes]);

  /** Obiekty do selecta budujemy z danych — wycena trzyma wpisaną nazwę, nie klucz obcy. */
  const quoteSites = useMemo(
    () =>
      Array.from(new Set(quotes.map((q) => (q.site || "").trim()).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b, "pl")
      ),
    [quotes]
  );

  /** Jeden przebieg: filtry + sortowanie wycen. */
  const visibleQuotes = useMemo(() => {
    const needle = quoteSearch.trim().toLowerCase();
    const min = parseAmount(quoteMinInput);
    const max = parseAmount(quoteMaxInput);
    // Granica świeżości liczona raz na przebieg — „ostatnie 30 dni" od teraz.
    const freshAfter =
      quoteFreshMode === "all"
        ? null
        : Date.now() - parseInt(quoteFreshMode, 10) * 24 * 3600_000;

    const list = quotes.filter((qt) => {
      if (
        needle &&
        ![qt.number, qt.site, qt.address]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle))
      ) {
        return false;
      }
      if (quoteSiteFilter !== "all") {
        const site = (qt.site || "").trim();
        if (quoteSiteFilter === NONE ? site !== "" : site !== quoteSiteFilter) return false;
      }
      if (quoteSourceFilter !== "all") {
        const fromRealization = qt.realizationId != null;
        if (quoteSourceFilter === "realization" ? !fromRealization : fromRealization) {
          return false;
        }
      }
      // Wycena na 0 zł = dokument z pozycjami cennika, w którym nikt jeszcze nie
      // wpisał ilości — filtr „tylko puste" służy właśnie do ich wyłapania.
      const total = qt.total ?? 0;
      if (quoteValueMode === "with" && total <= 0) return false;
      if (quoteValueMode === "without" && total > 0) return false;
      if (min !== undefined && total < min) return false;
      if (max !== undefined && total > max) return false;
      if (freshAfter !== null) {
        const changed = parseDate(qt.updatedAt) ?? parseDate(qt.createdAt);
        if (changed === null || changed < freshAfter) return false;
      }
      return true;
    });

    const mul = quoteDir === "asc" ? 1 : -1;
    const text = (qt: Quote): string => {
      switch (quoteSort) {
        case "site":
          return qt.site ?? "";
        case "address":
          return qt.address ?? "";
        default:
          return qt.number ?? "";
      }
    };
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (qt: Quote): number | null =>
      quoteSort === "date" ? parseDate(qt.date) : (qt.total ?? null);

    const numeric = quoteSort === "date" || quoteSort === "total";

    // Puste teksty i brak daty lądują na końcu w OBU kierunkach (jak NULLS LAST
    // w sortowaniu obiektów) — inaczej „sortuj po adresie" zaczynałoby się od
    // wycen bez adresu. Remis rozstrzyga numer.
    const compare = (a: Quote, b: Quote): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    return list.sort((a, b) => compare(a, b) || a.number.localeCompare(b.number, "pl"));
  }, [
    quotes,
    quoteSearch,
    quoteSiteFilter,
    quoteSourceFilter,
    quoteValueMode,
    quoteMinInput,
    quoteMaxInput,
    quoteFreshMode,
    quoteSort,
    quoteDir,
  ]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleQuoteSort = (key: QuoteSortKey) => {
    if (quoteSort === key) {
      setQuoteDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setQuoteSort(key);
    setQuoteDir(QUOTE_DEFAULT_DIR[key]);
  };

  const quoteFiltersActive =
    quoteSearch !== "" ||
    quoteSiteFilter !== "all" ||
    quoteSourceFilter !== "all" ||
    quoteValueMode !== "all" ||
    quoteMinInput !== "" ||
    quoteMaxInput !== "" ||
    quoteFreshMode !== "all";

  const clearQuoteFilters = () => {
    setQuoteSearch("");
    setQuoteSiteFilter("all");
    setQuoteSourceFilter("all");
    setQuoteValueMode("all");
    setQuoteMinInput("");
    setQuoteMaxInput("");
    setQuoteFreshMode("all");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const QuoteSortHeader = ({
    label,
    sortKey,
    align = "left",
    title,
  }: {
    label: string;
    sortKey: QuoteSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = quoteSort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : quoteDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`wyceny-sort-${sortKey}`}
          onClick={() => toggleQuoteSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          title={title}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            activeCol ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
        </button>
      </th>
    );
  };

  /**
   * Deep-link `?quote=ID` (z kalendarza — wycena wydarzenia): przełącz na zakładkę
   * Wyceny, otwórz formularz i przewiń do wiersza. Wycena z innego roku dociągana
   * jest osobnym zapytaniem (lista jest filtrowana rokiem).
   */
  const quoteLinkBusy = useRef(false);
  useEffect(() => {
    const raw = searchParams.get("quote");
    const id = raw ? Number(raw) : NaN;
    if (!Number.isFinite(id)) return;
    if (tab !== "wyceny") {
      navigate(`/technical/wyceny?quote=${id}`, { replace: true });
      return;
    }
    if (quotesLoading || quoteLinkBusy.current) return;
    const clearParam = () => {
      const next = new URLSearchParams(searchParams);
      next.delete("quote");
      setSearchParams(next, { replace: true });
    };
    const openQuote = (q: Quote) => {
      setEditingQuote(q);
      window.setTimeout(() => {
        document.querySelector(`[data-quote-id="${q.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 0);
      clearParam();
    };
    const local = quotes.find((x) => x.id === id);
    if (local) {
      openQuote(local);
      return;
    }
    quoteLinkBusy.current = true;
    getQuotes()
      .then((res) => {
        const found = (res.data || []).find((x) => x.id === id);
        if (found) openQuote(found);
        else clearParam();
      })
      .catch(() => clearParam())
      .finally(() => {
        quoteLinkBusy.current = false;
      });
  }, [searchParams, setSearchParams, tab, navigate, quotesLoading, quotes]);

  const handleQuoteNew = async () => {
    if (!editable) return;
    try {
      // Bez wyboru cennika backend prefilluje wycenę cennikiem głównym.
      const res = await createQuote(
        quotePriceListId ? { priceListId: quotePriceListId } : {}
      );
      await loadQuotes();
      if (res.data) setEditingQuote(res.data);
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Nie można utworzyć wyceny"
      );
    }
  };

  const handleQuoteUpdate = async (data: QuoteInput) => {
    if (!editable) return;
    if (editingQuote) {
      await updateQuote(editingQuote.id, data);
      loadQuotes();
    }
  };

  const handleQuoteDelete = async (quote: Quote) => {
    if (!editable) return;
    if (window.confirm(`Usunąć wycenę ${quote.number}?`)) {
      try {
        await deleteQuote(quote.id);
        loadQuotes();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć wyceny"
        );
      }
    }
  };

  const handleProtoUpdate = async (data: ProtocolInput) => {
    if (!editable) return;
    if (editingProto) {
      await updateProtocol(editingProto.id, data);
      loadProtocols();
    }
  };

  const handleProtoSign = async (signaturePng: string, signerName: string) => {
    if (!editable) return;
    if (editingProto) {
      const res = await signProtocol(editingProto.id, {
        signaturePng,
        signerName,
      });
      if (res.data) setEditingProto(res.data);
      // Backend po podpisie dolicza realizację i przelicza wycenę z protokołu — pokazujemy,
      // co się wydarzyło, bo dzieje się to poza otwartym dialogiem.
      setSignNote(res.message && res.message !== "Protokół podpisany" ? res.message : null);
      loadProtocols();
      load();
      loadQuotes();
    }
  };

  const handleProtoUnsign = async () => {
    if (!editable) return;
    if (editingProto) {
      const res = await unsignProtocol(editingProto.id);
      if (res.data) setEditingProto(res.data);
      loadProtocols();
    }
  };


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

  const handleCreate = async (data: RealizationInput) => {
    if (!editable) return;
    await createRealization(data);
    load();
  };

  const handleUpdate = async (data: RealizationInput) => {
    if (!editable) return;
    if (editing) {
      await updateRealization(editing.id, data, editing.updatedAt);
      load();
    }
  };

  const handleDelete = async (row: Realization) => {
    if (!editable) return;
    if (
      window.confirm(
        `Usunąć realizację "${row.site}" z ${new Date(row.date).toLocaleDateString("pl-PL")}?`
      )
    ) {
      try {
        await deleteRealization(row.id);
        load();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć realizacji"
        );
      }
    }
  };

  /** Protokół dla pojedynczej realizacji (starszy wpis, który go nie dostał). */
  const handleCreateProtocol = async (row: Realization) => {
    if (!editable || creatingProtoFor != null) return;
    setCreatingProtoFor(row.id);
    try {
      await createRealizationProtocol(row.id);
      await Promise.all([load(), loadProtocols()]);
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Nie można utworzyć protokołu"
      );
      // 409 „ma już protokół" — odśwież, żeby wiersz pokazał istniejący numer.
      load();
    } finally {
      setCreatingProtoFor(null);
    }
  };

  /** Masowe uzupełnienie braków (POST /protocols/sync) — po potwierdzeniu. */
  const handleSyncProtocols = async () => {
    if (!editable) return;
    setSyncingProtos(true);
    try {
      await syncProtocols();
      await Promise.all([load(), loadProtocols()]);
      setSyncProtoOpen(false);
    } catch (error) {
      alert(
        error instanceof Error
          ? error.message
          : "Nie można wygenerować brakujących protokołów"
      );
    } finally {
      setSyncingProtos(false);
    }
  };

  /**
   * Automat zapisał pola — odświeżamy wiersz w tabeli, podbijamy `updatedAt`
   * otwartego formularza i zostawiamy lokalny znacznik dla badge'a „auto"
   * (backend nie musi przechowywać kolumny `autofill`).
   */
  const handleAutofilled = (updated: Realization, applied: AutofillSuggestion[] | string[]) => {
    const fields = applied.map((a) => (typeof a === "string" ? a : a.field));
    markAutofilled(updated.id, fields, updated.updatedAt);
    setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
    setEditing((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
    load();
  };

  /** Realizacje, w których automat ma co uzupełnić: zerowe kwoty i bez faktury. */
  const autofillCandidates = rows.filter(
    (r) => !r.invoiced && !r.amountHours && !r.amountMaterial && !r.amountKm
  );
  const canAutofill = (row: Realization) =>
    !row.invoiced && !row.amountHours && !row.amountMaterial && !row.amountKm;

  /** Masowy podgląd — po jednej realizacji, tylko pola bezkonfliktowe. */
  const runBulkPreview = async () => {
    if (!editable || autofillCandidates.length === 0) return;
    setBulkBusy("preview");
    setBulkError(null);
    try {
      const res = await realizationAutofillApi.bulkPreview(
        autofillCandidates.map((r) => ({ id: r.id, site: r.site })),
        { confidentOnly: true }
      );
      setBulk(res);
      if (res.length === 0) setBulkError("Automat nie znalazł nic do uzupełnienia w tym miesiącu.");
    } catch (error) {
      setBulk(null);
      setBulkError(
        error instanceof Error ? error.message : "Nie udało się policzyć sugestii"
      );
    } finally {
      setBulkBusy(null);
    }
  };

  const runBulkApply = async () => {
    if (!editable || !bulk) return;
    setBulkBusy("apply");
    try {
      const res = await realizationAutofillApi.bulkApply(bulk);
      // Znaczniki „auto" wymagają świeżego updatedAt — bierzemy je z przeładowania.
      const fresh = await getRealizations(year, month);
      const byId = new Map((fresh.data || []).map((r) => [r.id, r]));
      for (const row of bulk) {
        const updated = byId.get(row.id);
        if (updated) markAutofilled(row.id, row.fields as string[], updated.updatedAt);
      }
      setBulk(null);
      setBulkError(
        res.failed.length > 0
          ? `Uzupełniono ${res.applied}, nie udało się ${res.failed.length}.`
          : null
      );
      await load();
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "Nie udało się zapisać");
    } finally {
      setBulkBusy(null);
    }
  };

  /**
   * Ile realizacji w CAŁYM miesiącu nie ma protokołu. Filtry tabeli tego nie
   * ruszają, bo pigułka i „Utwórz brakujące" opisują akcję `syncProtocols()`,
   * która działa globalnie (także poza bieżącym miesiącem).
   */
  const monthMissingProtocolCount = rows.filter((r) => !r.protocol).length;

  /** Obiekty do selecta budujemy z danych — realizacja trzyma migawkę nazwy, nie klucz obcy. */
  const realizationSites = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => (r.site || "").trim()).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b, "pl")
      ),
    [rows]
  );

  /** Wykonawcy do selecta — z listy miesiąca, po tym samym wzorze co kolumna. */
  const realizationContractors = useMemo(
    () =>
      Array.from(new Set(rows.map(realizationContractor).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b, "pl")
      ),
    [rows]
  );

  /**
   * Jeden przebieg: filtry, sortowanie, liczniki chipów i sumy stopki.
   *
   * Liczniki chipów liczymy fasetowo — każdy wymiar dostaje listę
   * przefiltrowaną WSZYSTKIM POZA nim samym, więc liczba na chipie mówi, ile
   * wierszy zobaczysz po jego kliknięciu (bez tego „Bez protokołu" pokazywałby
   * 0 zaraz po wybraniu „Z protokołem").
   */
  const realizationView = useMemo(() => {
    const needle = realSearch.trim().toLowerCase();
    const min = parseAmount(realMinInput);
    const max = parseAmount(realMaxInput);

    const matches = (r: Realization, skip?: RealizationFacet): boolean => {
      if (
        needle &&
        ![r.site, r.contractor1, r.contractor2, r.caretaker, r.note]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle))
      ) {
        return false;
      }
      if (skip !== "workType" && workTypeFilter !== "" && r.workType !== workTypeFilter) {
        return false;
      }
      if (skip !== "billing" && billingFilter !== "" && r.billing !== billingFilter) {
        return false;
      }
      if (skip !== "protocol" && protoFilter !== "") {
        if (protoFilter === "with" ? !r.protocol : !!r.protocol) return false;
      }
      if (realInvoicedFilter !== "all") {
        if (realInvoicedFilter === "yes" ? !r.invoiced : r.invoiced) return false;
      }
      if (realContractorFilter !== "all") {
        const who = realizationContractor(r);
        if (realContractorFilter === NONE ? who !== "" : who !== realContractorFilter) {
          return false;
        }
      }
      if (realSiteFilter !== "all") {
        const site = (r.site || "").trim();
        if (realSiteFilter === NONE ? site !== "" : site !== realSiteFilter) return false;
      }
      // Migawka nazwy zostaje na dokumencie nawet bez powiązania, więc „bez
      // obiektu z kartoteki" pyta o KLUCZ (`objectId`), a nie o pusty napis.
      if (realObjectFilter !== "all") {
        const linked = r.objectId != null;
        if (realObjectFilter === "linked" ? !linked : linked) return false;
      }
      // Realizacja na 0 zł = wpis, w którym nikt jeszcze nie policzył kwot —
      // tryb „tylko zerowe" służy właśnie do ich wyłapania.
      const total = r.total ?? 0;
      if (realValueMode === "with" && total <= 0) return false;
      if (realValueMode === "without" && total > 0) return false;
      if (min !== undefined && total < min) return false;
      if (max !== undefined && total > max) return false;
      return true;
    };

    const mul = realDir === "asc" ? 1 : -1;
    const text = (r: Realization): string => {
      switch (realSort) {
        case "site":
          return r.site ?? "";
        case "workType":
          return (
            REALIZATION_WORK_TYPE_META[r.workType] ?? REALIZATION_WORK_TYPE_META.inne
          ).label;
        case "billing":
          return (BILLING_META[r.billing] ?? BILLING_META.paid).label;
        default:
          return realizationContractor(r);
      }
    };
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (r: Realization): number | null => {
      switch (realSort) {
        case "date":
          return parseDate(r.date);
        // Godziny, kilometry i rabat tabela pokazuje jako „—", gdy są zerowe —
        // dla sortowania to wartość pusta (NULLS LAST), nie zero.
        case "actualHours":
          return Number(r.actualHours) || null;
        case "actualKm":
          return Number(r.actualKm) || null;
        case "discount":
          return Number(r.discount) || null;
        case "invoiced":
          return r.invoiced ? 1 : 0;
        // Kwoty tabela pokazuje zawsze (także „0,00 zł") — zero to wartość.
        case "amountHours":
          return Number(r.amountHours) || 0;
        case "amountMaterial":
          return Number(r.amountMaterial) || 0;
        case "amountKm":
          return Number(r.amountKm) || 0;
        default:
          return Number(r.total) || 0;
      }
    };

    const numeric = !REALIZATION_TEXT_SORT_KEYS.has(realSort);

    // Puste teksty i wartości bez treści lądują na końcu w OBU kierunkach (jak
    // NULLS LAST w sortowaniu obiektów) — inaczej „sortuj po wykonawcy"
    // zaczynałoby się od realizacji bez wpisanego wykonawcy. Realizacja nie ma
    // numeru dokumentu, więc remis rozstrzyga data (najnowsze u góry) i id.
    const compare = (a: Realization, b: Realization): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    const list = rows
      .filter((r) => matches(r))
      .sort((a, b) => compare(a, b) || b.date.localeCompare(a.date) || a.id - b.id);

    const countBy = <K extends string>(source: Realization[], pick: (r: Realization) => K) => {
      const out = {} as Record<K, number>;
      for (const r of source) out[pick(r)] = (out[pick(r)] ?? 0) + 1;
      return out;
    };
    const protoBase = rows.filter((r) => matches(r, "protocol"));
    const withProtocolCount = protoBase.filter((r) => !!r.protocol).length;

    const sum = (pick: (r: Realization) => number) =>
      list.reduce((acc, r) => acc + Number(pick(r) || 0), 0);

    return {
      list,
      workTypeCounts: countBy(
        rows.filter((r) => matches(r, "workType")),
        (r) => r.workType
      ),
      billingCounts: countBy(
        rows.filter((r) => matches(r, "billing")),
        (r) => r.billing
      ),
      withProtocolCount,
      missingProtocolCount: protoBase.length - withProtocolCount,
      // Stopka tabeli sumuje TO, CO WIDAĆ — inaczej „Razem" kłóciłoby się
      // z wierszami po zawężeniu filtrów.
      totals: {
        actualHours: sum((r) => r.actualHours),
        actualKm: sum((r) => r.actualKm),
        amountHours: sum((r) => r.amountHours),
        amountMaterial: sum((r) => r.amountMaterial),
        amountKm: sum((r) => r.amountKm),
        discount: sum((r) => r.discount),
        total: sum((r) => r.total),
      },
    };
  }, [
    rows,
    realSearch,
    workTypeFilter,
    billingFilter,
    protoFilter,
    realInvoicedFilter,
    realContractorFilter,
    realSiteFilter,
    realObjectFilter,
    realValueMode,
    realMinInput,
    realMaxInput,
    realSort,
    realDir,
  ]);

  const visibleRows = realizationView.list;
  const workTypeCounts = realizationView.workTypeCounts;
  const billingCounts = realizationView.billingCounts;
  const withProtocolCount = realizationView.withProtocolCount;
  const missingProtocolCount = realizationView.missingProtocolCount;
  const realTotals = realizationView.totals;

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleRealSort = (key: RealizationSortKey) => {
    if (realSort === key) {
      setRealDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setRealSort(key);
    setRealDir(REALIZATION_DEFAULT_DIR[key]);
  };

  const realFiltersActive =
    realSearch !== "" ||
    workTypeFilter !== "" ||
    billingFilter !== "" ||
    protoFilter !== "" ||
    realInvoicedFilter !== "all" ||
    realContractorFilter !== "all" ||
    realSiteFilter !== "all" ||
    realObjectFilter !== "all" ||
    realValueMode !== "all" ||
    realMinInput !== "" ||
    realMaxInput !== "";

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const RealSortHeader = ({
    label,
    sortKey,
    align = "left",
    title,
  }: {
    label: string;
    sortKey: RealizationSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = realSort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : realDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`realizacje-sort-${sortKey}`}
          onClick={() => toggleRealSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          title={title}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            activeCol ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
        </button>
      </th>
    );
  };

  const openEdit = (row: Realization) => {
    setEditing(row);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const defaultDate = `${year}-${String(month).padStart(2, "0")}-${String(
    Math.min(now.getDate(), 28)
  ).padStart(2, "0")}`;

  const tiles = summary
    ? [
        {
          label: "Serwisy płatne",
          value: money(summary.paidServices),
          sub: `${summary.counts.service} szt.`,
        },
        {
          label: "Montaże",
          value: money(summary.installations),
          sub: `${summary.counts.installation} szt.`,
        },
        {
          label: "Przychód razem",
          value: money(summary.revenue),
          sub: "płatne + montaże",
          accent: true,
        },
        {
          label: "Bezpłatne (potencjalny przychód)",
          value: money(summary.freePotential),
          sub: `${summary.counts.warranty} szt.`,
        },
        {
          label: "Strata (koszt bezpłatnych)",
          value: money(summary.freeCost),
          sub: "roboczogodziny",
        },
        {
          label: "Suma sum",
          value: money(summary.grandTotal),
          sub: "z bezpłatnymi",
        },
      ]
    : [];

  if (!tab || !TECH_TABS.includes(tab as (typeof TECH_TABS)[number])) {
    return <Navigate to="/technical/realizacje" replace />;
  }

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <Tabs value={tab}>
        <TabsContent value="realizacje" className="space-y-4">
          {/* Pasek: miesiąc + akcje */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(-1)}
              title="Poprzedni miesiąc"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-40 text-center text-lg font-semibold">
              {MONTH_NAMES[month - 1]} {year}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(1)}
              title="Następny miesiąc"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {summary && summary.uninvoicedCount > 0 && (
              <span className={pillClass("amber", { className: "ml-2" })}>
                Do zafakturowania: {summary.uninvoicedCount}
              </span>
            )}
            {editable && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {autofillCandidates.length > 0 && (
                  <Button
                    variant="outline"
                    data-testid="autofill-bulk-open"
                    disabled={bulkBusy != null}
                    onClick={() => void runBulkPreview()}
                    {...tip(
                      `Policz godziny, materiały i kilometry dla ${autofillCandidates.length} realizacji z zerowymi kwotami\nnajpierw podgląd, zapis dopiero po potwierdzeniu`
                    )}
                  >
                    <Wand2 className="mr-2 h-4 w-4" aria-hidden />
                    {bulkBusy === "preview"
                      ? "Liczenie…"
                      : `Uzupełnij brakujące (${autofillCandidates.length})`}
                  </Button>
                )}
                <Button onClick={() => setFormOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Dodaj realizację
                </Button>
              </div>
            )}
          </div>

          {bulkError && (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
              role="status"
              data-testid="autofill-bulk-note"
            >
              {bulkError}
            </div>
          )}

          {/* Kafelki podsumowań */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {tiles.map((tile) => (
              <Card
                key={tile.label}
                className={tile.accent ? "border-primary/50" : undefined}
              >
                <CardContent className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {tile.label}
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {tile.value}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tile.sub}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Filtry selectowe (jak w Protokołach / Wycenach). Chipy niżej
              zostają — dokładają rodzaj prac, typ rozliczenia i protokół. */}
          {!loading && rows.length > 0 && (
            <div className="space-y-2">
              {/* Pierwsza linia: szukajka, faktura, wykonawca, obiekt, kartoteka. */}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Szukaj po obiekcie, wykonawcy, opisie…"
                  data-testid="realizacje-filter-search"
                  value={realSearch}
                  onChange={(e) => setRealSearch(e.target.value)}
                  className="max-w-xs"
                />

                <Select value={realInvoicedFilter} onValueChange={setRealInvoicedFilter}>
                  <SelectTrigger className="w-[200px]" data-testid="realizacje-filter-invoiced">
                    <SelectValue placeholder="Faktura" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Faktura: wszystkie</SelectItem>
                    <SelectItem value="yes">Tylko zafakturowane</SelectItem>
                    <SelectItem value="no">Tylko niezafakturowane</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={realContractorFilter}
                  onValueChange={setRealContractorFilter}
                >
                  <SelectTrigger className="w-[200px]" data-testid="realizacje-filter-contractor">
                    <SelectValue placeholder="Wykonawca" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Wszyscy wykonawcy</SelectItem>
                    <SelectItem value={NONE}>Bez wykonawcy</SelectItem>
                    {realizationContractors.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={realSiteFilter} onValueChange={setRealSiteFilter}>
                  <SelectTrigger className="w-[220px]" data-testid="realizacje-filter-site">
                    <SelectValue placeholder="Obiekt" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Wszystkie obiekty</SelectItem>
                    <SelectItem value={NONE}>Bez obiektu</SelectItem>
                    {realizationSites.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Nazwa obiektu to migawka na dokument — ten filtr pyta o
                    powiązanie z kartoteką (`objectId`), nie o napis. */}
                <Select value={realObjectFilter} onValueChange={setRealObjectFilter}>
                  <SelectTrigger className="w-[240px]" data-testid="realizacje-filter-object">
                    <SelectValue placeholder="Kartoteka" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Kartoteka: wszystkie</SelectItem>
                    <SelectItem value="linked">Tylko z obiektem z kartoteki</SelectItem>
                    <SelectItem value="unlinked">Tylko bez obiektu z kartoteki</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Druga linia: suma netto — tryb i widełki. */}
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={realValueMode}
                  onValueChange={(v) => setRealValueMode(v as ValueMode)}
                >
                  <SelectTrigger className="w-[220px]" data-testid="realizacje-filter-value-mode">
                    <SelectValue placeholder="Kwota" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Kwota: wszystkie</SelectItem>
                    <SelectItem value="with">Tylko z kwotą</SelectItem>
                    <SelectItem value="without">Tylko zerowe (0 zł)</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <span>Kwota od</span>
                  <Input
                    type="number"
                    min="0"
                    step="50"
                    inputMode="decimal"
                    className="w-28 tabular-nums"
                    data-testid="realizacje-filter-min"
                    value={realMinInput}
                    onChange={(e) => setRealMinInput(e.target.value)}
                  />
                  <span>do</span>
                  <Input
                    type="number"
                    min="0"
                    step="50"
                    inputMode="decimal"
                    className="w-28 tabular-nums"
                    data-testid="realizacje-filter-max"
                    value={realMaxInput}
                    onChange={(e) => setRealMaxInput(e.target.value)}
                  />
                  <span>zł netto</span>
                </div>
                {realFiltersActive && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearRealFilters}
                    data-testid="realizacje-filters-clear"
                  >
                    <X className="h-4 w-4 mr-1" />
                    Wyczyść filtry
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Filtry: rodzaj prac i typ rozliczenia (chipy jak w kalendarzu) */}
          {!loading && rows.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Rodzaj
                </span>
                {REALIZATION_WORK_TYPE_ORDER.filter(
                  (t) => (workTypeCounts[t] ?? 0) > 0 || workTypeFilter === t
                ).map((t) => {
                  const meta = REALIZATION_WORK_TYPE_META[t];
                  const active = workTypeFilter === t;
                  const Icon = meta.icon;
                  return (
                    <button
                      key={t}
                      type="button"
                      data-testid={`realization-worktype-filter-${t}`}
                      aria-pressed={active}
                      onClick={() => setWorkTypeFilter(active ? "" : t)}
                      {...tip(
                        `Rodzaj prac: ${meta.label} — ${workTypeCounts[t] ?? 0} po pozostałych filtrach`
                      )}
                      className={cn(
                        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-6",
                        active ? meta.chipActive : meta.chip
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                      {meta.label}
                      <span className="tabular-nums opacity-70">{workTypeCounts[t] ?? 0}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Typ
                </span>
                {REALIZATION_BILLING_ORDER.filter(
                  (b) => (billingCounts[b] ?? 0) > 0 || billingFilter === b
                ).map((b) => {
                  const meta = BILLING_META[b];
                  const active = billingFilter === b;
                  const Icon = meta.icon;
                  return (
                    <button
                      key={b}
                      type="button"
                      data-testid={`realization-billing-filter-${b}`}
                      aria-pressed={active}
                      onClick={() => setBillingFilter(active ? "" : b)}
                      {...tip(
                        `Rozliczenie: ${meta.label} (${meta.hint}) — ${billingCounts[b] ?? 0} po pozostałych filtrach`
                      )}
                      className={cn(
                        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-6",
                        active ? meta.chipActive : meta.chip
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                      {meta.label}
                      <span className="tabular-nums opacity-70">{billingCounts[b] ?? 0}</span>
                    </button>
                  );
                })}
                {/* Bez lokalnego „wyczyść" — jeden przycisk nad chipami
                    (`realizacje-filters-clear`) zdejmuje wszystkie filtry. */}
              </div>
            </div>
          )}

          {/* Pasek protokołów: filtr + braki */}
          {!loading && rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Protokół
              </span>
              <div
                className="inline-flex rounded-full border bg-background p-0.5"
                role="group"
                aria-label="Filtr protokołu"
              >
                {(
                  [
                    { key: "", label: "Wszystkie", icon: null, count: null, hint: "bez filtra protokołu" },
                    {
                      key: "with",
                      label: "Z protokołem",
                      icon: FileCheck2,
                      count: withProtocolCount,
                      hint: "realizacje, które mają już protokół",
                    },
                    {
                      key: "without",
                      label: "Bez protokołu",
                      icon: FileX,
                      count: missingProtocolCount,
                      hint: "realizacje, dla których protokół nie powstał",
                    },
                  ] as const
                ).map((o) => {
                  const active = protoFilter === o.key;
                  const Icon = o.icon;
                  return (
                    <button
                      key={o.key || "all"}
                      type="button"
                      data-testid={`realization-protocol-filter-${o.key || "all"}`}
                      aria-pressed={active}
                      onClick={() => setProtoFilter(active && o.key ? "" : o.key)}
                      {...tip(
                        `Filtr protokołu: ${o.label.toLowerCase()}${o.count != null ? ` — ${o.count} po pozostałych filtrach` : ""}\n${o.hint}`
                      )}
                      className={cn(
                        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-6",
                        active
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />}
                      {o.label}
                      {o.count != null && (
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums",
                            active ? "bg-background/25" : "bg-muted text-muted-foreground"
                          )}
                        >
                          {o.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Pigułka i „Utwórz brakujące" chodzą parą z akcją globalną,
                  więc liczą CAŁY miesiąc — filtry tabeli ich nie zawężają
                  (chipy obok pokazują liczby po filtrach). */}
              {monthMissingProtocolCount > 0 && (
                <div className="ml-auto flex items-center gap-2">
                  <span
                    data-testid="missing-protocols-count"
                    className={pillClass("amber")}
                    {...tip("Cały miesiąc — niezależnie od filtrów tabeli")}
                  >
                    {monthMissingProtocolCount}{" "}
                    {monthMissingProtocolCount === 1
                      ? "realizacja bez protokołu"
                      : monthMissingProtocolCount < 5
                        ? "realizacje bez protokołu"
                        : "realizacji bez protokołu"}
                  </span>
                  {editable && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="create-missing-protocols"
                      onClick={() => setSyncProtoOpen(true)}
                    >
                      <FilePlus className="mr-2 h-4 w-4" aria-hidden />
                      Utwórz brakujące
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tabela realizacji */}
          <Card>
            <CardContent className="p-0">
              {loading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : rows.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak realizacji w tym miesiącu. Kliknij „Dodaj realizację",
                  aby wpisać pierwszą.
                </div>
              ) : visibleRows.length === 0 ? (
                <div
                  className="py-10 text-center text-muted-foreground"
                  data-testid="realizacje-empty-filtered"
                >
                  Brak realizacji dla wybranych filtrów
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1360px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <RealSortHeader label="Data" sortKey="date" />
                        <RealSortHeader label="Obiekt" sortKey="site" />
                        <RealSortHeader label="Rodzaj" sortKey="workType" />
                        <RealSortHeader label="Typ" sortKey="billing" />
                        <RealSortHeader
                          label="Godz."
                          sortKey="actualHours"
                          align="right"
                          title="Faktyczne godziny pracownicze (nie kwota)"
                        />
                        <RealSortHeader
                          label="KM"
                          sortKey="actualKm"
                          align="right"
                          title="Faktycznie przejechane kilometry (nie kwota)"
                        />
                        <RealSortHeader
                          label="Kwota godz."
                          sortKey="amountHours"
                          align="right"
                        />
                        <RealSortHeader
                          label="Materiały"
                          sortKey="amountMaterial"
                          align="right"
                        />
                        <RealSortHeader label="Kwota KM" sortKey="amountKm" align="right" />
                        <RealSortHeader label="Rabat" sortKey="discount" align="right" />
                        <RealSortHeader label="Suma netto" sortKey="total" align="right" />
                        <th className="px-3 py-2 font-medium">Adnotacja</th>
                        <RealSortHeader label="Zafakt." sortKey="invoiced" />
                        {/* Kolumna pokazuje `contractor1 || caretaker` — sortujemy po tym samym. */}
                        <RealSortHeader label="Wykonawca" sortKey="caretaker" />
                        <th className="px-3 py-2 font-medium">Protokół</th>
                        <th className="px-3 py-2 font-medium">Kalendarz</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => (
                        <tr
                          key={row.id}
                          data-realization-id={row.id}
                          className={`cursor-pointer border-b last:border-0 hover:bg-accent/50 ${
                            highlightRow === row.id ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : ""
                          }`}
                          onClick={() => openEdit(row)}
                        >
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {new Date(row.date).toLocaleDateString("pl-PL")}
                          </td>
                          <td className="px-3 py-2 font-medium">
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              {/* Obiekt z kartoteki (po kluczu obcym) → link do karty.
                                  Napis zostaje `row.site`, bo to migawka nazwy z dnia prac —
                                  link prowadzi do obiektu, nazwa mówi, co było na dokumencie. */}
                              {row.location ? (
                                <Link
                                  to={`/objects/${row.location.objectId}`}
                                  data-testid={`realization-object-link-${row.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-primary hover:underline"
                                  {...tip(
                                    `Otwórz kartę obiektu\n${row.location.name}${
                                      row.location.city ? ` — ${row.location.city}` : ""
                                    }\npowiązanie: ${
                                      row.location.source === "realizacja"
                                        ? "obiekt przypisany do realizacji"
                                        : "obiekt z wydarzenia kalendarza"
                                    }`
                                  )}
                                >
                                  {row.site}
                                </Link>
                              ) : (
                                row.site
                              )}
                              {/* „auto" = wartości z automatu (dopóki wpisu nie ruszy człowiek) */}
                              <AutoBadge fields={autofillFieldsFor(row)} />
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <RealizationWorkTypeBadge workType={row.workType} />
                          </td>
                          <td className="px-3 py-2">
                            <RealizationBillingBadge billing={row.billing} />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <ActualValue row={row} field="actualHours" suffix="h" />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <ActualValue row={row} field="actualKm" suffix="km" />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {money(row.amountHours)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {money(row.amountMaterial)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {money(row.amountKm)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {row.discount ? money(row.discount) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {money(row.total)}
                          </td>
                          <td
                            className="max-w-56 truncate px-3 py-2 text-muted-foreground"
                            title={row.note || undefined}
                          >
                            {row.note || "—"}
                          </td>
                          <td className="px-3 py-2">
                            {/* Ta sama pigułka co znacznik realizacji w kalendarzu. */}
                            <span
                              className={realizationBadgeClass(
                                row.invoiced ? "invoiced" : "open"
                              )}
                              {...tip(
                                REALIZATION_BADGE_META[
                                  row.invoiced ? "invoiced" : "open"
                                ].hint
                              )}
                            >
                              <InvoicedIcon className="h-3.5 w-3.5" aria-hidden />
                              {row.invoiced ? "TAK" : "NIE"}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {row.contractor1 || row.caretaker || "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {row.protocol ? (
                              <Link
                                to={protocolHref(row.protocol.id)}
                                data-testid={`realization-protocol-link-${row.id}`}
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {/* compact = sam numer, żeby kolumna nie rozpychała tabeli */}
                                <ProtocolBadge
                                  event={protocolBadgeEvent(row.protocol)}
                                  compact
                                  className="hover:underline"
                                />
                              </Link>
                            ) : editable ? (
                              <div onClick={(e) => e.stopPropagation()}>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  data-testid={`create-protocol-${row.id}`}
                                  disabled={creatingProtoFor != null}
                                  onClick={() => handleCreateProtocol(row)}
                                  {...tip(
                                    "Utwórz protokół\nrealizacja nie ma jeszcze protokołu — numer zostanie nadany automatycznie"
                                  )}
                                >
                                  {creatingProtoFor === row.id ? (
                                    "Tworzenie…"
                                  ) : (
                                    <>
                                      <FilePlus className="mr-1 h-3.5 w-3.5" aria-hidden />
                                      Utwórz
                                    </>
                                  )}
                                </Button>
                              </div>
                            ) : (
                              <span
                                className="text-xs text-muted-foreground"
                                {...tip("Brak protokołu — realizacja nie ma jeszcze protokołu")}
                              >
                                brak
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {row.calendarEventId ? (
                              <Link
                                to={calendarEventHref(row.calendarEventId, row.date)}
                                data-testid={`realization-calendar-link-${row.id}`}
                                onClick={(e) => e.stopPropagation()}
                                title={`Z kalendarza — otwórz wydarzenie #${row.calendarEventId}`}
                                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                              >
                                <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                                #{row.calendarEventId}
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground" title="Wpis ręczny (spoza kalendarza)">
                                ręczna
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {editable && (
                              <div
                                className="flex justify-end gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {canAutofill(row) && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-primary hover:text-primary"
                                    data-testid={`autofill-row-open-${row.id}`}
                                    onClick={() => setAutofillRow(row)}
                                    {...tip(
                                      "Uzupełnij automatycznie\ngodziny z kalendarza, materiały z protokołu, kilometry z kalkulacji"
                                    )}
                                  >
                                    <Wand2 className="h-4 w-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => openEdit(row)}
                                  title="Edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => handleDelete(row)}
                                  title="Usuń"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Sumy liczone po TYM, CO WIDAĆ — zawężenie filtrów
                        natychmiast zmienia „Razem". */}
                    <tfoot data-testid="realizacje-totals">
                      <tr className="border-t bg-muted/40 font-medium">
                        <td className="px-3 py-2" colSpan={4}>
                          Razem ({visibleRows.length}
                          {visibleRows.length !== rows.length ? ` z ${rows.length}` : ""})
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {numFmt.format(realTotals.actualHours)} h
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {numFmt.format(realTotals.actualKm)} km
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(realTotals.amountHours)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(realTotals.amountMaterial)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(realTotals.amountKm)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(realTotals.discount)}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">
                          {money(realTotals.total)}
                        </td>
                        <td className="px-3 py-2" colSpan={6}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Podsumowanie roczne + mapa realizacji miesiąca obok (na lg+;
              niżej mapa ląduje pod kaflem, pełna szerokość) */}
          {summary && (
            <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(280px,1fr)_2fr]">
            <Card>
              <CardContent className="p-4">
                <h3 className="mb-3 text-sm font-semibold">
                  Rok {year} — przychód / strata
                </h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">Miesiąc</th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Przychód
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Strata
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.months.map((m) => (
                      <tr
                        key={m.month}
                        className={`cursor-pointer border-b last:border-0 hover:bg-accent/50 ${
                          m.month === month ? "bg-accent/40 font-medium" : ""
                        }`}
                        onClick={() => setMonth(m.month)}
                      >
                        <td className="px-2 py-1.5">
                          {MONTH_NAMES[m.month - 1]}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {money(m.revenue)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {m.loss ? money(m.loss) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
            {!loading && <RealizationsMap rows={rows} className="min-h-[280px]" />}
            </div>
          )}
        </TabsContent>

        <TabsContent value="protokoly" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(-1)}
              title="Poprzedni miesiąc"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-40 text-center text-lg font-semibold">
              {MONTH_NAMES[month - 1]} {year}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(1)}
              title="Następny miesiąc"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <p className="ml-2 text-sm text-muted-foreground">
              Protokoły tworzą się automatycznie z realizacji.
            </p>
          </div>

          {/* Pierwsza linia filtrów: szukajka, status, rodzaj prac, podpis. */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Szukaj po numerze, obiekcie, zleceniodawcy…"
              data-testid="protokoly-filter-search"
              value={protoSearch}
              onChange={(e) => setProtoSearch(e.target.value)}
              className="max-w-xs"
            />

            <Select value={protoStatusFilter} onValueChange={setProtoStatusFilter}>
              <SelectTrigger className="w-[180px]" data-testid="protokoly-filter-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie statusy</SelectItem>
                <SelectItem value="draft">Szkic</SelectItem>
                <SelectItem value="final">Zatwierdzony</SelectItem>
              </SelectContent>
            </Select>

            <Select value={protoWorkTypeFilter} onValueChange={setProtoWorkTypeFilter}>
              <SelectTrigger className="w-[180px]" data-testid="protokoly-filter-worktype">
                <SelectValue placeholder="Rodzaj prac" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie rodzaje</SelectItem>
                {/* Rodzaj protokołu to podzbiór rodzajów realizacji — etykiety
                    bierzemy z tego samego słownika, co plakietki w tabeli. */}
                {(["serwis", "montaz", "wizja", "inne"] as const).map((t) => (
                  <SelectItem key={t} value={t}>
                    {REALIZATION_WORK_TYPE_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={protoSignFilter} onValueChange={setProtoSignFilter}>
              <SelectTrigger className="w-[190px]" data-testid="protokoly-filter-signature">
                <SelectValue placeholder="Podpis" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Podpis: wszystkie</SelectItem>
                <SelectItem value="signed">Tylko podpisane</SelectItem>
                <SelectItem value="unsigned">Tylko bez podpisu</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Druga linia: obiekt i wykonawca z danych miesiąca + braki danych zleceniodawcy. */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={protoSiteFilter} onValueChange={setProtoSiteFilter}>
              <SelectTrigger className="w-[220px]" data-testid="protokoly-filter-site">
                <SelectValue placeholder="Obiekt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie obiekty</SelectItem>
                <SelectItem value={NONE}>Bez obiektu</SelectItem>
                {protocolSites.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={protoContractorFilter} onValueChange={setProtoContractorFilter}>
              <SelectTrigger className="w-[200px]" data-testid="protokoly-filter-contractor">
                <SelectValue placeholder="Wykonawca" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszyscy wykonawcy</SelectItem>
                <SelectItem value={NONE}>Bez wykonawcy</SelectItem>
                {protocolContractors.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* To ten sam warunek, co plakietka „do uzupełnienia" przy numerze. */}
            <Select value={protoPrefillFilter} onValueChange={setProtoPrefillFilter}>
              <SelectTrigger className="w-[230px]" data-testid="protokoly-filter-prefill">
                <SelectValue placeholder="Dane zleceniodawcy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Dane zleceniodawcy: wszystkie</SelectItem>
                <SelectItem value="todo">Tylko do uzupełnienia</SelectItem>
                <SelectItem value="done">Tylko uzupełnione</SelectItem>
              </SelectContent>
            </Select>

            {protoFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearProtoFilters}
                data-testid="protokoly-filters-clear"
              >
                <X className="h-4 w-4 mr-1" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          {signNote && (
            <div
              className="flex items-start justify-between gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200"
              role="status"
              data-testid="protocol-sign-note"
            >
              <span>{signNote}</span>
              <button
                type="button"
                className="shrink-0 text-xs underline opacity-80 hover:opacity-100"
                onClick={() => setSignNote(null)}
              >
                ukryj
              </button>
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              {protoLoading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : protocols.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak protokołów w tym miesiącu — dodaj realizację, a protokół
                  powstanie automatycznie.
                </div>
              ) : visibleProtocols.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak protokołów dla wybranych filtrów
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <ProtoSortHeader
                          label="Numer"
                          sortKey="number"
                          title="Numer koduje rok i miesiąc, więc malejąco = najnowsze protokoły u góry"
                        />
                        <ProtoSortHeader label="Data" sortKey="date" />
                        <ProtoSortHeader label="Obiekt" sortKey="site" />
                        <ProtoSortHeader label="Typ" sortKey="workType" />
                        <ProtoSortHeader
                          label="Wykonawca"
                          sortKey="contractor"
                          title="Protokoły bez wpisanego wykonawcy idą na koniec"
                        />
                        <ProtoSortHeader
                          label="Podpis"
                          sortKey="signature"
                          title="Sortowanie po dacie podpisu; protokoły bez podpisu idą na koniec"
                        />
                        <ProtoSortHeader label="Status" sortKey="status" />
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleProtocols.map((proto) => (
                        <tr
                          key={proto.id}
                          data-protocol-id={proto.id}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                          onClick={() => setEditingProto(proto)}
                        >
                          <td className="whitespace-nowrap px-3 py-2 font-medium tabular-nums">
                            {proto.number}
                            {proto.status === "draft" &&
                              !(proto.clientName || "").trim() && (
                                <span
                                  data-testid={`protocol-needs-prefill-${proto.id}`}
                                  className={pillClass("amber", {
                                    compact: true,
                                    className: "ml-2 font-semibold uppercase tracking-wide",
                                  })}
                                  title="Brak danych zleceniodawcy — otwórz protokół i użyj „Uzupełnij z danych”"
                                >
                                  do uzupełnienia
                                </span>
                              )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {new Date(proto.workDate).toLocaleDateString(
                              "pl-PL"
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {proto.installationAddress || proto.site || "—"}
                          </td>
                          <td className="px-3 py-2">
                            <RealizationWorkTypeBadge
                              workType={proto.workType}
                              testIdPrefix="protocol-worktype"
                            />
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {proto.contractor || "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {proto.signaturePng ? (
                              <span
                                className="font-medium"
                                title={
                                  proto.signedAt
                                    ? `Podpisano ${new Date(proto.signedAt).toLocaleString("pl-PL")}`
                                    : undefined
                                }
                              >
                                {proto.signerName || "podpisano"}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {/* Te same kolory i ikony co znacznik protokołu w kalendarzu. */}
                            {proto.status === "final" ? (
                              <span className={protocolBadgeClass("final")}>
                                <FileCheck2 className="h-3.5 w-3.5" aria-hidden />
                                Zatwierdzony
                              </span>
                            ) : (
                              <span className={protocolBadgeClass("draft")}>
                                <FileCheck2 className="h-3.5 w-3.5" aria-hidden />
                                Szkic
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div
                              className="flex justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => printProtocol(proto)}
                                title="Drukuj / PDF"
                              >
                                <Printer className="h-4 w-4" />
                              </Button>
                              {editable && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => setEditingProto(proto)}
                                  title="Edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="wyceny" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Nowa wycena startuje z pozycjami z cennika — uzupełnij ilości i
              dopisz sprzęt. Rok {year}.
            </p>
            {editable && (
              <div className="flex items-center gap-2">
                <select
                  aria-label="Cennik dla nowej wyceny"
                  data-testid="quote-price-list"
                  value={quotePriceListId}
                  onChange={(e) => setQuotePriceListId(Number(e.target.value))}
                  className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value={0}>Cennik główny</option>
                  {priceLists
                    .filter((l) => l.active && !l.isDefault)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
                <Button onClick={handleQuoteNew}>
                  <Plus className="h-4 w-4 mr-2" />
                  Nowa wycena
                </Button>
              </div>
            )}
          </div>

          {/* Pierwsza linia filtrów: szukajka, obiekt z danych, źródło, świeżość. */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Szukaj po numerze, obiekcie, adresie…"
              data-testid="wyceny-filter-search"
              value={quoteSearch}
              onChange={(e) => setQuoteSearch(e.target.value)}
              className="max-w-xs"
            />

            <Select value={quoteSiteFilter} onValueChange={setQuoteSiteFilter}>
              <SelectTrigger className="w-[220px]" data-testid="wyceny-filter-site">
                <SelectValue placeholder="Obiekt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie obiekty</SelectItem>
                <SelectItem value={NONE}>Bez obiektu</SelectItem>
                {quoteSites.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Wycena z realizacji powstaje automatem po podpisaniu protokołu —
                warto umieć oddzielić ją od wycen pisanych od zera. */}
            <Select value={quoteSourceFilter} onValueChange={setQuoteSourceFilter}>
              <SelectTrigger className="w-[210px]" data-testid="wyceny-filter-source">
                <SelectValue placeholder="Źródło" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie źródła</SelectItem>
                <SelectItem value="realization">Tylko z realizacji</SelectItem>
                <SelectItem value="standalone">Tylko wolnostojące</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={quoteFreshMode}
              onValueChange={(v) => setQuoteFreshMode(v as FreshMode)}
            >
              <SelectTrigger className="w-[200px]" data-testid="wyceny-filter-fresh">
                <SelectValue placeholder="Zmieniane" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Zmieniane: kiedykolwiek</SelectItem>
                <SelectItem value="7">Ostatnie 7 dni</SelectItem>
                <SelectItem value="30">Ostatnie 30 dni</SelectItem>
                <SelectItem value="90">Ostatnie 90 dni</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Druga linia: kwota netto — tryb i widełki. */}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={quoteValueMode}
              onValueChange={(v) => setQuoteValueMode(v as ValueMode)}
            >
              <SelectTrigger className="w-[220px]" data-testid="wyceny-filter-value-mode">
                <SelectValue placeholder="Kwota" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Kwota: wszystkie</SelectItem>
                <SelectItem value="with">Tylko wycenione</SelectItem>
                <SelectItem value="without">Tylko puste (0 zł)</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Kwota od</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="wyceny-filter-min"
                value={quoteMinInput}
                onChange={(e) => setQuoteMinInput(e.target.value)}
              />
              <span>do</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="wyceny-filter-max"
                value={quoteMaxInput}
                onChange={(e) => setQuoteMaxInput(e.target.value)}
              />
              <span>zł netto</span>
            </div>
            {quoteFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearQuoteFilters}
                data-testid="wyceny-filters-clear"
              >
                <X className="h-4 w-4 mr-1" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              {quotesLoading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : quotes.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak wycen. Kliknij „Nowa wycena".
                </div>
              ) : visibleQuotes.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak wycen dla wybranych filtrów
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <QuoteSortHeader
                          label="Numer"
                          sortKey="number"
                          title="Numer koduje rok i miesiąc, więc malejąco = najnowsze wyceny u góry"
                        />
                        <QuoteSortHeader label="Data" sortKey="date" />
                        <QuoteSortHeader label="Obiekt" sortKey="site" />
                        <QuoteSortHeader
                          label="Adres"
                          sortKey="address"
                          title="Wyceny bez adresu idą na koniec"
                        />
                        <QuoteSortHeader
                          label="Razem (netto)"
                          sortKey="total"
                          align="right"
                        />
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleQuotes.map((quote) => (
                        <tr
                          key={quote.id}
                          data-quote-id={quote.id}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                          onClick={() => setEditingQuote(quote)}
                        >
                          <td className="whitespace-nowrap px-3 py-2 font-medium tabular-nums">
                            {quote.number}
                            {quote.realizationId != null && (
                              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                z realizacji #{quote.realizationId}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {new Date(quote.date).toLocaleDateString("pl-PL")}
                          </td>
                          <td className="px-3 py-2">{quote.site || "—"}</td>
                          <td className="max-w-64 truncate px-3 py-2 text-muted-foreground">
                            {quote.address || "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {money(quote.total)}
                          </td>
                          <td className="px-3 py-2">
                            <div
                              className="flex justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => printQuote(quote)}
                                title="Drukuj / PDF"
                              >
                                <Printer className="h-4 w-4" />
                              </Button>
                              {editable && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() => setEditingQuote(quote)}
                                    title="Edytuj"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={() => handleQuoteDelete(quote)}
                                    title="Usuń"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cennik" className="space-y-4">
          <PriceListTab editable={editable} />
        </TabsContent>

        <TabsContent value="technicy" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Serwisanci podpowiadani w polach „Wykonawca" przy realizacjach.
            </p>
            {editable && (
              <Button onClick={() => setTechFormOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Dodaj technika
              </Button>
            )}
          </div>

          {/* Filtry kartoteki: szukajka, rodzaj, cennik i powiązanie z kadrami. */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Szukaj po nazwisku, firmie, telefonie…"
              data-testid="technicy-filter-search"
              value={techSearch}
              onChange={(e) => setTechSearch(e.target.value)}
              className="max-w-xs"
            />

            <Select value={techTypeFilter} onValueChange={setTechTypeFilter}>
              <SelectTrigger className="w-[190px]" data-testid="technicy-filter-type">
                <SelectValue placeholder="Typ" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie typy</SelectItem>
                <SelectItem value="internal">Wewnętrzni</SelectItem>
                <SelectItem value="external">Zewnętrzni</SelectItem>
              </SelectContent>
            </Select>

            {/* „Główny" to brak własnego cennika — tak samo pokazuje to tabela. */}
            <Select value={techPriceListFilter} onValueChange={setTechPriceListFilter}>
              <SelectTrigger className="w-[200px]" data-testid="technicy-filter-pricelist">
                <SelectValue placeholder="Cennik" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie cenniki</SelectItem>
                <SelectItem value="main">Cennik główny</SelectItem>
                {priceLists
                  .filter((l) => !l.isDefault)
                  .map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            <Select value={techHrFilter} onValueChange={setTechHrFilter}>
              <SelectTrigger className="w-[210px]" data-testid="technicy-filter-hr">
                <SelectValue placeholder="Kadry" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Kadry: wszyscy</SelectItem>
                <SelectItem value="linked">Tylko na liście płac</SelectItem>
                <SelectItem value="unlinked">Tylko spoza kadr</SelectItem>
              </SelectContent>
            </Select>

            {techFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearTechFilters}
                data-testid="technicy-filters-clear"
              >
                <X className="h-4 w-4 mr-1" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          <Tabs
            value={techView}
            onValueChange={(v) => setTechView(v as "active" | "archived")}
          >
            <TabsList>
              <TabsTrigger value="active">
                Aktywni ({activeTechnicians.length})
              </TabsTrigger>
              <TabsTrigger value="archived">
                Archiwalni ({archivedTechnicians.length})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="active" className="mt-4">
              <Card>
                <CardContent className="p-0">
                  {renderTechTable(
                    activeTechnicians,
                    "Brak techników. Kliknij „Dodaj technika”, aby wpisać pierwszego."
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="archived" className="mt-4">
              <Card>
                <CardContent className="p-0">
                  {renderTechTable(
                    archivedTechnicians,
                    "Brak archiwalnych techników."
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="obiekty" className="space-y-4">
          <TechnicalObjects />
        </TabsContent>
      </Tabs>

      {editingQuote && (
        <QuoteForm
          key={editingQuote.id}
          open={!!editingQuote}
          onClose={() => setEditingQuote(null)}
          onSubmit={handleQuoteUpdate}
          quote={editingQuote}
        />
      )}

      {editingProto && (
        <ProtocolForm
          key={editingProto.id}
          open={!!editingProto}
          onClose={() => setEditingProto(null)}
          onSubmit={handleProtoUpdate}
          onSign={handleProtoSign}
          onUnsign={handleProtoUnsign}
          protocol={editingProto}
          editable={editable}
          onPrefilled={(updated) => {
            setEditingProto(updated);
            loadProtocols();
          }}
        />
      )}

      {techFormOpen && (
        <TechnicianForm
          key={editingTech?.id ?? "new"}
          open={techFormOpen}
          onClose={closeTechForm}
          onSubmit={editingTech ? handleTechUpdate : handleTechCreate}
          technician={editingTech}
          priceLists={priceLists}
          employees={hrEmployees}
        />
      )}

      {formOpen && (
        <RealizationForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={closeForm}
          onSubmit={editing ? handleUpdate : handleCreate}
          realization={editing}
          defaultDate={defaultDate}
          technicians={technicians
            .filter((t) => t.active)
            .map((t) => `${t.firstName} ${t.lastName}`.trim())}
          onAutofilled={handleAutofilled}
        />
      )}

      {/* Automat wywołany prosto z wiersza tabeli (bez otwierania formularza). */}
      {autofillRow && (
        <AutofillDialog
          key={autofillRow.id}
          open
          realization={autofillRow}
          onClose={() => setAutofillRow(null)}
          onApplied={handleAutofilled}
        />
      )}

      <AlertDialog open={!!bulk && bulk.length > 0} onOpenChange={(o) => !o && setBulk(null)}>
        <AlertDialogContent data-testid="autofill-bulk-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Uzupełnić {bulk?.length} {bulk?.length === 1 ? "realizację" : "realizacji"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Zapisane zostaną wyłącznie pola bezkonfliktowe (puste lub zerowe). Nic, co już ma wartość, nie
                  zostanie nadpisane.
                </p>
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs">
                  {bulk?.map((r) => (
                    <li key={r.id} className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{r.site}</span>
                      <span className="shrink-0 tabular-nums">
                        {r.fields.length} {r.fields.length === 1 ? "pole" : r.fields.length < 5 ? "pola" : "pól"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy === "apply"}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              data-testid="autofill-bulk-confirm"
              disabled={bulkBusy === "apply"}
              onClick={(e) => {
                e.preventDefault();
                void runBulkApply();
              }}
            >
              {bulkBusy === "apply" ? "Uzupełnianie…" : "Uzupełnij"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={syncProtoOpen} onOpenChange={setSyncProtoOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Utworzyć brakujące protokoły?</AlertDialogTitle>
            <AlertDialogDescription>
              W tym miesiącu {monthMissingProtocolCount === 1 ? "jest" : "są"}{" "}
              <strong>{monthMissingProtocolCount}</strong>{" "}
              {monthMissingProtocolCount === 1
                ? "realizacja bez protokołu"
                : monthMissingProtocolCount < 5
                  ? "realizacje bez protokołu"
                  : "realizacji bez protokołu"}
              . Operacja utworzy protokoły (szkice) dla{" "}
              <strong>wszystkich</strong> realizacji bez protokołu — również z
              innych miesięcy. Numery zostaną nadane automatycznie.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncingProtos}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-create-missing-protocols"
              disabled={syncingProtos}
              onClick={(e) => {
                e.preventDefault();
                handleSyncProtocols();
              }}
            >
              {syncingProtos ? "Tworzenie…" : "Utwórz"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
