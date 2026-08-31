/**
 * Test logiki planera trasy (frontend/src/lib/route-plan.ts):
 *   npx tsx scripts/test-route-plan.ts
 *
 * UWAGA: w odróżnieniu od pozostałych skryptów test-* ten NIE dotyka bazy ani sieci —
 * cała logika jest czysta, a dane są syntetyczne. Dlatego nie ma tu sprzątania.
 *
 * Zakres: kłódki (potwierdzone i wykonane jako kotwice), wstawianie elastycznych w okna
 * między kotwicami, konflikt samych kotwic (bez ich przestawiania), wydarzenia, które nie
 * mieszczą się w dniu, degeneracja do dokładnego TSP przy zerze kotwic, determinizm,
 * oś czasu (wyjazd liczony wstecz, spóźnienia, postoje, powrót), ręczna kolejność,
 * podział na samochody i wykluczanie techników na urlopie.
 */
import {
  assignVehicles,
  buildSchedule,
  canMoveStop,
  defaultLock,
  effectiveLock,
  fromMinutes,
  planOrder,
  resolveOrder,
  splitOffRoute,
  summarize,
  type LockState,
  type PlanEvent,
  type PlanMatrix,
  type StopReason,
  type Vehicle,
} from "../frontend/src/lib/route-plan.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const DATE = "2031-03-10";

// --- Macierz testowa: celowo ASYMETRYCZNA (jak prawdziwa odpowiedź OSRM) ---
const KEYS = ["office", "A", "B", "C"];
//            office   A     B     C
const KM = [
  [0, 20, 40, 60], // z office
  [21, 0, 25, 50], // z A
  [41, 26, 0, 30], // z B
  [61, 51, 31, 0], // z C
];
const MIN = [
  [0, 30, 50, 70],
  [31, 0, 35, 60],
  [51, 36, 0, 40],
  [71, 61, 41, 0],
];
const matrix: PlanMatrix = {
  keys: KEYS,
  km: KM,
  minutes: MIN,
  method: KEYS.map(() => KEYS.map(() => "route" as const)),
};

const POINT: Record<number, string> = {};
let nextId = 1;
function ev(v: {
  key: string;
  from: string;
  to: string;
  status?: string;
  type?: string;
  techs?: number[];
  title?: string;
}): PlanEvent {
  const id = nextId++;
  POINT[id] = v.key;
  return {
    id,
    title: v.title ?? `${v.key} ${v.from}`,
    type: v.type ?? "serwis",
    status: v.status ?? "planned",
    startAt: `${DATE}T${v.from}`,
    endAt: `${DATE}T${v.to}`,
    allDay: false,
    objectId: 100 + id,
    objectName: v.key,
    technicianIds: v.techs ?? [],
  };
}

const pointKeyOf = (e: PlanEvent) => POINT[e.id] ?? null;
const lockOverrides = new Map<number, LockState>();
const lockOf = (e: PlanEvent): LockState => {
  const l = effectiveLock(e.status, lockOverrides.get(e.id));
  return l === "off-route" ? "free" : l;
};
const vehicle: Vehicle = { id: "v1", name: "Samochód A", technicianIds: [], colorIndex: 0 };

/** planOrder + buildSchedule w jednym — tak jak zrobi to widok. */
function plan(
  events: PlanEvent[],
  opts: {
    mode?: "auto" | "optimized";
    office?: string | null;
    depart?: string | null;
    earliestDepartMin?: number;
    latestReturnMin?: number;
    matrix?: PlanMatrix;
  } = {}
) {
  const mx = opts.matrix ?? matrix;
  const res = planOrder({
    events,
    date: DATE,
    lockOf,
    pointKeyOf,
    matrix: mx,
    officeKey: opts.office === undefined ? "office" : opts.office,
    mode: opts.mode ?? "auto",
    objective: "km",
    earliestDepartMin: opts.earliestDepartMin,
    latestReturnMin: opts.latestReturnMin,
  });
  const byId = new Map(events.map((e) => [e.id, e]));
  const ordered = res.order.map((id) => byId.get(id)!);
  const schedule = buildSchedule({
    vehicle,
    stops: ordered,
    date: DATE,
    lockOf,
    reasonOf: (e) => res.reasons.get(e.id) ?? ("chronological" as StopReason),
    pointKeyOf,
    matrix: mx,
    officeKey: opts.office === undefined ? "office" : opts.office,
    departOverride: opts.depart ?? null,
    overflow: res.overflow,
    anchorConflicts: res.anchorConflicts,
  });
  return { res, schedule };
}

// ---------------------------------------------------------------------------
// Kłódki
// ---------------------------------------------------------------------------
ok("potwierdzone → kotwica", defaultLock("confirmed") === "locked");
ok("wykonane → kotwica (fakt dokonany)", defaultLock("done") === "locked");
ok("zaplanowane → elastyczne", defaultLock("planned") === "free");
ok("anulowane → poza trasą", defaultLock("cancelled") === "off-route");
ok("ręczne otwarcie kłódki wygrywa nad statusem", effectiveLock("confirmed", "free") === "free");
ok("ręczne zamknięcie kłódki wygrywa nad statusem", effectiveLock("planned", "locked") === "locked");
ok("anulowanego nie da się przywrócić kłódką", effectiveLock("cancelled", "locked") === "off-route");

// ---------------------------------------------------------------------------
// Oś czasu
// ---------------------------------------------------------------------------
{
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const { schedule } = plan([a]);
  ok("wyjazd policzony wstecz od kotwicy (08:00 − 30 min)", schedule.departAt === "07:30", schedule.departAt);
  ok("powrót do biura doliczony (10:00 + 31 min)", schedule.returnAt === "10:31", schedule.returnAt);
  ok("kilometry to pełna pętla biuro→A→biuro", schedule.totals.km === 41, schedule.totals);
  ok("czas jazdy = 30 + 31 min", schedule.totals.driveMinutes === 61, schedule.totals);
  ok("kotwica ma kłódkę i nie jest przesunięta", schedule.stops[0].lock === "locked" && schedule.stops[0].shifted === false);
}

{
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const { schedule } = plan([a], { depart: "06:00" });
  ok("ręczna godzina wyjazdu wygrywa", schedule.departAt === "06:00" && schedule.departFixed === true, schedule.departAt);
  ok("przyjazd przed czasem → postój, nie wcześniejszy start", schedule.stops[0].idleMinutes === 90 && schedule.stops[0].startAt === "08:00", schedule.stops[0]);
}

{
  // Za późny wyjazd → spóźnienie na potwierdzony termin.
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const { schedule } = plan([a], { depart: "07:50" });
  ok("spóźnienie na kotwicę policzone", schedule.stops[0].lateMinutes === 20 && schedule.totals.lateStops === 1, schedule.stops[0]);
  ok("spóźnienie ma ostrzeżenie z nazwą wydarzenia", schedule.warnings.some((w) => w.kind === "late" && w.minutes === 20), schedule.warnings);
}

// ---------------------------------------------------------------------------
// Elastyczne dopasowywane do kotwic
// ---------------------------------------------------------------------------
{
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const b = ev({ key: "B", from: "14:00", to: "15:00", status: "planned" });
  const { res, schedule } = plan([a, b]);
  ok("kotwica przed elastycznym", res.order[0] === a.id && res.order[1] === b.id, res.order);
  const stopB = schedule.stops[1];
  ok("elastyczne dostaje propozycję godziny (ASAP po dojeździe)", stopB.startAt === "10:35" && stopB.shifted === true, stopB);
  ok("godzina z kalendarza zachowana do porównania", stopB.plannedStartAt === "14:00", stopB);
  ok("przesunięcie policzone jako różnica minut", stopB.shiftMinutes === -205, stopB.shiftMinutes);
  ok("kotwica NIE została przesunięta", schedule.stops[0].startAt === "08:00", schedule.stops[0]);
}

{
  // Kotwice wzajemnie niewykonalne — zgłaszamy, ale nie przestawiamy.
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const b = ev({ key: "B", from: "10:15", to: "11:00", status: "confirmed" });
  const { res, schedule } = plan([a, b]);
  ok("konflikt kotwic wykryty z liczbą brakujących minut", res.anchorConflicts.length === 1 && res.anchorConflicts[0].shortfallMinutes === 20, res.anchorConflicts);
  ok("kotwice zostają na swoich miejscach", res.order[0] === a.id && res.order[1] === b.id, res.order);
  ok("konflikt trafia do ostrzeżeń planu", schedule.warnings.some((w) => w.kind === "anchor-conflict"), schedule.warnings);
}

{
  // Elastyczne, które nie mieści się w żadnym oknie.
  const a = ev({ key: "A", from: "08:00", to: "09:00", status: "confirmed" });
  const b = ev({ key: "B", from: "09:40", to: "10:30", status: "confirmed" });
  const c = ev({ key: "C", from: "12:00", to: "13:00", status: "planned" });
  const { res, schedule } = plan([a, b, c], { latestReturnMin: 11 * 60 });
  ok("nie mieszczące się wydarzenie ląduje w overflow", res.overflow.length === 1 && res.overflow[0].eventId === c.id, res.overflow);
  const o = res.overflow[0];
  ok("overflow mówi, ilu minut zabrakło", o.shortfallMinutes > 0, o);
  ok("overflow podaje czas trwania samej roboty", o.durationMinutes === 60, o);
  ok("overflow podaje czas z dojazdami (więcej niż sama robota)", o.neededMinutes > o.durationMinutes, o);
  ok("overflow wskazuje konkretne okno", /^\d{2}:\d{2}–\d{2}:\d{2}$/.test(o.windowLabel ?? ""), o.windowLabel);
  ok("overflow składa się arytmetycznie (potrzeba − wolne = brakuje)", o.neededMinutes - o.freeMinutes === o.shortfallMinutes, o);
  ok(
    "komunikat mówi ile trwa, ile zajęłaby i ile zabrakło",
    /Robota trwa/.test(o.message) && /z dojazdem zajęłaby/.test(o.message) && /za mało/.test(o.message),
    o.message
  );
  ok("overflow nie wchodzi na trasę", !res.order.includes(c.id), res.order);
  ok("overflow widoczny w ostrzeżeniach", schedule.warnings.some((w) => w.kind === "overflow"), schedule.warnings);
}

// ---------------------------------------------------------------------------
// Optymalizacja
// ---------------------------------------------------------------------------
{
  // Zero kotwic → zamknięta pętla; optimum na tej macierzy to A → B → C (136 km).
  const a = ev({ key: "A", from: "12:00", to: "13:00" });
  const b = ev({ key: "B", from: "09:00", to: "10:00" });
  const c = ev({ key: "C", from: "15:00", to: "16:00" });
  const optimized = plan([a, b, c], { mode: "optimized" });
  ok("bez kotwic optymalizator znajduje najkrótszą pętlę (A→B→C)", JSON.stringify(optimized.res.order) === JSON.stringify([a.id, b.id, c.id]), optimized.res.order);
  ok("najkrótsza pętla to 136 km", optimized.schedule.totals.km === 136, optimized.schedule.totals);

  const auto = plan([a, b, c], { mode: "auto" });
  ok("optymalizacja nie jest gorsza od kolejności z kalendarza", optimized.schedule.totals.km <= auto.schedule.totals.km, {
    optimized: optimized.schedule.totals.km,
    auto: auto.schedule.totals.km,
  });

  // Determinizm: inna kolejność wejściowa, ten sam wynik.
  const shuffled = plan([c, a, b], { mode: "optimized" });
  ok("wynik jest deterministyczny niezależnie od kolejności wejścia", JSON.stringify(shuffled.res.order) === JSON.stringify(optimized.res.order), shuffled.res.order);
}

{
  // Wszystko potwierdzone → optymalizator nie ma czego ruszać.
  const a = ev({ key: "C", from: "08:00", to: "09:00", status: "confirmed" });
  const b = ev({ key: "A", from: "11:00", to: "12:00", status: "confirmed" });
  const c = ev({ key: "B", from: "14:00", to: "15:00", status: "confirmed" });
  const auto = plan([a, b, c], { mode: "auto" });
  const opt = plan([a, b, c], { mode: "optimized" });
  ok("same kotwice: optymalizacja niczego nie zmienia", JSON.stringify(auto.res.order) === JSON.stringify(opt.res.order), { auto: auto.res.order, opt: opt.res.order });
}

// ---------------------------------------------------------------------------
// Ramy dnia
// ---------------------------------------------------------------------------
{
  // Realny przypadek z produkcji: jedna konserwacja ~310 km od biura. Wyjazd wypada
  // przed szóstą, powrót po dwunastej — sztywne ramy 06:00–20:00 uznałyby to za
  // niewykonalne, choć taki dzień faktycznie się odbywa.
  const far: PlanMatrix = {
    keys: ["office", "A"],
    km: [
      [0, 311.5],
      [308.3, 0],
    ],
    minutes: [
      [0, 186],
      [184, 0],
    ],
    method: [
      ["route", "route"],
      ["route", "route"],
    ],
  };
  const a = ev({ key: "A", from: "08:00", to: "09:30", status: "confirmed", title: "Konserwacja" });
  const { res, schedule } = plan([a], { matrix: far });
  ok("długi dojazd nie wypycha kotwicy poza dzień", res.overflow.length === 0 && schedule.stops.length === 1, res.overflow);
  ok("wyjazd przed szóstą jest dozwolony (08:00 − 3 godz. 6 min)", schedule.departAt === "04:54", schedule.departAt);
  ok("powrót policzony po pełnej pętli", schedule.returnAt === "12:34", schedule.returnAt);
  ok("kilometry to obie strony", schedule.totals.km === 619.8, schedule.totals.km);
  // Całość = od wyjazdu do powrotu: 04:54 → 12:34.
  ok("całość dnia to rozpiętość wyjazd→powrót", schedule.totals.spanMinutes === 460, schedule.totals.spanMinutes);
  ok("całość = jazda + praca + postoje", schedule.totals.spanMinutes === schedule.totals.driveMinutes + schedule.totals.workMinutes + schedule.totals.idleMinutes, schedule.totals);
}

{
  // Ręczne zawężenie ram działa na elastycznych…
  const a = ev({ key: "A", from: "08:00", to: "09:00" });
  const b = ev({ key: "B", from: "10:00", to: "11:00" });
  const wide = plan([a, b], { mode: "optimized" });
  const narrow = plan([a, b], { mode: "optimized", earliestDepartMin: 7 * 60, latestReturnMin: 9 * 60 });
  ok("szerokie ramy mieszczą oba przystanki", wide.res.overflow.length === 0, wide.res.overflow);
  ok("zawężone ramy wypychają to, co się nie mieści", narrow.res.overflow.length > 0, narrow.res.overflow);
  ok("komunikat podpowiada poszerzenie ram dnia", /Poszerz ramy dnia/.test(narrow.res.overflow[0]?.message ?? ""), narrow.res.overflow[0]);
  ok("komunikat podaje czas trwania roboty", /Robota trwa 1 godz\./.test(narrow.res.overflow[0]?.message ?? ""), narrow.res.overflow[0]?.message);
}

{
  // …ale NIE unieważnia potwierdzonego terminu.
  const a = ev({ key: "A", from: "08:00", to: "09:00", status: "confirmed" });
  const { res, schedule } = plan([a], { earliestDepartMin: 7 * 60 + 45, latestReturnMin: 8 * 60 + 30 });
  ok("kotwica mieści się mimo za wąskich ram", res.overflow.length === 0 && schedule.stops.length === 1, res.overflow);
  ok("okno rozszerza się do dojazdu i powrotu kotwicy", schedule.departAt === "07:30" && schedule.returnAt === "09:31", {
    depart: schedule.departAt,
    ret: schedule.returnAt,
  });
}

// ---------------------------------------------------------------------------
// Przypadki brzegowe
// ---------------------------------------------------------------------------
{
  const a1 = ev({ key: "A", from: "08:00", to: "09:00", status: "confirmed" });
  const a2 = ev({ key: "A", from: "09:00", to: "10:00", status: "confirmed" });
  const { schedule } = plan([a1, a2]);
  ok("ten sam obiekt dwa razy: dojazd 0 km", schedule.stops[1].leg.km === 0 && schedule.stops[1].sameAsPrevious === true, schedule.stops[1]);
}

{
  const a = ev({ key: "A", from: "08:00", to: "11:00", status: "confirmed" });
  const b = ev({ key: "B", from: "09:00", to: "10:00", status: "confirmed" });
  const { schedule } = plan([a, b]);
  ok("wydarzenia nachodzące na siebie → ostrzeżenie overlap", schedule.warnings.some((w) => w.kind === "overlap"), schedule.warnings);
}

{
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const { schedule } = plan([a], { office: null });
  ok("brak biura → ostrzeżenie i plan bez powrotu", schedule.warnings.some((w) => w.kind === "no-office") && schedule.returnLeg === null, schedule.warnings);
  ok("bez biura pierwszy przystanek nie ma dojazdu", schedule.stops[0].leg.km === 0, schedule.stops[0].leg);
}

{
  const straight: PlanMatrix = { ...matrix, method: KEYS.map(() => KEYS.map(() => "straight" as const)) };
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const s = buildSchedule({
    vehicle,
    stops: [a],
    date: DATE,
    lockOf,
    pointKeyOf,
    matrix: straight,
    officeKey: "office",
  });
  ok("odcinek w linii prostej jest oznaczony i ostrzega", s.stops[0].leg.estimated === true && s.warnings.some((w) => w.kind === "estimated"), s.stops[0].leg);
}

// ---------------------------------------------------------------------------
// Ręczna kolejność
// ---------------------------------------------------------------------------
{
  const stops = [
    { eventId: 1, lock: "free" as LockState, title: "Alfa" },
    { eventId: 2, lock: "locked" as LockState, title: "Beta" },
    { eventId: 3, lock: "free" as LockState, title: "Gamma" },
  ];
  ok("nie można przenieść kotwicy", canMoveStop(stops, 1, 0).ok === false);
  const through = canMoveStop(stops, 2, 0);
  ok("nie można przenieść przez kotwicę", through.ok === false && /potwierdzony termin/.test((through as { reason: string }).reason), through);
  ok("przeniesienie bez kotwicy po drodze jest dozwolone", canMoveStop([stops[0], stops[2]], 1, 0).ok === true);
}

{
  const auto = [1, 2, 3];
  ok("bez nadpisań obowiązuje kolejność automatyczna", resolveOrder({ autoOrder: auto }).layer === "auto");
  ok("optymalizacja wygrywa nad automatyczną", resolveOrder({ autoOrder: auto, optimizedOrder: [3, 2, 1] }).layer === "optimized");
  const manual = resolveOrder({ autoOrder: auto, optimizedOrder: [3, 2, 1], manualOrder: [2, 1, 3] });
  ok("ręczna wygrywa nad wszystkim", manual.layer === "manual" && JSON.stringify(manual.order) === JSON.stringify([2, 1, 3]), manual);
  ok("nieaktualne nadpisanie jest ignorowane", resolveOrder({ autoOrder: auto, manualOrder: [1, 2] }).layer === "auto");
}

// ---------------------------------------------------------------------------
// Samochody
// ---------------------------------------------------------------------------
{
  const one: Vehicle = { id: "v1", name: "Samochód A", technicianIds: [1, 2], colorIndex: 0 };
  const two: Vehicle = { id: "v2", name: "Samochód B", technicianIds: [3], colorIndex: 1 };
  const e1 = ev({ key: "A", from: "08:00", to: "09:00", techs: [1] });
  const e2 = ev({ key: "B", from: "10:00", to: "11:00", techs: [3] });
  const e3 = ev({ key: "C", from: "12:00", to: "13:00", techs: [1, 2, 3] });
  const e4 = ev({ key: "A", from: "14:00", to: "15:00", techs: [] });

  const single = assignVehicles({ events: [e1, e2, e4], vehicles: [one], pins: {} });
  ok("jeden samochód bierze wszystko, także bez techników", single.byVehicle.get("v1")!.length === 3 && single.unassigned.length === 0, single.byVehicle.get("v1")!.length);

  const split = assignVehicles({ events: [e1, e2, e3, e4], vehicles: [one, two], pins: {} });
  ok("wydarzenie jedzie tam, gdzie jego technicy", split.byVehicle.get("v1")!.some((e) => e.id === e1.id) && split.byVehicle.get("v2")!.some((e) => e.id === e2.id));
  ok("technicy w dwóch samochodach → konflikt zgłoszony", split.conflicts.some((c) => c.eventId === e3.id), split.conflicts);
  ok("konfliktowe wydarzenie trafia do samochodu z większością załogi", split.byVehicle.get("v1")!.some((e) => e.id === e3.id), split.byVehicle.get("v1")!.map((e) => e.id));
  ok("bez technika i przy kilku samochodach → pula nieprzypisanych", split.unassigned.some((e) => e.id === e4.id), split.unassigned.map((e) => e.id));

  const pinned = assignVehicles({ events: [e1], vehicles: [one, two], pins: { [e1.id]: "v2" } });
  ok("ręczne przypięcie ma pierwszeństwo przed technikami", pinned.byVehicle.get("v2")!.length === 1, pinned.byVehicle.get("v2")!.length);
}

{
  const urlop = ev({ key: "A", from: "08:00", to: "16:00", type: "urlop", techs: [7] });
  const praca = ev({ key: "B", from: "09:00", to: "10:00", techs: [8] });
  const split = splitOffRoute({
    events: [urlop, praca],
    skipByEvent: new Map([[urlop.id, { skip: "off-site", message: "Nie jest wyjazdem do obiektu" }]]),
  });
  ok("urlop wypada z trasy", split.offRoute.length === 1 && split.onRoute.length === 1, split.offRoute.length);
  ok("technik na urlopie wypada z puli samochodów", split.unavailableTechnicianIds.includes(7) && !split.unavailableTechnicianIds.includes(8), split.unavailableTechnicianIds);
}

// ---------------------------------------------------------------------------
// Podsumowanie i formatowanie
// ---------------------------------------------------------------------------
{
  const a = ev({ key: "A", from: "08:00", to: "10:00", status: "confirmed" });
  const b = ev({ key: "B", from: "12:00", to: "13:00", status: "confirmed" });
  const p1 = plan([a]).schedule;
  const p2 = plan([b]).schedule;
  const total = summarize([p1, p2]);
  ok("sumy zbierają się po pojazdach", total.km === Math.round((p1.totals.km + p2.totals.km) * 10) / 10, total);
}

ok("minuty → HH:MM", fromMinutes(7 * 60 + 5) === "07:05");
ok("minuty ujemne zawijają się na poprzednią dobę", fromMinutes(-30) === "23:30");

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
