import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeftRight,
  ChevronRight,
  HardHat,
  LogOut,
  Phone,
  Sparkles,
  User,
} from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { TECHNIK_VERSION } from "@/lib/version";
import { cn } from "@/lib/utils";
import { useTechnikAccess } from "../lib/access";
import { useTechnikMe } from "../lib/me";

/**
 * WIĘCEJ — szuflada, do której wchodzi się raz na tydzień.
 *
 * Lista w stylu iOS: wiersze 48 px, wartość po prawej, strzałka tylko tam,
 * gdzie naprawdę coś się otwiera. Wersja panelu (`TECHNIK_VERSION`, NIE wersja
 * CRM-a) jest tu, bo to jedyne miejsce, gdzie technik może ją odczytać przez
 * telefon, gdy coś nie działa.
 */
export function Wiecej() {
  const { user, logout } = useAuth();
  const { isTechnikRole } = useTechnikAccess();
  const { me } = useTechnikMe();

  const tech = me?.technician;
  const technicianName = tech ? `${tech.firstName} ${tech.lastName}`.trim() : null;
  // Podwykonawca ma widzieć wprost, na jakich zasadach jest w systemie —
  // od tego zależy, czego biuro od niego oczekuje przy protokole.
  const technicianKind = tech
    ? tech.type === "internal"
      ? "wewnętrzny"
      : // Przy podwykonawcy nazwa firmy mówi więcej niż samo słowo
        // „podwykonawca” — to ona figuruje na papierach.
        tech.company
        ? `podwykonawca (${tech.company})`
        : "podwykonawca"
    : null;

  return (
    <div className="space-y-5">
      <Group title="Konto">
        <Row icon={User} label="Użytkownik" value={user?.displayName || user?.email || "—"} />
        <Row
          icon={HardHat}
          label="Powiązany technik"
          value={
            technicianName ? (
              <span>
                {technicianName}
                <span className="text-muted-foreground"> · {technicianKind}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">brak powiązania</span>
            )
          }
        />
        {tech?.phone && <Row icon={Phone} label="Telefon" value={tech.phone} />}
      </Group>

      {!me?.linked && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          To konto nie jest połączone z kartoteką Technicy, więc lista zleceń zostanie pusta.
          Poproś administratora o powiązanie.
        </p>
      )}

      <Group title="Aplikacja">
        <LinkRow
          icon={Sparkles}
          label="Co nowego"
          value={`v${TECHNIK_VERSION}`}
          to="/technik/co-nowego"
        />
        {/* Konto biurowe z dostępem do panelu musi mieć drogę powrotną; rola
            `technik` widzi wyłącznie `/technik`, więc jej tego nie pokazujemy. */}
        {!isTechnikRole && (
          <LinkRow icon={ArrowLeftRight} label="Wróć do CRM" to="/" />
        )}
      </Group>

      <button
        type="button"
        onClick={() => void logout()}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-card px-4 text-base font-medium text-destructive active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LogOut className="h-5 w-5" aria-hidden />
        Wyloguj
      </button>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  );
}

const ROW = "flex min-h-12 items-center gap-3 px-3 text-sm";

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof User;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className={ROW}>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  );
}

function LinkRow({
  icon: Icon,
  label,
  value,
  to,
}: {
  icon: typeof User;
  label: string;
  value?: ReactNode;
  to: string;
}) {
  return (
    <Link
      to={to}
      className={cn(ROW, "active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-medium">{label}</span>
      {value && <span className="ml-auto tabular-nums text-muted-foreground">{value}</span>}
      <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground", !value && "ml-auto")} aria-hidden />
    </Link>
  );
}
