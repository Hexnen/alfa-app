import type { LucideIcon } from "lucide-react";
import { Navigation, Phone } from "lucide-react";
import type { TechnikJobDetails, TechnikJobDistance } from "@/lib/api";
import { fmtMinutes } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { mapsHref, telHref } from "../lib/jobs";

/**
 * DWA KAFLE POD KCIUKIEM — „Nawiguj” i „Zadzwoń”.
 *
 * Stoją zaraz pod nagłówkiem, bo to jedyne dwie rzeczy, których technik szuka
 * JADĄC: dokąd i do kogo. Oba mają stałą pozycję i identyczny rozmiar (h-14),
 * więc trafia się w nie bez patrzenia.
 *
 * Kafel bez danych NIE ZNIKA — szarzeje i mówi dlaczego („Brak numeru”).
 * Znikający kafel przesuwałby ten drugi pod palec i technik dzwoniłby zamiast
 * nawigować.
 */
export function KafleAkcji({
  job,
  distance,
  distanceLoading,
}: {
  job: TechnikJobDetails;
  distance: TechnikJobDistance | null;
  distanceLoading: boolean;
}) {
  const navHref = mapsHref(job);
  const phoneHref = telHref(job.contactPhone);
  const address = job.address || job.objectName;
  const trip = distance?.km != null ? officeTripLabel(distance) : null;

  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
      <Kafel
        icon={Navigation}
        label="Nawiguj"
        sub={navHref ? address : "Brak adresu"}
        href={navHref}
        external
        disabledReason={navHref ? null : "Brak adresu"}
        testId="zlecenie-nawiguj"
      />
      <Kafel
        icon={Phone}
        label="Zadzwoń"
        sub={phoneHref ? job.contactPerson || job.contactPhone : "Brak numeru"}
        href={phoneHref}
        disabledReason={phoneHref ? null : "Brak numeru"}
        testId="zlecenie-zadzwon"
      />

      {/* Dojazd z biura — pod kaflem nawigacji, bo opisuje właśnie jego.
          Miejsce jest zarezerwowane także w trakcie liczenia, żeby kafle nie
          podskakiwały technikowi pod palcem. */}
      <p
        className="col-start-1 min-h-4 truncate text-xs tabular-nums text-muted-foreground"
        data-testid="zlecenie-dojazd"
      >
        {trip ?? (distanceLoading ? "Liczę dojazd…" : "")}
      </p>
    </div>
  );
}

/**
 * Jeden kafel: ikona, etykieta i podtytuł (adres / imię kontaktu). Wyłączony
 * wariant to `<div>`, a nie `<a>` — link bez celu na dotyku tylko myli.
 */
function Kafel({
  icon: Icon,
  label,
  sub,
  href,
  external,
  disabledReason,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  sub: string | null;
  href: string | null;
  external?: boolean;
  disabledReason: string | null;
  testId: string;
}) {
  const base =
    "flex h-14 min-w-0 items-center gap-2.5 rounded-xl border px-3 text-left transition-colors";
  const body = (
    <>
      <Icon
        className={cn("h-5 w-5 shrink-0", disabledReason ? "text-muted-foreground" : "text-primary")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-tight">{label}</span>
        {sub && (
          <span className="block truncate text-xs leading-tight text-muted-foreground">{sub}</span>
        )}
      </span>
    </>
  );

  if (!href) {
    return (
      <div
        className={cn(base, "border-dashed bg-muted/40 opacity-70")}
        aria-disabled="true"
        aria-label={`${label} — ${disabledReason}`}
        data-testid={testId}
      >
        {body}
      </div>
    );
  }

  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={cn(
        base,
        "bg-card shadow-sm hover:bg-muted/40 active:scale-[0.99]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      data-testid={testId}
    >
      {body}
    </a>
  );
}

/** „23,4” — jedno miejsce po przecinku, z polskim przecinkiem. */
const kmText = (km: number): string => km.toLocaleString("pl-PL", { maximumFractionDigits: 1 });

/**
 * „Z biura: 23,4 km · ok. 35 min” — dystans i czas w JEDNĄ stronę (tak liczy
 * backend). Czas z routera dostaje „ok.”, czas z szacunku (trasa w linii
 * prostej, stary wpis cache'u) — „≈”, żeby nie udawał wyniku nawigacji.
 */
function officeTripLabel(d: TechnikJobDistance): string {
  const head = `Z biura: ${kmText(d.km ?? 0)} km`;
  if (d.minutes == null || !Number.isFinite(d.minutes)) return head;
  // Powyżej godziny „95 min” nic technikowi nie mówi — `fmtMinutes` daje
  // „1 godz. 35 min” (ten sam format, co w kalendarzu).
  const mins = Math.max(1, Math.round(d.minutes));
  return `${head} · ${d.minutesEstimated ? "≈" : "ok."} ${fmtMinutes(mins)}`;
}
