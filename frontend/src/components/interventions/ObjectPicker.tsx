/**
 * Wyszukiwarka obiektów do formularzy Grup interwencyjnych. Pyta własny lekki
 * endpoint `/pick/objects` — dzięki temu użytkownik z samym kluczem
 * `cma/grupy-interwencyjne` nie potrzebuje dostępu do kartoteki obiektów.
 *
 * Ten sam picker obsługuje inne moduły z własnym endpointem wyszukiwania
 * (Drafty umów) — przez prop `fetcher`. Duplikowanie komponentu byłoby gorsze:
 * różnica jest jedną linijką, a wygląd i obsługa klawiatury mają zostać wspólne.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { interventionsApi, type InterventionPickObject } from "@/lib/api";
import { cn } from "@/lib/utils";
import { errMsg, objectMeta } from "./helpers";

/** Wyszukiwarka obiektów innego modułu — zwraca gotową listę podpowiedzi. */
export type ObjectPickerFetcher = (q: string) => Promise<InterventionPickObject[]>;

/** Domyślne źródło: endpoint Grup interwencyjnych. */
const defaultFetcher: ObjectPickerFetcher = async (q) =>
  (await interventionsApi.pickObjects(q)).data?.items ?? [];

interface ObjectPickerProps {
  /** Wybrany obiekt — chip z krzyżykiem; null = pole wyszukiwania. */
  value: InterventionPickObject | null;
  onChange: (next: InterventionPickObject | null) => void;
  /** Edycja wiersza i wejście z karty obiektu blokują zmianę obiektu. */
  disabled?: boolean;
  placeholder?: string;
  testid: string;
  className?: string;
  /**
   * Skąd brać podpowiedzi. Domyślnie `/cma/intervention-groups/pick/objects`;
   * moduł z własnym kluczem uprawnień podaje tu swój endpoint.
   *
   * MUSI mieć stabilną tożsamość (stała modułu albo `useCallback`) — funkcja
   * siedzi w zależnościach efektu z debounce, więc świeża referencja przy każdym
   * renderze kazałaby pickerowi odpytywać backend w kółko.
   */
  fetcher?: ObjectPickerFetcher;
}

/**
 * Wyszukiwarka obiektów z debounce 250 ms (wzorzec `ManualLinkPicker`).
 * Jeden wybór — po kliknięciu pozycja zamienia się w chip z krzyżykiem.
 */
export function ObjectPicker({
  value,
  onChange,
  disabled,
  placeholder = "Szukaj obiektu (nazwa, adres, miasto, kontrahent)…",
  testid,
  className,
  fetcher = defaultFetcher,
}: ObjectPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InterventionPickObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const search = useCallback(
    async (q: string, signal: { cancelled: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        const items = await fetcher(q);
        if (signal.cancelled) return;
        setResults(items);
      } catch (e) {
        if (signal.cancelled) return;
        setResults([]);
        setError(errMsg(e, "Nie udało się pobrać podpowiedzi"));
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    },
    [fetcher]
  );

  useEffect(() => {
    if (disabled || !open) return;
    const signal = { cancelled: false };
    const t = window.setTimeout(() => void search(query, signal), query ? 250 : 0);
    return () => {
      signal.cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, open, disabled, search]);

  // Klik poza komponentem zamyka listę podpowiedzi.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (value) {
    const meta = objectMeta(value);
    return (
      <div
        className={cn("flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-sm", className)}
        data-testid={`${testid}-selected`}
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{value.name}</span>
          {meta && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
            }}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Zmień obiekt"
            title="Zmień obiekt"
            data-testid={`${testid}-clear`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={cn("relative", className)} ref={boxRef}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        disabled={disabled}
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
        placeholder={placeholder}
        className="h-9 pl-8 text-sm"
        data-testid={`${testid}-input`}
      />
      {loading && (
        <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}
      {open && !disabled && (
        <div
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
          data-testid={`${testid}-results`}
        >
          {error ? (
            <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>
          ) : results.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {loading ? "Szukam…" : "Brak obiektów dla tej frazy"}
            </p>
          ) : (
            <ul>
              {results.map((o) => {
                const meta = objectMeta(o);
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(o);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                      data-testid={`${testid}-option`}
                    >
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{o.name}</span>
                        {meta && <span className="block truncate text-muted-foreground">{meta}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
