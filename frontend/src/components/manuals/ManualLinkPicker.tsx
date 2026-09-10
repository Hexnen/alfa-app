import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Package, Plus, Search, Wrench, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { manualsApi } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Wybrane powiązanie w formularzu — kształt niezależny od id wiersza w bazie. */
export interface SelectedLink {
  kind: "item" | "service";
  /** Id towaru (`warehouse_items`) albo usługi (`services`). */
  refId: number;
  name: string;
  meta: string | null;
}

interface Suggestion {
  refId: number;
  name: string;
  meta: string | null;
}

interface ManualLinkPickerProps {
  kind: "item" | "service";
  /** Wybrane pozycje TEGO rodzaju — chipy pod wyszukiwarką. */
  selected: SelectedLink[];
  onAdd: (link: SelectedLink) => void;
  onRemove: (refId: number) => void;
  /** Tryb podglądu: same chipy, bez wyszukiwarki i krzyżyków. */
  readOnly?: boolean;
}

const META = {
  item: {
    label: "Sprzęt z magazynu",
    placeholder: "Szukaj towaru (nazwa, SKU, producent)…",
    empty: "Brak towarów dla tej frazy",
    icon: Package,
    testid: "items",
  },
  service: {
    label: "Usługi",
    placeholder: "Szukaj usługi (nazwa, kategoria)…",
    empty: "Brak usług dla tej frazy",
    icon: Wrench,
    testid: "services",
  },
} as const;

/**
 * Wyszukiwarka towarów/usług do powiązania z manualem. Pyta lekkie endpointy
 * `/manuals/pick/*` (osobne od magazynu, żeby użytkownik z samym uprawnieniem
 * do manuali też widział podpowiedzi). Debounce 300 ms — po każdej literze nie
 * ma sensu bić w bazę.
 */
export function ManualLinkPicker({ kind, selected, onAdd, onRemove, readOnly }: ManualLinkPickerProps) {
  const meta = META[kind];
  const Icon = meta.icon;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const search = useCallback(
    async (q: string, signal: { cancelled: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        let rows: Suggestion[];
        if (kind === "item") {
          const res = await manualsApi.pickItems(q);
          if (signal.cancelled) return;
          rows = (res.data ?? []).map((it) => ({
            refId: it.id,
            name: it.name,
            meta: [it.sku, it.manufacturer, it.category].filter(Boolean).join(" · ") || null,
          }));
        } else {
          const res = await manualsApi.pickServices(q);
          if (signal.cancelled) return;
          rows = (res.data ?? []).map((sv) => ({
            refId: sv.id,
            name: sv.name,
            meta: [sv.category, sv.unit].filter(Boolean).join(" · ") || null,
          }));
        }
        setResults(rows);
      } catch (e) {
        if (signal.cancelled) return;
        setResults([]);
        setError(e instanceof Error ? e.message : "Nie udało się pobrać podpowiedzi");
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    },
    [kind]
  );

  // Debounce: szukamy dopiero, gdy pole jest otwarte (użytkownik faktycznie wybiera).
  useEffect(() => {
    if (readOnly || !open) return;
    const signal = { cancelled: false };
    const t = window.setTimeout(() => void search(query, signal), query ? 300 : 0);
    return () => {
      signal.cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, open, readOnly, search]);

  // Klik poza komponentem zamyka listę podpowiedzi.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const chosen = new Set(selected.map((s) => s.refId));

  const add = (s: Suggestion) => {
    if (chosen.has(s.refId)) return;
    onAdd({ kind, refId: s.refId, name: s.name, meta: s.meta });
    setQuery("");
  };

  return (
    <div className="space-y-1.5" data-testid={`manuals-picker-${meta.testid}`}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {meta.label}
      </p>

      {!readOnly && (
        <div className="relative" ref={boxRef}>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            placeholder={meta.placeholder}
            className="h-8 pl-8 text-sm"
            data-testid={`manuals-picker-${meta.testid}-input`}
          />
          {loading && (
            <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
          {open && (
            <div
              className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
              data-testid={`manuals-picker-${meta.testid}-results`}
            >
              {error ? (
                <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>
              ) : results.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {loading ? "Szukam…" : meta.empty}
                </p>
              ) : (
                <ul>
                  {results.map((s) => {
                    const already = chosen.has(s.refId);
                    return (
                      <li key={s.refId}>
                        <button
                          type="button"
                          disabled={already}
                          onClick={() => add(s)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                            already && "cursor-default opacity-50 hover:bg-transparent"
                          )}
                          data-testid={`manuals-picker-${meta.testid}-option`}
                        >
                          {already ? (
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          ) : (
                            <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{s.name}</span>
                            {s.meta && <span className="block truncate text-muted-foreground">{s.meta}</span>}
                          </span>
                          {already && <span className="shrink-0 text-muted-foreground">wybrane</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {selected.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {readOnly ? "Brak powiązań." : "Nic nie wybrano."}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" data-testid={`manuals-picker-${meta.testid}-selected`}>
          {selected.map((s) => (
            <li
              key={s.refId}
              className="flex max-w-full items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pl-2 pr-1 text-xs"
              title={s.meta ?? undefined}
            >
              <Icon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{s.name}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onRemove(s.refId)}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Usuń powiązanie ${s.name}`}
                  title="Usuń powiązanie"
                  data-testid="manuals-picker-remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
