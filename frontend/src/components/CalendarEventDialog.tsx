import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Calculator,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  CloudSun,
  ExternalLink,
  FileCheck2,
  FileText,
  Handshake,
  History,
  Loader2,
  Mail,
  MapPin,
  Paperclip,
  Pencil,
  Phone,
  Receipt,
  Repeat,
  RotateCcw,
  Route,
  Search,
  StickyNote,
  Trash2,
  TreePalm,
  Unlink,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  availabilityAssigneeId,
  calendarApi,
  contactsApi,
  getObjects,
  leadsApi,
  getProtocols,
  getQuotes,
  getRealizations,
  type ActivityEntry,
  type CalendarBilling,
  type CalendarConflict,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarEventProtocol,
  type CalendarEventQuote,
  type CalendarEventRealization,
  type CalendarEventStatus,
  type CalendarEventType,
  type CalendarNote,
  type CalendarNoteAttachment,
  type CalendarNoteRef,
  type CalendarSeriesFreq,
  type CalendarSeriesScope,
  type ObjectWithContractor,
  type Protocol,
  type Quote,
  type Realization,
  type CalendarAvailability,
  type Contact,
  type Lead,
  type WeatherBrief,
} from "@/lib/api";
import {
  ACTIVITY_FIELD_LABELS,
  BILLING_META,
  BILLING_ORDER,
  EVENT_STATUS_META,
  EVENT_TYPE_UI,
  activityIcon,
  fmtDuration,
  fmtMinutes,
  fmtRelative,
  initials,
  statusBadgeClass,
  EVENT_STATUS_ORDER,
  EVENT_TYPE_META,
  PROTOCOL_BADGE_META,
  QUOTE_BADGE_META,
  SERIES_FREQ_META,
  billingApplies,
  billingBadgeClass,
  billingTip,
  describeActivity,
  eventStatusLabel,
  eventTypeLabel,
  fmtLong,
  fmtRange,
  fmtShort,
  fmtTimestamp,
  isNoteEvent,
  noteEventTitle,
  noteSnippet,
  notesLabel,
  parseLocal,
  pluralPl,
  protocolBadgeClass,
  protocolBadgeKind,
  protocolHref,
  quoteBadgeClass,
  quoteBadgeKind,
  quoteHref,
  REALIZATION_BADGE_META,
  REALIZATION_KIND_LABEL,
  realizationApplies,
  realizationBadgeClass,
  realizationBadgeKind,
  realizationHref,
  realizationMoney,
  seriesShortLabel,
  toDateStr,
  toDateTimeStr,
} from "@/lib/calendar-labels";
import {
  TECHNICAL_CALENDAR,
  assigneeConflictQuery,
  assigneeIdsInput,
  assigneesOf,
  type AssigneeRef,
  type CalendarConfig,
} from "@/lib/calendar-config";
import { LEAD_STAGE_META } from "@/lib/sales-labels";
import { travelLine, travelSourceLabel, useTravel } from "@/lib/travel";
import { cn } from "@/lib/utils";
import { CalendarEventNotes, type CalendarEventNotesHandle } from "@/components/CalendarEventNotes";
import { ContactPicker } from "@/components/sales/ContactPicker";
import { LeadPicker, type LeadRef } from "@/components/sales/LeadPicker";
import { WeatherSection } from "@/components/CalendarWeather";
import { tip } from "@/components/ui/tooltip";

export type CalendarDialogMode = "create" | "edit" | "view";

export interface CalendarEventPrefill {
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  objectId?: number | null;
  type?: CalendarEventType;
  /** Pola używane przy duplikowaniu wydarzenia (bez id/serii). */
  title?: string;
  location?: string | null;
  description?: string | null;
  /**
   * Przypisani w dziale tego kalendarza (technicy albo handlowcy) — nazwa pola
   * jest wspólna, bo prefill nie wie, w której konfiguracji wyląduje.
   */
  assigneeIds?: number[];
  /** @deprecated Stara nazwa `assigneeIds`; czytana dla zgodności z wywołaniami sprzed refaktoru. */
  technicianIds?: number[];
  status?: CalendarEventStatus;
  /** Dział handlowy: szansa i osoba kontaktowa („Zaplanuj następną”). */
  leadId?: number | null;
  contactId?: number | null;
}

interface CalendarEventDialogProps {
  open: boolean;
  onClose: () => void;
  mode: CalendarDialogMode;
  /** Wydarzenie do edycji/podglądu (null przy tworzeniu). */
  event?: CalendarEvent | null;
  /**
   * Skrót pogody z listy kalendarza — sekcja „Pogoda” pokazuje go od razu,
   * zanim dociągnie pełną prognozę. Bez niego sekcja i tak działa (dociąga sama).
   */
  weather?: WeatherBrief | null;
  /** Wstępne wartości przy tworzeniu (zakres z kliknięcia w siatkę, obiekt). */
  prefill?: CalendarEventPrefill | null;
  /** Wywołane po zapisie (create/update) — rodzic odświeża dane. */
  onSaved?: (event: CalendarEvent) => void;
  /** Wywołane po usunięciu — rodzic pokazuje link "Przywróć". */
  onDeleted?: (event: CalendarEvent, scope: CalendarSeriesScope) => void;
  /**
   * Klik w pozycję kolizji — rodzic otwiera tamto wydarzenie (np. zamyka
   * ten dialog i otwiera inne). Bez propa pozycje kolizji są tylko tekstem.
   */
  onOpenEvent?: (id: number) => void;
  /**
   * Przejście kalendarza do dnia (klik we wzmiankę daty w notatce, gdy nie ma jeszcze
   * kafelka). Bez propa dialog nawiguje na `<cfg.baseHref>?date=…`.
   */
  onGoToDate?: (date: string) => void;
  /** Zmiana liczby notatek (zapis natychmiastowy, poza „Zapisz”) — rodzic aktualizuje licznik w kalendarzu. */
  onNotesChanged?: (eventId: number, count: number) => void;
  /**
   * W trybie `view`: pokazuje akcje „Edytuj / Potwierdź / Wykonane”.
   * Rodzic przełącza dialog w tryb `edit` (ten sam event).
   */
  onEdit?: () => void;
  /**
   * Powłoka formularza. `modal` (domyślnie) to okno na środku, `drawer` — panel dokowany
   * w siatce strony, który zwęża kalendarz zamiast go zasłaniać. Rodzic decyduje, kiedy
   * szuflada ma sens (dość szeroki ekran) i osadza komponent we właściwej kolumnie.
   */
  variant?: "modal" | "drawer";
  /**
   * Konfiguracja działu. Domyślnie techniczna — drugi konsument dialogu
   * (`pages/ObjectDetails.tsx`) propa nie podaje i ma działać jak przed refaktorem.
   * Wartość domyślna MUSI stać w destrukturyzacji propsów, a nie w `useMemo`,
   * inaczej referencja zmieniałaby się przy każdym renderze.
   */
  config?: CalendarConfig;
  /**
   * „Zaplanuj następną” (dział handlowy, wydarzenie wykonane): rodzic zamyka ten
   * dialog i otwiera nowy w trybie `create` z podanym prefillem. Bez propa
   * przycisk się nie pokazuje — dialog nie ma jak sam otworzyć drugiego siebie.
   */
  onPlanNext?: (prefill: CalendarEventPrefill) => void;
}

const plural = (n: number, one: string, few: string, many: string) => {
  if (n === 1) return one;
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few;
  return many;
};

// ---------------------------------------------------------------------------
// Stan formularza
// ---------------------------------------------------------------------------

interface FormState {
  type: CalendarEventType;
  title: string;
  allDay: boolean;
  /** Dla allDay: "YYYY-MM-DD" (koniec INCLUSIVE w formularzu); inaczej "YYYY-MM-DDTHH:MM". */
  start: string;
  end: string;
  status: CalendarEventStatus;
  objectId: string;
  location: string;
  description: string;
  /** Przypisani: technicy albo handlowcy — o tym, które pole API, decyduje `config`. */
  assigneeIds: number[];
  /** Dział handlowy: szansa, do której wydarzenie należy (null = wolna aktywność). */
  leadId: number | null;
  /** Dział handlowy: osoba kontaktowa (musi należeć do szansy albo jej kontrahenta). */
  contactId: number | null;
  /** Rozliczenie (null = nie dotyczy); ukryte dla urlop/biuro/przygotowanie. */
  billing: CalendarBilling | null;
  /** Jawnie przypięty protokół (null = brak / protokół realizacji wyliczany przez backend). */
  protocolId: number | null;
  /** Jawnie przypięta wycena (null = brak / wycena realizacji wyliczana przez backend). */
  quoteId: number | null;
  /** Powiązana realizacja (null = brak / do utworzenia automatem). */
  realizationId: number | null;
  /** `true` = realizacja ręcznie odpięta — automat jej nie odtworzy. */
  realizationOptout: boolean;
  /** Typ `notatka`: notatka, na którą wskazuje kafelek. */
  noteId: number | null;
  // Powtarzanie (tylko create)
  recFreq: "" | CalendarSeriesFreq;
  recInterval: string;
  recMode: "until" | "count";
  recUntil: string;
  recCount: string;
}

type FieldKey = "title" | "start" | "end" | "assignees" | "recUntil" | "recCount" | "note";
type FieldErrors = Partial<Record<FieldKey, string>>;

/**
 * Jedno pytanie na całą „niezapisaną pracę”: szkic notatki i/lub zmiany w formularzu.
 * `intent` mówi, co użytkownik chciał zrobić, gdy guard wszedł mu w drogę.
 */
interface DraftPrompt {
  intent: "save" | "close" | "status";
  /** Docelowy status dla `intent === "status"` (szybkie akcje w podglądzie). */
  status?: CalendarEventStatus;
  /** Podsumowanie szkicu notatki (null = szkicu nie ma, pytamy tylko o zmiany formularza). */
  note: { text: boolean; files: number } | null;
  /** Czy formularz ma niezapisane zmiany (istotne tylko przy zamykaniu). */
  dirty: boolean;
}

/** Domyślny czas trwania nowego wydarzenia (minuty). */
const DEFAULT_DURATION_MIN = 180;

/** Domyślny zakres: najbliższa pełna godzina, 3h (typowy wyjazd na obiekt). */
function defaultRange(): { start: string; end: string } {
  const s = new Date();
  s.setMinutes(0, 0, 0);
  s.setHours(s.getHours() + 1);
  const e = new Date(s);
  e.setHours(e.getHours() + DEFAULT_DURATION_MIN / 60);
  return { start: toDateTimeStr(s), end: toDateTimeStr(e) };
}

function addDays(dateStr: string, days: number): string {
  const d = parseLocal(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function addYears(dateStr: string, years: number): string {
  const d = parseLocal(dateStr);
  d.setFullYear(d.getFullYear() + years);
  return toDateStr(d);
}

function buildInitial(
  event: CalendarEvent | null | undefined,
  prefill: CalendarEventPrefill | null | undefined,
  cfg: CalendarConfig
): FormState {
  if (event) {
    const allDay = event.allDay;
    return {
      type: event.type,
      title: event.title,
      allDay,
      start: allDay ? event.startAt.slice(0, 10) : event.startAt.slice(0, 16),
      end: allDay ? addDays(event.endAt.slice(0, 10), -1) : event.endAt.slice(0, 16),
      status: event.status,
      objectId: event.objectId ? String(event.objectId) : "",
      location: event.location ?? "",
      description: event.description ?? "",
      assigneeIds: assigneesOf(event, cfg).map((a) => a.id),
      leadId: event.leadId ?? null,
      contactId: event.contactId ?? null,
      billing: event.billing ?? null,
      protocolId: event.protocolId ?? null,
      quoteId: event.quoteId ?? null,
      realizationId: event.realizationId ?? null,
      realizationOptout: event.realizationOptout ?? false,
      noteId: event.noteId ?? null,
      recFreq: "",
      recInterval: "1",
      recMode: "until",
      recUntil: "",
      recCount: "",
    };
  }
  // Pierwszy typ z listy działu: „serwis” w technicznym, „spotkanie” w handlowym.
  const prefillType = prefill?.type ?? cfg.typeOrder[0] ?? "serwis";
  const isNote = prefillType === "notatka";
  const allDay = prefillType === "urlop" || isNote ? true : (prefill?.allDay ?? false);
  const def = defaultRange();
  let start = prefill?.startAt ?? def.start;
  let end = prefill?.endAt ?? def.end;
  if (allDay) {
    start = start.slice(0, 10);
    // Kafelek notatki jest zawsze jednodniowy — zaznaczenie zakresu w siatce ignorujemy.
    end = isNote ? start : prefill?.endAt ? addDays(end.slice(0, 10), -1) : start;
  } else {
    if (start.length === 10) start = `${start}T08:00`;
    if (end.length === 10) end = `${end}T11:00`;
  }
  const isKons = prefillType === "konserwacja";
  return {
    type: prefillType,
    title: prefill?.title ?? "",
    allDay,
    start,
    end,
    status: prefill?.status ?? "planned",
    objectId: prefill?.objectId ? String(prefill.objectId) : "",
    location: prefill?.location ?? "",
    description: prefill?.description ?? "",
    assigneeIds: [...(prefill?.assigneeIds ?? prefill?.technicianIds ?? [])],
    leadId: prefill?.leadId ?? null,
    contactId: prefill?.contactId ?? null,
    billing: null,
    protocolId: null,
    quoteId: null,
    realizationId: null,
    realizationOptout: false,
    noteId: null,
    recFreq: isKons ? "quarterly" : "",
    recInterval: "1",
    recMode: "until",
    recUntil: isKons ? addYears(start.slice(0, 10), 2) : "",
    recCount: "",
  };
}

/**
 * Konwersja stanu formularza → payload API (all-day: koniec exclusive).
 *
 * `department` idzie w KAŻDYM zapisie, także technicznym: backend domyśla się
 * `technical`, więc `PUT` bez tego pola na wydarzeniu handlowym wyglądałby jak
 * próba zmiany działu i skończyłby się błędem 400.
 */
function toInput(f: FormState, cfg: CalendarConfig): CalendarEventInput {
  // Kafelek notatki: zawsze jeden dzień, bez przypisanych, obiektu i dokumentów.
  if (isNoteEvent(f.type)) {
    const day = f.start.slice(0, 10);
    return {
      type: f.type,
      title: f.title.trim() || "Notatka",
      description: null,
      location: null,
      startAt: day,
      endAt: addDays(day, 1),
      allDay: true,
      status: f.status,
      objectId: null,
      department: cfg.department,
      // `technicianIds` jest w kontrakcie API wymagane; dla działu handlowego
      // zostaje puste, a most dokłada właściwe pole z identyfikatorami.
      technicianIds: [],
      ...assigneeIdsInput([], cfg),
      billing: null,
      protocolId: null,
      quoteId: null,
      realizationId: null,
      realizationOptout: false,
      noteId: f.noteId,
      ...(cfg.features.leadPicker ? { leadId: f.leadId, contactId: f.contactId } : {}),
    };
  }
  const startAt = f.allDay ? f.start.slice(0, 10) : f.start;
  const endAt = f.allDay ? addDays(f.end.slice(0, 10) || startAt, 1) : f.end;
  const isUrlop = f.type === "urlop";
  const input: CalendarEventInput = {
    type: f.type,
    title: f.title.trim(),
    description: f.description.trim() || null,
    location: isUrlop ? null : f.location.trim() || null,
    startAt,
    endAt,
    allDay: f.allDay,
    status: f.status,
    objectId: !isUrlop && f.objectId ? Number(f.objectId) : null,
    department: cfg.department,
    technicianIds: [],
    ...assigneeIdsInput(f.assigneeIds, cfg),
    // Dokumenty techniczne (rozliczenie, protokół, wycena, realizacja) nie istnieją
    // w dziale handlowym — flagi decydują, czy pola w ogóle wyjeżdżają na serwer.
    billing: cfg.features.billing && billingApplies(f.type) ? f.billing : null,
    protocolId: cfg.features.protocol && billingApplies(f.type) ? f.protocolId : null,
    quoteId: cfg.features.quote && billingApplies(f.type) ? f.quoteId : null,
    realizationId: cfg.features.realization && realizationApplies(f.type) ? f.realizationId : null,
    realizationOptout: cfg.features.realization && realizationApplies(f.type) ? f.realizationOptout : false,
    ...(cfg.features.leadPicker ? { leadId: f.leadId, contactId: f.contactId } : {}),
  };
  if (f.recFreq && !isUrlop) {
    input.recurrence = {
      freq: f.recFreq,
      interval: Math.max(1, Number(f.recInterval) || 1),
      until: f.recMode === "until" && f.recUntil ? f.recUntil : null,
      count: f.recMode === "count" && f.recCount ? Number(f.recCount) : null,
    };
  }
  return input;
}

/** Lokalny podgląd wystąpień serii (ta sama reguła co backend: +N mies. / +N tyg., maks. 200). */
function previewOccurrences(f: FormState): string[] {
  if (!f.recFreq || !f.start) return [];
  const meta = SERIES_FREQ_META[f.recFreq];
  const interval = Math.max(1, Number(f.recInterval) || 1);
  const until = f.recMode === "until" && f.recUntil ? parseLocal(f.recUntil).getTime() : null;
  const count = f.recMode === "count" ? Number(f.recCount) || 0 : 200;
  const base = parseLocal(f.start);
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, 200); i++) {
    const d = new Date(base);
    if (meta.months > 0) d.setMonth(base.getMonth() + meta.months * interval * i);
    else d.setDate(base.getDate() + 7 * interval * i);
    if (until != null && d.getTime() > until + 86_399_000) break;
    out.push(toDateStr(d));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drobne komponenty
// ---------------------------------------------------------------------------

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase text-muted-foreground",
        className
      )}
    >
      {initials(name)}
    </span>
  );
}

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-1 text-xs text-destructive">
      <AlertTriangle className="h-3 w-3 shrink-0" /> {msg}
    </p>
  );
}

/** Sekcja formularza z nagłówkiem; opcjonalnie zwijana (akordeon na mobile / „Więcej opcji”). */
function Section({
  icon: Icon,
  title,
  summary,
  open,
  onToggle,
  children,
  id,
  keepMounted,
}: {
  icon: typeof Clock;
  title: string;
  /** Krótkie podsumowanie przy zwiniętej sekcji (np. nazwa obiektu). */
  summary?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
  id: string;
  /**
   * Zwinięcie tylko ukrywa treść (`hidden`) zamiast ją odmontowywać — sekcja notatek
   * musi przeżyć zwinięcie ze szkicem (tekst, wybrane pliki) i zachować `ref` dla
   * guardów zapisu/zamknięcia.
   */
  keepMounted?: boolean;
}) {
  const collapsible = typeof open === "boolean" && !!onToggle;
  const head = (
    <span className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {title}
      {collapsible && !open && summary && (
        <span className="ml-1 truncate font-normal normal-case tracking-normal text-foreground/80">
          — {summary}
        </span>
      )}
    </span>
  );
  return (
    <section aria-labelledby={`${id}-h`} className="border-t pt-3 first:border-t-0 first:pt-0">
      {collapsible ? (
        <button
          type="button"
          id={`${id}-h`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={onToggle}
          className="-mx-1 flex w-[calc(100%+0.5rem)] items-center justify-between rounded px-1 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {head}
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>
      ) : (
        <div id={`${id}-h`} className="py-1">
          {head}
        </div>
      )}
      {(!collapsible || open || keepMounted) && (
        <div id={`${id}-body`} hidden={collapsible && !open} className="mt-2 space-y-3">
          {children}
        </div>
      )}
    </section>
  );
}

/** Wyszukiwarka obiektów (lista z filtrem zamiast <select>). */
function ObjectPicker({
  objects,
  value,
  onChange,
  fallbackName,
  inputId,
}: {
  objects: ObjectWithContractor[];
  value: string;
  onChange: (id: string) => void;
  fallbackName?: string | null;
  inputId: string;
}) {
  const [q, setQ] = useState("");
  const [openList, setOpenList] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = objects.find((o) => String(o.id) === value);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? objects.filter((o) =>
          `${o.name} ${o.city ?? ""} ${o.address ?? ""} ${o.contractor?.name ?? ""}`
            .toLowerCase()
            .includes(s)
        )
      : objects;
    return list.slice(0, 8);
  }, [objects, q]);

  useEffect(() => {
    if (!openList) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openList]);

  if (value) {
    const name = selected?.name ?? fallbackName ?? `Obiekt #${value}`;
    const sub = selected
      ? [selected.address, selected.city].filter(Boolean).join(", ") ||
        selected.contractor?.name
      : null;
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm">
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{name}</div>
          {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
        </div>
        <button
          type="button"
          aria-label="Usuń powiązanie z obiektem"
          {...tip("Odepnij obiekt — wydarzenie zostanie bez powiązania")}
          onClick={() => {
            onChange("");
            setQ("");
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={openList}
        aria-controls={`${inputId}-list`}
        aria-autocomplete="list"
        value={q}
        placeholder={objects.length ? `Szukaj wśród ${objects.length} obiektów…` : "Brak obiektów"}
        className="pl-8"
        onFocus={() => setOpenList(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpenList(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && openList && results[active]) {
            e.preventDefault();
            onChange(String(results[active].id));
            setOpenList(false);
          } else if (e.key === "Escape" && openList) {
            e.stopPropagation();
            setOpenList(false);
          }
        }}
      />
      {openList && (
        <ul
          id={`${inputId}-list`}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {results.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">Brak wyników.</li>
          ) : (
            results.map((o, i) => (
              <li
                key={o.id}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(String(o.id));
                  setOpenList(false);
                }}
                className={cn(
                  "cursor-pointer rounded px-2 py-1.5",
                  i === active && "bg-accent text-accent-foreground"
                )}
              >
                <div className="truncate font-medium">{o.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[o.address, o.city].filter(Boolean).join(", ") || o.contractor?.name || "—"}
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Skrót protokołu z pełnego rekordu (lista /protocols) → podgląd w dialogu. */
function toEventProtocol(p: Protocol): CalendarEventProtocol {
  return { id: p.id, number: p.number, status: p.status, signedAt: p.signedAt ?? null, workDate: p.workDate };
}

/** Wybór protokołu z listy (szukajka z debounce ~250 ms; bez filtra — ostatnie 50). */
function ProtocolPicker({ onPick, disabled }: { onPick: (p: Protocol) => void; disabled?: boolean }) {
  const [openList, setOpenList] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Protocol[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!openList) return;
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      getProtocols(undefined, undefined, { q: q.trim() || undefined, limit: 50 })
        .then((res) => {
          if (cancelled) return;
          setItems(res.data || []);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setItems([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [openList, q]);

  useEffect(() => {
    if (!openList) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openList]);

  const pick = (p: Protocol) => {
    onPick(p);
    setOpenList(false);
    setQ("");
  };

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-expanded={openList}
        aria-controls="cal-protocol-list"
        data-testid="protocol-pick"
        onClick={() => setOpenList((v) => !v)}
      >
        <FileCheck2 className="mr-1 h-4 w-4" /> Wybierz protokół…
      </Button>
      {openList && (
        <div className="absolute left-0 z-20 mt-1 w-full min-w-[20rem] max-w-[28rem] rounded-md border bg-popover p-1.5 text-sm shadow-md sm:w-[26rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              role="combobox"
              aria-expanded={openList}
              aria-controls="cal-protocol-list"
              aria-autocomplete="list"
              aria-label="Szukaj protokołu"
              data-testid="protocol-search"
              value={q}
              placeholder="Numer, klient, obiekt…"
              className="h-9 pl-8"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, items.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter" && items[active]) {
                  e.preventDefault();
                  pick(items[active]);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpenList(false);
                }
              }}
            />
          </div>
          <ul id="cal-protocol-list" role="listbox" className="mt-1 max-h-64 overflow-y-auto">
            {loading && items.length === 0 ? (
              <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Szukam…
              </li>
            ) : items.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">Brak protokołów.</li>
            ) : (
              items.map((p, i) => {
                const kind = p.status === "final" || p.signedAt ? "final" : "draft";
                return (
                  <li
                    key={p.id}
                    role="option"
                    aria-selected={i === active}
                    data-testid={`protocol-option-${p.id}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(p);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5",
                      i === active && "bg-accent text-accent-foreground"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium tabular-nums">{p.number}</span>
                        <span className="text-xs text-muted-foreground">{fmtLong(p.workDate, true)}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[p.clientName, p.site ?? p.clientCity].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                    <span className={cn(protocolBadgeClass(kind), "shrink-0")}>
                      {kind === "final" ? "podpisany" : "szkic"}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Pełny rekord realizacji (`/realizations`) → skrót używany w dialogu. */
function toEventRealization(r: Realization): CalendarEventRealization {
  return { id: r.id, date: r.date, site: r.site, kind: r.kind, invoiced: r.invoiced, total: r.total };
}

/**
 * Wybór istniejącej realizacji: lista miesiąca (strzałki ← →, start z daty
 * wydarzenia) + filtr tekstowy po obiekcie/adnotacji. Backend realizacji nie ma
 * wyszukiwarki globalnej, więc szukamy w obrębie miesiąca.
 */
function RealizationPicker({
  dateHint,
  siteHint,
  onPick,
  disabled,
}: {
  dateHint: string;
  siteHint?: string;
  onPick: (r: Realization) => void;
  disabled?: boolean;
}) {
  const hint = /^\d{4}-\d{2}/.test(dateHint) ? dateHint : toDateStr(new Date());
  const [openList, setOpenList] = useState(false);
  const [ym, setYm] = useState<{ y: number; m: number }>(() => ({
    y: Number(hint.slice(0, 4)),
    m: Number(hint.slice(5, 7)),
  }));
  const [q, setQ] = useState("");
  /** Wynik ostatniego pobrania wraz z kluczem miesiąca — `loading` jest z niego wyliczane. */
  const [loaded, setLoaded] = useState<{ key: string; items: Realization[] } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const monthKey = `${ym.y}-${ym.m}`;
  const items = loaded?.key === monthKey ? loaded.items : [];
  const loading = loaded?.key !== monthKey;

  useEffect(() => {
    if (!openList) return;
    let cancelled = false;
    const key = `${ym.y}-${ym.m}`;
    getRealizations(ym.y, ym.m)
      .then((res) => {
        if (!cancelled) setLoaded({ key, items: res.data || [] });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [openList, ym]);

  useEffect(() => {
    if (!openList) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openList]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? items.filter((r) => `${r.site} ${r.note ?? ""}`.toLowerCase().includes(needle))
    : items;
  const shiftMonth = (d: number) =>
    setYm(({ y, m }) => {
      const n = m + d;
      if (n < 1) return { y: y - 1, m: 12 };
      if (n > 12) return { y: y + 1, m: 1 };
      return { y, m: n };
    });

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-expanded={openList}
        aria-controls="cal-realization-list"
        data-testid="realization-pick"
        onClick={() =>
          setOpenList((v) => {
            if (!v) setQ(siteHint?.trim() ?? "");
            return !v;
          })
        }
      >
        <Receipt className="mr-1 h-4 w-4" /> Podepnij istniejącą…
      </Button>
      {openList && (
        <div className="absolute left-0 z-20 mt-1 w-full min-w-[20rem] max-w-[28rem] rounded-md border bg-popover p-1.5 text-sm shadow-md sm:w-[26rem]">
          <div className="mb-1 flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="Poprzedni miesiąc" {...tip("Poprzedni miesiąc na liście realizacji")} onClick={() => shiftMonth(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="flex-1 text-center text-xs font-medium tabular-nums" data-testid="realization-pick-month">
              {String(ym.m).padStart(2, "0")}.{ym.y}
            </span>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="Następny miesiąc" {...tip("Następny miesiąc na liście realizacji")} onClick={() => shiftMonth(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              aria-label="Szukaj realizacji"
              data-testid="realization-search"
              value={q}
              placeholder="Obiekt, adnotacja…"
              className="h-9 pl-8"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpenList(false);
                }
              }}
            />
          </div>
          <ul id="cal-realization-list" role="listbox" className="mt-1 max-h-64 overflow-y-auto">
            {loading ? (
              <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Szukam…
              </li>
            ) : filtered.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">Brak realizacji w tym miesiącu.</li>
            ) : (
              filtered.map((r) => (
                <li
                  key={r.id}
                  role="option"
                  aria-selected={false}
                  data-testid={`realization-option-${r.id}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(r);
                    setOpenList(false);
                    setQ("");
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent hover:text-accent-foreground"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{r.site || `Realizacja #${r.id}`}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{fmtLong(r.date, true)}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {REALIZATION_KIND_LABEL[r.kind] ?? r.kind} · {realizationMoney(r.total)}
                    </div>
                  </div>
                  <span className={cn(realizationBadgeClass(r.invoiced ? "invoiced" : "open"), "shrink-0")}>
                    {r.invoiced ? "zafakturowana" : "otwarta"}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Pełny rekord wyceny (`/quotes`) → skrót używany w dialogu. */
function toEventQuote(q: Quote): CalendarEventQuote {
  const filledItems = q.items.filter((i) => {
    const n = parseFloat(String(i.qty).replace(",", "."));
    return Number.isFinite(n) && n > 0;
  }).length;
  return { id: q.id, number: q.number, date: q.date, total: q.total, filledItems };
}

/** Wybór wyceny z listy (szukajka z debounce ~250 ms; bez filtra — ostatnie 50). */
function QuotePicker({ onPick, disabled }: { onPick: (q: Quote) => void; disabled?: boolean }) {
  const [openList, setOpenList] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!openList) return;
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      getQuotes(undefined, undefined, { q: q.trim() || undefined, limit: 50 })
        .then((res) => {
          if (cancelled) return;
          setItems(res.data || []);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setItems([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [openList, q]);

  useEffect(() => {
    if (!openList) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openList]);

  const pick = (item: Quote) => {
    onPick(item);
    setOpenList(false);
    setQ("");
  };

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-expanded={openList}
        aria-controls="cal-quote-list"
        data-testid="quote-pick"
        onClick={() => setOpenList((v) => !v)}
      >
        <Calculator className="mr-1 h-4 w-4" /> Wybierz wycenę…
      </Button>
      {openList && (
        <div className="absolute left-0 z-20 mt-1 w-full min-w-[20rem] max-w-[28rem] rounded-md border bg-popover p-1.5 text-sm shadow-md sm:w-[26rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              role="combobox"
              aria-expanded={openList}
              aria-controls="cal-quote-list"
              aria-autocomplete="list"
              aria-label="Szukaj wyceny"
              data-testid="quote-search"
              value={q}
              placeholder="Numer, obiekt, adres…"
              className="h-9 pl-8"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, items.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter" && items[active]) {
                  e.preventDefault();
                  pick(items[active]);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpenList(false);
                }
              }}
            />
          </div>
          <ul id="cal-quote-list" role="listbox" className="mt-1 max-h-64 overflow-y-auto">
            {loading && items.length === 0 ? (
              <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Szukam…
              </li>
            ) : items.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">Brak wycen.</li>
            ) : (
              items.map((item, i) => {
                const ref = toEventQuote(item);
                const kind = ref.filledItems > 0 ? "filled" : "draft";
                return (
                  <li
                    key={item.id}
                    role="option"
                    aria-selected={i === active}
                    data-testid={`quote-option-${item.id}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(item);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5",
                      i === active && "bg-accent text-accent-foreground"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium tabular-nums">{item.number}</span>
                        <span className="text-xs text-muted-foreground">{fmtLong(item.date, true)}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[item.site, item.address].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                    <span className={cn(quoteBadgeClass(kind), "shrink-0 tabular-nums")}>
                      {realizationMoney(item.total)}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notatka jako wydarzenie (typ `notatka`)
// ---------------------------------------------------------------------------

/** Jedna linia opisu notatki: „Serwis kamer — 12.09.2026 · Jan Kowalski”. */
function noteMetaLine(n: CalendarNoteRef): string {
  return [
    `${eventTypeLabel(n.eventType)}: ${n.eventTitle}`,
    fmtLong(n.eventStartAt, n.eventStartAt.length <= 10),
    n.userLabel || null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Wyszukiwarka notatek (GET /calendar/notes/search) — wybór notatki dla kafelka. */
function NotePicker({
  value,
  onPick,
  onClear,
  inputId,
  invalid,
}: {
  value: CalendarNoteRef | null;
  onPick: (n: CalendarNoteRef) => void;
  onClear: () => void;
  inputId: string;
  invalid?: boolean;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<CalendarNoteRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const hasValue = !!value;

  useEffect(() => {
    if (hasValue) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      setLoading(true);
      calendarApi
        .searchNotes(q.trim() || undefined, 20)
        .then((res) => {
          if (cancelled) return;
          setItems(res.data ?? []);
          setActive(0);
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setItems([]);
          setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, hasValue]);

  if (value) {
    return (
      <div
        className="flex flex-wrap items-start gap-2 rounded-md border bg-muted/40 px-2.5 py-2 text-sm"
        data-testid="note-picked"
        data-note-id={value.id}
      >
        <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap break-words">
            {noteSnippet(value.text, 200) || <span className="text-muted-foreground">notatka bez treści (sam załącznik)</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{noteMetaLine(value)}</div>
          {value.attachmentsCount > 0 && (
            <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Paperclip className="h-3 w-3" aria-hidden />
              {pluralPl(value.attachmentsCount, "załącznik", "załączniki", "załączników")}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Wybierz inną notatkę"
          {...tip("Odepnij notatkę — wybierzesz inną z listy")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="note-clear"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          value={q}
          placeholder="Szukaj w treści notatek i tytułach wydarzeń…"
          className={cn("pl-8", invalid && "border-destructive focus-visible:ring-destructive")}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && items[active]) {
              e.preventDefault();
              onPick(items[active]);
            }
          }}
          data-testid="note-search"
        />
      </div>
      <ul
        role="listbox"
        aria-label="Notatki"
        className="max-h-64 overflow-y-auto rounded-md border p-1 text-sm"
        data-testid="note-search-results"
      >
        {loading && items.length === 0 ? (
          <li className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Szukam notatek…
          </li>
        ) : failed ? (
          <li className="px-2 py-1.5 text-xs text-destructive">Nie udało się pobrać notatek.</li>
        ) : items.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            {q.trim() ? "Brak notatek pasujących do zapytania." : "Brak notatek — dopisz je najpierw w wydarzeniu."}
          </li>
        ) : (
          items.map((n, i) => (
            <li
              key={n.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(n);
              }}
              className={cn(
                "cursor-pointer rounded px-2 py-1.5",
                i === active && "bg-accent text-accent-foreground"
              )}
              data-testid="note-search-item"
              data-note-id={n.id}
            >
              <div className="line-clamp-2 break-words">
                {noteSnippet(n.text, 160) || <span className="text-muted-foreground">notatka bez treści</span>}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <span className="truncate">{noteMetaLine(n)}</span>
                {n.attachmentsCount > 0 && <Paperclip className="h-3 w-3 shrink-0" aria-hidden />}
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** Podgląd notatki źródłowej kafelka `notatka` (readonly) z załącznikami i linkiem do wydarzenia. */
function SourceNoteCard({
  note,
  onOpenSource,
}: {
  note: CalendarNoteRef;
  onOpenSource?: () => void;
}) {
  // Skrót notatki nie niesie plików — dociągamy je z wydarzenia źródłowego (tylko do odczytu).
  const [loaded, setLoaded] = useState<{ noteId: number; list: CalendarNoteAttachment[] } | null>(null);
  useEffect(() => {
    if (!note.attachmentsCount) return;
    let cancelled = false;
    calendarApi
      .notes(note.eventId)
      .then((res) => {
        if (cancelled) return;
        setLoaded({ noteId: note.id, list: (res.data ?? []).find((n) => n.id === note.id)?.attachments ?? [] });
      })
      .catch(() => {
        /* bez załączników — sama treść notatki wystarczy */
      });
    return () => {
      cancelled = true;
    };
  }, [note.id, note.eventId, note.attachmentsCount]);
  const attachments = loaded?.noteId === note.id ? loaded.list : [];

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 px-2.5 py-2 text-sm" data-testid="source-note">
      <div className="flex items-start gap-2">
        <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap break-words" data-testid="source-note-text">
            {note.text?.trim() || <span className="text-muted-foreground">notatka bez treści (sam załącznik)</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{noteMetaLine(note)}</div>
        </div>
      </div>
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Załączniki notatki" data-testid="source-note-attachments">
          {attachments.map((a) =>
            a.kind === "image" ? (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noopener noreferrer" title={a.fileName}>
                  <img
                    src={a.url}
                    alt={a.fileName}
                    loading="lazy"
                    className="h-20 w-20 rounded-md border object-cover"
                  />
                </a>
              </li>
            ) : (
              <li key={a.id} className="flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 items-center gap-1.5 hover:underline"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{a.fileName}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                </a>
              </li>
            )
          )}
        </ul>
      )}
      {onOpenSource && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          onClick={onOpenSource}
          data-testid="source-note-open-event"
        >
          <ExternalLink className="mr-1 h-3.5 w-3.5" /> Otwórz wydarzenie źródłowe
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Historia (oś czasu)
// — agregacja wpisów z jednej operacji, grupowanie po dniu
// ---------------------------------------------------------------------------

interface HistoryGroup {
  key: string;
  at: string;
  user: string;
  action: string;
  entries: ActivityEntry[];
}

function groupHistory(entries: ActivityEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    const sameOp =
      last &&
      last.at === e.createdAt &&
      last.user === (e.userLabel ?? "") &&
      last.action === "updated" &&
      e.action === "updated";
    if (sameOp) last.entries.push(e);
    else
      groups.push({
        key: `g-${e.id}`,
        at: e.createdAt,
        user: e.userLabel ?? "",
        action: e.action,
        entries: [e],
      });
  }
  return groups;
}

const fieldVal = (field: string | null, v: string | null): string => {
  if (v == null || v === "") return "(puste)";
  switch (field) {
    case "type":
      return eventTypeLabel(v);
    case "status":
      return eventStatusLabel(v);
    case "start_at":
    case "startAt":
    case "end_at":
    case "endAt":
      return fmtShort(v);
    case "all_day":
    case "allDay":
      return v === "1" || v === "true" ? "tak" : "nie";
    default:
      return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  }
};

function HistoryTimeline({ entries }: { entries: ActivityEntry[] }) {
  const [limit, setLimit] = useState(10);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupHistory(entries), [entries]);
  const visible = groups.slice(0, limit);

  // Nagłówki dnia
  let lastDay = "";
  return (
    <div className="space-y-1">
      {visible.map((g) => {
        const day = fmtTimestamp(g.at).slice(0, 10);
        const showDay = day !== lastDay;
        lastDay = day;
        const first = g.entries[0];
        const Icon = activityIcon(g.action);
        const who = g.user || "System";
        const multi = g.entries.length > 1;
        const isOpen = !!expanded[g.key];
        return (
          <div key={g.key}>
            {showDay && (
              <div className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
                {day}
              </div>
            )}
            <div className="flex gap-2.5 py-1">
              <div className="flex flex-col items-center">
                <Avatar name={who} />
                <div className="mt-1 w-px flex-1 bg-border" />
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {multi ? (
                        <span>
                          <span className="font-medium">{who}</span> zmienił(a){" "}
                          {g.entries.length}{" "}
                          {plural(g.entries.length, "pole", "pola", "pól")}
                        </span>
                      ) : (
                        <span>{describeActivity(first)}</span>
                      )}
                    </span>
                    {multi && (
                      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {(isOpen ? g.entries : g.entries.slice(0, 3)).map((e) => (
                          <li key={e.id}>
                            <span className="text-foreground/80">
                              {e.field ? ACTIVITY_FIELD_LABELS[e.field] ?? e.field : "pole"}
                            </span>
                            : {fieldVal(e.field, e.oldValue)} → {fieldVal(e.field, e.newValue)}
                          </li>
                        ))}
                        {g.entries.length > 3 && (
                          <li>
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={() =>
                                setExpanded((m) => ({ ...m, [g.key]: !isOpen }))
                              }
                            >
                              {isOpen ? "Zwiń" : `Pokaż wszystkie (${g.entries.length})`}
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                  <time
                    dateTime={g.at}
                    {...tip(fmtTimestamp(g.at))}
                    className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                  >
                    {fmtRelative(g.at)}
                  </time>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      {groups.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + 20)}
          className="w-full rounded-md border border-dashed py-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          Pokaż więcej ({groups.length - limit})
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sekcja „Kiedy” — helpery daty/czasu i pole godziny (combobox z krokiem 15 min)
// ---------------------------------------------------------------------------

const dateOf = (v: string) => v.slice(0, 10);
const timeOf = (v: string) => (v.length >= 16 ? v.slice(11, 16) : "");

function addMinutes(v: string, minutes: number): string {
  const d = parseLocal(v);
  d.setMinutes(d.getMinutes() + minutes);
  return toDateTimeStr(d);
}

function diffMinutes(a: string, b: string): number {
  return Math.round((parseLocal(b).getTime() - parseLocal(a).getTime()) / 60_000);
}

function diffDays(a: string, b: string): number {
  return Math.round((parseLocal(dateOf(b)).getTime() - parseLocal(dateOf(a)).getTime()) / 86_400_000);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Wszystkie kwadranse doby: "00:00" … "23:45". */
const TIME_OPTIONS: string[] = Array.from({ length: 96 }, (_, i) =>
  `${pad2(Math.floor(i / 4))}:${pad2((i % 4) * 15)}`
);

/** Luźne parsowanie wpisu: „9”, „9:30”, „9.30”, „930”, „0930”, „14 15” → „HH:MM” lub null. */
function parseTimeInput(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, "");
  if (!s) return null;
  let h: number;
  let m = 0;
  const sep = /^(\d{1,2})[:.,h](\d{1,2})$/.exec(s);
  if (sep) {
    h = Number(sep[1]);
    m = Number(sep[2]);
    if (sep[2].length === 1) m *= 10;
  } else if (/^\d{1,2}$/.test(s)) {
    h = Number(s);
  } else if (/^\d{3,4}$/.test(s)) {
    h = Number(s.slice(0, s.length - 2));
    m = Number(s.slice(-2));
  } else return null;
  if (h === 24 && m === 0) h = 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

const timeToMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Chipy czasu trwania: same liczby, wspólne „godz." raz za grupą (patrz `suffix`
 * w DurationChips) — inaczej jednostka powtarza się dziewięć razy i zjada wiersz.
 */
const HOURS_DURATIONS = [
  { label: "30 min", minutes: 30 },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ label: String(h), minutes: h * 60 })),
];
const DAY_DURATIONS = [
  { label: "1 dzień", days: 1 },
  { label: "2 dni", days: 2 },
  { label: "tydzień", days: 7 },
];

/** Czy ekran „mobilny” (poniżej sm) — wtedy natywne pola czasu. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 639px)").matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

/**
 * Pole godziny: na desktopie combobox (wpisz ręcznie albo wybierz z listy co 15 min),
 * na mobile natywny <input type="time">. `durationFrom` = godzina początku — lista
 * pokazuje wtedy czas trwania przy każdej pozycji („10:00 (2 godz.)”).
 */
function TimeField({
  id,
  value,
  onChange,
  mobile,
  durationFrom,
  invalid,
  describedBy,
  label,
  className,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  mobile: boolean;
  durationFrom?: string;
  invalid?: boolean;
  describedBy?: string;
  label: string;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [openList, setOpenList] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focused = useRef(false);

  // Synchronizacja tekstu z wartością, gdy zmiana przyszła z zewnątrz (chipy, data).
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  const commit = (raw: string) => {
    const t = parseTimeInput(raw);
    if (t) {
      if (t !== value) onChange(t);
      setText(t);
    } else setText(value);
  };

  // Lista: od godziny początku (dla „do”) albo cała doba (dla „od”).
  const options = useMemo(() => {
    if (!durationFrom) return TIME_OPTIONS.map((t) => ({ t, hint: "" }));
    const from = timeToMin(durationFrom);
    const startIdx = TIME_OPTIONS.findIndex((t) => timeToMin(t) > from);
    const ordered =
      startIdx === -1
        ? TIME_OPTIONS
        : [...TIME_OPTIONS.slice(startIdx), ...TIME_OPTIONS.slice(0, startIdx)];
    return ordered.map((t) => {
      let m = timeToMin(t) - from;
      if (m <= 0) m += 1440;
      return { t, hint: fmtMinutes(m) };
    });
  }, [durationFrom]);

  const openWith = () => {
    const idx = Math.max(
      0,
      options.findIndex((o) => o.t === value)
    );
    setActive(idx === -1 ? 0 : idx);
    setOpenList(true);
  };

  useEffect(() => {
    if (!openList) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [openList, active]);

  useEffect(() => {
    if (!openList) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openList]);

  if (mobile) {
    return (
      <Input
        id={id}
        type="time"
        step={900}
        value={value}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn("w-auto tabular-nums", invalid && "border-destructive", className)}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
      />
    );
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <Input
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={openList}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        inputMode="numeric"
        autoComplete="off"
        value={text}
        placeholder="HH:MM"
        className={cn("w-[5.75rem] pr-6 tabular-nums", invalid && "border-destructive")}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
          openWith();
        }}
        onBlur={() => {
          focused.current = false;
          setOpenList(false);
          commit(text);
        }}
        onChange={(e) => {
          setText(e.target.value);
          const t = parseTimeInput(e.target.value);
          if (t) {
            const idx = options.findIndex((o) => timeToMin(o.t) >= timeToMin(t));
            if (idx >= 0) setActive(idx);
          }
          if (!openList) setOpenList(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!openList) openWith();
            else setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const typed = parseTimeInput(text);
            const pick = openList && typed === null ? options[active]?.t : typed;
            commit(pick ?? text);
            setOpenList(false);
          } else if (e.key === "Escape" && openList) {
            e.stopPropagation();
            setOpenList(false);
          } else if (e.key === "Tab") {
            setOpenList(false);
          }
        }}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
      />
      {openList && (
        <ul
          id={`${id}-list`}
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-1 max-h-52 w-max min-w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {options.map((o, i) => (
            <li
              key={o.t}
              role="option"
              aria-selected={o.t === value}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(o.t);
                setOpenList(false);
              }}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 rounded px-2 py-1 tabular-nums",
                i === active && "bg-accent text-accent-foreground",
                o.t === value && i !== active && "font-medium"
              )}
            >
              {o.t}
              {o.hint && <span className="text-xs text-muted-foreground">({o.hint})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Chipy szybkiego czasu trwania (aktywny = aktualny czas trwania). */
function DurationChips<T extends { label: string }>({
  items,
  isActive,
  onPick,
  ariaLabel,
  suffix,
}: {
  items: T[];
  isActive: (item: T) => boolean;
  onPick: (item: T) => void;
  ariaLabel: string;
  /** Wspólna jednostka pokazana raz, za chipami (np. „godz."). */
  suffix?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1">
      {items.map((it) => {
        const active = isActive(it);
        return (
          <button
            key={it.label}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(it)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {it.label}
          </button>
        );
      })}
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** Mały przełącznik (checkbox z etykietą) używany w wierszu „Kiedy”. */
function ToggleChip({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer select-none items-center gap-1.5 text-xs">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <span>{children}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function CalendarEventDialog({
  open,
  onClose,
  mode,
  event,
  weather,
  prefill,
  onSaved,
  onDeleted,
  onOpenEvent,
  onGoToDate,
  onEdit,
  onNotesChanged,
  variant = "modal",
  config: cfg = TECHNICAL_CALENDAR,
  onPlanNext,
}: CalendarEventDialogProps) {
  const docked = variant === "drawer";
  const readOnly = mode === "view";
  const isEdit = mode === "edit" && !!event;
  const navigate = useNavigate();
  /** Notatki z GET /calendar/events/:id; null = jeszcze nie wczytane (komponent notatek sam dociągnie). */
  const [notes, setNotes] = useState<CalendarNote[] | null>(null);
  const [notesCount, setNotesCount] = useState<number>(event?.notesCount ?? 0);
  /** Tryb create: „Pierwsza notatka” wysyłana po utworzeniu wydarzenia. */
  const [firstNote, setFirstNote] = useState("");
  const handleNotesCount = useCallback(
    (count: number) => {
      setNotesCount(count);
      if (!event) return;
      onNotesChanged?.(event.id, count);
      // Historia w dialogu: dopisy note_added/… pojawiają się od razu.
      calendarApi
        .getEvent(event.id)
        .then((res) => setHistory(res.data?.history || []))
        .catch(() => {
          /* historia odświeży się przy kolejnym otwarciu */
        });
    },
    [event, onNotesChanged]
  );

  const initialRef = useRef<FormState>(buildInitial(event, prefill, cfg));
  const [form, setForm] = useState<FormState>(initialRef.current);
  /** Protokół wybrany z listy w tej sesji edycji (podgląd przed zapisem). */
  const [pickedProtocol, setPickedProtocol] = useState<CalendarEventProtocol | null>(null);
  /** Realizacja wybrana z listy w tej sesji edycji (podgląd przed zapisem). */
  const [pickedRealization, setPickedRealization] = useState<CalendarEventRealization | null>(null);
  /** Wycena wybrana z listy w tej sesji edycji (podgląd przed zapisem). */
  const [pickedQuote, setPickedQuote] = useState<CalendarEventQuote | null>(null);
  /** Notatka wybrana z wyszukiwarki (typ `notatka`) — podgląd przed zapisem. */
  const [pickedNote, setPickedNote] = useState<CalendarNoteRef | null>(event?.sourceNote ?? null);
  /** Technicy albo handlowcy — kto, decyduje `cfg.assignees.load()`. */
  const [assignees, setAssignees] = useState<AssigneeRef[]>([]);
  /** Dział handlowy: szansa wybrana w tej sesji (podgląd zanim zapis wróci). */
  const [pickedLead, setPickedLead] = useState<Lead | null>(null);
  /** Osoby kontaktowe szansy i jej kontrahenta (zawężone przez `LeadPicker`). */
  const [leadContacts, setLeadContacts] = useState<Contact[]>([]);
  const [objects, setObjects] = useState<ObjectWithContractor[]>([]);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [conflicts, setConflicts] = useState<CalendarConflict[]>([]);
  const [availability, setAvailability] = useState<CalendarAvailability[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [quickStatusBusy, setQuickStatusBusy] = useState<CalendarEventStatus | null>(null);

  // Sekcje „Więcej opcji”: przy tworzeniu zwinięte, przy edycji otwarte gdy mają wartość.
  const init = initialRef.current;
  const [openSec, setOpenSec] = useState({
    // Sekcja stoi tuż pod tytułem i statusem, więc trzymanie jej zwiniętej przy
    // tworzeniu chowałoby pierwszą decyzję planującego (który obiekt).
    where: true,
    repeat: mode === "create" && !!init.recFreq,
    notes: mode !== "create" || !!init.description,
    protocol: mode !== "create" && !!(init.protocolId || event?.protocol),
    quote: mode !== "create" && !!(init.quoteId || event?.quote),
    realization: mode !== "create" && !!(init.realizationId || event?.realization || init.realizationOptout),
    journal: true,
    firstNote: false,
    history: false,
  });
  const toggleSec = (k: keyof typeof openSec) =>
    setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  // --- Drag & drop plików na całe okno → załączniki w kompozytorze notatki ---
  const notesRef = useRef<CalendarEventNotesHandle>(null);
  /** Te same warunki, na jakich kompozytor notatek dostaje `canEdit`. */
  // Kafelek notatki nie ma własnych notatek, więc nie ma też gdzie upuścić plików.
  const dropEnabled =
    !!event && !event.deletedAt && !isNoteEvent(event.type) && (isEdit || (readOnly && !!onEdit));
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  /** Pliki z dropu czekają, aż sekcja notatek się rozwinie i komponent zamontuje. */
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const hasFiles = (e: ReactDragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = (e: ReactDragEvent) => {
    if (!dropEnabled || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!dragOver) setDragOver(true);
  };
  const onDragOver = (e: ReactDragEvent) => {
    if (!dropEnabled || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: ReactDragEvent) => {
    if (!dropEnabled || !hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: ReactDragEvent) => {
    if (!dropEnabled) return;
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    setOpenSec((s) => (s.journal ? s : { ...s, journal: true }));
    setDroppedFiles(files);
  };
  useEffect(() => {
    if (!droppedFiles) return;
    const handle = notesRef.current;
    if (!handle) return; // sekcja jeszcze zwinięta — efekt odpali się po jej rozwinięciu
    handle.addFiles(droppedFiles);
    setDroppedFiles(null);
    document.getElementById("sec-journal-body")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [droppedFiles, openSec.journal]);
  useEffect(() => {
    if (!open) {
      dragDepth.current = 0;
      setDragOver(false);
      setDroppedFiles(null);
      setHasNoteDraft(false);
    }
  }, [open]);
  const dropProps = dropEnabled ? { onDragEnter, onDragOver, onDragLeave, onDrop } : {};
  const dropOverlay = dropEnabled && dragOver && (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/85 backdrop-blur-[1px]"
      data-testid="event-drop-overlay"
      aria-hidden
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Paperclip className="h-6 w-6" />
        </span>
        <p className="text-sm font-medium">Upuść pliki, aby dodać notatkę z załącznikiem</p>
        <p className="text-xs text-muted-foreground">Obrazy, PDF, dokumenty — maks. 15 plików po 5 MB</p>
      </div>
    </div>
  );

  const [scopeFor, setScopeFor] = useState<"save" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Pytanie o niewysłany szkic notatki i/lub niezapisany formularz (jedno na wszystkie przypadki). */
  const [prompt, setPrompt] = useState<DraftPrompt | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  /** Czy kompozytor notatek ma szkic — badge „szkic” przy zwiniętej sekcji. */
  const [hasNoteDraft, setHasNoteDraft] = useState(false);

  const dirty = useMemo(
    () => !readOnly && (JSON.stringify(form) !== JSON.stringify(initialRef.current) || firstNote.trim() !== ""),
    [form, readOnly, firstNote]
  );

  // Słowniki
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Kartotekę obiektów ciągniemy tylko tam, gdzie jest picker — w dziale bez
    // niego to byłoby tysiąc wierszy pobranych po nic.
    Promise.all([cfg.assignees.load(), cfg.features.objectPicker ? getObjects({ pageSize: 1000 }) : null])
      .then(([aRows, oRes]) => {
        if (cancelled) return;
        setAssignees(aRows || []);
        setObjects(oRes?.data || []);
      })
      .catch(() => {
        /* słowniki opcjonalne — formularz działa bez nich */
      });
    return () => {
      cancelled = true;
    };
  }, [open, cfg]);

  // Historia
  useEffect(() => {
    if (!open || !event) return;
    let cancelled = false;
    calendarApi
      .getEvent(event.id)
      .then((res) => {
        if (cancelled) return;
        setHistory(res.data?.history || []);
        const n = res.data?.notes;
        if (Array.isArray(n)) {
          setNotes(n);
          setNotesCount(n.length);
        } else {
          // Starszy backend bez notatek — komponent spróbuje GET /notes sam.
          setNotes(null);
        }
      })
      .catch(() => {
        /* brak historii nie blokuje edycji */
      });
    return () => {
      cancelled = true;
    };
  }, [open, event]);

  // Konflikty (debounce)
  const draftInput = useMemo(() => {
    if (!open || readOnly) return null;
    if (!form.assigneeIds.length || !form.start || !form.end) return null;
    const i = toInput(form, cfg);
    // Kolizje pytamy o TYCH SAMYCH ludzi, których zapisujemy — nazwę parametru
    // (`technicianIds` / `salespersonIds`) podmienia most z calendar-config.
    return { ...assigneeConflictQuery(form.assigneeIds, cfg), startAt: i.startAt, endAt: i.endAt };
  }, [open, readOnly, form, cfg]);

  useEffect(() => {
    if (!draftInput) {
      setConflicts([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      calendarApi
        .conflicts({ ...draftInput, excludeId: event?.id })
        .then((res) => {
          if (!cancelled) setConflicts(res.data || []);
        })
        .catch(() => {
          if (!cancelled) setConflicts([]);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [draftInput, event?.id]);

  // Dostępność (urlopy) w wybranym terminie
  const draftRange = useMemo(() => {
    if (!open || readOnly || !form.start || !form.end) return null;
    const i = toInput(form, cfg);
    return { from: i.startAt, to: i.endAt };
  }, [open, readOnly, form, cfg]);

  useEffect(() => {
    if (!draftRange || draftRange.to <= draftRange.from) {
      setAvailability([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      calendarApi
        .availability(draftRange.from, draftRange.to, cfg.department)
        .then((res) => {
          if (!cancelled) setAvailability(res.data || []);
        })
        .catch(() => {
          if (!cancelled) setAvailability([]);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [draftRange, cfg.department]);

  // --- Szansa i osoby kontaktowe (dział handlowy) ---------------------------

  /**
   * Szansa do pokazania w pickerze. Przy edycji zapisanego wydarzenia znamy z
   * początku tylko `leadId` + `leadTitle` z wiersza — pełny obiekt (kontrahent,
   * właściciel) dociąga efekt niżej, a do tego czasu pokazujemy, co mamy.
   */
  const selectedLead: LeadRef | null = useMemo(() => {
    if (form.leadId == null) return null;
    if (pickedLead && pickedLead.id === form.leadId) return pickedLead;
    if (event?.leadId === form.leadId) {
      return { id: form.leadId, title: event.leadTitle ?? `Szansa #${form.leadId}`, stage: event.leadStage ?? null };
    }
    return { id: form.leadId, title: `Szansa #${form.leadId}` };
  }, [form.leadId, pickedLead, event]);

  // Pełna szansa po id — potrzebna dla kontrahenta (zawężenie kontaktów) i właściciela.
  useEffect(() => {
    if (!open || !cfg.features.leadPicker || form.leadId == null) return;
    if (pickedLead?.id === form.leadId) return;
    let cancelled = false;
    leadsApi
      .get(form.leadId)
      .then((res) => {
        if (!cancelled && res.data) setPickedLead(res.data);
      })
      .catch(() => {
        /* brak dostępu do karty szansy nie blokuje edycji wydarzenia */
      });
    return () => {
      cancelled = true;
    };
  }, [open, cfg.features.leadPicker, form.leadId, pickedLead?.id]);

  /**
   * Kontakty szansy ORAZ jej kontrahenta — dokładnie ten zbiór, który backend
   * przyjmuje w `contactId` (src/lib/calendar-mutations.ts). Dwa zapytania zamiast
   * jednego, bo kontakt bywa podpięty pod klienta, a nie pod samą szansę.
   */
  useEffect(() => {
    if (!open || !cfg.features.contactPicker || form.leadId == null) {
      setLeadContacts([]);
      return;
    }
    let cancelled = false;
    const leadId = form.leadId;
    const contractorId = pickedLead?.id === leadId ? pickedLead.contractorId : null;
    Promise.all([
      contactsApi.list({ leadId, pageSize: 200 }),
      contractorId != null ? contactsApi.list({ contractorId, pageSize: 200 }) : null,
    ])
      .then(([byLead, byContractor]) => {
        if (cancelled) return;
        const merged = new Map<number, Contact>();
        for (const c of [...(byLead.data ?? []), ...(byContractor?.data ?? [])]) merged.set(c.id, c);
        setLeadContacts([...merged.values()]);
      })
      .catch(() => {
        if (!cancelled) setLeadContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cfg.features.contactPicker, form.leadId, pickedLead]);

  const selectedContact = useMemo(
    () => (form.contactId == null ? null : (leadContacts.find((c) => c.id === form.contactId) ?? null)),
    [leadContacts, form.contactId]
  );

  /**
   * Dopełniacz przypisanego („technika” / „handlowca”). Polskiej odmiany nie da
   * się złożyć z mianownika, a osobnego pola w `CalendarConfig` nie ma — wycinamy
   * go więc z gotowego zdania walidacji urlopu, które już go zawiera.
   */
  const assigneeGenitive =
    cfg.assignees.labels.leave.replace(/^.*wskazania\s+/i, "").replace(/\.\s*$/, "") ||
    cfg.assignees.labels.one.toLowerCase();

  const isUrlop = form.type === "urlop";
  /** Kafelek notatki — formularz redukuje się do daty, statusu i wyboru notatki. */
  const isNote = isNoteEvent(form.type);
  // Rozliczenia, protokoły, wyceny i realizacje należą do świata techniki —
  // w kalendarzu handlowym tych sekcji po prostu nie ma.
  const showBilling = cfg.features.billing && billingApplies(form.type);
  const showProtocol = cfg.features.protocol && billingApplies(form.type);
  const showQuote = cfg.features.quote && billingApplies(form.type);
  /** Notatka źródłowa: wybrana w tej sesji albo przysłana przez backend z wydarzeniem. */
  const sourceNote = pickedNote ?? event?.sourceNote ?? null;

  /** Dojazd — pole informacyjne, poza FormState: nie zapisuje się z wydarzeniem. */
  const { travel, loading: travelLoading } = useTravel(form.objectId, open && cfg.features.routePlanner && !isUrlop && !isNote);
  /** Protokół widoczny w formularzu: wybrany z listy / przypięty / z realizacji (gdy nic nie przypięto). */
  const formProtocol: CalendarEventProtocol | null =
    form.protocolId != null
      ? pickedProtocol?.id === form.protocolId
        ? pickedProtocol
        : event?.protocol?.id === form.protocolId
          ? event.protocol
          : null
      : event && event.protocolId == null
        ? (event.protocol ?? null)
        : null;
  const protocolFromRealization = !!formProtocol && form.protocolId == null;
  /** Odpięto protokół przypięty jawnie — po zapisie backend wróci do protokołu realizacji lub braku. */
  const protocolUnpinned = !!event && event.protocolId != null && form.protocolId == null;

  /** Wycena widoczna w formularzu: wybrana z listy / przypięta / z realizacji (gdy nic nie przypięto). */
  const formQuote: CalendarEventQuote | null =
    form.quoteId != null
      ? pickedQuote?.id === form.quoteId
        ? pickedQuote
        : event?.quote?.id === form.quoteId
          ? event.quote
          : null
      : event && event.quoteId == null
        ? (event.quote ?? null)
        : null;
  const quoteFromRealization = !!formQuote && form.quoteId == null;
  /** Odpięto wycenę przypiętą jawnie — po zapisie backend wróci do wyceny realizacji lub braku. */
  const quoteUnpinned = !!event && event.quoteId != null && form.quoteId == null;

  const showRealization = realizationApplies(form.type);
  /** Realizacja widoczna w formularzu: wybrana z listy albo przypięta do wydarzenia. */
  const formRealization: CalendarEventRealization | null =
    form.realizationId == null
      ? null
      : pickedRealization?.id === form.realizationId
        ? pickedRealization
        : event?.realization?.id === form.realizationId
          ? event.realization
          : null;
  /** Odpięto realizację — po zapisie wydarzenie zostanie bez niej (automat może utworzyć nową). */
  const realizationUnpinned = !!event && event.realizationId != null && form.realizationId == null;
  /** Świadome odpięcie: automat nie utworzy realizacji, dopóki nie zostanie włączony z powrotem. */
  const realizationOptedOut = form.realizationOptout && form.realizationId == null;

  const onLeave = useMemo(() => {
    // Wiersz dostępności ma `technicianId` albo `salespersonId` — id czyta most.
    const m = new Map<number, CalendarAvailability>();
    for (const a of availability) {
      const leaves = a.leaves.filter((l) => l.eventId !== event?.id);
      if (leaves.length) m.set(availabilityAssigneeId(a), { ...a, leaves });
    }
    return m;
  }, [availability, event?.id]);

  const leaveConflicts = useMemo(
    () => (isUrlop ? [] : conflicts.filter((c) => c.conflictKind === "urlop")),
    [conflicts, isUrlop]
  );
  const eventConflicts = useMemo(
    () => conflicts.filter((c) => c.conflictKind !== "urlop" || isUrlop),
    [conflicts, isUrlop]
  );
  const leaveMessages = useMemo(() => {
    const out: { key: string; eventId: number; text: string }[] = [];
    for (const c of leaveConflicts) {
      for (const t of assigneesOf(c, cfg)) {
        if (!form.assigneeIds.includes(t.id)) continue;
        out.push({
          key: `${c.id}-${t.id}`,
          eventId: c.id,
          text: `${t.firstName} ${t.lastName} — urlop ${fmtRange(c.startAt, c.endAt, c.allDay)}`,
        });
      }
    }
    return out;
  }, [leaveConflicts, form.assigneeIds, cfg]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => {
      const key = (k === "assigneeIds" ? "assignees" : k) as FieldKey;
      if (!(key in e)) return e;
      const n = { ...e };
      delete n[key];
      return n;
    });
  };

  const toggleAllDay = (allDay: boolean) => {
    setForm((f) => {
      if (allDay) {
        return {
          ...f,
          allDay,
          start: f.start.slice(0, 10),
          end: f.end.slice(0, 10) || f.start.slice(0, 10),
        };
      }
      const s = f.start.length === 10 ? `${f.start}T08:00` : f.start;
      const e = f.end.length === 10 ? `${f.end}T10:00` : f.end;
      return { ...f, allDay, start: s, end: e };
    });
  };

  const changeType = (type: CalendarEventType) => {
    setForm((f) => {
      const next = { ...f, type };
      if (!billingApplies(type)) {
        next.billing = null;
        next.protocolId = null;
        next.quoteId = null;
      }
      if (!realizationApplies(type)) next.realizationId = null;
      if (type === "urlop") {
        next.allDay = true;
        next.start = f.start.slice(0, 10);
        next.end = f.end.slice(0, 10) || f.start.slice(0, 10);
        next.objectId = "";
        next.location = "";
        next.recFreq = "";
        // Urlop nie należy do żadnej szansy — to nieobecność, nie aktywność handlowa.
        next.leadId = null;
        next.contactId = null;
        setMultiDayPref(true);
      }
      if (!isNoteEvent(type) && isNoteEvent(f.type)) {
        // Wyjście z trybu notatki — tytuł był generowany z jej treści.
        next.noteId = null;
        next.title = "";
        setPickedNote(null);
      }
      if (isNoteEvent(type)) {
        // Kafelek notatki: jeden dzień, bez techników, obiektu, cykliczności i dokumentów.
        next.allDay = true;
        next.start = f.start.slice(0, 10);
        next.end = next.start;
        next.objectId = "";
        next.location = "";
        next.description = "";
        next.assigneeIds = [];
        next.leadId = null;
        next.contactId = null;
        next.recFreq = "";
        next.realizationOptout = false;
        setMultiDayPref(false);
      }
      if (type === "konserwacja" && !f.recFreq && mode === "create") {
        next.recFreq = "quarterly";
        next.recInterval = "1";
        next.recMode = "until";
        next.recUntil = addYears(f.start.slice(0, 10), 2);
        setOpenSec((s) => ({ ...s, repeat: true }));
      }
      return next;
    });
  };

  const toggleAssignee = (id: number) =>
    set(
      "assigneeIds",
      form.assigneeIds.includes(id)
        ? form.assigneeIds.filter((x) => x !== id)
        : [...form.assigneeIds, id]
    );

  // --- Sekcja „Kiedy”: jeden wiersz Data / od → do, czas trwania zachowywany ---
  const mobile = useIsMobile();
  /** Preferencja użytkownika „Wielodniowe / Więcej dni”; wartości mogą ją wymusić. */
  const [multiDayPref, setMultiDayPref] = useState<boolean>(() => {
    const f = initialRef.current;
    if (f.type === "urlop") return true;
    if (f.allDay) return f.end !== f.start;
    const d = diffMinutes(f.start, f.end);
    return dateOf(f.end) !== dateOf(f.start) && !(d > 0 && d < 1440);
  });
  const valuesMultiDay = (() => {
    if (!form.start || !form.end) return false;
    if (form.allDay) return form.end !== form.start;
    const d = diffMinutes(form.start, form.end);
    return dateOf(form.end) !== dateOf(form.start) && !(d > 0 && d < 1440);
  })();
  const multiDay = multiDayPref || valuesMultiDay;
  /** Koniec następnego dnia bez trybu wielodniowego (np. 22:00 → 02:00). */
  const overnight = !form.allDay && !multiDay && dateOf(form.end) !== dateOf(form.start);
  const durationMin = !form.allDay && form.start && form.end ? diffMinutes(form.start, form.end) : 0;
  const durationDays = form.allDay && form.start && form.end ? diffDays(form.start, form.end) + 1 : 0;

  const clearWhenErrors = () =>
    setFieldErrors((er) => (er.start || er.end ? { ...er, start: undefined, end: undefined } : er));

  /** Godzinowe: zmiana daty/„od” przesuwa „do” zachowując czas trwania. */
  const setStartKeepDuration = (nextStart: string) => {
    clearWhenErrors();
    setForm((f) => {
      const dur = f.start && f.end && diffMinutes(f.start, f.end) > 0 ? diffMinutes(f.start, f.end) : DEFAULT_DURATION_MIN;
      return { ...f, start: nextStart, end: addMinutes(nextStart, dur) };
    });
  };
  const setStartDate = (d: string) => {
    if (!d) return;
    if (form.allDay) {
      clearWhenErrors();
      setForm((f) => {
        const days = f.start && f.end ? Math.max(0, diffDays(f.start, f.end)) : 0;
        return { ...f, start: d, end: multiDay ? addDays(d, days) : d };
      });
    } else setStartKeepDuration(`${d}T${timeOf(form.start) || "08:00"}`);
  };
  const setStartTime = (t: string) => setStartKeepDuration(`${dateOf(form.start)}T${t}`);
  /** „do” wcześniejsze niż „od” (bez trybu wielodniowego) = następny dzień. */
  const setEndTime = (t: string) => {
    clearWhenErrors();
    setForm((f) => {
      if (multiDay) return { ...f, end: `${dateOf(f.end) || dateOf(f.start)}T${t}` };
      let end = `${dateOf(f.start)}T${t}`;
      if (end <= f.start) end = addMinutes(end, 1440);
      return { ...f, end };
    });
  };
  const setEndDate = (d: string) => {
    if (!d) return;
    clearWhenErrors();
    setForm((f) => ({ ...f, end: f.allDay ? d : `${d}T${timeOf(f.end) || "10:00"}` }));
  };
  const setDurationMinutes = (m: number) => {
    clearWhenErrors();
    setForm((f) => ({ ...f, end: addMinutes(f.start, m) }));
  };
  const setDurationDays = (days: number) => {
    clearWhenErrors();
    setForm((f) => ({ ...f, end: addDays(f.start, days - 1) }));
  };
  const toggleMultiDay = (on: boolean) => {
    setMultiDayPref(on);
    if (on) return;
    clearWhenErrors();
    // Zwinięcie zakresu: all-day → ten sam dzień; godzinowe → ta sama doba (lub +1 dzień).
    setForm((f) => {
      if (f.allDay) return { ...f, end: f.start };
      let end = `${dateOf(f.start)}T${timeOf(f.end) || "10:00"}`;
      if (end <= f.start) end = addMinutes(end, 1440);
      return { ...f, end };
    });
  };

  const validate = (): FieldErrors => {
    const e: FieldErrors = {};
    if (isNote) {
      if (!form.noteId) e.note = "Wskaż notatkę, do której ma prowadzić kafelek.";
      if (!form.start) e.start = "Podaj dzień.";
      return e;
    }
    if (!form.title.trim() && !isUrlop) e.title = "Podaj tytuł wydarzenia.";
    if (isUrlop && form.assigneeIds.length === 0) e.assignees = cfg.assignees.labels.leave;
    if (!form.start) e.start = "Podaj początek.";
    if (!form.end) e.end = "Podaj koniec.";
    if (form.start && form.end) {
      const i = toInput(form, cfg);
      if (parseLocal(i.endAt).getTime() <= parseLocal(i.startAt).getTime()) {
        e.end = form.allDay
          ? "Koniec nie może być wcześniejszy niż początek."
          : "Koniec musi być po początku.";
      }
    }
    if (form.recFreq && mode === "create" && !isUrlop) {
      if (form.recMode === "until" && !form.recUntil)
        e.recUntil = "Podaj datę końca powtarzania.";
      if (form.recMode === "count" && !(Number(form.recCount) >= 1))
        e.recCount = "Podaj liczbę powtórzeń (min. 1).";
    }
    return e;
  };

  const focusField = (k: FieldKey) => {
    const idMap: Record<FieldKey, string> = {
      title: "cal-title",
      start: "cal-start",
      end: "cal-end",
      assignees: "cal-assignee-first",
      recUntil: "cal-rec-until",
      recCount: "cal-rec-count",
      note: "cal-note-search",
    };
    window.setTimeout(() => document.getElementById(idMap[k])?.focus(), 0);
  };

  const doSave = useCallback(
    async (scope: CalendarSeriesScope = "this") => {
      setSaving(true);
      setError(null);
      try {
        const input = toInput(form, cfg);
        const res = isEdit
          ? await calendarApi.update(event!.id, input, scope)
          : await calendarApi.create(input);
        let saved = res.data;
        // Pierwsza notatka: osobne API po utworzeniu. Błąd nie cofa utworzenia — wydarzenie już istnieje.
        if (!isEdit && saved && firstNote.trim()) {
          try {
            await calendarApi.addNote(saved.id, firstNote.trim());
            saved = { ...saved, notesCount: (saved.notesCount ?? 0) + 1 };
          } catch {
            /* notatkę można dopisać w edycji */
          }
        }
        if (saved) onSaved?.(saved);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Błąd zapisu");
      } finally {
        setSaving(false);
      }
    },
    [form, isEdit, event, onSaved, onClose, firstNote]
  );

  /** Właściwy zapis (po walidacji i po rozstrzygnięciu szkicu notatki). */
  const continueSave = useCallback(() => {
    if (isEdit && event?.seriesId) {
      setScopeFor("save");
      return;
    }
    void doSave("this");
  }, [isEdit, event, doSave]);

  /** Walidacja + fokus na pierwszym błędnym polu. `true` = można zapisywać. */
  const validateAndFocus = (): boolean => {
    const errs = validate();
    setFieldErrors(errs);
    const first = (Object.keys(errs) as FieldKey[])[0];
    if (!first) return true;
    setError(null);
    if (first === "recUntil" || first === "recCount") setOpenSec((s) => ({ ...s, repeat: true }));
    focusField(first);
    return false;
  };

  /** Rozwija sekcję notatek i przewija do niej (błąd wysyłki, żeby było widać komunikat). */
  const revealJournal = () => {
    setOpenSec((s) => (s.journal ? s : { ...s, journal: true }));
    window.setTimeout(
      () => document.getElementById("sec-journal-body")?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      0
    );
  };

  /**
   * Guard niezapisanej pracy: szkic notatki (zapis/zamknięcie/szybki status) i — przy
   * zamykaniu — zmiany w formularzu. `true` = pokazaliśmy pytanie, akcja wstrzymana.
   */
  const guardDraft = (intent: DraftPrompt["intent"], status?: CalendarEventStatus): boolean => {
    const summary = notesRef.current?.draftSummary();
    const note = summary && (summary.text || summary.files > 0) ? summary : null;
    // Przy zapisie i szybkim statusie zmiany formularza i tak trafiają na serwer — pytamy tylko o notatkę.
    const formDirty = intent === "close" && dirty;
    if (!note && !formDirty) return false;
    setPrompt({ intent, status, note, dirty: formDirty });
    return true;
  };

  const handleSubmit = () => {
    if (readOnly || saving) return;
    if (!validateAndFocus()) return;
    // Niewysłany szkic w kompozytorze notatki (tryb edycji; w „create” notatka idzie z formularzem).
    if (guardDraft("save")) return;
    continueSave();
  };

  const doDelete = useCallback(
    async (scope: CalendarSeriesScope = "this") => {
      if (!event) return;
      setSaving(true);
      try {
        await calendarApi.remove(event.id, scope);
        onDeleted?.(event, scope);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Błąd usuwania wydarzenia");
      } finally {
        setSaving(false);
      }
    },
    [event, onDeleted, onClose]
  );

  const handleDeleteClick = () => {
    if (event?.seriesId) setScopeFor("delete");
    else setConfirmDelete(true);
  };

  /** Tryb podglądu: szybka zmiana statusu (Potwierdź / Wykonane). */
  const quickStatus = async (status: CalendarEventStatus) => {
    if (!event || quickStatusBusy) return;
    setQuickStatusBusy(status);
    setError(null);
    try {
      const res = await calendarApi.update(
        event.id,
        { ...toInput(buildInitial(event, null, cfg), cfg), status },
        "this"
      );
      if (res.data) onSaved?.(res.data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zmiany statusu");
    } finally {
      setQuickStatusBusy(null);
    }
  };

  /** Tryb podglądu: szybka akcja statusu przez guard (mogła czekać niewysłana notatka). */
  const requestQuickStatus = (status: CalendarEventStatus) => {
    if (!event || quickStatusBusy) return;
    if (guardDraft("status", status)) return;
    void quickStatus(status);
  };

  /** Zamknięcie z ochroną niezapisanych zmian i niewysłanego szkicu notatki. */
  const requestClose = () => {
    if (saving) return;
    if (guardDraft("close")) return;
    onClose();
  };

  /**
   * Rozstrzygnięcie pytania: „send” wysyła szkic notatki i dopiero potem wykonuje pierwotną
   * akcję; „discard” czyści szkic (a przy zamykaniu porzuca też zmiany formularza).
   * Błąd wysyłki zostawia użytkownika w dialogu — komunikat pokazuje kompozytor.
   */
  const resolvePrompt = async (choice: "send" | "discard") => {
    if (!prompt || promptBusy) return;
    const { intent, status, note, dirty: formDirty } = prompt;
    if (choice === "send" && note) {
      setPromptBusy(true);
      try {
        await notesRef.current?.submitDraft();
      } catch {
        setPrompt(null);
        setPromptBusy(false);
        revealJournal();
        return;
      }
      setPromptBusy(false);
    } else if (choice === "discard" && note) {
      notesRef.current?.discardDraft();
    }
    setPrompt(null);
    if (intent === "save") {
      continueSave();
      return;
    }
    if (intent === "status") {
      if (status) void quickStatus(status);
      return;
    }
    // Zamknięcie: „Dodaj notatkę i zapisz” przy zmianach w formularzu zapisuje wydarzenie
    // (dialog zamknie się po udanym zapisie); w pozostałych przypadkach po prostu zamykamy.
    if (choice === "send" && formDirty) {
      if (validateAndFocus()) continueSave();
      return;
    }
    onClose();
  };

  // Ostatnie pytanie zostaje w refie, żeby napisy nie zmieniały się w trakcie animacji zamykania.
  const lastPromptRef = useRef<DraftPrompt | null>(null);
  if (prompt) lastPromptRef.current = prompt;
  const shownPrompt = prompt ?? lastPromptRef.current;
  const promptTexts = (() => {
    const note = shownPrompt?.note ?? null;
    if (!note) {
      return {
        title: "Odrzucić niezapisane zmiany?",
        description: "Formularz ma zmiany, które nie zostały zapisane. Zamknięcie je utraci.",
        cancel: "Wróć do edycji",
        discard: "Odrzuć zmiany",
        send: "",
      };
    }
    const what = [note.text ? "tekst" : null, note.files ? pluralPl(note.files, "plik", "pliki", "plików") : null]
      .filter(Boolean)
      .join(", ");
    const closing = shownPrompt?.intent === "close";
    if (closing && shownPrompt?.dirty) {
      return {
        title: "Niezapisane zmiany i notatka",
        description: `Masz niezapisane zmiany w wydarzeniu i niewysłaną notatkę${what ? ` (${what})` : ""}. Co zrobić?`,
        cancel: "Anuluj",
        discard: "Odrzuć wszystko",
        send: "Dodaj notatkę i zapisz",
      };
    }
    return {
      title: "Niezapisana notatka",
      description: `Masz niewysłaną notatkę${what ? ` (${what})` : ""}. Co zrobić?`,
      cancel: "Anuluj",
      discard: "Odrzuć notatkę",
      send: closing ? "Dodaj notatkę i zamknij" : "Dodaj notatkę i zapisz",
    };
  })();

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  const goToObject = (objectId: number) => {
    onClose();
    navigate(`/objects/${objectId}`);
  };

  /**
   * Klik we wzmiankę daty w notatce („@piątek”) albo w link „w kalendarzu”:
   * z `eventId` otwieramy kafelek notatki, bez niego przechodzimy do dnia.
   */
  const openMention = (date: string, eventId: number | null) => {
    if (eventId != null) {
      if (onOpenEvent) {
        onOpenEvent(eventId);
        return;
      }
      onClose();
      navigate(`${cfg.baseHref}?event=${eventId}`);
      return;
    }
    if (!date) return;
    onClose();
    if (onGoToDate) onGoToDate(date);
    else navigate(`${cfg.baseHref}?date=${date}`);
  };

  /** „Otwórz wydarzenie źródłowe” — wydarzenie, do którego należy notatka kafelka. */
  const openSourceEvent = () => {
    const id = sourceNote?.eventId;
    if (!id) return;
    if (onOpenEvent) {
      onOpenEvent(id);
      return;
    }
    onClose();
    navigate(`${cfg.baseHref}?event=${id}`);
  };

  // --- Wyliczenia do nagłówka / podsumowań ---
  const typeMeta = EVENT_TYPE_META[form.type];
  const typeUi = EVENT_TYPE_UI[form.type];
  const TypeIcon = typeMeta?.icon ?? Clock;
  const selectedObject = objects.find((o) => String(o.id) === form.objectId);
  const objectAddress = selectedObject
    ? [selectedObject.address, selectedObject.city].filter(Boolean).join(", ")
    : "";
  // Dojazd: błąd geokodera pokazujemy zamiast liczb — pole nigdy nie blokuje zapisu.
  const travelText = travelLine(travel, travelLoading, { startAt: form.start, allDay: form.allDay });
  const travelSource = travelSourceLabel(travel, travelLoading);
  const rangeText = (() => {
    if (!form.start || !form.end) return "";
    const i = toInput(form, cfg);
    return fmtRange(i.startAt, i.endAt, i.allDay);
  })();
  const durationText = (() => {
    if (!form.start || !form.end) return "";
    const i = toInput(form, cfg);
    return fmtDuration(i.startAt, i.endAt, i.allDay);
  })();

  const occurrences = useMemo(
    () => (mode === "create" && !isUrlop ? previewOccurrences(form) : []),
    [mode, isUrlop, form]
  );
  const recSummary = (() => {
    if (!form.recFreq) return "";
    const base = seriesShortLabel(form.recFreq, Math.max(1, Number(form.recInterval) || 1));
    const head = base.charAt(0).toUpperCase() + base.slice(1);
    const tail =
      form.recMode === "until"
        ? form.recUntil
          ? `, do ${fmtLong(form.recUntil, true)}`
          : ""
        : form.recCount
          ? `, ${form.recCount} razy`
          : "";
    const n = occurrences.length;
    return `${head}${tail} — ${n} ${plural(n, "wystąpienie", "wystąpienia", "wystąpień")}`;
  })();

  const seriesBadge =
    event?.seriesId && event.series
      ? `${seriesShortLabel(event.series.freq, event.series.interval)}${
          event.seriesIndex != null && event.seriesTotal != null
            ? ` · ${event.seriesIndex}/${event.seriesTotal}`
            : event.series.count
              ? ` · ${event.series.count} razy`
              : ""
        }`
      : event?.seriesId
        ? `seria #${event.seriesId}`
        : null;

  const titleText =
    mode === "create"
      ? "Nowe wydarzenie"
      : mode === "edit"
        ? "Edycja wydarzenia"
        : event?.title || "Wydarzenie";

  /**
   * Prefill dla „Zaplanuj następną”: ta sama szansa, ten sam handlowiec, termin
   * przesunięty o tydzień. `null` = przycisku nie ma (nie ten dział, nie wykonane
   * wydarzenie albo rodzic nie umie otworzyć nowego dialogu).
   */
  const planNextPrefill: CalendarEventPrefill | null = useMemo(() => {
    if (!cfg.features.leadPicker || !onPlanNext) return null;
    if (!readOnly || !event || event.status !== "done" || event.deletedAt) return null;
    if (isNoteEvent(event.type) || event.type === "urlop") return null;
    const shift = (v: string) =>
      v.length > 10 ? `${addDays(v.slice(0, 10), 7)}${v.slice(10, 16)}` : addDays(v.slice(0, 10), 7);
    return {
      type: event.type,
      startAt: shift(event.startAt),
      endAt: shift(event.endAt),
      allDay: event.allDay,
      assigneeIds: assigneesOf(event, cfg).map((a) => a.id),
      leadId: event.leadId ?? null,
      contactId: event.contactId ?? null,
      objectId: event.objectId,
      location: event.location,
    };
  }, [cfg, onPlanNext, readOnly, event]);

  /** Lista do wyboru: słownik działu, a zanim dojedzie — osoby już przypisane. */
  const assigneeList: AssigneeRef[] = assignees.length
    ? assignees
    : event
      ? assigneesOf(event, cfg).map((a) => ({ ...a, active: true }))
      : [];

  // ---------------------------------------------------------------------------

  const Title = docked ? "h2" : DialogTitle;
  const Description = docked ? "p" : DialogDescription;
  const header = (
    <div className="relative shrink-0 border-b px-5 pb-3 pt-4 pr-12">
      <div className={cn("absolute inset-x-0 top-0 h-1", typeUi?.bar)} aria-hidden />
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            typeUi?.soft
          )}
          aria-hidden
        >
          <TypeIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <Title className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold leading-tight">
            <span className="truncate">{titleText}</span>
            {event && (
              <span className={statusBadgeClass(event.status)}>
                {EVENT_STATUS_META[event.status]?.label}
              </span>
            )}
            {seriesBadge && (
              <span className="inline-flex items-center gap-1 rounded-full bg-teal-500/15 px-2 py-0.5 text-xs font-medium text-teal-700 dark:text-teal-300">
                <Repeat className="h-3 w-3" />
                {seriesBadge}
              </span>
            )}
            {event?.deletedAt && (
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
                Usunięte
              </span>
            )}
          </Title>
          <Description className="mt-0.5 text-xs text-muted-foreground">
            {readOnly && event
              ? `${typeMeta?.label ?? form.type} · ${fmtRange(event.startAt, event.endAt, event.allDay)}`
              : event
                ? `${typeMeta?.label ?? form.type} · #${event.id}${dirty ? " · niezapisane zmiany" : ""}`
                : isNote
                  ? "Wybierz notatkę i dzień — kafelek tylko do niej prowadzi."
                  : isUrlop
                    ? `Wskaż ${assigneeGenitive} i termin urlopu. Tytuł jest opcjonalny.`
                    : `Typ, tytuł, termin i ${cfg.assignees.labels.many.toLowerCase()}. Reszta pod rozwijanymi sekcjami.`}
          </Description>
        </div>
      </div>
      {docked && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-3 h-7 w-7"
          onClick={requestClose}
          aria-label="Zamknij edycję"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );

  // --- Tryb podglądu: karta ---
  const viewBody = event && (
    <div className="space-y-4 px-5 py-4">
      {onEdit && !event.deletedAt && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={onEdit}>
            <Pencil className="mr-1 h-4 w-4" /> Edytuj
          </Button>
          {event.status === "planned" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!!quickStatusBusy}
              onClick={() => requestQuickStatus("confirmed")}
            >
              {quickStatusBusy === "confirmed" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              Potwierdź
            </Button>
          )}
          {(event.status === "planned" || event.status === "confirmed") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!!quickStatusBusy}
              onClick={() => requestQuickStatus("done")}
            >
              {quickStatusBusy === "done" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CircleCheck className="mr-1 h-4 w-4" />
              )}
              Wykonane
            </Button>
          )}
        </div>
      )}
      {/*
        Reguła modułu handlowego: po wykonanej aktywności od razu planuje się
        następną, żeby szansa nie została bez kolejnego kroku (i nie zaczęła gnić).
        Dialog nie umie otworzyć drugiego siebie — robi to rodzic przez `onPlanNext`.
      */}
      {planNextPrefill && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="plan-next-activity"
            onClick={() => onPlanNext?.(planNextPrefill)}
            {...tip("Zaplanuj kolejny krok na tej szansie (za tydzień)")}
          >
            <CalendarPlus className="mr-1 h-4 w-4" /> Zaplanuj następną
          </Button>
        </div>
      )}
      <dl className="grid gap-3 text-sm sm:grid-cols-[120px_1fr]">
        <dt className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="h-3.5 w-3.5" /> Kiedy
        </dt>
        <dd>
          <div className="font-medium">{fmtRange(event.startAt, event.endAt, event.allDay)}</div>
          <div className="text-xs text-muted-foreground">
            {event.allDay ? "Cały dzień · " : ""}
            {fmtDuration(event.startAt, event.endAt, event.allDay)}
          </div>
        </dd>
        {isNoteEvent(event.type) && (
          <>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <StickyNote className="h-3.5 w-3.5" /> Notatka
            </dt>
            <dd>
              {sourceNote ? (
                <SourceNoteCard note={sourceNote} onOpenSource={openSourceEvent} />
              ) : (
                <span className="text-muted-foreground">
                  Notatka źródłowa niedostępna (mogła zostać usunięta).
                </span>
              )}
            </dd>
          </>
        )}
        {event.type !== "urlop" && !isNoteEvent(event.type) && (
          <>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" /> Obiekt
            </dt>
            <dd>
              {event.objectId ? (
                <button
                  type="button"
                  onClick={() => goToObject(event.objectId!)}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {event.objectName ?? `Obiekt #${event.objectId}`}
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" /> Lokalizacja
            </dt>
            <dd>{event.location || <span className="text-muted-foreground">—</span>}</dd>
            {/* Pogoda dla dnia i miejsca wydarzenia (nie dotyczy urlopu ani działu handlowego). */}
            {cfg.features.weather && (
              <>
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <CloudSun className="h-3.5 w-3.5" /> Pogoda
                </dt>
                <dd>
                  <WeatherSection
                    eventId={event.id}
                    brief={weather}
                    startAt={event.startAt}
                    endAt={event.endAt}
                    allDay={event.allDay}
                  />
                </dd>
              </>
            )}
          </>
        )}
        {/* Szansa i osoba kontaktowa — karta wydarzenia handlowego. */}
        {cfg.features.leadPicker && event.leadId != null && (
          <>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Handshake className="h-3.5 w-3.5" /> Szansa
            </dt>
            <dd>
              <Link
                to={`/handlowy/leady/${event.leadId}`}
                onClick={onClose}
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                {event.leadTitle ?? `Szansa #${event.leadId}`}
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
              {event.leadStage && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {LEAD_STAGE_META[event.leadStage]?.label ?? event.leadStage}
                </span>
              )}
            </dd>
          </>
        )}
        {cfg.features.contactPicker && event.contactId != null && (
          <>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Kontakt
            </dt>
            <dd>{event.contactName || <span className="text-muted-foreground">—</span>}</dd>
          </>
        )}
        {cfg.features.billing && billingApplies(event.type) && (
          <>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" /> Rozliczenie
            </dt>
            <dd>
              {event.billing ? (
                <span className={billingBadgeClass(event.billing)}>
                  {(() => {
                    const I = BILLING_META[event.billing].icon;
                    return <I className="h-3.5 w-3.5" />;
                  })()}
                  {BILLING_META[event.billing].label}
                </span>
              ) : (
                <span className="text-muted-foreground">nie dotyczy</span>
              )}
            </dd>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <FileCheck2 className="h-3.5 w-3.5" /> Protokół
            </dt>
            <dd>
              {(() => {
                const kind = protocolBadgeKind(event);
                if (!kind) return <span className="text-muted-foreground">—</span>;
                const meta = PROTOCOL_BADGE_META[kind];
                const I = meta.icon;
                const badge = (
                  <span className={protocolBadgeClass(kind)}>
                    <I className="h-3.5 w-3.5" />
                    {meta.label(event.protocol?.number)}
                  </span>
                );
                return event.protocol ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link to={protocolHref(event.protocol.id)} className="hover:underline">
                      {badge}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {kind === "final" ? "podpisany" : "szkic"}
                      {event.protocolId == null ? " · z realizacji" : ""}
                    </span>
                  </span>
                ) : (
                  badge
                );
              })()}
            </dd>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Calculator className="h-3.5 w-3.5" /> Wycena
            </dt>
            <dd>
              {(() => {
                const kind = quoteBadgeKind(event);
                if (!kind) return <span className="text-muted-foreground">nie dotyczy</span>;
                const meta = QUOTE_BADGE_META[kind];
                const I = meta.icon;
                const badge = (
                  <span className={quoteBadgeClass(kind)}>
                    <I className="h-3.5 w-3.5" />
                    {meta.label(event.quote?.number)}
                  </span>
                );
                return event.quote ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link to={quoteHref(event.quote.id)} className="hover:underline">
                      {badge}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      <span className="tabular-nums">{realizationMoney(event.quote.total)}</span>
                      {event.quote.filledItems === 0 ? " · szkic z cennika" : ""}
                      {event.quoteId == null ? " · z realizacji" : ""}
                    </span>
                  </span>
                ) : (
                  badge
                );
              })()}
            </dd>
          </>
        )}

        {cfg.features.realization && realizationApplies(event.type) && (
          <>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Receipt className="h-3.5 w-3.5" /> Realizacja
            </dt>
            <dd>
              {event.realization ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Link to={realizationHref(event.realization.id, event.realization.date)} className="hover:underline">
                    <span className={realizationBadgeClass(event.realization.invoiced ? "invoiced" : "open")}>
                      <Receipt className="h-3.5 w-3.5" />#{event.realization.id}
                    </span>
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {REALIZATION_KIND_LABEL[event.realization.kind] ?? event.realization.kind} ·{" "}
                    <span className="tabular-nums">{realizationMoney(event.realization.total)}</span>
                    {event.realization.invoiced ? " · zafakturowana" : ""}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </>
        )}

        {!isNoteEvent(event.type) && (
          <>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> {cfg.assignees.labels.many}
            </dt>
            <dd>
              {assigneesOf(event, cfg).length ? (
                <div className="flex flex-wrap gap-1.5">
                  {assigneesOf(event, cfg).map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-sm"
                    >
                      <Avatar name={`${t.firstName} ${t.lastName}`} className="h-5 w-5 text-[9px]" />
                      {t.firstName} {t.lastName}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground">nieprzypisani</span>
              )}
            </dd>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <FileText className="h-3.5 w-3.5" /> Opis
            </dt>
            <dd className="whitespace-pre-wrap">
              {event.description || <span className="text-muted-foreground">—</span>}
            </dd>
          </>
        )}
      </dl>
      {/* Kafelek notatki nie ma własnego dziennika — treść pokazuje karta notatki źródłowej. */}
      {!isNoteEvent(event.type) && (
        <Section id="sec-journal" icon={StickyNote} title={`Notatki (${notesCount})`}>
          <CalendarEventNotes
            ref={notesRef}
            eventId={event.id}
            initialNotes={notes}
            canEdit={!!onEdit && !event.deletedAt}
            onCountChange={handleNotesCount}
            onOpenMention={cfg.features.noteMentions ? openMention : undefined}
            objectId={event.objectId}
            objectName={event.objectName}
          />
        </Section>
      )}
    </div>
  );

  // --- Tryb edycji/tworzenia ---
  const formBody = (
    <div className="space-y-4 px-5 py-4">
      {/* Typ — typu `notatka` nie da się nadać ani zdjąć w edycji (backend odrzuca). */}
      {isEdit && isNote ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm" data-testid="type-locked">
          <StickyNote className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="font-medium">Notatka</span>
          <span className="text-xs text-muted-foreground">typu kafelka notatki nie da się zmienić</span>
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label="Typ wydarzenia"
          className={cn("grid gap-1.5", docked ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}
        >
          {cfg.typeOrder.filter((t) => !isEdit || !isNoteEvent(t)).map((t) => {
            const m = EVENT_TYPE_META[t];
            const I = m.icon;
            const active = form.type === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => changeType(t)}
                data-testid={`type-chip-${t}`}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  active ? m.chipActive : cn(m.chip, "bg-background hover:bg-muted")
                )}
              >
                <I className="h-4 w-4 shrink-0" />
                <span className="truncate">{m.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Notatka — kafelek wskazuje istniejącą notatkę (tytuł generuje backend) */}
      {isNote && (
        <Section id="sec-note" icon={StickyNote} title={mode === "create" ? "Notatka *" : "Notatka"}>
          {mode === "create" ? (
            <>
              <NotePicker
                inputId="cal-note-search"
                value={sourceNote}
                invalid={!!fieldErrors.note}
                onPick={(n) => {
                  setPickedNote(n);
                  setForm((f) => ({ ...f, noteId: n.id, title: noteEventTitle(n.text, n.eventTitle) }));
                  setFieldErrors((e) => {
                    if (!("note" in e)) return e;
                    const next = { ...e };
                    delete next.note;
                    return next;
                  });
                }}
                onClear={() => {
                  setPickedNote(null);
                  setForm((f) => ({ ...f, noteId: null, title: "" }));
                }}
              />
              <FieldError id="cal-note-err" msg={fieldErrors.note} />
              <p className="text-[11px] text-muted-foreground">
                Kafelek prowadzi do notatki — nie da się go stworzyć „z niczego”. Notatkę można też przypiąć
                sama, wpisując w jej treści datę po „@” (np. „@piątek”).
              </p>
            </>
          ) : sourceNote ? (
            <SourceNoteCard note={sourceNote} onOpenSource={openSourceEvent} />
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="source-note-missing">
              Notatka źródłowa niedostępna (mogła zostać usunięta).
            </p>
          )}
        </Section>
      )}

      {/* Tytuł */}
      {!isNote && (
        <div className="space-y-1">
          <Label htmlFor="cal-title">{isUrlop ? "Tytuł" : "Tytuł *"}</Label>
          <Input
            id="cal-title"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={isUrlop ? "domyślnie: Urlop — Imię Nazwisko" : "np. Serwis kamer — magazyn A"}
            autoFocus={mode === "create"}
            aria-invalid={!!fieldErrors.title}
            aria-describedby={fieldErrors.title ? "cal-title-err" : undefined}
            className={cn(fieldErrors.title && "border-destructive focus-visible:ring-destructive")}
          />
          <FieldError id="cal-title-err" msg={fieldErrors.title} />
        </div>
      )}

      {/* Status — cztery wartości, więc segmenty zamiast rozwijanej listy */}
      <div className="space-y-1">
        <Label>Status</Label>
        <div
          role="radiogroup"
          aria-label="Status"
          className={cn("grid gap-1.5", docked ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}
        >
          {EVENT_STATUS_ORDER.map((st) => {
            const m = EVENT_STATUS_META[st];
            const I = m.icon;
            const active = form.status === st;
            return (
              <button
                key={st}
                type="button"
                role="radio"
                aria-checked={active}
                {...tip(m.hint)}
                data-testid={`status-chip-${st}`}
                onClick={() => set("status", st)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  active ? m.chipActive : cn(m.chip, "bg-background hover:bg-muted")
                )}
              >
                <I className="h-4 w-4 shrink-0" />
                <span className="truncate">{m.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Gdzie (nie dla urlopu ani kafelka notatki) */}
      {!isUrlop && !isNote && (
        <Section
          id="sec-where"
          icon={Building2}
          title="Gdzie"
          open={openSec.where}
          onToggle={() => toggleSec("where")}
          summary={
            selectedObject?.name ??
            (form.objectId ? event?.objectName : null) ??
            form.location ??
            "obiekt, lokalizacja"
          }
        >
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="cal-object">Obiekt</Label>
              {form.objectId && (
                <button
                  type="button"
                  onClick={() => goToObject(Number(form.objectId))}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Karta obiektu
                </button>
              )}
            </div>
            <ObjectPicker
              inputId="cal-object"
              objects={objects}
              value={form.objectId}
              onChange={(id) => {
                set("objectId", id);
                // Podpowiedź adresu do lokalizacji, gdy pusta
                const o = objects.find((x) => String(x.id) === id);
                const addr = o ? [o.address, o.city].filter(Boolean).join(", ") : "";
                if (id && addr && !form.location.trim()) set("location", addr);
              }}
              fallbackName={event?.objectName}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cal-location" className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" /> Lokalizacja
            </Label>
            <Input
              id="cal-location"
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              placeholder="Adres / miejsce"
            />
            {objectAddress && objectAddress !== form.location.trim() && (
              <button
                type="button"
                onClick={() => set("location", objectAddress)}
                className="text-xs text-primary hover:underline"
              >
                Użyj adresu obiektu: {objectAddress}
              </button>
            )}
          </div>
          {cfg.features.routePlanner && form.objectId && (
            <div className="space-y-0.5" aria-live="polite">
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Route className="h-3.5 w-3.5" /> Dojazd (szacowany)
              </span>
              <p className="text-sm">{travelText}</p>
              {travelSource && <p className="text-[11px] text-muted-foreground">{travelSource}</p>}
            </div>
          )}
          {/* Pogoda — tylko dla zapisanego wydarzenia (punkt liczy backend z zapisanych danych). */}
          {cfg.features.weather && event && (
            <div className="space-y-0.5">
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <CloudSun className="h-3.5 w-3.5" /> Pogoda
              </span>
              <WeatherSection
                eventId={event.id}
                brief={weather}
                startAt={event.startAt}
                endAt={event.endAt}
                allDay={event.allDay}
              />
            </div>
          )}
        </Section>
      )}

      {/*
        Szansa i osoba kontaktowa — sekcja działu handlowego. Wybór szansy
        podpowiada tytuł i właściciela, a przede wszystkim ZAWĘŻA listę kontaktów:
        backend przyjmuje tylko osoby należące do szansy albo do jej kontrahenta.
      */}
      {cfg.features.leadPicker && !isNote && !isUrlop && (
        <Section id="sec-lead" icon={Handshake} title="Szansa i kontakt">
          <div className="space-y-1">
            <Label htmlFor="cal-lead">Szansa</Label>
            <LeadPicker
              inputId="cal-lead"
              value={selectedLead}
              onPick={(lead) => {
                setPickedLead(lead);
                setForm((f) => ({
                  ...f,
                  leadId: lead.id,
                  // Podpowiedzi wchodzą tylko w PUSTE pola — nadpisywanie tego,
                  // co planujący już wpisał, byłoby zabraniem mu decyzji.
                  title: f.title.trim() ? f.title : `${eventTypeLabel(f.type)} — ${lead.title}`,
                  assigneeIds:
                    f.assigneeIds.length === 0 && lead.salespersonId != null
                      ? [lead.salespersonId]
                      : f.assigneeIds,
                  // Kontakt spoza nowej szansy przestaje być dozwolony.
                  contactId: null,
                }));
              }}
              onClear={() => {
                setPickedLead(null);
                setForm((f) => ({ ...f, leadId: null, contactId: null }));
              }}
            />
          </div>
          {cfg.features.contactPicker && (
            <div className="space-y-1">
              <Label htmlFor="cal-contact">Osoba kontaktowa</Label>
              <ContactPicker
                inputId="cal-contact"
                contacts={leadContacts}
                value={form.contactId}
                disabled={form.leadId == null}
                onChange={(id) => set("contactId", id)}
              />
              {form.leadId == null ? (
                <p className="text-[11px] text-muted-foreground">
                  Najpierw wskaż szansę — kontakt musi do niej należeć.
                </p>
              ) : (
                selectedContact && (
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    {selectedContact.phone && (
                      <a href={`tel:${selectedContact.phone}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                        <Phone className="h-3.5 w-3.5" /> {selectedContact.phone}
                      </a>
                    )}
                    {selectedContact.email && (
                      <a href={`mailto:${selectedContact.email}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                        <Mail className="h-3.5 w-3.5" /> {selectedContact.email}
                      </a>
                    )}
                    {selectedContact.role && <span className="text-muted-foreground">{selectedContact.role}</span>}
                  </div>
                )
              )}
            </div>
          )}
        </Section>
      )}

      {/* Rozliczenie — gwarancyjny / darmowy / płatny (nie dla urlop/biuro/przygotowanie) */}
      {showBilling && (
        <div className="space-y-1">
          <Label className="flex items-center gap-1">
            <Wallet className="h-3.5 w-3.5" /> Rozliczenie
          </Label>
          <div role="radiogroup" aria-label="Rozliczenie" className="flex flex-wrap gap-1.5">
            {BILLING_ORDER.map((b) => {
              const m = BILLING_META[b];
              const I = m.icon;
              const active = form.billing === b;
              return (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  {...tip(billingTip(b) ?? m.hint)}
                  data-testid={`billing-chip-${b}`}
                  onClick={() => set("billing", b)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    active ? m.chipActive : cn(m.chip, "bg-background hover:bg-muted")
                  )}
                >
                  <I className="h-4 w-4 shrink-0" />
                  {m.label}
                </button>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={form.billing == null}
              data-testid="billing-chip-none"
              onClick={() => set("billing", null)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                form.billing == null
                  ? "border-slate-500 bg-slate-500 text-white"
                  : "border-slate-400/60 bg-background text-muted-foreground hover:bg-muted"
              )}
            >
              Nie dotyczy
            </button>
          </div>
        </div>
      )}

      {/* Kiedy — kafelek notatki ma tylko dzień */}
      {isNote ? (
        <Section id="sec-when" icon={Clock} title="Kiedy">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="cal-start"
              type="date"
              aria-label="Dzień"
              value={dateOf(form.start)}
              aria-invalid={!!fieldErrors.start}
              aria-describedby={fieldErrors.start ? "cal-start-err" : undefined}
              className={cn("w-auto min-w-[9.5rem]", fieldErrors.start && "border-destructive")}
              onChange={(e) => {
                clearWhenErrors();
                if (e.target.value) setForm((f) => ({ ...f, start: e.target.value, end: e.target.value }));
              }}
              data-testid="note-event-date"
            />
            <span className="text-xs text-muted-foreground">cały dzień</span>
          </div>
          <FieldError id="cal-start-err" msg={fieldErrors.start} />
        </Section>
      ) : (
      /* Kiedy — jeden wiersz: Data · od → do · czas trwania */
      <Section id="sec-when" icon={Clock} title="Kiedy">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <Input
            id="cal-start"
            type="date"
            aria-label={multiDay ? "Data początku" : "Data"}
            value={dateOf(form.start)}
            aria-invalid={!!fieldErrors.start}
            aria-describedby={fieldErrors.start ? "cal-start-err" : undefined}
            className={cn("w-auto min-w-[9.5rem]", fieldErrors.start && "border-destructive")}
            onChange={(e) => setStartDate(e.target.value)}
          />
          {!form.allDay && (
            <TimeField
              id="cal-start-time"
              label="Godzina początku"
              mobile={mobile}
              value={timeOf(form.start) || "08:00"}
              onChange={setStartTime}
            />
          )}
          {(!form.allDay || multiDay) && (
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          {multiDay && (
            <Input
              id={form.allDay ? "cal-end" : "cal-end-date"}
              type="date"
              aria-label="Data końca"
              value={dateOf(form.end)}
              min={dateOf(form.start)}
              aria-invalid={!!fieldErrors.end}
              aria-describedby={fieldErrors.end ? "cal-end-err" : undefined}
              className={cn("w-auto min-w-[9.5rem]", fieldErrors.end && "border-destructive")}
              onChange={(e) => setEndDate(e.target.value)}
            />
          )}
          {!form.allDay && (
            <span className="flex items-center gap-1.5">
              <TimeField
                id="cal-end"
                label="Godzina końca"
                mobile={mobile}
                value={timeOf(form.end) || "10:00"}
                onChange={setEndTime}
                durationFrom={multiDay ? undefined : timeOf(form.start) || "08:00"}
                invalid={!!fieldErrors.end}
                describedBy={fieldErrors.end ? "cal-end-err" : undefined}
              />
              {overnight && (
                <span
                  className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
                  {...tip(`Wydarzenie kończy się następnego dnia: ${fmtLong(dateOf(form.end), true)}`)}
                >
                  +1 dzień
                </span>
              )}
            </span>
          )}
          {durationText && (
            <span className="text-xs text-muted-foreground" aria-live="polite">
              ({durationText})
            </span>
          )}
        </div>
        <FieldError id="cal-start-err" msg={fieldErrors.start} />
        <FieldError id="cal-end-err" msg={fieldErrors.end} />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {form.allDay ? (
            multiDay && (
              <DurationChips
                ariaLabel="Liczba dni"
                items={DAY_DURATIONS}
                isActive={(d) => durationDays === d.days}
                onPick={(d) => setDurationDays(d.days)}
              />
            )
          ) : (
            <DurationChips
              ariaLabel="Czas trwania"
              items={HOURS_DURATIONS}
              suffix="godz."
              isActive={(d) => durationMin === d.minutes}
              onPick={(d) => setDurationMinutes(d.minutes)}
            />
          )}
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
            <ToggleChip id="cal-allday" checked={form.allDay} onChange={toggleAllDay}>
              Cały dzień
            </ToggleChip>
            <ToggleChip id="cal-multiday" checked={multiDay} onChange={toggleMultiDay}>
              {form.allDay ? "Więcej dni" : "Wielodniowe"}
            </ToggleChip>
          </div>
        </div>
        {rangeText && (
          <p className="text-xs text-muted-foreground">
            {form.allDay ? "Cały dzień · " : ""}
            {rangeText}
          </p>
        )}
      </Section>
      )}

      {/* Kto (kafelek notatki nie ma przypisanych) */}
      {!isNote && (
      <Section id="sec-who" icon={Users} title={isUrlop ? "Kto *" : "Kto"}>
        {assigneeList.length === 0 ? (
          <p className="text-xs text-muted-foreground">{cfg.assignees.labels.empty}.</p>
        ) : (
          <div
            role="group"
            aria-label={cfg.assignees.labels.many}
            aria-describedby={fieldErrors.assignees ? "cal-assignee-err" : undefined}
            className={cn(
              "flex flex-wrap gap-1.5 rounded-md border p-2",
              fieldErrors.assignees && "border-destructive"
            )}
          >
            {assigneeList.map((t, idx) => {
              const checked = form.assigneeIds.includes(t.id);
              const leave = onLeave.get(t.id);
              const name = `${t.firstName} ${t.lastName}`;
              return (
                <button
                  key={t.id}
                  id={idx === 0 ? "cal-assignee-first" : undefined}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleAssignee(t.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  )}
                >
                  <Avatar
                    name={name}
                    className={cn(
                      "h-5 w-5 text-[9px]",
                      checked && "bg-primary-foreground/20 text-primary-foreground"
                    )}
                  />
                  {name}
                  {checked && <Check className="h-3.5 w-3.5" aria-hidden />}
                  {leave && (
                    <span
                      className="inline-flex items-center gap-0.5 rounded-full bg-rose-500/15 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300"
                      {...tip(
                        `${name} — urlop w tym terminie:\n${leave.leaves
                          .map((l) => fmtRange(l.startAt, l.endAt, l.allDay))
                          .join("\n")}`
                      )}
                    >
                      <TreePalm className="h-3 w-3" /> urlop
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <FieldError id="cal-assignee-err" msg={fieldErrors.assignees} />

        {leaveMessages.length > 0 && (
          <div
            data-testid="cal-leave-conflict"
            role="status"
            className="rounded-md border border-rose-500/50 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-300"
          >
            <div className="flex items-center gap-2 font-medium">
              <TreePalm className="h-4 w-4 shrink-0" />
              {cfg.assignees.labels.one} na urlopie w tym terminie
            </div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {leaveMessages.map((m) => (
                <li key={m.key}>
                  {onOpenEvent ? (
                    <button
                      type="button"
                      onClick={() => onOpenEvent(m.eventId)}
                      className="text-left hover:underline"
                    >
                      {m.text}
                    </button>
                  ) : (
                    m.text
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs opacity-80">Możesz zapisać mimo to.</p>
          </div>
        )}

        {eventConflicts.length > 0 && (
          <div
            role="status"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
          >
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Kolizja terminów — {eventConflicts.length}{" "}
              {plural(eventConflicts.length, "wydarzenie", "wydarzenia", "wydarzeń")} w tym czasie
            </div>
            <ul className="mt-1.5 space-y-1 text-xs">
              {eventConflicts.map((c) => {
                const CI = EVENT_TYPE_META[c.type]?.icon ?? Clock;
                const inner = (
                  <>
                    <CI className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-medium">{c.title}</span>
                    <span className="opacity-80">
                      · {fmtRange(c.startAt, c.endAt, c.allDay)} ·{" "}
                      {assigneesOf(c, cfg).map((t) => `${t.firstName} ${t.lastName}`).join(", ")}
                    </span>
                  </>
                );
                return (
                  <li key={c.id}>
                    {onOpenEvent ? (
                      <button
                        type="button"
                        onClick={() => onOpenEvent(c.id)}
                        {...tip(`Otwórz kolidujące wydarzenie: ${c.title}`)}
                        className="flex flex-wrap items-center gap-1 text-left hover:underline"
                      >
                        {inner}
                        <ExternalLink className="h-3 w-3 opacity-70" />
                      </button>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">{inner}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-xs opacity-80">Możesz zapisać mimo to.</p>
          </div>
        )}
      </Section>
      )}

      {/* Protokół — przypięty jawnie albo wyliczony z realizacji */}
      {showProtocol && (
        <Section
          id="sec-protocol"
          icon={FileCheck2}
          title="Protokół"
          open={openSec.protocol}
          onToggle={() => toggleSec("protocol")}
          summary={
            formProtocol
              ? `${formProtocol.number}${protocolFromRealization ? " (z realizacji)" : ""}`
              : protocolUnpinned
                ? "odpięto"
                : "brak"
          }
        >
          {(() => {
            const kind = protocolBadgeKind({ type: form.type, status: form.status, protocol: formProtocol });
            const meta = kind ? PROTOCOL_BADGE_META[kind] : null;
            const KindIcon = meta?.icon ?? FileCheck2;
            return (
              <div className="space-y-2">
                {formProtocol ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm">
                    <span className={protocolBadgeClass(kind ?? "draft")}>
                      <KindIcon className="h-3.5 w-3.5" />
                      {formProtocol.number}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {kind === "final" ? "podpisany" : "szkic"}
                      {formProtocol.workDate ? ` · ${fmtLong(formProtocol.workDate, true)}` : ""}
                      {protocolFromRealization ? " · z realizacji" : ""}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      <Link
                        to={protocolHref(formProtocol.id)}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Otwórz protokół
                      </Link>
                      {!protocolFromRealization && (
                        <button
                          type="button"
                          data-testid="protocol-unpin"
                          onClick={() => {
                            set("protocolId", null);
                            setPickedProtocol(null);
                          }}
                          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Unlink className="h-3.5 w-3.5" /> Odepnij
                        </button>
                      )}
                    </span>
                  </div>
                ) : kind === "missing" ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={protocolBadgeClass("missing")}>
                      <KindIcon className="h-3.5 w-3.5" />
                      {meta?.label()}
                    </span>
                    <span className="text-muted-foreground">
                      {protocolUnpinned
                        ? "Odpięto — po zapisie wróci protokół realizacji (jeśli istnieje) albo pozostanie brak."
                        : "Wykonane prace bez protokołu — wybierz z listy."}
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {protocolUnpinned
                      ? "Odpięto. Po zapisie wydarzenie dostanie protokół realizacji (jeśli istnieje) albo pozostanie bez protokołu."
                      : "Brak przypiętego protokołu. Jeśli wydarzenie ma realizację, jej protokół pojawi się tu automatycznie."}
                  </p>
                )}
                <ProtocolPicker
                  onPick={(p) => {
                    setPickedProtocol(toEventProtocol(p));
                    set("protocolId", p.id);
                  }}
                />
              </div>
            );
          })()}
        </Section>
      )}

      {/* Wycena — dokument „za ile”; powstaje automatycznie dla prac płatnych */}
      {showQuote && (
        <Section
          id="sec-quote"
          icon={Calculator}
          title="Wycena"
          open={openSec.quote}
          onToggle={() => toggleSec("quote")}
          summary={
            formQuote
              ? `${formQuote.number}${quoteFromRealization ? " (z realizacji)" : ""}`
              : quoteUnpinned
                ? "odpięto"
                : form.billing === "paid"
                  ? mode === "create"
                    ? "powstanie automatycznie"
                    : "brak"
                  : "nie dotyczy"
          }
        >
          {(() => {
            const kind = quoteBadgeKind({ type: form.type, status: form.status, billing: form.billing, quote: formQuote });
            const meta = kind ? QUOTE_BADGE_META[kind] : null;
            const KindIcon = meta?.icon ?? Calculator;
            return (
              <div className="space-y-2">
                {formQuote ? (
                  <div
                    data-testid="quote-linked"
                    className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm"
                  >
                    <span className={quoteBadgeClass(kind ?? "draft")}>
                      <KindIcon className="h-3.5 w-3.5" />
                      {formQuote.number}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {fmtLong(formQuote.date, true)} ·{" "}
                      <span className="tabular-nums">{realizationMoney(formQuote.total)}</span>
                      {formQuote.filledItems === 0 ? " · szkic z cennika" : ""}
                      {quoteFromRealization ? " · z realizacji" : ""}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      <Link
                        to={quoteHref(formQuote.id)}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Otwórz wycenę
                      </Link>
                      {!quoteFromRealization && (
                        <button
                          type="button"
                          data-testid="quote-unpin"
                          onClick={() => {
                            set("quoteId", null);
                            setPickedQuote(null);
                          }}
                          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Unlink className="h-3.5 w-3.5" /> Odepnij
                        </button>
                      )}
                    </span>
                  </div>
                ) : kind === "missing" ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={quoteBadgeClass("missing")}>
                      <KindIcon className="h-3.5 w-3.5" />
                      {meta?.label()}
                    </span>
                    <span className="text-muted-foreground">
                      {quoteUnpinned
                        ? "Odpięto — po zapisie wróci wycena realizacji (jeśli istnieje) albo pozostanie brak."
                        : mode === "create"
                          ? "Praca płatna — wycena powstanie razem z realizacją, z pozycjami z cennika technika."
                          : "Praca płatna bez wyceny — wybierz z listy albo włącz automat w Administracja → Kalendarz."}
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {form.billing !== "paid"
                      ? "Wycena dotyczy tylko prac płatnych — dla gwarancji i prac darmowych nie powstaje."
                      : quoteUnpinned
                        ? "Odpięto. Po zapisie wydarzenie dostanie wycenę realizacji (jeśli istnieje) albo zostanie bez wyceny."
                        : mode === "create"
                          ? "Praca płatna — wycena powstanie razem z realizacją, z pozycjami z cennika technika."
                          : "Brak przypiętej wyceny. Jeśli wydarzenie ma realizację, jej wycena pojawi się tu automatycznie."}
                  </p>
                )}
                <QuotePicker
                  onPick={(q) => {
                    setPickedQuote(toEventQuote(q));
                    set("quoteId", q.id);
                  }}
                />
              </div>
            );
          })()}
        </Section>
      )}

      {/* Realizacja — powiązanie z rejestrem Realizacji (auto lub ręcznie) */}
      {cfg.features.realization && showRealization && (
        <Section
          id="sec-realization"
          icon={Receipt}
          title="Realizacja"
          open={openSec.realization}
          onToggle={() => toggleSec("realization")}
          summary={
            formRealization
              ? `#${formRealization.id} · ${realizationMoney(formRealization.total)}${formRealization.invoiced ? " (zafakturowana)" : ""}`
              : realizationOptedOut
                ? "odpięta ręcznie"
                : realizationUnpinned
                  ? "odpięto"
                  : mode === "create"
                    ? "powstanie automatycznie"
                    : "brak"
          }
        >
          <div className="space-y-2">
            {formRealization ? (
              <div
                data-testid="realization-linked"
                className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm"
              >
                {(() => {
                  const kind = realizationBadgeKind({ realization: formRealization }) ?? "open";
                  const KindIcon = REALIZATION_BADGE_META[kind].icon;
                  return (
                    <span className={realizationBadgeClass(kind)}>
                      <KindIcon className="h-3.5 w-3.5" />#{formRealization.id}
                    </span>
                  );
                })()}
                <span className="text-xs text-muted-foreground">
                  {fmtLong(formRealization.date, true)} · {REALIZATION_KIND_LABEL[formRealization.kind] ?? formRealization.kind} ·{" "}
                  <span className="tabular-nums">{realizationMoney(formRealization.total)}</span>
                  {formRealization.site ? ` · ${formRealization.site}` : ""}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <Link
                    to={realizationHref(formRealization.id, formRealization.date)}
                    data-testid="realization-open"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Otwórz w Realizacjach
                  </Link>
                  <button
                    type="button"
                    data-testid="realization-unpin"
                    onClick={() => {
                      setForm((f) => ({ ...f, realizationId: null, realizationOptout: true }));
                      setPickedRealization(null);
                    }}
                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Unlink className="h-3.5 w-3.5" /> Odepnij
                  </button>
                </span>
              </div>
            ) : realizationOptedOut ? (
              <div
                data-testid="realization-optout"
                className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
              >
                <Unlink className="h-3.5 w-3.5 shrink-0" />
                <span>Ręcznie odpięta — realizacja nie powstanie automatycznie.</span>
                <button
                  type="button"
                  data-testid="realization-optout-off"
                  onClick={() => set("realizationOptout", false)}
                  className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Włącz automat
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="realization-empty">
                {realizationUnpinned
                  ? "Odpięto. Po zapisie wydarzenie zostanie bez realizacji — automat może utworzyć nową zgodnie z ustawieniem."
                  : "Brak powiązanej realizacji. Powstanie automatycznie (przy zapisie albo po oznaczeniu jako wykonane — zgodnie z ustawieniem w Administracja → Kalendarz) albo podepnij istniejącą."}
              </p>
            )}
            {formRealization?.invoiced && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Realizacja jest zafakturowana — zmiany wydarzenia nie będą do niej przenoszone.
              </p>
            )}
            <RealizationPicker
              dateHint={form.start.slice(0, 10)}
              siteHint={selectedObject?.name}
              onPick={(r) => {
                setPickedRealization(toEventRealization(r));
                setForm((f) => ({ ...f, realizationId: r.id, realizationOptout: false }));
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Kwoty i rabat ustawiasz w module Realizacje — kalendarz ich nie nadpisuje.
            </p>
          </div>
        </Section>
      )}

      {/* Powtarzanie — tylko przy tworzeniu (nie dla urlopu) */}

      {mode === "create" && !isUrlop && !isNote && (
        <Section
          id="sec-repeat"
          icon={Repeat}
          title="Powtarzanie"
          open={openSec.repeat}
          onToggle={() => toggleSec("repeat")}
          summary={form.recFreq ? recSummary : "nie powtarzaj"}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_130px]">
            <div className="space-y-1">
              <Label htmlFor="cal-rec-freq">Cykl</Label>
              <select
                id="cal-rec-freq"
                value={form.recFreq}
                onChange={(e) => set("recFreq", e.target.value as FormState["recFreq"])}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Nie powtarzaj</option>
                {(Object.keys(SERIES_FREQ_META) as CalendarSeriesFreq[]).map((f) => (
                  <option key={f} value={f}>
                    {SERIES_FREQ_META[f].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cal-rec-int">Co ile</Label>
              <Input
                id="cal-rec-int"
                type="number"
                min={1}
                max={52}
                value={form.recInterval}
                disabled={!form.recFreq}
                onChange={(e) => set("recInterval", e.target.value)}
              />
            </div>
          </div>
          {form.recFreq && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="rec-mode"
                      checked={form.recMode === "until"}
                      onChange={() => set("recMode", "until")}
                    />
                    <span className="whitespace-nowrap">Do dnia</span>
                    <Input
                      id="cal-rec-until"
                      type="date"
                      value={form.recUntil}
                      min={form.start.slice(0, 10)}
                      disabled={form.recMode !== "until"}
                      aria-invalid={!!fieldErrors.recUntil}
                      aria-describedby={fieldErrors.recUntil ? "cal-rec-until-err" : undefined}
                      className={cn(fieldErrors.recUntil && "border-destructive")}
                      onChange={(e) => set("recUntil", e.target.value)}
                    />
                  </label>
                  <FieldError id="cal-rec-until-err" msg={fieldErrors.recUntil} />
                </div>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="rec-mode"
                      checked={form.recMode === "count"}
                      onChange={() => set("recMode", "count")}
                    />
                    <span className="whitespace-nowrap">Liczba razy</span>
                    <Input
                      id="cal-rec-count"
                      type="number"
                      min={1}
                      max={200}
                      value={form.recCount}
                      disabled={form.recMode !== "count"}
                      aria-invalid={!!fieldErrors.recCount}
                      aria-describedby={fieldErrors.recCount ? "cal-rec-count-err" : undefined}
                      className={cn(fieldErrors.recCount && "border-destructive")}
                      onChange={(e) => set("recCount", e.target.value)}
                    />
                  </label>
                  <FieldError id="cal-rec-count-err" msg={fieldErrors.recCount} />
                </div>
              </div>
              <div className="rounded-md bg-muted/60 px-3 py-2 text-xs">
                <div className="font-medium">{recSummary}</div>
                {occurrences.length > 1 && (
                  <div className="mt-0.5 text-muted-foreground">
                    Najbliższe:{" "}
                    {occurrences
                      .slice(1, 4)
                      .map((d) => fmtLong(d, true))
                      .join(", ")}
                    {occurrences.length > 4 ? ", …" : ""}
                  </div>
                )}
                <div className="mt-0.5 text-muted-foreground">
                  Każde wystąpienie to osobne wydarzenie (własny status, technicy, historia). Maks. 200.
                </div>
              </div>
            </>
          )}
        </Section>
      )}

      {/* Opis (stały) — kafelek notatki go nie ma */}
      {!isNote && (
      <Section
        id="sec-notes"
        icon={FileText}
        title="Opis"
        open={openSec.notes}
        onToggle={() => toggleSec("notes")}
        summary={form.description ? form.description.slice(0, 60) : "brak"}
      >
        <div className="space-y-1">
          <Label htmlFor="cal-desc" className="sr-only">
            Opis
          </Label>
          <Textarea
            id="cal-desc"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            placeholder="Stały opis: zakres prac, kontakt na miejscu, uwagi dla techników…"
          />
          <p className="text-[11px] text-muted-foreground">
            Przebieg i ustalenia dopisuj jako notatki — mają autora i czas.
          </p>
        </div>
      </Section>
      )}

      {/* Notatki (dziennik) — edycja: zapis natychmiastowy; tworzenie: pierwsza notatka po utworzeniu */}
      {isNote ? null : isEdit && event ? (
        <Section
          id="sec-journal"
          icon={StickyNote}
          title={`Notatki (${notesCount})`}
          open={openSec.journal}
          onToggle={() => toggleSec("journal")}
          // Zwinięcie tylko ukrywa kompozytor — szkic (tekst, pliki) i `notesRef` przeżywają.
          keepMounted
          summary={
            <>
              {hasNoteDraft && (
                <span
                  className="mr-1 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-semibold text-amber-800 dark:text-amber-200"
                  data-testid="note-draft-badge"
                  title="Niewysłana notatka czeka w kompozytorze"
                >
                  <StickyNote className="h-3 w-3" aria-hidden /> szkic
                </span>
              )}
              {notesCount ? notesLabel(notesCount) : "brak"}
            </>
          }
        >
          <CalendarEventNotes
            ref={notesRef}
            eventId={event.id}
            initialNotes={notes}
            canEdit={!event.deletedAt}
            onCountChange={handleNotesCount}
            onDraftChange={setHasNoteDraft}
            onOpenMention={cfg.features.noteMentions ? openMention : undefined}
            objectId={event.objectId}
            objectName={event.objectName}
          />
        </Section>
      ) : mode === "create" ? (
        <Section
          id="sec-first-note"
          icon={StickyNote}
          title="Pierwsza notatka"
          open={openSec.firstNote}
          onToggle={() => toggleSec("firstNote")}
          summary={firstNote.trim() ? firstNote.trim().slice(0, 60) : "opcjonalnie"}
        >
          <div className="space-y-1">
            <Label htmlFor="cal-first-note" className="sr-only">
              Pierwsza notatka
            </Label>
            <Textarea
              id="cal-first-note"
              value={firstNote}
              onChange={(e) => setFirstNote(e.target.value)}
              rows={2}
              maxLength={4000}
              placeholder="np. Klient prosi o telefon przed przyjazdem"
              data-testid="first-note-input"
            />
            <p className="text-[11px] text-muted-foreground">Zostanie dodana do dziennika zaraz po utworzeniu wydarzenia.</p>
          </div>
        </Section>
      ) : null}
    </div>
  );

  const historySection = event && (
    <div className="px-5 pb-4">
      <Section
        id="sec-history"
        icon={History}
        title={`Historia (${history.length})`}
        open={openSec.history}
        onToggle={() => toggleSec("history")}
      >
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">Brak wpisów.</p>
        ) : (
          <HistoryTimeline entries={history} />
        )}
      </Section>
    </div>
  );

  const metaLine = event && (
    <span className="truncate text-[11px] text-muted-foreground">
      Utworzył {event.createdByLabel ?? "—"},{" "}
      <time dateTime={event.createdAt} {...tip(`Utworzono: ${fmtTimestamp(event.createdAt)}`)}>
        {fmtRelative(event.createdAt)}
      </time>
      {event.updatedByLabel && event.updatedAt !== event.createdAt && (
        <>
          {" · "}Zmienił {event.updatedByLabel},{" "}
          <time dateTime={event.updatedAt} {...tip(`Ostatnia zmiana: ${fmtTimestamp(event.updatedAt)}`)}>
            {fmtRelative(event.updatedAt)}
          </time>
        </>
      )}
    </span>
  );

  const scrollBody = (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {readOnly ? viewBody : formBody}
      {historySection}
      {error && (
        <div
          role="alert"
          className="mx-5 mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );

  /* Stopka: sticky (na mobile pełny ekran, na desktopie dół dialogu / szuflady) */
  const footer = (
    <div className="shrink-0 border-t bg-background px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {isEdit && !event?.deletedAt && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={saving}
                    onClick={handleDeleteClick}
                  >
                    <Trash2 className="mr-1 h-4 w-4" /> Usuń
                  </Button>
                )}
                <div className="hidden min-w-0 sm:block">{metaLine}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={requestClose} disabled={saving}>
                  {readOnly ? "Zamknij" : "Anuluj"}
                </Button>
                {!readOnly && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSubmit}
                    disabled={saving}
                    {...tip(isEdit ? "Zapisz zmiany w wydarzeniu" : "Utwórz wydarzenie", {
                      shortcut: "Ctrl+Enter",
                    })}
                  >
                    {saving ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-1 h-4 w-4" />
                    )}
                    {saving ? "Zapisywanie…" : mode === "create" ? "Utwórz" : "Zapisz"}
                  </Button>
                )}
              </div>
            </div>
      {metaLine && <div className="mt-1 sm:hidden">{metaLine}</div>}
    </div>
  );

  // Modal zostawiamy zamontowany, żeby Radix dokończył animację zamykania;
  // szuflada nie ma animacji wyjścia, więc znika od razu.
  if (docked && !open) return null;

  return (
    <>
      {docked ? (
        // Szuflada: zwykły panel w siatce strony (kalendarz zwęża się obok), więc bez
        // overlaya i pułapki fokusu. Esc zamyka tak samo jak w oknie modalnym.
        <aside
          role="region"
          aria-label={isEdit ? "Edycja wydarzenia" : "Wydarzenie"}
          data-testid="event-drawer"
          onKeyDown={(e) => {
            onKeyDown(e);
            if (e.key === "Escape") {
              e.stopPropagation();
              requestClose();
            }
          }}
          className="relative flex h-fit min-w-0 flex-col overflow-hidden rounded-lg border bg-background shadow-sm lg:h-full lg:min-h-0"
          {...dropProps}
        >
          {header}
          {scrollBody}
          {footer}
          {dropOverlay}
        </aside>
      ) : (
        <Dialog open={open} onOpenChange={(o) => !o && requestClose()}>
          <DialogContent
            onKeyDown={onKeyDown}
            aria-describedby={undefined}
            className={cn(
              "flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 overflow-hidden p-0",
              "sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-lg",
              "motion-reduce:animate-none motion-reduce:transition-none"
            )}
            {...dropProps}
          >
            {header}
            {scrollBody}
            {footer}
            {dropOverlay}
          </DialogContent>
        </Dialog>
      )}

      {/* Niewysłany szkic notatki i/lub niezapisany formularz — jedno pytanie na wszystkie ścieżki */}
      <AlertDialog open={prompt !== null} onOpenChange={(o) => !o && !promptBusy && setPrompt(null)}>
        <AlertDialogContent
          className="motion-reduce:animate-none"
          data-testid={shownPrompt?.note ? "note-draft-prompt" : "confirm-close-prompt"}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{promptTexts.title}</AlertDialogTitle>
            <AlertDialogDescription>{promptTexts.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={promptBusy} data-testid="note-draft-cancel">
              {promptTexts.cancel}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={promptBusy}
              className={cn(!shownPrompt?.note && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => void resolvePrompt("discard")}
              data-testid="note-draft-discard"
            >
              {promptTexts.discard}
            </Button>
            {shownPrompt?.note && (
              <AlertDialogAction
                disabled={promptBusy}
                onClick={(e) => {
                  e.preventDefault();
                  void resolvePrompt("send");
                }}
                data-testid="note-draft-send"
              >
                {promptBusy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {promptTexts.send}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Potwierdzenie usunięcia (pojedyncze wydarzenie) */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć wydarzenie?</AlertDialogTitle>
            <AlertDialogDescription>
              „{event?.title}” zostanie usunięte. Będzie można je przywrócić zaraz po usunięciu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmDelete(false);
                void doDelete("this");
              }}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Usuń
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Wybór zakresu dla wystąpienia serii */}
      <SeriesScopeDialog
        open={scopeFor !== null}
        action={scopeFor ?? "save"}
        event={event ?? null}
        onCancel={() => setScopeFor(null)}
        onPick={(scope) => {
          const action = scopeFor;
          setScopeFor(null);
          if (action === "save") void doSave(scope);
          else if (action === "delete") void doDelete(scope);
        }}
      />
    </>
  );
}

/**
 * Samodzielny flow usuwania (bez otwierania karty wydarzenia) — używany przez
 * menu kontekstowe w kalendarzu.
 */
export function CalendarDeletePrompt({
  event,
  onCancel,
  onDeleted,
}: {
  event: CalendarEvent | null;
  onCancel: () => void;
  onDeleted?: (event: CalendarEvent, scope: CalendarSeriesScope) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (scope: CalendarSeriesScope) => {
    if (!event || busy) return;
    setBusy(true);
    try {
      await calendarApi.remove(event.id, scope);
      onDeleted?.(event, scope);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Błąd usuwania wydarzenia");
    } finally {
      setBusy(false);
      onCancel();
    }
  };
  if (!event) return null;
  if (event.seriesId) {
    return (
      <SeriesScopeDialog
        open
        action="delete"
        event={event}
        onCancel={onCancel}
        onPick={(scope) => void run(scope)}
      />
    );
  }
  return (
    <AlertDialog open onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent className="motion-reduce:animate-none">
        <AlertDialogHeader>
          <AlertDialogTitle>Usunąć wydarzenie?</AlertDialogTitle>
          <AlertDialogDescription>
            „{event.title}” zostanie usunięte. Będzie można je przywrócić zaraz po usunięciu.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Anuluj</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              void run("this");
            }}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
            Usuń
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Dialog „Tylko to / To i kolejne / Całą serię” z opisem konsekwencji. */
function SeriesScopeDialog({
  open,
  action,
  event,
  onCancel,
  onPick,
}: {
  open: boolean;
  action: "save" | "delete";
  event: CalendarEvent | null;
  onCancel: () => void;
  onPick: (scope: CalendarSeriesScope) => void;
}) {
  const del = action === "delete";
  const idx = event?.seriesIndex;
  const total = event?.seriesTotal;
  const remaining = idx != null && total != null ? total - idx + 1 : null;
  const seriesText =
    event?.series ? seriesShortLabel(event.series.freq, event.series.interval) : "seria";
  const options: {
    scope: CalendarSeriesScope;
    label: string;
    hint: string;
    danger?: boolean;
  }[] = [
    {
      scope: "this",
      label: "Tylko to wystąpienie",
      hint: del
        ? "Usuwa to jedno wydarzenie. Pozostałe terminy serii zostają bez zmian."
        : "Zmiany dotyczą tylko tego terminu. Reszta serii bez zmian — to wystąpienie może się od niej różnić.",
    },
    {
      scope: "future",
      label: "To i kolejne",
      hint: del
        ? `Usuwa to i wszystkie późniejsze wystąpienia${remaining ? ` (${remaining})` : ""}. Wcześniejsze zostają.`
        : `Zmiany zostaną zastosowane do tego i wszystkich późniejszych wystąpień${remaining ? ` (${remaining})` : ""}. Wcześniejsze bez zmian.`,
      danger: del,
    },
    {
      scope: "all",
      label: "Całą serię",
      hint: del
        ? `Usuwa wszystkie wystąpienia serii${total ? ` (${total})` : ""}, również te wykonane.`
        : `Zmiany trafią do wszystkich wystąpień serii${total ? ` (${total})` : ""}, także wcześniejszych.`,
      danger: del,
    },
  ];
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent className="motion-reduce:animate-none">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Repeat className="h-4 w-4 text-teal-600 dark:text-teal-300" />
            {del ? "Usuwanie z serii" : "Zapis w serii"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            To wydarzenie jest częścią serii ({seriesText}
            {idx != null && total != null ? `, wystąpienie ${idx} z ${total}` : ""}).{" "}
            {del ? "Co usunąć?" : "Do których wystąpień zastosować zmiany?"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2">
          {options.map((o) => (
            <button
              key={o.scope}
              type="button"
              onClick={() => onPick(o.scope)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                o.danger && "hover:border-destructive/60 hover:bg-destructive/5"
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                {o.label}
                {o.danger && <Trash2 className="h-3.5 w-3.5 text-destructive" />}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{o.hint}</div>
            </button>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Anuluj</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
