import { Package, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Chip powiązania manuala — ikona wg rodzaju + nazwa. Używany w liście manuali,
 * w panelu podglądu i w pickerze powiązań, więc mieszka w osobnym pliku
 * (import z `ManualDialog` ciągnąłby cały formularz tam, gdzie go nie potrzeba).
 */
export function ManualLinkChip({ kind, name, meta }: { kind: "item" | "service"; name: string; meta?: string | null }) {
  const Icon = kind === "item" ? Package : Wrench;
  return (
    <span
      className={cn(
        "inline-flex max-w-[14rem] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
        kind === "item" ? "bg-sky-500/10" : "bg-emerald-500/10"
      )}
      title={[name, meta].filter(Boolean).join(" · ")}
      data-testid={`manual-link-${kind}`}
    >
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}
