/**
 * Wybór osoby kontaktowej z GOTOWEJ listy (rodzic ją zawęża — backend przyjmuje
 * tylko kontakty należące do szansy albo do jej kontrahenta, więc wolna szukajka
 * po całej bazie kończyłaby się błędem 400 przy zapisie).
 *
 * Zwykły `<select>`, nie combobox: kontaktów przy jednej szansie są jednostki,
 * a nie tysiące — lista rozwijana jest tu szybsza i dostępna z klawiatury bez
 * dodatkowego kodu.
 */
import { Users } from "lucide-react";
import { type Contact } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ContactPicker({
  contacts,
  value,
  onChange,
  inputId,
  disabled,
  emptyLabel = "Bez osoby kontaktowej",
}: {
  contacts: Contact[];
  value: number | null;
  onChange: (id: number | null) => void;
  inputId: string;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  // Wybrany kontakt bywa nieaktywny albo spoza bieżącej listy (zapisany dawniej) —
  // dopisujemy go, żeby edycja wydarzenia nie kasowała po cichu powiązania.
  const known = contacts.some((c) => c.id === value);

  return (
    <div className="relative">
      <Users className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <select
        id={inputId}
        data-testid="contact-picker"
        disabled={disabled}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm shadow-sm",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <option value="">{emptyLabel}</option>
        {!known && value != null && <option value={String(value)}>Kontakt #{value}</option>}
        {contacts.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {[c.fullName || `${c.firstName} ${c.lastName}`.trim(), c.role].filter(Boolean).join(" — ")}
            {c.active === false ? " (nieaktywny)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

export default ContactPicker;
