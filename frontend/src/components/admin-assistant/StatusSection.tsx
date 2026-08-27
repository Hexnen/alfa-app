import { CheckCircle2, Loader2, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AdminAssistantTestResult } from "@/lib/api";
import { SectionCard, SourceBadge } from "./shared";
import { keySourceLabel, type FormApi } from "./helpers";

/** Karta „Stan”: bieżące (zapisane) połączenie + test z wartościami z formularza. */
export function StatusSection({
  form,
  effectiveBaseUrl,
  testing,
  testResult,
  onTest,
}: {
  form: FormApi;
  effectiveBaseUrl: string;
  testing: boolean;
  testResult: AdminAssistantTestResult | null;
  onTest: () => void;
}) {
  const { values, sources, settings } = form;
  const apiKey = settings.apiKey;
  const stateBadge = !values.enabled
    ? { variant: "secondary" as const, label: "Wyłączony" }
    : apiKey.set
      ? { variant: "success" as const, label: "Skonfigurowany" }
      : { variant: "destructive" as const, label: "Nieskonfigurowany" };

  return (
    <SectionCard id="stan" title="Stan" description="Tak asystent działa w tej chwili — po zapisanych ustawieniach.">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Status</div>
          <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Model</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{values.model}</span>
            <SourceBadge source={sources.model} />
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Klucz API</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{apiKey.masked ?? "—"}</span>
            <Badge variant={apiKey.set ? (apiKey.source === "db" ? "info" : "warning") : "destructive"} className="h-5 px-1.5 text-[10px]">
              {keySourceLabel(apiKey.source)}
            </Badge>
          </div>
        </div>
        <div className="space-y-1 sm:col-span-3">
          <div className="text-xs text-muted-foreground">Dostawca</div>
          <div className="text-sm">
            {values.providerLabel} <span className="font-mono text-xs text-muted-foreground">({effectiveBaseUrl})</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
          Testuj połączenie
        </Button>
        <span className="text-xs text-muted-foreground">
          Test wysyła krótkie zapytanie z tym, co jest teraz w formularzu (model, adres, nowy klucz jeśli wpisany) — nic nie zapisuje.
        </span>
      </div>
      {testResult && (
        <div
          role="status"
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            testResult.ok
              ? "border-green-600/40 bg-green-600/10 text-green-700 dark:text-green-400"
              : "border-destructive/50 bg-destructive/10 text-destructive"
          )}
        >
          {testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <div className="min-w-0 space-y-0.5">
            <div className="font-medium">
              {testResult.ok ? "Połączenie działa" : "Błąd połączenia"}
              {testResult.model && <span className="ml-2 font-mono text-xs font-normal opacity-80">{testResult.model}</span>}
              {testResult.ok && <span className="ml-2 text-xs font-normal opacity-80">{testResult.latencyMs} ms</span>}
            </div>
            <div className="break-words text-xs opacity-90">{testResult.ok ? testResult.reply : testResult.error}</div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
