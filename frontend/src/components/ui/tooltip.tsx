/* eslint-disable react-refresh/only-export-components */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Building2,
  Clock,
  MapPin,
  Repeat,
  StickyNote,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Lekki tooltip aplikacji — bez zewnętrznych zależności, jeden wspólny wygląd
 * (`bg-popover` + `border` + `shadow-lg`, `text-xs`, treść wieloliniowa,
 * opcjonalny skrót klawiszowy po prawej).
 *
 * Trzy sposoby użycia:
 *   1. `<Tooltip content="…" shortcut="[">{<button …/>}</Tooltip>` — opakowanie
 *      pojedynczego elementu (klonuje go i dokłada handlery).
 *   2. `{...tip("…", { shortcut: "[" })}` — rozsypanie propsów na dowolny element,
 *      także wewnątrz `.map()` (nie jest hookiem, więc nie łamie zasad hooków).
 *   3. Atrybuty `data-tip*` — obsługiwane przez delegowany listener na `document`,
 *      więc działają też dla DOM tworzonego imperatywnie (kafelki FullCalendar).
 *      `{...tipAttrs({ title: "…", pills: […] })}` albo ręcznie
 *      `el.setAttribute("data-tip", "…")`. Bogaty układ (nagłówek, pigułki,
 *      ostrzeżenia) opisuje obiekt `RichTip` serializowany do `data-tip-json`.
 *
 * Zasady zachowania:
 *   - opóźnienie 400 ms przy wejściu, 0 ms przy przejściu między sąsiadami
 *     (okno „grace” 300 ms od ostatniego zamknięcia) → brak migotania,
 *   - zamyka się na wyjściu kursora, `pointerdown`, `blur`, Escape, scroll i resize,
 *   - nie pokazuje się w trakcie przeciągania (pointerdown…pointerup, HTML5 drag)
 *     ani gdy ktoś zawoła `blockTooltips(key, true)` (otwarty podgląd, menu),
 *   - `role="tooltip"` + `aria-describedby` ustawiane na elemencie na czas pokazu,
 *   - klawiatura: pokazuje się na `:focus-visible` (natychmiast), nie na kliknięciu,
 *   - `pointer: coarse` (dotyk) → tooltip w ogóle się nie pokazuje,
 *   - warstwa ma `pointer-events: none`, więc nie blokuje dotyku ani kliknięć,
 *   - dymek nigdy nie nachodzi na element — wybierana jest strona z wolnym miejscem.
 */

export type TooltipSide = "top" | "bottom" | "left" | "right";

/** Kolorystyka pigułki / wiersza w bogatym dymku. */
export type TipTone = "neutral" | "info" | "good" | "warn" | "bad";

/** Ikona wiersza — nazwa zamiast komponentu, bo `data-tip-json` jest tekstem. */
export type TipIcon = "clock" | "users" | "pin" | "repeat" | "note" | "object";

export interface TipPill {
  label: string;
  tone?: TipTone;
}

export interface TipRow {
  /** Etykieta („Technicy”) — renderowana wyszarzoną czcionką przed wartością. */
  label?: string;
  text: string;
  icon?: TipIcon;
}

/**
 * Ustrukturyzowana treść dymka. Serializowana do `data-tip-json` dla elementów
 * budowanych imperatywnie, albo podawana wprost przez `tipAttrs`.
 */
export interface RichTip {
  /** Pierwsza linia, pogrubiona, z kolorową kropką typu (patrz `accent`). */
  title?: string;
  /** Kolor akcentu jako wartość CSS (np. `#0ea5e9`) — kropka przy tytule. */
  accent?: string;
  /**
   * Kolor akcentu jako klasa Tailwind (np. `bg-sky-500`). Preferowany dla typów
   * wydarzeń: zmienne `--cal-*` żyją w `.alfa-calendar`, a warstwa dymka wisi
   * w `<body>`, więc `hsl(var(--cal-…))` by się tam nie rozwiązało.
   */
  accentClass?: string;
  /** Tytuł przekreślony (wydarzenie anulowane / w koszu). */
  strike?: boolean;
  /** Druga linia, wyszarzona: „Serwis · Magazyn Centralny”. */
  meta?: string;
  /** Zwykły tekst wieloliniowy (gdy nie ma sensu rozbijać na wiersze). */
  text?: string;
  rows?: TipRow[];
  pills?: TipPill[];
  /** Ostrzeżenia w kolorze bursztynowym z ikoną (po terminie, konflikt). */
  warnings?: string[];
  /** Drobna podpowiedź na dole, oddzielona linią. */
  hint?: string;
  shortcut?: string;
  side?: TooltipSide;
}

export interface TooltipOptions {
  /** Skrót klawiszowy pokazany po prawej stronie treści. */
  shortcut?: ReactNode;
  /** Preferowana strona (z automatycznym odbiciem przy krawędzi). Domyślnie „top”. */
  side?: TooltipSide;
  /** Własne opóźnienie w ms (domyślnie 400). */
  delay?: number;
}

const TIP_ID = "alfa-tooltip";
const OPEN_DELAY = 400;
/** Okno, w którym przejście na sąsiedni element pokazuje tooltip natychmiast. */
const GRACE_MS = 300;
/** Odstęp dymka od elementu — na tyle duży, żeby kafelek został widoczny. */
const GAP = 10;
const EDGE = 8;

interface TipState {
  /** Rośnie z każdym pokazem — wymusza remount warstwy (świeża, ukryta pozycja startowa). */
  key: number;
  content: ReactNode;
  rich: RichTip | null;
  shortcut?: ReactNode;
  side: TooltipSide;
  anchor: Element;
}

let seq = 0;
let current: TipState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Element, dla którego tyka opóźnienie — potrzebny, by nie gasić własnego dymka. */
let pendingAnchor: Element | null = null;
let lastClosedAt = 0;
/** Trwa przeciąganie / wciśnięty przycisk myszy — żadnych dymków. */
let pointerBusy = false;
/** Blokady zewnętrzne (otwarty podgląd wydarzenia, menu kontekstowe, dialog). */
const blockers = new Set<string>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of Array.from(listeners)) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => current;

/** Dotyk (telefon, tablet) — natywnego tooltipa i tak nie ma, nasz też nie przeszkadza. */
function coarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

let host: HTMLDivElement | null = null;

/** Warstwa tooltipa montuje się leniwie przy pierwszym pokazie (osobny root w <body>). */
function ensureHost() {
  if (host || typeof document === "undefined") return;
  host = document.createElement("div");
  host.setAttribute("data-alfa-tooltip-host", "");
  document.body.appendChild(host);
  createRoot(host).render(<TooltipLayer />);
}

function openNow(next: TipState) {
  if (current && current.anchor !== next.anchor) current.anchor.removeAttribute("aria-describedby");
  current = next;
  next.anchor.setAttribute("aria-describedby", TIP_ID);
  ensureHost();
  emit();
}

/** Natychmiast chowa tooltip (np. przy zmianie widoku, otwarciu dialogu). */
export function hideTooltip() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingAnchor = null;
  if (!current) return;
  current.anchor.removeAttribute("aria-describedby");
  current = null;
  lastClosedAt = Date.now();
  emit();
}

/**
 * Blokuje dymki na czas, gdy przykryłyby coś ważnego (otwarty podgląd wydarzenia,
 * menu kontekstowe, modal). Klucz pozwala kilku źródłom blokować niezależnie.
 */
export function blockTooltips(key: string, on: boolean) {
  const had = blockers.size > 0;
  if (on) blockers.add(key);
  else blockers.delete(key);
  if (!had && blockers.size > 0) hideTooltip();
}

const blocked = () => blockers.size > 0 || pointerBusy;

interface ScheduleInput {
  content?: ReactNode;
  rich?: RichTip | null;
}

function scheduleTooltip(
  anchor: Element,
  input: ScheduleInput,
  opts: TooltipOptions,
  immediate: boolean
) {
  const content = input.content;
  const rich = input.rich ?? null;
  if (!rich && (content == null || content === "" || content === false)) return;
  if (coarsePointer() || blocked()) return;
  // Ten sam element — nie restartuj (brak migotania przy ruchu wewnątrz kafelka).
  if (current?.anchor === anchor) return;
  if (timer && pendingAnchor === anchor) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const next: TipState = {
    key: ++seq,
    content,
    rich,
    shortcut: opts.shortcut ?? rich?.shortcut,
    side: opts.side ?? rich?.side ?? "top",
    anchor,
  };
  const delay = immediate || Date.now() - lastClosedAt < GRACE_MS ? 0 : (opts.delay ?? OPEN_DELAY);
  if (delay <= 0) {
    pendingAnchor = null;
    openNow(next);
    return;
  }
  pendingAnchor = anchor;
  timer = setTimeout(() => {
    timer = null;
    pendingAnchor = null;
    if (anchor.isConnected && !blocked()) openNow(next);
  }, delay);
}

// ---------------------------------------------------------------------------
// API dla Reacta (propsy / opakowanie)
// ---------------------------------------------------------------------------

export interface TooltipTriggerProps {
  onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (e: ReactFocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  onPointerDown: () => void;
}

/**
 * Propsy do rozsypania na elemencie-wyzwalaczu. Zastępuje natywny `title`
 * (nie łącz obu — byłyby dwa dymki).
 */
export function tip(content: ReactNode, opts: TooltipOptions = {}): TooltipTriggerProps {
  return {
    onMouseEnter: (e) => scheduleTooltip(e.currentTarget, { content }, opts, false),
    onMouseLeave: hideTooltip,
    onFocus: (e) => {
      const el = e.currentTarget;
      // Tylko nawigacja klawiaturą — po kliknięciu myszą tooltip nie wyskakuje.
      try {
        if (typeof el.matches === "function" && !el.matches(":focus-visible")) return;
      } catch {
        /* stara przeglądarka bez :focus-visible — pokazujemy */
      }
      scheduleTooltip(el, { content }, opts, true);
    },
    onBlur: hideTooltip,
    onPointerDown: hideTooltip,
  };
}

type ChildProps = Partial<TooltipTriggerProps> & Record<string, unknown>;

const chain =
  <T extends unknown[]>(a: ((...args: T) => void) | undefined, b: (...args: T) => void) =>
  (...args: T) => {
    a?.(...args);
    b(...args);
  };

/** Opakowanie pojedynczego elementu: `<Tooltip content="…"><button …/></Tooltip>`. */
export function Tooltip({
  content,
  shortcut,
  side,
  delay,
  children,
}: TooltipOptions & { content: ReactNode; children: ReactNode }) {
  if (!isValidElement(children)) return <>{children}</>;
  const el = children as ReactElement<ChildProps>;
  const own = el.props;
  const t = tip(content, { shortcut, side, delay });
  return cloneElement(el, {
    onMouseEnter: chain(own.onMouseEnter, t.onMouseEnter),
    onMouseLeave: chain(own.onMouseLeave, t.onMouseLeave),
    onFocus: chain(own.onFocus, t.onFocus),
    onBlur: chain(own.onBlur, t.onBlur),
    onPointerDown: chain(own.onPointerDown, t.onPointerDown),
  });
}

// ---------------------------------------------------------------------------
// API atrybutowe (`data-tip*`) — działa też dla DOM tworzonego imperatywnie
// ---------------------------------------------------------------------------

/** Atrybuty `data-tip*` opisujące dymek. Da się je rozsypać w JSX albo ustawić przez `applyTip`. */
export type TipAttrs = Record<string, string>;

/**
 * Buduje atrybuty dymka. Prosty tekst → `data-tip` (+ `data-tip-title`,
 * `data-tip-tone`), bogaty układ → `data-tip-json`.
 */
export function tipAttrs(spec: string | RichTip, opts: TooltipOptions = {}): TipAttrs {
  if (typeof spec === "string") {
    const attrs: TipAttrs = { "data-tip": spec };
    if (opts.shortcut != null && opts.shortcut !== "") attrs["data-tip-shortcut"] = String(opts.shortcut);
    if (opts.side) attrs["data-tip-side"] = opts.side;
    return attrs;
  }
  const simple =
    !spec.rows?.length &&
    !spec.pills?.length &&
    !spec.warnings?.length &&
    !spec.meta &&
    !spec.hint &&
    !spec.accentClass;
  if (simple && spec.text) {
    const attrs: TipAttrs = { "data-tip": spec.text };
    if (spec.title) attrs["data-tip-title"] = spec.title;
    if (spec.accent) attrs["data-tip-tone"] = spec.accent;
    if (spec.shortcut) attrs["data-tip-shortcut"] = spec.shortcut;
    if (spec.side ?? opts.side) attrs["data-tip-side"] = (spec.side ?? opts.side) as string;
    return attrs;
  }
  return { "data-tip-json": JSON.stringify({ ...spec, side: spec.side ?? opts.side }) };
}

/** Wersja imperatywna `tipAttrs` — czyści stare atrybuty i natywny `title`. */
export function applyTip(el: Element, spec: string | RichTip | null, opts: TooltipOptions = {}) {
  for (const a of ["data-tip", "data-tip-json", "data-tip-title", "data-tip-tone", "data-tip-shortcut", "data-tip-side"]) {
    el.removeAttribute(a);
  }
  // Element z własnym dymkiem nigdy nie ma `title` — byłyby dwa dymki naraz.
  el.removeAttribute("title");
  if (!spec) return;
  for (const [k, v] of Object.entries(tipAttrs(spec, opts))) el.setAttribute(k, v);
}

/** Odczyt dymka z atrybutów elementu. `null` → element nic nie opisuje. */
function readAttrTip(el: Element): { rich: RichTip; opts: TooltipOptions } | null {
  const json = el.getAttribute("data-tip-json");
  if (json) {
    try {
      const parsed = JSON.parse(json) as RichTip;
      if (parsed && typeof parsed === "object") return { rich: parsed, opts: {} };
    } catch {
      /* uszkodzony JSON — spadamy na `data-tip` */
    }
  }
  const text = el.getAttribute("data-tip");
  if (text) {
    return {
      rich: {
        text,
        title: el.getAttribute("data-tip-title") ?? undefined,
        accent: el.getAttribute("data-tip-tone") ?? undefined,
        shortcut: el.getAttribute("data-tip-shortcut") ?? undefined,
        side: (el.getAttribute("data-tip-side") as TooltipSide | null) ?? undefined,
      },
      opts: {},
    };
  }
  return null;
}

const TIP_SELECTOR = "[data-tip],[data-tip-json],[title]";

/**
 * Najbliższy przodek opisujący dymek. Zagnieżdżony znacznik (badge w kafelku)
 * wygrywa nad rodzicem, bo `closest` zwraca element najbliższy kursorowi.
 *
 * Natywny `title` przejmujemy tylko wewnątrz `[data-tip-scope]` (np. siatka
 * FullCalendara, która sama dokleja `title` do „+N więcej” i linków dni) —
 * poza tym zakresem natywne dymki zostawiamy w spokoju.
 */
function tipTargetOf(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest(TIP_SELECTOR);
  if (!el) return null;
  const title = el.getAttribute("title");
  if (title) {
    if (!el.closest("[data-tip-scope]")) return null;
    // Przejęcie: świeży `title` (FullCalendar ustawia go przy każdym renderze)
    // zastępuje poprzednią treść i znika z DOM, żeby nie było dwóch dymków.
    el.setAttribute("data-tip", title);
    el.removeAttribute("title");
  }
  return el.hasAttribute("data-tip") || el.hasAttribute("data-tip-json") ? el : null;
}

function onPointerOver(e: Event) {
  const el = tipTargetOf(e.target);
  if (!el) {
    // Kursor wciąż w środku aktywnego wyzwalacza (np. ikona w przycisku z `tip()`)
    // — dymek zostaje. Dopiero wyjście poza niego chowa.
    const active = current?.anchor ?? pendingAnchor;
    const node = e.target instanceof Node ? e.target : null;
    if (active && node && active.contains(node)) return;
    if (current || timer) hideTooltip();
    return;
  }
  // Nie podmieniaj bardziej szczegółowego dymka (dziecko) na dymek rodzica —
  // dotyczy też dymka, który dopiero czeka na swoje opóźnienie.
  const active = current?.anchor ?? pendingAnchor;
  if (active && active !== el && el.contains(active)) return;
  const spec = readAttrTip(el);
  if (!spec) return;
  scheduleTooltip(el, { rich: spec.rich }, spec.opts, false);
}

function onFocusIn(e: Event) {
  const el = tipTargetOf(e.target);
  if (!el) return;
  try {
    if (typeof el.matches === "function" && !el.matches(":focus-visible")) return;
  } catch {
    /* brak :focus-visible — pokazujemy */
  }
  const spec = readAttrTip(el);
  if (spec) scheduleTooltip(el, { rich: spec.rich }, spec.opts, true);
}

let delegationReady = false;

/** Globalne listenery delegujące — instalowane raz, przy pierwszym imporcie. */
function installDelegation() {
  if (delegationReady || typeof document === "undefined") return;
  delegationReady = true;
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", hideTooltip, true);
  const busy = () => {
    pointerBusy = true;
    hideTooltip();
  };
  const idle = () => {
    pointerBusy = false;
  };
  document.addEventListener("pointerdown", busy, true);
  document.addEventListener("dragstart", busy, true);
  document.addEventListener("pointerup", idle, true);
  document.addEventListener("pointercancel", idle, true);
  document.addEventListener("dragend", idle, true);
  document.addEventListener("drop", idle, true);
}

installDelegation();

// ---------------------------------------------------------------------------
// Warstwa
// ---------------------------------------------------------------------------

const TIP_ICONS: Record<TipIcon, LucideIcon> = {
  clock: Clock,
  users: Users,
  pin: MapPin,
  repeat: Repeat,
  note: StickyNote,
  object: Building2,
};

const PILL_TONE: Record<TipTone, string> = {
  // Pierścień zamiast samego tła — na tle popovera szara pigułka bez obwódki
  // rozmywa się w tekst.
  neutral: "bg-muted text-foreground/80 ring-1 ring-inset ring-border",
  info: "bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/30 dark:bg-sky-400/20 dark:text-sky-200 dark:ring-sky-300/30",
  good: "bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:bg-emerald-400/20 dark:text-emerald-200 dark:ring-emerald-300/30",
  warn: "bg-amber-500/20 text-amber-800 ring-1 ring-inset ring-amber-500/30 dark:bg-amber-400/20 dark:text-amber-200 dark:ring-amber-300/30",
  bad: "bg-red-500/15 text-red-700 ring-1 ring-inset ring-red-500/30 dark:bg-red-400/20 dark:text-red-200 dark:ring-red-300/30",
};

/** Bogaty układ: nagłówek z kropką typu, meta, wiersze, pigułki, ostrzeżenia, podpowiedź. */
function RichTipBody({ data }: { data: RichTip }) {
  const rows = data.rows ?? [];
  const pills = data.pills ?? [];
  const warnings = data.warnings ?? [];
  const hasBody = rows.length > 0 || pills.length > 0 || warnings.length > 0 || !!data.text;
  return (
    <div className="min-w-0 space-y-1.5" data-testid="alfa-tooltip-rich">
      {(data.title || data.meta) && (
        <div className="flex min-w-0 items-start gap-1.5">
          {(data.accent || data.accentClass) && (
            <span
              className={cn(
                "mt-[0.3rem] h-2 w-2 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/20",
                data.accentClass
              )}
              style={data.accent ? { backgroundColor: data.accent } : undefined}
              data-testid="alfa-tooltip-dot"
              aria-hidden
            />
          )}
          <div className="min-w-0">
            {data.title && (
              <div
                className={cn(
                  "text-[0.8125rem] font-semibold leading-tight text-foreground",
                  data.strike && "line-through opacity-70"
                )}
                data-testid="alfa-tooltip-title"
              >
                {data.title}
              </div>
            )}
            {data.meta && (
              <div className="mt-px text-[0.6875rem] leading-tight text-muted-foreground">{data.meta}</div>
            )}
          </div>
        </div>
      )}
      {(data.title || data.meta) && hasBody && <div className="-mx-2 border-t border-border/60" />}
      {data.text && <div className="whitespace-pre-line break-words">{data.text}</div>}
      {rows.length > 0 && (
        <div className="space-y-0.5">
          {rows.map((r, i) => {
            const Icon = r.icon ? TIP_ICONS[r.icon] : null;
            return (
              <div key={i} className="flex min-w-0 items-start gap-1.5 leading-snug">
                {Icon ? (
                  <Icon className="mt-[0.15rem] h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <span className="w-3 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 break-words">
                  {r.label && <span className="text-muted-foreground">{r.label}: </span>}
                  {r.text}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="alfa-tooltip-pills">
          {pills.map((p, i) => (
            <span
              key={i}
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-px text-[0.6875rem] font-medium leading-4",
                PILL_TONE[p.tone ?? "neutral"]
              )}
            >
              {p.label}
            </span>
          ))}
        </div>
      )}
      {warnings.map((w, i) => (
        <div
          key={i}
          className="flex items-start gap-1.5 font-medium leading-snug text-amber-700 dark:text-amber-300"
          data-testid="alfa-tooltip-warning"
        >
          <AlertTriangle className="mt-[0.15rem] h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{w}</span>
        </div>
      ))}
      {data.hint && (
        <div className="-mx-2 border-t border-border/60 px-2 pt-1.5 text-[0.6875rem] leading-tight text-muted-foreground">
          {data.hint}
        </div>
      )}
    </div>
  );
}

/**
 * Umieszcza dymek po stronie, po której naprawdę się mieści — dzięki temu nigdy
 * nie nachodzi na element (przycinana jest tylko oś poprzeczna).
 */
function place(el: HTMLElement, anchor: Element, preferred: TooltipSide) {
  const r = anchor.getBoundingClientRect();
  const { width: w, height: h } = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const opposite: Record<TooltipSide, TooltipSide> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  };
  const order: TooltipSide[] = [];
  for (const s of [preferred, opposite[preferred], "top", "bottom", "right", "left"] as TooltipSide[]) {
    if (!order.includes(s)) order.push(s);
  }
  const space: Record<TooltipSide, number> = {
    top: r.top - EDGE,
    bottom: vh - r.bottom - EDGE,
    left: r.left - EDGE,
    right: vw - r.right - EDGE,
  };
  const need = (s: TooltipSide) => (s === "top" || s === "bottom" ? h : w) + GAP;
  let side = order.find((s) => space[s] >= need(s));
  if (!side) side = order.reduce((a, b) => (space[b] - need(b) > space[a] - need(a) ? b : a));
  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    left = r.left + r.width / 2 - w / 2;
    top = side === "top" ? r.top - h - GAP : r.bottom + GAP;
  } else {
    left = side === "left" ? r.left - w - GAP : r.right + GAP;
    top = r.top + r.height / 2 - h / 2;
  }
  el.style.left = `${Math.max(EDGE, Math.min(left, vw - w - EDGE))}px`;
  el.style.top = `${Math.max(EDGE, Math.min(top, vh - h - EDGE))}px`;
  el.style.visibility = "visible";
  el.dataset.side = side;
}

function TooltipLayer() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const ref = useRef<HTMLDivElement>(null);

  // Pozycję ustawiamy imperatywnie (bez setState w efekcie): warstwa montuje się
  // ukryta i poza ekranem, po zmierzeniu dostaje współrzędne i `visibility`.
  // `key={state.key}` gwarantuje świeży węzeł przy każdym pokazie.
  useLayoutEffect(() => {
    if (!state) return;
    const el = ref.current;
    if (!el) return;
    if (!state.anchor.isConnected) {
      hideTooltip();
      return;
    }
    place(el, state.anchor, state.side);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      // Bez stopPropagation — Escape ma nadal zamykać dialogi/popovery.
      if (e.key === "Escape") hideTooltip();
    };
    const away = () => hideTooltip();
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [state]);

  if (!state) return null;
  const rich = state.rich;
  return (
    <div
      key={state.key}
      ref={ref}
      id={TIP_ID}
      role="tooltip"
      data-testid="alfa-tooltip"
      data-rich={rich && (rich.rows?.length || rich.pills?.length || rich.title) ? "" : undefined}
      style={{ left: -9999, top: -9999, visibility: "hidden" }}
      className={cn(
        "pointer-events-none fixed z-[90] rounded-lg border bg-popover px-2 py-1.5",
        "text-xs font-normal leading-snug text-popover-foreground shadow-lg",
        rich?.rows?.length || rich?.pills?.length ? "max-w-[22rem]" : "max-w-[20rem]"
      )}
    >
      <span className="flex items-start gap-3">
        <span className={cn("min-w-0 break-words", !rich && "whitespace-pre-line")}>
          {rich ? <RichTipBody data={rich} /> : state.content}
        </span>
        {state.shortcut != null && state.shortcut !== "" && (
          <kbd className="mt-px inline-flex h-[1.15rem] min-w-[1.25rem] shrink-0 items-center justify-center rounded border border-b-2 border-border bg-muted/60 px-1 font-mono text-[0.65rem] font-semibold text-foreground">
            {state.shortcut}
          </kbd>
        )}
      </span>
    </div>
  );
}
