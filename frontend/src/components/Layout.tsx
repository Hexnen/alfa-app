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
  ChevronDown,
  Menu,
  X,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { useAuth } from "@/auth/AuthProvider";

type NavChild = { name: string; href: string };
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
  { name: "Zlecenia", href: "/orders", icon: ClipboardList },
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
      { name: "Realizacje", href: "/technical/realizacje" },
      { name: "Protokoły", href: "/technical/protokoly" },
      { name: "Wyceny", href: "/technical/wyceny" },
      { name: "Cennik", href: "/technical/cennik" },
      { name: "Technicy", href: "/technical/technicy" },
      { name: "Obiekty", href: "/technical/obiekty" },
      { name: "Projekty", href: "/technical/projekty" },
      { name: "Szablony", href: "/technical/szablony" },
    ],
  },
  { name: "OFI", href: "/ofi", icon: FolderKanban },
];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const { user, logout } = useAuth();

  const isChildActive = (href: string) =>
    location.pathname === href || location.pathname.startsWith(href + "/");

  const isSectionActive = (item: NavItem) =>
    location.pathname === item.href ||
    location.pathname.startsWith(item.href + "/");

  // A section is expanded when the user toggled it, otherwise it auto-opens
  // whenever the current route lives inside it.
  const isGroupOpen = (item: NavItem) =>
    openGroups[item.name] ?? isSectionActive(item);

  const toggleGroup = (item: NavItem) =>
    setOpenGroups((prev) => ({
      ...prev,
      [item.name]: !isGroupOpen(item),
    }));

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
          "fixed inset-y-0 left-0 z-50 flex w-64 transform flex-col bg-card border-r transition-transform duration-200 ease-in-out lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-16 items-center justify-between px-6 border-b">
          <Link to="/" className="text-xl font-bold text-primary">
            Alfa Group
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
          {topLevel.map((item) => {
            const isActive =
              location.pathname === item.href ||
              (item.href !== "/" &&
                location.pathname.startsWith(item.href + "/"));
            return (
              <Link
                key={item.name}
                to={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
                onClick={() => setSidebarOpen(false)}
              >
                <item.icon className="h-5 w-5" />
                {item.name}
              </Link>
            );
          })}

          <div className="my-2 border-t" />

          {sections.map((item) => {
            const sectionActive = isSectionActive(item);

            // Section without sub-tabs behaves like a plain link.
            if (!item.children) {
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    sectionActive
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
                    sectionActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Link
                    to={item.href}
                    className="flex flex-1 items-center gap-3 px-3 py-2"
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
                    className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-accent"
                    onClick={() => toggleGroup(item)}
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
                      const childActive = isChildActive(child.href);
                      return (
                        <Link
                          key={child.href}
                          to={child.href}
                          className={cn(
                            "flex items-center gap-3 rounded-lg border-l px-3 py-1.5 text-sm transition-colors",
                            childActive
                              ? "border-primary bg-primary/10 font-medium text-primary"
                              : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          )}
                          onClick={() => setSidebarOpen(false)}
                        >
                          {child.name}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Bottom bar: system name + user + logout (moved from the top bar) */}
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
      </aside>

      {/* Main content */}
      <div className="lg:pl-64">
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
