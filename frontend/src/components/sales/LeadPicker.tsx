/**
 * Wyszukiwarka szans sprzedaży — combobox z podpowiedziami z `GET /leads`.
 *
 * Szans bywa więcej niż da się trzymać w pamięci ekranu, więc lista NIE jest
 * słownikiem ładowanym z góry (jak obiekty w kalendarzu): każde wpisanie frazy
 * pyta backend, z debouncem i limitem 10 pozycji. Domyślnie szukamy tylko wśród
 * OTWARTYCH szans (`includeClosed: false`) — planując następny krok nikt nie
 * celuje w rzecz wygraną albo przegraną pół roku temu.
 *
 * Komponent jest świadomie „głupi”: nie zna kalendarza ani karty szansy, oddaje
 * wybraną szansę w całości (`onPick`), a co z niej wziąć — decyduje rodzic.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Handshake, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { leadsApi, type Lead, type LeadStage } from "@/lib/api";
import { LEAD_STAGE_META, stagePillClass } from "@/lib/sales-labels";
import { cn } from "@/lib/utils";
import { tip } from "@/components/ui/tooltip";

/** Tyle o szansie wystarczy, żeby pokazać wybór — pełny `Lead` bywa niedostępny. */
export interface LeadRef {
  id: number;
  title: string;
  stage?: LeadStage | null;
  clientLabel?: string | null;
}

export function LeadPicker({
  value,
  onPick,
  onClear,
  inputId,
  disabled,
  includeClosed = false,
  placeholder = "Szukaj szansy…",
}: {
  value: LeadRef | null;
  onPick: (lead: Lead) => void;
  onClear: () => void;
  inputId: string;
  disabled?: boolean;
  /** `true` = szukaj też wśród wygranych i przegranych (domyślnie tylko otwarte). */
  includeClosed?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [openList, setOpenList] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounce: szukajka pyta backend, a nie filtruje gotowej listy.
  useEffect(() => {
    if (!openList) return;
    let cancelled = false;
    // `setLoading` dopiero w callbacku timera: ustawienie stanu w ciele efektu
    // wymusza kaskadę renderów (i wywala lintera), a „Szukam…” i tak ma sens
    // dopiero, gdy zapytanie naprawdę wychodzi.
    const t = window.setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      leadsApi
        .list({ q: q.trim() || undefined, includeClosed, pageSize: 10, sort: "lastActivityAt", dir: "desc" })
        .then((res) => {
          if (!cancelled) setResults(res.data?.items ?? []);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, openList, includeClosed]);

  useEffect(() => {
    if (!openList) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openList]);

  const stagePill = useMemo(
    () => (stage: LeadStage | null | undefined) =>
      stage ? (
        <span className={stagePillClass(stage)}>{LEAD_STAGE_META[stage]?.label ?? stage}</span>
      ) : null,
    []
  );

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm" data-testid="lead-picker-selected">
        <Handshake className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{value.title}</div>
          {value.clientLabel && <div className="truncate text-xs text-muted-foreground">{value.clientLabel}</div>}
        </div>
        {stagePill(value.stage)}
        {!disabled && (
          <button
            type="button"
            aria-label="Usuń powiązanie z szansą"
            {...tip("Odepnij szansę — aktywność zostanie bez powiązania")}
            onClick={() => {
              onClear();
              setQ("");
            }}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={openList}
        aria-controls={`${inputId}-list`}
        aria-autocomplete="list"
        disabled={disabled}
        value={q}
        placeholder={placeholder}
        className="pl-8"
        data-testid="lead-picker-input"
        onFocus={() => setOpenList(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpenList(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && openList && results[active]) {
            e.preventDefault();
            onPick(results[active]);
            setOpenList(false);
          } else if (e.key === "Escape" && openList) {
            // Esc zamyka listę, a nie cały dialog — stąd stopPropagation.
            e.stopPropagation();
            setOpenList(false);
          }
        }}
      />
      {openList && (
        <ul
          id={`${inputId}-list`}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {loading && results.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">Szukam…</li>
          ) : results.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">Brak wyników.</li>
          ) : (
            results.map((l, i) => (
              <li
                key={l.id}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(l);
                  setOpenList(false);
                }}
                className={cn(
                  "cursor-pointer rounded px-2 py-1.5",
                  i === active && "bg-accent text-accent-foreground"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{l.title}</span>
                  {stagePill(l.stage)}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {[l.clientLabel, l.salespersonName].filter(Boolean).join(" · ") || "—"}
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export default LeadPicker;
