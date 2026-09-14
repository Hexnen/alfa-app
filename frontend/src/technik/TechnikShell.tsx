import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { CalendarDays, MoreHorizontal, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKeyboardVar } from "./lib/keyboard";
import type { NavItem } from "./lib/nav";
import { BottomNav } from "./ui/bottom-nav";
import { TopBar } from "./ui/top-bar";

/**
 * TRZY POZYCJE NAWIGACJI. Panel technika ma świadomie mniej zakładek niż CRM:
 * „co robię teraz”, „co mnie czeka” i szuflada z resztą. Każda pozycja z ikoną
 * I etykietą — sama ikona nie niesie znaczenia.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/technik", label: "Dziś", icon: Sun, end: true },
  { to: "/technik/nadchodzace", label: "Nadchodzące", icon: CalendarDays },
  // „Co nowego” wchodzi się z „Więcej” i nie ma własnej zakładki — bez tego
  // dopasowania tab bar nie podświetlałby niczego.
  {
    to: "/technik/wiecej",
    label: "Więcej",
    icon: MoreHorizontal,
    match: /^\/technik\/(wiecej|co-nowego)(\/|$)/,
  },
];

/** Tytuł górnego paska dla tras, które nie ustawiają własnego. */
const ROUTE_TITLES: [RegExp, string][] = [
  [/^\/technik\/?$/, "Dziś"],
  [/^\/technik\/nadchodzace/, "Nadchodzące"],
  [/^\/technik\/co-nowego/, "Co nowego"],
  [/^\/technik\/wiecej/, "Więcej"],
];

/**
 * Cel strzałki „wstecz” — konkretna ścieżka, a nie `history.back()`: do
 * zlecenia wchodzi się i z „Dziś”, i z „Nadchodzących”, a po zakończeniu
 * cofnięcie historii wracałoby w miejsce, którego technik już nie pamięta.
 */
const ROUTE_BACK: [RegExp, string][] = [[/^\/technik\/co-nowego/, "/technik/wiecej"]];

/**
 * POWŁOKA PANELU.
 *
 * Górny pasek 48 px + treść `max-w-3xl` + dolny tab bar 56 px. Szerokość jest
 * ograniczona celowo: na tablecie w poziomie (1180 px) rozciągnięta karta
 * zlecenia rozjeżdżała godzinę i przycisk na pół metra pustego miejsca, a to
 * jest lista czytana z góry na dół, nie tabela.
 *
 * Ekrany szczegółu niosą WŁASNY sticky nagłówek (typ, godzina, status) i
 * własny pasek akcji, więc powłoka nie dubluje im chromu. Protokół idzie
 * dodatkowo bez tab bara: to formularz wypełniany u klienta i każdy piksel
 * nad klawiaturą jest tam wart więcej niż skrót do „Dziś”.
 */
export function TechnikShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  // Wysokość klawiatury → `--kb` (sticky paski akcji, FAB, toasty).
  useKeyboardVar();

  const bare = /^\/technik\/zlecenie\//.test(pathname);
  const nav = !/\/protokol\/?$/.test(pathname);

  const title = ROUTE_TITLES.find(([re]) => re.test(pathname))?.[1] ?? "Panel technika";
  const back = ROUTE_BACK.find(([re]) => re.test(pathname))?.[1];

  return (
    <div className="min-h-dvh bg-background">
      {!bare && <TopBar title={title} back={back} />}

      <main
        className={cn(
          "mx-auto w-full max-w-3xl px-4",
          bare ? "pt-0" : "pt-3",
          // Miejsce na tab bar (56 px) + bezpieczny obszar.
          nav ? "pb-[calc(3.5rem+1.5rem+env(safe-area-inset-bottom,0px))]" : "pb-6",
        )}
      >
        {children}
      </main>

      {nav && <BottomNav items={NAV_ITEMS} />}
    </div>
  );
}
