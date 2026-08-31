/**
 * Planer trasy dnia — mapa + oś czasu (kalendarz → widok „Trasa").
 *
 * Widok jest ROBOCZY i w 100% odczytowy: niczego nie zapisuje w kalendarzu. Podział na
 * samochody, kolejność, kłódki i godzina wyjazdu żyją w localStorage tej przeglądarki
 * (@/lib/route-plan-storage), a proponowane godziny są tylko propozycją.
 *
 * Model kłódek: POTWIERDZONE i WYKONANE są kotwicami (sztywna godzina i pozycja),
 * ZAPLANOWANE planer dopasowuje do nich czasowo i trasowo. Kłódkę można przełączyć
 * ręcznie — to bezpieczne, bo plan i tak nic nie zmienia.
 *
 * Dostępność: mapa jest z natury nieczytelna dla czytnika ekranu, więc oś czasu w panelu
 * jest jej pełnym tekstowym odpowiednikiem, a każda operacja (kłódka, kolejność, przypisanie
 * technika, optymalizacja) jest osiągalna z klawiatury.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  ChevronDown,
  Clock,
  Copy,
  Info,
  Lock,
  Plus,
  Route as RouteIcon,
  Trash2,
  Unlock,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePerms } from "@/auth/permissions";
import {
  adminCompanyApi,
  type AdminCompanySettings,
  type CalendarEvent,
  type DayRoutePoint,
  type Technician,
} from "@/lib/api";
import { EVENT_TYPE_META, fmtMinutes } from "@/lib/calendar-labels";
import { fmtKm } from "@/lib/travel";
import { useDayRoute } from "@/lib/use-day-route";
import {
  assignVehicles,
  buildSchedule,
  canMoveStop,
  effectiveLock,
  planOrder,
  resolveOrder,
  splitOffRoute,
  summarize,
  type LockState,
  type PlanEvent,
  type PlanMatrix,
  type StopReason,
  vehicleLetter,
  type Vehicle,
  type VehiclePlan,
} from "@/lib/route-plan";
import {
  emptyDayPlan,
  readDefaults,
  readPlan,
  writeDefaults,
  writePlan,
  type StoredDayPlan,
} from "@/lib/route-plan-storage";
import { RoutePlannerMap } from "./RoutePlannerMap";

const MAX_VEHICLES = 6;

function newVehicle(index: number): Vehicle {
  return { id: `v${index + 1}`, name: `Samochód ${vehicleLetter(index)}`, technicianIds: [], colorIndex: index };
}

const techLabel = (t: Technician) => `${t.firstName} ${t.lastName}`.trim();

/** "HH:MM" → minuty; null przy pustym albo niepełnym wpisie (pole time bywa puste). */
function hhmmToMin(v: string | undefined | null): number | undefined {
  if (!v || !/^\d{2}:\d{2}$/.test(v)) return undefined;
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
}

/** CalendarEvent → PlanEvent (typowanie strukturalne; route-plan.ts nie zna api.ts). */
function toPlanEvent(ev: CalendarEvent): PlanEvent {
  return {
    id: ev.id,
    title: ev.title,
    type: ev.type,
    status: ev.status,
    startAt: ev.startAt,
    endAt: ev.endAt,
    allDay: ev.allDay,
    objectId: ev.objectId,
    objectName: ev.objectName,
    technicianIds: ev.technicians.map((t) => t.id),
  };
}

export interface RoutePlannerProps {
  /** "YYYY-MM-DD" */
  date: string;
  /** Wydarzenia dnia PO filtrach widoku. */
  events: CalendarEvent[];
  technicians: Technician[];
  loading: boolean;
  fit: boolean;
  onOpenEvent: (ev: CalendarEvent) => void;
  onAnnounce?: (msg: string) => void;
}

export function RoutePlanner({ date, events, technicians, loading, fit, onOpenEvent, onAnnounce }: RoutePlannerProps) {
  const { isAdmin } = usePerms();

  // --- Stan planu (localStorage) ---
  const [plan, setPlanState] = useState<StoredDayPlan>(() => readPlan(date) ?? emptyDayPlan(readDefaults()));
  const [highlight, setHighlight] = useState<number | null>(null);
  const [openOffRoute, setOpenOffRoute] = useState(false);
  const [rateKm, setRateKm] = useState<number | null>(null);
  const [proposal, setProposal] = useState<{ vehicleId: string; order: number[]; km: number; before: number } | null>(null);

  const setPlan = useCallback(
    (update: (prev: StoredDayPlan) => StoredDayPlan) => {
      setPlanState((prev) => {
        const next = update(prev);
        writePlan(date, next);
        return next;
      });
    },
    [date]
  );

  // Stawka km tylko dla admina — endpoint /admin/company/settings jest za `requireAdmin`,
  // a /calendar/day-route celowo nie zwraca żadnych kwot (patrz src/routes/company.ts).
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void adminCompanyApi
      .settings()
      .then((res: AdminCompanySettings) => {
        if (!cancelled) setRateKm(res.values.rateKm ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // --- Dane z backendu ---
  const eventIds = useMemo(() => events.map((e) => e.id), [events]);
  const { route, loading: routeLoading, error: routeError } = useDayRoute(date, eventIds);

  const planEvents = useMemo(() => events.map(toPlanEvent), [events]);
  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  const skipByEvent = useMemo(() => {
    const m = new Map<number, { skip: string; message: string }>();
    for (const e of route?.events ?? []) {
      if (e.skip) m.set(e.eventId, { skip: e.skip, message: e.skipMessage ?? "Poza trasą" });
    }
    return m;
  }, [route]);

  const pointKeyByEvent = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of route?.events ?? []) if (e.pointKey) m.set(e.eventId, e.pointKey);
    return m;
  }, [route]);

  const pointByKey = useMemo(() => {
    const m = new Map<string, DayRoutePoint>();
    for (const p of route?.points ?? []) m.set(p.key, p);
    return m;
  }, [route]);

  const matrix: PlanMatrix | null = route?.matrix ?? null;

  // --- Samochody: domyślnie jeden, z całą załogą dnia ---
  const { onRoute, offRoute, unavailableTechnicianIds } = useMemo(
    () => splitOffRoute({ events: planEvents, skipByEvent }),
    [planEvents, skipByEvent]
  );

  const dayTechnicians = useMemo(() => {
    const ids = new Set<number>();
    for (const e of onRoute) for (const t of e.technicianIds) ids.add(t);
    for (const id of unavailableTechnicianIds) ids.delete(id);
    return technicians.filter((t) => ids.has(t.id));
  }, [onRoute, unavailableTechnicianIds, technicians]);

  /**
   * Samochody obowiązujące w tym dniu. Zapisany plan trzyma WYŁĄCZNIE decyzje użytkownika
   * (nazwy, podział załogi); domyślny jeden samochód i technicy, którzy pojawili się
   * w kalendarzu już po ostatniej ręcznej zmianie, doliczają się tutaj przy renderze.
   * Dzięki temu localStorage nie puchnie od stanu, który i tak wynika z danych.
   */
  const vehicles = useMemo(() => {
    const base = plan.vehicles.length > 0 ? plan.vehicles : [newVehicle(0)];
    const assigned = new Set(base.flatMap((v) => v.technicianIds));
    const missing = dayTechnicians.filter((t) => !assigned.has(t.id)).map((t) => t.id);
    if (missing.length === 0) return base;
    return base.map((v, i) => (i === 0 ? { ...v, technicianIds: [...v.technicianIds, ...missing] } : v));
  }, [plan.vehicles, dayTechnicians]);

  const lockOf = useCallback(
    (ev: PlanEvent): LockState => {
      const l = effectiveLock(ev.status, plan.locks[String(ev.id)]);
      return l === "off-route" ? "free" : l;
    },
    [plan.locks]
  );

  const pointKeyOf = useCallback((ev: PlanEvent) => pointKeyByEvent.get(ev.id) ?? null, [pointKeyByEvent]);

  const assignment = useMemo(() => {
    if (vehicles.length === 0) return null;
    const usable = plan.includeDone ? onRoute : onRoute.filter((e) => e.status !== "done");
    const pins: Record<number, string> = {};
    for (const [k, v] of Object.entries(plan.pins)) pins[Number(k)] = v;
    return assignVehicles({ events: usable, vehicles, pins });
  }, [onRoute, vehicles, plan.pins, plan.includeDone]);

  /** Plan każdego pojazdu: automat → (opcjonalnie) optymalizacja → ręczna korekta. */
  const vehiclePlans = useMemo(() => {
    if (!matrix || !assignment) return [] as { vehicle: Vehicle; plan: VehiclePlan; layer: string }[];
    const officeKey = route?.office?.key ?? null;

    return vehicles.map((vehicle) => {
      const mine = assignment.byVehicle.get(vehicle.id) ?? [];
      const auto = planOrder({
        events: mine,
        date,
        lockOf,
        pointKeyOf,
        matrix,
        officeKey,
        mode: "auto",
        objective: plan.objective,
        earliestDepartMin: hhmmToMin(plan.dayWindow?.from),
        latestReturnMin: hhmmToMin(plan.dayWindow?.to),
      });
      const resolved = resolveOrder({
        autoOrder: auto.order,
        optimizedOrder: plan.optimizedOrder[vehicle.id],
        manualOrder: plan.manualOrder[vehicle.id],
      });
      const byId = new Map(mine.map((e) => [e.id, e]));
      const ordered = resolved.order.map((id) => byId.get(id)).filter((e): e is PlanEvent => !!e);
      const built = buildSchedule({
        vehicle,
        stops: ordered,
        date,
        lockOf,
        reasonOf: (e) =>
          resolved.layer === "manual" ? ("manual" as StopReason) : auto.reasons.get(e.id) ?? ("chronological" as StopReason),
        pointKeyOf,
        matrix,
        officeKey,
        departOverride: plan.depart[vehicle.id] ?? null,
        overflow: auto.overflow,
        anchorConflicts: auto.anchorConflicts,
      });
      return { vehicle, plan: built, layer: resolved.layer };
    });
  }, [matrix, assignment, vehicles, plan.optimizedOrder, plan.manualOrder, plan.depart, plan.objective, plan.dayWindow, route, date, lockOf, pointKeyOf]);

  const totals = useMemo(() => summarize(vehiclePlans.map((v) => v.plan)), [vehiclePlans]);

  const labelOf = useCallback((id: number) => eventById.get(id)?.title ?? `Wydarzenie ${id}`, [eventById]);
  const typeOf = useCallback((id: number) => eventById.get(id)?.type ?? "serwis", [eventById]);

  // --- Akcje ---
  const toggleLock = (eventId: number, current: LockState) => {
    const next: LockState = current === "locked" ? "free" : "locked";
    setPlan((prev) => ({ ...prev, locks: { ...prev.locks, [String(eventId)]: next } }));
    onAnnounce?.(next === "locked" ? "Godzina zablokowana" : "Godzina odblokowana — planer może ją przesunąć");
  };

  const moveStop = (vehicleId: string, stops: VehiclePlan["stops"], from: number, to: number) => {
    const check = canMoveStop(
      stops.map((s) => ({ eventId: s.eventId, lock: s.lock, title: labelOf(s.eventId) })),
      from,
      to
    );
    if (!check.ok) {
      onAnnounce?.(check.reason);
      return;
    }
    const ids = stops.map((s) => s.eventId);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    setPlan((prev) => ({ ...prev, manualOrder: { ...prev.manualOrder, [vehicleId]: ids } }));
    onAnnounce?.(`Przeniesiono „${labelOf(moved)}” na pozycję ${to + 1}`);
  };

  const optimize = (vehicle: Vehicle, current: VehiclePlan) => {
    if (!matrix || !assignment) return;
    const mine = assignment.byVehicle.get(vehicle.id) ?? [];
    const res = planOrder({
      events: mine,
      date,
      lockOf,
      pointKeyOf,
      matrix,
      officeKey: route?.office?.key ?? null,
      mode: "optimized",
      objective: plan.objective,
      earliestDepartMin: hhmmToMin(plan.dayWindow?.from),
      latestReturnMin: hhmmToMin(plan.dayWindow?.to),
    });
    const byId = new Map(mine.map((e) => [e.id, e]));
    const built = buildSchedule({
      vehicle,
      stops: res.order.map((id) => byId.get(id)).filter((e): e is PlanEvent => !!e),
      date,
      lockOf,
      pointKeyOf,
      matrix,
      officeKey: route?.office?.key ?? null,
      departOverride: plan.depart[vehicle.id] ?? null,
      overflow: res.overflow,
      anchorConflicts: res.anchorConflicts,
    });
    setProposal({ vehicleId: vehicle.id, order: res.order, km: built.totals.km, before: current.totals.km });
  };

  const applyProposal = () => {
    if (!proposal) return;
    setPlan((prev) => ({
      ...prev,
      optimizedOrder: { ...prev.optimizedOrder, [proposal.vehicleId]: proposal.order },
      manualOrder: { ...prev.manualOrder, [proposal.vehicleId]: [] },
    }));
    onAnnounce?.(`Zastosowano zoptymalizowaną kolejność: ${fmtKm(proposal.km)}`);
    setProposal(null);
  };

  const resetOrder = (vehicleId: string) => {
    setPlan((prev) => ({
      ...prev,
      manualOrder: { ...prev.manualOrder, [vehicleId]: [] },
      optimizedOrder: { ...prev.optimizedOrder, [vehicleId]: [] },
    }));
    onAnnounce?.("Przywrócono kolejność automatyczną");
  };

  const addVehicle = () => {
    if (vehicles.length >= MAX_VEHICLES) return;
    setPlan((prev) => {
      const next = [...vehicles, newVehicle(vehicles.length)];
      writeDefaults(next);
      return { ...prev, vehicles: next };
    });
  };

  const removeVehicle = (vehicleId: string) => {
    setPlan((prev) => {
      const removed = vehicles.find((v) => v.id === vehicleId);
      const rest = vehicles.filter((v) => v.id !== vehicleId);
      if (rest.length === 0) return prev;
      // Załoga i przypięcia wracają do pierwszego samochodu — plan nie może zgubić ludzi.
      const next = rest.map((v, i) =>
        i === 0 ? { ...v, technicianIds: [...v.technicianIds, ...(removed?.technicianIds ?? [])] } : v
      );
      const pins = Object.fromEntries(Object.entries(prev.pins).filter(([, vid]) => vid !== vehicleId));
      writeDefaults(next);
      return { ...prev, vehicles: next, pins };
    });
  };

  const moveTechnician = (technicianId: number, toVehicleId: string) => {
    setPlan((prev) => ({
      ...prev,
      vehicles: vehicles.map((v) => ({
        ...v,
        technicianIds:
          v.id === toVehicleId
            ? [...new Set([...v.technicianIds, technicianId])]
            : v.technicianIds.filter((t) => t !== technicianId),
      })),
    }));
  };

  const copyAsText = async () => {
    const lines: string[] = [`Plan trasy — ${date}`, ""];
    for (const { vehicle, plan: p } of vehiclePlans) {
      const crew = vehicle.technicianIds
        .map((id) => technicians.find((t) => t.id === id))
        .filter(Boolean)
        .map((t) => techLabel(t as Technician))
        .join(", ");
      lines.push(`${vehicle.name}${crew ? ` (${crew})` : ""}`);
      lines.push(`  ${p.departAt}  wyjazd z biura`);
      p.stops.forEach((s, i) => {
        lines.push(`    ↓ ${fmtMinutes(s.leg.minutes)} · ${fmtKm(s.leg.km)}`);
        lines.push(
          `  ${s.startAt}–${s.endAt}  ${i + 1}. ${labelOf(s.eventId)}${s.lock === "locked" ? " [potwierdzone]" : ""}${
            s.shifted ? ` (w kalendarzu ${s.plannedStartAt})` : ""
          }`
        );
      });
      if (p.returnLeg) lines.push(`    ↓ ${fmtMinutes(p.returnLeg.minutes)} · ${fmtKm(p.returnLeg.km)}`);
      if (p.returnAt) lines.push(`  ${p.returnAt}  powrót do biura`);
      lines.push(
        `  Razem: ${fmtKm(p.totals.km)} · ${fmtMinutes(p.totals.driveMinutes)} jazdy · całość ${fmtMinutes(p.totals.spanMinutes)}`
      );
      lines.push("");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      onAnnounce?.("Plan skopiowany do schowka");
    } catch {
      onAnnounce?.("Nie udało się skopiować planu");
    }
  };

  // --- Render ---
  const busy = loading || routeLoading;
  const allWarnings = vehiclePlans.flatMap((v) => v.plan.warnings);
  const doneCount = onRoute.filter((e) => e.status === "done").length;

  return (
    <div className={cn("cal-route", fit && "flex min-h-0 flex-1 flex-col lg:flex-row lg:gap-3")}>
      <RoutePlannerMap
        className={cn("cal-route-map-wrap", fit ? "min-h-[280px] flex-1 lg:min-h-0" : "h-[420px]")}
        office={route?.office ?? null}
        plans={vehiclePlans.map(({ vehicle, plan: p }) => ({ vehicle, plan: p }))}
        points={pointByKey}
        highlightEventId={highlight}
        onSelectStop={(id) => {
          const ev = eventById.get(id);
          if (ev) onOpenEvent(ev);
        }}
        labelOf={labelOf}
        typeOf={typeOf}
      />

      <div className={cn("cal-route-panel", fit && "lg:w-[400px] lg:min-h-0 lg:overflow-y-auto")}>
        {/* Pasek „plan roboczy" — niezamykalny. Bez niego łatwo pomylić propozycję z kalendarzem. */}
        <p className="cal-route-notice">
          <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Plan roboczy — <strong>nie zmienia kalendarza</strong>. Zapisany tylko w tej przeglądarce.
          </span>
        </p>

        {routeError && <p className="cal-route-error">{routeError}</p>}
        {route?.notes.map((n) => (
          <p key={n} className="cal-route-note">
            {n}
          </p>
        ))}
        {route?.pending && <p className="cal-route-note">Trasy doliczają się w tle — odległości mogą się jeszcze uściślić.</p>}

        <div className="cal-route-summary" aria-live="polite">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <RouteIcon className="h-4 w-4" aria-hidden="true" />
            Dzień łącznie
          </h3>
          {busy && vehiclePlans.length === 0 ? (
            <p className="text-sm text-muted-foreground">Liczę trasę…</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm">
              <li>
                <strong>{fmtKm(totals.km)}</strong> · {fmtMinutes(totals.driveMinutes)} jazdy
              </li>
              <li className="text-muted-foreground">
                praca {fmtMinutes(totals.workMinutes)}
                {totals.idleMinutes > 0 && ` · postoje ${fmtMinutes(totals.idleMinutes)}`}
              </li>
              {totals.lateStops > 0 && (
                <li className="cal-route-badge-late">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {totals.lateStops} spóźnień
                </li>
              )}
              {isAdmin && rateKm != null && totals.km > 0 && (
                <li className="text-muted-foreground">
                  Szacowany koszt: {fmtKm(totals.km)} × {rateKm.toLocaleString("pl-PL", { minimumFractionDigits: 2 })} zł ={" "}
                  <strong>
                    {(totals.km * rateKm).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł
                  </strong>
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="cal-route-window">
          <span>Ramy dnia</span>
          <input
            type="time"
            aria-label="Najwcześniejszy wyjazd"
            value={plan.dayWindow?.from ?? ""}
            onChange={(e) =>
              setPlan((prev) => ({
                ...prev,
                dayWindow: { from: e.target.value, to: prev.dayWindow?.to ?? "" },
              }))
            }
          />
          <span aria-hidden="true">–</span>
          <input
            type="time"
            aria-label="Najpóźniejszy powrót"
            value={plan.dayWindow?.to ?? ""}
            onChange={(e) =>
              setPlan((prev) => ({
                ...prev,
                dayWindow: { from: prev.dayWindow?.from ?? "", to: e.target.value },
              }))
            }
          />
          {plan.dayWindow && (
            <button type="button" className="underline" onClick={() => setPlan((prev) => ({ ...prev, dayWindow: null }))}>
              auto
            </button>
          )}
          <span className="cal-route-window-hint">
            Puste = automatycznie. Potwierdzone terminy i tak mieszczą się zawsze.
          </span>
        </div>

        {doneCount > 0 && (
          <p className="cal-route-note">
            Część dnia jest już wykonana ({doneCount}) — trasa liczy się od miejsca, w którym ekipa była.{" "}
            <button type="button" className="underline" onClick={() => setPlan((p) => ({ ...p, includeDone: !p.includeDone }))}>
              {plan.includeDone ? "Pomiń wykonane" : "Uwzględnij wykonane"}
            </button>
          </p>
        )}

        {/* --- Pojazdy --- */}
        {vehiclePlans.map(({ vehicle, plan: p, layer }) => (
          <section key={vehicle.id} className="cal-route-vehicle" style={{ ["--veh" as string]: `var(--cal-veh-${(vehicle.colorIndex % 6) + 1})` }}>
            <header className="cal-route-vehicle-head">
              <span className="cal-route-vehicle-letter" aria-hidden="true">
                {vehicleLetter(vehicle.colorIndex)}
              </span>
              <input
                className="cal-route-vehicle-name"
                value={vehicle.name}
                aria-label="Nazwa samochodu"
                onChange={(e) =>
                  setPlan((prev) => ({
                    ...prev,
                    vehicles: vehicles.map((v) => (v.id === vehicle.id ? { ...v, name: e.target.value } : v)),
                  }))
                }
              />
              {vehicles.length > 1 && (
                <Button type="button" variant="ghost" size="icon" aria-label={`Usuń ${vehicle.name}`} onClick={() => removeVehicle(vehicle.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </header>

            <div className="cal-route-crew">
              {vehicle.technicianIds.length === 0 && <span className="text-muted-foreground">Brak przypisanych techników</span>}
              {vehicle.technicianIds.map((id) => {
                const t = technicians.find((x) => x.id === id);
                if (!t) return null;
                return (
                  <span key={id} className="cal-route-crew-chip">
                    {techLabel(t)}
                    {vehicles.length > 1 && (
                      <select
                        aria-label={`Przenieś ${techLabel(t)} do innego samochodu`}
                        value={vehicle.id}
                        onChange={(e) => moveTechnician(id, e.target.value)}
                      >
                        {vehicles.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                );
              })}
            </div>

            <div className="cal-route-order-bar">
              <span className={cn("cal-route-layer", layer === "manual" && "is-manual")}>
                {layer === "manual" ? "kolejność zmieniona ręcznie" : layer === "optimized" ? "kolejność zoptymalizowana" : "kolejność automatyczna"}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {layer !== "auto" && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => resetOrder(vehicle.id)}>
                    Wróć do automatycznej
                  </Button>
                )}
                <Button type="button" variant="secondary" size="sm" className="gap-1" onClick={() => optimize(vehicle, p)} disabled={p.stops.length < 2}>
                  <Wand2 className="h-3.5 w-3.5" />
                  Optymalizuj
                </Button>
              </div>
            </div>

            {proposal?.vehicleId === vehicle.id && (
              <div className="cal-route-proposal">
                <p>
                  {fmtKm(proposal.before)} → <strong>{fmtKm(proposal.km)}</strong>{" "}
                  {proposal.km < proposal.before ? `(−${fmtKm(Math.round((proposal.before - proposal.km) * 10) / 10)})` : "(bez poprawy)"}
                </p>
                <div className="flex gap-1">
                  <Button type="button" size="sm" onClick={applyProposal} disabled={proposal.km >= proposal.before}>
                    Zastosuj
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setProposal(null)}>
                    Anuluj
                  </Button>
                </div>
              </div>
            )}

            {/* Oś czasu = tekstowy odpowiednik mapy. */}
            {p.stops.length === 0 ? (
              <p className="cal-route-empty">
                Brak przystanków w tym samochodzie
                {vehicle.technicianIds.length === 0 && " — nie ma w nim żadnego technika"}.
              </p>
            ) : (
            <ol className="cal-route-timeline">
              <li className="cal-route-edge">
                <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                <strong>{p.departAt}</strong> wyjazd z biura
                {p.departsDayBefore && <em> (dzień wcześniej)</em>}
                <input
                  type="time"
                  className="cal-route-depart"
                  aria-label={`Wymuś godzinę wyjazdu dla ${vehicle.name}`}
                  value={plan.depart[vehicle.id] ?? ""}
                  onChange={(e) =>
                    setPlan((prev) => ({ ...prev, depart: { ...prev.depart, [vehicle.id]: e.target.value } }))
                  }
                />
              </li>

              {p.stops.map((stop, i) => {
                const ev = eventById.get(stop.eventId);
                const Meta = ev ? EVENT_TYPE_META[ev.type] : null;
                const Icon = Meta?.icon;
                const locked = stop.lock === "locked";
                return (
                  <li
                    key={stop.eventId}
                    className={cn("cal-route-stop", locked && "is-locked", stop.shifted && "is-shifted")}
                    data-lock={stop.lock}
                    data-shifted={stop.shifted ? "true" : undefined}
                    onMouseEnter={() => setHighlight(stop.eventId)}
                    onMouseLeave={() => setHighlight(null)}
                    onFocus={() => setHighlight(stop.eventId)}
                    onBlur={() => setHighlight(null)}
                  >
                    <p className="cal-route-leg">
                      ↓ {fmtMinutes(stop.leg.minutes)} · {fmtKm(stop.leg.km)}
                      {stop.leg.estimated && <span title="Dystans z linii prostej — trasa jeszcze się nie doliczyła"> ≈</span>}
                      {stop.sameAsPrevious && <span> · to samo miejsce</span>}
                    </p>

                    <div className="cal-route-stop-head">
                      <span className="cal-route-no" aria-hidden="true">
                        {i + 1}
                      </span>
                      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                      <button type="button" className="cal-route-title" onClick={() => ev && onOpenEvent(ev)}>
                        {stop.startAt}–{stop.endAt} {labelOf(stop.eventId)}
                      </button>
                      <button
                        type="button"
                        className="cal-route-lock"
                        aria-pressed={locked}
                        aria-label={locked ? "Odblokuj godzinę (analiza „co gdyby”)" : "Zablokuj godzinę"}
                        title={stop.reasonText}
                        onClick={() => toggleLock(stop.eventId, stop.lock)}
                      >
                        {locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                      </button>
                      <span className="cal-route-move">
                        <button type="button" aria-label="W górę" disabled={i === 0} onClick={() => moveStop(vehicle.id, p.stops, i, i - 1)}>
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          aria-label="W dół"
                          disabled={i === p.stops.length - 1}
                          onClick={() => moveStop(vehicle.id, p.stops, i, i + 1)}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </span>
                    </div>

                    {stop.shifted && (
                      <p className="cal-route-badge-proposal">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        propozycja — w kalendarzu {stop.plannedStartAt}, tu {stop.startAt}
                      </p>
                    )}
                    {stop.lateMinutes > 0 && (
                      <p className="cal-route-badge-late">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> spóźnienie {fmtMinutes(stop.lateMinutes)}
                      </p>
                    )}
                    {stop.idleMinutes > 0 && <p className="cal-route-badge-idle">postój {fmtMinutes(stop.idleMinutes)}</p>}
                  </li>
                );
              })}

              {p.returnLeg && (
                <li className="cal-route-edge">
                  <p className="cal-route-leg">
                    ↓ {fmtMinutes(p.returnLeg.minutes)} · {fmtKm(p.returnLeg.km)}
                  </p>
                  <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <strong>{p.returnAt}</strong> powrót do biura
                </li>
              )}
            </ol>
            )}

            {p.stops.length > 0 && (
              <p className="cal-route-vehicle-total">
                Razem: <strong>{fmtKm(p.totals.km)}</strong>
                {p.totals.driveMinutes > 0 && ` · ${fmtMinutes(p.totals.driveMinutes)} jazdy`}
                {p.totals.spanMinutes > 0 && ` · całość ${fmtMinutes(p.totals.spanMinutes)}`}
              </p>
            )}

            {p.overflow.length > 0 && (
              <div className="cal-route-overflow">
                <h4>Nie mieści się w dniu</h4>
                <ul>
                  {p.overflow.map((o) => (
                    <li key={o.eventId}>
                      <strong>{labelOf(o.eventId)}</strong> — {o.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))}

        {vehicles.length < MAX_VEHICLES && (
          <Button type="button" variant="secondary" size="sm" className="gap-1" onClick={addVehicle}>
            <Plus className="h-3.5 w-3.5" />
            Rozdziel na kolejny samochód
          </Button>
        )}

        {assignment && assignment.unassigned.length > 0 && (
          <div className="cal-route-overflow">
            <h4>Nieprzypisane do samochodu</h4>
            <ul>
              {assignment.unassigned.map((e) => (
                <li key={e.id}>
                  {e.title}
                  {vehicles.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="ml-1 underline"
                      onClick={() => setPlan((prev) => ({ ...prev, pins: { ...prev.pins, [String(e.id)]: v.id } }))}
                    >
                      → {v.name}
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {allWarnings.length > 0 && (
          <div className="cal-route-warnings">
            <h4 className="flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Ostrzeżenia
            </h4>
            <ul>
              {allWarnings
                .filter((w) => w.kind !== "estimated")
                .map((w, i) => (
                  <li key={`${w.kind}-${w.eventId ?? i}`}>{w.message}</li>
                ))}
            </ul>
          </div>
        )}

        {offRoute.length > 0 && (
          <div className="cal-route-offroute">
            <button type="button" className="flex w-full items-center gap-1" onClick={() => setOpenOffRoute((v) => !v)} aria-expanded={openOffRoute}>
              <ChevronDown className={cn("h-4 w-4 transition-transform", !openOffRoute && "-rotate-90")} aria-hidden="true" />
              Poza trasą ({offRoute.length})
            </button>
            {openOffRoute && (
              <ul>
                {offRoute.map(({ event, reason }) => (
                  <li key={event.id}>
                    <strong>{event.title}</strong> — {reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={copyAsText}>
          <Copy className="h-3.5 w-3.5" />
          Kopiuj plan jako tekst
        </Button>
      </div>
    </div>
  );
}
