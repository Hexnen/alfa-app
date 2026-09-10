/**
 * Rejestr sklepów: domena → parser + etykieta.
 *
 * Dobieramy po domenie (bez `www.`), z dopasowaniem także subdomen — Grodno ma
 * `sklep.grodno.pl` i `b2b.grodno.pl`, a to ten sam silnik. Nieznany sklep nie
 * jest błędem: dostaje parser ogólny i ostrzeżenie w diagnostyce.
 */
import type { ParserId, ShopParser } from "../types.js";
import { genericParser } from "./generic.js";
import { samalParser } from "./samal.js";
import { janexParser } from "./janex.js";
import { eltroxParser } from "./eltrox.js";
import { grodnoParser } from "./grodno.js";

interface ShopEntry {
  /** Nazwa pokazywana człowiekowi (belka panelu, lista źródeł towaru). */
  label: string;
  parser: ShopParser;
}

const SHOPS: Record<string, ShopEntry> = {
  "samal.pl": { label: "SAMAL", parser: samalParser },
  "janexint.com.pl": { label: "Janex International", parser: janexParser },
  "eltrox.pl": { label: "Eltrox", parser: eltroxParser },
  "grodno.pl": { label: "Grodno", parser: grodnoParser },
};

function entryFor(shop: string | null): ShopEntry | null {
  if (!shop) return null;
  const key = shop.toLowerCase().replace(/^www\./, "");
  if (SHOPS[key]) return SHOPS[key];
  for (const [domain, entry] of Object.entries(SHOPS)) {
    if (key.endsWith(`.${domain}`)) return entry;
  }
  return null;
}

export function parserFor(shop: string | null): ShopParser {
  return entryFor(shop)?.parser ?? genericParser;
}

/** Etykieta sklepu; dla nieznanych zostaje sama domena (uczciwie). */
export function shopLabelFor(shop: string | null): string {
  const entry = entryFor(shop);
  if (entry) return entry.label;
  return shop && shop.trim() ? shop : "nieznany sklep";
}

export function isKnownShop(shop: string | null): boolean {
  return entryFor(shop) !== null;
}

/** Lista obsługiwanych sklepów — dla UI („obsługujemy: …”). */
export function knownShops(): { shop: string; label: string; parser: ParserId }[] {
  return Object.entries(SHOPS).map(([shop, entry]) => ({
    shop,
    label: entry.label,
    parser: entry.parser.id,
  }));
}
