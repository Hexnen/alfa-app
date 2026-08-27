import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import plLocale from "@fullcalendar/core/locales/pl";
import type {
  DateSelectArg,
  DatesSetArg,
  EventClickArg,
  EventContentArg,
  EventDropArg,
  EventInput,
  EventMountArg,
} from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Building2,
  CalendarDays,
  CalendarPlus,
  CalendarX2,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CopyPlus,
  ExternalLink,
  Eye,
  Filter,
  FilterX,
  HelpCircle,
  ListChecks,
  Loader2,
  MapPin,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Rss,
  Sparkles,
  StickyNote,
  Tags,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  activityApi,
  assistantApi,
  calendarApi,
  getTechnicians,
  type ActivityEntry,
  type AssistantStatus,
  type CalendarEvent,
  type CalendarNote,
  type CalendarEventInput,
  type CalendarEventStatus,
  type CalendarEventType,
  type CalendarSeriesScope,
  type Technician,
} from "@/lib/api";
import {
  ACTIVITY_ACTION_META,
  ACTIVITY_FILTER_OPTIONS,
  EVENT_STATUS_META,
  EVENT_STATUS_ORDER,
  EVENT_TYPE_META,
  EVENT_TYPE_ORDER,
  activityParts,
  fmtDayHeading,
  fmtRange,
  fmtRelative,
  fmtShort,
  fmtTimestamp,
  parseLocal,
  techShort,
  timestampDayKey,
  toDateStr,
  toDateTimeStr,
  initials,
} from "@/lib/calendar-labels";
import {
  CalendarDeletePrompt,
  CalendarEventDialog,
  type CalendarDialogMode,
  type CalendarEventPrefill,
} from "@/components/CalendarEventDialog";
import { CalendarBoard, isOverdue, type BoardGroupBy } from "@/components/CalendarBoard";
import { NotesBadge } from "@/components/CalendarEventNotes";
import { AssistantDrawer, type AssistantEventChangeKind, type AssistantPreview } from "@/components/assistant/AssistantDrawer";
import { cn } from "@/lib/utils";
import "./Calendar.css";

type FcViewName = "dayGridMonth" | "timeGridWeek" | "timeGridDay" | "listWeek";
/** "board" = Tablica (kanban wg statusu/typu) — poza FullCalendar. */
type ViewName = FcViewName | "board";

const VIEWS: { key: ViewName; label: string; shortLabel: string; keys: string[] }[] = [
  { key: "dayGridMonth", label: "Miesiąc", shortLabel: "Mies.", keys: ["m"] },
  { key: "timeGridWeek", label: "Tydzień", shortLabel: "Tydz.", keys: ["w"] },
  { key: "timeGridDay", label: "Dzień", shortLabel: "Dzień", keys: ["d"] },
  { key: "listWeek", label: "Lista", shortLabel: "Lista", keys: ["l", "a"] },
  { key: "board", label: "Tablica", shortLabel: "Tabl.", keys: ["b"] },
];

const VIEW_STORAGE_KEY = "alfa.calendar.view";
const BOARD_GROUP_STORAGE_KEY = "alfa.calendar.boardGroup";

const isViewName = (v: unknown): v is ViewName => VIEWS.some((x) => x.key === v);

/** Ostatnio wybrany widok (localStorage) — „lepki” między wizytami. */
function readStoredView(): ViewName | null {
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return isViewName(v) ? v : null;
  } catch {
    return null;
  }
}

function storeView(v: ViewName) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    /* prywatny tryb / brak storage — ignoruj */
  }
}

function readStoredBoardGroup(): BoardGroupBy {
  try {
    return window.localStorage.getItem(BOARD_GROUP_STORAGE_KEY) === "type" ? "type" : "status";
  } catch {
    return "status";
  }
}

const FILTERS_STORAGE_KEY = "alfa.calendar.filters";
interface StoredFilters {
  types: CalendarEventType[];
  technicianIds: number[];
  statuses: CalendarEventStatus[];
}
const isType = (v: unknown): v is CalendarEventType =>
  typeof v === "string" && v in EVENT_TYPE_META;
const isStatus = (v: unknown): v is CalendarEventStatus =>
  typeof v === "string" && v in EVENT_STATUS_META;

/** Filtry z localStorage (walidowane — nieznane wartości pomijamy). */
function readStoredFilters(): StoredFilters {
  const empty: StoredFilters = { types: [], technicianIds: [], statuses: [] };
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return empty;
    const j = JSON.parse(raw) as Partial<Record<keyof StoredFilters, unknown[]>>;
    return {
      types: Array.isArray(j.types) ? j.types.filter(isType) : [],
      technicianIds: Array.isArray(j.technicianIds)
        ? j.technicianIds.filter((x): x is number => Number.isInteger(x) && (x as number) > 0)
        : [],
      statuses: Array.isArray(j.statuses) ? j.statuses.filter(isStatus) : [],
    };
  } catch {
    return empty;
  }
}

function storeFilters(f: StoredFilters) {
  try {
    if (!f.types.length && !f.technicianIds.length && !f.statuses.length) {
      window.localStorage.removeItem(FILTERS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(f));
    }
  } catch {
    /* ignoruj */
  }
}

/** Pierwszy dzień miesiąca (lokalnie). */
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

/** Tytuł miesiąca dla Tablicy, np. „sierpień 2026” (jak FullCalendar pl). */
const monthTitle = (d: Date) =>
  new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" }).format(d);


const errMsg = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

const isMobile = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 767px)").matches;

const typeColor = (t: CalendarEventType) =>
  `hsl(var(${EVENT_TYPE_META[t]?.cssVar ?? "--cal-biuro"}))`;

/** Mapowanie CalendarEvent → EventInput FullCalendar. */
function toFcEvent(ev: CalendarEvent, now: Date): EventInput {
  return {
    id: String(ev.id),
    title: ev.title,
    start: ev.startAt,
    end: ev.endAt,
    allDay: ev.allDay,
    classNames: [
      `cal-type-${ev.type}`,
      `cal-status-${ev.status}`,
      ev.deletedAt ? "cal-deleted" : "",
      isOverdue(ev, now) ? "cal-overdue" : "",
    ].filter(Boolean),
    // Usunięte nie do przesuwania; dla pozostałych NIE nadpisujemy — o DnD
    // decyduje globalne `editable` (uprawnienie edit), per-event true by je obeszło.
    // Klucz musi być NIEOBECNY: FullCalendar przepuszcza `editable: undefined` przez Boolean() → false.
    ...(ev.deletedAt ? { editable: false } : {}),
    extendedProps: { ev },
  };
}

/** CalendarEvent → pełny payload PUT (do punktowych zmian, np. statusu z menu). */
function toEventInput(ev: CalendarEvent): CalendarEventInput {
  return {
    type: ev.type,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    startAt: ev.startAt,
    endAt: ev.endAt,
    allDay: ev.allDay,
    status: ev.status,
    objectId: ev.objectId,
    orderId: ev.orderId,
    realizationId: ev.realizationId,
    technicianIds: ev.technicians.map((t) => t.id),
  };
}

/** Stan menu kontekstowego: na wydarzeniu albo na pustym dniu/slocie. */
type CtxMenuState =
  | { kind: "event"; x: number; y: number; ev: CalendarEvent }
  | { kind: "slot"; x: number; y: number; startAt: string; endAt: string; allDay: boolean };

/** Podgląd wydarzenia (jeden klik) — zakotwiczony przy elemencie. */
interface PreviewState {
  ev: CalendarEvent;
  rect: { left: number; top: number; width: number; height: number };
}

// ---------------------------------------------------------------------------
// Toasty (błędy + „Usunięto · Przywróć”)
// ---------------------------------------------------------------------------

export interface CalendarToast {
  id: number;
  kind: "error" | "info";
  message: ReactNode;
  action?: { label: string; icon?: typeof Undo2; onClick: () => void };
  /** ms; domyślnie 6 s dla błędów, 12 s dla info. */
  duration?: number;
}
export type CalendarNotify = (t: Omit<CalendarToast, "id">) => void;

/** Treść wydarzenia w siatce: ikona typu + czas + tytuł (+ ✓ dla wykonanych). */
function renderEventContent(arg: EventContentArg) {
  const ev = arg.event.extendedProps.ev as CalendarEvent | undefined;
  const type = ev?.type ?? "biuro";
  const meta = EVENT_TYPE_META[type as CalendarEventType];
  const Icon = meta?.icon ?? Building2;
  const done = ev?.status === "done";
  const overdue = arg.event.classNames.includes("cal-overdue");
  // W wierszu „cały dzień” siatki godzinowej — układ kompaktowy jak w miesiącu.
  const isTimeGrid = arg.view.type.startsWith("timeGrid") && !arg.event.allDay;
  const isList = arg.view.type.startsWith("list");
  const sub = [ev?.objectName, ev?.technicians?.map(techShort).join(", ")]
    .filter(Boolean)
    .join(" · ");

  if (isList) {
    const status = ev ? EVENT_STATUS_META[ev.status] : null;
    return (
      <div className="cal-list-item">
        <Icon className="cal-ev-icon" aria-label={meta?.label} />
        <span className="cal-ev-title">{arg.event.title}</span>
        {ev?.seriesId && <Repeat className="cal-ev-series" aria-label="Seria" />}
        {sub && <span className="cal-list-sub">{sub}</span>}
        {status && (
          <span className={cn("cal-list-status rounded-full px-2 py-0.5 text-[10px] font-semibold", status.badge)}>
            {status.label}
          </span>
        )}
      </div>
    );
  }
  if (isTimeGrid) {
    return (
      <div className="cal-ev">
        <div className="cal-ev-head">
          <Icon className="cal-ev-icon" aria-label={meta?.label} />
          {arg.timeText && <span className="cal-ev-time">{arg.timeText}</span>}
          {overdue && <AlertTriangle className="cal-ev-overdue" aria-label="Po terminie" />}
          {done && <Check className="cal-ev-check" aria-label="Wykonane" />}
          <span className="cal-ev-title">{arg.event.title}</span>
        </div>
        {sub && <div className="cal-ev-sub">{sub}</div>}
      </div>
    );
  }
  return (
    <div className="cal-ev">
      <Icon className="cal-ev-icon" aria-label={meta?.label} />
      {arg.timeText && <span className="cal-ev-time">{arg.timeText}</span>}
      <span className="cal-ev-title">{arg.event.title}</span>
      {overdue && <AlertTriangle className="cal-ev-overdue" aria-label="Po terminie" />}
      {done && <Check className="cal-ev-check" aria-label="Wykonane" />}
    </div>
  );
}

/** Czy fokus jest w polu edycyjnym (nie przechwytujemy skrótów). */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function Calendar() {
  const { canEdit, isAdmin } = usePerms();
  const editable = canEdit("technical/kalendarz");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const calendarRef = useRef<FullCalendar>(null);
  const mobile = useMemo(isMobile, []);
  const [view, setView] = useState<ViewName>(
    () => readStoredView() ?? (mobile ? "listWeek" : "dayGridMonth")
  );
  const isBoard = view === "board";
  const isBoardRef = useRef(isBoard);
  isBoardRef.current = isBoard;
  /** Data „kotwicy” — utrzymuje ciągłość nawigacji między siatką a Tablicą. */
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date());
  /** Grupowanie kolumn Tablicy. */
  const [boardGroup, setBoardGroupState] = useState<BoardGroupBy>(readStoredBoardGroup);
  const setBoardGroup = (g: BoardGroupBy) => {
    setBoardGroupState(g);
    try {
      window.localStorage.setItem(BOARD_GROUP_STORAGE_KEY, g);
    } catch {
      /* ignoruj */
    }
  };
  const [title, setTitle] = useState("");
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  // Tablica: zakres = bieżący miesiąc kotwicy (FullCalendar jest wtedy odmontowany).
  useEffect(() => {
    if (!isBoard) return;
    const from = startOfMonth(anchorDate);
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    setTitle(monthTitle(from));
    const f = toDateStr(from);
    const t = toDateStr(to);
    setRange((r) => (r && r.from === f && r.to === t ? r : { from: f, to: t }));
  }, [isBoard, anchorDate]);

  // --- Toasty + aria-live ---
  const [toasts, setToasts] = useState<CalendarToast[]>([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const notify = useCallback<CalendarNotify>((t) => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    const ms = t.duration ?? (t.kind === "error" ? 7000 : 12000);
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ms);
  }, []);
  const notifyError = useCallback(
    (err: unknown, fallback: string, retry?: () => void) =>
      notify({
        kind: "error",
        message: errMsg(err, fallback),
        action: retry ? { label: "Ponów", icon: RefreshCw, onClick: retry } : undefined,
      }),
    [notify]
  );
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((msg: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(msg), 30);
  }, []);

  // --- Filtry (zapamiętywane w localStorage) ---
  const stored = useMemo(readStoredFilters, []);
  const [typeFilter, setTypeFilter] = useState<Set<CalendarEventType>>(() => new Set(stored.types));
  const [technicianFilter, setTechnicianFilter] = useState<Set<number>>(() => new Set(stored.technicianIds));
  const [statusFilter, setStatusFilter] = useState<Set<CalendarEventStatus>>(() => new Set(stored.statuses));
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false); // arkusz na mobile
  const activeFilterCount =
    (typeFilter.size > 0 ? 1 : 0) + (technicianFilter.size > 0 ? 1 : 0) + (statusFilter.size > 0 ? 1 : 0);
  const clearFilters = () => {
    setTypeFilter(new Set());
    setTechnicianFilter(new Set());
    setStatusFilter(new Set());
  };
  useEffect(() => {
    storeFilters({
      types: Array.from(typeFilter),
      technicianIds: Array.from(technicianFilter),
      statuses: Array.from(statusFilter),
    });
  }, [typeFilter, technicianFilter, statusFilter]);

  useEffect(() => {
    getTechnicians(true)
      .then((res) => setTechnicians(res.data || []))
      .catch(() => {});
  }, []);

  /** Technicy na urlopie w bieżącym zakresie (badge w filtrze). */
  const [onLeave, setOnLeave] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    calendarApi
      .availability(range.from, range.to)
      .then((res) => {
        if (cancelled) return;
        setOnLeave(new Set((res.data || []).filter((t) => t.leaves.length > 0).map((t) => t.technicianId)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [range]);

  // --- Wydarzenia ---
  // Z API pobieramy z filtrem typu i techników; status filtrujemy po stronie
  // klienta — dzięki temu liczniki przy chipach statusów są zawsze pełne.
  const [allEvents, setAllEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    if (!range) return;
    setLoading(true);
    try {
      const res = await calendarApi.getEvents({
        from: range.from,
        to: range.to,
        type: typeFilter.size ? Array.from(typeFilter) : undefined,
        technicianId: technicianFilter.size ? Array.from(technicianFilter) : undefined,
      });
      setAllEvents(res.data || []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err, "Błąd wczytywania kalendarza"));
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [range, typeFilter, technicianFilter]);

  const events = useMemo(
    () => (statusFilter.size ? allEvents.filter((e) => statusFilter.has(e.status)) : allEvents),
    [allEvents, statusFilter]
  );
  const statusCounts = useMemo(() => {
    const m: Record<CalendarEventStatus, number> = { planned: 0, confirmed: 0, done: 0, cancelled: 0 };
    for (const e of allEvents) if (!e.deletedAt) m[e.status] = (m[e.status] ?? 0) + 1;
    return m;
  }, [allEvents]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Błąd ładowania → toast z „Ponów” (raz per błąd).
  const lastErrRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loadError || lastErrRef.current === loadError) return;
    lastErrRef.current = loadError;
    notify({
      kind: "error",
      message: loadError,
      action: { label: "Ponów", icon: RefreshCw, onClick: () => void loadEvents() },
    });
  }, [loadError, notify, loadEvents]);
  useEffect(() => {
    if (!loadError) lastErrRef.current = null;
  }, [loadError]);

  const now = useMemo(() => new Date(), [events]); // eslint-disable-line react-hooks/exhaustive-deps
  // Widmo propozycji asystenta (karta / hover slotu): event tła + klasy konfliktów na siatce.
  const [assistantPreview, setAssistantPreview] = useState<AssistantPreview>(null);
  const fcEvents = useMemo(() => {
    const base = events.map((e) => toFcEvent(e, now));
    const g = assistantPreview;
    if (!g) return base;
    const conflict = new Set(g.conflictIds ?? []);
    if (conflict.size) {
      for (const ev of base) {
        if (conflict.has(Number(ev.id))) ev.classNames = [...(ev.classNames as string[]), "fc-event-conflict"];
      }
    }
    // Karta zmian: oryginał modyfikowanego wydarzenia wyciszony, poprzedni termin jako szare widmo.
    if (g.eventId != null) {
      for (const ev of base) {
        if (Number(ev.id) === g.eventId) ev.classNames = [...(ev.classNames as string[]), "fc-event-changing"];
      }
    }
    // Siatka godzinowa: event tła rozciągnięty na slot; miesiąc/lista: zwykły (nieedytowalny)
    // wpis z ramką przerywaną — FullCalendar nie rysuje timed background-eventów w dayGrid.
    const timeGrid = view.startsWith("timeGrid");
    if (g.before) {
      base.push({
        id: "assistant-ghost-before",
        title: `Było: ${g.title ?? ""}`.trim(),
        start: g.before.startAt,
        end: g.before.endAt,
        allDay: Boolean(g.before.allDay),
        display: timeGrid ? "background" : "block",
        classNames: ["fc-event-ghost-before"],
        editable: false,
        startEditable: false,
        durationEditable: false,
        overlap: true,
        extendedProps: { ghost: true },
      });
    }
    base.push({
      id: "assistant-ghost",
      title: g.type === "slot" ? "Wolny termin" : `${g.before ? "Nowy termin" : "Propozycja"}: ${g.title ?? ""}`.trim(),
      start: g.startAt,
      end: g.endAt,
      allDay: Boolean(g.allDay),
      display: timeGrid ? "background" : "block",
      classNames: ["fc-event-ghost", g.type && g.type !== "slot" ? `cal-type-${g.type}` : ""].filter(Boolean),
      editable: false,
      startEditable: false,
      durationEditable: false,
      overlap: true,
      extendedProps: { ghost: true },
    });
    return base;
  }, [events, now, assistantPreview, view]);
  const visibleCount = useMemo(() => events.filter((e) => !e.deletedAt).length, [events]);

  // --- Dialog wydarzenia ---
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<CalendarDialogMode>("create");
  const [dialogEvent, setDialogEvent] = useState<CalendarEvent | null>(null);
  const [dialogPrefill, setDialogPrefill] = useState<CalendarEventPrefill | null>(null);
  const [dialogNonce, setDialogNonce] = useState(0);

  const openCreate = useCallback(
    (prefill?: CalendarEventPrefill) => {
      if (!editable) return;
      setDialogMode("create");
      setDialogEvent(null);
      setDialogPrefill(prefill ?? null);
      setDialogNonce((n) => n + 1);
      setDialogOpen(true);
    },
    [editable]
  );

  const openEvent = useCallback(
    (ev: CalendarEvent) => {
      setDialogMode(editable && !ev.deletedAt ? "edit" : "view");
      setDialogEvent(ev);
      setDialogPrefill(null);
      setDialogNonce((n) => n + 1);
      setDialogOpen(true);
    },
    [editable]
  );

  /** Przejście do daty: w siatce przez API FullCalendar, w Tablicy przez kotwicę miesiąca. */
  const gotoDateRef = useRef<(date: string) => void>(() => {});
  gotoDateRef.current = (date) => {
    if (isBoard) setAnchorDate(startOfMonth(new Date(`${date}T00:00`)));
    else calendarRef.current?.getApi().gotoDate(date);
  };

  /** Otwiera wydarzenie po ID (świeże dane z API) i przewija kalendarz do jego daty. */
  const openEventById = useCallback(
    async (id: number, gotoDate = true) => {
      try {
        const res = await calendarApi.getEvent(id);
        if (!res.data) return;
        if (gotoDate) gotoDateRef.current(res.data.startAt.slice(0, 10));
        openEvent(res.data);
      } catch (err) {
        notifyError(err, "Nie znaleziono wydarzenia");
      }
    },
    [openEvent, notifyError]
  );

  // --- Query params: ?event=ID&date=YYYY-MM-DD (linki z karty obiektu) ---
  const paramsHandled = useRef(false);
  useEffect(() => {
    if (paramsHandled.current) return;
    const ev = searchParams.get("event");
    const date = searchParams.get("date");
    if (!ev && !date) return;
    // Poczekaj aż FullCalendar się zamontuje. Flagę ustawiamy dopiero w
    // callbacku — w StrictMode (dev) efekt odpala się dwukrotnie i cleanup
    // kasuje pierwszy timeout; wcześniejsze ustawienie flagi gubiło otwarcie.
    const t = window.setTimeout(() => {
      paramsHandled.current = true;
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        gotoDateRef.current(date);
      }
      if (ev && /^\d+$/.test(ev)) void openEventById(Number(ev), !date);
      setSearchParams({}, { replace: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [searchParams, setSearchParams, openEventById]);

  // --- Podgląd (jeden klik) ---
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  useEffect(() => {
    // Po przeładowaniu danych odśwież obiekt w podglądzie (np. po zmianie statusu).
    if (!preview) return;
    const fresh = events.find((e) => e.id === preview.ev.id);
    if (!fresh) setPreview(null);
    else if (fresh !== preview.ev) setPreview({ ...preview, ev: fresh });
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Menu kontekstowe (prawy przycisk) ---
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const [deleteTarget, setDeleteTarget] = useState<CalendarEvent | null>(null);

  /** Prawy klik / dwuklik na wydarzeniu — listenery natywne podpinane w eventDidMount. */
  const eventCtxRef = useRef<(ev: CalendarEvent, e: MouseEvent) => void>(() => {});
  eventCtxRef.current = (ev, e) => {
    e.preventDefault();
    e.stopPropagation();
    setPreview(null);
    setCtxMenu({ kind: "event", x: e.clientX, y: e.clientY, ev });
  };
  const eventDblRef = useRef<(ev: CalendarEvent) => void>(() => {});
  eventDblRef.current = (ev) => {
    setPreview(null);
    openEvent(ev);
  };
  type ElWithHandlers = HTMLElement & {
    _alfaCtx?: (e: MouseEvent) => void;
    _alfaDbl?: (e: MouseEvent) => void;
  };
  const handleEventDidMount = useCallback((arg: EventMountArg) => {
    const el = arg.el as ElWithHandlers;
    const ev = arg.event.extendedProps.ev as CalendarEvent | undefined;
    const ctx = (e: MouseEvent) => {
      if (ev) eventCtxRef.current(ev, e);
    };
    const dbl = (e: MouseEvent) => {
      e.preventDefault();
      if (ev) eventDblRef.current(ev);
    };
    el._alfaCtx = ctx;
    el._alfaDbl = dbl;
    el.addEventListener("contextmenu", ctx);
    el.addEventListener("dblclick", dbl);
    // Tooltip natywny — pełny tytuł, zakres, obiekt (obcięty tekst w komórce).
    if (ev) {
      const bits = [
        ev.title,
        fmtRange(ev.startAt, ev.endAt, ev.allDay),
        ev.objectName ?? "",
        ev.technicians?.length ? ev.technicians.map(techShort).join(", ") : "",
        `${EVENT_TYPE_META[ev.type]?.label ?? ev.type} · ${EVENT_STATUS_META[ev.status]?.label ?? ev.status}`,
      ].filter(Boolean);
      el.title = bits.join("\n");
      el.setAttribute("aria-label", bits.join(", "));
    }
  }, []);
  const handleEventWillUnmount = useCallback((arg: EventMountArg) => {
    const el = arg.el as ElWithHandlers;
    if (el._alfaCtx) el.removeEventListener("contextmenu", el._alfaCtx);
    if (el._alfaDbl) el.removeEventListener("dblclick", el._alfaDbl);
  }, []);

  /**
   * Prawy klik na pustym dniu / slocie: dzień z `[data-date]` (dayGrid, kolumna
   * timeGrid, wiersz all-day), godzina z lane `.fc-timegrid-slot[data-time]`
   * pod kursorem (elementsFromPoint).
   */
  const handleGridContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".fc-event")) return; // obsługuje listener z eventDidMount
    if (!editable) return;
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    const dayEl = stack.find((n) => (n as HTMLElement).dataset?.date) as HTMLElement | undefined;
    const date = dayEl?.dataset.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const slotEl = stack.find(
      (n) => n.classList.contains("fc-timegrid-slot") && (n as HTMLElement).dataset.time
    ) as HTMLElement | undefined;
    const time = slotEl?.dataset.time; // "HH:MM:SS"
    e.preventDefault();
    setPreview(null);
    if (time && !dayEl?.closest(".fc-daygrid-body")) {
      const start = new Date(`${date}T${time.slice(0, 5)}`);
      const end = new Date(start);
      end.setHours(end.getHours() + 1);
      setCtxMenu({
        kind: "slot",
        x: e.clientX,
        y: e.clientY,
        allDay: false,
        startAt: toDateTimeStr(start),
        endAt: toDateTimeStr(end),
      });
      return;
    }
    const next = new Date(`${date}T00:00`);
    next.setDate(next.getDate() + 1);
    setCtxMenu({
      kind: "slot",
      x: e.clientX,
      y: e.clientY,
      allDay: true,
      startAt: date,
      endAt: toDateStr(next),
    });
  };

  /** Zmiana statusu z menu (PUT z pełnym payloadem, scope=this dla serii). */
  const setStatus = async (ev: CalendarEvent, status: CalendarEventStatus) => {
    try {
      await calendarApi.update(ev.id, { ...toEventInput(ev), status }, ev.seriesId ? "this" : undefined);
      announce(`Status „${ev.title}”: ${EVENT_STATUS_META[status].label}`);
      await loadEvents();
    } catch (err) {
      notifyError(err, "Nie udało się zmienić statusu", () => void setStatus(ev, status));
    }
  };

  /** Tablica: drop karty do kolumny → zmiana statusu (grupowanie wg statusu) lub typu. */
  const handleBoardMove = async (ev: CalendarEvent, target: CalendarEventStatus | CalendarEventType) => {
    if (!editable || ev.deletedAt) return;
    if (boardGroup === "status") {
      await setStatus(ev, target as CalendarEventStatus);
      return;
    }
    try {
      await calendarApi.update(
        ev.id,
        { ...toEventInput(ev), type: target as CalendarEventType },
        ev.seriesId ? "this" : undefined
      );
      announce(`Typ „${ev.title}”: ${EVENT_TYPE_META[target as CalendarEventType].label}`);
      await loadEvents();
    } catch (err) {
      notifyError(err, "Nie udało się zmienić typu");
    }
  };

  /** Prawy klik na karcie Tablicy — to samo menu co na siatce. */
  const handleBoardContextMenu = (ev: CalendarEvent, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: "event", x: e.clientX, y: e.clientY, ev });
  };

  /** Duplikat: dialog „Nowe wydarzenie” z danymi źródła (bez id, serii i statusu). */
  const duplicateEvent = (ev: CalendarEvent) =>
    openCreate({
      type: ev.type,
      title: ev.title,
      allDay: ev.allDay,
      startAt: ev.startAt,
      endAt: ev.endAt,
      objectId: ev.objectId,
      location: ev.location,
      description: ev.description,
      technicianIds: ev.technicians.map((t) => t.id),
    });

  const ctxItems = useMemo<ContextMenuItem[]>(() => {
    if (!ctxMenu) return [];
    if (ctxMenu.kind === "slot") {
      return [
        {
          key: "new",
          label: "Nowe wydarzenie",
          icon: CalendarPlus,
          onSelect: () =>
            openCreate({ allDay: ctxMenu.allDay, startAt: ctxMenu.startAt, endAt: ctxMenu.endAt }),
        },
      ];
    }
    const ev = ctxMenu.ev;
    const canMutate = editable && !ev.deletedAt;
    const items: ContextMenuItem[] = [
      {
        key: "open",
        label: canMutate ? "Edytuj" : "Otwórz",
        icon: canMutate ? Pencil : Eye,
        hint: "dwuklik",
        onSelect: () => openEvent(ev),
      },
    ];
    if (ev.objectId) {
      items.push({
        key: "object",
        label: "Idź do obiektu",
        hint: ev.objectName ?? `#${ev.objectId}`,
        icon: ExternalLink,
        onSelect: () => navigate(`/objects/${ev.objectId}`),
      });
    }
    if (canMutate) {
      items.push({ key: "sep1", label: null, separator: true });
      if (ev.status === "planned") {
        items.push({
          key: "confirm",
          label: "Potwierdź",
          icon: Check,
          onSelect: () => void setStatus(ev, "confirmed"),
        });
      }
      // Urlop nie bywa „wykonany” — tylko Potwierdź
      if (ev.status !== "done" && ev.type !== "urlop") {
        items.push({
          key: "done",
          label: "Oznacz jako wykonane",
          icon: CheckCheck,
          onSelect: () => void setStatus(ev, "done"),
        });
      }
      items.push({
        key: "dup",
        label: "Duplikuj",
        icon: CopyPlus,
        onSelect: () => duplicateEvent(ev),
      });
      items.push({ key: "sep2", label: null, separator: true });
      items.push({
        key: "del",
        label: "Usuń",
        icon: Trash2,
        destructive: true,
        onSelect: () => setDeleteTarget(ev),
      });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, editable, openCreate, openEvent, navigate]);

  // --- Toast "Usunięto · Przywróć" ---
  const handleDeleted = (ev: CalendarEvent, scope: CalendarSeriesScope) => {
    setPreview(null);
    announce(`Usunięto „${ev.title}”`);
    notify({
      kind: "info",
      message: (
        <>
          Usunięto „{ev.title}”
          {scope !== "this" && " (wraz z innymi wystąpieniami serii)"}
        </>
      ),
      action:
        scope === "this"
          ? {
              label: "Przywróć",
              icon: Undo2,
              onClick: async () => {
                try {
                  await calendarApi.restore(ev.id);
                  announce(`Przywrócono „${ev.title}”`);
                  await loadEvents();
                } catch (err) {
                  notifyError(err, "Błąd przywracania wydarzenia");
                }
              },
            }
          : undefined,
    });
    void loadEvents();
  };

  // --- FullCalendar handlers ---
  const handleDatesSet = (arg: DatesSetArg) => {
    setTitle(arg.view.title);
    setView(arg.view.type as ViewName);
    // Kotwica = „bieżąca data” FullCalendar (nie początek okresu) — dzięki temu
    // Tablica → Tydzień/Lista wraca do tygodnia z tą datą, a nie do 1. tygodnia miesiąca.
    // Przy pierwszym datesSet ref bywa jeszcze pusty — wtedy zostawiamy kotwicę,
    // o ile mieści się w okresie (inaczej Tablica → Lista lądowała w 1. tygodniu miesiąca).
    const cur = calendarRef.current?.getApi().getDate();
    setAnchorDate((d) => {
      if (cur) return d.getTime() === cur.getTime() ? d : cur;
      if (d >= arg.start && d < arg.end) return d;
      return arg.view.currentStart;
    });
    const from = toDateStr(arg.start);
    const to = toDateStr(arg.end);
    setRange((r) => (r && r.from === from && r.to === to ? r : { from, to }));
    setPreview(null);
  };

  const handleSelect = (arg: DateSelectArg) => {
    if (!editable) return;
    const allDay = arg.allDay;
    openCreate({
      allDay,
      startAt: allDay ? toDateStr(arg.start) : toDateTimeStr(arg.start),
      endAt: allDay ? toDateStr(arg.end) : toDateTimeStr(arg.end),
    });
    calendarRef.current?.getApi().unselect();
  };

  const handleEventClick = (arg: EventClickArg) => {
    arg.jsEvent.preventDefault();
    const ev = arg.event.extendedProps.ev as CalendarEvent | undefined;
    if (!ev) return;
    // Na mobile od razu dialog (arkusz); na desktopie lekki podgląd przy evencie.
    if (mobile) {
      openEvent(ev);
      return;
    }
    const r = arg.el.getBoundingClientRect();
    setCtxMenu(null);
    setPreview((p) =>
      p && p.ev.id === ev.id
        ? null
        : { ev, rect: { left: r.left, top: r.top, width: r.width, height: r.height } }
    );
  };

  /** Drag&drop / resize → PATCH move. Przy błędzie cofamy zmianę w siatce. */
  const handleMove = async (arg: EventDropArg | EventResizeDoneArg) => {
    const ev = arg.event.extendedProps.ev as CalendarEvent | undefined;
    if (!ev || !editable) {
      arg.revert();
      return;
    }
    const allDay = arg.event.allDay;
    const start = arg.event.start;
    if (!start) {
      arg.revert();
      return;
    }
    let end = arg.event.end;
    if (!end) {
      end = new Date(start);
      if (allDay) end.setDate(end.getDate() + 1);
      else end.setHours(end.getHours() + 1);
    }
    setPreview(null);
    try {
      await calendarApi.move(ev.id, {
        startAt: allDay ? toDateStr(start) : toDateTimeStr(start),
        endAt: allDay ? toDateStr(end) : toDateTimeStr(end),
        allDay,
      });
      announce(`Przeniesiono „${ev.title}” na ${fmtShort(allDay ? toDateStr(start) : toDateTimeStr(start), allDay)}`);
      await loadEvents();
    } catch (err) {
      arg.revert();
      notifyError(err, "Nie udało się przesunąć wydarzenia");
    }
  };

  const api = () => calendarRef.current?.getApi();
  const changeView = useCallback(
    (v: ViewName) => {
      storeView(v);
      setPreview(null);
      if (v === "board") {
        // Kotwicy nie zaokrąglamy — Tablica sama liczy miesiąc z anchorDate,
        // a powrót do siatki wraca wtedy do tego samego tygodnia/dnia.
        setView(v);
        return;
      }
      // Z Tablicy wracamy przez remount FullCalendar z initialView/initialDate;
      // z siatki — zwykła zmiana widoku.
      if (view !== "board") calendarRef.current?.getApi().changeView(v);
      setView(v);
    },
    [view]
  );

  /** Nawigacja ‹ Dziś ›: FullCalendar albo miesiąc Tablicy. */
  const navPrev = useCallback(() => {
    setPreview(null);
    if (isBoard) setAnchorDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
    else api()?.prev();
  }, [isBoard]);
  const navNext = useCallback(() => {
    setPreview(null);
    if (isBoard) setAnchorDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
    else api()?.next();
  }, [isBoard]);
  const navToday = useCallback(() => {
    setPreview(null);
    if (isBoard) setAnchorDate(startOfMonth(new Date()));
    else api()?.today();
  }, [isBoard]);

  // Ogłaszaj zmianę okresu czytnikom ekranu.
  useEffect(() => {
    if (title) announce(title);
  }, [title, announce]);

  // --- Panel Aktywność ---
  const [activityOpen, setActivityOpen] = useState(false);

  // --- Panel Asystent — dostęp wg `status.allowed` (admin lub edytor kalendarza,
  // zależnie od ustawienia „access” w administracji); do czasu odpowiedzi
  // backendu fallback = isAdmin. Wyklucza się z Aktywnością (jedna kolumna boczna).
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatus | null>(null);
  useEffect(() => {
    let alive = true;
    assistantApi
      .status()
      .then((st) => {
        if (alive) setAssistantStatus(st);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const assistantAllowed = assistantStatus?.allowed ?? isAdmin;
  /** Callback z karty propozycji „Edytuj” — wołany po zapisie z dialogu (zamiast Zatwierdź). */
  const assistantSavedRef = useRef<((ev: CalendarEvent) => void) | null>(null);
  const closeAssistant = useCallback(() => setAssistantOpen(false), []);
  /** Zapis/zmiana z asystenta (propozycja, karta zmian, dialog) → toast + odświeżenie siatki. */
  const onAssistantEventsChanged = useCallback(
    (ev: CalendarEvent | null, kind: AssistantEventChangeKind, title?: string) => {
      const VERB: Record<AssistantEventChangeKind, string> = {
        created: "Zapisano",
        create: "Dodano",
        update: "Zmieniono",
        status: "Zmieniono status",
        cancel: "Anulowano",
        delete: "Usunięto",
        restore: "Przywrócono",
        note: "Dodano notatkę",
      };
      const name = ev?.title ?? title ?? "wydarzenie";
      if (!ev && kind === "update" && title && !ev) {
        // Sygnał błędu z drawera (np. nie udało się wczytać wydarzenia do edycji).
        notify({ kind: "error", message: title });
        return;
      }
      announce(`${VERB[kind] ?? "Zmieniono"} „${name}”`);
      notify({
        kind: "info",
        message: (
          <span>
            {VERB[kind] ?? "Zmieniono"} <strong>{name}</strong>
            {ev && kind !== "delete" ? <> — {fmtRange(ev.startAt, ev.endAt, ev.allDay)}</> : null}
            {kind !== "created" && <span className="text-muted-foreground"> (przez asystenta)</span>}
          </span>
        ),
        action: ev && kind !== "delete" ? { label: "Otwórz", icon: ExternalLink, onClick: () => void openEventById(ev.id) } : undefined,
        duration: 8000,
      });
      void loadEvents();
    },
    [announce, notify, openEventById, loadEvents]
  );
  /** Widmo na siatce; `focus` („Pokaż w kalendarzu”) albo termin poza widokiem → gotoDate. */
  const onAssistantPreview = useCallback((r: AssistantPreview) => {
    setAssistantPreview(r);
    if (!r) return;
    const day = r.startAt.slice(0, 10);
    const api = calendarRef.current?.getApi();
    let outside = true;
    if (api && !isBoardRef.current) {
      const v = api.view;
      const d = new Date(`${day}T00:00`);
      outside = d < v.activeStart || d >= v.activeEnd;
    }
    // Poza cyklem efektów (karta zgłasza z useEffect; gotoDate FullCalendara robi flushSync).
    if (r.focus || outside) setTimeout(() => gotoDateRef.current(day), 0);
  }, []);
  const onAssistantEditProposal = useCallback(
    (prefill: CalendarEventPrefill, onSaved: (ev: CalendarEvent) => void) => {
      assistantSavedRef.current = onSaved;
      openCreate(prefill);
    },
    [openCreate]
  );
  /** Karta zmian „Edytuj” → dialog edycji istniejącego wydarzenia (scalonego z patchem asystenta). */
  const onAssistantEditEvent = useCallback(
    (ev: CalendarEvent, onSaved: (saved: CalendarEvent) => void) => {
      assistantSavedRef.current = onSaved;
      openEvent(ev);
    },
    [openEvent]
  );
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await activityApi.recent(50);
      setActivity(res.data || []);
    } catch (err) {
      notifyError(err, "Błąd wczytywania aktywności", () => void loadActivity());
    } finally {
      setActivityLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    if (activityOpen) loadActivity();
  }, [activityOpen, loadActivity, events]);

  // --- Pomoc / ICS ---
  const [helpOpen, setHelpOpen] = useState(false);
  const [icsOpen, setIcsOpen] = useState(false);

  // --- Skróty klawiaturowe ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // Dialogi Radix blokują tło — nie reaguj, gdy otwarty jest dialog/prompt.
      if (dialogOpen || deleteTarget || icsOpen || document.querySelector('[role="dialog"]')) {
        return;
      }
      const k = e.key;
      if (k === "Escape") {
        if (helpOpen || preview || ctxMenu || filtersOpen) {
          setHelpOpen(false);
          setPreview(null);
          setCtxMenu(null);
          setFiltersOpen(false);
          e.preventDefault();
        }
        return;
      }
      if (ctxMenu) return; // menu ma własną nawigację
      const lower = k.toLowerCase();
      if (k === "?" || (e.shiftKey && lower === "/")) {
        setHelpOpen((o) => !o);
        e.preventDefault();
        return;
      }
      if (e.shiftKey) return;
      if (lower === "t") return void (e.preventDefault(), navToday());
      if (k === "ArrowLeft" || lower === "j" || lower === "p") return void (e.preventDefault(), navPrev());
      if (k === "ArrowRight" || lower === "k" || lower === "n") {
        if (lower === "n") {
          if (editable) openCreate();
          e.preventDefault();
          return;
        }
        e.preventDefault();
        navNext();
        return;
      }
      if (lower === "c") {
        if (editable) openCreate();
        e.preventDefault();
        return;
      }
      const v = VIEWS.find((x) => x.keys.includes(lower));
      if (v) {
        e.preventDefault();
        changeView(v.key);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    dialogOpen,
    deleteTarget,
    icsOpen,
    helpOpen,
    preview,
    ctxMenu,
    filtersOpen,
    editable,
    navToday,
    navPrev,
    navNext,
    openCreate,
    changeView,
  ]);

  // --- Swipe (mobile) — lewo/prawo zmienia okres ---
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s || !mobile) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Date.now() - s.t > 600) return;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if ((e.target as HTMLElement).closest(".fc-event, [data-board-card]")) return;
    if (dx < 0) navNext();
    else navPrev();
  };

  const toggleType = (t: CalendarEventType, only = false) =>
    setTypeFilter((s) => {
      if (only) return s.size === 1 && s.has(t) ? new Set() : new Set([t]);
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  const orderedViews = mobile
    ? [VIEWS[3], VIEWS[0], VIEWS[1], VIEWS[2], VIEWS[4]]
    : VIEWS;

  const overdueTotal = useMemo(() => events.filter((e) => isOverdue(e, now)).length, [events, now]);

  /** Chipy typów + selecty — wspólne dla paska desktop i arkusza mobile. */
  const filterControls = (
    <>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Typy wydarzeń">
        {EVENT_TYPE_ORDER.map((t) => {
          const m = EVENT_TYPE_META[t];
          const active = typeFilter.has(t);
          const dimmed = typeFilter.size > 0 && !active;
          const Icon = m.icon;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={active}
              onClick={(e) => toggleType(t, e.altKey)}
              onDoubleClick={(e) => {
                e.preventDefault();
                toggleType(t, true);
              }}
              title={
                active
                  ? `${m.label} — kliknij, by ukryć`
                  : `${m.label} — kliknij, by filtrować (Alt+klik / dwuklik: tylko ten typ)`
              }
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-7",
                active
                  ? cn(m.chipActive, "shadow-sm")
                  : cn(
                      "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                      dimmed && "opacity-60"
                    )
              )}
            >
              <Icon
                className="h-3.5 w-3.5"
                style={active ? undefined : { color: typeColor(t) }}
                aria-hidden
              />
              {m.label}
              {active && <Check className="h-3 w-3" aria-hidden />}
            </button>
          );
        })}
      </div>
      <span className="hidden h-5 w-px bg-border md:block" aria-hidden />
      <StatusFilter value={statusFilter} counts={statusCounts} onChange={setStatusFilter} />
      <span className="hidden h-5 w-px bg-border md:block" aria-hidden />
      <TechnicianFilter
        technicians={technicians}
        value={technicianFilter}
        onLeave={onLeave}
        onChange={setTechnicianFilter}
        inline={mobile}
      />
    </>
  );

  return (
    <div className="space-y-4">
      {!editable && <ReadOnlyBanner />}

      {/* aria-live: zmiany okresu / przeniesienia / statusy */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {/* Nagłówek */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Kalendarz</h1>
          <p className="text-sm text-muted-foreground">
            Dział techniczny — serwisy, montaże, wizje, konserwacje
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={activityOpen ? "secondary" : "outline"}
            size="sm"
            className="h-10 md:h-9"
            aria-pressed={activityOpen}
            onClick={() => {
              setAssistantOpen(false);
              setActivityOpen((o) => !o);
            }}
          >
            <Activity className="mr-1 h-4 w-4" /> Aktywność
          </Button>
          {assistantAllowed && (
            <Button
              variant={assistantOpen ? "secondary" : "outline"}
              size="sm"
              className="h-10 md:h-9"
              aria-pressed={assistantOpen}
              onClick={() => {
                setActivityOpen(false);
                setAssistantOpen((o) => !o);
              }}
              title="Asystent kalendarza (AI)"
              data-testid="assistant-toggle"
            >
              <Sparkles className="mr-1 h-4 w-4" /> Asystent
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-10 md:h-9" onClick={() => setIcsOpen(true)}>
            <Rss className="mr-1 h-4 w-4" /> <span className="hidden sm:inline">Subskrybuj (ICS)</span>
            <span className="sm:hidden">ICS</span>
          </Button>
          {editable && (
            <Button size="sm" className="h-10 md:h-9" onClick={() => openCreate()} title="Nowe wydarzenie (N)">
              <Plus className="mr-1 h-4 w-4" /> Nowe wydarzenie
            </Button>
          )}
        </div>
      </div>

      <div
        className={cn(
          "grid gap-4",
          activityOpen && "lg:grid-cols-[1fr_360px]",
          assistantOpen && "lg:grid-cols-[1fr_420px]"
        )}
      >
        <Card className="min-w-0">
          <CardContent className="space-y-3 p-3 sm:p-4">
            {/* Toolbar — rząd 1: nawigacja + tytuł | widoki */}
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-2",
                mobile && "sticky top-16 z-20 -mx-3 -mt-3 border-b bg-card px-3 py-2"
              )}
            >
              <div className="flex min-w-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 md:h-9 md:w-9"
                  onClick={navPrev}
                  aria-label="Poprzedni okres"
                  title="Poprzedni (←)"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 md:h-9"
                  onClick={navToday}
                  title="Dziś (T)"
                >
                  Dziś
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 md:h-9 md:w-9"
                  onClick={navNext}
                  aria-label="Następny okres"
                  title="Następny (→)"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <h2
                  className="ml-1 min-w-0 truncate text-base font-semibold capitalize sm:ml-2 sm:text-lg"
                  aria-live="off"
                >
                  {title}
                </h2>
                {loading && loadedOnce && (
                  <Loader2
                    className="ml-1 h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                    aria-label="Odświeżanie"
                  />
                )}
                {!loading && loadedOnce && overdueTotal > 0 && !isBoard && (
                  <button
                    type="button"
                    onClick={() => {
                      changeView("board");
                      setBoardGroup("status");
                    }}
                    className="ml-2 hidden items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 hover:bg-red-200 dark:bg-red-500/20 dark:text-red-200 dark:hover:bg-red-500/30 md:inline-flex"
                    title="Zaplanowane, których termin minął — otwórz Tablicę"
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    {overdueTotal} po terminie
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isBoard && !mobile && (
                  <SegmentedControl
                    label="Grupowanie tablicy"
                    value={boardGroup}
                    onChange={(k) => setBoardGroup(k as BoardGroupBy)}
                    tone="secondary"
                    options={[
                      { key: "status", label: "wg statusu", icon: ListChecks },
                      { key: "type", label: "wg typu", icon: Tags },
                    ]}
                  />
                )}
                <SegmentedControl
                  label="Widok"
                  value={view}
                  onChange={(k) => changeView(k as ViewName)}
                  options={orderedViews.map((v) => ({
                    key: v.key,
                    label: mobile ? v.shortLabel : v.label,
                    title: `${v.label} (${v.keys[0].toUpperCase()})`,
                  }))}
                />
                <Button
                  variant={activeFilterCount ? "secondary" : "outline"}
                  size="icon"
                  className="relative h-10 w-10 md:hidden"
                  onClick={() => setFiltersOpen(true)}
                  aria-label={`Filtry${activeFilterCount ? ` (${activeFilterCount} aktywne)` : ""}`}
                >
                  <Filter className="h-4 w-4" />
                  {activeFilterCount > 0 && (
                    <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
                <div className="relative hidden md:block">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground"
                    onClick={() => setHelpOpen((o) => !o)}
                    aria-label="Pomoc: legenda i skróty"
                    aria-expanded={helpOpen}
                    title="Legenda i skróty (?)"
                  >
                    <HelpCircle className="h-4 w-4" />
                  </Button>
                  {helpOpen && <HelpPopover onClose={() => setHelpOpen(false)} editable={editable} />}
                </div>
              </div>
            </div>

            {/* Toolbar — rząd 2: filtry (desktop) */}
            <div className="hidden flex-wrap items-center gap-2 md:flex">
              <span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Filter className="h-3.5 w-3.5" aria-hidden /> Filtry
                {activeFilterCount > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </span>
              {filterControls}
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FilterX className="h-3.5 w-3.5" aria-hidden /> Wyczyść filtry
                </button>
              )}
              {isBoard && mobile && null}
            </div>

            {/* Aktywne filtry na mobile — pasek podsumowania */}
            {mobile && activeFilterCount > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Filtry: {activeFilterCount} aktywne
                  {typeFilter.size > 0 && ` · ${Array.from(typeFilter).map((t) => EVENT_TYPE_META[t].label).join(", ")}`}
                </span>
                <button type="button" onClick={clearFilters} className="ml-auto underline">
                  wyczyść
                </button>
              </div>
            )}

            {/* Tablica (kanban) — zamiast siatki FullCalendar */}
            {isBoard && (
              <div className="alfa-calendar relative min-w-0" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                {mobile && (
                  <div className="mb-2">
                    <SegmentedControl
                      label="Grupowanie tablicy"
                      value={boardGroup}
                      onChange={(k) => setBoardGroup(k as BoardGroupBy)}
                      tone="secondary"
                      options={[
                        { key: "status", label: "wg statusu", icon: ListChecks },
                        { key: "type", label: "wg typu", icon: Tags },
                      ]}
                    />
                  </div>
                )}
                {!loadedOnce && <CalendarSkeleton columns={4} />}
                <CalendarBoard
                  events={events}
                  groupBy={boardGroup}
                  editable={editable}
                  loading={loading}
                  onOpen={openEvent}
                  onContextMenu={handleBoardContextMenu}
                  onMove={handleBoardMove}
                  onCreate={editable ? () => openCreate() : undefined}
                />
              </div>
            )}

            {/* Kalendarz */}
            {!isBoard && (
              <div
                className="alfa-calendar relative"
                onContextMenu={handleGridContextMenu}
                onTouchStart={onTouchStart}
                onTouchEnd={onTouchEnd}
                aria-busy={loading || undefined}
              >
                {!loadedOnce && <CalendarSkeleton columns={view === "timeGridDay" ? 1 : 7} />}
                <FullCalendar
                  ref={calendarRef}
                  plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
                  locale={plLocale}
                  initialView={view}
                  initialDate={anchorDate}
                  headerToolbar={false}
                  firstDay={1}
                  height="auto"
                  nowIndicator
                  slotMinTime="06:00:00"
                  slotMaxTime="20:00:00"
                  slotDuration="00:30:00"
                  scrollTime="07:00:00"
                  dayMaxEvents={mobile ? 2 : 3}
                  weekNumbers={!mobile}
                  weekText="T"
                  eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
                  slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
                  dayPopoverFormat={{ weekday: "long", day: "numeric", month: "long" }}
                  editable={editable}
                  eventStartEditable={editable}
                  eventDurationEditable={editable}
                  selectable={editable}
                  selectMirror
                  unselectAuto
                  events={fcEvents}
                  eventContent={renderEventContent}
                  eventClick={handleEventClick}
                  eventDidMount={handleEventDidMount}
                  eventWillUnmount={handleEventWillUnmount}
                  select={handleSelect}
                  eventDrop={handleMove}
                  eventResize={handleMove}
                  datesSet={handleDatesSet}
                  noEventsContent={() => (
                    <EmptyState
                      title={
                        activeFilterCount
                          ? "Brak wydarzeń pasujących do filtrów"
                          : view === "timeGridDay"
                            ? "Brak wydarzeń tego dnia"
                            : "Brak wydarzeń w tym tygodniu"
                      }
                      onCreate={editable ? () => openCreate() : undefined}
                      onClearFilters={activeFilterCount ? clearFilters : undefined}
                      onNext={navNext}
                    />
                  )}
                  moreLinkContent={(a) => `+${a.num} więcej`}
                  moreLinkHint={(n) => `Pokaż ${n} więcej`}
                  navLinkHint="Przejdź do dnia"
                  closeHint="Zamknij"
                  eventHint="Wydarzenie"
                />
                {/* Pusty stan w siatce (mies./tydz.) — subtelny pasek pod siatką */}
                {loadedOnce && !loading && visibleCount === 0 && view !== "listWeek" && (
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    <CalendarX2 className="h-3.5 w-3.5" aria-hidden />
                    {activeFilterCount ? "Brak wydarzeń pasujących do filtrów." : "Brak wydarzeń w tym okresie."}
                    {activeFilterCount > 0 && (
                      <button type="button" onClick={clearFilters} className="font-medium underline">
                        Wyczyść filtry
                      </button>
                    )}
                    {editable && (
                      <button type="button" onClick={() => openCreate()} className="font-medium underline">
                        Nowe wydarzenie
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Panel Aktywność */}
        {activityOpen && (
          <ActivityPanel
            entries={activity}
            loading={activityLoading}
            onClose={() => setActivityOpen(false)}
            onOpenEvent={(id) => void openEventById(id)}
            onRefresh={() => void loadActivity()}
          />
        )}

        {/* Panel Asystent (wg status.allowed) */}
        {assistantOpen && assistantAllowed && (
          <AssistantDrawer
            onClose={closeAssistant}
            onPreviewRange={onAssistantPreview}
            onEventsChanged={onAssistantEventsChanged}
            onEditProposal={onAssistantEditProposal}
            onEditEvent={onAssistantEditEvent}
            onOpenEvent={(id) => void openEventById(id)}
          />
        )}
      </div>

      {/* Podgląd wydarzenia (jeden klik) */}
      {preview && (
        <EventPreview
          state={preview}
          editable={editable}
          onClose={closePreview}
          onEdit={() => {
            closePreview();
            openEvent(preview.ev);
          }}
          onGoToObject={
            preview.ev.objectId ? () => navigate(`/objects/${preview.ev.objectId}`) : undefined
          }
          onStatus={(s) => void setStatus(preview.ev, s)}
        />
      )}

      {/* Dialog wydarzenia */}
      <CalendarEventDialog
        key={dialogNonce}
        open={dialogOpen}
        mode={dialogMode}
        event={dialogEvent}
        prefill={dialogPrefill}
        onClose={() => {
          assistantSavedRef.current = null;
          setDialogOpen(false);
        }}
        onSaved={(ev) => {
          const fromAssistant = assistantSavedRef.current;
          assistantSavedRef.current = null;
          if (fromAssistant) {
            // Propozycja asystenta zapisana z dialogu — toast + wpis systemowy w czacie.
            fromAssistant(ev);
            return;
          }
          announce(`Zapisano „${ev.title}”`);
          void loadEvents();
        }}
        onDeleted={handleDeleted}
        onNotesChanged={(id, count) =>
          setAllEvents((list) => list.map((e) => (e.id === id ? { ...e, notesCount: count } : e)))
        }
        onOpenEvent={(id) => void openEventById(id)}
      />

      {/* Menu kontekstowe (prawy przycisk na wydarzeniu / pustym dniu) */}
      <ContextMenu
        open={ctxMenu !== null}
        x={ctxMenu?.x ?? 0}
        y={ctxMenu?.y ?? 0}
        items={ctxItems}
        onClose={closeCtxMenu}
        header={
          ctxMenu?.kind === "event"
            ? ctxMenu.ev.title
            : ctxMenu?.kind === "slot"
              ? "Nowe wydarzenie"
              : undefined
        }
        headerIcon={
          ctxMenu?.kind === "event"
            ? EVENT_TYPE_META[ctxMenu.ev.type]?.icon ?? Building2
            : ctxMenu?.kind === "slot"
              ? CalendarPlus
              : undefined
        }
        headerIconColor={ctxMenu?.kind === "event" ? typeColor(ctxMenu.ev.type) : undefined}
        subheader={
          ctxMenu?.kind === "event"
            ? fmtRange(ctxMenu.ev.startAt, ctxMenu.ev.endAt, ctxMenu.ev.allDay)
            : ctxMenu?.kind === "slot"
              ? fmtRange(ctxMenu.startAt, ctxMenu.endAt, ctxMenu.allDay)
              : undefined
        }
      />

      {/* Usuwanie z menu kontekstowego — ta sama ścieżka co „Usuń” w dialogu */}
      <CalendarDeletePrompt
        event={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onDeleted={handleDeleted}
      />

      {/* Arkusz filtrów (mobile) */}
      {filtersOpen && (
        <FiltersSheet
          count={activeFilterCount}
          onClear={clearFilters}
          onClose={() => setFiltersOpen(false)}
        >
          {filterControls}
        </FiltersSheet>
      )}

      {/* Toasty */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <IcsDialog open={icsOpen} onClose={() => setIcsOpen(false)} notify={notify} />

      {/* Link do listy obiektów — dla wygody planowania */}
      <p className="text-xs text-muted-foreground">
        Wydarzenia powiązane z obiektem są też widoczne w zakładce „Kalendarz” na{" "}
        <Link to="/objects" className="underline">karcie obiektu</Link>.
        <span className="hidden md:inline">
          {" "}Skróty klawiaturowe: <kbd className="alfa-kbd">?</kbd>
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pod-komponenty strony
// ---------------------------------------------------------------------------

interface SegmentedOption {
  key: string;
  label: string;
  icon?: typeof Tags;
  title?: string;
}

/** Grupa radio (segmented) z nawigacją strzałkami / Home / End. */
function SegmentedControl({
  label,
  value,
  onChange,
  options,
  tone = "primary",
}: {
  label: string;
  value: string;
  onChange: (key: string) => void;
  options: SegmentedOption[];
  tone?: "primary" | "secondary";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = options.findIndex((o) => o.key === value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(options[next].key);
    const btn = ref.current?.querySelectorAll<HTMLButtonElement>("button[role=radio]")[next];
    btn?.focus();
  };
  return (
    <div
      ref={ref}
      className="inline-flex gap-0.5 rounded-md border bg-muted/50 p-0.5"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex h-9 items-center gap-1 rounded px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8",
              active
                ? tone === "primary"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:bg-background hover:text-foreground"
            )}
          >
            {o.icon && <o.icon className="h-3.5 w-3.5" aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Skeleton nakładany na siatkę przy pierwszym ładowaniu (stabilna wysokość). */
function CalendarSkeleton({ columns }: { columns: number }) {
  return (
    <div
      className="cal-skeleton"
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      role="status"
      aria-label="Ładowanie kalendarza"
    >
      {Array.from({ length: columns * (columns === 1 ? 1 : 3) }).map((_, i) => (
        <div key={i} className="cal-skeleton-cell">
          <div className="cal-skeleton-bar w40" style={{ animationDelay: `${(i % 7) * 80}ms` }} />
          {i % 3 !== 1 && <div className="cal-skeleton-bar w80" style={{ animationDelay: `${(i % 7) * 80 + 120}ms` }} />}
          {i % 4 === 0 && <div className="cal-skeleton-bar w60" style={{ animationDelay: `${(i % 7) * 80 + 240}ms` }} />}
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  onCreate,
  onClearFilters,
  onNext,
}: {
  title: string;
  onCreate?: () => void;
  onClearFilters?: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <CalendarX2 className="h-8 w-8 text-muted-foreground/50" aria-hidden />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">
        Przejdź do następnego tygodnia strzałką <kbd className="alfa-kbd">→</kbd>
        {onClearFilters ? " albo wyczyść filtry." : onCreate ? " albo zaplanuj coś nowego." : "."}
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button variant="outline" size="sm" onClick={onNext}>
          Następny okres <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
        {onClearFilters && (
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            <FilterX className="mr-1 h-4 w-4" /> Wyczyść filtry
          </Button>
        )}
        {onCreate && (
          <Button size="sm" onClick={onCreate}>
            <Plus className="mr-1 h-4 w-4" /> Nowe wydarzenie
          </Button>
        )}
      </div>
    </div>
  );
}

/** Popover pomocy: legenda kolorów/statusów, gesty, skróty. */
function HelpPopover({ onClose, editable }: { onClose: () => void; editable: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      // klik w przycisk „?” obsługuje toggle rodzica
      if ((t as HTMLElement).closest?.('[aria-label="Pomoc: legenda i skróty"]')) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  const shortcuts: [string[], string][] = [
    [["T"], "Dziś"],
    [["←", "→"], "Poprzedni / następny okres"],
    [["J", "K"], "jak wyżej (styl Gmail)"],
    [["M"], "Miesiąc"],
    [["W"], "Tydzień"],
    [["D"], "Dzień"],
    [["L", "A"], "Lista (agenda)"],
    [["B"], "Tablica"],
    ...(editable ? ([[["N", "C"], "Nowe wydarzenie"]] as [string[], string][]) : []),
    [["Esc"], "Zamknij podgląd / menu / pomoc"],
    [["?"], "Ta ściąga"],
  ];
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Legenda i skróty"
      className="alfa-pop absolute right-0 top-11 z-40 w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Legenda i skróty</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Zamknij pomoc">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Typy</p>
            <ul className="alfa-calendar space-y-1">
              {EVENT_TYPE_ORDER.map((t) => {
                const m = EVENT_TYPE_META[t];
                return (
                  <li key={t} className="flex items-center gap-2 text-xs">
                    <span className="h-3 w-1 rounded-sm" style={{ background: typeColor(t) }} aria-hidden />
                    <m.icon className="h-3.5 w-3.5" style={{ color: typeColor(t) }} aria-hidden />
                    {m.label}
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Statusy</p>
            <ul className="space-y-1">
              {EVENT_STATUS_ORDER.map((s) => (
                <li key={s} className="flex items-start gap-2 text-xs">
                  <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold", EVENT_STATUS_META[s].badge)}>
                    {EVENT_STATUS_META[s].label}
                  </span>
                  <span className="text-muted-foreground">{EVENT_STATUS_META[s].hint}</span>
                </li>
              ))}
              <li className="flex items-center gap-2 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 text-red-500" aria-hidden />
                <span className="text-muted-foreground">po terminie — zaplanowane, minął koniec</span>
              </li>
            </ul>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mysz</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li className="flex gap-2"><MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span>Klik — podgląd; dwuklik — edycja</span></li>
              <li className="flex gap-2"><MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span>Prawy przycisk — menu (status, duplikat, usuń)</span></li>
              {editable && (
                <>
                  <li className="flex gap-2"><MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span>Przeciągnij — przenieś; krawędź — zmień długość</span></li>
                  <li className="flex gap-2"><MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span>Zaznacz dni/godziny — nowe wydarzenie</span></li>
                </>
              )}
              <li className="flex gap-2"><Filter className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span>Alt+klik / dwuklik na chipie — tylko ten typ</span></li>
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Klawiatura</p>
            <ul className="space-y-1">
              {shortcuts.map(([keys, desc]) => (
                <li key={desc} className="flex items-center gap-2 text-xs">
                  <span className="flex w-16 shrink-0 gap-1">
                    {keys.map((k) => (
                      <kbd key={k} className="alfa-kbd">{k}</kbd>
                    ))}
                  </span>
                  <span className="text-muted-foreground">{desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Szybki podgląd wydarzenia zakotwiczony przy elemencie w siatce. */
function EventPreview({
  state,
  editable,
  onClose,
  onEdit,
  onGoToObject,
  onStatus,
}: {
  state: PreviewState;
  editable: boolean;
  onClose: () => void;
  onEdit: () => void;
  onGoToObject?: () => void;
  onStatus: (s: CalendarEventStatus) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: state.rect.left, top: state.rect.top });
  const ev = state.ev;
  const meta = EVENT_TYPE_META[ev.type];
  const Icon = meta?.icon ?? Building2;
  const status = EVENT_STATUS_META[ev.status];
  const canMutate = editable && !ev.deletedAt;
  const overdue = isOverdue(ev, new Date());
  const notesCount = ev.notesCount ?? ev.notes?.length ?? 0;
  // Ostatnia notatka jedną linią: z listy nie mamy treści — dociągamy tylko gdy licznik > 0.
  const inlineLast = ev.notes?.length ? ev.notes[ev.notes.length - 1] : null;
  const [fetchedLast, setFetchedLast] = useState<{ id: number; note: CalendarNote | null } | null>(null);
  useEffect(() => {
    if (inlineLast || !notesCount) return;
    let cancelled = false;
    calendarApi
      .notes(ev.id)
      .then((res) => {
        if (cancelled) return;
        const list = res.data ?? [];
        setFetchedLast({ id: ev.id, note: list.length ? list[list.length - 1] : null });
      })
      .catch(() => {
        /* starszy backend — bez linii notatki */
      });
    return () => {
      cancelled = true;
    };
  }, [ev.id, inlineLast, notesCount]);
  const lastNote = inlineLast ?? (fetchedLast?.id === ev.id && notesCount ? fetchedLast.note : null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    const r = state.rect;
    // Preferuj prawo od eventu, potem lewo, potem pod spodem.
    let left = r.left + r.width + 8;
    let top = r.top;
    if (left + width > window.innerWidth - pad) left = r.left - width - 8;
    if (left < pad) {
      left = Math.max(pad, Math.min(r.left, window.innerWidth - width - pad));
      top = r.top + r.height + 6;
    }
    if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
    setPos({ left, top });
  }, [state]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button[data-primary]")?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Podgląd: ${ev.title}`}
      data-testid="event-preview"
      style={{ left: pos.left, top: pos.top }}
      className="alfa-pop alfa-calendar fixed z-50 w-80 rounded-lg border bg-popover p-0 text-sm text-popover-foreground shadow-xl"
    >
      <div className="flex items-start gap-2 border-b px-3 py-2.5" style={{ boxShadow: `inset 3px 0 0 ${typeColor(ev.type)}` }}>
        <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: typeColor(ev.type) }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className={cn("font-semibold leading-snug", ev.status === "cancelled" && "line-through")}>{ev.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{meta?.label ?? ev.type}</span>
            <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold", status?.badge)}>{status?.label}</span>
            {overdue && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-600 dark:text-red-300">
                <AlertTriangle className="h-3 w-3" aria-hidden /> po terminie
              </span>
            )}
            {ev.deletedAt && <span className="text-[10px] font-semibold text-red-600">usunięte</span>}
            <NotesBadge count={notesCount} />
          </div>
        </div>
        <Button variant="ghost" size="icon" className="-mr-1 -mt-1 h-7 w-7" onClick={onClose} aria-label="Zamknij podgląd">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <dl className="space-y-1.5 px-3 py-2.5 text-xs">
        <div className="flex gap-2">
          <dt className="w-4 shrink-0 text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" aria-label="Termin" /></dt>
          <dd className="tabular-nums">{fmtRange(ev.startAt, ev.endAt, ev.allDay)}{ev.allDay && " · cały dzień"}</dd>
        </div>
        {ev.objectName && (
          <div className="flex gap-2">
            <dt className="w-4 shrink-0 text-muted-foreground"><Building2 className="h-3.5 w-3.5" aria-label="Obiekt" /></dt>
            <dd className="truncate">{ev.objectName}</dd>
          </div>
        )}
        {ev.location && (
          <div className="flex gap-2">
            <dt className="w-4 shrink-0 text-muted-foreground"><MapPin className="h-3.5 w-3.5" aria-label="Lokalizacja" /></dt>
            <dd className="truncate">{ev.location}</dd>
          </div>
        )}
        {ev.technicians.length > 0 && (
          <div className="flex gap-2">
            <dt className="w-4 shrink-0 text-muted-foreground"><Users className="h-3.5 w-3.5" aria-label="Technicy" /></dt>
            <dd>{ev.technicians.map((t) => `${t.firstName} ${t.lastName}`).join(", ")}</dd>
          </div>
        )}
        {ev.seriesId && (
          <div className="flex gap-2">
            <dt className="w-4 shrink-0 text-muted-foreground"><Repeat className="h-3.5 w-3.5" aria-label="Seria" /></dt>
            <dd>
              seria
              {ev.seriesIndex != null && ev.seriesTotal != null && ` ${ev.seriesIndex}/${ev.seriesTotal}`}
            </dd>
          </div>
        )}
        {ev.description && (
          <div className="flex gap-2">
            <dt className="w-4 shrink-0 text-muted-foreground"><AlertCircle className="h-3.5 w-3.5" aria-label="Opis" /></dt>
            <dd className="line-clamp-2 text-muted-foreground">{ev.description}</dd>
          </div>
        )}
        {lastNote && (
          <div className="flex gap-2" data-testid="preview-last-note">
            <dt className="w-4 shrink-0 text-amber-600 dark:text-amber-400"><StickyNote className="h-3.5 w-3.5" aria-label="Ostatnia notatka" /></dt>
            <dd className="min-w-0 truncate" title={lastNote.text}>
              <span className="text-muted-foreground">{lastNote.userLabel || (lastNote.source === "assistant" ? "Asystent" : "—")}:</span>{" "}
              {lastNote.text.replace(/\s+/g, " ")}
            </dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
        <Button size="sm" className="h-8" onClick={onEdit} data-primary>
          {canMutate ? <Pencil className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
          {canMutate ? "Edytuj" : "Otwórz"}
        </Button>
        {onGoToObject && (
          <Button size="sm" variant="outline" className="h-8" onClick={onGoToObject}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" /> Obiekt
          </Button>
        )}
        {canMutate && ev.status === "planned" && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => onStatus("confirmed")}>
            <Check className="mr-1 h-3.5 w-3.5" /> Potwierdź
          </Button>
        )}
        {canMutate && ev.status !== "done" && ev.type !== "urlop" && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => onStatus("done")}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" /> Wykonane
          </Button>
        )}
      </div>
    </div>
  );
}

/** Arkusz dolny z filtrami (mobile). */
function FiltersSheet({
  count,
  onClear,
  onClose,
  children,
}: {
  count: number;
  onClear: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden">
      <button type="button" className="absolute inset-0 bg-black/40" aria-label="Zamknij filtry" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Filtry"
        className="alfa-toast relative max-h-[85vh] overflow-y-auto rounded-t-2xl border-t bg-card p-4 pb-6 shadow-2xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden />
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Filtry{count > 0 && <span className="ml-1 text-muted-foreground">({count})</span>}
          </h3>
          <Button variant="ghost" size="icon" className="h-10 w-10" onClick={onClose} aria-label="Zamknij">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-col gap-3 [&_select]:h-11 [&_select]:w-full">{children}</div>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="h-11 flex-1" onClick={onClear} disabled={count === 0}>
            <FilterX className="mr-1 h-4 w-4" /> Wyczyść
          </Button>
          <Button className="h-11 flex-1" onClick={onClose}>
            Pokaż wyniki
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Stos toastów (błędy z „Ponów”, „Usunięto · Przywróć”). */
function ToastStack({ toasts, onDismiss }: { toasts: CalendarToast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => {
        const ActionIcon = t.action?.icon;
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={cn(
              "alfa-toast pointer-events-auto flex items-center gap-3 rounded-md border bg-popover px-3 py-2 text-sm shadow-lg",
              t.kind === "error" && "border-red-300 dark:border-red-500/40"
            )}
          >
            {t.kind === "error" ? (
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-300" aria-hidden />
            ) : (
              <Trash2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.action && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                onClick={() => {
                  onDismiss(t.id);
                  t.action?.onClick();
                }}
              >
                {ActionIcon && <ActionIcon className="mr-1 h-4 w-4" />} {t.action.label}
              </Button>
            )}
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onDismiss(t.id)} aria-label="Zamknij">
              <X className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Chipy statusów (multi) z licznikami wydarzeń w bieżącym zakresie. */
function StatusFilter({
  value,
  counts,
  onChange,
}: {
  value: Set<CalendarEventStatus>;
  counts: Record<CalendarEventStatus, number>;
  onChange: (next: Set<CalendarEventStatus>) => void;
}) {
  const toggle = (s: CalendarEventStatus, only: boolean) => {
    if (only) {
      onChange(value.size === 1 && value.has(s) ? new Set() : new Set([s]));
      return;
    }
    const n = new Set(value);
    if (n.has(s)) n.delete(s);
    else n.add(s);
    onChange(n);
  };
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Statusy">
      {EVENT_STATUS_ORDER.map((s) => {
        const m = EVENT_STATUS_META[s];
        const active = value.has(s);
        const dimmed = value.size > 0 && !active;
        const count = counts[s] ?? 0;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={active}
            onClick={(e) => toggle(s, e.altKey)}
            onDoubleClick={(e) => {
              e.preventDefault();
              toggle(s, true);
            }}
            title={`${m.label}: ${count} w tym okresie — ${m.hint}`}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-7",
              active
                ? cn("border-transparent shadow-sm", m.badge)
                : cn(
                    "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                    dimmed && "opacity-60"
                  )
            )}
          >
            <span className={cn("h-2 w-2 rounded-full", STATUS_DOT[s])} aria-hidden />
            {m.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums",
                active ? "bg-background/70 text-foreground" : "bg-muted text-muted-foreground"
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const STATUS_DOT: Record<CalendarEventStatus, string> = {
  planned: "bg-sky-500",
  confirmed: "bg-emerald-500",
  done: "bg-slate-400",
  cancelled: "bg-red-500",
};

/** Filtr techników: przycisk-popover z multi-wyborem (inline w arkuszu mobile). */
function TechnicianFilter({
  technicians,
  value,
  onLeave,
  onChange,
  inline,
}: {
  technicians: Technician[];
  value: Set<number>;
  onLeave: Set<number>;
  onChange: (next: Set<number>) => void;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const selected = technicians.filter((t) => value.has(t.id));
  const label =
    selected.length === 0
      ? "Technicy"
      : selected.length <= 2
        ? `Technicy: ${selected.map((t) => t.lastName || t.firstName).join(", ")}`
        : `Technicy (${selected.length})`;
  const needle = q.trim().toLowerCase();
  const list = needle
    ? technicians.filter((t) => `${t.firstName} ${t.lastName}`.toLowerCase().includes(needle))
    : technicians;
  const toggle = (id: number) => {
    const n = new Set(value);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    onChange(n);
  };
  const active = value.size > 0;

  const panel = (
    <div
      role="group"
      aria-label="Wybór techników"
      className={cn(
        inline
          ? "rounded-md border bg-background"
          : "alfa-pop absolute left-0 top-9 z-40 w-72 rounded-md border bg-popover shadow-xl"
      )}
    >
      {technicians.length > 8 && (
        <div className="border-b p-2">
          <input
            ref={searchRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Szukaj technika…"
            aria-label="Szukaj technika"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      )}
      <ul className="max-h-64 overflow-y-auto p-1">
        {list.length === 0 && (
          <li className="px-2 py-3 text-center text-xs text-muted-foreground">
            {technicians.length === 0 ? "Brak aktywnych techników" : "Nikt nie pasuje"}
          </li>
        )}
        {list.map((t) => {
          const checked = value.has(t.id);
          const leave = onLeave.has(t.id);
          return (
            <li key={t.id}>
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent",
                  inline && "py-2.5"
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(t.id)}
                  className="h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
                />
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                    checked ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                  )}
                  aria-hidden
                >
                  {initials(`${t.firstName} ${t.lastName}`)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {t.firstName} {t.lastName}
                </span>
                {leave && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-1.5 py-px text-[10px] font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-200"
                    title="Ma urlop w tym okresie"
                  >
                    urlop
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5 text-xs">
        <button
          type="button"
          className="rounded px-1.5 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onChange(new Set(technicians.map((t) => t.id)))}
          disabled={technicians.length === 0}
        >
          Zaznacz wszystkich
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          onClick={() => onChange(new Set())}
          disabled={!active}
        >
          Wyczyść
        </button>
      </div>
    </div>
  );

  if (inline) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {panel}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-pressed={active}
        onClick={() => setOpen((o) => !o)}
        title="Filtruj wg techników"
        className={cn(
          "inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-7",
          active
            ? "border-primary bg-primary text-primary-foreground shadow-sm"
            : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        )}
      >
        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && panel}
    </div>
  );
}

/** Panel „Ostatnia aktywność”: grupowanie po dniu, avatar, czas relatywny, filtr akcji. */
function ActivityPanel({
  entries,
  loading,
  onClose,
  onOpenEvent,
  onRefresh,
}: {
  entries: ActivityEntry[];
  loading: boolean;
  onClose: () => void;
  onOpenEvent: (id: number) => void;
  onRefresh: () => void;
}) {
  const [action, setAction] = useState("");
  const [query, setQuery] = useState("");
  const now = useMemo(() => new Date(), [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((a) => {
      if (action && a.action !== action && !(action === "assigned" && a.action === "unassigned")) return false;
      if (!q) return true;
      const hay = [a.event?.title, a.userLabel, a.summary, a.oldValue, a.newValue]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [entries, action, query]);

  const groups = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>();
    for (const a of filtered) {
      const k = timestampDayKey(a.createdAt);
      const arr = map.get(k);
      if (arr) arr.push(a);
      else map.set(k, [a]);
    }
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <Card className="h-fit lg:sticky lg:top-4">
      <CardContent className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4" aria-hidden /> Ostatnia aktywność
          </h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onRefresh}
              aria-label="Odśwież aktywność"
              disabled={loading}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Zamknij panel aktywności">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="mb-2 flex gap-1.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Szukaj…"
            aria-label="Szukaj w aktywności"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            aria-label="Rodzaj akcji"
            className="h-8 rounded-md border border-input bg-background px-1.5 text-xs"
          >
            <option value="">Wszystkie akcje</option>
            {ACTIVITY_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {loading && entries.length === 0 ? (
          <ul className="space-y-2" aria-label="Ładowanie aktywności" aria-busy>
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex gap-2 px-1 py-1">
                <div className="alfa-calendar h-6 w-6 shrink-0"><div className="cal-skeleton-bar h-6 w-6 rounded-full" /></div>
                <div className="alfa-calendar flex-1 space-y-1.5">
                  <div className="cal-skeleton-bar w80" style={{ height: 11 }} />
                  <div className="cal-skeleton-bar w60" style={{ height: 9 }} />
                </div>
              </li>
            ))}
          </ul>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-2 py-8 text-center">
            <Activity className="h-6 w-6 text-muted-foreground/50" aria-hidden />
            <p className="text-xs font-medium">{entries.length === 0 ? "Brak wpisów" : "Nic nie pasuje do filtra"}</p>
            <p className="text-[11px] text-muted-foreground">
              {entries.length === 0
                ? "Zmiany w kalendarzu pojawią się tutaj."
                : "Zmień rodzaj akcji albo wyczyść wyszukiwanie."}
            </p>
          </div>
        ) : (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {groups.map(([day, items]) => (
              <section key={day} aria-label={fmtDayHeading(day, now)}>
                <h3 className="sticky top-0 z-[1] mb-1 bg-card py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {fmtDayHeading(day, now)}
                </h3>
                <ul className="space-y-0.5">
                  {items.map((a) => (
                    <ActivityRow key={a.id} entry={a} now={now} onOpen={a.event ? () => onOpenEvent(a.event!.id) : undefined} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  entry: a,
  now,
  onOpen,
}: {
  entry: ActivityEntry;
  now: Date;
  onOpen?: () => void;
}) {
  const parts = activityParts(a);
  const am = ACTIVITY_ACTION_META[a.action];
  const ActionIcon = am?.icon ?? Pencil;
  const TypeIcon = a.event ? EVENT_TYPE_META[a.event.type]?.icon ?? CalendarDays : CalendarDays;
  const when = parseLocal(a.event?.startAt ?? "");
  const eventDate = a.event && !Number.isNaN(when.getTime()) ? fmtShort(a.event.startAt, a.event.allDay) : null;
  return (
    <li>
      <button
        type="button"
        disabled={!onOpen}
        onClick={onOpen}
        title={fmtTimestamp(a.createdAt)}
        className="group w-full rounded-md px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <div className="flex items-start gap-2">
          <span className="relative mt-0.5 shrink-0">
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground"
              aria-hidden
            >
              {initials(a.userLabel)}
            </span>
            <span
              className={cn(
                "absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-card bg-card",
                am?.tone ?? "text-muted-foreground"
              )}
            >
              <ActionIcon className="h-2.5 w-2.5" aria-hidden />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1">
              <span className="truncate font-medium">{parts.who}</span>
              <span className="truncate text-muted-foreground">{parts.verb.toLowerCase()}</span>
              <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                {fmtRelative(a.createdAt, now.getTime())}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1">
              <TypeIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className={cn("truncate", a.event?.deletedAt && "line-through text-muted-foreground")}>
                {a.event?.title ?? `${a.entityType} #${a.entityId}`}
              </span>
              {eventDate && <span className="shrink-0 tabular-nums text-muted-foreground">· {eventDate}</span>}
            </div>
            {parts.detail && (
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={parts.detail}>
                {parts.detail}
              </div>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

/** Dialog subskrypcji ICS: generuje token i pokazuje URL do skopiowania. */
function IcsDialog({ open, onClose, notify }: { open: boolean; onClose: () => void; notify: CalendarNotify }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const buildUrl = (token: string) =>
    `${window.location.origin}/api/calendar/feed.ics?token=${encodeURIComponent(token)}`;

  // Przy otwarciu pokazujemy istniejący link (bez rotacji tokenu).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    calendarApi
      .getFeedToken()
      .then((res) => {
        if (!cancelled && res.data?.token) setUrl(buildUrl(res.data.token));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const generate = async () => {
    setBusy(true);
    try {
      const res = await calendarApi.feedToken();
      const token = res.data?.token;
      if (!token) throw new Error("Brak tokenu w odpowiedzi");
      setUrl(buildUrl(token));
      setCopied(false);
    } catch (err) {
      notify({ kind: "error", message: errMsg(err, "Nie udało się wygenerować linku") });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt("Skopiuj adres:", url);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rss className="h-5 w-5" /> Subskrybuj kalendarz (ICS)
          </DialogTitle>
          <DialogDescription>
            Prywatny link do kalendarza w formacie iCalendar — dodaj go w Google
            Calendar, Outlooku lub aplikacji w telefonie, a wydarzenia będą się
            synchronizować automatycznie (tylko odczyt).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {url ? (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 flex-1 rounded-md border bg-muted px-2 font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={copy}>
                {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                {copied ? "Skopiowano" : "Kopiuj"}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Kliknij „Generuj link”, aby utworzyć swój prywatny adres subskrypcji.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Uwaga: wygenerowanie nowego linku unieważnia poprzedni. Link zawiera
            prywatny token — nie udostępniaj go innym.
          </p>
          <div className="rounded-md border bg-muted/40 p-3 text-xs">
            <p className="mb-1 font-medium">Jak dodać:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>
                <b>Google Calendar</b> (przeglądarka): Inne kalendarze → „+” →
                „Z adresu URL” → wklej link. Google odświeża feed co kilka godzin.
              </li>
              <li>
                <b>Outlook</b>: Dodaj kalendarz → Subskrybuj z sieci Web → wklej link.
              </li>
              <li>
                <b>iPhone / macOS</b>: Ustawienia → Kalendarz → Konta → Dodaj
                subskrybowany kalendarz.
              </li>
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Zamknij
          </Button>
          <Button onClick={generate} disabled={busy}>
            {busy ? "Generowanie…" : url ? "Wygeneruj nowy link" : "Generuj link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
