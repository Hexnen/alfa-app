import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Contractors } from "./pages/Contractors";
import { Objects } from "./pages/Objects";
import { ObjectDetails } from "./pages/ObjectDetails";
import { Contracts } from "./pages/Contracts";
import { Orders } from "./pages/Orders";

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contractors" element={<Contractors />} />
          <Route path="/objects" element={<Objects />} />
          <Route path="/objects/:id" element={<ObjectDetails />} />
          <Route path="/contracts" element={<Contracts />} />
          <Route path="/orders" element={<Orders />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
