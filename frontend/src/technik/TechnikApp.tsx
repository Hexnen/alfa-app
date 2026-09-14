import { useEffect, useRef } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { RefreshCw, ShieldOff, WifiOff } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { useTechnikAccess } from "./lib/access";
import { useTechnikLive } from "./lib/live";
import { TechnikMeProvider } from "./lib/me";
import { useTechnikPwaHead, useTechnikServiceWorker } from "./lib/pwa";
import { TechnikAuthScreen } from "./TechnikAuthScreen";
import { TechnikShell } from "./TechnikShell";
import { ToastProvider, useToast } from "./ui/toast";
import { Dzis } from "./pages/Dzis";
import { Nadchodzace } from "./pages/Nadchodzace";
import { Mapa } from "./pages/Mapa";
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
  const { user, loading, offline, retry } = useAuth();

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

  // Serwer się nie odezwał, więc NIE WIEMY, czy sesja jest ważna. Ekran
  // logowania byłby tu kłamstwem („zaloguj się” przy ważnej sesji) i technik
  // wpisywałby hasło, które i tak nie ma jak dojść. Zostaje jedno zdanie
  // i przycisk, który pyta jeszcze raz.
  if (offline && !user) {
    return (
      <div className="technik-root">
        <div className="mx-auto w-full max-w-sm px-4 pt-[12dvh] text-center">
          <WifiOff className="mx-auto h-10 w-10 text-muted-foreground/60" aria-hidden />
          <h1 className="mt-3 text-lg font-semibold">Brak połączenia</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Panel nie może się połączyć z serwerem. Sprawdź zasięg albo Wi-Fi — jeśli byłeś
            zalogowany, zlecenia wrócą same, gdy tylko sieć wróci.
          </p>
          <Button size="lg" className="mt-5 h-12 w-full text-base" onClick={retry}>
            <RefreshCw className="mr-2 h-5 w-5" aria-hidden />
            Spróbuj ponownie
          </Button>
        </div>
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

  // Strumień „na żywo" — jeden na cały panel, otwarty tylko dla konta, które
  // faktycznie ma panel (bez dostępu nie ma czego słuchać). Zamyka się sam przy
  // wylogowaniu, bo cały ten poddrzewek znika razem z `user`.
  useTechnikLive(access.canView);

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
          <Route path="mapa" element={<Mapa />} />
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
  /** Kiedy ostatnio pokazaliśmy pasek — żeby nie wracał przy każdym mrugnięciu. */
  const shownAt = useRef(0);

  useEffect(() => {
    if (!updateReady) return;

    const show = () => {
      // Odrzucony toast nie wraca sam z siebie, a technik potrafi siedzieć na
      // starej wersji tygodniami. Ponawiamy go po powrocie do panelu, ale nie
      // częściej niż raz na 10 minut — inaczej z przypomnienia robi się
      // natręctwo. Stały wiersz „Dostępna nowa wersja” jest w „Więcej”.
      if (Date.now() - shownAt.current < UPDATE_TOAST_COOLDOWN_MS) return;
      shownAt.current = Date.now();
      toast({
        message: "Dostępna nowa wersja panelu",
        kind: "info",
        duration: 0,
        action: { label: "Odśwież", icon: RefreshCw, onClick: applyUpdate },
      });
    };

    show();
    const onFocus = () => {
      if (document.visibilityState === "visible") show();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [updateReady, applyUpdate, toast]);

  return null;
}

/** Najkrótszy odstęp między dwoma paskami „nowa wersja”. */
const UPDATE_TOAST_COOLDOWN_MS = 10 * 60 * 1000;

export default TechnikApp;
