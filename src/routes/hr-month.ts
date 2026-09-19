/**
 * Stan miesiąca rozliczeniowego Kadr — odczyt, zamknięcie, ponowne otwarcie.
 *
 * Montowany w `src/routes/hr.ts` jedną linią pod `/month-status`, bo jest to
 * osobna sprawa od 40 tras kadrowych: trzy endpointy, jedna tabela
 * (`hr_month_status`, migracja 0106) i jedna reguła — zamknięty miesiąc nie
 * przyjmuje zmian danych miesięcznych (423 z `assertMonthOpen`, patrz
 * `src/lib/hr-month.ts`).
 *
 * Router powstaje przez FABRYKĘ, której podaje się funkcję liczącą listę
 * kontrolną. Lista bierze się z wyliczenia płac (`computeMonth` w hr.ts), a
 * import w drugą stronę zrobiłby cykl modułów — więc hr.ts wstrzykuje ją przy
 * montażu i obie trasy (`/hr/summary` i ta) liczą braki JEDNYM kodem.
 *
 * Uprawnienia: zamknięcie i otwarcie to decyzja o całym miesiącu wypłat, więc
 * wymagają `edit` na `kadry/wynagrodzenia` — nie wystarczy edycja godzin, choć
 * `tabPermissionGuard` przepuszcza na /hr każdego edytora dowolnej podzakładki.
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ApiResponse } from "../types/index.js";
import { getUser } from "../middleware/auth.js";
import { canEdit } from "../lib/auth/permissions.js";
import { logHrEvent, periodLabel } from "../lib/hr-activity.js";
import {
  closingNotes,
  closingWarnings,
  monthStatusRow,
  type HrMonthChecklist,
} from "../lib/hr-month.js";

export type { HrMonthChecklist };

/** Odpowiedź `GET /hr/month-status` — to, co rysuje pasek miesiąca. */
export interface HrMonthStatusPayload {
  year: number;
  month: number;
  status: "open" | "closed";
  /** Data ostatniego zamknięcia (ISO) — zostaje też po ponownym otwarciu. */
  closedAt: string | null;
  /** Podpis osoby, która zamknęła (snapshot, odporny na usunięcie konta). */
  closedBy: string | null;
  /** Ostatni powód ponownego otwarcia — pełna historia jest w dzienniku. */
  reopenReason: string | null;
  checklist: HrMonthChecklist;
}

const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const YEAR_MONTH_ERROR = `Nieprawidłowy rok/miesiąc (rok ${YEAR_MIN}–${YEAR_MAX}, miesiąc 1–12, liczby całkowite)`;

/** Rok i miesiąc z wartości surowych — bez domyślania się „bieżącego”: */
function readYearMonth(
  rawYear: unknown,
  rawMonth: unknown,
): { year: number; month: number } | { error: string } {
  const year = Number(rawYear);
  const month = Number(rawMonth);
  if (
    !Number.isInteger(year) ||
    year < YEAR_MIN ||
    year > YEAR_MAX ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return { error: YEAR_MONTH_ERROR };
  }
  return { year, month };
}

/** Minimalna długość powodu — „ok” i „bo” nie są uzasadnieniem. */
const REASON_MIN = 5;

export interface HrMonthDeps {
  /** Lista kontrolna miesiąca (ta sama, którą pokazuje `GET /hr/summary`). */
  loadChecklist: (year: number, month: number) => Promise<HrMonthChecklist>;
}

export function createHrMonthRoutes({ loadChecklist }: HrMonthDeps) {
  const app = new Hono();

  const payload = async (year: number, month: number): Promise<HrMonthStatusPayload> => {
    const row = monthStatusRow(year, month);
    return {
      year,
      month,
      status: row?.status === "closed" ? "closed" : "open",
      closedAt: row?.closedAt ?? null,
      closedBy: row?.closedByLabel ?? null,
      reopenReason: row?.reopenReason ?? null,
      checklist: await loadChecklist(year, month),
    };
  };

  /** `edit` na Wynagrodzeniach — inaczej komunikat, a nie ciche „nic się nie stało”. */
  const canCloseMonth = (c: Context) => canEdit(getUser(c), "kadry/wynagrodzenia");

  const NO_RIGHTS = "Zamykanie miesiąca wymaga prawa edycji Wynagrodzeń";

  // ---------------------------------------------------------------------
  // Odczyt
  // ---------------------------------------------------------------------

  app.get("/", async (c) => {
    const ym = readYearMonth(c.req.query("year"), c.req.query("month"));
    if ("error" in ym) {
      return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
    }
    return c.json({ success: true, data: await payload(ym.year, ym.month) });
  });

  // ---------------------------------------------------------------------
  // Zamknięcie
  // ---------------------------------------------------------------------

  app.post("/close", async (c) => {
    if (!canCloseMonth(c)) {
      return c.json<ApiResponse<null>>({ success: false, error: NO_RIGHTS }, 403);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const ym = readYearMonth(body.year, body.month);
    if ("error" in ym) {
      return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
    }
    const { year, month } = ym;
    const label = periodLabel({ year, month });

    const existing = monthStatusRow(year, month);
    if (existing?.status === "closed") {
      return c.json<ApiResponse<HrMonthStatusPayload>>(
        {
          success: false,
          error: `Miesiąc ${label} jest już zamknięty`,
          data: await payload(year, month),
        },
        409,
      );
    }

    const checklist = await loadChecklist(year, month);
    const warnings = closingWarnings(checklist);
    // Notki nie blokują zamknięcia, ale jadą razem z odmową — kadrowa widzi
    // w jednym komunikacie i to, co musi domknąć, i to, co tylko odnotowuje.
    const notes = closingNotes(checklist);
    // Braki zatrzymują zamknięcie, ale go nie zabraniają: „force” to świadome
    // „wiem, zamykam mimo to” — i taki zapis zostaje w dzienniku z listą braków.
    if (warnings.length > 0 && body.force !== true) {
      const note = notes.length > 0 ? ` Do odnotowania: ${notes.join("; ")}.` : "";
      return c.json<ApiResponse<HrMonthStatusPayload>>(
        {
          success: false,
          error: `Miesiąc ${label} ma braki: ${warnings.join("; ")}.${note}`,
          data: { ...(await payload(year, month)), checklist },
        },
        409,
      );
    }

    const user = getUser(c);
    const now = new Date().toISOString();
    const closedByLabel = (user.displayName || "").trim() || user.email || null;
    db.transaction((tx) => {
      const values = {
        status: "closed" as const,
        closedAt: now,
        closedByUserId: user.id,
        closedByLabel,
        // Powód poprzedniego otwarcia dotyczył poprzedniego zamknięcia —
        // w pasku „miesiąc zamknięty” byłby myląco aktualny.
        reopenReason: null,
        updatedAt: now,
      };
      if (existing) {
        tx.update(schema.hrMonthStatus)
          .set(values)
          .where(eq(schema.hrMonthStatus.id, existing.id))
          .run();
      } else {
        tx.insert(schema.hrMonthStatus).values({ year, month, ...values }).run();
      }
      logHrEvent(tx, {
        entityType: "hr_month",
        // Wpis dotyczy OKRESU, nie wiersza tabeli — id wiersza zmieniłoby się
        // przy pierwszym zamknięciu i historia miesiąca by się rozjechała.
        entityId: year * 100 + month,
        user,
        action: "status_changed",
        field: "status",
        oldValue: existing?.status ?? "open",
        newValue: "closed",
        summary:
          warnings.length > 0
            ? `Zamknięto ${label} (z ostrzeżeniami: ${warnings.join("; ")})`
            : notes.length > 0
              ? `Zamknięto ${label} (do odnotowania: ${notes.join("; ")})`
              : `Zamknięto ${label}`,
      });
    });

    return c.json({
      success: true,
      data: await payload(year, month),
      message: `Miesiąc ${label} zamknięty`,
    });
  });

  // ---------------------------------------------------------------------
  // Ponowne otwarcie
  // ---------------------------------------------------------------------

  app.post("/reopen", async (c) => {
    if (!canCloseMonth(c)) {
      return c.json<ApiResponse<null>>({ success: false, error: NO_RIGHTS }, 403);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const ym = readYearMonth(body.year, body.month);
    if ("error" in ym) {
      return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
    }
    const { year, month } = ym;
    const label = periodLabel({ year, month });
    // Powód jest WARUNKIEM otwarcia, nie ozdobą: zamknięty miesiąc to dane,
    // które ktoś już wypłacił — za miesiąc nikt nie pamięta, po co go ruszano.
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < REASON_MIN) {
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error: `Podaj powód ponownego otwarcia (min. ${REASON_MIN} znaków)`,
        },
        400,
      );
    }

    const existing = monthStatusRow(year, month);
    if (existing?.status !== "closed") {
      return c.json<ApiResponse<HrMonthStatusPayload>>(
        {
          success: false,
          error: `Miesiąc ${label} nie jest zamknięty`,
          data: await payload(year, month),
        },
        409,
      );
    }

    const user = getUser(c);
    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.update(schema.hrMonthStatus)
        .set({ status: "open", reopenReason: reason, updatedAt: now })
        // `closedAt` / `closedBy` ZOSTAJĄ: miesiąc otwarty ponownie to nie to
        // samo, co miesiąc nigdy nie zamknięty, i pasek ma o tym mówić.
        .where(eq(schema.hrMonthStatus.id, existing.id))
        .run();
      logHrEvent(tx, {
        entityType: "hr_month",
        entityId: year * 100 + month,
        user,
        action: "status_changed",
        field: "status",
        oldValue: "closed",
        newValue: "open",
        summary: `Otwarto ponownie ${label} — powód: ${reason}`,
      });
    });

    return c.json({
      success: true,
      data: await payload(year, month),
      message: `Miesiąc ${label} otwarty ponownie`,
    });
  });

  return app;
}
