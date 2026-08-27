/**
 * Dialog „Uzupełnij automatycznie" (kontrakt AUTOFILL §4).
 *
 * Pokazuje sugestie automatu jako listę różnic „obecnie → proponowane" wraz ze
 * źródłem i szczegółami wyliczenia. Nic nie nadpisuje po cichu: pola sprzeczne
 * (`confident: false`) są wyróżnione na bursztynowo i domyślnie odznaczone.
 *
 * Defensywnie: brak endpointu (404) → komunikat i zablokowany zapis; brak
 * uprawnień (403) i realizacja zafakturowana → tylko podgląd.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Info, Loader2, TriangleAlert, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  errStatus,
  isMissingEndpoint,
  realizationAutofillApi,
  type AutofillPreview,
  type AutofillSuggestion,
  type Realization,
} from "@/lib/api";
import {
  autofillFieldLabel,
  autofillSourceGenitive,
  autofillSourceTone,
  fmtAutofillValue,
  suggestionLabel,
} from "./autofill-format";

interface AutofillDialogProps {
  open: boolean;
  realization: Realization;
  onClose: () => void;
  /** Zaktualizowana realizacja + zastosowane sugestie (do adnotacji w formularzu). */
  onApplied: (updated: Realization, applied: AutofillSuggestion[]) => void;
}

export function AutofillDialog({ open, realization, onClose, onApplied }: AutofillDialogProps) {
  const [preview, setPreview] = useState<AutofillPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const data = await realizationAutofillApi.preview(realization.id);
      setPreview(data);
      // Domyślnie zaznaczone tylko pola bezkonfliktowe — resztę potwierdza człowiek.
      setPicked(data.suggestions.filter((s) => s.confident).map((s) => s.field));
    } catch (e) {
      setPreview(null);
      if (isMissingEndpoint(e)) {
        setUnavailable(true);
      } else {
        setError(e instanceof Error ? e.message : "Nie udało się policzyć sugestii");
      }
    } finally {
      setLoading(false);
    }
  }, [realization.id]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const toggle = (field: string) =>
    setPicked((p) => (p.includes(field) ? p.filter((f) => f !== field) : [...p, field]));

  const suggestions = preview?.suggestions ?? [];
  const warnings = preview?.warnings ?? [];
  const conflicts = suggestions.filter((s) => !s.confident).length;
  const readOnly = realization.invoiced;

  const apply = async () => {
    if (picked.length === 0 || readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await realizationAutofillApi.apply(realization.id, picked);
      onApplied(updated, suggestions.filter((s) => picked.includes(s.field)));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zapisać");
      if (errStatus(e) === 409 || errStatus(e) === 428) void load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="autofill-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-primary" aria-hidden />
            Uzupełnij automatycznie
          </DialogTitle>
          <DialogDescription>
            {realization.site} ·{" "}
            {new Date(realization.date).toLocaleDateString("pl-PL", {
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
            . Automat czyta kalendarz, protokół, cennik i ustawienia firmy — zapisuje tylko zaznaczone pola.
          </DialogDescription>
        </DialogHeader>

        {readOnly && (
          <Note tone="warn">
            Realizacja jest zafakturowana — poniżej tylko podgląd, zapis jest zablokowany.
          </Note>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Liczenie sugestii…
          </div>
        ) : unavailable ? (
          <Note tone="info" testId="autofill-unavailable">
            Automat nie jest dostępny w tej wersji backendu (brak endpointu{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">/realizations/{realization.id}/autofill</code>).
            Uzupełnij pola ręcznie albo zaktualizuj aplikację.
          </Note>
        ) : error ? (
          <Note tone="error" testId="autofill-error">
            {error}
          </Note>
        ) : suggestions.length === 0 ? (
          <Note tone="info" testId="autofill-empty">
            Automat nie ma czego podstawić — brak powiązanego wydarzenia, protokołu i danych do kalkulacji, albo
            wszystkie pola są już wypełnione tak, jak wyszłoby z wyliczenia.
          </Note>
        ) : (
          <ul className="space-y-2" data-testid="autofill-suggestions">
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.field}
                suggestion={s}
                checked={picked.includes(s.field)}
                disabled={readOnly || saving}
                onToggle={() => toggle(s.field)}
              />
            ))}
          </ul>
        )}

        {warnings.length > 0 && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
            data-testid="autofill-warnings"
          >
            <p className="mb-1 flex items-center gap-1.5 font-medium">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Automat czegoś nie dopasował
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {suggestions.length > 0 && (
              <>
                Zaznaczono <strong className="tabular-nums text-foreground">{picked.length}</strong> z{" "}
                {suggestions.length}
                {conflicts > 0 && ` · ${conflicts} sprzecznych z obecną wartością`}
              </>
            )}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Anuluj
            </Button>
            <Button
              type="button"
              data-testid="autofill-apply"
              disabled={saving || loading || readOnly || picked.length === 0}
              onClick={() => void apply()}
              {...(readOnly ? tip("Realizacja zafakturowana — automat nie zapisuje zmian") : {})}
            >
              {saving ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Wand2 className="mr-1 h-4 w-4" aria-hidden />
              )}
              Zastosuj zaznaczone
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionRow({
  suggestion: s,
  checked,
  disabled,
  onToggle,
}: {
  suggestion: AutofillSuggestion;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const conflict = !s.confident;
  return (
    <li>
      <label
        data-testid={`autofill-row-${s.field}`}
        data-conflict={conflict ? "1" : undefined}
        className={cn(
          "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
          disabled && "cursor-not-allowed opacity-70",
          conflict
            ? "border-amber-500/50 bg-amber-500/[0.07] hover:bg-amber-500/[0.12]"
            : checked
              ? "border-primary/60 bg-primary/5"
              : "hover:bg-accent/40"
        )}
      >
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={`Zastosuj: ${suggestionLabel(s)}`}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{suggestionLabel(s)}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
                autofillSourceTone(s.source)
              )}
            >
              {s.source}
            </span>
            {conflict && (
              <span
                className="rounded-full bg-amber-500/20 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200"
                {...tip("Pole ma już inną wartość — zaznacz świadomie, żeby ją nadpisać")}
              >
                nadpisze
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm tabular-nums">
            <span className={cn("text-muted-foreground", conflict && "line-through")}>
              {fmtAutofillValue(s.field, s.current)}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <span className="font-semibold">{fmtAutofillValue(s.field, s.suggested)}</span>
          </div>
          {s.detail && <p className="text-xs text-muted-foreground">{s.detail}</p>}
        </div>
      </label>
    </li>
  );
}

function Note({
  tone,
  testId,
  children,
}: {
  tone: "info" | "warn" | "error";
  testId?: string;
  children: ReactNode;
}) {
  const Icon = tone === "error" ? TriangleAlert : tone === "warn" ? TriangleAlert : Info;
  return (
    <div
      data-testid={testId}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2 rounded-md border px-3 py-2 text-sm",
        tone === "error"
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : tone === "warn"
            ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
            : "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Drobna adnotacja pod polem liczbowym w formularzu realizacji: skąd wzięła się
 * wartość. Pełny opis wyliczenia siedzi w dymku.
 */
export function AutofillHint({ suggestion, applied }: { suggestion: AutofillSuggestion; applied?: boolean }) {
  const short = `z ${autofillSourceGenitive(suggestion.source)}: ${fmtAutofillValue(
    suggestion.field,
    suggestion.suggested
  )}`;
  return (
    <p
      data-testid={`autofill-hint-${suggestion.field}`}
      className="inline-flex max-w-full items-center gap-1 text-[11px] text-muted-foreground"
      {...tip(suggestion.detail || short)}
    >
      <Wand2 className={cn("h-3 w-3 shrink-0", applied ? "text-primary" : "")} aria-hidden />
      <span className="truncate">{applied ? short : `automat proponuje: ${short}`}</span>
    </p>
  );
}

/** Pigułka „auto" — pole/wiersz uzupełniony automatem. */
export function AutoBadge({ fields, className }: { fields: string[]; className?: string }) {
  if (fields.length === 0) return null;
  return (
    <span
      data-testid="autofill-badge"
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary",
        className
      )}
      {...tip(`Uzupełnione automatem: ${fields.map(autofillFieldLabel).join(", ")}`)}
    >
      <Wand2 className="h-3 w-3" aria-hidden />
      auto
    </span>
  );
}
