/**
 * KARTA SZANSY (`/handlowy/leady/:id`).
 *
 * Układ jak w kartotece obiektu: praca po lewej (następny krok, aktywności,
 * oś czasu), fakty po prawej (klient, kontakty, wartość, obiekt, dokumenty).
 * Kolejność nie jest przypadkowa — moduł stoi na zasadzie „każda otwarta szansa
 * ma zaplanowany następny krok”, więc TO jest pierwsza rzecz na ekranie, a brak
 * następnej aktywności krzyczy na czerwono zamiast chować się w tabelce.
 *
 * Aktywności to zwykłe wydarzenia kalendarza działu handlowego — karta używa
 * tego samego dialogu (`CalendarEventDialog` z `SALES_CALENDAR`), więc notatki,
 * załączniki, serie i historia działają tu za darmo.
 *
 * ODSTĘPSTWA od planu §5.6 (świadome):
 * — sekcja „Kontakty” ma własny mały formularz zamiast `ContactDialog` (P2.B),
 *   bez kontaktu nie da się zaplanować telefonu ani wypełnić zlecenia;
 * — „Obiekt” pokazuje adres i link do mapy zamiast `LocationPicker`, bo ten
 *   komponent jest edytowalny (przesuwa pinezkę) i nie ma trybu podglądu.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Building2,
  CalendarPlus,
  Check,
  ClipboardList,
  Clock,
  ExternalLink,
  FilePlus2,
  FileText,
  Handshake,
  History,
  Loader2,
  Mail,
  MapPin,
  NotebookPen,
  Pencil,
  Phone,
  Plus,
  Star,
  Trash2,
  Trophy,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Section } from "@/components/ui/section";
import { tip } from "@/components/ui/tooltip";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { EmptyState } from "@/components/analytics";
import { CalendarEventDialog, type CalendarDialogMode } from "@/components/CalendarEventDialog";
import { ActivityList, splitActivities, type ActivityGroup } from "@/components/sales/ActivityList";
import { LeadConvertDialog } from "@/components/sales/LeadConvertDialog";
import { LeadDialog } from "@/components/sales/LeadDialog";
import { LeadLostDialog } from "@/components/sales/LeadLostDialog";
import { MdPreview } from "@/components/offers/TextEditor";
import { OFFER_STATUS_META } from "@/components/offers/offersShared";
import { usePerms } from "@/auth/permissions";
import {
  calendarApi,
  contactsApi,
  leadsApi,
  type CalendarEvent,
  type Contact,
  type LeadDetail,
  type LeadLostReason,
  type LeadStage,
} from "@/lib/api";
import { SALES_CALENDAR } from "@/lib/calendar-config";
import {
  activityIcon,
  describeActivity,
  fmtRange,
  fmtRelative,
  fmtTimestamp,
  initials,
  pillClass,
} from "@/lib/calendar-labels";
import {
  LEAD_OPEN_STAGES,
  LEAD_SERVICE_META,
  LEAD_STAGE_META,
  isClosedStage,
  leadSourceLabel,
  lostReasonLabel,
  rottingTip,
  stagePillClass,
  weightedValue,
} from "@/lib/sales-labels";
import { cn, formatCurrency, formatDate } from "@/lib/utils";

/**
 * Zakres pobierania aktywności szansy: dwa lata w tył i w przód. Kalendarz
 * pyta o okno, a karta szansy chce WSZYSTKIEGO, co przy niej zaplanowano —
 * przy jednej szansie to i tak kilka wierszy, więc szerokie okno nic nie kosztuje.
 */
const ACTIVITY_WINDOW_DAYS = 730;

const dayOffset = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function HandlowyLeadDetails() {
  const { id } = useParams<{ id: string }>();
  const leadId = Number(id);
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("handlowy/leady");
  const canOrders = canEdit("orders");

  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyStage, setBusyStage] = useState(false);

  // Nagłówek: tytuł edytowany na miejscu (reszta pól idzie przez dialog).
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [notesBusy, setNotesBusy] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [contactFormOpen, setContactFormOpen] = useState(false);

  // Dialog wydarzenia (aktywności): jedna instancja, trzy tryby.
  const [evOpen, setEvOpen] = useState(false);
  const [evMode, setEvMode] = useState<CalendarDialogMode>("create");
  const [evEvent, setEvEvent] = useState<CalendarEvent | null>(null);
  const [evPrefill, setEvPrefill] = useState<{ leadId: number; assigneeIds?: number[] } | null>(null);
  const [evNonce, setEvNonce] = useState(0);

  const load = useCallback(async () => {
    if (!Number.isFinite(leadId)) return;
    setLoading(true);
    try {
      // Karta i aktywności lecą równolegle: `GET /leads/:id` niesie skróty
      // terminów, ale `ActivityList` pracuje na pełnych wydarzeniach (zna
      // „Zrobione” i „Przełóż”), więc bierzemy je wprost z kalendarza.
      const [leadRes, evRes] = await Promise.all([
        leadsApi.get(leadId),
        calendarApi
          .getEvents({
            department: "handlowy",
            leadId,
            from: dayOffset(-ACTIVITY_WINDOW_DAYS),
            to: dayOffset(ACTIVITY_WINDOW_DAYS),
          })
          .catch(() => ({ data: [] as CalendarEvent[] })),
      ]);
      setLead(leadRes.data ?? null);
      setEvents(evRes.data ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się wczytać szansy.");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rot = lead ? rottingTip(lead) : null;

  const setStage = async (stage: LeadStage) => {
    if (!lead || !editable || stage === lead.stage) return;
    if (stage === "przegrany") {
      setLostOpen(true);
      return;
    }
    if (stage === "wygrany") {
      setConvertOpen(true);
      return;
    }
    setBusyStage(true);
    try {
      await leadsApi.setStage(lead.id, { stage });
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zmienić etapu.");
    } finally {
      setBusyStage(false);
    }
  };

  const saveTitle = async () => {
    if (!lead || titleDraft === null) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (!next || next === lead.title) return;
    try {
      await leadsApi.update(lead.id, { title: next });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zapisać tytułu.");
    }
  };

  const saveNotes = async () => {
    if (!lead || notesDraft === null) return;
    setNotesBusy(true);
    try {
      await leadsApi.update(lead.id, { notes: notesDraft.trim() || null });
      setNotesDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zapisać notatki.");
    } finally {
      setNotesBusy(false);
    }
  };

  const removeLead = async () => {
    if (!lead) return;
    if (!window.confirm(`Usunąć szansę „${lead.title}”? Trafi do kosza i da się ją przywrócić.`)) return;
    try {
      await leadsApi.remove(lead.id);
      navigate("/handlowy/leady");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się usunąć szansy.");
    }
  };

  /** Nowa aktywność: szansa i jej opiekun wchodzą do formularza z góry. */
  const planActivity = () => {
    if (!lead) return;
    setEvMode("create");
    setEvEvent(null);
    setEvPrefill({
      leadId: lead.id,
      assigneeIds: lead.salespersonId != null ? [lead.salespersonId] : undefined,
    });
    setEvNonce((n) => n + 1);
    setEvOpen(true);
  };

  const openActivity = (ev: CalendarEvent) => {
    setEvMode(editable && !ev.deletedAt ? "edit" : "view");
    setEvEvent(ev);
    setEvPrefill(null);
    setEvNonce((n) => n + 1);
    setEvOpen(true);
  };

  const weighted = lead ? weightedValue(lead) : 0;

  const stageIndex = lead ? LEAD_STAGE_META[lead.stage]?.order ?? 0 : 0;

  const history = useMemo(() => (lead?.history ?? []).slice(0, 100), [lead]);

  // Kubełki liczy `splitActivities` (wspólne z ekranem Aktywności i pulpitem);
  // horyzont rozciągamy na całe pobrane okno — karta szansy pokazuje WSZYSTKO,
  // co przy niej zaplanowano, a nie tylko najbliższy tydzień.
  const buckets = useMemo(
    () => splitActivities(events, { upcomingDays: ACTIVITY_WINDOW_DAYS, doneDays: ACTIVITY_WINDOW_DAYS }),
    [events]
  );
  /** Następny krok = najbliższa niewykonana aktywność (dziś przed przyszłymi). */
  const nextEvent = buckets.today[0] ?? buckets.upcoming[0] ?? null;
  const activityCount =
    buckets.overdue.length + buckets.today.length + buckets.upcoming.length + buckets.done.length;

  if (loading && !lead) {
    return (
      <div className="py-10 text-center text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
        Ładowanie szansy…
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="space-y-4">
        <Link to="/handlowy/leady" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Wróć do listy szans
        </Link>
        <EmptyState
          icon={Handshake}
          title="Nie znaleziono szansy"
          description={error ?? "Szansa mogła zostać usunięta albo nie masz do niej dostępu."}
          actionLabel="Lista szans"
          actionHref="/handlowy/leady"
        />
      </div>
    );
  }

  const StageIcon = LEAD_STAGE_META[lead.stage]?.icon ?? Handshake;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/handlowy/leady"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Szanse sprzedaży
        </Link>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={planActivity} data-testid="lead-plan-activity">
              <CalendarPlus className="mr-1.5 h-4 w-4" />
              Nowa aktywność
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/technical/oferty?leadId=${lead.id}`)}
              data-testid="lead-new-offer"
            >
              <FilePlus2 className="mr-1.5 h-4 w-4" />
              Nowa oferta
            </Button>
            <span
              {...(lead.orderId
                ? tip(`Szansa ma już zlecenie ${lead.orderNumber ?? `#${lead.orderId}`}`)
                : {})}
            >
              <Button
                size="sm"
                variant="outline"
                disabled={lead.orderId != null || !canOrders}
                onClick={() => navigate(`/orders/formularz?leadId=${lead.id}`)}
                data-testid="lead-create-order"
              >
                <ClipboardList className="mr-1.5 h-4 w-4" />
                Utwórz zlecenie
              </Button>
            </span>
            {!isClosedStage(lead.stage) && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConvertOpen(true)}
                  data-testid="lead-mark-won"
                >
                  <Trophy className="mr-1.5 h-4 w-4 text-emerald-600" />
                  Wygrana
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setLostOpen(true)}
                  data-testid="lead-mark-lost"
                >
                  <XCircle className="mr-1.5 h-4 w-4 text-red-600" />
                  Przegrana
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)} {...tip("Edytuj szansę")}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={removeLead} {...tip("Usuń szansę (kosz)")}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        )}
      </div>

      {!editable && <ReadOnlyBanner />}

      {error && (
        <p
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="lead-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {titleDraft === null ? (
            <h1
              className="text-2xl font-semibold tracking-tight"
              data-testid="lead-title"
              onDoubleClick={() => editable && setTitleDraft(lead.title)}
            >
              {lead.title}
            </h1>
          ) : (
            <span className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={titleDraft}
                data-testid="lead-title-input"
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveTitle();
                  if (e.key === "Escape") setTitleDraft(null);
                }}
                className="h-9 w-[26rem] max-w-full text-lg font-semibold"
              />
              <Button size="sm" onClick={() => void saveTitle()}>
                <Check className="h-4 w-4" />
              </Button>
            </span>
          )}
          <span className={stagePillClass(lead.stage)} data-testid="lead-stage-pill">
            <StageIcon className="h-3.5 w-3.5" aria-hidden />
            {LEAD_STAGE_META[lead.stage]?.label ?? lead.stage}
          </span>
          {rot && (
            <span className={pillClass("amber")} {...tip(rot)} data-testid="lead-rotting">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Wymaga uwagi
            </span>
          )}
          {editable && titleDraft === null && (
            <button
              type="button"
              onClick={() => setTitleDraft(lead.title)}
              {...tip("Zmień tytuł")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Zmień tytuł"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {lead.clientLabel || "Klient nieokreślony"}
          {lead.salespersonName ? ` · opiekun: ${lead.salespersonName}` : " · bez opiekuna"}
          {lead.source ? ` · źródło: ${leadSourceLabel(lead.source)}` : ""}
        </p>

        {/* Stepper etapów: klik = PATCH. Zamknięcia stoją poza ścieżką — mają
            własne przyciski, bo wymagają powodu albo konwersji. */}
        <div className="flex flex-wrap items-center gap-1" data-testid="lead-stepper">
          {LEAD_OPEN_STAGES.map((s) => {
            const meta = LEAD_STAGE_META[s];
            const Icon = meta.icon;
            const done = meta.order < stageIndex;
            const current = s === lead.stage;
            return (
              <button
                key={s}
                type="button"
                disabled={!editable || busyStage || current}
                onClick={() => void setStage(s)}
                data-testid={`lead-stage-${s}`}
                {...tip(meta.hint)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
                  current && "border-primary bg-primary/10 text-primary",
                  !current && done && "bg-muted text-muted-foreground",
                  !current && !done && "text-muted-foreground hover:bg-muted",
                  !editable && "cursor-default"
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {meta.label}
              </button>
            );
          })}
          {isClosedStage(lead.stage) && (
            <span className={cn(stagePillClass(lead.stage), "ml-1")}>
              {LEAD_STAGE_META[lead.stage].label}
              {lead.lostReason ? ` — ${lostReasonLabel(lead.lostReason)}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- Lewa kolumna: praca --- */}
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="p-4">
              <Section icon={Clock} title="Następny krok" id="lead-next">
                {nextEvent ? (
                  <ActivityList
                    events={[nextEvent]}
                    grouping={buckets.today.includes(nextEvent) ? "today" : "upcoming"}
                    testIdPrefix="lead-next"
                    onOpen={openActivity}
                    onDone={() => void load()}
                    onPostpone={() => void load()}
                  />
                ) : isClosedStage(lead.stage) ? (
                  <p className="text-sm text-muted-foreground">
                    Szansa zamknięta — następny krok nie jest już potrzebny.
                  </p>
                ) : (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-3 py-3 dark:border-red-500/40 dark:bg-red-500/10"
                    data-testid="lead-no-next"
                  >
                    <p className="text-sm font-medium text-red-700 dark:text-red-300">
                      Brak zaplanowanej następnej aktywności — szansa bez następnego kroku umiera po cichu.
                    </p>
                    {editable && (
                      <Button size="sm" onClick={planActivity} data-testid="lead-plan-next">
                        <CalendarPlus className="mr-1.5 h-4 w-4" />
                        Zaplanuj następną aktywność
                      </Button>
                    )}
                  </div>
                )}
              </Section>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <Section
                icon={CalendarPlus}
                title="Aktywności"
                id="lead-activities"
                action={
                  editable ? (
                    <Button size="sm" variant="ghost" onClick={planActivity}>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Dodaj
                    </Button>
                  ) : undefined
                }
              >
                <div className="space-y-4" data-testid="lead-activity-list">
                  {activityCount === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nic jeszcze nie zaplanowano ani nie wykonano.
                    </p>
                  ) : (
                    (
                      [
                        ["Zaległe", "overdue", buckets.overdue],
                        ["Dziś", "today", buckets.today],
                        ["Nadchodzące", "upcoming", buckets.upcoming],
                        ["Wykonane", "done", buckets.done],
                      ] as [string, ActivityGroup, CalendarEvent[]][]
                    ).map(([label, group, list]) =>
                      list.length === 0 ? null : (
                        <div key={group} className="space-y-1.5">
                          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <span
                              className={pillClass(
                                group === "overdue" ? "red" : group === "done" ? "muted" : "sky",
                                { compact: true }
                              )}
                            >
                              {list.length}
                            </span>
                            {label}
                          </p>
                          <ActivityList
                            events={list}
                            grouping={group}
                            testIdPrefix={`lead-${group}`}
                            onOpen={openActivity}
                            onDone={() => void load()}
                            onPostpone={() => void load()}
                          />
                        </div>
                      )
                    )
                  )}
                </div>
              </Section>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <Section icon={History} title="Oś czasu" id="lead-history">
                {history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Brak historii dla tej szansy.</p>
                ) : (
                  <ol className="relative ml-3 border-l pl-5" data-testid="lead-timeline">
                    {history.map((entry) => {
                      const Icon = activityIcon(entry.action);
                      return (
                        <li key={`${entry.entityType}-${entry.id}`} className="relative pb-4 last:pb-0">
                          <span
                            aria-hidden
                            className="absolute -left-[1.6rem] top-1 flex h-4 w-4 items-center justify-center rounded-full bg-muted-foreground/60 ring-4 ring-background"
                          >
                            <Icon className="h-2.5 w-2.5 text-white" />
                          </span>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-0.5">
                              <p className="text-sm">{describeActivity(entry)}</p>
                              {entry.event && (
                                <p className="text-xs text-muted-foreground">
                                  {entry.event.title} ·{" "}
                                  {fmtRange(entry.event.startAt, entry.event.endAt, entry.event.allDay)}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {entry.userLabel && (
                                <span
                                  {...tip(`Autor zmiany: ${entry.userLabel}`)}
                                  className="hidden h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold uppercase text-muted-foreground sm:inline-flex"
                                >
                                  {initials(entry.userLabel)}
                                </span>
                              )}
                              <time
                                dateTime={entry.createdAt}
                                {...tip(fmtTimestamp(entry.createdAt))}
                                className="whitespace-nowrap text-xs text-muted-foreground"
                              >
                                {fmtRelative(entry.createdAt)}
                              </time>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Section>
            </CardContent>
          </Card>
        </div>

        {/* --- Prawa kolumna: fakty --- */}
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 p-4">
              <Section icon={Users} title="Klient" id="lead-client">
                {lead.contractorId ? (
                  <div className="space-y-1 text-sm">
                    <Link
                      to={`/contractors?contractorId=${lead.contractorId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {lead.contractorName ?? `Kontrahent #${lead.contractorId}`}
                    </Link>
                    <p className="text-xs text-muted-foreground">Kontrahent w kartotece</p>
                  </div>
                ) : (
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">{lead.prospectName ?? "Prospekt bez nazwy"}</p>
                    {lead.prospectNip && (
                      <p className="text-xs text-muted-foreground">NIP {lead.prospectNip}</p>
                    )}
                    {lead.prospectPhone && (
                      <a
                        href={`tel:${lead.prospectPhone}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Phone className="h-3 w-3" /> {lead.prospectPhone}
                      </a>
                    )}
                    {lead.prospectEmail && (
                      <a
                        href={`mailto:${lead.prospectEmail}`}
                        className="ml-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Mail className="h-3 w-3" /> {lead.prospectEmail}
                      </a>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Kartoteka powstanie przy wygranej („Wygrana” → kontrahent + obiekt).
                    </p>
                  </div>
                )}
              </Section>

              <Section
                icon={UserPlus}
                title="Kontakty"
                id="lead-contacts"
                action={
                  editable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setContactFormOpen((o) => !o)}
                      data-testid="lead-contact-add"
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Dodaj
                    </Button>
                  ) : undefined
                }
              >
                <div className="space-y-2">
                  {lead.contacts.length === 0 && !contactFormOpen && (
                    <p className="text-sm text-muted-foreground">
                      Brak osób kontaktowych — bez nazwiska i telefonu szansa wisi w próżni.
                    </p>
                  )}
                  {lead.contacts.map((c) => (
                    <ContactRow key={c.id} contact={c} editable={editable} onChanged={load} />
                  ))}
                  {contactFormOpen && editable && (
                    <LeadContactForm
                      leadId={lead.id}
                      contractorId={lead.contractorId}
                      onCancel={() => setContactFormOpen(false)}
                      onSaved={async () => {
                        setContactFormOpen(false);
                        await load();
                      }}
                    />
                  )}
                </div>
              </Section>

              <Section icon={Banknote} title="Wartość" id="lead-value">
                <dl className="space-y-1.5 text-sm">
                  <Row
                    label="Abonament"
                    value={lead.estimatedMonthly != null ? `${formatCurrency(lead.estimatedMonthly)}/mies.` : "—"}
                  />
                  <Row
                    label="Wdrożenie"
                    value={lead.estimatedSetup != null ? formatCurrency(lead.estimatedSetup) : "—"}
                  />
                  <Row label="Prawdopodobieństwo" value={lead.probability != null ? `${lead.probability}%` : "—"} />
                  <Row label="Ważony abonament" value={`${formatCurrency(weighted)}/mies.`} />
                  <Row
                    label="Przewidywane zamknięcie"
                    value={lead.expectedCloseDate ? formatDate(lead.expectedCloseDate) : "—"}
                  />
                  <Row
                    label="Ostatni kontakt"
                    value={lead.lastActivityAt ? fmtRelative(lead.lastActivityAt) : "—"}
                  />
                </dl>
                {lead.services.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {lead.services.map((s) => {
                      const meta = LEAD_SERVICE_META[s];
                      if (!meta) return null;
                      const Icon = meta.icon;
                      return (
                        <span key={s} className={pillClass(meta.tone, { compact: true })}>
                          <Icon className="h-2.5 w-2.5" aria-hidden />
                          {meta.label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </Section>

              <Section icon={Building2} title="Obiekt" id="lead-object">
                <div className="space-y-1 text-sm">
                  {lead.objectId ? (
                    <Link
                      to={`/objects/${lead.objectId}`}
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                      data-testid="lead-object-link"
                    >
                      {lead.objectName ?? `Obiekt #${lead.objectId}`}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  ) : (
                    <p className="text-muted-foreground">
                      Obiekt powstanie przy wygranej szansie.
                    </p>
                  )}
                  {lead.objectKind && <p className="text-xs text-muted-foreground">{lead.objectKind}</p>}
                  {(lead.address || lead.city) && (
                    <p className="flex items-start gap-1 text-xs text-muted-foreground">
                      <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                      {[lead.address, lead.city].filter(Boolean).join(", ")}
                    </p>
                  )}
                  {lead.mapsUrl && (
                    <a
                      href={lead.mapsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <MapPin className="h-3 w-3" /> Pokaż na mapie
                    </a>
                  )}
                </div>
              </Section>

              <Section icon={FileText} title="Oferty" id="lead-offers">
                {lead.offers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Brak ofert powiązanych z tą szansą.
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {lead.offers.map((o) => {
                      const meta = OFFER_STATUS_META[o.status];
                      return (
                        <li key={o.id} className="flex items-center justify-between gap-2">
                          <Link
                            to={`/technical/oferty?offerId=${o.id}`}
                            className="truncate text-primary hover:underline"
                          >
                            {o.number}
                          </Link>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className="tabular-nums text-muted-foreground">
                              {formatCurrency(o.totals?.monthlyTotal ?? 0)}/mies.
                            </span>
                            {meta && <span className={pillClass(meta.tone, { compact: true })}>{meta.label}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>

              <Section icon={ClipboardList} title="Zlecenie" id="lead-order">
                {lead.orders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Zlecenia jeszcze nie ma. Przycisk „Utwórz zlecenie” wypełni formularz danymi szansy.
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {lead.orders.map((o) => (
                      <li key={o.id}>
                        <Link to={`/orders/${o.id}`} className="text-primary hover:underline">
                          {o.orderNumber}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">{o.objectName}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section icon={NotebookPen} title="Notatka" id="lead-notes">
                {notesDraft === null ? (
                  <div className="space-y-2">
                    {lead.notes ? (
                      <MdPreview body={lead.notes} />
                    ) : (
                      <p className="text-sm text-muted-foreground">Brak notatki.</p>
                    )}
                    {editable && (
                      <Button size="sm" variant="outline" onClick={() => setNotesDraft(lead.notes ?? "")}>
                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                        {lead.notes ? "Edytuj notatkę" : "Dodaj notatkę"}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Textarea
                      rows={6}
                      autoFocus
                      value={notesDraft}
                      data-testid="lead-notes-input"
                      onChange={(e) => setNotesDraft(e.target.value)}
                      placeholder="Ustalenia, potrzeby, konkurencja… (prosty markdown: **pogrubienie**, listy)"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void saveNotes()} disabled={notesBusy}>
                        {notesBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Zapisz
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setNotesDraft(null)} disabled={notesBusy}>
                        Anuluj
                      </Button>
                    </div>
                  </div>
                )}
              </Section>
            </CardContent>
          </Card>
        </div>
      </div>

      {editOpen && (
        <LeadDialog
          open={editOpen}
          mode="edit"
          lead={lead}
          onClose={() => setEditOpen(false)}
          onSaved={() => void load()}
        />
      )}

      {lostOpen && (
        <LeadLostDialog
          open
          leadTitle={lead.title}
          onClose={() => setLostOpen(false)}
          onConfirm={async (reason: LeadLostReason, note) => {
            await leadsApi.setStage(lead.id, { stage: "przegrany", lostReason: reason, lostNote: note });
            await load();
          }}
        />
      )}

      {convertOpen && (
        <LeadConvertDialog
          open
          lead={lead}
          onClose={() => setConvertOpen(false)}
          onConverted={() => {
            setConvertOpen(false);
            void load();
          }}
        />
      )}

      {evOpen && (
        <CalendarEventDialog
          key={evNonce}
          config={SALES_CALENDAR}
          open={evOpen}
          mode={evMode}
          event={evEvent}
          prefill={evPrefill}
          onClose={() => setEvOpen(false)}
          onSaved={() => {
            setEvOpen(false);
            void load();
          }}
          onDeleted={() => {
            setEvOpen(false);
            void load();
          }}
          onEdit={editable ? () => setEvMode("edit") : undefined}
          onPlanNext={(prefill) => {
            // „Zaplanuj następną” z wykonanej aktywności: ten sam dialog, tryb create.
            setEvMode("create");
            setEvEvent(null);
            setEvPrefill({
              leadId: prefill.leadId ?? lead.id,
              assigneeIds: prefill.assigneeIds,
            });
            setEvNonce((n) => n + 1);
            setEvOpen(true);
          }}
        />
      )}
    </div>
  );
}

/** Wiersz „etykieta — wartość” w kolumnie faktów. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
/** Osoba kontaktowa na karcie: gwiazdka = główna u kontrahenta. */
function ContactRow({
  contact,
  editable,
  onChanged,
}: {
  contact: Contact;
  editable: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const name = contact.fullName || `${contact.firstName} ${contact.lastName}`.trim();
  const togglePrimary = async () => {
    if (!editable || busy) return;
    setBusy(true);
    try {
      await contactsApi.update(contact.id, { isPrimary: !contact.isPrimary });
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-2 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {name}
          {contact.role ? <span className="text-muted-foreground"> — {contact.role}</span> : null}
        </p>
        <p className="flex flex-wrap gap-2 text-xs">
          {contact.phone && (
            <a href={`tel:${contact.phone}`} className="inline-flex items-center gap-1 text-primary hover:underline">
              <Phone className="h-3 w-3" /> {contact.phone}
            </a>
          )}
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1 text-primary hover:underline">
              <Mail className="h-3 w-3" /> {contact.email}
            </a>
          )}
          {!contact.active && <span className="text-muted-foreground">(nieaktywny)</span>}
        </p>
      </div>
      {editable && (
        <button
          type="button"
          onClick={() => void togglePrimary()}
          disabled={busy}
          {...tip(contact.isPrimary ? "Główna osoba kontaktowa" : "Ustaw jako główną")}
          aria-pressed={contact.isPrimary}
          className={cn(
            "shrink-0 rounded p-1 hover:bg-muted",
            contact.isPrimary ? "text-amber-500" : "text-muted-foreground"
          )}
        >
          <Star className={cn("h-4 w-4", contact.isPrimary && "fill-current")} />
        </button>
      )}
    </div>
  );
}

/**
 * Mały formularz osoby kontaktowej. Świadomie lokalny: pełny `ContactDialog`
 * powstaje w paczce P2.B, a karta szansy nie może na niego czekać — bez kontaktu
 * nie da się zaplanować telefonu ani wypełnić zlecenia.
 */
function LeadContactForm({
  leadId,
  contractorId,
  onCancel,
  onSaved,
}: {
  leadId: number;
  contractorId: number | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!lastName.trim()) {
      setError("Nazwisko jest wymagane.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await contactsApi.create({
        leadId,
        contractorId,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        role: role.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        // Flagę „główny” trzyma kontrahent — przy prospekcie nie ma jej gdzie zapisać.
        isPrimary: contractorId != null ? isPrimary : false,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zapisać kontaktu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed p-2.5" data-testid="lead-contact-form">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="lead-contact-first" className="text-xs">
            Imię
          </Label>
          <Input
            id="lead-contact-first"
            className="h-8"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="lead-contact-last" className="text-xs">
            Nazwisko
          </Label>
          <Input
            id="lead-contact-last"
            className="h-8"
            data-testid="lead-contact-lastname"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
        <div className="space-y-1 col-span-2">
          <Label htmlFor="lead-contact-role" className="text-xs">
            Rola
          </Label>
          <Input
            id="lead-contact-role"
            className="h-8"
            placeholder="np. zarządca, prezes zarządu"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="lead-contact-phone" className="text-xs">
            Telefon
          </Label>
          <Input
            id="lead-contact-phone"
            className="h-8"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="lead-contact-email" className="text-xs">
            E-mail
          </Label>
          <Input
            id="lead-contact-email"
            className="h-8"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      {contractorId != null && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
          Główna osoba kontaktowa u kontrahenta
        </label>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy} data-testid="lead-contact-save">
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Zapisz
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Anuluj
        </Button>
      </div>
    </div>
  );
}

export default HandlowyLeadDetails;
