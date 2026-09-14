import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * KARTA KROKU — `rounded-xl border bg-card p-3` z małym wersalikowym
 * nagłówkiem, czyli dokładnie to, co widać na karcie zlecenia (`JobCard`)
 * i na ekranie zlecenia. `Section` z separatorem poziomym zostaje tam, gdzie
 * sekcje płyną jedna pod drugą; krok protokołu to zamknięty kawałek treści
 * i ma mieć własną krawędź.
 */
export function Panel({
  icon: Icon,
  title,
  action,
  footer,
  children,
  className,
  bodyClassName,
  ...rest
}: {
  icon?: LucideIcon;
  title?: string;
  /** Akcje w linii nagłówka, wyrównane do prawej (licznik, „Dodaj”). */
  action?: ReactNode;
  /** Pas pod treścią, oddzielony kreską — np. duży przycisk dodawania. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  "data-testid"?: string;
}) {
  return (
    <section
      className={cn("rounded-xl border bg-card p-3 text-card-foreground", className)}
      {...rest}
    >
      {(title || action) && (
        <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            <span className="truncate">{title}</span>
          </h2>
          {action}
        </div>
      )}
      <div className={cn("space-y-3", bodyClassName)}>{children}</div>
      {footer && <div className="mt-3 border-t pt-3">{footer}</div>}
    </section>
  );
}

/** Pole formularza: etykieta, kontrolka, podpowiedź tekstem (nigdy w hoverze). */
export function Field({
  label,
  htmlFor,
  hint,
  action,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {action}
      </div>
      {children}
      {hint && <div className="text-xs leading-snug text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * ŻÓŁTY PASEK OSTRZEŻENIA — brak obiektu, braki przed podpisem. Nic tu nie
 * blokuje: protokół u klienta ma się dać podpisać także wtedy, gdy biuro nie
 * dopięło danych, a technik ma tylko wiedzieć, co poleci dalej niepełne.
 */
export function WarnNote({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <p
      className={cn(
        "flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900",
        "dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
        className,
      )}
      {...rest}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Wiersz „etykieta → wartość” w kartach read-only (klient, podsumowanie). */
export function ReadRow({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-2 text-sm", className)}>
      <dt className="w-28 shrink-0 text-muted-foreground sm:w-36">{label}</dt>
      <dd className="min-w-0 flex-1 whitespace-pre-line break-words font-medium">
        {value || "—"}
      </dd>
    </div>
  );
}
