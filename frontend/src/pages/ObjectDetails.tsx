/**
 * KARTOTEKA OBIEKTU — stos sekcji zamiast zakładek.
 *
 * Strona odpowiada po kolei na cztery pytania: „ile ten obiekt zarabia?”
 * (rząd KPI), „czym właściwie jest?” (karta obiektu), „co na nim świadczymy
 * i od kiedy?” (okresy usług), „co się na nim działo?” (umowy, kalendarz
 * i notatki, historia). Zakładki `Tabs` wyleciały, bo chowały połowę tych
 * odpowiedzi za kliknięciem — a przy dziewięciu polach nie ma czego chować.
 *
 * Kalendarz i notatki stoją obok siebie w jednym `grid gap-4 lg:grid-cols-2`:
 * pierwszy mówi, kiedy tam jedziemy, drugi — co o tym obiekcie wiadomo.
 * Notatka wydarzenia z zaznaczonym „Zapisz też w obiekcie” ląduje w karcie po
 * prawej, więc obie karty czyta się razem (`components/ObjectNotes.tsx`).
 *
 * Wzorce wizualne (konwencja repo — cytujemy źródło, nie wymyślamy drugiego
 * stylu):
 *  - lepki pasek dokumentu: `components/offers/OfferEditor.tsx:580`
 *    (`ArrowLeft` ghost, tytuł `text-xl font-semibold`, pigułki, akcje `ml-auto`);
 *  - definicje z ikonami: `components/CalendarEventDialog.tsx:2873`
 *    (`<dl className="grid gap-3 text-sm sm:grid-cols-[120px_1fr]">`);
 *  - kafelki i karty: `components/analytics/*` (`KpiRow`, `KpiTile`, `MarginGauge`,
 *    `ChartCard`, `EmptyState`, `CoverageNote`, `DASH`);
 *  - tabela okresów: `components/analytics/views/ObiektyView.tsx:646-700`
 *    (`thead border-b bg-muted/50 text-xs uppercase`, `px-2 py-2`, `tabular-nums`);
 *  - pigułki: `pillClass`/`PILL_TONE` z `lib/calendar-labels.ts:257-285` — jeden
 *    zestaw tonów jasny/ciemny, bez surowych `slate-*` w tym pliku.
 *
 * Reguła kwot: `null` to „nikt nie uzupełnił”, a NIE 0 zł. Dlatego brak kosztu
 * daje kreskę i notę pokrycia, a nie zero i marżę 100%.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  ClockAlert,
  ExternalLink,
  FileClock,
  FileText,
  Info,
  Landmark,
  MapPin,
  Pencil,
  Plus,
  Repeat,
  Search,
  Send,
  ShieldCheck,
  StickyNote,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { ObjectInterventionSection } from "@/components/interventions/ObjectInterventionSection";
import { ObjectContractDraftsSection } from "@/components/contracts/ObjectContractDraftsSection";
import { SalesEntitySections } from "@/components/sales/SalesEntitySections";
import { CalendarEventDialog, type CalendarDialogMode } from "@/components/CalendarEventDialog";
import { BillingBadge, ProtocolBadge, QuoteBadge, RealizationBadge } from "@/components/CalendarEventBadges";
import {
  EVENT_STATUS_META,
  EVENT_TYPE_META,
  EVENT_TYPE_UI,
  activityIcon,
  eventTipData,
  describeActivity,
  fmtRelative,
  initials,
  pillClass,
  statusBadgeClass,
  fmtRange,
  fmtTimestamp,
  parseLocal,
  parseTimestamp,
  overdueTip,
  type PillTone,
} from "@/lib/calendar-labels";
import {
  ChartCard,
  DASH,
  EmptyState,
  KpiRow,
  KpiTile,
  MarginGauge,
} from "@/components/analytics";
import { tip, tipAttrs } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { ObjectForm } from "@/components/ObjectForm";
import { ObjectNotes } from "@/components/ObjectNotes";
import { usePerms } from "@/auth/permissions";
import { fmtKm, travelSourceLabel, useTravel } from "@/lib/travel";
import { toMapsUrl } from "@/lib/maps-url";
import { RichText } from "@/components/RichText";
import { MapPreviewCard } from "@/components/MapPreviewCard";
import {
  activityApi,
  calendarApi,
  getObject,
  getObjectHistory,
  salespersonName,
  transitionObject,
  updateObject,
  type ActivityEntry,
  type CalendarEvent,
  type ObjectInput,
  type ObjectService,
  type ObjectServiceKind,
  type ObjectWithDetails,
  type ObjectHistoryRecord,
  type WorkflowTransition,
} from "@/lib/api";
import {
  activeServiceFlagsOf,
  installationTypeLabels,
  isServicePeriodEnded,
  isServicePeriodPlanned,
  objectServiceLabels,
  objectServicesOf,
  statusLabels,
  departmentLabels,
  contractStatusLabels,
  formatCurrency,
  formatDate,
  todayIsoLocal,
} from "@/lib/utils";

/**
 * Tony pigułek statusu obiektu. Te same barwy, co na liście i w analityce:
 * oczekujący bursztynowy (czeka na człowieka), w realizacji błękitny (trwa),
 * aktywny zielony, nieaktywny szary.
 */
const STATUS_TONE: Record<string, PillTone> = {
  pending: "amber",
  in_progress: "sky",
  active: "emerald",
  inactive: "neutral",
};

/** Statusy umów — szkic szary, aktywna zielona, wygasła bursztynowa, rozwiązana czerwona. */
const CONTRACT_TONE: Record<string, PillTone> = {
  draft: "neutral",
  active: "emerald",
  expired: "amber",
  terminated: "red",
};

/**
 * Tony rodzajów usług — kopia mapy z `components/ObjectServicesEditor.tsx:47`,
 * żeby ta sama usługa miała ten sam kolor w edytorze i w kartotece. Kopia, a nie
 * import: plik edytora eksportuje wyłącznie komponent (reguła
 * react-refresh/only-export-components).
 */
const SERVICE_TONE: Record<ObjectServiceKind, PillTone> = {
  kamery: "sky",
  sswin: "amber",
  wideorecepcja: "violet",
  ofi: "emerald",
};

const workflowOptions: Record<
  string,
  Array<{ status: string; department: string; label: string }>
> = {
  "pending-sales": [
    {
      status: "in_progress",
      department: "technical",
      label: "Przekaż do działu technicznego",
    },
  ],
  "in_progress-technical": [
    { status: "active", department: "accounting", label: "Zakończ wdrożenie" },
    { status: "pending", department: "sales", label: "Zwróć do handlowego" },
  ],
  "active-accounting": [
    { status: "inactive", department: "accounting", label: "Dezaktywuj" },
  ],
};

/**
 * „za 42 dni” / „jutro” / „3 dni temu” — dopisek przy przewidywanym zakończeniu.
 *
 * Dlaczego nie `fmtRelative` z kalendarza (którym opisujemy znaczniki czasu
 * niżej): ta funkcja liczy WYŁĄCZNIE wstecz. Dla daty w przyszłości różnica
 * wychodzi ujemna i odpowiada „przed chwilą”, a dla przeszłości starszej niż
 * tydzień oddaje samą datę — czyli dokładnie to, co stoi już obok. Przewidywane
 * zakończenie leży zwykle w przyszłości, więc obie strony liczymy tutaj, w dniach
 * kalendarzowych (daty są kalendarzowe, nie chwilowe).
 */
function expectedEndRelative(iso: string, today: string): string {
  const days = Math.round((Date.parse(iso) - Date.parse(today)) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days === 0) return "dziś";
  if (days === 1) return "jutro";
  if (days === -1) return "wczoraj";
  const abs = Math.abs(days);
  const span = abs < 60 ? `${abs} dni` : `${Math.round(abs / 30)} mies.`;
  return days > 0 ? `za ${span}` : `${span} temu`;
}

/** Wiersz definicji karty obiektu: ikona + etykieta po lewej, treść po prawej. */
function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      {/* `items-start`, a nie `items-center`: przy długich uwagach wyśrodkowana
          etykieta odjeżdżała na środek akapitu i wyglądała, jakby opisywała
          jego drugą połowę. */}
      <dt className="flex items-start gap-1.5 text-muted-foreground">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Kreska „nie wiemy” — jedno miejsce na brak danych w całej karcie. */
const Empty = () => <span className="text-muted-foreground">{DASH}</span>;

export function ObjectDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canEdit, canView } = usePerms();
  const editable = canEdit("objects");
  const calViewable = canView("technical/kalendarz");
  const calEditable = canEdit("technical/kalendarz");
  const [object, setObject] = useState<ObjectWithDetails | null>(null);
  const [history, setHistory] = useState<ObjectHistoryRecord[]>([]);

  // --- Kalendarz obiektu + activity_log ---
  const [calEvents, setCalEvents] = useState<CalendarEvent[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [calDialogOpen, setCalDialogOpen] = useState(false);
  const [calDialogMode, setCalDialogMode] = useState<CalendarDialogMode>("create");
  const [calDialogEvent, setCalDialogEvent] = useState<CalendarEvent | null>(null);
  const [calNonce, setCalNonce] = useState(0);
  /** Podbijane po zapisie wydarzenia — z dialogu można skopiować notatkę do obiektu. */
  const [notesNonce, setNotesNonce] = useState(0);

  const loadCalendar = useCallback(async (objectId: number) => {
    // Historia (activity_log) jest czytelna dla każdego zalogowanego;
    // lista wydarzeń wymaga uprawnienia technical/kalendarz.
    activityApi
      .object(objectId)
      .then((res) => setActivity(res.data || []))
      .catch(() => setActivity([]));
    if (!calViewable) return;
    calendarApi
      .objectEvents(objectId)
      .then((res) => setCalEvents(res.data || []))
      .catch(() => setCalEvents([]));
  }, [calViewable]);

  useEffect(() => {
    if (!id) return;
    loadCalendar(parseInt(id));
  }, [id, loadCalendar]);

  const openCalCreate = () => {
    setCalDialogMode("create");
    setCalDialogEvent(null);
    setCalNonce((n) => n + 1);
    setCalDialogOpen(true);
  };
  const openCalEvent = (ev: CalendarEvent) => {
    setCalDialogMode(calEditable && !ev.deletedAt ? "edit" : "view");
    setCalDialogEvent(ev);
    setCalNonce((n) => n + 1);
    setCalDialogOpen(true);
  };

  // Znacznik "teraz" ustalony przy montażu (czysty render — bez Date.now w useMemo).
  const [nowTs] = useState(() => Date.now());
  const [today] = useState(() => todayIsoLocal());
  const { upcoming, past } = useMemo(() => {
    const now = nowTs;
    const up: CalendarEvent[] = [];
    const pa: CalendarEvent[] = [];
    for (const ev of calEvents) {
      (parseLocal(ev.endAt).getTime() >= now ? up : pa).push(ev);
    }
    up.sort((a, b) => a.startAt.localeCompare(b.startAt));
    pa.sort((a, b) => b.startAt.localeCompare(a.startAt));
    return { upcoming: up, past: pa };
  }, [calEvents, nowTs]);

  /** Scalona historia: object_history + activity_log, sort. malejąco po dacie. */
  const mergedHistory = useMemo(() => {
    type HistoryRow =
      | { key: string; at: number; kind: "object"; item: ObjectHistoryRecord }
      | { key: string; at: number; kind: "calendar"; item: ActivityEntry }
      // Dziennik po `object_id` niesie też wpisy, które NIE są wydarzeniem
      // kalendarza — notatki kartoteki (`entity_type = "object"`). Bez własnego
      // rodzaju lądowałyby pod nagłówkiem „Wydarzenie w kalendarzu”, w którym
      // nie ma czego kliknąć, i wypadałyby z filtra „Tylko obiekt”.
      | { key: string; at: number; kind: "objectActivity"; item: ActivityEntry };
    const rows: HistoryRow[] = [
      ...history.map((item) => ({
        key: `h-${item.id}`,
        at: parseTimestamp(item.createdAt).getTime(),
        kind: "object" as const,
        item,
      })),
      ...activity.map((item) => ({
        key: `a-${item.id}`,
        at: parseTimestamp(item.createdAt).getTime(),
        kind: item.entityType === "calendar_event" ? ("calendar" as const) : ("objectActivity" as const),
        item,
      })),
    ];
    rows.sort((a, b) => b.at - a.at);
    // Agregacja: kilka pól zmienionych w jednej operacji (ten sam event, autor,
    // sekunda) → jeden wpis „zmienił N pól” (pattern audit-feed).
    const out: (HistoryRow & { more?: ActivityEntry[] })[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (
        r.kind === "calendar" &&
        last?.kind === "calendar" &&
        r.item.action === "updated" &&
        last.item.action === "updated" &&
        r.item.createdAt === last.item.createdAt &&
        r.item.userLabel === last.item.userLabel &&
        r.item.event?.id === last.item.event?.id
      ) {
        (last.more ??= []).push(r.item);
      } else out.push({ ...r });
    }
    return out;
  }, [history, activity]);

  // Filtry historii: źródło, aktor, szukaj
  const [histSource, setHistSource] = useState<"all" | "calendar" | "object">("all");
  const [histActor, setHistActor] = useState<string>("all");
  const [histQuery, setHistQuery] = useState("");
  const [histLimit, setHistLimit] = useState(30);
  const actors = useMemo(() => {
    const s = new Set<string>();
    for (const r of mergedHistory) {
      const who = r.kind === "object" ? r.item.changedBy : r.item.userLabel;
      if (who) s.add(who);
    }
    return [...s].sort((a, b) => a.localeCompare(b, "pl"));
  }, [mergedHistory]);
  const filteredHistory = useMemo(() => {
    const q = histQuery.trim().toLowerCase();
    return mergedHistory.filter((r) => {
      // Notatki kartoteki idą pod „Tylko obiekt” razem z object_history — dla
      // czytającego to jedno źródło: zmiany w kartotece, nie w kalendarzu.
      const source = r.kind === "calendar" ? "calendar" : "object";
      if (histSource !== "all" && source !== histSource) return false;
      const who = r.kind === "object" ? r.item.changedBy : r.item.userLabel;
      if (histActor !== "all" && who !== histActor) return false;
      if (q) {
        const text =
          r.kind === "object"
            ? `${r.item.action} ${r.item.description ?? ""} ${who ?? ""}`
            : r.kind === "objectActivity"
              ? `${r.item.summary ?? describeActivity(r.item)} ${who ?? ""}`
              : `${r.item.event?.title ?? ""} ${describeActivity(r.item)}`;
        if (!text.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [mergedHistory, histSource, histActor, histQuery]);
  const [loading, setLoading] = useState(true);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  /**
   * `?edit=1` otwiera od razu edycję kartoteki. Wchodzi się tak z formularza
   * nowej umowy („Przypisz spółkę w karcie obiektu”) — bez tego użytkownik
   * lądowałby na karcie i musiał sam znaleźć przycisk „Edytuj”.
   *
   * Parametr KASUJEMY zaraz po otwarciu: gdyby został w adresie, odświeżenie
   * strony albo powrót „wstecz” otwierałyby dialog jeszcze raz.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("edit") !== "1") return;
    setEditOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("edit");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const [transitionData, setTransitionData] = useState<WorkflowTransition>({
    newStatus: "pending",
    newDepartment: "sales",
    description: "",
  });

  /** Przeładowanie kartoteki po zapisie (edycja, przejście workflow). */
  const reload = useCallback(async (objectId: number) => {
    const [objRes, historyRes] = await Promise.all([
      getObject(objectId),
      getObjectHistory(objectId),
    ]);
    setObject(objRes.data!);
    setHistory(historyRes.data);
  }, []);

  useEffect(() => {
    if (!id) return;
    reload(parseInt(id))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id, reload]);

  /**
   * Dojazd biuro → obiekt liczy backend (`GET /company/travel`) — ten sam hook,
   * co w dialogu wydarzenia (`CalendarEventDialog.tsx:2191`) i w kalendarzu, więc
   * kilometry w obu miejscach zawsze zgadzają się co do przecinka.
   */
  const { travel, loading: travelLoading } = useTravel(object?.id, !!object);

  const handleTransition = async () => {
    if (!editable) return;
    if (!object) return;
    try {
      await transitionObject(object.id, transitionData);
      await reload(object.id);
      setTransitionOpen(false);
    } catch (error) {
      console.error("Error transitioning object:", error);
    }
  };

  const handleEditSubmit = async (data: ObjectInput) => {
    if (!editable || !object) return;
    await updateObject(object.id, data);
    await reload(object.id);
  };

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Ładowanie…</div>;
  }

  if (!object) {
    return <div className="py-8 text-center text-muted-foreground">Obiekt nie znaleziony</div>;
  }

  const currentWorkflowKey = `${object.status}-${object.department}`;
  const availableTransitions = workflowOptions[currentWorkflowKey] || [];

  // --- Usługi: źródłem prawdy są okresy, flagi `hasX` to tylko cache stanu na
  // dziś. Starszy backend okresów nie odsyła (`services?`), więc pigułki „co
  // obiekt ma dziś” liczymy z okresów, gdy są, a w przeciwnym razie z flag.
  const periods: ObjectService[] = object.services ?? [];
  const flags =
    periods.length > 0
      ? activeServiceFlagsOf(periods, today)
      : {
          hasCameras: object.hasCameras,
          hasSswin: object.hasSswin,
          hasVideoreception: object.hasVideoreception,
          hasOfi: object.hasOfi,
          cameraCount: object.cameraCount,
        };
  const activeServiceKeys = objectServicesOf(flags);
  /** Okresy w kolejności: trwające i zaplanowane najpierw, zakończone na dole. */
  const sortedPeriods = [...periods].sort((a, b) => {
    const ea = isServicePeriodEnded(a, today) ? 1 : 0;
    const eb = isServicePeriodEnded(b, today) ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return b.startDate.localeCompare(a.startDate);
  });

  // --- Ekonomia obiektu. `monthlyCost === null` znaczy „nikt tego nie uzupełnił”,
  // więc zysku ani marży nie liczymy — inaczej każdy pusty obiekt miałby 100%.
  const monthlyCost = object.monthlyCost ?? null;
  const setupCost = object.setupCost ?? null;
  // Przychód miesięczny = abonament ZDW + abonament OFI + dzierżawa sprzętu
  // (klient płaci wszystkie trzy pozycje).
  const monthlyRevenue =
    (object.monthlyZdw ?? 0) + (object.monthlyOfi ?? 0) + (object.monthlyRental ?? 0);
  // Puste kwoty to „nieuzupełnione”, a nie 0 zł — tak samo jak przy koszcie
  // niżej. Bez tego obiekt bez kwot chwaliłby się „0,00 zł przychodu” obok
  // kreski w koszcie, jakby przychód ktoś ustalił na zero.
  const hasRevenue =
    object.monthlyZdw != null || object.monthlyOfi != null || object.monthlyRental != null;
  /** Rozbicie pod kwotą — pokazujemy tylko wypełnione linie, kreski nic nie wnoszą. */
  const revenueParts = [
    object.monthlyZdw != null ? `ZDW ${formatCurrency(object.monthlyZdw)}` : null,
    object.monthlyOfi != null ? `OFI ${formatCurrency(object.monthlyOfi)}` : null,
    object.monthlyRental != null ? `dzierżawa ${formatCurrency(object.monthlyRental)}` : null,
  ].filter((s): s is string => s !== null);
  const monthlyProfit = monthlyCost === null ? null : monthlyRevenue - monthlyCost;
  const marginPct =
    monthlyProfit === null || !monthlyRevenue
      ? null
      : Math.round((monthlyProfit / monthlyRevenue) * 100);
  const paybackMonths =
    setupCost === null || monthlyProfit === null
      ? null
      : monthlyProfit <= 0
        ? Infinity
        : Math.ceil(setupCost / monthlyProfit);

  // --- Lokalizacja
  const hasCoords = object.latitude != null && object.longitude != null;
  const mapsHref =
    object.mapsUrl ??
    (hasCoords ? toMapsUrl(object.latitude as number, object.longitude as number) : null);

  const expectedEnd = object.expectedEndDate;
  const expectedEndPast = !!expectedEnd && expectedEnd < today;

  const actionLabels: Record<string, string> = {
    created: "Utworzono",
    updated: "Zaktualizowano",
    transition: "Zmieniono status",
    contract_created: "Dodano umowę",
    contract_updated: "Zaktualizowano umowę",
    contract_deleted: "Usunięto umowę",
  };

  return (
    <div className="space-y-4">
      {/* Pasek obiektu — lepki, żeby nazwa, status i akcje były pod ręką także
          pod historią (wzorzec: offers/OfferEditor.tsx:580). */}
      <div className="sticky top-0 z-20 -mx-3 flex flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur lg:-mx-4 lg:px-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/objects")}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Obiekty
        </Button>
        <h1 className="text-xl font-semibold">{object.name}</h1>
        <span className={pillClass(STATUS_TONE[object.status] ?? "neutral")}>
          {statusLabels[object.status]}
        </span>
        {/* Pigułki usług = stan NA DZIŚ (okresy zakończone tu nie wchodzą);
            pełna historia okresów jest w sekcji „Usługi”. */}
        {activeServiceKeys.map((k) => (
          <span key={k} className={pillClass(SERVICE_TONE[k])}>
            {k === "kamery"
              ? `Kamery ${flags.cameraCount ?? "(ilość?)"}`
              : objectServiceLabels[k]}
          </span>
        ))}
        <span
          className={pillClass("muted")}
          {...tip("Dział, który obecnie prowadzi obiekt")}
        >
          {departmentLabels[object.department]}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mapsHref && (
            <a
              href={mapsHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-primary hover:underline"
              {...tip(
                object.mapsUrl
                  ? "Link do pinezki zapisany w kartotece"
                  : "Mapa dla współrzędnych obiektu"
              )}
              data-testid="object-maps-link"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Otwórz w Google Maps
            </a>
          )}
          {editable && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1 h-4 w-4" /> Edytuj
            </Button>
          )}
          {/* Przejścia workflow tam, gdzie reszta akcji dokumentu — osobna karta
              „Akcje workflow” zajmowała trzecią część ekranu na dwa przyciski. */}
          {editable &&
            availableTransitions.map((transition, i) => (
              <Button
                key={`${transition.status}-${transition.department}`}
                size="sm"
                variant={i === 0 ? "default" : "outline"}
                onClick={() => {
                  setTransitionData({
                    newStatus: transition.status as WorkflowTransition["newStatus"],
                    newDepartment: transition.department as WorkflowTransition["newDepartment"],
                    description: "",
                  });
                  setTransitionOpen(true);
                }}
              >
                <Send className="mr-1 h-4 w-4" />
                {transition.label}
              </Button>
            ))}
        </div>
      </div>

      {!editable && <ReadOnlyBanner />}

      {/* --- Ekonomia obiektu w jednym rzędzie --- */}
      <KpiRow>
        <KpiTile
          label="Przychód mies."
          value={hasRevenue ? formatCurrency(monthlyRevenue) : DASH}
          sub={
            // Rozbicie mówi, Z CZEGO ta kwota jest — a to informacja także przy
            // jednej wypełnionej linii („9 543 zł” z samego ZDW to co innego niż
            // z samej dzierżawy). Znika dopiero, gdy nie ma ani jednej kwoty.
            revenueParts.length > 0 ? (
              <span data-testid="object-revenue-breakdown">{revenueParts.join(" · ")}</span>
            ) : undefined
          }
          tip="Abonament ZDW + abonament OFI + dzierżawa sprzętu (netto)"
        />
        <KpiTile
          label="Koszt mies."
          value={monthlyCost === null ? DASH : formatCurrency(monthlyCost)}
          tip="Koszty poza wynagrodzeniami (monitoring, sprzęt, abonamenty). Pensje załogi dolicza Analityka z Kadr."
          // Nota pokrycia stoi TYLKO przy koszcie — to jedyna luka, którą da się
          // tu wypełnić. Powtarzanie jej pod zyskiem, marżą i zwrotem czyniłoby
          // z jednego braku cztery ostrzeżenia.
          coverage={{ known: monthlyCost === null ? 0 : 1, total: 1, noun: "obiektu" }}
        />
        <KpiTile
          label="Zysk mies."
          value={monthlyProfit === null ? DASH : formatCurrency(monthlyProfit)}
          tone={
            monthlyProfit === null ? "neutral" : monthlyProfit >= 0 ? "good" : "bad"
          }
          sub={monthlyProfit === null ? "brak kosztu" : undefined}
        />
        <KpiTile label="Marża" value={<MarginGauge value={marginPct} size="lg" />} />
        <KpiTile
          label="Koszt instalacji"
          value={setupCost === null ? DASH : formatCurrency(setupCost)}
          tip="Jednorazowy nakład na wdrożenie"
        />
        <KpiTile
          label="Zwrot"
          value={
            paybackMonths === null
              ? DASH
              : paybackMonths === Infinity
                ? "nigdy"
                : `${paybackMonths} mies.`
          }
          tone={paybackMonths === Infinity ? "bad" : "neutral"}
          tip="Ile miesięcy zysku pokrywa koszt instalacji"
        />
      </KpiRow>
      {/* Jedno zdanie o konwencji na całą stronę zamiast dopisku „netto” przy
          każdej kwocie. Druga połowa jest ważniejsza: zysk i marża stoją tu
          WYŁĄCZNIE na koszcie pozostałym — koszt osobowy z Kadr dokłada dopiero
          Analityka, więc marża z tej karty jest zawyżona dla każdego obiektu,
          na którym stoją ludzie. */}
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Wszystkie kwoty są netto (bez VAT). Zysk i marża liczone są z samego kosztu
        pozostałego — koszt osobowy z Kadr dolicza dopiero Analityka.
      </p>

      <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {/* --- Karta obiektu: kto, gdzie, czyje --- */}
          <ChartCard
            title="Karta obiektu"
            description={`Kartoteka #${object.id} · zaktualizowana ${fmtRelative(object.updatedAt)}`}
          >
            <dl className="grid gap-3 text-sm sm:grid-cols-[120px_1fr]">
              <Row icon={Building2} label="Kontrahent">
                {object.contractor ? (
                  <>
                    <Link
                      to={`/objects?contractorId=${object.contractor.id}`}
                      className="font-medium text-primary hover:underline"
                      {...tip("Pokaż wszystkie obiekty tego kontrahenta")}
                    >
                      {object.contractor.name}
                    </Link>
                    {object.contractor.nip && (
                      <div className="text-xs tabular-nums text-muted-foreground">
                        NIP {object.contractor.nip}
                      </div>
                    )}
                  </>
                ) : (
                  <Empty />
                )}
              </Row>

              <Row icon={MapPin} label="Adres">
                {object.address || object.city ? (
                  <div className="font-medium">
                    {[object.address, object.city].filter(Boolean).join(", ")}
                  </div>
                ) : (
                  <Empty />
                )}
                {hasCoords && (
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {object.latitude!.toFixed(5)}, {object.longitude!.toFixed(5)}
                  </div>
                )}
                {mapsHref && (
                  <a
                    href={mapsHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> Google Maps
                  </a>
                )}
                {/* Mini-mapa pinezki — ta sama karta, co pod linkiem w notatce.
                    Mając współrzędne w kartotece rysujemy ją BEZ pytania backendu;
                    sam link do Map (bez współrzędnych) idzie przez podgląd linku. */}
                {mapsHref && (
                  <MapPreviewCard
                    href={mapsHref}
                    point={
                      hasCoords
                        ? {
                            lat: object.latitude as number,
                            lng: object.longitude as number,
                            label: object.name,
                          }
                        : null
                    }
                    url={hasCoords ? undefined : (object.mapsUrl ?? undefined)}
                    className="mt-1.5 max-w-sm"
                  />
                )}
                {/* Dojazd z biura — ta sama linia, co w dialogu wydarzenia. */}
                <div className="text-xs text-muted-foreground">
                  {travel?.error
                    ? travel.error
                    : travel?.km != null
                      ? `${fmtKm(travel.km)} z biura${
                          travelSourceLabel(travel, travelLoading)
                            ? ` · ${travelSourceLabel(travel, travelLoading)}`
                            : ""
                        }`
                      : travelLoading
                        ? "dojazd: liczę…"
                        : ""}
                </div>
              </Row>

              <Row icon={Wrench} label="Instalacja">
                {installationTypeLabels[object.installationType] ?? <Empty />}
              </Row>

              <Row icon={ArrowRight} label="Dział">
                <span className={pillClass("muted")}>
                  {departmentLabels[object.department]}
                </span>
              </Row>

              <Row icon={Landmark} label="Spółka">
                {object.company?.name ?? <Empty />}
              </Row>

              <Row icon={UserRound} label="Handlowiec">
                {object.salesperson ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{salespersonName(object.salesperson)}</span>
                    {object.salesperson.inherited && (
                      <span
                        className={pillClass("muted", { compact: true })}
                        {...tip("Opiekun kontrahenta — obiekt nie ma własnego handlowca")}
                      >
                        dziedziczony
                      </span>
                    )}
                  </span>
                ) : (
                  <Empty />
                )}
              </Row>

              <Row icon={CalendarClock} label="Przew. zakończenie">
                {/* Testid siedzi na kontenerze, a nie w gałęzi z datą — inaczej
                    znikałby dla obiektów bezterminowych i test nie miałby czego
                    sprawdzić poza obecnością wiersza. */}
                <span
                  data-testid="object-expected-end"
                  className={cn(
                    "inline-flex flex-wrap items-baseline gap-1.5",
                    // Data w przeszłości to sygnał do działania (przedłużyć albo
                    // domknąć obiekt), a nie zwykła informacja — stąd bursztyn.
                    expectedEndPast && "text-amber-700 dark:text-amber-300"
                  )}
                >
                  {expectedEnd ? (
                    <>
                      <span className="font-medium tabular-nums">{formatDate(expectedEnd)}</span>
                      <span className={cn("text-xs", !expectedEndPast && "text-muted-foreground")}>
                        {expectedEndRelative(expectedEnd, today)}
                        {expectedEndPast ? " · termin minął" : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">bezterminowo</span>
                  )}
                </span>
              </Row>

              {object.notes && (
                <Row icon={StickyNote} label="Uwagi">
                  <RichText text={object.notes} />
                </Row>
              )}
            </dl>
          </ChartCard>

          {/* --- Okresy usług --- */}
          <ChartCard
            title="Usługi"
            description="Okresy świadczenia. Zakończony okres zostaje w kartotece, ale nie liczy się do flag, filtrów ani analityki."
            controls={
              editable ? (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Plus className="mr-1 h-4 w-4" /> Dodaj usługę
                </Button>
              ) : undefined
            }
          >
            {sortedPeriods.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="Brak okresów usług"
                description={
                  editable
                    ? "Dodaj pierwszy okres („Dodaj usługę”), żeby kartoteka wiedziała, co i od kiedy świadczymy na tym obiekcie."
                    : "Nikt nie zapisał jeszcze, co i od kiedy świadczymy na tym obiekcie."
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="object-services-list">
                  <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 text-left font-medium">Usługa</th>
                      <th className="px-2 py-2 text-left font-medium">Od</th>
                      <th className="px-2 py-2 text-left font-medium">Do</th>
                      <th className="px-2 py-2 text-right font-medium">Kamery</th>
                      <th className="px-2 py-2 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPeriods.map((p) => {
                      const ended = isServicePeriodEnded(p, today);
                      const planned = isServicePeriodPlanned(p, today);
                      return (
                        <tr
                          key={p.id}
                          className={cn("border-b last:border-0", ended && "opacity-60")}
                        >
                          <td className="px-2 py-2">
                            <span className={pillClass(SERVICE_TONE[p.service])}>
                              {objectServiceLabels[p.service]}
                            </span>
                          </td>
                          <td className="px-2 py-2 tabular-nums">{formatDate(p.startDate)}</td>
                          <td className="px-2 py-2 tabular-nums">
                            {p.endDate ? (
                              formatDate(p.endDate)
                            ) : (
                              <span className="text-muted-foreground">bezterminowo</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {p.service !== "kamery" ? (
                              <span className="text-muted-foreground">·</span>
                            ) : p.cameraCount == null ? (
                              // Brak liczby to „nikt nie policzył”, a nie zero —
                              // od niej zależy waga obiektu w koszcie centrum.
                              <span
                                className="text-muted-foreground"
                                {...tip("Usługa jest, ale kamer nikt nie policzył")}
                              >
                                (ilość?)
                              </span>
                            ) : (
                              p.cameraCount
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {ended ? (
                              <span className={pillClass("muted")}>zakończona</span>
                            ) : planned ? (
                              <span className={pillClass("indigo")}>zaplanowana</span>
                            ) : (
                              <span className={pillClass("emerald")}>trwa</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </ChartCard>
        </div>

        {/* --- Umowy: wąska kolumna, bo to lista odnośników, nie tabela --- */}
        <ChartCard
          title="Umowy"
          description={
            object.contracts.length > 0
              ? `${object.contracts.length} w kartotece`
              : undefined
          }
          className="h-fit"
        >
          {object.contracts.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="Brak umów"
              description="Umowy podpięte do tego obiektu pojawią się tutaj."
            />
          ) : (
            <ul className="divide-y rounded-md border" data-testid="object-contracts-list">
              {object.contracts.map((contract) => (
                <li key={contract.id} className="space-y-1 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{contract.contractNumber}</span>
                    <span className={pillClass(CONTRACT_TONE[contract.status] ?? "neutral")}>
                      {contractStatusLabels[contract.status]}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="tabular-nums">
                      {formatDate(contract.startDate)}
                      {contract.endDate ? ` – ${formatDate(contract.endDate)}` : " – bezterminowo"}
                    </span>
                    <span className="tabular-nums">
                      {contract.value == null ? DASH : formatCurrency(contract.value)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>
      </div>

      {/* --- Co się dzieje na obiekcie: kalendarz obok notatek ---
          Para kart w tym samym rytmie, co pozostałe pary na tej stronie
          (`grid gap-4 lg:grid-cols-2`). Kalendarz odpowiada „kiedy tam
          jedziemy”, notatki — „co o tym obiekcie wiadomo”; obie odpowiedzi
          czyta się razem, a notatka z kalendarza ląduje właśnie tu obok. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={
            <span className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              Kalendarz
            </span>
          }
          description={`${upcoming.length} nadchodzących · ${past.length} przeszłych · wydarzenia działu technicznego`}
          controls={
            calEditable ? (
              <Button size="sm" onClick={openCalCreate}>
                <Plus className="mr-1 h-4 w-4" /> Zaplanuj
              </Button>
            ) : undefined
          }
          bodyClassName="space-y-5"
        >
          {!calViewable ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Brak uprawnień do kalendarza działu technicznego.
            </p>
          ) : calEvents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-center">
              <CalendarPlus className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm font-medium">Brak zaplanowanych wydarzeń</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Serwisy, montaże i konserwacje powiązane z tym obiektem pojawią się tutaj.
              </p>
              {calEditable && (
                <Button size="sm" variant="outline" className="mt-1" onClick={openCalCreate}>
                  <Plus className="mr-1 h-4 w-4" /> Zaplanuj pierwsze
                </Button>
              )}
            </div>
          ) : (
            <>
              <ObjectEventList
                title="Nadchodzące"
                count={upcoming.length}
                events={upcoming}
                nowTs={nowTs}
                onOpen={openCalEvent}
                emptyText="Nic nie jest zaplanowane."
              />
              <ObjectEventList
                title="Przeszłe"
                count={past.length}
                events={past}
                nowTs={nowTs}
                onOpen={openCalEvent}
                emptyText="Brak wcześniejszych wydarzeń."
                muted
              />
            </>
          )}
        </ChartCard>

        {/* Notatki kartoteki — także kopie notatek z wydarzeń („Zapisz też w obiekcie”).
            `notesNonce` przeładowuje listę po zapisie w dialogu kalendarza. */}
        {canView("objects") && (
          <ObjectNotes objectId={object.id} canEdit={editable} reloadKey={notesNonce} />
        )}
      </div>

      {/* --- Lejek handlowy: szanse i osoby kontaktowe tego obiektu ---
          Każda sekcja za własnym kluczem (`handlowy/leady`, `handlowy/kontakty`);
          bez żadnego z nich komponent nie renderuje niczego. */}
      <SalesEntitySections
        objectId={object.id}
        editable={canEdit("objects")}
        className="grid gap-4 lg:grid-cols-2"
      />

      {/* --- Grupa interwencyjna: warunki i podjazdy ---
          Osobna sekcja za WŁASNYM kluczem uprawnień (`cma/grupy-interwencyjne`):
          kto go nie ma, nie widzi ani tabel, ani zapytań, które je zasilają. */}
      {canView("cma/grupy-interwencyjne") && (
        <ObjectInterventionSection
          object={{
            id: object.id,
            name: object.name,
            address: object.address ?? null,
            city: object.city ?? null,
            contractorName: object.contractor?.name ?? null,
          }}
          editable={canEdit("cma/grupy-interwencyjne")}
        />
      )}

      {/* --- Umowy (drafty) ---
          Za kluczem `contracts`, tak jak cała zakładka Umowy: kto go nie ma, nie
          widzi ani tabeli, ani zapytania, które ją zasila. */}
      {canView("contracts") && (
        <ObjectContractDraftsSection
          object={{
            id: object.id,
            name: object.name,
            address: object.address ?? null,
            city: object.city ?? null,
            contractorName: object.contractor?.name ?? null,
            companyId: object.company?.id ?? null,
            companyName: object.company?.name ?? null,
          }}
          editable={canEdit("contracts")}
        />
      )}

      {/* --- Historia: object_history + activity_log w jednej osi czasu --- */}
      <ChartCard
        title={
          <span className="flex items-center gap-2">
            <FileClock className="h-4 w-4 text-muted-foreground" />
            Historia
          </span>
        }
        description="Zmiany kartoteki i wydarzeń kalendarza, od najnowszych."
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* Segmented control — ten sam idiom, co przełączniki w dziale
              technicznym: obwódka + tło `bg-muted/50` i aktywny klawisz. */}
          <div
            role="radiogroup"
            aria-label="Źródło wpisów"
            className="inline-flex gap-0.5 rounded-md border bg-muted/50 p-0.5 text-xs"
          >
            {(
              [
                ["all", "Wszystko"],
                ["calendar", "Tylko kalendarz"],
                ["object", "Tylko obiekt"],
              ] as const
            ).map(([v, l]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={histSource === v}
                onClick={() => setHistSource(v)}
                className={cn(
                  "rounded px-2.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  histSource === v
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60"
                )}
              >
                {l}
              </button>
            ))}
          </div>
          {actors.length > 1 && (
            <Select value={histActor} onValueChange={setHistActor}>
              <SelectTrigger className="h-8 w-auto min-w-[10rem] text-xs" aria-label="Autor wpisu">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszyscy autorzy</SelectItem>
                {actors.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="relative ml-auto w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Szukaj w historii"
              value={histQuery}
              onChange={(e) => setHistQuery(e.target.value)}
              placeholder="Szukaj w historii…"
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>
        {filteredHistory.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {mergedHistory.length === 0
              ? "Brak historii dla tego obiektu"
              : "Brak wpisów pasujących do filtra."}
          </p>
        ) : (
          <ol className="relative ml-3 border-l pl-5">
            {filteredHistory.slice(0, histLimit).map((row) => {
              const when = row.item.createdAt;
              const who = row.kind === "object" ? row.item.changedBy : row.item.userLabel;
              const evRef = row.kind === "calendar" ? row.item.event : null;
              const typeUi = evRef ? EVENT_TYPE_UI[evRef.type] : null;
              const TypeIcon = evRef ? EVENT_TYPE_META[evRef.type]?.icon : null;
              const ActIcon =
                row.kind === "object" ? FileClock : activityIcon(row.item.action);
              return (
                <li key={row.key} className="relative pb-4 last:pb-0">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -left-[1.6rem] top-1 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-background",
                      typeUi ? typeUi.dot : "bg-muted-foreground/60"
                    )}
                  >
                    {TypeIcon ? (
                      <TypeIcon className="h-2.5 w-2.5 text-white" />
                    ) : (
                      <Building2 className="h-2.5 w-2.5 text-white" />
                    )}
                  </span>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      {row.kind === "object" ? (
                        <>
                          <p className="flex items-center gap-1.5 text-sm">
                            <ActIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="font-medium">
                              {actionLabels[row.item.action] || row.item.action}
                            </span>
                            <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                              obiekt
                            </span>
                          </p>
                          {row.item.description && (
                            <p className="text-sm text-muted-foreground">
                              {row.item.description}
                            </p>
                          )}
                        </>
                      ) : row.kind === "objectActivity" ? (
                        /* Notatka kartoteki — wpis dziennika bez wydarzenia:
                           własny nagłówek, żeby nie udawał kalendarza. Treść
                           niesie `summary` („Dodano notatkę obiektu: …”). */
                        <>
                          <p className="flex items-center gap-1.5 text-sm">
                            <ActIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="font-medium">
                              {row.item.field === "note" ? "Notatka kartoteki" : "Zmiana w kartotece"}
                            </span>
                            <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                              obiekt
                            </span>
                          </p>
                          {/* Autora niesie awatar po prawej — tak samo jak przy
                              wpisach z object_history, więc tu zostaje sama treść. */}
                          <p className="text-sm text-muted-foreground">
                            {row.item.summary ?? describeActivity(row.item)}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="flex flex-wrap items-center gap-1.5 text-sm">
                            <ActIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            {evRef ? (
                              <button
                                type="button"
                                className="text-left font-medium hover:underline"
                                onClick={() => {
                                  const ev = calEvents.find((e) => e.id === evRef.id);
                                  if (ev) openCalEvent(ev);
                                }}
                              >
                                {evRef.title}
                              </button>
                            ) : (
                              <span className="font-medium">Wydarzenie w kalendarzu</span>
                            )}
                            {evRef && (
                              <span
                                className={cn(
                                  "rounded px-1.5 py-px text-[10px] uppercase tracking-wide",
                                  typeUi?.soft
                                )}
                              >
                                {EVENT_TYPE_META[evRef.type]?.label}
                              </span>
                            )}
                            {evRef?.deletedAt && (
                              <span className="text-xs text-red-600 dark:text-red-400">
                                (usunięte)
                              </span>
                            )}
                          </p>
                          {row.more ? (
                            <div className="text-sm text-muted-foreground">
                              <span className="font-medium text-foreground/80">
                                {row.item.userLabel || "System"}
                              </span>{" "}
                              zmienił(a) {row.more.length + 1} pola
                              <ul className="mt-0.5 space-y-0.5 text-xs">
                                {[row.item, ...row.more].map((e) => (
                                  <li key={e.id}>
                                    {e.summary ?? describeActivity(e).replace(/^[^—]*— /, "")}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              {describeActivity(row.item)}
                            </p>
                          )}
                          {evRef && (
                            <p className="text-xs text-muted-foreground">
                              {fmtRange(evRef.startAt, evRef.endAt, evRef.allDay)}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {who && (
                        <span
                          {...tip(`Autor zmiany: ${who}`)}
                          className="hidden h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold uppercase text-muted-foreground sm:inline-flex"
                        >
                          {initials(who)}
                        </span>
                      )}
                      <time
                        dateTime={when}
                        {...tip(fmtTimestamp(when))}
                        className="whitespace-nowrap text-xs text-muted-foreground"
                      >
                        {fmtRelative(when)}
                      </time>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {filteredHistory.length > histLimit && (
          <button
            type="button"
            onClick={() => setHistLimit((l) => l + 30)}
            className="w-full rounded-md border border-dashed py-1.5 text-xs text-muted-foreground hover:bg-muted"
          >
            Pokaż więcej ({filteredHistory.length - histLimit})
          </button>
        )}
      </ChartCard>

      {/* Dialog wydarzenia kalendarza (prewypełniony obiektem) */}
      <CalendarEventDialog
        key={calNonce}
        open={calDialogOpen}
        mode={calDialogMode}
        event={calDialogEvent}
        prefill={{ objectId: object.id }}
        onClose={() => {
          setCalDialogOpen(false);
          // Notatki w dialogu zapisują się natychmiast, bez „Zapisz” — po zamknięciu
          // kartoteka musi zobaczyć ewentualną świeżą kopię.
          setNotesNonce((n) => n + 1);
        }}
        onSaved={() => {
          loadCalendar(object.id);
          // Notatka wydarzenia mogła zostać skopiowana do kartoteki — przeładuj kartę.
          setNotesNonce((n) => n + 1);
        }}
        onDeleted={() => loadCalendar(object.id)}
        onEdit={
          calEditable && calDialogEvent && !calDialogEvent.deletedAt
            ? () => {
                setCalDialogMode("edit");
                setCalNonce((n) => n + 1);
              }
            : undefined
        }
      />

      {/* Edycja kartoteki — ten sam formularz, co na liście obiektów. Montujemy
          dopiero na otwarcie i z kluczem po `updatedAt`, bo formularz czyta
          `object` wyłącznie w inicjalizatorze stanu (wzorzec z Objects.tsx:963). */}
      {editOpen && (
        <ObjectForm
          key={object.updatedAt}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSubmit={handleEditSubmit}
          object={object}
        />
      )}

      {/* Dialog przejścia workflow */}
      <Dialog open={transitionOpen} onOpenChange={setTransitionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Zmiana statusu obiektu</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Nowy status</Label>
                <Select
                  value={transitionData.newStatus}
                  onValueChange={(value) =>
                    setTransitionData((prev) => ({
                      ...prev,
                      newStatus: value as WorkflowTransition["newStatus"],
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Nowy dział</Label>
                <Select
                  value={transitionData.newDepartment}
                  onValueChange={(value) =>
                    setTransitionData((prev) => ({
                      ...prev,
                      newDepartment: value as WorkflowTransition["newDepartment"],
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(departmentLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Opis zmiany (opcjonalnie)</Label>
              <Textarea
                value={transitionData.description}
                onChange={(e) =>
                  setTransitionData((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransitionOpen(false)}>
              Anuluj
            </Button>
            <Button onClick={handleTransition}>Zatwierdź zmianę</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Lista wydarzeń obiektu (nadchodzące / przeszłe) z linkiem do kalendarza. */
function ObjectEventList({
  title,
  count,
  events,
  nowTs,
  onOpen,
  emptyText,
  muted,
}: {
  title: string;
  count: number;
  events: CalendarEvent[];
  nowTs: number;
  onOpen: (ev: CalendarEvent) => void;
  emptyText: string;
  muted?: boolean;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-foreground">
          {count}
        </span>
      </h3>
      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {events.map((ev) => {
            const meta = EVENT_TYPE_META[ev.type];
            const ui = EVENT_TYPE_UI[ev.type];
            const Icon = meta?.icon ?? CalendarDays;
            const overdue =
              (ev.status === "planned" || ev.status === "confirmed") &&
              parseLocal(ev.endAt).getTime() < nowTs;
            return (
              <li
                key={ev.id}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 text-sm",
                  muted && "text-muted-foreground"
                )}
                {...tipAttrs(
                  eventTipData(ev, {
                    hint: "Kliknij tytuł, by otworzyć szczegóły · „w kalendarzu” przenosi do modułu",
                  })
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                    ui?.soft
                  )}
                  aria-label={`Typ: ${meta?.label ?? ev.type}`}
                  {...tip(`Typ: ${meta?.label ?? ev.type}`)}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <button
                      type="button"
                      onClick={() => onOpen(ev)}
                      className={cn(
                        "truncate text-left font-medium text-foreground hover:underline",
                        ev.status === "cancelled" && "line-through"
                      )}
                    >
                      {ev.title}
                    </button>
                    {ev.seriesId && (
                      <Repeat
                        className="h-3.5 w-3.5 text-teal-600 dark:text-teal-300"
                        aria-label="Wydarzenie cykliczne"
                      />
                    )}
                    <span className={statusBadgeClass(ev.status)}>
                      {EVENT_STATUS_META[ev.status]?.label ?? ev.status}
                    </span>
                    {overdue && (
                      <span
                        className={pillClass("amber")}
                        {...tip(overdueTip(ev))}
                      >
                        <ClockAlert className="h-3 w-3" /> po terminie
                      </span>
                    )}
                    <BillingBadge billing={ev.billing} compact />
                    <ProtocolBadge event={ev} compact link />
                    <QuoteBadge event={ev} compact link />
                    <RealizationBadge event={ev} compact link />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="whitespace-nowrap">
                      {fmtRange(ev.startAt, ev.endAt, ev.allDay)}
                    </span>
                    {ev.technicians.length > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="flex -space-x-1">
                          {ev.technicians.slice(0, 4).map((t) => (
                            <span
                              key={t.id}
                              {...tip(`Technik: ${t.firstName} ${t.lastName}`)}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-background bg-muted text-[9px] font-semibold uppercase text-muted-foreground"
                            >
                              {initials(`${t.firstName} ${t.lastName}`)}
                            </span>
                          ))}
                        </span>
                        <span className="hidden sm:inline">
                          {ev.technicians
                            .map((t) => `${t.firstName} ${t.lastName[0]}.`)
                            .join(", ")}
                        </span>
                      </span>
                    )}
                    {ev.location && (
                      <span className="hidden truncate sm:inline">· {ev.location}</span>
                    )}
                  </div>
                </div>
                <Link
                  to={`/technical/kalendarz?event=${ev.id}&date=${ev.startAt.slice(0, 10)}`}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-primary hover:underline"
                  {...tip(`Otwórz „${ev.title}” w module Kalendarz`)}
                >
                  <span className="hidden sm:inline">w kalendarzu</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
