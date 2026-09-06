import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Building2, Loader2, Search } from "lucide-react";
import { getContractors, type Contractor } from "@/lib/api";
import { formatNIP } from "@/lib/nip";

interface ContractorPickerProps {
  /** Tekst w polu — zwykle nazwa firmy zapisana w rekordzie nadrzędnym. */
  value: string;
  /** Każda zmiana tekstu (wpisanie ręczne również). */
  onChange: (value: string) => void;
  /** Wybór kontrahenta z listy — formularz decyduje, które pola uzupełnić. */
  onSelect: (contractor: Contractor) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  /** Klasa pola — pozwala wpiąć wyszukiwarkę w gęsty formularz (niższy input). */
  inputClassName?: string;
}

/**
 * Wyszukiwarka kontrahentów już zapisanych w bazie (nazwa / NIP / miasto).
 * Pole zostaje zwykłym inputem — kontrahenta można wpisać ręcznie, a podpowiedzi
 * tylko skracają drogę do istniejącego rekordu.
 */
export function ContractorPicker({
  value,
  onChange,
  onSelect,
  label = "Kontrahent",
  placeholder = "Nazwa, NIP lub miasto…",
  required = false,
  disabled = false,
  id = "contractor-picker",
  inputClassName,
}: ContractorPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Contractor[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const boxRef = useRef<HTMLDivElement>(null);

  // Zamknięcie listy kliknięciem poza komponentem.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Szukamy dopiero od 2 znaków i z opóźnieniem — inaczej każdy znak to zapytanie.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await getContractors({ search: term, pageSize: 8 });
        if (!cancelled) {
          setResults(res.data || []);
          setHighlight(0);
        }
      } catch (err) {
        if (!cancelled) {
          setResults([]);
          // Najczęstszy przypadek: brak uprawnień do modułu kontrahentów.
          setError(
            err instanceof Error ? err.message : "Nie udało się wyszukać kontrahentów"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  const showList = open && (loading || results.length > 0 || !!error || query.trim().length >= 2);

  const hint = useMemo(() => {
    if (loading) return "Szukam…";
    if (error) return error;
    if (query.trim().length >= 2 && results.length === 0) {
      return "Brak kontrahentów — wpisz dane ręcznie";
    }
    return null;
  }, [loading, error, query, results.length]);

  const choose = (contractor: Contractor) => {
    onSelect(contractor);
    onChange(contractor.name);
    setQuery(contractor.name);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showList || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      // Enter wybiera podpowiedź zamiast wysyłać formularz.
      e.preventDefault();
      choose(results[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={label ? "space-y-2" : ""} ref={boxRef}>
      {label && (
        <Label htmlFor={id}>
          {label} {required && <span className="text-red-500">*</span>}
        </Label>
      )}
      <div className="relative">
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => {
            onChange(e.target.value);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setQuery(value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={inputClassName ? `pr-9 ${inputClassName}` : "pr-9"}
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
        </div>

        {showList && (
          <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
            {results.length > 0 ? (
              <ul className="max-h-64 overflow-y-auto py-1">
                {results.map((contractor, i) => (
                  <li key={contractor.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => choose(contractor)}
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${
                        i === highlight ? "bg-accent" : ""
                      }`}
                    >
                      <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{contractor.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          NIP {formatNIP(contractor.nip)}
                          {contractor.city ? ` • ${contractor.city}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              hint && <p className="px-3 py-2 text-sm text-muted-foreground">{hint}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
