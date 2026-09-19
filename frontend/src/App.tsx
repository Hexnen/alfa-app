import { Suspense, lazy } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { Layout } from "./components/Layout";
import { PluginImportBridge } from "./components/PluginImportBridge";
import { useAuth } from "./auth/AuthProvider";
import { usePerms, tabKeyForPath } from "./auth/permissions";
import AuthScreen from "./auth/AuthScreen";

/*
 * PODZIAŁ BUNDLA
 *
 * Każda strona top-level wchodzi przez `React.lazy`, bo inaczej jeden build
 * sklejał całego CRM-a (kalendarz, designer monitoringu, magazyn, oferty,
 * asystent) w jeden plik ~3,3 MB — a technik na LTE ściągał go w całości, żeby
 * zobaczyć cztery zlecenia. W chunku wejściowym zostaje tylko powłoka:
 * router, `AuthProvider`, `Layout` i ekran logowania.
 *
 * Strony eksportują nazwane komponenty (nie `default`), stąd `.then(...)`
 * przepisujące eksport na `default` — tego wymaga `React.lazy`.
 */

// Panel technika — osobna aplikacja na tablet; jego chunk nie ma prawa ciągnąć
// niczego z CRM-a poza wspólnymi klockami `components/ui` i `lib/api`.
const TechnikApp = lazy(() =>
  import("./technik/TechnikApp").then((m) => ({ default: m.TechnikApp })),
);

// Publiczne, niezalogowane trasy — klient otwiera je z linku w mailu i nie ma
// powodu ściągać przy tym CRM-a.
const PublicOrderForm = lazy(() =>
  import("./pages/PublicOrderForm").then((m) => ({ default: m.PublicOrderForm })),
);
const PublicOffer = lazy(() =>
  import("./pages/PublicOffer").then((m) => ({ default: m.PublicOffer })),
);

const Dashboard = lazy(() =>
  import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const CoNowego = lazy(() =>
  import("./pages/CoNowego").then((m) => ({ default: m.CoNowego })),
);
const Contractors = lazy(() =>
  import("./pages/Contractors").then((m) => ({ default: m.Contractors })),
);
const Objects = lazy(() =>
  import("./pages/Objects").then((m) => ({ default: m.Objects })),
);
const ObjectDetails = lazy(() =>
  import("./pages/ObjectDetails").then((m) => ({ default: m.ObjectDetails })),
);
const Salespeople = lazy(() =>
  import("./pages/Salespeople").then((m) => ({ default: m.Salespeople })),
);
const Spolki = lazy(() => import("./pages/Spolki").then((m) => ({ default: m.Spolki })));
const Contracts = lazy(() =>
  import("./pages/Contracts").then((m) => ({ default: m.Contracts })),
);
const ContractDetails = lazy(() =>
  import("./pages/ContractDetails").then((m) => ({ default: m.ContractDetails })),
);
const Orders = lazy(() => import("./pages/Orders").then((m) => ({ default: m.Orders })));
const OrderDetails = lazy(() =>
  import("./pages/OrderDetails").then((m) => ({ default: m.OrderDetails })),
);
const Technical = lazy(() =>
  import("./pages/Technical").then((m) => ({ default: m.Technical })),
);
const Monitoring = lazy(() =>
  import("./pages/Monitoring").then((m) => ({ default: m.Monitoring })),
);
const Templates = lazy(() =>
  import("./pages/Templates").then((m) => ({ default: m.Templates })),
);
const Calendar = lazy(() =>
  import("./pages/Calendar").then((m) => ({ default: m.Calendar })),
);
const Warehouse = lazy(() =>
  import("./pages/Warehouse").then((m) => ({ default: m.Warehouse })),
);
const Manuals = lazy(() =>
  import("./pages/Manuals").then((m) => ({ default: m.Manuals })),
);
const Uslugi = lazy(() => import("./pages/Uslugi").then((m) => ({ default: m.Uslugi })));
const Oferty = lazy(() => import("./pages/Oferty").then((m) => ({ default: m.Oferty })));
const Kadry = lazy(() => import("./pages/Kadry").then((m) => ({ default: m.Kadry })));
const Analityka = lazy(() =>
  import("./pages/Analityka").then((m) => ({ default: m.Analityka })),
);
const AnalitykaRedirect = lazy(() =>
  import("./pages/Analityka").then((m) => ({ default: m.AnalitykaRedirect })),
);
const Ofi = lazy(() => import("./pages/Ofi").then((m) => ({ default: m.Ofi })));
// „Godziny działu” — jeden komponent na cztery sekcje (CMA, OFI, Handlowy,
// Techniczny); różni je wyłącznie propem `portal` (src/lib/hr-scope.ts).
const DeptHours = lazy(() =>
  import("./pages/DeptHours").then((m) => ({ default: m.DeptHours })),
);
const HandlowyPulpit = lazy(() =>
  import("./pages/HandlowyPulpit").then((m) => ({ default: m.HandlowyPulpit })),
);
const HandlowyLeady = lazy(() =>
  import("./pages/HandlowyLeady").then((m) => ({ default: m.HandlowyLeady })),
);
const HandlowyLeadDetails = lazy(() =>
  import("./pages/HandlowyLeadDetails").then((m) => ({
    default: m.HandlowyLeadDetails,
  })),
);
const HandlowyKalendarz = lazy(() =>
  import("./pages/HandlowyKalendarz").then((m) => ({ default: m.HandlowyKalendarz })),
);
const HandlowyAktywnosci = lazy(() =>
  import("./pages/HandlowyAktywnosci").then((m) => ({ default: m.HandlowyAktywnosci })),
);
const HandlowyKontakty = lazy(() =>
  import("./pages/HandlowyKontakty").then((m) => ({ default: m.HandlowyKontakty })),
);
const CmaReports = lazy(() =>
  import("./pages/CmaReports").then((m) => ({ default: m.CmaReports })),
);
const CmaReportDetails = lazy(() =>
  import("./pages/CmaReportDetails").then((m) => ({ default: m.CmaReportDetails })),
);
const CmaTrends = lazy(() =>
  import("./pages/CmaTrends").then((m) => ({ default: m.CmaTrends })),
);
const CmaCameraOutages = lazy(() =>
  import("./pages/CmaCameraOutages").then((m) => ({ default: m.CmaCameraOutages })),
);
const CmaObjects = lazy(() =>
  import("./pages/CmaObjects").then((m) => ({ default: m.CmaObjects })),
);
const CmaInterventionGroups = lazy(() =>
  import("./pages/CmaInterventionGroups").then((m) => ({
    default: m.CmaInterventionGroups,
  })),
);
const CmaSettings = lazy(() =>
  import("./pages/CmaSettings").then((m) => ({ default: m.CmaSettings })),
);
const AdminUsers = lazy(() =>
  import("./pages/AdminUsers").then((m) => ({ default: m.AdminUsers })),
);
const AdminAssistant = lazy(() =>
  import("./pages/AdminAssistant").then((m) => ({ default: m.AdminAssistant })),
);
const AdminCalendar = lazy(() =>
  import("./pages/AdminCalendar").then((m) => ({ default: m.AdminCalendar })),
);
const AdminCompany = lazy(() =>
  import("./pages/AdminCompany").then((m) => ({ default: m.AdminCompany })),
);
const AdminMail = lazy(() =>
  import("./pages/AdminMail").then((m) => ({ default: m.AdminMail })),
);
const AdminTechnik = lazy(() =>
  import("./pages/AdminTechnik").then((m) => ({ default: m.AdminTechnik })),
);

/** Pełnoekranowy stan ładowania — ten sam co w `AuthedApp`, gdy czekamy na sesję. */
function FullPageFallback() {
  return (
    <div className="min-h-dvh flex items-center justify-center text-muted-foreground text-sm">
      Ładowanie…
    </div>
  );
}

/**
 * Stan ładowania strony WEWNĄTRZ `Layout` — sidebar i nagłówek już stoją, więc
 * nie zabieramy całej wysokości ekranu, tylko obszar treści.
 */
function PageFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground text-sm">
      Ładowanie…
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<FullPageFallback />}>
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
      </Suspense>
    </BrowserRouter>
  );
}

function AuthedApp() {
  const { user, loading, offline, retry } = useAuth();

  if (loading) {
    return <FullPageFallback />;
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
      <Suspense fallback={<PageFallback />}>
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
          {/* MUSI stać przed „/technical/:tab": inaczej catch-all zjadłby ten
              adres i pokazał pustą zakładkę Technicznego. */}
          <Route path="/technical/godziny" element={<DeptHours portal="technical" />} />
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
          {/* Pierwsza realna podzakładka OFI — reszta sekcji to wciąż placeholder. */}
          <Route path="/ofi/godziny" element={<DeptHours portal="ofi" />} />
          {/* Handlowy: strona na zakładkę (wzorzec CMA), bez wspólnego routera. */}
          <Route path="/handlowy" element={<Navigate to="/handlowy/pulpit" replace />} />
          <Route path="/handlowy/pulpit" element={<HandlowyPulpit />} />
          <Route path="/handlowy/leady" element={<HandlowyLeady />} />
          <Route path="/handlowy/leady/:id" element={<HandlowyLeadDetails />} />
          <Route path="/handlowy/kalendarz" element={<HandlowyKalendarz />} />
          <Route path="/handlowy/aktywnosci" element={<HandlowyAktywnosci />} />
          <Route path="/handlowy/kontakty" element={<HandlowyKontakty />} />
          <Route path="/handlowy/godziny" element={<DeptHours portal="handlowy" />} />
          <Route path="/cma" element={<Navigate to="/cma/raporty" replace />} />
          <Route path="/cma/raporty" element={<CmaReports />} />
          <Route path="/cma/raporty/:id" element={<CmaReportDetails />} />
          <Route path="/cma/trendy" element={<CmaTrends />} />
          <Route path="/cma/braki-kamer" element={<CmaCameraOutages />} />
          <Route path="/cma/obiekty" element={<CmaObjects />} />
          <Route path="/cma/grupy-interwencyjne" element={<CmaInterventionGroups />} />
          <Route path="/cma/ustawienia" element={<CmaSettings />} />
          <Route path="/cma/godziny" element={<DeptHours portal="cma" />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/asystent" element={<AdminAssistant />} />
          <Route path="/admin/kalendarz" element={<AdminCalendar />} />
          <Route path="/admin/firma" element={<AdminCompany />} />
          <Route path="/admin/poczta" element={<AdminMail />} />
          <Route path="/admin/technik" element={<AdminTechnik />} />
        </Routes>
      </Suspense>
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
