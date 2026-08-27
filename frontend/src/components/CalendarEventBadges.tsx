import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import type { CalendarBilling, CalendarEventStatus, CalendarEventType } from "@/lib/api";
import {
  BILLING_META,
  PROTOCOL_BADGE_META,
  billingBadgeClass,
  protocolBadgeClass,
  protocolBadgeKind,
  protocolHref,
} from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";

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
      title={`Rozliczenie: ${m.label} — ${m.hint}`}
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
  return (
    <m.icon
      data-testid="billing-mark"
      data-kind={billing}
      className={cn("h-3 w-3 shrink-0", m.tone, className)}
      aria-label={`Rozliczenie: ${m.label}`}
    >
      <title>{`Rozliczenie: ${m.label} — ${m.hint}`}</title>
    </m.icon>
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
      title={kind === "missing" ? "Wykonane, ale bez protokołu" : `${label} (${kind === "final" ? "zatwierdzony" : "szkic"})`}
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
  const num = event.protocol?.number ?? undefined;
  const label =
    kind === "missing" ? "Brak protokołu" : `${m.label(num)} (${kind === "final" ? "zatwierdzony" : "szkic"})`;
  return (
    <m.icon
      data-testid="protocol-mark"
      data-kind={kind}
      className={cn("h-3 w-3 shrink-0", m.tone, className)}
      aria-label={label}
    >
      <title>{label}</title>
    </m.icon>
  );
}
