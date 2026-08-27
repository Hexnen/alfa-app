import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  CalendarDays,
  CalendarPlus,
  ClockAlert,
  FileClock,
  Plus,
  Repeat,
  Search,
  Send,
} from "lucide-react";
import { CalendarEventDialog, type CalendarDialogMode } from "@/components/CalendarEventDialog";
import { BillingBadge, ProtocolBadge, RealizationBadge } from "@/components/CalendarEventBadges";
import {
  EVENT_STATUS_META,
  EVENT_TYPE_META,
  EVENT_TYPE_UI,
  activityIcon,
  eventTipData,
  describeActivity,
  fmtRelative,
  initials,
  statusBadgeClass,
  fmtRange,
  fmtTimestamp,
  parseLocal,
  parseTimestamp,
  overdueTip,
} from "@/lib/calendar-labels";
import { tip, tipAttrs } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  activityApi,
  calendarApi,
  getObject,
  getObjectHistory,
  transitionObject,
  type ActivityEntry,
  type CalendarEvent,
  type ObjectWithDetails,
  type ObjectHistoryRecord,
  type WorkflowTransition,
} from "@/lib/api";
import {
  objectTypeLabels,
  installationTypeLabels,
  statusLabels,
  departmentLabels,
  contractStatusLabels,
  formatCurrency,
  formatDate,
} from "@/lib/utils";

const statusColors: Record<string, "warning" | "info" | "success" | "secondary"> = {
  pending: "warning",
  in_progress: "info",
  active: "success",
  inactive: "secondary",
};

const workflowOptions: Record<
  string,
  Array<{ status: string; department: string; label: string }>
> = {
  "pending-sales": [
    {
      status: "in_progress",
      department: "technical",
      label: "Przekaz do dzialu technicznego",
    },
  ],
  "in_progress-technical": [
    { status: "active", department: "accounting", label: "Zakoncz wdrozenie" },
    { status: "pending", department: "sales", label: "Zwroc do handlowego" },
  ],
  "active-accounting": [
    { status: "inactive", department: "accounting", label: "Dezaktywuj" },
  ],
};

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
    type Row =
      | { key: string; at: number; kind: "object"; item: ObjectHistoryRecord }
      | { key: string; at: number; kind: "calendar"; item: ActivityEntry };
    const rows: Row[] = [
      ...history.map((item) => ({
        key: `h-${item.id}`,
        at: parseTimestamp(item.createdAt).getTime(),
        kind: "object" as const,
        item,
      })),
      ...activity.map((item) => ({
        key: `a-${item.id}`,
        at: parseTimestamp(item.createdAt).getTime(),
        kind: "calendar" as const,
        item,
      })),
    ];
    rows.sort((a, b) => b.at - a.at);
    // Agregacja: kilka pól zmienionych w jednej operacji (ten sam event, autor,
    // sekunda) → jeden wpis „zmienił N pól” (pattern audit-feed).
    const out: (Row & { more?: ActivityEntry[] })[] = [];
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
  const [histActor, setHistActor] = useState<string>("");
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
      if (histSource !== "all" && r.kind !== histSource) return false;
      const who = r.kind === "object" ? r.item.changedBy : r.item.userLabel;
      if (histActor && who !== histActor) return false;
      if (q) {
        const text =
          r.kind === "object"
            ? `${r.item.action} ${r.item.description ?? ""} ${who ?? ""}`
            : `${r.item.event?.title ?? ""} ${describeActivity(r.item)}`;
        if (!text.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [mergedHistory, histSource, histActor, histQuery]);
  const [loading, setLoading] = useState(true);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [transitionData, setTransitionData] = useState<WorkflowTransition>({
    newStatus: "pending",
    newDepartment: "sales",
    description: "",
  });

  useEffect(() => {
    if (!id) return;
    Promise.all([getObject(parseInt(id)), getObjectHistory(parseInt(id))])
      .then(([objRes, historyRes]) => {
        setObject(objRes.data!);
        setHistory(historyRes.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  const handleTransition = async () => {
    if (!editable) return;
    if (!object) return;
    try {
      await transitionObject(object.id, transitionData);
      const [objRes, historyRes] = await Promise.all([
        getObject(object.id),
        getObjectHistory(object.id),
      ]);
      setObject(objRes.data!);
      setHistory(historyRes.data);
      setTransitionOpen(false);
    } catch (error) {
      console.error("Error transitioning object:", error);
    }
  };

  if (loading) {
    return <div className="text-center py-8">Ladowanie...</div>;
  }

  if (!object) {
    return <div className="text-center py-8">Obiekt nie znaleziony</div>;
  }

  const currentWorkflowKey = `${object.status}-${object.department}`;
  const availableTransitions = workflowOptions[currentWorkflowKey] || [];

  const actionLabels: Record<string, string> = {
    created: "Utworzono",
    updated: "Zaktualizowano",
    transition: "Zmieniono status",
    contract_created: "Dodano umowe",
    contract_updated: "Zaktualizowano umowe",
    contract_deleted: "Usunieto umowe",
  };

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-3xl font-bold">{object.name}</h1>
        <Badge variant={statusColors[object.status]} className="ml-2">
          {statusLabels[object.status]}
        </Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main info */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Informacje o obiekcie</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-muted-foreground">Kontrahent</dt>
                <dd className="font-medium">{object.contractor?.name || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">NIP</dt>
                <dd>{object.contractor?.nip || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Adres</dt>
                <dd>{object.address || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Miasto</dt>
                <dd>{object.city || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Typ ochrony</dt>
                <dd>{objectTypeLabels[object.type]}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Typ instalacji</dt>
                <dd>{installationTypeLabels[object.installationType]}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Dzial</dt>
                <dd>
                  <Badge variant="outline">
                    {departmentLabels[object.department]}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Wartosc miesieczna
                </dt>
                <dd className="font-medium">
                  {formatCurrency(object.monthlyValue)}
                </dd>
              </div>
              {object.notes && (
                <div className="col-span-2">
                  <dt className="text-sm text-muted-foreground">Uwagi</dt>
                  <dd className="whitespace-pre-wrap">{object.notes}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {/* Workflow actions */}
        <Card>
          <CardHeader>
            <CardTitle>Akcje workflow</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {availableTransitions.length === 0 || !editable ? (
              <p className="text-sm text-muted-foreground">
                Brak dostepnych akcji dla obecnego statusu
              </p>
            ) : (
              availableTransitions.map((transition) => (
                <Button
                  key={`${transition.status}-${transition.department}`}
                  className="w-full"
                  onClick={() => {
                    setTransitionData({
                      newStatus: transition.status as WorkflowTransition["newStatus"],
                      newDepartment: transition.department as WorkflowTransition["newDepartment"],
                      description: "",
                    });
                    setTransitionOpen(true);
                  }}
                >
                  <Send className="h-4 w-4 mr-2" />
                  {transition.label}
                </Button>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tabs for contracts and history */}
      <Tabs defaultValue="contracts">
        <TabsList>
          <TabsTrigger value="contracts">
            Umowy ({object.contracts.length})
          </TabsTrigger>
          <TabsTrigger value="calendar">
            Kalendarz{calEvents.length ? ` (${calEvents.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">Historia</TabsTrigger>
        </TabsList>
        <TabsContent value="contracts">
          <Card>
            <CardContent className="pt-6">
              {object.contracts.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  Brak umow dla tego obiektu
                </p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 font-medium">Nr umowy</th>
                      <th className="text-left py-2 font-medium">
                        Data rozpoczecia
                      </th>
                      <th className="text-left py-2 font-medium">
                        Data zakonczenia
                      </th>
                      <th className="text-right py-2 font-medium">Wartosc</th>
                      <th className="text-left py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {object.contracts.map((contract) => (
                      <tr key={contract.id} className="border-b">
                        <td className="py-2">{contract.contractNumber}</td>
                        <td className="py-2">{formatDate(contract.startDate)}</td>
                        <td className="py-2">
                          {formatDate(contract.endDate) || "-"}
                        </td>
                        <td className="py-2 text-right">
                          {formatCurrency(contract.value)}
                        </td>
                        <td className="py-2">
                          <Badge variant="outline">
                            {contractStatusLabels[contract.status]}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="calendar">
          <Card>
            <CardContent className="space-y-5 pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    Kalendarz obiektu
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {upcoming.length} nadchodzących · {past.length} przeszłych · wydarzenia działu technicznego
                  </p>
                </div>
                {calEditable && (
                  <Button size="sm" onClick={openCalCreate}>
                    <Plus className="mr-1 h-4 w-4" /> Zaplanuj
                  </Button>
                )}
              </div>
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
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="history">
          <Card>
            <CardContent className="space-y-4 pt-5">
              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="radiogroup"
                  aria-label="Źródło wpisów"
                  className="flex rounded-md border p-0.5 text-xs"
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
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                {actors.length > 1 && (
                  <select
                    aria-label="Autor wpisu"
                    value={histActor}
                    onChange={(e) => setHistActor(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">Wszyscy autorzy</option>
                    {actors.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
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
                    const when = row.kind === "object" ? row.item.createdAt : row.item.createdAt;
                    const who =
                      row.kind === "object" ? row.item.changedBy : row.item.userLabel;
                    const evRef = row.kind === "calendar" ? row.item.event : null;
                    const typeUi = evRef ? EVENT_TYPE_UI[evRef.type] : null;
                    const TypeIcon = evRef ? EVENT_TYPE_META[evRef.type]?.icon : null;
                    const ActIcon =
                      row.kind === "calendar" ? activityIcon(row.item.action) : FileClock;
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
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialog wydarzenia kalendarza (prewypełniony obiektem) */}
      <CalendarEventDialog
        key={calNonce}
        open={calDialogOpen}
        mode={calDialogMode}
        event={calDialogEvent}
        prefill={{ objectId: object.id }}
        onClose={() => setCalDialogOpen(false)}
        onSaved={() => loadCalendar(object.id)}
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

      {/* Transition dialog */}
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
                <Label>Nowy dzial</Label>
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
            <Button onClick={handleTransition}>Zatwierdz zmiane</Button>
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
                        className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                        {...tip(overdueTip(ev))}
                      >
                        <ClockAlert className="h-3 w-3" /> po terminie
                      </span>
                    )}
                    <BillingBadge billing={ev.billing} compact />
                    <ProtocolBadge event={ev} compact link />
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
