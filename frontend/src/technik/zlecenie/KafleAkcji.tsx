import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Navigation, Phone } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  ConfirmDialog,
} from "../ui/confirm";
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
  const [callOpen, setCallOpen] = useState(false);
  // Lista „do kogo zadzwonić”: backend zbiera kontakt z wydarzenia, osobę
  // kontaktową kontrahenta i kontakty z kartoteki (bez powtórzonych numerów).
  // Gdy jest jedna osoba — samo pytanie; gdy więcej — wybór z listy.
  const contacts = (job.contacts ?? []).filter((k) => telHref(k.phone));
  const many = contacts.length > 1;
  const callSub = many
    ? `${contacts.length} kontakty`
    : phoneHref
      ? job.contactPerson || job.contactPhone
      : "Brak numeru";
  const dial = (phone: string) => {
    const href = telHref(phone);
    setCallOpen(false);
    if (href) window.location.assign(href);
  };
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
      {/* Telefon przez pytanie: kafel siedzi pod kciukiem, a przypadkowe
          dotknięcie w aucie wybierałoby numer klienta bez ostrzeżenia. */}
      <Kafel
        icon={Phone}
        label="Zadzwoń"
        sub={callSub}
        href={phoneHref ?? (many ? "#" : null)}
        onClick={phoneHref || many ? () => setCallOpen(true) : undefined}
        disabledReason={phoneHref || many ? null : "Brak numeru"}
        testId="zlecenie-zadzwon"
      />
      {many && (
        <AlertDialog open={callOpen} onOpenChange={setCallOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>Do kogo zadzwonić?</AlertDialogTitle>
            <AlertDialogDescription>{job.objectName ?? "Kontakty do zlecenia"}</AlertDialogDescription>
            {/* Lista dostaje WŁASNY scroll, żeby tytuł i „Anuluj” zostały na
                swoich miejscach także przy pięciu kontaktach na telefonie
                w poziomie. */}
            <ul
              className="-mx-1 flex min-h-0 max-h-[50dvh] flex-col gap-2 overflow-y-auto overscroll-contain px-1"
              data-testid="zlecenie-kontakty"
            >
              {contacts.map((k) => (
                <li key={`${k.source}-${k.phone}`}>
                  <button
                    type="button"
                    onClick={() => dial(k.phone)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl border bg-card px-3 py-2 text-left active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Phone className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                    {/* NUMER PIERWSZY I W CAŁOŚCI. Sklejone „rola · numer”
                        ucinało się na telefonie dokładnie na numerze, czyli na
                        jedynej rzeczy, po której technik wybiera, do kogo
                        dzwoni. Rola schodzi linijkę niżej i tylko ona może się
                        uciąć. */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold leading-tight">{k.name}</span>
                      <span className="block text-xs leading-tight tabular-nums text-muted-foreground">
                        {k.phone}
                      </span>
                      {k.role && (
                        <span className="block truncate text-xs leading-tight text-muted-foreground">
                          {k.role}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel>Anuluj</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <ConfirmDialog
        open={callOpen && !many}
        onOpenChange={setCallOpen}
        title={`Zadzwonić do ${job.contactPerson || "kontaktu"}?`}
        description={job.contactPhone ?? undefined}
        confirmLabel="Zadzwoń"
        variant="default"
        onConfirm={() => {
          setCallOpen(false);
          if (phoneHref) window.location.assign(phoneHref);
        }}
      />

      {/* Dojazd z biura — pod kaflem nawigacji, bo opisuje właśnie jego.
          Miejsce jest zarezerwowane także w trakcie liczenia, żeby kafle nie
          podskakiwały technikowi pod palcem. */}
      <p
        className="col-start-1 min-h-4 text-xs tabular-nums text-muted-foreground line-clamp-2"
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
  onClick,
  disabledReason,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  sub: string | null;
  href: string | null;
  external?: boolean;
  /** Gdy podane, kafel jest przyciskiem (akcja z potwierdzeniem), nie linkiem. */
  onClick?: () => void;
  disabledReason: string | null;
  testId: string;
}) {
  // `min-h-14`, a nie `h-14`: adres („ul. Marszałkowska 100 lok. 44, Warszawa”)
  // nie mieści się na 390 px w jednej linii, a to jedyna treść tego kafla.
  const base =
    "flex min-h-14 min-w-0 items-center gap-2.5 rounded-xl border px-3 py-1.5 text-left transition-colors";
  const body = (
    <>
      <Icon
        className={cn("h-5 w-5 shrink-0", disabledReason ? "text-muted-foreground" : "text-primary")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-tight">{label}</span>
        {/* Bez `block`: `line-clamp-2` ustawia własny `display`, a `block` stoi
            w arkuszu później i klamra przestawała działać. */}
        {sub && (
          <span className="text-xs leading-tight text-muted-foreground line-clamp-2">{sub}</span>
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

  const active = cn(
    base,
    "bg-card shadow-sm hover:bg-muted/40 active:scale-[0.99]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(active, "w-full")} data-testid={testId}>
        {body}
      </button>
    );
  }

  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={active}
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
