import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import type {
  CalendarBilling,
  CalendarEventRealization,
  CalendarEventStatus,
  CalendarEventType,
} from "@/lib/api";
import {
  BILLING_META,
  PROTOCOL_BADGE_META,
  REALIZATION_BADGE_META,
  billingBadgeClass,
  billingTip,
  protocolBadgeClass,
  protocolBadgeKind,
  protocolHref,
  protocolTip,
  realizationBadgeClass,
  realizationBadgeKind,
  realizationHref,
  realizationTip,
  splitTip,
} from "@/lib/calendar-labels";
import { tipAttrs } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Wieloliniowy tekst tooltipa → jedna linia dla `aria-label` (czytniki ekranu). */
const flat = (s: string): string => s.replace(/\n/g, " · ");

/**
 * Atrybuty własnego dymka z krótkiego opisu „Nagłówek — wyjaśnienie”.
 * Zastępuje natywny `title` (szary, z sekundą opóźnienia, bez stylu) — obsługą
 * zajmuje się delegowany listener z `components/ui/tooltip`.
 */
const markTip = (text: string | null | undefined) => {
  const spec = splitTip(text);
  return spec ? tipAttrs(spec) : {};
};

/** Pigułka rozliczenia (gwarancyjny / darmowy / płatny). Nic nie renderuje dla null. */
export function BillingBadge({
  billing,
  compact,
  className,
}: {
  billing: CalendarBilling | null | undefined;
  /** Mniejsza pigułka (karty tablicy, listy). */
  compact?: boolean;
  className?: string;
}) {
  if (!billing) return null;
  const m = BILLING_META[billing];
  if (!m) return null;
  return (
    <span
      data-testid="billing-badge"
      data-kind={billing}
      {...markTip(billingTip(billing))}
      className={cn(billingBadgeClass(billing), compact && "px-1.5 py-px text-[10px]", className)}
    >
      <m.icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      {m.label}
    </span>
  );
}

/**
 * Sam znacznik rozliczenia (ikona + tooltip) — do wąskich kontekstów: kafelki
 * FullCalendar, karty tablicy. Nic nie renderuje dla null.
 */
export function BillingMark({
  billing,
  className,
}: {
  billing: CalendarBilling | null | undefined;
  className?: string;
}) {
  if (!billing) return null;
  const m = BILLING_META[billing];
  if (!m) return null;
  const label = billingTip(billing) ?? `Rozliczenie: ${m.label.toLowerCase()}`;
  return (
    <m.icon
      data-testid="billing-mark"
      data-kind={billing}
      className={cn("h-3 w-3 shrink-0", m.tone, className)}
      aria-label={flat(label)}
      {...markTip(label)}
    />
  );
}

export interface ProtocolBadgeEvent {
  type: CalendarEventType | string;
  status: CalendarEventStatus | string;
  protocol?: { id: number; number?: string | null; status: "draft" | "final"; signedAt?: string | null; signed?: boolean } | null;
}

/**
 * Pigułka protokołu: zielona (final), szara (szkic), bursztynowa „Brak protokołu”
 * (tylko wykonane prace na obiekcie). Nic nie renderuje, gdy `protocolBadgeKind` = null.
 * `link` — dla final/draft dodaje link „Otwórz” do modułu Protokoły.
 */
export function ProtocolBadge({
  event,
  compact,
  link,
  className,
}: {
  event: ProtocolBadgeEvent;
  compact?: boolean;
  link?: boolean;
  className?: string;
}) {
  const kind = protocolBadgeKind(event);
  if (!kind) return null;
  const m = PROTOCOL_BADGE_META[kind];
  const num = event.protocol?.number ?? undefined;
  const label = m.label(num);
  const badge = (
    <span
      data-testid="protocol-badge"
      data-kind={kind}
      {...markTip(protocolTip(event))}
      className={cn(protocolBadgeClass(kind), compact && "px-1.5 py-px text-[10px]", className)}
    >
      <m.icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      {compact && kind !== "missing" ? (num ?? "Protokół") : label}
    </span>
  );
  if (link && kind !== "missing" && event.protocol) {
    return (
      <span className="inline-flex items-center gap-1">
        {badge}
        <Link
          to={protocolHref(event.protocol.id)}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
          data-testid="protocol-open-link"
        >
          Otwórz <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      </span>
    );
  }
  return badge;
}

/**
 * Sam znacznik protokołu (ikona + tooltip) — do wąskich kontekstów (siatka, karty).
 * Nic nie renderuje, gdy `protocolBadgeKind` = null.
 */
export function ProtocolMark({ event, className }: { event: ProtocolBadgeEvent; className?: string }) {
  const kind = protocolBadgeKind(event);
  if (!kind) return null;
  const m = PROTOCOL_BADGE_META[kind];
  const label = protocolTip(event) ?? m.label(event.protocol?.number ?? undefined);
  return (
    <m.icon
      data-testid="protocol-mark"
      data-kind={kind}
      className={cn("h-3 w-3 shrink-0", m.tone, className)}
      aria-label={flat(label)}
      {...markTip(label)}
    />
  );
}

export interface RealizationBadgeEvent {
  realization?: CalendarEventRealization | null;
}

/** Opis realizacji do tooltipa — patrz `realizationTip` (stan + kwota, w 2. linii rodzaj · obiekt · data). */
const realizationTitle = (r: CalendarEventRealization): string => realizationTip(r) ?? `Realizacja #${r.id}`;

/**
 * Pigułka realizacji: zielona (zafakturowana), szara (nierozliczona).
 * Nic nie renderuje, gdy wydarzenie nie ma realizacji (albo starszy backend
 * nie zwraca pola `realization`).
 * `link` — dodaje link „Otwórz” do zakładki Realizacje.
 */
export function RealizationBadge({
  event,
  compact,
  link,
  className,
}: {
  event: RealizationBadgeEvent;
  compact?: boolean;
  link?: boolean;
  className?: string;
}) {
  const kind = realizationBadgeKind(event);
  const r = event.realization;
  if (!kind || !r) return null;
  const m = REALIZATION_BADGE_META[kind];
  const badge = (
    <span
      data-testid="realization-badge"
      data-kind={kind}
      {...markTip(realizationTitle(r))}
      className={cn(realizationBadgeClass(kind), compact && "px-1.5 py-px text-[10px]", className)}
    >
      <m.icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      {compact ? (kind === "invoiced" ? "Zafakt." : "Realizacja") : m.label}
    </span>
  );
  if (!link) return badge;
  return (
    <span className="inline-flex items-center gap-1">
      {badge}
      <Link
        to={realizationHref(r.id, r.date)}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
        data-testid="realization-open-link"
      >
        Otwórz <ExternalLink className="h-3 w-3" aria-hidden />
      </Link>
    </span>
  );
}

/**
 * Sam znacznik realizacji (ikona + tooltip) — do wąskich kontekstów (siatka,
 * karty tablicy). Nic nie renderuje bez realizacji.
 */
export function RealizationMark({ event, className }: { event: RealizationBadgeEvent; className?: string }) {
  const kind = realizationBadgeKind(event);
  const r = event.realization;
  if (!kind || !r) return null;
  const m = REALIZATION_BADGE_META[kind];
  const label = realizationTitle(r);
  return (
    <m.icon
      data-testid="realization-mark"
      data-kind={kind}
      className={cn("h-3 w-3 shrink-0", m.tone, className)}
      aria-label={flat(label)}
      {...markTip(label)}
    />
  );
}
