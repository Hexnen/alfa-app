import { Bug, Palette, Settings2, Sparkles, type LucideIcon } from "lucide-react";
import { UPDATES_TECHNIK, type UpdateType } from "@/lib/updates";
import { cn } from "@/lib/utils";
import { formatDatePl } from "../lib/dates";

/**
 * CO NOWEGO W PANELU — własna historia zmian, oddzielona od changelogu CRM-a.
 *
 * Bez filtrów po module i typie, które ma strona biurowa: tu jest jeden moduł
 * i kilkanaście wpisów rocznie, a filtr byłby kolejnym elementem do ominięcia
 * kciukiem. Zostaje prosta lista kart: wersja, data, punkty.
 */
const TYPE_META: Record<UpdateType, { icon: LucideIcon; label: string; className: string }> = {
  feat: { icon: Sparkles, label: "Nowość", className: "text-emerald-600" },
  fix: { icon: Bug, label: "Poprawka", className: "text-amber-600" },
  tweak: { icon: Settings2, label: "Usprawnienie", className: "text-sky-600" },
  style: { icon: Palette, label: "Wygląd", className: "text-violet-600" },
};

export function CoNowegoTechnik() {
  return (
    <div className="space-y-4">
      {UPDATES_TECHNIK.map((card) => (
        <article key={`${card.version ?? ""}-${card.date}`} className="rounded-xl border bg-card p-4">
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {card.version && (
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-sm font-semibold tabular-nums text-primary">
                v{card.version}
              </span>
            )}
            <h2 className="text-base font-semibold">{card.title ?? "Zmiany"}</h2>
            <time className="ml-auto text-xs text-muted-foreground">{formatDatePl(card.date)}</time>
          </header>

          <ul className="mt-3 space-y-2.5">
            {card.entries.map((entry, i) => {
              const meta = TYPE_META[entry.type];
              const Icon = meta.icon;
              return (
                <li key={i} className="flex gap-2.5 text-sm leading-snug">
                  <Icon
                    className={cn("mt-0.5 h-4 w-4 shrink-0", meta.className)}
                    aria-label={meta.label}
                  />
                  <span className="min-w-0">{entry.text}</span>
                </li>
              );
            })}
          </ul>
        </article>
      ))}
    </div>
  );
}
