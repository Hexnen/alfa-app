import { Hono } from "hono";
import type { ApiResponse } from "../types/index.js";
import { getUserId } from "../middleware/auth.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  lookupCompanyByNip,
  isMfError,
  type CompanyLookupResult,
} from "../lib/mf-whitelist.js";

/**
 * Wyszukiwarka firm po NIP (wykaz podatników VAT MF).
 *
 * Trasa celowo NIE jest w API_TAB_MAP: z podpowiadania danych firmy korzystają
 * formularze z różnych modułów (kontrahenci, technicy, zlecenia), a sam lookup
 * nie ujawnia żadnych danych z naszej bazy — to publiczny rejestr. Wystarczy
 * więc zalogowana sesja.
 */
const app = new Hono();

// Limit per zalogowany użytkownik (MF ogranicza ruch po IP; nie chcemy go
// wyczerpać). Hojny — to narzędzie pracy: przy 100 sprawdzeniach na godzinę
// nikt normalnie pracujący go nie zobaczy.
const perUser = createRateLimiter({ limit: 100, windowMs: 60 * 60_000 });

// GET /company-lookup/nip/:nip — dane firmy z wykazu MF (?refresh=1 pomija cache)
app.get("/nip/:nip", async (c) => {
  const raw = c.req.param("nip");
  const nip = normalizeNIP(raw);

  if (!validateNIP(nip)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy NIP (błędna suma kontrolna)" },
      400
    );
  }

  if (!perUser.check(String(getUserId(c)))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo zapytań do wykazu MF — spróbuj za chwilę" },
      429
    );
  }

  const result = await lookupCompanyByNip(nip, {
    skipCache: c.req.query("refresh") === "1",
  });

  // Awaria sieci/rejestru to nie błąd naszej aplikacji — 502, żeby front mógł
  // pokazać „nie udało się pobrać”, a użytkownik i tak wpisał dane ręcznie.
  if (isMfError(result)) {
    return c.json<ApiResponse<null>>({ success: false, error: result.error }, 502);
  }

  return c.json<ApiResponse<CompanyLookupResult & { source: string }>>({
    success: true,
    data: { ...result, source: "mf-wl" },
  });
});

export default app;
