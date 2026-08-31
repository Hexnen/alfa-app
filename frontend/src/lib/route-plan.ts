/**
 * Planer trasy — cała logika układania dnia. Bez Reacta, bez sieci, bez bazy.
 *
 * ŻADNYCH IMPORTÓW. Ten plik jest wołany także przez `scripts/test-route-plan.ts`
 * uruchamiany przez `npx tsx`, który używa `tsconfig.json` backendu (`@/*` → `src/*`,
 * `frontend` w `exclude`). Import czegokolwiek z `@/…` wysypałby test, dlatego typy
 * wejściowe są zdefiniowane lokalnie — typowanie strukturalne sprawia, że `CalendarEvent`
 * z api.ts pasuje do `PlanEvent` bez rzutowania.
 *
 * Model: dzień to zamknięta pętla biuro → przystanki → biuro. Wydarzenia POTWIERDZONE
 * (i WYKONANE) są kotwicami — ich godzina i pozycja są sztywne. ZAPLANOWANE są elastyczne:
 * planer wstawia je w okna między kotwicami i proponuje dla nich inne godziny.
 *
 * Plan NIC nie zapisuje — proponowane godziny żyją wyłącznie w tym widoku.
 */

// ---------------------------------------------------------------------------
// Typy wejściowe
// ---------------------------------------------------------------------------

export interface PlanEvent {
  id: number;
  title: string;
  type: string;
  status: string;
  /** Lokalny ISO "YYYY-MM-DDTHH:MM" (albo "YYYY-MM-DD" dla całodniowych). */
  startAt: string;
  endAt: string;
  allDay: boolean;
  objectId: number | null;
  objectName: string | null;
  technicianIds: number[];
}

export interface PlanMatrix {
  keys: string[];
  km: number[][];
  minutes: number[][];
  method: ("route" | "straight")[][];
}

export interface Vehicle {
  /** Stabilne id w localStorage ("v1", "v2"…). */
  id: string;
  name: string;
  technicianIds: number[];
  /** Indeks palety 0..5 — kolor bierze CSS, nie logika. */
  colorIndex: number;
}

export type LockState = "locked" | "free";

/**
 * Litera pojazdu (A/B/C…) — towarzyszy kolorowi wszędzie, gdzie kolor się pojawia,
 * żeby sam kolor nigdy nie był jedynym nośnikiem informacji.
 */
export function vehicleLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

// ---------------------------------------------------------------------------
// Typy wynikowe
// ---------------------------------------------------------------------------

export interface Leg {
  fromKey: string;
  toKey: string;
  km: number;
  minutes: number;
  /** true = linia prosta ×1,3, a nie trasa OSRM. */
  estimated: boolean;
}

/** Dlaczego przystanek stoi w tym miejscu — wytłumaczalność wyniku. */
export type StopReason =
  | "anchor-confirmed"
  | "anchor-done"
  | "anchor-manual"
  | "inserted"
  | "chronological"
  | "manual";

export interface PlannedStop {
  eventId: number;
  pointKey: string;
  lock: LockState;
  reason: StopReason;
  /** Gotowe zdanie PL do dymka „dlaczego tak”. */
  reasonText: string;
  /** Dojazd DO tego przystanku (z biura dla pierwszego). */
  leg: Leg;
  arriveAt: string;
  /** Proponowany start i koniec pracy. */
  startAt: string;
  endAt: string;
  /** Godziny z kalendarza — zawsze pokazywane obok proponowanych. */
  plannedStartAt: string;
  plannedEndAt: string;
  /** true = propozycja różni się od kalendarza (tylko dla elastycznych). */
  shifted: boolean;
  /** Ujemne = wcześniej niż w kalendarzu. */
  shiftMinutes: number;
  /** > 0 = przyjazd po godzinie kotwicy. */
  lateMinutes: number;
  /** > 0 = postój przed wydarzeniem. */
  idleMinutes: number;
  /** Ten sam punkt co poprzedni przystanek (dojazd 0). */
  sameAsPrevious: boolean;
}

export interface OverflowStop {
  eventId: number;
  /** Ilu minut zabrakło w najlepszym oknie. */
  shortfallMinutes: number;
  /** Ile trwa sama robota (z kalendarza) — bez dojazdów. */
  durationMinutes: number;
  /** Ile zajęłaby razem z dojazdem tam i dalej — to jest liczba, która się nie mieści. */
  neededMinutes: number;
  /** Ile wolnego było w najlepszym oknie po tym, co już w nim stoi. */
  freeMinutes: number;
  /** Najlepsze okno, np. „13:00–15:30”; null, gdy żadne okno nie jest dozwolone. */
  windowLabel: string | null;
  message: string;
}

export type PlanWarningKind =
  | "anchor-conflict"
  | "late"
  | "overlap"
  | "tech-split"
  | "estimated"
  | "no-office"
  | "long-day"
  | "overflow";

export interface PlanWarning {
  kind: PlanWarningKind;
  message: string;
  eventId?: number;
  minutes?: number;
}

export interface VehiclePlan {
  vehicleId: string;
  departAt: string;
  /** true = godzina wyjazdu wymuszona ręcznie, nie policzona wstecz. */
  departFixed: boolean;
  /** true = wyjazd wypada przed północą dnia planu (bardzo długi pierwszy dojazd). */
  departsDayBefore: boolean;
  stops: PlannedStop[];
  returnLeg: Leg | null;
  returnAt: string | null;
  overflow: OverflowStop[];
  totals: {
    km: number;
    driveMinutes: number;
    workMinutes: number;
    idleMinutes: number;
    spanMinutes: number;
    lateStops: number;
  };
  warnings: PlanWarning[];
}

// ---------------------------------------------------------------------------
// Stałe
// ---------------------------------------------------------------------------

/**
 * Domyślne ramy dnia. Punktem wyjścia jest siatka kalendarza (06:00–20:00,
 * `slotMinTime`/`slotMaxTime` w Calendar.tsx) — bez żadnych ram optymalizator upychałby
 * wszystko przed pierwszą kotwicą, „wyjeżdżając o 3:00”.
 *
 * To są jednak ramy MIĘKKIE i celowo szerokie: przy trasach po 300 km w jedną stronę
 * realny dzień zaczyna się przed szóstą i kończy po dwudziestej. Okno rozszerza się
 * automatycznie tak, żeby zawsze pomieścić kotwice (patrz `planOrder`), a użytkownik
 * może je ustawić ręcznie. Sztywne 06:00–20:00 kasowałoby plany, które realnie się odbywają.
 */
export const DEFAULT_EARLIEST_DEPART_MIN = 4 * 60;
export const DEFAULT_LATEST_RETURN_MIN = 22 * 60;

/** Ile prób poprawy bez efektu kończy optymalizację (UI nie może stanąć). */
const OPT_STALL_LIMIT = 200;
/** Powyżej tylu elastycznych przystanków rezygnujemy z dokładnego Held-Karpa. */
const EXACT_MAX = 12;

// ---------------------------------------------------------------------------
// Kłódki
// ---------------------------------------------------------------------------

/**
 * Domyślna kłódka wynikająca ze statusu — jedyne miejsce z tą regułą.
 *   confirmed → kotwica (termin uzgodniony z klientem i ekipą)
 *   done      → kotwica (fakt dokonany; reszta dnia liczy się od miejsca, gdzie ekipa stoi)
 *   planned   → elastyczne (termin wstępny)
 *   cancelled → poza trasą
 */
export function defaultLock(status: string): LockState | "off-route" {
  if (status === "cancelled") return "off-route";
  return status === "confirmed" || status === "done" ? "locked" : "free";
}

/** Efektywna kłódka: ręczne nadpisanie wygrywa nad statusem (poza „anulowane”). */
export function effectiveLock(status: string, override: LockState | undefined): LockState | "off-route" {
  const base = defaultLock(status);
  if (base === "off-route") return base;
  return override ?? base;
}

// ---------------------------------------------------------------------------
// Czas
// ---------------------------------------------------------------------------

const DAY_MIN = 24 * 60;

function dayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.round(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** Lokalny ISO → minuty względem północy dnia `base` (może wyjść poza 0..1440). */
export function toMinutes(iso: string, base: string): number {
  const [datePart, timePart] = iso.split("T");
  const offset = (dayIndex(datePart) - dayIndex(base)) * DAY_MIN;
  if (!timePart) return offset;
  const [hh, mm] = timePart.split(":").map(Number);
  return offset + (hh ?? 0) * 60 + (mm ?? 0);
}

/** Minuty → „4 godz. 20 min” po polsku. Własne, bo ten plik nie importuje niczego. */
export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m === 0) return "0 min";
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  if (rest === 0) return `${h} godz.`;
  return `${h} godz. ${rest} min`;
}

/** Minuty → "HH:MM" (zawija przez dobę, żeby nie pokazywać „26:15”). */
export function fromMinutes(min: number): string {
  const wrapped = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Macierz
// ---------------------------------------------------------------------------

interface MatrixLookup {
  km: (from: string, to: string) => number;
  minutes: (from: string, to: string) => number;
  estimated: (from: string, to: string) => boolean;
  has: (key: string) => boolean;
}

function lookup(matrix: PlanMatrix): MatrixLookup {
  const idx = new Map<string, number>();
  matrix.keys.forEach((k, i) => idx.set(k, i));
  const at = (from: string, to: string): [number, number] | null => {
    const i = idx.get(from);
    const j = idx.get(to);
    if (i === undefined || j === undefined) return null;
    return [i, j];
  };
  return {
    has: (key) => idx.has(key),
    km: (f, t) => {
      const p = at(f, t);
      return p ? matrix.km[p[0]]?.[p[1]] ?? 0 : 0;
    },
    minutes: (f, t) => {
      const p = at(f, t);
      return p ? matrix.minutes[p[0]]?.[p[1]] ?? 0 : 0;
    },
    estimated: (f, t) => {
      const p = at(f, t);
      return p ? matrix.method[p[0]]?.[p[1]] !== "route" : true;
    },
  };
}

// ---------------------------------------------------------------------------
// Wewnętrzny model przystanku
// ---------------------------------------------------------------------------

interface Node {
  ev: PlanEvent;
  key: string;
  lock: LockState;
  startMin: number;
  endMin: number;
  durationMin: number;
}

function buildNodes(input: {
  events: PlanEvent[];
  date: string;
  lockOf: (ev: PlanEvent) => LockState;
  pointKeyOf: (ev: PlanEvent) => string | null;
  mx: MatrixLookup;
}): Node[] {
  const out: Node[] = [];
  for (const ev of input.events) {
    const key = input.pointKeyOf(ev);
    if (!key || !input.mx.has(key)) continue;
    const startMin = toMinutes(ev.startAt, input.date);
    const endMin = toMinutes(ev.endAt, input.date);
    out.push({
      ev,
      key,
      lock: input.lockOf(ev),
      startMin,
      endMin,
      durationMin: Math.max(0, endMin - startMin),
    });
  }
  return out;
}

/** Stabilny porządek: godzina z kalendarza, potem id. Bez tego wyniki „skaczą”. */
function byCalendar(a: Node, b: Node): number {
  return a.startMin - b.startMin || a.ev.id - b.ev.id;
}

// ---------------------------------------------------------------------------
// Sloty między kotwicami
// ---------------------------------------------------------------------------

interface Slot {
  /** Punkt przed slotem (biuro albo poprzednia kotwica); null = brak biura. */
  prevKey: string | null;
  nextKey: string | null;
  /** Najwcześniejszy możliwy start slotu. */
  fromMin: number;
  /** Najpóźniejszy możliwy koniec slotu. */
  toMin: number;
  items: Node[];
}

function buildSlots(input: {
  anchors: Node[];
  officeKey: string | null;
  earliestDepartMin: number;
  latestReturnMin: number;
}): Slot[] {
  const { anchors, officeKey } = input;
  const slots: Slot[] = [];
  for (let i = 0; i <= anchors.length; i++) {
    slots.push({
      prevKey: i === 0 ? officeKey : anchors[i - 1].key,
      nextKey: i === anchors.length ? officeKey : anchors[i].key,
      fromMin: i === 0 ? input.earliestDepartMin : anchors[i - 1].endMin,
      toMin: i === anchors.length ? input.latestReturnMin : anchors[i].startMin,
      items: [],
    });
  }
  return slots;
}

/** Ile minut zajmuje przejechanie slotu z zadaną zawartością (dojazdy + praca). */
function slotNeed(slot: Slot, items: Node[], mx: MatrixLookup): number {
  let need = 0;
  let cursor = slot.prevKey;
  for (const it of items) {
    if (cursor) need += mx.minutes(cursor, it.key);
    need += it.durationMin;
    cursor = it.key;
  }
  if (cursor && slot.nextKey) need += mx.minutes(cursor, slot.nextKey);
  return need;
}

function slotFits(slot: Slot, items: Node[], mx: MatrixLookup): boolean {
  return slotNeed(slot, items, mx) <= slot.toMin - slot.fromMin;
}

/**
 * Czy elastyczny przystanek w ogóle wolno wstawić do tego slotu.
 *
 * Planer ma DOPASOWAĆ zaplanowane do potwierdzonych, a nie przemeblować dzień: zlecenie
 * wpisane na popołudnie ma zostać po popołudniowej stronie potwierdzonych terminów.
 * Bez tej reguły szerokie ramy dnia pozwalają wciągnąć robotę z 14:00 na 05:00 — formalnie
 * poprawnie (jest elastyczna), praktycznie bez sensu.
 *
 * Kolejność WŚRÓD elastycznych pozostaje wolna — tam optymalizacja ma pole do popisu.
 */
function slotAllowed(slotIndex: number, node: Node, anchors: Node[]): boolean {
  const before = anchors[slotIndex - 1];
  if (before && before.startMin > node.startMin) return false;
  const after = anchors[slotIndex];
  if (after && after.startMin < node.startMin) return false;
  return true;
}

/**
 * Ile miejsca zajmie przystanek w danym slocie i ile go tam zostało.
 * `neededMinutes` jest PRZYROSTOWE (dojazd tam + robota + zmiana dojazdu dalej),
 * bo to ta liczba odpowiada na pytanie „czemu się nie mieści”.
 */
interface SlotFit {
  freeMinutes: number;
  neededMinutes: number;
  shortfallMinutes: number;
  fromMin: number;
  toMin: number;
}

function slotFit(slot: Slot, items: Node[], node: Node, at: number, mx: MatrixLookup): SlotFit {
  const baseNeed = slotNeed(slot, items, mx);
  const withNode = slotNeed(slot, [...items.slice(0, at), node, ...items.slice(at)], mx);
  const window = slot.toMin - slot.fromMin;
  return {
    freeMinutes: window - baseNeed,
    neededMinutes: withNode - baseNeed,
    shortfallMinutes: withNode - window,
    fromMin: slot.fromMin,
    toMin: slot.toMin,
  };
}

/** Koszt przejazdu slotu wg celu optymalizacji. */
function slotCost(slot: Slot, items: Node[], mx: MatrixLookup, objective: "km" | "time"): number {
  const f = objective === "km" ? mx.km : mx.minutes;
  let cost = 0;
  let cursor = slot.prevKey;
  for (const it of items) {
    if (cursor) cost += f(cursor, it.key);
    cursor = it.key;
  }
  if (cursor && slot.nextKey) cost += f(cursor, slot.nextKey);
  return cost;
}

// ---------------------------------------------------------------------------
// Kolejność
// ---------------------------------------------------------------------------

export interface PlanOrderResult {
  /** Kolejność przejazdu — id wydarzeń. */
  order: number[];
  /** Skąd wzięła się pozycja danego przystanku. */
  reasons: Map<number, StopReason>;
  overflow: OverflowStop[];
  /** Kotwice, do których nie da się zdążyć z poprzedniej kotwicy. */
  anchorConflicts: { eventId: number; shortfallMinutes: number }[];
}

export interface PlanOrderInput {
  events: PlanEvent[];
  date: string;
  lockOf: (ev: PlanEvent) => LockState;
  pointKeyOf: (ev: PlanEvent) => string | null;
  matrix: PlanMatrix;
  officeKey: string | null;
  /** "auto" = elastyczne chronologicznie; "optimized" = minimalizacja km/czasu. */
  mode: "auto" | "optimized";
  objective?: "km" | "time";
  earliestDepartMin?: number;
  latestReturnMin?: number;
}

/**
 * Ułożenie przystanków dnia z poszanowaniem kotwic.
 *
 * Kotwice trzymają swoją godzinę i pozycję — planer ich NIE rusza, nawet gdy są wzajemnie
 * niewykonalne. Wtedy zgłasza konflikt: przestawienie uzgodnionego z klientem terminu jest
 * decyzją dyspozytora, nie algorytmu.
 *
 * Elastyczne trafiają w okna między kotwicami: w trybie „auto” chronologicznie (to jest
 * plan, który wynika wprost z kalendarza), w „optimized” metodą najtańszego wstawienia
 * z poprawą Or-opt.
 */
export function planOrder(input: PlanOrderInput): PlanOrderResult {
  const objective = input.objective ?? "km";
  const mx = lookup(input.matrix);
  const nodes = buildNodes({ ...input, mx }).sort(byCalendar);

  const anchors = nodes.filter((n) => n.lock === "locked");
  const flexible = nodes.filter((n) => n.lock === "free");

  const reasons = new Map<number, StopReason>();
  for (const a of anchors) {
    reasons.set(a.ev.id, a.ev.status === "done" ? "anchor-done" : a.ev.status === "confirmed" ? "anchor-confirmed" : "anchor-manual");
  }

  // Wykonalność samego łańcucha kotwic — informacja, nie powód do przestawiania.
  const anchorConflicts: { eventId: number; shortfallMinutes: number }[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const arrive = anchors[i - 1].endMin + mx.minutes(anchors[i - 1].key, anchors[i].key);
    if (arrive > anchors[i].startMin) {
      anchorConflicts.push({ eventId: anchors[i].ev.id, shortfallMinutes: arrive - anchors[i].startMin });
    }
  }

  // Ramy dnia. Kotwice są faktem — uzgodnionego terminu nie unieważnia ustawienie okna,
  // więc okno rozszerzamy tak, żeby dojazd do pierwszej i powrót z ostatniej zawsze się mieściły.
  // Bez tego dzień z jedną wizytą 300 km od biura byłby „niewykonalny”, choć odbywa się co tydzień.
  let earliest = input.earliestDepartMin ?? DEFAULT_EARLIEST_DEPART_MIN;
  let latest = input.latestReturnMin ?? DEFAULT_LATEST_RETURN_MIN;
  if (anchors.length > 0) {
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    earliest = Math.min(earliest, first.startMin - (input.officeKey ? mx.minutes(input.officeKey, first.key) : 0));
    latest = Math.max(latest, last.endMin + (input.officeKey ? mx.minutes(last.key, input.officeKey) : 0));
  }

  const slots = buildSlots({ anchors, officeKey: input.officeKey, earliestDepartMin: earliest, latestReturnMin: latest });

  const overflow: OverflowStop[] = [];

  if (input.mode === "auto") {
    // Chronologicznie: każdy elastyczny do pierwszego okna, w którym się mieści,
    // z zachowaniem porządku godzin wewnątrz okna.
    for (const node of flexible) {
      let placed = false;
      let best: SlotFit | null = null;
      for (let si = 0; si < slots.length; si++) {
        const slot = slots[si];
        if (!slotAllowed(si, node, anchors)) continue;
        const pos = slot.items.findIndex((it) => byCalendar(node, it) < 0);
        const at = pos === -1 ? slot.items.length : pos;
        const candidate = [...slot.items.slice(0, at), node, ...slot.items.slice(at)];
        if (slotFits(slot, candidate, mx)) {
          slot.items = candidate;
          reasons.set(node.ev.id, "chronological");
          placed = true;
          break;
        }
        const fit = slotFit(slot, slot.items, node, at, mx);
        if (!best || fit.shortfallMinutes < best.shortfallMinutes) best = fit;
      }
      if (!placed) overflow.push(makeOverflow(node, best));
    }
  } else if (anchors.length === 0 && input.officeKey && flexible.length > 1 && flexible.length <= EXACT_MAX) {
    // Zero kotwic → zwykła zamknięta pętla. Held-Karp jest dokładny także na macierzy
    // asymetrycznej (w przeciwieństwie do 2-opt liczonego deltą).
    const best = heldKarp(flexible, input.officeKey, mx, objective);
    const slot = slots[0];
    for (const node of best) {
      const candidate = [...slot.items, node];
      if (slotFits(slot, candidate, mx)) {
        slot.items = candidate;
        reasons.set(node.ev.id, "inserted");
      } else {
        overflow.push(makeOverflow(node, slotFit(slot, slot.items, node, slot.items.length, mx)));
      }
    }
  } else {
    // Najtańsze wstawienie: najpierw te, które mieszczą się w najmniejszej liczbie miejsc.
    const pending = [...flexible];
    while (pending.length > 0) {
      let choice: { node: Node; slot: Slot | null; at: number; cost: number; options: number; fit: SlotFit | null } | null = null;

      for (const node of pending) {
        let bestCost = Number.POSITIVE_INFINITY;
        let bestSlot: Slot | null = null;
        let bestAt = 0;
        let options = 0;
        let bestFit: SlotFit | null = null;

        for (let si = 0; si < slots.length; si++) {
          const slot = slots[si];
          if (!slotAllowed(si, node, anchors)) continue;
          const baseCost = slotCost(slot, slot.items, mx, objective);
          for (let at = 0; at <= slot.items.length; at++) {
            const candidate = [...slot.items.slice(0, at), node, ...slot.items.slice(at)];
            const need = slotNeed(slot, candidate, mx);
            if (need > slot.toMin - slot.fromMin) {
              const fit = slotFit(slot, slot.items, node, at, mx);
              if (!bestFit || fit.shortfallMinutes < bestFit.shortfallMinutes) bestFit = fit;
              continue;
            }
            options++;
            const delta = slotCost(slot, candidate, mx, objective) - baseCost;
            if (delta < bestCost - 1e-9) {
              bestCost = delta;
              bestSlot = slot;
              bestAt = at;
            }
          }
        }

        const cand = { node, slot: bestSlot, at: bestAt, cost: bestCost, options, fit: bestFit };
        if (!choice) {
          choice = cand;
          continue;
        }
        // Najbardziej ograniczony najpierw; potem najtańszy; potem kolejność z kalendarza.
        const better =
          cand.options < choice.options ||
          (cand.options === choice.options && cand.cost < choice.cost - 1e-9) ||
          (cand.options === choice.options && Math.abs(cand.cost - choice.cost) <= 1e-9 && byCalendar(cand.node, choice.node) < 0);
        if (better) choice = cand;
      }

      const picked = choice as NonNullable<typeof choice>;
      pending.splice(pending.indexOf(picked.node), 1);
      if (picked.options === 0 || !picked.slot) {
        overflow.push(makeOverflow(picked.node, picked.fit));
        continue;
      }
      const target = picked.slot;
      target.items = [...target.items.slice(0, picked.at), picked.node, ...target.items.slice(picked.at)];
      reasons.set(picked.node.ev.id, "inserted");
    }

    improve(slots, anchors, mx, objective);
  }

  // Sklejenie: slot 0, kotwica 1, slot 1, kotwica 2, …
  const order: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    for (const it of slots[i].items) order.push(it.ev.id);
    if (i < anchors.length) order.push(anchors[i].ev.id);
  }

  return { order, reasons, overflow, anchorConflicts };
}

function makeOverflow(node: Node, best: SlotFit | null): OverflowStop {
  const duration = node.durationMin;
  const base = `Robota trwa ${fmtDuration(duration)}`;

  if (!best) {
    return {
      eventId: node.ev.id,
      shortfallMinutes: 0,
      durationMinutes: duration,
      neededMinutes: duration,
      freeMinutes: 0,
      windowLabel: null,
      message: `${base}. Między potwierdzonymi terminami nie ma dla niej żadnego okna — przenieś termin albo odblokuj którąś kłódkę.`,
    };
  }

  const short = Math.max(1, Math.round(best.shortfallMinutes));
  const windowLabel = `${fromMinutes(best.fromMin)}–${fromMinutes(best.toMin)}`;
  const free = Math.max(0, Math.round(best.freeMinutes));
  return {
    eventId: node.ev.id,
    shortfallMinutes: short,
    durationMinutes: duration,
    neededMinutes: Math.round(best.neededMinutes),
    freeMinutes: free,
    windowLabel,
    message:
      `${base}, a z dojazdem zajęłaby ${fmtDuration(best.neededMinutes)}. ` +
      `Najwięcej wolnego było w oknie ${windowLabel} — ${fmtDuration(free)}, ` +
      `czyli o ${fmtDuration(short)} za mało. Poszerz ramy dnia albo przenieś termin.`,
  };
}

/**
 * Poprawa Or-opt: przenoszenie 1–3 kolejnych elastycznych przystanków w inne miejsce.
 * Świadomie BEZ klasycznego 2-opt liczonego deltą — macierz OSRM jest asymetryczna
 * (jednokierunkowe, zakazy skrętu), więc delta odwróconego segmentu jest nieprawdziwa
 * i „optymalizacja” potrafi pogorszyć trasę. Każdy ruch tutaj jest oceniany PEŁNYM
 * przeliczeniem kosztu obu dotkniętych slotów.
 */
function improve(slots: Slot[], anchors: Node[], mx: MatrixLookup, objective: "km" | "time"): void {
  let stall = 0;
  while (stall < OPT_STALL_LIMIT) {
    let improved = false;

    outer: for (const from of slots) {
      for (let start = 0; start < from.items.length; start++) {
        for (let len = 1; len <= 3 && start + len <= from.items.length; len++) {
          const segment = from.items.slice(start, start + len);
          const rest = [...from.items.slice(0, start), ...from.items.slice(start + len)];

          for (let ti = 0; ti < slots.length; ti++) {
            const to = slots[ti];
            if (segment.some((n) => !slotAllowed(ti, n, anchors))) continue;
            const targetBase = to === from ? rest : to.items;
            for (let at = 0; at <= targetBase.length; at++) {
              if (to === from && at === start) continue;
              const nextTarget = [...targetBase.slice(0, at), ...segment, ...targetBase.slice(at)];
              const nextFrom = to === from ? nextTarget : rest;

              if (!slotFits(from, nextFrom, mx)) continue;
              if (to !== from && !slotFits(to, nextTarget, mx)) continue;

              const before =
                slotCost(from, from.items, mx, objective) + (to === from ? 0 : slotCost(to, to.items, mx, objective));
              const after =
                slotCost(from, nextFrom, mx, objective) + (to === from ? 0 : slotCost(to, nextTarget, mx, objective));

              if (after < before - 1e-9) {
                from.items = nextFrom;
                if (to !== from) to.items = nextTarget;
                improved = true;
                break outer;
              }
            }
          }
        }
      }
    }

    if (!improved) return;
    stall++;
  }
}

/** Dokładny TSP zamknięty (biuro → … → biuro) dla małych zestawów. */
function heldKarp(nodes: Node[], officeKey: string, mx: MatrixLookup, objective: "km" | "time"): Node[] {
  const f = objective === "km" ? mx.km : mx.minutes;
  const n = nodes.length;
  const size = 1 << n;
  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: size }, () => new Array<number>(n).fill(INF));
  const parent: number[][] = Array.from({ length: size }, () => new Array<number>(n).fill(-1));

  for (let i = 0; i < n; i++) dp[1 << i][i] = f(officeKey, nodes[i].key);

  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last)) || dp[mask][last] === INF) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nextMask = mask | (1 << next);
        const cost = dp[mask][last] + f(nodes[last].key, nodes[next].key);
        if (cost < dp[nextMask][next] - 1e-9) {
          dp[nextMask][next] = cost;
          parent[nextMask][next] = last;
        }
      }
    }
  }

  const full = size - 1;
  let bestLast = 0;
  let bestCost = INF;
  for (let last = 0; last < n; last++) {
    const cost = dp[full][last] + f(nodes[last].key, officeKey);
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      bestLast = last;
    }
  }

  const seq: Node[] = [];
  let mask = full;
  let last = bestLast;
  while (last !== -1) {
    seq.push(nodes[last]);
    const prev = parent[mask][last];
    mask ^= 1 << last;
    last = prev;
  }
  return seq.reverse();
}

// ---------------------------------------------------------------------------
// Oś czasu
// ---------------------------------------------------------------------------

export interface BuildScheduleInput {
  vehicle: Vehicle;
  /** Wydarzenia w KOLEJNOŚCI przejazdu. */
  stops: PlanEvent[];
  date: string;
  lockOf: (ev: PlanEvent) => LockState;
  reasonOf?: (ev: PlanEvent) => StopReason;
  pointKeyOf: (ev: PlanEvent) => string | null;
  matrix: PlanMatrix;
  officeKey: string | null;
  /** "HH:MM" — wymuszona godzina wyjazdu. */
  departOverride?: string | null;
  /** Norma dnia w minutach — do ostrzeżenia o przekroczeniu. */
  workDayMinutes?: number;
  overflow?: OverflowStop[];
  anchorConflicts?: { eventId: number; shortfallMinutes: number }[];
}

const REASON_TEXT: Record<StopReason, string> = {
  "anchor-confirmed": "Termin potwierdzony — godzina i pozycja w trasie są sztywne.",
  "anchor-done": "Wydarzenie wykonane — trasa liczy się od miejsca, w którym ekipa już była.",
  "anchor-manual": "Kłódka zamknięta ręcznie — planer nie zmienia tej godziny.",
  inserted: "Wstawione przez planer w wolne okno, żeby dołożyć jak najmniej kilometrów.",
  chronological: "Kolejność wynika z godzin w kalendarzu.",
  manual: "Kolejność ustawiona ręcznie.",
};

/**
 * Oś czasu jednego pojazdu dla ZADANEJ kolejności.
 *
 * Godzina wyjazdu bez `departOverride` liczy się WSTECZ — od pierwszej kotwicy, jeśli
 * jakaś jest (to jest pytanie dyspozytora: „o której wyjechać, żeby zdążyć na potwierdzony
 * termin”), a gdy kotwic nie ma — od godziny pierwszego wydarzenia w kalendarzu.
 * Dalej harmonogram idzie DO PRZODU i to on ujawnia spóźnienia.
 */
export function buildSchedule(input: BuildScheduleInput): VehiclePlan {
  const mx = lookup(input.matrix);
  const nodes = buildNodes({
    events: input.stops,
    date: input.date,
    lockOf: input.lockOf,
    pointKeyOf: input.pointKeyOf,
    mx,
  });

  const warnings: PlanWarning[] = [];
  const office = input.officeKey;
  if (!office) {
    warnings.push({
      kind: "no-office",
      message: "Brak współrzędnych biura — plan nie obejmuje wyjazdu ani powrotu.",
    });
  }

  for (const conflict of input.anchorConflicts ?? []) {
    const node = nodes.find((n) => n.ev.id === conflict.eventId);
    warnings.push({
      kind: "anchor-conflict",
      eventId: conflict.eventId,
      minutes: conflict.shortfallMinutes,
      message: node
        ? `Nie da się zdążyć na „${node.ev.title}” z poprzedniego potwierdzonego terminu — brakuje ${conflict.shortfallMinutes} min.`
        : `Potwierdzone terminy nachodzą na siebie — brakuje ${conflict.shortfallMinutes} min.`,
    });
  }
  for (const over of input.overflow ?? []) {
    warnings.push({ kind: "overflow", eventId: over.eventId, minutes: over.shortfallMinutes, message: over.message });
  }

  const empty: VehiclePlan = {
    vehicleId: input.vehicle.id,
    departAt: "—",
    departFixed: false,
    departsDayBefore: false,
    stops: [],
    returnLeg: null,
    returnAt: null,
    overflow: input.overflow ?? [],
    totals: { km: 0, driveMinutes: 0, workMinutes: 0, idleMinutes: 0, spanMinutes: 0, lateStops: 0 },
    warnings,
  };
  if (nodes.length === 0) return empty;

  const legFor = (fromKey: string | null, toKey: string): Leg => ({
    fromKey: fromKey ?? toKey,
    toKey,
    km: fromKey ? mx.km(fromKey, toKey) : 0,
    minutes: fromKey ? mx.minutes(fromKey, toKey) : 0,
    estimated: fromKey ? mx.estimated(fromKey, toKey) : false,
  });

  // --- Godzina wyjazdu ---
  const overrideMin =
    input.departOverride && /^\d{2}:\d{2}$/.test(input.departOverride)
      ? Number(input.departOverride.slice(0, 2)) * 60 + Number(input.departOverride.slice(3, 5))
      : null;

  let departMin: number;
  if (overrideMin !== null) {
    departMin = overrideMin;
  } else {
    // Wstecz od pierwszej kotwicy (albo od pierwszego wydarzenia, gdy kotwic nie ma):
    // sumujemy dojazdy i pracę wszystkiego, co jest przed nią w kolejności.
    const anchorAt = nodes.findIndex((n) => n.lock === "locked");
    const pivot = anchorAt === -1 ? 0 : anchorAt;
    let need = 0;
    let cursor = office;
    for (let i = 0; i < pivot; i++) {
      need += (cursor ? mx.minutes(cursor, nodes[i].key) : 0) + nodes[i].durationMin;
      cursor = nodes[i].key;
    }
    need += cursor ? mx.minutes(cursor, nodes[pivot].key) : 0;
    departMin = nodes[pivot].startMin - need;
  }

  // --- Przejazd do przodu ---
  const stops: PlannedStop[] = [];
  let cursorKey = office;
  let clock = departMin;
  let km = 0;
  let driveMinutes = 0;
  let workMinutes = 0;
  let idleMinutes = 0;
  let lateStops = 0;

  nodes.forEach((node, i) => {
    const leg = legFor(cursorKey, node.key);
    const arrive = clock + leg.minutes;
    const isLocked = node.lock === "locked";
    // Kotwica startuje o swojej godzinie (albo z opóźnieniem, gdy dojazd był za długi);
    // elastyczne zaczynają od razu po dojeździe — postój ma sens tylko przed sztywnym terminem.
    const start = isLocked ? Math.max(arrive, node.startMin) : arrive;
    const end = start + node.durationMin;
    const late = isLocked ? Math.max(0, arrive - node.startMin) : 0;
    const idle = Math.max(0, start - arrive);
    const shift = start - node.startMin;

    const reason = input.reasonOf?.(node.ev) ?? (isLocked ? "anchor-confirmed" : "chronological");
    stops.push({
      eventId: node.ev.id,
      pointKey: node.key,
      lock: node.lock,
      reason,
      reasonText: REASON_TEXT[reason],
      leg,
      arriveAt: fromMinutes(arrive),
      startAt: fromMinutes(start),
      endAt: fromMinutes(end),
      plannedStartAt: fromMinutes(node.startMin),
      plannedEndAt: fromMinutes(node.endMin),
      shifted: !isLocked && shift !== 0,
      shiftMinutes: shift,
      lateMinutes: late,
      idleMinutes: idle,
      sameAsPrevious: i > 0 && nodes[i - 1].key === node.key,
    });

    if (late > 0) {
      lateStops++;
      warnings.push({
        kind: "late",
        eventId: node.ev.id,
        minutes: late,
        message: `„${node.ev.title}”: przyjazd ${fromMinutes(arrive)}, termin ${fromMinutes(node.startMin)} — spóźnienie ${late} min.`,
      });
    }
    if (leg.estimated && leg.minutes > 0) {
      warnings.push({
        kind: "estimated",
        eventId: node.ev.id,
        message: `Dojazd do „${node.ev.title}” liczony w linii prostej — trasa jeszcze się nie doliczyła.`,
      });
    }
    if (i > 0 && node.startMin < nodes[i - 1].endMin) {
      warnings.push({
        kind: "overlap",
        eventId: node.ev.id,
        message: `„${node.ev.title}” nachodzi w kalendarzu na poprzednie wydarzenie — jeden samochód nie zdąży w obu miejscach.`,
      });
    }

    km += leg.km;
    driveMinutes += leg.minutes;
    workMinutes += node.durationMin;
    idleMinutes += idle;
    clock = end;
    cursorKey = node.key;
  });

  // --- Powrót ---
  let returnLeg: Leg | null = null;
  let returnAt: string | null = null;
  let endMin = clock;
  if (office && cursorKey) {
    returnLeg = legFor(cursorKey, office);
    endMin = clock + returnLeg.minutes;
    returnAt = fromMinutes(endMin);
    km += returnLeg.km;
    driveMinutes += returnLeg.minutes;
  }

  const spanMinutes = endMin - departMin;
  if (input.workDayMinutes && spanMinutes > input.workDayMinutes) {
    warnings.push({
      kind: "long-day",
      minutes: spanMinutes - input.workDayMinutes,
      message: `Dzień trwa ${Math.round(spanMinutes / 60)} godz. — o ${Math.round((spanMinutes - input.workDayMinutes) / 60 * 10) / 10} godz. dłużej niż norma.`,
    });
  }

  return {
    vehicleId: input.vehicle.id,
    departAt: fromMinutes(departMin),
    departFixed: overrideMin !== null,
    departsDayBefore: departMin < 0,
    stops,
    returnLeg,
    returnAt,
    overflow: input.overflow ?? [],
    totals: {
      km: Math.round(km * 10) / 10,
      driveMinutes,
      workMinutes,
      idleMinutes,
      spanMinutes,
      lateStops,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Ręczna kolejność
// ---------------------------------------------------------------------------

/** Czy wolno przenieść przystanek na pozycję `to` — kotwic nie przestawiamy. */
export function canMoveStop(
  stops: { eventId: number; lock: LockState; title?: string }[],
  from: number,
  to: number
): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  if (from < 0 || from >= stops.length || to < 0 || to >= stops.length) {
    return { ok: false, reason: "Pozycja poza listą." };
  }
  if (stops[from].lock === "locked") {
    return { ok: false, reason: "Ten termin jest zablokowany kłódką — otwórz kłódkę, żeby go przesunąć." };
  }
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) {
    if (i === from) continue;
    if (stops[i].lock === "locked") {
      const label = stops[i].title ? `„${stops[i].title}”` : "zablokowany termin";
      return { ok: false, reason: `Nie można przenieść przez ${label} — to potwierdzony termin.` };
    }
  }
  return { ok: true };
}

export type OrderLayer = "auto" | "optimized" | "manual";

/** Warstwa obowiązująca: ręczna > zoptymalizowana > automatyczna. */
export function resolveOrder(input: {
  autoOrder: number[];
  optimizedOrder?: number[] | null;
  manualOrder?: number[] | null;
}): { order: number[]; layer: OrderLayer } {
  const valid = (o: number[] | null | undefined) =>
    o && o.length === input.autoOrder.length && input.autoOrder.every((id) => o.includes(id));
  if (valid(input.manualOrder)) return { order: input.manualOrder as number[], layer: "manual" };
  if (valid(input.optimizedOrder)) return { order: input.optimizedOrder as number[], layer: "optimized" };
  return { order: input.autoOrder, layer: "auto" };
}

// ---------------------------------------------------------------------------
// Samochody
// ---------------------------------------------------------------------------

export interface AssignResult {
  byVehicle: Map<string, PlanEvent[]>;
  /** Bez technika i bez przypięcia — pula „nieprzypisane”. */
  unassigned: PlanEvent[];
  conflicts: { eventId: number; vehicleIds: string[] }[];
}

/**
 * Podział wydarzeń na samochody. Domyślnie JEDEN samochód ze wszystkimi technikami dnia.
 * Wydarzenie jedzie tam, gdzie są jego technicy; gdy rozjeżdżają się między samochody —
 * do tego z większością załogi, ze zgłoszeniem konfliktu (plan zostaje kompletny,
 * a użytkownik może przypiąć wydarzenie ręcznie).
 */
export function assignVehicles(input: {
  events: PlanEvent[];
  vehicles: Vehicle[];
  pins: Record<number, string>;
}): AssignResult {
  const byVehicle = new Map<string, PlanEvent[]>();
  for (const v of input.vehicles) byVehicle.set(v.id, []);
  const unassigned: PlanEvent[] = [];
  const conflicts: { eventId: number; vehicleIds: string[] }[] = [];

  const vehicleOfTech = new Map<number, string>();
  for (const v of input.vehicles) for (const t of v.technicianIds) vehicleOfTech.set(t, v.id);

  for (const ev of input.events) {
    const pinned = input.pins[ev.id];
    if (pinned && byVehicle.has(pinned)) {
      byVehicle.get(pinned)!.push(ev);
      continue;
    }

    const counts = new Map<string, number>();
    for (const t of ev.technicianIds) {
      const vid = vehicleOfTech.get(t);
      if (vid) counts.set(vid, (counts.get(vid) ?? 0) + 1);
    }

    if (counts.size === 0) {
      // Bez techników: przy jednym samochodzie nie ma czego rozstrzygać.
      if (input.vehicles.length === 1) byVehicle.get(input.vehicles[0].id)!.push(ev);
      else unassigned.push(ev);
      continue;
    }

    if (counts.size > 1) conflicts.push({ eventId: ev.id, vehicleIds: [...counts.keys()] });

    // Większość załogi; przy remisie — kolejność samochodów (stabilnie).
    let bestId = input.vehicles[0].id;
    let bestCount = -1;
    for (const v of input.vehicles) {
      const c = counts.get(v.id) ?? 0;
      if (c > bestCount) {
        bestCount = c;
        bestId = v.id;
      }
    }
    byVehicle.get(bestId)!.push(ev);
  }

  return { byVehicle, unassigned, conflicts };
}

// ---------------------------------------------------------------------------
// Poza trasą
// ---------------------------------------------------------------------------

/**
 * Rozdział na trasę i „poza trasą”. Urlop nie jest zwykłym wpisem poza trasą —
 * WYKLUCZA technika z puli samochodów na cały dzień (na urlopie nikt nigdzie nie jedzie).
 */
export function splitOffRoute(input: {
  events: PlanEvent[];
  skipByEvent: Map<number, { skip: string; message: string }>;
}): {
  onRoute: PlanEvent[];
  offRoute: { event: PlanEvent; reason: string }[];
  unavailableTechnicianIds: number[];
} {
  const onRoute: PlanEvent[] = [];
  const offRoute: { event: PlanEvent; reason: string }[] = [];
  const unavailable = new Set<number>();

  for (const ev of input.events) {
    if (ev.type === "urlop") for (const t of ev.technicianIds) unavailable.add(t);
    const skip = input.skipByEvent.get(ev.id);
    if (skip) offRoute.push({ event: ev, reason: skip.message });
    else onRoute.push(ev);
  }

  return { onRoute, offRoute, unavailableTechnicianIds: [...unavailable] };
}

// ---------------------------------------------------------------------------
// Podsumowanie
// ---------------------------------------------------------------------------

export function summarize(plans: VehiclePlan[]): {
  km: number;
  driveMinutes: number;
  workMinutes: number;
  idleMinutes: number;
  lateStops: number;
  overflow: number;
  warnings: number;
} {
  const acc = { km: 0, driveMinutes: 0, workMinutes: 0, idleMinutes: 0, lateStops: 0, overflow: 0, warnings: 0 };
  for (const p of plans) {
    acc.km += p.totals.km;
    acc.driveMinutes += p.totals.driveMinutes;
    acc.workMinutes += p.totals.workMinutes;
    acc.idleMinutes += p.totals.idleMinutes;
    acc.lateStops += p.totals.lateStops;
    acc.overflow += p.overflow.length;
    acc.warnings += p.warnings.length;
  }
  acc.km = Math.round(acc.km * 10) / 10;
  return acc;
}
