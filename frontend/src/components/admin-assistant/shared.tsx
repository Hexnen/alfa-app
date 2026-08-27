import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AssistantSettingSource } from "@/lib/api";
import { SOURCE_LABEL } from "./helpers";

// ---------------------------------------------------------------------------
// Collapsible „Zaawansowane”
// ---------------------------------------------------------------------------

/**
 * Prosty Collapsible (bez nowej zależności): przycisk z aria-expanded + panel.
 * Gdy zwinięty, a w środku są zmienione/błędne pola — pokazuje to w nagłówku,
 * żeby nic nie „zniknęło” użytkownikowi.
 */
export function AdvancedBlock({
  id,
  open,
  onToggle,
  dirtyCount = 0,
  errorCount = 0,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  dirtyCount?: number;
  errorCount?: number;
  children: ReactNode;
}) {
  const panelId = `${id}-panel`;
  return (
    <div className="rounded-md border border-dashed">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-accent/50"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onToggle(!open)}
      >
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        Zaawansowane
        {!open && dirtyCount > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            zmienione: {dirtyCount}
          </Badge>
        )}
        {!open && errorCount > 0 && (
          <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
            błędy: {errorCount}
          </Badge>
        )}
        {!open && dirtyCount === 0 && errorCount === 0 && (
          <span className="text-xs font-normal text-muted-foreground">rzadko zmieniane ustawienia</span>
        )}
      </button>
      {open && (
        <div id={panelId} className="space-y-5 border-t px-3 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drobne komponenty UI
// ---------------------------------------------------------------------------

export function SourceBadge({ source }: { source: AssistantSettingSource | undefined }) {
  if (!source) return null;
  return (
    <Badge
      variant={source === "db" ? "info" : source === "env" ? "warning" : "outline"}
      className="h-5 px-1.5 text-[10px] font-medium"
      title={`Źródło wartości: ${SOURCE_LABEL[source]}`}
    >
      {SOURCE_LABEL[source]}
    </Badge>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
      {children}
    </div>
  );
}

/** Przełącznik on/off (brak komponentu Switch w ui — własna implementacja z role="switch"). */
export function Switch({
  checked,
  onChange,
  disabled,
  id,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
  label: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}

/** Wiersz pola: etykieta + badge źródła + kontrolka + opis. */
export function Field({
  id,
  label,
  source,
  description,
  dirty,
  error,
  children,
  inline,
}: {
  id: string;
  label: string;
  source?: AssistantSettingSource;
  description?: ReactNode;
  dirty?: boolean;
  error?: string;
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={cn("space-y-1.5", inline && "flex items-start justify-between gap-4 space-y-0")}>
      <div className={cn("space-y-1.5", inline ? "min-w-0 flex-1" : "contents")}>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          <SourceBadge source={source} />
          {dirty && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              zmienione
            </Badge>
          )}
        </div>
        {inline && description && <p className="text-xs text-muted-foreground">{description}</p>}
        {inline && error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      {children}
      {!inline && description && <p className="text-xs text-muted-foreground">{description}</p>}
      {!inline && error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SectionCard({
  id,
  title,
  description,
  onReset,
  resetDisabled,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  onReset?: () => void;
  resetDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {onReset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 self-start text-muted-foreground"
            onClick={onReset}
            disabled={resetDisabled}
            title="Usuń wartości tej sekcji z bazy (powrót do env/domyślnych)"
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Przywróć domyślne
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

export function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums" title={value}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

