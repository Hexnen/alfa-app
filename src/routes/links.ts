/**
 * Podgląd linków wpisanych w wolnych tekstach (notatki wydarzeń, notatki
 * obiektu, opisy). Montowane pod `/links`, POZA `API_TAB_MAP` — adres pochodzi
 * z tekstu, który użytkownik i tak widzi, a odpowiedź nie ujawnia niczego z
 * naszej bazy, więc wystarczy zalogowana sesja (jak `/company-lookup`).
 *
 * Cała robota i całe bezpieczeństwo siedzą w `src/lib/link-preview.ts` — tutaj
 * zostaje walidacja wejścia (400 dla adresu, którego nie tkniemy) i limit tempa.
 */
import { Hono } from "hono";
import type { ApiResponse } from "../types/index.js";
import { getUserId } from "../middleware/auth.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  checkHostname,
  getLinkPreview,
  LinkPreviewError,
  normalizeUrl,
  type LinkPreview,
} from "../lib/link-preview.js";

const app = new Hono();

/**
 * Hojny limit per użytkownik: jedna notatka pyta o maks. 3 adresy, a wyniki
 * lecą z cache'u — 300 pobrań na godzinę zobaczy tylko skrypt.
 */
const perUser = createRateLimiter({ limit: 300, windowMs: 60 * 60_000 });

// GET /links/preview?url=... — metadane strony (z cache'u albo świeżo pobrane)
app.get("/preview", async (c) => {
  const raw = c.req.query("url") ?? "";
  const normalized = normalizeUrl(raw);
  if (!normalized) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy adres URL" }, 400);
  }

  // Odrzucamy PRZED pobraniem to, czego serwerowi nie wolno tknąć — adresy
  // lokalne i prywatne. Reszta walidacji (DNS, przekierowania) siedzi w
  // `getLinkPreview` i kończy się podglądem ze `status: "error"`, bo tam chodzi
  // już o cudzą stronę, a nie o próbę sięgnięcia do naszej sieci.
  const hostProblem = checkHostname(new URL(normalized).hostname);
  if (hostProblem) {
    return c.json<ApiResponse<null>>({ success: false, error: hostProblem }, 400);
  }

  if (!perUser.check(String(getUserId(c)))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo zapytań o podgląd linków — spróbuj za chwilę" },
      429
    );
  }

  try {
    const data = await getLinkPreview(normalized);
    return c.json<ApiResponse<LinkPreview>>({ success: true, data });
  } catch (err) {
    if (err instanceof LinkPreviewError) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    console.error("[links/preview]", err);
    return c.json<ApiResponse<null>>({ success: false, error: "Nie udało się pobrać podglądu" }, 500);
  }
});

export default app;
