import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ShieldOff } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { useTechnikAccess } from "./lib/access";
import { TechnikMeProvider } from "./lib/me";
import { TechnikAuthScreen } from "./TechnikAuthScreen";
import { TechnikShell } from "./TechnikShell";
import { ToastProvider } from "./ui/toast";
import { Dzis } from "./pages/Dzis";
import { Nadchodzace } from "./pages/Nadchodzace";
import { Wiecej } from "./pages/Wiecej";
import { Zlecenie } from "./pages/Zlecenie";
import { Protokol } from "./pages/Protokol";
import { CoNowegoTechnik } from "./pages/CoNowegoTechnik";
import "./technik.css";

/**
 * PANEL TECHNIKA — osobna aplikacja pod `/technik`, poza `AuthedApp`.
 *
 * Świadomie NIE korzysta z `Layout` CRM-a: to ma być ekran na tablet przy
 * kliencie, a nie sidebar z dwudziestoma zakładkami. Wspólne zostaje tylko
 * konto (`AuthProvider` opakowuje całe `App`) i klocki `components/ui`.
 *
 * Wszystko renderuje się wewnątrz `.technik-root`, bo `technik.css`
 * (16-pikselowe inputy, `touch-action`, bezpieczne obszary) jest zakresowany
 * pod tę klasę — inaczej te reguły rozjechałyby biurowe ekrany CRM-a.
 */
export function TechnikApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        Ładowanie…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="technik-root">
        <TechnikAuthScreen />
      </div>
    );
  }

  // `/technik/me` wymaga zalogowania, więc provider wchodzi dopiero za bramką
  // konta — inaczej strzelałby 401 na ekranie logowania.
  return (
    <div className="technik-root">
      <TechnikMeProvider>
        <TechnikRoutes />
      </TechnikMeProvider>
    </div>
  );
}

function TechnikRoutes() {
  const access = useTechnikAccess();

  if (!access.canView) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 pt-[12dvh] text-center">
        <ShieldOff className="mx-auto h-10 w-10 text-muted-foreground/60" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold">Brak dostępu do panelu technika</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          To konto nie ma włączonego panelu. Poproś administratora o dostęp.
        </p>
        <Button asChild size="lg" className="mt-5 h-11 w-full">
          <Link to="/">Wróć do CRM</Link>
        </Button>
      </div>
    );
  }

  return (
    <ToastProvider>
      <TechnikShell>
        <Routes>
          <Route path="/" element={<Dzis />} />
          <Route path="nadchodzace" element={<Nadchodzace />} />
          <Route path="wiecej" element={<Wiecej />} />
          <Route path="co-nowego" element={<CoNowegoTechnik />} />
          <Route path="zlecenie/:id" element={<Zlecenie />} />
          <Route path="zlecenie/:id/protokol" element={<Protokol />} />
          {/* Literówka w adresie nie ma wyrzucać technika z panelu. */}
          <Route path="*" element={<Navigate to="/technik" replace />} />
        </Routes>
      </TechnikShell>
    </ToastProvider>
  );
}

export default TechnikApp;
