import { useEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTechnikMe } from "./lib/me";
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

/**
 * Tytuł górnego paska — WYŁĄCZNIE dla podstron bez własnej zakładki.
 *
 * Ekrany zakładek (Dziś / Nadchodzące / Więcej) nagłówka nie dostają: nazwa
 * stoi już podświetlona w dolnym tab barze, a powtórzona u góry zjadała
 * 48 px ekranu, żeby powiedzieć to samo drugi raz.
 */
const ROUTE_TITLES: [RegExp, string][] = [[/^\/technik\/co-nowego/, "Co nowego"]];

/**
 * Cel strzałki „wstecz” — konkretna ścieżka, a nie `history.back()`: do
 * zlecenia wchodzi się i z „Dziś”, i z „Nadchodzących”, a po zakończeniu
 * cofnięcie historii wracałoby w miejsce, którego technik już nie pamięta.
 */
const ROUTE_BACK: [RegExp, string][] = [[/^\/technik\/co-nowego/, "/technik/wiecej"]];

/**
 * POWŁOKA PANELU.
 *
 * Treść `max-w-3xl` + dolny tab bar 56 px. Szerokość jest ograniczona celowo:
 * na tablecie w poziomie (1180 px) rozciągnięta karta zlecenia rozjeżdżała
 * godzinę i przycisk na pół metra pustego miejsca, a to jest lista czytana
 * z góry na dół, nie tabela.
 *
 * GÓRNEGO PASKA NIE MA TAM, GDZIE NIE NIESIE TREŚCI. Zostaje wyłącznie na
 * podstronach bez własnej zakładki (dziś: „Co nowego”) — tam jest jedyną drogą
 * powrotną. Ekrany zakładek go nie mają, bo dublował tab bar; ekrany szczegółu
 * (zlecenie, protokół) niosą WŁASNY sticky nagłówek z typem, godziną i statusem.
 *
 * Bez górnego paska treść dotyka krawędzi ekranu, a w trybie standalone PWA
 * stoi tam pasek stanu iPada / notch — stąd `pt-safe-3` (odstęp + bezpieczny
 * obszar w jednej deklaracji, patrz technik.css). Ekrany z własnym nagłówkiem
 * mają `pt-safe` w nim samym i drugi raz go nie potrzebują.
 *
 * Protokół idzie dodatkowo bez tab bara: to formularz wypełniany u klienta
 * i każdy piksel nad klawiaturą jest tam wart więcej niż skrót do „Dziś”.
 */
export function TechnikShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { me, reload } = useTechnikMe();

  // Wysokość klawiatury → `--kb` (sticky paski akcji, FAB, toasty).
  useKeyboardVar();

  // Liczniki na tab barze: WSZYSTKIE zlecenia na dziś i wszystkie nadchodzące
  // (14 dni, z dzisiejszymi — tyle samo, ile pokazuje ekran „Nadchodzące”).
  // Odświeżane przy każdej zmianie trasy, bo po „Zakończ” technik wraca
  // na listę i liczby mają się zgadzać z tym, co widzi.
  useEffect(() => {
    reload();
    // `reload` jest stabilne między renderami — zależność to sama trasa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const navItems = useMemo<NavItem[]>(
    () =>
      NAV_ITEMS.map((item) => {
        if (item.to === "/technik")
          return { ...item, badge: me?.counts.today ?? 0, badgeAlert: (me?.counts.changedToday ?? 0) > 0 };
        if (item.to === "/technik/nadchodzace")
          return {
            ...item,
            badge: me?.counts.upcoming ?? 0,
            badgeAlert: (me?.counts.changedUpcoming ?? 0) > 0,
          };
        return item;
      }),
    [me?.counts.today, me?.counts.upcoming, me?.counts.changedToday, me?.counts.changedUpcoming],
  );

  const ownHeader = /^\/technik\/zlecenie\//.test(pathname);
  const nav = !/\/protokol\/?$/.test(pathname);

  const title = ROUTE_TITLES.find(([re]) => re.test(pathname))?.[1];
  const back = ROUTE_BACK.find(([re]) => re.test(pathname))?.[1];
  const topBar = !ownHeader && title != null;

  return (
    <div className="min-h-dvh bg-background">
      {topBar && <TopBar title={title} back={back} />}

      <main
        className={cn(
          "mx-auto w-full max-w-3xl px-4",
          // Nagłówek (własny albo `TopBar`) niesie już `pt-safe`.
          ownHeader ? "pt-0" : topBar ? "pt-3" : "pt-safe-3",
          // Miejsce na tab bar (56 px) + bezpieczny obszar.
          nav ? "pb-[calc(3.5rem+1.5rem+env(safe-area-inset-bottom,0px))]" : "pb-6",
        )}
      >
        {children}
      </main>

      {nav && <BottomNav items={navItems} />}
    </div>
  );
}
