import { CalendarPage } from "@/components/calendar/CalendarPage";
import { TECHNICAL_CALENDAR } from "@/lib/calendar-config";

/**
 * Kalendarz działu technicznego. Cała logika siedzi w `CalendarPage` — tutaj
 * zostaje wyłącznie wybór konfiguracji (patrz `@/lib/calendar-config`).
 */
export function Calendar() {
  return <CalendarPage config={TECHNICAL_CALENDAR} />;
}
