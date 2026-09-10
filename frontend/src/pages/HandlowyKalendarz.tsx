import { CalendarPage } from "@/components/calendar/CalendarPage";
import { SALES_CALENDAR } from "@/lib/calendar-config";

/**
 * Kalendarz działu handlowego — ten sam silnik co techniczny, inna
 * konfiguracja: typy handlowe, przypisani handlowcy, filtr szansy i
 * przełącznik „Moje / Wszyscy”, bez trasy, pogody i rozliczeń.
 */
export function HandlowyKalendarz() {
  return <CalendarPage config={SALES_CALENDAR} />;
}
