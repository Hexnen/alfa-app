// Wyszukiwarka pracownika do formularzy Kadr (umowa, godziny, biuro).
//
// Natywny `<select>` z 155 nazwiskami wymagał przewijania listy albo
// zgadywania pierwszej litery — a nazwiska zaczynają się gęsto na tę samą.
// Tutaj: pole tekstowe filtruje listę po fragmencie (nazwisko, imię, kod),
// ↑/↓ chodzą po wynikach, Enter wybiera, Esc zamyka. Bez nowych zależności —
// to kilkadziesiąt linii stanu, a nie biblioteka komboboksów.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, X } from "lucide-react";
import type { HrEmployee } from "@/lib/api";

/**
 * Ile pozycji rysujemy naraz. Kartoteka ma ~150 osób, a lista przerysowuje się
 * przy każdym wciśnięciu klawisza — ale ucięcie MUSI być widoczne, inaczej
 * „nie ma takiej osoby" znaczy naprawdę „jest, tylko 61. w kolejności".
 */
const VISIBLE_LIMIT = 60;

export function EmployeePicker({
  id,
  employees,
  value,
  onChange,
  disabled,
  placeholder = "Szukaj nazwiska…",
  required,
}: {
  id?: string;
  employees: HrEmployee[];
  /** Id jako string (formularze trzymają je tak samo jak natywny select). */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
}) {
  const selected = employees.find((e) => String(e.id) === value) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Stabilne id listy i opcji — potrzebne do `aria-controls`
  // i `aria-activedescendant` (czytnik ekranu musi wiedzieć, KTÓRA pozycja
  // jest podświetlona, skoro focus zostaje w polu tekstowym).
  const listId = useId();
  const optionId = (idx: number) => `${listId}-opt-${idx}`;

  const { matches, hiddenCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? employees.filter((e) =>
          `${e.fullName} ${e.code ?? ""}`.toLowerCase().includes(q),
        )
      : employees;
    return {
      matches: list.slice(0, VISIBLE_LIMIT),
      hiddenCount: Math.max(0, list.length - VISIBLE_LIMIT),
    };
  }, [employees, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Podświetlony wynik ma zostawać w polu widzenia przy chodzeniu strzałkami.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  /**
   * WALIDACJA „pole wymagane" bez ukrytego `<input required>`.
   *
   * Poprzednio pod spodem siedział input `required` z `aria-hidden`, zerowym
   * rozmiarem i `tabIndex={-1}` — Chrome nie potrafi ustawić na nim focusa, więc
   * zgłaszał w konsoli „An invalid form control … is not focusable" i po prostu
   * NIE WYSYŁAŁ formularza, bez żadnego komunikatu dla użytkownika. Tutaj
   * niepoprawność zgłasza samo (widoczne, focusowalne) pole przez
   * `setCustomValidity`, więc przeglądarka pokazuje dymek dokładnie nad nim.
   *
   * Sprawdzamy `value` (id wybranej osoby), a nie tekst w polu: wpisana szukajka
   * bez wybrania nikogo to dalej brak wyboru.
   */
  useEffect(() => {
    inputRef.current?.setCustomValidity(
      required && !value ? "Wybierz pracownika z listy" : "",
    );
  }, [required, value]);

  const pick = (emp: HrEmployee) => {
    onChange(String(emp.id));
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((i) => {
        const next = i + (e.key === "ArrowDown" ? 1 : -1);
        if (next < 0) return matches.length - 1;
        if (next >= matches.length) return 0;
        return next;
      });
    } else if (e.key === "Enter") {
      if (!open) {
        // Enter w zamkniętym polu otwiera listę zamiast wysyłać formularz —
        // to pole wyboru, nie pole tekstowe.
        e.preventDefault();
        setActive(0);
        setOpen(true);
        return;
      }
      // Enter w otwartej liście WYBIERA — nie wysyła formularza (inaczej
      // pierwsze naciśnięcie zapisywałoby wpis bez pracownika).
      e.preventDefault();
      const emp = matches[active];
      if (emp) pick(emp);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <Input
          id={id}
          ref={inputRef}
          // Gdy ktoś jest wybrany, pole pokazuje nazwisko; wpisywanie zamienia
          // je w szukajkę (jak w polu adresu przeglądarki).
          value={open ? query : (selected?.fullName ?? "")}
          placeholder={selected ? selected.fullName : placeholder}
          disabled={disabled}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-required={required || undefined}
          // Focus zostaje w polu, więc podświetloną pozycję trzeba wskazać
          // czytnikowi ekranu jawnie.
          aria-activedescendant={
            open && matches[active] ? optionId(active) : undefined
          }
          data-testid="kadry-employee-picker"
          // Lista NIE rozwija się na sam focus: Radix ustawia focus na pierwszym
          // polu dialogu, więc otwarcie „Edytuj wpis godzin” witało użytkownika
          // rozwiniętą listą 150 nazwisk zamiast wpisem, który chciał poprawić.
          // Otwiera ją klik, pisanie, strzałka w dół albo Enter.
          onClick={() => {
            setActive(0);
            setOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            // Nowe zapytanie zaczyna podświetlenie od pierwszego wyniku —
            // inaczej Enter wybierałby osobę z poprzedniej listy.
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="pr-16"
        />
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
          {selected && !disabled && (
            <button
              type="button"
              aria-label="Wyczyść wybór"
              {...tip("Wyczyść wybór")}
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              onClick={() => {
                onChange("");
                setQuery("");
              }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <ChevronDown className="mr-1 h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Pracownicy"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-background py-1 shadow-md"
        >
          {matches.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
              Brak pracownika dla „{query}"
            </li>
          ) : (
            matches.map((e, idx) => (
              <li
                key={e.id}
                id={optionId(idx)}
                role="option"
                aria-selected={String(e.id) === value}
                data-idx={idx}
                onMouseEnter={() => setActive(idx)}
                // Wybór na `mousedown`, a nie `click`: `click` przychodzi po
                // blurze pola, a lista zamyka się już na `mousedown` (patrz
                // efekt wyżej), więc kliknięcie potrafiło nie trafić w nic.
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(e);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm",
                  idx === active && "bg-accent",
                )}
              >
                <Check
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    String(e.id) === value ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{e.fullName}</span>
                {e.code && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {e.code}
                  </span>
                )}
              </li>
            ))
          )}
          {/* Ucięcie listy widoczne, a nie domyślne: bez tej stopki 61. osoba
              w kolejności po prostu „nie istniała". */}
          {hiddenCount > 0 && (
            <li
              role="presentation"
              className="border-t px-3 py-1.5 text-xs text-muted-foreground"
            >
              …i {hiddenCount} więcej — zawęź wpisując
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
