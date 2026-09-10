import { useMemo, useState } from "react";
import { Paintbrush, Search, Settings2, Sparkles, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import {
  MODULE_LABELS,
  UPDATES,
  type UpdateModule,
  type UpdateType,
  type VersionUpdate,
} from "@/lib/updates";

/** Ikona, etykieta i kolor dla każdego rodzaju wpisu. */
const TYPE_CONFIG: Record<
  UpdateType,
  { icon: typeof Sparkles; label: string; color: string }
> = {
  feat: { icon: Sparkles, label: "Nowość", color: "text-emerald-600" },
  fix: { icon: Wrench, label: "Poprawka", color: "text-amber-600" },
  tweak: { icon: Settings2, label: "Usprawnienie", color: "text-blue-600" },
  style: { icon: Paintbrush, label: "Wygląd", color: "text-primary" },
};

const TYPE_ORDER: UpdateType[] = ["feat", "fix", "tweak", "style"];

/** Kolejność chipów filtra modułów — jak w menu bocznym. */
const MODULE_ORDER: UpdateModule[] = [
  "ogolne",
  "analityka",
  "kadry",
  "cma",
  "handlowy",
  "techniczny",
  "ofi",
];

const dateFmt = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** „2026-09-10” → „10 września 2026”. Nieznany format zostawiamy bez zmian. */
function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dateFmt.format(d);
}

/**
 * Karta odpowiada bieżącej wersji, gdy jest nią dokładnie albo gdy kończy nią
 * zakres wydań z jednego dnia (np. „1.2.0–1.2.3”).
 */
function isCurrent(update: VersionUpdate): boolean {
  if (!update.version) return false;
  return (
    update.version === APP_VERSION || update.version.endsWith(`–${APP_VERSION}`)
  );
}

/**
 * „Co nowego” — historia zmian aplikacji pisana dla użytkowników, nie dla
 * programistów. Strona jest dostępna dla każdego zalogowanego (nie ma własnego
 * klucza uprawnień), a dane bierze z `lib/updates.ts`, który utrzymuje skill
 * `/commit` przy każdym wydaniu. Filtry działają na poziomie pojedynczych
 * wpisów — karta bez pasujących punktów w ogóle znika z listy.
 */
export function CoNowego() {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<UpdateType | "all">("all");
  const [module, setModule] = useState<UpdateModule | "all">("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return UPDATES.map((update) => ({
      ...update,
      entries: update.entries.filter(
        (e) =>
          (type === "all" || e.type === type) &&
          (module === "all" || e.module === module) &&
          (!q ||
            e.text.toLowerCase().includes(q) ||
            MODULE_LABELS[e.module].toLowerCase().includes(q) ||
            (update.title || "").toLowerCase().includes(q) ||
            (update.version || "").toLowerCase().includes(q))
      ),
    })).filter((update) => update.entries.length > 0);
  }, [query, type, module]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Co nowego</h1>
        <p className="text-sm text-muted-foreground">
          Historia zmian w aplikacji — od najnowszych. Aktualna wersja:{" "}
          <span className="font-medium text-foreground">v{APP_VERSION}</span>
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Szukaj w zmianach…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-10"
              data-testid="co-nowego-filter-q"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant={type === "all" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setType("all")}
              data-testid="co-nowego-filter-typ-all"
            >
              Wszystko
            </Button>
            {TYPE_ORDER.map((t) => {
              const cfg = TYPE_CONFIG[t];
              const Icon = cfg.icon;
              return (
                <Button
                  key={t}
                  variant={type === t ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setType(t)}
                  data-testid={`co-nowego-filter-typ-${t}`}
                >
                  <Icon className={cn("mr-1.5 h-4 w-4", cfg.color)} />
                  {cfg.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">Moduł:</span>
          <Button
            variant={module === "all" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setModule("all")}
            data-testid="co-nowego-filter-modul-all"
          >
            Wszystkie
          </Button>
          {MODULE_ORDER.map((m) => (
            <Button
              key={m}
              variant={module === m ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setModule(m)}
              data-testid={`co-nowego-filter-modul-${m}`}
            >
              {MODULE_LABELS[m]}
            </Button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nic nie pasuje do wybranych filtrów.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((update, idx) => {
            const current = isCurrent(update);
            return (
              <Card
                key={`${update.version ?? update.date}-${idx}`}
                className={cn(current && "ring-1 ring-primary/40")}
                data-testid="co-nowego-card"
              >
                <CardHeader className="gap-1 p-4 pb-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">
                      {update.version ? `v${update.version}` : formatDate(update.date)}
                    </h2>
                    {update.title && (
                      <span className="text-sm text-muted-foreground">
                        — {update.title}
                      </span>
                    )}
                    {current && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Aktualna
                      </span>
                    )}
                  </div>
                  {update.version && (
                    <p className="text-xs text-muted-foreground">
                      {formatDate(update.date)}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <ul className="space-y-1.5">
                    {update.entries.map((entry, i) => {
                      const cfg = TYPE_CONFIG[entry.type];
                      const Icon = cfg.icon;
                      return (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <Icon
                            className={cn("mt-0.5 h-4 w-4 shrink-0", cfg.color)}
                            aria-label={cfg.label}
                          />
                          <span
                            className="mt-px shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem] leading-4 text-muted-foreground"
                            title={`Moduł: ${MODULE_LABELS[entry.module]}`}
                          >
                            {MODULE_LABELS[entry.module]}
                          </span>
                          <span>{entry.text}</span>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
