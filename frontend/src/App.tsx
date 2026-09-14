import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Contractors } from "./pages/Contractors";
import { Objects } from "./pages/Objects";
import { Salespeople } from "./pages/Salespeople";
import { Spolki } from "./pages/Spolki";
import { ObjectDetails } from "./pages/ObjectDetails";
import { Contracts } from "./pages/Contracts";
import { ContractDetails } from "./pages/ContractDetails";
import { Orders } from "./pages/Orders";
import { Technical } from "./pages/Technical";
import { Kadry } from "./pages/Kadry";
import { Analityka, AnalitykaRedirect } from "./pages/Analityka";
import { Monitoring } from "./pages/Monitoring";
import { Templates } from "./pages/Templates";
import { Warehouse } from "./pages/Warehouse";
import { Manuals } from "./pages/Manuals";
import { CoNowego } from "./pages/CoNowego";
import { Uslugi } from "./pages/Uslugi";
import { Oferty } from "./pages/Oferty";
import { Calendar } from "./pages/Calendar";
import { OrderDetails } from "./pages/OrderDetails";
import { CmaReports } from "./pages/CmaReports";
import { CmaReportDetails } from "./pages/CmaReportDetails";
import { CmaTrends } from "./pages/CmaTrends";
import { CmaCameraOutages } from "./pages/CmaCameraOutages";
import { CmaObjects } from "./pages/CmaObjects";
import { CmaInterventionGroups } from "./pages/CmaInterventionGroups";
import { CmaSettings } from "./pages/CmaSettings";
import { Ofi } from "./pages/Ofi";
import { HandlowyPulpit } from "./pages/HandlowyPulpit";
import { HandlowyLeady } from "./pages/HandlowyLeady";
import { HandlowyLeadDetails } from "./pages/HandlowyLeadDetails";
import { HandlowyKalendarz } from "./pages/HandlowyKalendarz";
import { HandlowyAktywnosci } from "./pages/HandlowyAktywnosci";
import { HandlowyKontakty } from "./pages/HandlowyKontakty";
import { AdminUsers } from "./pages/AdminUsers";
import { AdminAssistant } from "./pages/AdminAssistant";
import { AdminCalendar } from "./pages/AdminCalendar";
import { AdminCompany } from "./pages/AdminCompany";
import { AdminMail } from "./pages/AdminMail";
import { AdminTechnik } from "./pages/AdminTechnik";
import { PublicOrderForm } from "./pages/PublicOrderForm";
import { PublicOffer } from "./pages/PublicOffer";
import { PluginImportBridge } from "./components/PluginImportBridge";
import { TechnikApp } from "./technik/TechnikApp";
import { useAuth } from "./auth/AuthProvider";
import { usePerms, tabKeyForPath } from "./auth/permissions";
import AuthScreen from "./auth/AuthScreen";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public, unauthenticated intake form (external Alfa branding) */}
        <Route path="/formularz/zlecenie" element={<PublicOrderForm />} />
        {/* Public, unauthenticated client-facing offer (link + print/PDF) */}
        <Route path="/oferta/:token" element={<PublicOffer />} />
        {/* Panel technika — osobna aplikacja na tablet, poza `AuthedApp` i poza
            `Layout`. Ma własny ekran logowania i własną powłokę; `AuthProvider`
            opakowuje całe `App`, więc konto jest to samo co w CRM. */}
        <Route path="/technik/*" element={<TechnikApp />} />
        {/* Everything else goes through the authenticated app shell */}
        <Route path="/*" element={<AuthedApp />} />
      </Routes>
    </BrowserRouter>
  );
}

function AuthedApp() {
  const { user, loading, offline, retry } = useAuth();

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center text-muted-foreground text-sm">
        Ładowanie…
      </div>
    );
  }
  // `/api/auth/me` nie doszło (padł backend, zerwana sieć) — nie wiemy, kim
  // jest użytkownik, więc ekran logowania byłby fałszywą informacją „sesja
  // wygasła”. 401 dalej kończy się `user === null` i normalnym logowaniem.
  if (offline && !user) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted-foreground">
          Brak połączenia z serwerem — nie wiadomo, czy sesja jest jeszcze ważna. Spróbuj ponownie
          za chwilę.
        </p>
        <button
          type="button"
          onClick={retry}
          className="h-10 rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent"
        >
          Spróbuj ponownie
        </button>
      </div>
    );
  }
  if (!user) return <AuthScreen />;
  // Rola `technik` widzi wyłącznie panel technika — także wtedy, gdy ktoś
  // wpisze adres CRM-a z ręki albo wróci na zapamiętaną zakładkę.
  if (user.role === "technik") return <Navigate to="/technik" replace />;

  return (
    <Layout>
      <AccessGuard />
      {/* Nasłuch sygnału z wtyczki przeglądarki — musi być w zalogowanej części
          i WEWNĄTRZ routera (używa `useNavigate`), a nie w `App`, gdzie
          obejmowałby też publiczne trasy bez sesji. */}
      <PluginImportBridge />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        {/* Historia zmian — dostępna dla każdego zalogowanego, bez uprawnień. */}
        <Route path="/co-nowego" element={<CoNowego />} />
        <Route path="/contractors" element={<Contractors />} />
        <Route path="/objects" element={<Objects />} />
        <Route path="/objects/:id" element={<ObjectDetails />} />
        <Route path="/handlowcy" element={<Salespeople />} />
        <Route path="/spolki" element={<Spolki />} />
        <Route path="/contracts" element={<Contracts />} />
        <Route path="/contracts/:id" element={<ContractDetails />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/formularz" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetails />} />
          <Route
            path="/technical"
            element={<Navigate to="/technical/realizacje" replace />}
          />
          <Route path="/technical/projekty" element={<Monitoring />} />
          <Route path="/technical/szablony" element={<Templates />} />
          <Route path="/technical/kalendarz" element={<Calendar />} />
          <Route path="/technical/magazyn" element={<Warehouse />} />
          <Route path="/technical/manuale" element={<Manuals />} />
          <Route path="/technical/uslugi" element={<Uslugi />} />
          <Route path="/technical/oferty" element={<Oferty />} />
          {/* Oferta ma własny adres z numeru: /technical/oferty/of202608014 */}
          <Route path="/technical/oferty/:slug" element={<Oferty />} />
          <Route path="/technical/:tab" element={<Technical />} />
          {/* Legacy paths → new locations under Techniczny */}
          <Route
            path="/monitoring"
            element={<Navigate to="/technical/projekty" replace />}
          />
          <Route
            path="/templates"
            element={<Navigate to="/technical/szablony" replace />}
          />
          <Route
            path="/kadry"
            element={<Navigate to="/kadry/wynagrodzenia" replace />}
          />
          <Route path="/kadry/:tab" element={<Kadry />} />
          {/* Analityka: goły adres trafia na pierwszą podzakładkę, którą
              użytkownik naprawdę widzi (patrz AnalitykaRedirect). */}
          <Route path="/analityka" element={<AnalitykaRedirect />} />
          <Route path="/analityka/:tab" element={<Analityka />} />
          <Route path="/ofi" element={<Ofi />} />
          {/* Handlowy: strona na zakładkę (wzorzec CMA), bez wspólnego routera. */}
          <Route path="/handlowy" element={<Navigate to="/handlowy/pulpit" replace />} />
          <Route path="/handlowy/pulpit" element={<HandlowyPulpit />} />
          <Route path="/handlowy/leady" element={<HandlowyLeady />} />
          <Route path="/handlowy/leady/:id" element={<HandlowyLeadDetails />} />
          <Route path="/handlowy/kalendarz" element={<HandlowyKalendarz />} />
          <Route path="/handlowy/aktywnosci" element={<HandlowyAktywnosci />} />
          <Route path="/handlowy/kontakty" element={<HandlowyKontakty />} />
          <Route path="/cma" element={<Navigate to="/cma/raporty" replace />} />
          <Route path="/cma/raporty" element={<CmaReports />} />
          <Route path="/cma/raporty/:id" element={<CmaReportDetails />} />
          <Route path="/cma/trendy" element={<CmaTrends />} />
          <Route path="/cma/braki-kamer" element={<CmaCameraOutages />} />
          <Route path="/cma/obiekty" element={<CmaObjects />} />
          <Route path="/cma/grupy-interwencyjne" element={<CmaInterventionGroups />} />
          <Route path="/cma/ustawienia" element={<CmaSettings />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/asystent" element={<AdminAssistant />} />
          <Route path="/admin/kalendarz" element={<AdminCalendar />} />
          <Route path="/admin/firma" element={<AdminCompany />} />
          <Route path="/admin/poczta" element={<AdminMail />} />
          <Route path="/admin/technik" element={<AdminTechnik />} />
        </Routes>
      </Layout>
  );
}

// Przekierowuje na Dashboard, gdy bieżąca ścieżka wymaga uprawnień, których
// użytkownik nie ma (dostęp przez wpisany URL). Sekcja /admin tylko dla admina.
function AccessGuard() {
  const loc = useLocation();
  const perms = usePerms();
  const path = loc.pathname;
  if (path.startsWith("/admin")) {
    return perms.isAdmin ? null : <Navigate to="/" replace />;
  }
  const key = tabKeyForPath(path);
  if (key && !perms.canView(key)) return <Navigate to="/" replace />;
  return null;
}

export default App;
