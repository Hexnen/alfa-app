import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { isNavActive, type NavItem } from "../lib/nav";

/**
 * DOLNY TAB BAR — jedyna nawigacja panelu, widoczna ZAWSZE (także na desktopie:
 * technik pracuje na tablecie, a biuro i tak wchodzi tu tylko z ciekawości).
 *
 * Każda pozycja z ikoną I ETYKIETĄ — sama ikona nie niesie znaczenia. 56 px
 * wysokości + `pb-safe` (pasek gestów). Aktywna pozycja ma kolor, pogrubienie
 * i `aria-current`: trzy niezależne sygnały.
 */
export function BottomNav({ items, className }: { items: NavItem[]; className?: string }) {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Nawigacja panelu technika"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-safe backdrop-blur-sm",
        className,
      )}
    >
      <ul className="flex h-14 items-stretch">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end}
                aria-current={isNavActive(item, pathname, false) ? "page" : undefined}
                className={({ isActive }) =>
                  cn(
                    "flex h-full select-none flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] leading-tight",
                    "transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    isNavActive(item, pathname, isActive)
                      ? "font-semibold text-primary"
                      : "text-muted-foreground",
                  )
                }
              >
                {({ isActive }) => {
                  const active = isNavActive(item, pathname, isActive);
                  return (
                    <>
                      <Icon
                        className="h-5 w-5 shrink-0"
                        strokeWidth={active ? 2.4 : 1.8}
                        aria-hidden
                      />
                      <span className="truncate">{item.label}</span>
                    </>
                  );
                }}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
