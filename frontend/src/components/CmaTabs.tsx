import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

// Sub-navigation for the CMA section. Add new tabs here as new
// sub-pages appear (e.g. { name: "Obiekty", href: "/cma/obiekty" }).
const tabs = [
  { name: "Raporty", href: "/cma/raporty" },
  { name: "Trendy", href: "/cma/trendy" },
  { name: "Braki kamer", href: "/cma/braki-kamer" },
  { name: "Ustawienia", href: "/cma/ustawienia" },
];

export function CmaTabs() {
  return (
    <div className="border-b">
      <nav className="-mb-px flex gap-6">
        {tabs.map((tab) => (
          <NavLink
            key={tab.href}
            to={tab.href}
            className={({ isActive }) =>
              cn(
                "border-b-2 px-1 pb-3 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
              )
            }
          >
            {tab.name}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
