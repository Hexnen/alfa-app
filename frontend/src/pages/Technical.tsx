import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  FilePlus,
  FileX,
  Pencil,
  Trash2,
  Printer,
  Wand2,
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

  /** Cenniki — do kolumny „Cennik" w tabeli techników i selecta w formularzu. */
  const [priceLists, setPriceLists] = useState<PriceListGroup[]>([]);
  /** Cennik wybrany do prefillu nowej wyceny (0 = główny). */
  const [quotePriceListId, setQuotePriceListId] = useState(0);

  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [protoLoading, setProtoLoading] = useState(true);
  const [editingProto, setEditingProto] = useState<Protocol | null>(null);

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null);

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

  const activeTechnicians = technicians.filter((t) => t.active);
  const archivedTechnicians = technicians.filter((t) => !t.active);

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
          {emptyText}
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Imię</th>
              <th className="px-3 py-2 font-medium">Nazwisko</th>
              <th className="px-3 py-2 font-medium">Typ</th>
              <th className="px-3 py-2 font-medium">Cennik</th>
              <th className="px-3 py-2 font-medium">Telefon</th>
              <th className="px-3 py-2 font-medium">E-mail</th>
              <th className="px-3 py-2 font-medium">Firma</th>
              <th className="px-3 py-2 font-medium">NIP</th>
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
    setHighlightRow(id);
    setEditing(row);
    setFormOpen(true);
    window.setTimeout(() => {
      document
        .querySelector(`[data-realization-id="${id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    window.setTimeout(() => setHighlightRow((cur) => (cur === id ? null : cur)), 6000);
  }, [searchParams, setSearchParams, tab, navigate, loading, rows, year, month]);

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

  const missingProtocolCount = rows.filter((r) => !r.protocol).length;
  const withProtocolCount = rows.length - missingProtocolCount;
  /** Liczniki chipów rodzaju/typu — po pozostałych filtrach, żeby zgadzały się z tabelą. */
  const countBy = <K extends string>(pick: (r: Realization) => K) => {
    const out = {} as Record<K, number>;
    for (const r of rows) out[pick(r)] = (out[pick(r)] ?? 0) + 1;
    return out;
  };
  const workTypeCounts = countBy((r) => r.workType);
  const billingCounts = countBy((r) => r.billing);

  const visibleRows = rows.filter(
    (r) =>
      (protoFilter === "with" ? !!r.protocol : protoFilter === "without" ? !r.protocol : true) &&
      (workTypeFilter === "" || r.workType === workTypeFilter) &&
      (billingFilter === "" || r.billing === billingFilter)
  );

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
                      {...tip(`Rodzaj prac: ${meta.label} — ${workTypeCounts[t] ?? 0} w tym miesiącu`)}
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
                      {...tip(`Rozliczenie: ${meta.label} (${meta.hint}) — ${billingCounts[b] ?? 0} w tym miesiącu`)}
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
                {(workTypeFilter || billingFilter) && (
                  <button
                    type="button"
                    data-testid="realization-kind-filter-clear"
                    onClick={() => {
                      setWorkTypeFilter("");
                      setBillingFilter("");
                    }}
                    className="ml-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Wyczyść filtry
                  </button>
                )}
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
                        `Filtr protokołu: ${o.label.toLowerCase()}${o.count != null ? ` — ${o.count} w tym miesiącu` : ""}\n${o.hint}`
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
              {missingProtocolCount > 0 && (
                <div className="ml-auto flex items-center gap-2">
                  <span
                    data-testid="missing-protocols-count"
                    className={pillClass("amber")}
                  >
                    {missingProtocolCount}{" "}
                    {missingProtocolCount === 1
                      ? "realizacja bez protokołu"
                      : missingProtocolCount < 5
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
                <div className="py-10 text-center text-muted-foreground">
                  {workTypeFilter || billingFilter
                    ? "Żadna realizacja w tym miesiącu nie pasuje do wybranych filtrów."
                    : protoFilter === "with"
                      ? "Żadna realizacja w tym miesiącu nie ma jeszcze protokołu."
                      : "Wszystkie realizacje w tym miesiącu mają protokół."}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1360px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Data</th>
                        <th className="px-3 py-2 font-medium">Obiekt</th>
                        <th className="px-3 py-2 font-medium">Rodzaj</th>
                        <th className="px-3 py-2 font-medium">Typ</th>
                        <th
                          className="px-3 py-2 text-right font-medium"
                          {...tip("Faktyczne godziny pracownicze (nie kwota)")}
                        >
                          Godz.
                        </th>
                        <th
                          className="px-3 py-2 text-right font-medium"
                          {...tip("Faktycznie przejechane kilometry (nie kwota)")}
                        >
                          KM
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Kwota godz.
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Materiały
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Kwota KM
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Rabat
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Suma netto
                        </th>
                        <th className="px-3 py-2 font-medium">Adnotacja</th>
                        <th className="px-3 py-2 font-medium">Zafakt.</th>
                        <th className="px-3 py-2 font-medium">Wykonawca</th>
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
                              {/* Obiekt z kartoteki (przez wydarzenie albo nazwę) → link do karty */}
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
                                      row.location.source === "event" ? "z wydarzenia kalendarza" : "po nazwie"
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
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Numer</th>
                        <th className="px-3 py-2 font-medium">Data</th>
                        <th className="px-3 py-2 font-medium">Obiekt</th>
                        <th className="px-3 py-2 font-medium">Typ</th>
                        <th className="px-3 py-2 font-medium">Wykonawca</th>
                        <th className="px-3 py-2 font-medium">Podpis</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {protocols.map((proto) => (
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
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Numer</th>
                        <th className="px-3 py-2 font-medium">Data</th>
                        <th className="px-3 py-2 font-medium">Obiekt</th>
                        <th className="px-3 py-2 font-medium">Adres</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Razem (netto)
                        </th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotes.map((quote) => (
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
              W tym miesiącu {missingProtocolCount === 1 ? "jest" : "są"}{" "}
              <strong>{missingProtocolCount}</strong>{" "}
              {missingProtocolCount === 1
                ? "realizacja bez protokołu"
                : missingProtocolCount < 5
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
