import type { Context } from "hono";
import { canView } from "./auth/permissions.js";
import type { User } from "../db/schema.js";

/**
 * Pola kosztowe ofert — widoczne wyłącznie z kluczem `technical/oferty-koszty`.
 *
 * Kopia listy `COST_FIELDS` z `src/routes/offers.ts` dla tras SPOZA modułu Ofert,
 * które też wydają oferty (karta szansy `GET /leads/:id` → `offers[]`,
 * docs/AUDYT-UPRAWNIEN-B.md #2). TODO: `offers.ts` powinien importować stąd —
 * przepięcie odłożone, bo plik był w tym samym czasie edytowany przez inną paczkę
 * (przy zmianie listy aktualizować OBA miejsca, dopóki nie zostaną scalone).
 */
export const OFFER_COST_FIELDS = [
  "unitCost",
  "lineCost",
  "oldUnitCost",
  "newUnitCost",
  "oneTimeCost",
  "oneTimeCostMaterial",
  "oneTimeCostLabour",
  "monthlyCost",
  "horizonCost",
  "margin",
  "belowMinMargin",
  "salesCommissionPct",
  "salesCommission",
  "companyProfit",
  "companyProfitPct",
] as const;

/** Czy użytkownik może oglądać koszty i marżę na ofertach. */
export function canSeeOfferCosts(c: Context): boolean {
  const user = c.get("user") as User | undefined;
  return !!user && canView(user, "technical/oferty-koszty");
}

/** Rekurencyjnie usuwa pola kosztowe z odpowiedzi (czarna lista jak w offers.ts). */
export function redactOfferCosts<T>(payload: T): T {
  if (Array.isArray(payload)) return payload.map((v) => redactOfferCosts(v)) as unknown as T;
  if (payload && typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if ((OFFER_COST_FIELDS as readonly string[]).includes(k)) continue;
      out[k] = redactOfferCosts(v);
    }
    return out as T;
  }
  return payload;
}
