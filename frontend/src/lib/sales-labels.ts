/**
 * Słownik modułu Handlowy: etykiety PL, ikony i kolory etapów lejka, źródeł,
 * usług i powodów przegranej — jedno miejsce dla kanbanu, listy, karty szansy,
 * pulpitu i aktywności.
 *
 * Zasada ta sama, co w `calendar-labels.ts`: kolor nigdy nie niesie znaczenia
 * sam — zawsze stoi obok ikony i etykiety, a pigułki budujemy `pillClass`,
 * żeby wyglądały jak reszta systemu i przeżyły tryb ciemny.
 */
import {
  Ban,
  Cctv,
  CircleDot,
  Eye,
  FileText,
  Handshake,
  MonitorPlay,
  PhoneCall,
  Shield,
  ShieldAlert,
  Trophy,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  Lead,
  LeadLostReason,
  LeadService,
  LeadSource,
  LeadStage,
} from "@/lib/api";
import { fmtRelative, parseLocal, pillClass, type PillTone } from "@/lib/calendar-labels";

/** Etapy lejka w kolejności — lustro `LEAD_STAGES` z `src/db/schema.ts`. */
export const LEAD_STAGES: LeadStage[] = [
  "nowy",
  "kontakt",
  "wizja",
  "oferta",
  "negocjacje",
  "wygrany",
  "przegrany",
];

/**
 * Etapy OTWARTE — kolumny kanbanu i domyślny zakres listy. Wygrane i przegrane
 * są zamknięciem szansy, nie kolejnym krokiem, więc stoją poza tą listą.
 */
export const LEAD_OPEN_STAGES: LeadStage[] = LEAD_STAGES.slice(0, 5);

export interface LeadStageMeta {
  label: string;
  icon: LucideIcon;
  tone: PillTone;
  /** Pozycja w lejku (0-based) — stepper na karcie i sortowanie kolumn. */
  order: number;
  /** Krótkie wyjaśnienie „co znaczy ten etap" — dymek nad stepperem. */
  hint: string;
}

export const LEAD_STAGE_META: Record<LeadStage, LeadStageMeta> = {
  nowy: {
    label: "Nowy",
    icon: CircleDot,
    tone: "sky",
    order: 0,
    hint: "Zgłoszenie przyjęte, nikt jeszcze nie rozmawiał z klientem",
  },
  kontakt: {
    label: "Kontakt",
    icon: PhoneCall,
    tone: "indigo",
    order: 1,
    hint: "Rozmowa odbyta, znamy potrzebę i osobę decyzyjną",
  },
  wizja: {
    label: "Wizja",
    icon: Eye,
    tone: "violet",
    order: 2,
    hint: "Umówiona albo wykonana wizja lokalna na obiekcie",
  },
  oferta: {
    label: "Oferta",
    icon: FileText,
    tone: "amber",
    order: 3,
    hint: "Oferta wystawiona i wysłana do klienta",
  },
  negocjacje: {
    label: "Negocjacje",
    icon: Handshake,
    tone: "orange",
    order: 4,
    hint: "Ustalamy warunki — cenę, zakres albo termin",
  },
  wygrany: {
    label: "Wygrany",
    icon: Trophy,
    tone: "emerald",
    order: 5,
    hint: "Klient powiedział „tak” — czas założyć obiekt i zlecenie",
  },
  przegrany: {
    label: "Przegrany",
    icon: XCircle,
    tone: "red",
    order: 6,
    hint: "Szansa zamknięta bez sprzedaży (powód jest wymagany)",
  },
};

export const leadStageLabel = (s: LeadStage | string): string =>
  (LEAD_STAGE_META as Record<string, LeadStageMeta>)[s]?.label ?? s;

/** Czy etap zamyka szansę (wygrany/przegrany). */
export const isClosedStage = (s: LeadStage): boolean => s === "wygrany" || s === "przegrany";

/** Pigułka etapu w kształcie badge'y kalendarza (patrz `pillClass`). */
export function stagePillClass(
  stage: LeadStage,
  opts?: { compact?: boolean; className?: string }
): string {
  return pillClass(LEAD_STAGE_META[stage]?.tone ?? "muted", opts);
}

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  polecenie: "Polecenie",
  www: "Strona WWW",
  formularz: "Formularz zgłoszeniowy",
  telefon: "Telefon przychodzący",
  targi: "Targi i wydarzenia",
  inne: "Inne",
};

export const leadSourceLabel = (s: LeadSource | null | undefined): string =>
  s ? LEAD_SOURCE_LABELS[s] ?? s : "—";

export interface LeadServiceMeta {
  label: string;
  icon: LucideIcon;
  tone: PillTone;
}

/**
 * Usługi, o które szansa zabiega. Cztery pierwsze mają odpowiednik 1:1 w
 * usługach obiektu (`objectServiceLabels`); `ochrona` (fizyczna) przy tworzeniu
 * zlecenia mapuje się na `ofi`.
 */
export const LEAD_SERVICE_META: Record<LeadService, LeadServiceMeta> = {
  kamery: { label: "Kamery", icon: Cctv, tone: "sky" },
  sswin: { label: "SSWiN", icon: ShieldAlert, tone: "rose" },
  wideorecepcja: { label: "Wideorecepcja", icon: MonitorPlay, tone: "indigo" },
  ofi: { label: "OFI", icon: Users, tone: "teal" },
  ochrona: { label: "Ochrona fizyczna", icon: Shield, tone: "emerald" },
};

/** Kolejność wyświetlania usług — jak w kartotece obiektu. */
export const LEAD_SERVICES: LeadService[] = [
  "kamery",
  "sswin",
  "wideorecepcja",
  "ofi",
  "ochrona",
];

export const leadServiceLabel = (s: LeadService | string): string =>
  (LEAD_SERVICE_META as Record<string, LeadServiceMeta>)[s]?.label ?? s;

export const LOST_REASON_LABELS: Record<LeadLostReason, string> = {
  cena: "Cena",
  konkurencja: "Konkurencja",
  brak_decyzji: "Brak decyzji",
  brak_potrzeby: "Brak potrzeby",
  brak_kontaktu: "Brak kontaktu",
  inne: "Inne",
};

export const LOST_REASONS: LeadLostReason[] = [
  "cena",
  "konkurencja",
  "brak_decyzji",
  "brak_potrzeby",
  "brak_kontaktu",
  "inne",
];

export const lostReasonLabel = (r: LeadLostReason | null | undefined): string =>
  r ? LOST_REASON_LABELS[r] ?? r : "—";

/** Adres karty szansy. */
export const leadHref = (id: number): string => `/handlowy/leady/${id}`;

/** Próg „gnicia" — ta sama liczba, co `SALES_ROT_DAYS` na backendzie (tylko do tekstu). */
export const SALES_ROT_DAYS = 7;

/**
 * Dymek bursztynowej krawędzi na kanbanie. Powód liczy BACKEND (`rotReason`) —
 * front go wyłącznie tłumaczy, żeby lista i karta mówiły dokładnie to samo.
 */
export function rottingTip(
  lead: Pick<Lead, "rotting" | "rotReason" | "lastActivityAt">
): string | null {
  if (!lead.rotting) return null;
  if (lead.rotReason === "no_activity")
    return "Brak zaplanowanej następnej aktywności — każda otwarta szansa ma mieć następny krok";
  if (lead.rotReason === "idle")
    return `Cisza dłuższa niż ${SALES_ROT_DAYS} dni — czas odezwać się do klienta`;
  return "Szansa wymaga uwagi";
}

/**
 * Wartość ważona: abonament miesięczny przemnożony przez prawdopodobieństwo.
 * Szansa bez P% liczy się jak 0 — inaczej lejek obiecywałby pieniądze,
 * których nikt nie oszacował.
 */
export function weightedValue(
  lead: Pick<Lead, "estimatedMonthly" | "probability">
): number {
  const monthly = Number(lead.estimatedMonthly ?? 0);
  const p = Number(lead.probability ?? 0);
  if (!monthly || !p) return 0;
  return (monthly * p) / 100;
}

/** Ikona „szansa zamknięta bez sprzedaży" — używana przez oś czasu i listy. */
export const LEAD_LOST_ICON: LucideIcon = Ban;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Termin NASTĘPNEGO kroku po polsku — „dziś 14:00”, „jutro 10:00”, „za 3 dni”.
 *
 * `fmtRelative` z `calendar-labels` patrzy wyłącznie w przeszłość (dla daty
 * jutrzejszej odpowiada „przed chwilą”), a moduł handlowy mówi przede wszystkim
 * o tym, co DOPIERO ma się wydarzyć. Terminy przeszłe oddajemy jej z powrotem —
 * „2 dni temu” przy zaległej aktywności jest dokładnie tym, czego się oczekuje.
 */
export function fmtWhen(startAt: string, now = Date.now()): string {
  const d = parseLocal(startAt);
  if (Number.isNaN(d.getTime())) return startAt;
  const diff = d.getTime() - now;
  if (diff <= 0) return fmtRelative(startAt, now);
  const today = new Date(now);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return `dziś ${hhmm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `jutro ${hhmm}`;
  const days = Math.ceil(diff / 86_400_000);
  if (days < 7) return `za ${days} dni`;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
