import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Building2,
  FileText,
  ClipboardList,
  Cctv,
  Wrench,
  IdCard,
  FolderKanban,
  CalendarCog,
  ChevronDown,
  Menu,
  X,
  LogOut,
  Shield,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { useAuth } from "@/auth/AuthProvider";
import { usePerms, TABS } from "@/auth/permissions";

type NavChild = {
  name: string;
  href: string;
  // Optional custom active matcher (needed when sibling paths overlap, e.g.
  // "/orders" is a prefix of "/orders/formularz").
  isActive?: (pathname: string) => boolean;
  /** Opcjonalna ikona podzakładki (np. w grupie Administracja). */
  icon?: LucideIcon;
};
type NavItem = {
  name: string;
  href: string;
  icon: LucideIcon;
  children?: NavChild[];
};

// Standalone entries shown at the top of the sidebar.
const topLevel: NavItem[] = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Kontrahenci", href: "/contractors", icon: Users },
  { name: "Obiekty", href: "/objects", icon: Building2 },
  { name: "Umowy", href: "/contracts", icon: FileText },
  {
    name: "Zlecenia",
    href: "/orders",
    icon: ClipboardList,
    children: [
      {
        name: "Lista zleceń",
        href: "/orders",
        // Active on the list and on any order detail, but not on the form.
        isActive: (p) =>
          p === "/orders" ||
          (p.startsWith("/orders/") && !p.startsWith("/orders/formularz")),
      },
      {
        name: "Formularz",
        href: "/orders/formularz",
        isActive: (p) => p.startsWith("/orders/formularz"),
      },
    ],
  },
];

// Main sections. Their sub-tabs live directly in the sidebar (not on the
// sub-page) — each child navigates to its own URL.
const sections: NavItem[] = [
  {
    name: "Kadry",
    href: "/kadry",
    icon: IdCard,
    children: [
      { name: "Wynagrodzenia", href: "/kadry/wynagrodzenia" },
      { name: "Godziny", href: "/kadry/godziny" },
      { name: "Biuro", href: "/kadry/biuro" },
      { name: "Umowy", href: "/kadry/umowy" },
      { name: "Pracownicy", href: "/kadry/pracownicy" },
      { name: "Obiekty", href: "/kadry/obiekty" },
      { name: "Normy", href: "/kadry/normy" },
    ],
  },
  {
    name: "CMA",
    href: "/cma",
    icon: Cctv,
    children: [
      { name: "Raporty", href: "/cma/raporty" },
      { name: "Trendy", href: "/cma/trendy" },
      { name: "Braki kamer", href: "/cma/braki-kamer" },
      { name: "Ustawienia", href: "/cma/ustawienia" },
    ],
  },
  {
    name: "Techniczny",
    href: "/technical",
    icon: Wrench,
    children: [
      { name: "Kalendarz", href: "/technical/kalendarz" },
      { name: "Realizacje", href: "/technical/realizacje" },
      { name: "Protokoły", href: "/technical/protokoly" },
      { name: "Wyceny", href: "/technical/wyceny" },
      { name: "Cennik", href: "/technical/cennik" },
      { name: "Technicy", href: "/technical/technicy" },
      { name: "Obiekty", href: "/technical/obiekty" },
      { name: "Magazyn", href: "/technical/magazyn" },
      { name: "Projekty", href: "/technical/projekty" },
      { name: "Szablony", href: "/technical/szablony" },
    ],
  },
  { name: "OFI", href: "/ofi", icon: FolderKanban },
];

interface LayoutProps {
  children: React.ReactNode;
}

/** Klucz trwałości zwinięcia sidebara (desktop). */
const COLLAPSE_KEY = "alfa.sidebar.collapsed";

const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
};

const isDesktopWidth = () =>
  typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;

/** Czy fokus jest w polu edycyjnym (nie przechwytujemy skrótu „[”). */
const isTypingTarget = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const { user, logout } = useAuth();
  const perms = usePerms();

  // --- Zwijanie sidebara (tylko desktop; mobile ma swój drawer) -------------
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [desktop, setDesktop] = useState(isDesktopWidth);
  /** Flyout z podzakładkami sekcji w trybie zwiniętym (pozycja = ikona sekcji). */
  const [flyout, setFlyout] = useState<{ item: NavItem; top: number } | null>(null);
  /** Pasek ikon: zwinięty sidebar renderujemy tylko na desktopie. */
  const rail = collapsed && desktop;

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const toggleCollapsed = () => {
    setFlyout(null);
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* prywatny tryb przeglądarki — trudno */
      }
      return next;
    });
  };

  // Skrót „[” — zwiń/rozwiń menu (poza polami tekstowymi i skrótami z modyfikatorem).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || !isDesktopWidth()) return;
      e.preventDefault();
      setFlyout(null);
      setCollapsed((c) => {
        const next = !c;
        try {
          localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
        } catch {
          /* ignore */
        }
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Flyout: zamknij klikiem obok / Esc.
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-sidebar-flyout]") || t?.closest?.("[data-sidebar-rail-group]")) return;
      setFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFlyout(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [flyout]);

  // Mapuje ścieżkę SPA na klucz zakładki z katalogu uprawnień. Ścieżki
  // szczegółowe bez własnego klucza (np. /orders/formularz) dziedziczą
  // uprawnienie z nadrzędnej zakładki (/orders → "orders").
  const tabKeySet = useMemo(() => new Set(TABS.map((t) => t.key)), []);
  const keyFor = (href: string): string | null => {
    let key = href.replace(/^\//, "");
    while (key) {
      if (tabKeySet.has(key)) return key;
      const i = key.lastIndexOf("/");
      if (i < 0) break;
      key = key.slice(0, i);
    }
    return null;
  };
  // Dashboard ("/") oraz ścieżki nieobjęte katalogiem są zawsze widoczne.
  const canSee = (href: string): boolean => {
    if (href === "/") return true;
    const key = keyFor(href);
    return key ? perms.canView(key) : true;
  };

  // Nawigacja przefiltrowana wg uprawnień: sekcja/pozycja znika, gdy nie ma
  // żadnej widocznej podzakładki (lub sama nie jest dostępna).
  const filterNav = (items: NavItem[]): NavItem[] =>
    items
      .map((item) => {
        if (!item.children) return canSee(item.href) ? item : null;
        const children = item.children.filter((ch) => canSee(ch.href));
        if (children.length === 0) return null;
        return { ...item, children };
      })
      .filter((x): x is NavItem => x !== null);

  const visibleTopLevel = useMemo(
    () => filterNav(topLevel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [perms.user],
  );
  const visibleSections = useMemo(
    () => filterNav(sections),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [perms.user],
  );

  const isChildActive = (child: NavChild) =>
    child.isActive
      ? child.isActive(location.pathname)
      : location.pathname === child.href ||
        location.pathname.startsWith(child.href + "/");

  // Grupa jest aktywna także wtedy, gdy aktywna jest dowolna podzakładka
  // (np. Administracja ma href /admin/users, a /admin/asystent to rodzeństwo).
  const isSectionActive = (item: NavItem) =>
    location.pathname === item.href ||
    location.pathname.startsWith(item.href + "/") ||
    (item.children?.some(isChildActive) ?? false);

  // A section is expanded when the user toggled it, otherwise it auto-opens
  // whenever the current route lives inside it.
  const isGroupOpen = (item: NavItem) =>
    openGroups[item.name] ?? isSectionActive(item);

  const toggleGroup = (item: NavItem) =>
    setOpenGroups((prev) => ({
      ...prev,
      [item.name]: !isGroupOpen(item),
    }));

  // Tryb zwinięty: sama ikona + `title` jako tooltip. Sekcje z podzakładkami
  // otwierają flyout obok paska (pozycjonowany jak menu kontekstowe).
  const renderRailItem = (item: NavItem) => {
    const active = isSectionActive(item);
    const cls = cn(
      "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    );
    if (!item.children) {
      return (
        <Link key={item.name} to={item.href} className={cls} title={item.name} aria-label={item.name}>
          <item.icon className="h-5 w-5" />
        </Link>
      );
    }
    const open = flyout?.item.name === item.name;
    return (
      <button
        key={item.name}
        type="button"
        data-sidebar-rail-group
        className={cls}
        title={item.name}
        aria-label={item.name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setFlyout(open ? null : { item, top: r.top });
        }}
      >
        <item.icon className="h-5 w-5" />
      </button>
    );
  };

  // Unified renderer used for both the top-level entries and the main
  // sections, so any entry can carry expandable sub-tabs in the sidebar.
  const renderNavItem = (item: NavItem) => {
    if (rail) return renderRailItem(item);
    const active = isSectionActive(item);

    // Entry without sub-tabs behaves like a plain link.
    if (!item.children) {
      return (
        <Link
          key={item.name}
          to={item.href}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
          onClick={() => setSidebarOpen(false)}
        >
          <item.icon className="h-5 w-5" />
          {item.name}
        </Link>
      );
    }

    const open = isGroupOpen(item);
    return (
      <div key={item.name}>
        <div
          className={cn(
            "flex items-center rounded-lg text-sm font-medium transition-colors",
            active
              ? "text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <Link
            to={item.href}
            className="flex flex-1 items-center gap-3 rounded-lg px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setOpenGroups((prev) => ({ ...prev, [item.name]: true }));
              setSidebarOpen(false);
            }}
          >
            <item.icon className="h-5 w-5" />
            {item.name}
          </Link>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => toggleGroup(item)}
            aria-expanded={open}
            aria-label={open ? `Zwiń ${item.name}` : `Rozwiń ${item.name}`}
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                open ? "rotate-0" : "-rotate-90"
              )}
            />
          </button>
        </div>

        {open && (
          <div className="mt-1 flex flex-col gap-1 pl-4">
            {item.children.map((child) => {
              const childActive = isChildActive(child);
              return (
                <Link
                  key={child.href}
                  to={child.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border-l px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    childActive
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                  onClick={() => setSidebarOpen(false)}
                >
                  {child.icon && <child.icon className="h-4 w-4" />}
                  {child.name}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 transform flex-col bg-card border-r transition-[transform,width] duration-200 ease-in-out lg:translate-x-0",
          collapsed && "lg:w-16",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div
          className={cn(
            "flex h-16 items-center border-b",
            rail ? "justify-center px-2" : "justify-between px-6"
          )}
        >
          {!rail && (
            <Link to="/" className="text-xl font-bold text-primary">
              Alfa Group
            </Link>
          )}
          <div className="flex items-center gap-1">
            {/* Zwijanie — tylko desktop; mobile zamyka drawer krzyżykiem */}
            <Button
              variant="ghost"
              size="icon"
              className="hidden lg:inline-flex"
              onClick={toggleCollapsed}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Rozwiń menu boczne" : "Zwiń menu boczne"}
              title={collapsed ? "Rozwiń menu ([)" : "Zwiń menu ([)"}
            >
              {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="Zamknij menu"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
        <nav
          className={cn(
            "flex flex-1 flex-col gap-1 overflow-y-auto",
            rail ? "items-center px-2 py-4" : "p-4"
          )}
        >
          {visibleTopLevel.map(renderNavItem)}

          {visibleSections.length > 0 && <div className="my-2 w-full border-t" />}

          {visibleSections.map(renderNavItem)}

          {perms.isAdmin && (
            <>
              <div className="my-2 w-full border-t" />
              {renderNavItem({
                name: "Administracja",
                href: "/admin/users",
                icon: Shield,
                children: [
                  { name: "Użytkownicy", href: "/admin/users", icon: Users },
                  { name: "Kalendarz", href: "/admin/kalendarz", icon: CalendarCog },
                  { name: "Firma", href: "/admin/firma", icon: Building2 },
                  { name: "Asystent AI", href: "/admin/asystent", icon: Sparkles },
                ],
              })}
            </>
          )}
        </nav>

        {/* Bottom bar: system name + user + logout (moved from the top bar) */}
        {rail ? (
          <div className="flex flex-col items-center border-t p-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => logout()}
              aria-label="Wyloguj"
              title={`Wyloguj${user ? ` — ${user.displayName || user.email}` : ""}`}
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        ) : (
          <div className="border-t p-4">
            <div className="text-sm font-semibold leading-snug">
              System Wdrozen Obiektow Ochrony
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground min-w-0 truncate">
                {user ? user.displayName || user.email : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => logout()}
                title="Wyloguj"
              >
                <LogOut className="h-4 w-4 mr-1" />
                Wyloguj
              </Button>
            </div>
          </div>
        )}
      </aside>

      {/* Flyout z podzakładkami sekcji (tylko przy zwiniętym sidebarze) */}
      {rail && flyout && (
        <div
          data-sidebar-flyout
          role="menu"
          aria-label={flyout.item.name}
          className="fixed left-16 z-50 ml-1 w-56 rounded-lg border bg-popover p-2 text-popover-foreground shadow-xl"
          style={{ top: Math.max(8, Math.min(flyout.top, window.innerHeight - 24 - 44 * ((flyout.item.children?.length ?? 0) + 1))) }}
        >
          <Link
            to={flyout.item.href}
            onClick={() => setFlyout(null)}
            className="mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <flyout.item.icon className="h-4 w-4" />
            {flyout.item.name}
          </Link>
          <div className="flex flex-col gap-0.5">
            {flyout.item.children?.map((child) => (
              <Link
                key={child.href}
                to={child.href}
                role="menuitem"
                onClick={() => setFlyout(null)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isChildActive(child)
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {child.icon && <child.icon className="h-4 w-4" />}
                {child.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Main content */}
      <div
        className={cn(
          "transition-[padding] duration-200 ease-in-out",
          collapsed ? "lg:pl-16" : "lg:pl-64"
        )}
      >
        {/* Top bar — only the hamburger on mobile; the system/user bar lives
            at the bottom of the sidebar now */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background px-4 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">
            System Wdrozen Obiektow Ochrony
          </h1>
        </header>

        {/* Page content */}
        <main className="p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
