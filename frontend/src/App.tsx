import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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
import { OrderDetails } from "./pages/OrderDetails";
import { CmaReports } from "./pages/CmaReports";
import { CmaReportDetails } from "./pages/CmaReportDetails";
import { CmaTrends } from "./pages/CmaTrends";
import { CmaCameraOutages } from "./pages/CmaCameraOutages";
import { CmaSettings } from "./pages/CmaSettings";
import { Ofi } from "./pages/Ofi";
import { useAuth } from "./auth/AuthProvider";
import AuthScreen from "./auth/AuthScreen";

function App() {
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
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contractors" element={<Contractors />} />
          <Route path="/objects" element={<Objects />} />
          <Route path="/objects/:id" element={<ObjectDetails />} />
          <Route path="/contracts" element={<Contracts />} />
          <Route path="/contracts/:id" element={<ContractDetails />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderDetails />} />
          <Route
            path="/technical"
            element={<Navigate to="/technical/realizacje" replace />}
          />
          <Route path="/technical/projekty" element={<Monitoring />} />
          <Route path="/technical/szablony" element={<Templates />} />
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
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
