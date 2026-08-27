/**
 * Firma — lekki odczyt dla zalogowanych (/api/company/*).
 *
 * Pełne ustawienia firmy (stawki, automat, źródła km) siedzą w /api/admin/company/settings
 * za `requireAdmin`. Mapa realizacji potrzebuje z nich wyłącznie znacznika biura, więc
 * wystawiamy go osobno: adres + współrzędne, bez żadnych danych kosztowych.
 */
import { Hono } from "hono";
import { getCompanyConfig, officeAddressLine } from "../lib/company-config.js";

const app = new Hono();

/** Znacznik biura na mapie: { address, city, lat, lng } (lat/lng null = nieustalone). */
app.get("/office", (c) => {
  const { values } = getCompanyConfig();
  return c.json({
    success: true,
    data: {
      address: officeAddressLine(values),
      city: values.officeCity,
      lat: values.officeLat,
      lng: values.officeLng,
    },
  });
});

export default app;
