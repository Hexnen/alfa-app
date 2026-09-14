import { useEffect } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { RefreshCw, ShieldOff } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { useTechnikAccess } from "./lib/access";
import { TechnikMeProvider } from "./lib/me";
import { useTechnikPwaHead, useTechnikServiceWorker } from "./lib/pwa";
import { TechnikAuthScreen } from "./TechnikAuthScreen";
import { TechnikShell } from "./TechnikShell";
import { ToastProvider, useToast } from "./ui/toast";
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

  // Manifest i meta tagi PWA wchodzą do `<head>` TYLKO na czas życia panelu —
  // biurowy CRM (ta sama SPA, ten sam build) nie ma być instalowalny.
  useTechnikPwaHead();

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
      <TechnikUpdateWatcher />
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

/**
 * Rejestruje service workera panelu i pilnuje wydań.
 *
 * Nowy worker nie wchodzi sam z siebie — technik w połowie protokołu nie ma
 * prawa dostać przeładowania ekranu. Zamiast tego podnosimy toast, który
 * zostaje na ekranie (`duration: 0`), dopóki ktoś go nie odrzuci albo nie
 * kliknie „Odśwież".
 *
 * Komponent musi siedzieć WEWNĄTRZ `ToastProvider` — stąd osobny byt zamiast
 * hooka wołanego w `TechnikApp`.
 */
function TechnikUpdateWatcher() {
  const { updateReady, applyUpdate } = useTechnikServiceWorker();
  const { toast } = useToast();

  useEffect(() => {
    if (!updateReady) return;
    toast({
      message: "Dostępna nowa wersja panelu",
      kind: "info",
      duration: 0,
      action: { label: "Odśwież", icon: RefreshCw, onClick: applyUpdate },
    });
  }, [updateReady, applyUpdate, toast]);

  return null;
}

export default TechnikApp;
