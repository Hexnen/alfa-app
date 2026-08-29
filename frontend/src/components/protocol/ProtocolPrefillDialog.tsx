/**
 * Dialog „Uzupełnij z danych" dla protokołu powykonawczego.
 *
 * Pokazuje, co system już wie o zleceniu (wydarzenie kalendarza → obiekt → kontrahent
 * → cennik) jako listę różnic „obecnie → proponowane" ze źródłem i checkboxem.
 * Nic nie nadpisuje po cichu: pola, które mają już inną wartość (`confident: false`),
 * są wyróżnione na bursztynowo i domyślnie odznaczone.
 *
 * Ten sam wzorzec, co `components/realization/AutofillDialog.tsx` — celowo, żeby
 * „uzupełnij automatycznie" wyglądało tak samo w realizacjach i w protokołach.
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
  protocolPrefillApi,
  type Protocol,
  type ProtocolPrefillApplied,
  type ProtocolPrefillPreview,
  type ProtocolSuggestion,
} from "@/lib/api";
import {
  fmtPrefillValue,
  prefillSourceGenitive,
  prefillSourceTone,
} from "./prefill-format";

interface ProtocolPrefillDialogProps {
  open: boolean;
  protocol: Protocol;
  onClose: () => void;
  /** Zapisany protokół + zastosowane sugestie (formularz podstawia je do pól). */
  onApplied: (updated: ProtocolPrefillApplied, applied: ProtocolSuggestion[]) => void;
}

export function ProtocolPrefillDialog({
  open,
  protocol,
  onClose,
  onApplied,
}: ProtocolPrefillDialogProps) {
  const [preview, setPreview] = useState<ProtocolPrefillPreview | null>(null);
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
      const data = await protocolPrefillApi.preview(protocol.id);
      setPreview(data);
      // Domyślnie zaznaczone tylko pola puste — resztę potwierdza człowiek.
      setPicked(data.suggestions.filter((s) => s.confident).map((s) => s.field));
    } catch (e) {
      setPreview(null);
      if (isMissingEndpoint(e)) setUnavailable(true);
      else setError(e instanceof Error ? e.message : "Nie udało się policzyć sugestii");
    } finally {
      setLoading(false);
    }
  }, [protocol.id]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const toggle = (field: string) =>
    setPicked((p) => (p.includes(field) ? p.filter((f) => f !== field) : [...p, field]));

  const suggestions = preview?.suggestions ?? [];
  const conflicts = suggestions.filter((s) => !s.confident && !s.assumed).length;
  const assumed = suggestions.filter((s) => s.assumed).length;
  const ctx = preview?.context ?? null;

  const apply = async () => {
    if (picked.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await protocolPrefillApi.apply(protocol.id, picked);
      onApplied(
        updated,
        suggestions.filter((s) => (updated.applied ?? picked).includes(s.field))
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zapisać");
      if (errStatus(e) === 409) void load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="protocol-prefill-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-primary" aria-hidden />
            Uzupełnij z danych
          </DialogTitle>
          <DialogDescription>
            Protokół {protocol.number}. Dane biorą się z wydarzenia w kalendarzu, obiektu i jego
            kontrahenta oraz z cennika technika — zapisujemy tylko zaznaczone pola.
          </DialogDescription>
        </DialogHeader>

        {ctx && (
          <p className="text-xs text-muted-foreground" data-testid="protocol-prefill-context">
            Źródła:{" "}
            {[
              ctx.event ? `wydarzenie #${ctx.event.id} (${ctx.event.title})` : null,
              ctx.object ? `obiekt ${ctx.object.name}` : null,
              ctx.contractor ? `kontrahent ${ctx.contractor.name}` : null,
              ctx.priceList
                ? `cennik „${ctx.priceList.name}” (${ctx.priceList.via}${
                    ctx.priceList.technician ? `: ${ctx.priceList.technician}` : ""
                  })`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "brak powiązanych danych"}
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Szukanie danych…
          </div>
        ) : unavailable ? (
          <Note tone="info" testId="protocol-prefill-unavailable">
            Uzupełnianie nie jest dostępne w tej wersji backendu (brak endpointu{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              /protocols/{protocol.id}/prefill
            </code>
            ). Wypełnij pola ręcznie albo zaktualizuj aplikację.
          </Note>
        ) : error ? (
          <Note tone="error" testId="protocol-prefill-error">
            {error}
          </Note>
        ) : suggestions.length === 0 ? (
          <Note tone="info" testId="protocol-prefill-empty">
            Nie ma czego podstawić — protokół ma już wszystko, co system wie o tym zleceniu.
          </Note>
        ) : (
          <ul className="space-y-2" data-testid="protocol-prefill-suggestions">
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.field}
                suggestion={s}
                checked={picked.includes(s.field)}
                disabled={saving}
                onToggle={() => toggle(s.field)}
              />
            ))}
          </ul>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {suggestions.length > 0 && (
              <>
                Zaznaczono <strong className="tabular-nums text-foreground">{picked.length}</strong> z{" "}
                {suggestions.length}
                {conflicts > 0 && ` · ${conflicts} nadpisze obecną wartość`}
                {assumed > 0 && ` · ${assumed} to szacunek do potwierdzenia`}
              </>
            )}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Anuluj
            </Button>
            <Button
              type="button"
              data-testid="protocol-prefill-apply"
              disabled={saving || loading || picked.length === 0}
              onClick={() => void apply()}
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
  suggestion: ProtocolSuggestion;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  // Szacunek (godziny z normy dnia) nie nadpisuje niczego — ma własną, łagodniejszą pigułkę.
  const assumed = !!s.assumed;
  const conflict = !s.confident && !assumed;
  return (
    <li>
      <label
        data-testid={`protocol-prefill-row-${s.field}`}
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
          aria-label={`Uzupełnij: ${s.label}`}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{s.label}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
                prefillSourceTone(s.source)
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
            {assumed && (
              <span
                className="rounded-full bg-slate-500/20 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200"
                {...tip("Wartość wyliczona z normy dnia, a nie z terminu — potwierdź albo popraw ręcznie")}
              >
                szacunek
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cn("text-muted-foreground", conflict && "line-through")}>
              {fmtPrefillValue(s.field, s.current)}
            </span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="font-semibold">{fmtPrefillValue(s.field, s.suggested)}</span>
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
  const Icon = tone === "info" ? Info : TriangleAlert;
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

/** Drobna adnotacja pod uzupełnionym polem: skąd wzięła się wartość (pełny opis w dymku). */
export function PrefillHint({ suggestion }: { suggestion: ProtocolSuggestion }) {
  return (
    <p
      data-testid={`protocol-prefill-hint-${suggestion.field}`}
      className="inline-flex max-w-full items-center gap-1 text-[11px] text-muted-foreground"
      {...tip(suggestion.detail || `z ${prefillSourceGenitive(suggestion.source)}`)}
    >
      <Wand2 className="h-3 w-3 shrink-0 text-primary" aria-hidden />
      <span className="truncate">z {prefillSourceGenitive(suggestion.source)}</span>
    </p>
  );
}
