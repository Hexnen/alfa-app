import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Building2,
  FileText,
  ClipboardList,
  Cctv,
  Camera,
  MapPinned,
  Wrench,
  IdCard,
  Menu,
  X,
  LogOut,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { useAuth } from "@/auth/AuthProvider";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Kontrahenci", href: "/contractors", icon: Users },
  { name: "Obiekty", href: "/objects", icon: Building2 },
  { name: "Umowy", href: "/contracts", icon: FileText },
  { name: "Zlecenia", href: "/orders", icon: ClipboardList },
  { name: "Techniczny", href: "/technical", icon: Wrench },
  { name: "Kadry", href: "/kadry", icon: IdCard },
  { name: "Monitoring", href: "/monitoring", icon: MapPinned },
  { name: "CMA", href: "/cma", icon: Cctv },
  { name: "Szablony", href: "/templates", icon: Camera },
];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();

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
          {navigation.map((item) => {
            const isActive = location.pathname === item.href ||
              (item.href !== "/" && location.pathname.startsWith(item.href));
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
