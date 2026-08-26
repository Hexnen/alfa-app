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
import { ObjectDetails } from "./pages/ObjectDetails";
import { Contracts } from "./pages/Contracts";
import { ContractDetails } from "./pages/ContractDetails";
import { Orders } from "./pages/Orders";
import { Technical } from "./pages/Technical";
import { Kadry } from "./pages/Kadry";
import { Monitoring } from "./pages/Monitoring";
import { Templates } from "./pages/Templates";
import { Warehouse } from "./pages/Warehouse";
import { Calendar } from "./pages/Calendar";
import { OrderDetails } from "./pages/OrderDetails";
import { CmaReports } from "./pages/CmaReports";
import { CmaReportDetails } from "./pages/CmaReportDetails";
import { CmaTrends } from "./pages/CmaTrends";
import { CmaCameraOutages } from "./pages/CmaCameraOutages";
import { CmaSettings } from "./pages/CmaSettings";
import { Ofi } from "./pages/Ofi";
import { AdminUsers } from "./pages/AdminUsers";
import { PublicOrderForm } from "./pages/PublicOrderForm";
import { useAuth } from "./auth/AuthProvider";
import { usePerms, tabKeyForPath } from "./auth/permissions";
import AuthScreen from "./auth/AuthScreen";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public, unauthenticated intake form (external Alfa branding) */}
        <Route path="/formularz/zlecenie" element={<PublicOrderForm />} />
        {/* Everything else goes through the authenticated app shell */}
        <Route path="/*" element={<AuthedApp />} />
      </Routes>
    </BrowserRouter>
  );
}

function AuthedApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center text-muted-foreground text-sm">
        Ładowanie…
      </div>
    );
  }
  if (!user) return <AuthScreen />;

  return (
    <Layout>
      <AccessGuard />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/contractors" element={<Contractors />} />
        <Route path="/objects" element={<Objects />} />
        <Route path="/objects/:id" element={<ObjectDetails />} />
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
          <Route path="/ofi" element={<Ofi />} />
          <Route path="/cma" element={<Navigate to="/cma/raporty" replace />} />
          <Route path="/cma/raporty" element={<CmaReports />} />
          <Route path="/cma/raporty/:id" element={<CmaReportDetails />} />
          <Route path="/cma/trendy" element={<CmaTrends />} />
          <Route path="/cma/braki-kamer" element={<CmaCameraOutages />} />
          <Route path="/cma/ustawienia" element={<CmaSettings />} />
          <Route path="/admin/users" element={<AdminUsers />} />
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
