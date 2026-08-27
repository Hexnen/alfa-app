import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { AdminAssistantSettings } from "@/lib/api";

const NotSet = () => <span className="font-sans text-muted-foreground">nie ustawiony</span>;

/** Informacja o precedencji DB → env → domyślne i stanie zmiennych środowiskowych. */
export function EnvInfoCard({ env }: { env: AdminAssistantSettings["env"] }) {
  return (
    <Card>
      <CardContent className="space-y-3 pt-6 text-sm">
        <p className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <span>
            <strong>Ustawienia zapisane w bazie mają pierwszeństwo</strong> przed zmiennymi środowiskowymi, a te przed wartościami domyślnymi. „Przywróć domyślne” usuwa wartości z bazy — wraca wtedy env lub domyślne.
          </span>
        </p>
        <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
          <dt className="font-mono text-muted-foreground">OPENROUTER_API_KEY</dt>
          <dd>{env.OPENROUTER_API_KEY ? "ustawiony" : "nie ustawiony"}</dd>
          <dt className="font-mono text-muted-foreground">OPENROUTER_KEY_FILE</dt>
          <dd>
            {env.OPENROUTER_KEY_FILE ? (
              <>
                <span className="font-mono">{env.OPENROUTER_KEY_FILE}</span> — {env.keyFileExists ? "plik istnieje" : "plik nie istnieje"}
              </>
            ) : (
              <>
                nie ustawiony (domyślnie <span className="font-mono">data/openrouter.key</span>, {env.keyFileExists ? "istnieje" : "brak pliku"})
              </>
            )}
          </dd>
          <dt className="font-mono text-muted-foreground">OPENROUTER_BASE_URL</dt>
          <dd className="font-mono">{env.OPENROUTER_BASE_URL ?? <NotSet />}</dd>
          <dt className="font-mono text-muted-foreground">OPENROUTER_MODEL</dt>
          <dd className="font-mono">{env.OPENROUTER_MODEL ?? <NotSet />}</dd>
          <dt className="font-mono text-muted-foreground">OPENROUTER_PROVIDER_SORT</dt>
          <dd className="font-mono">{env.OPENROUTER_PROVIDER_SORT ?? <NotSet />}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
