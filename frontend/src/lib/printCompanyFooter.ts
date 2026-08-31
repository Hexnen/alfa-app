/**
 * Stopka wydruku z danymi spółki wystawiającej.
 *
 * Dotąd każdy wydruk miał dane firmy WPISANE NA SZTYWNO w kodzie (patrz historia
 * `quotePrint.ts`): nazwa, KRS, NIP i REGON jednej spółki. Grupa ma ich kilka
 * (`companies`), a `orders.invoice_issuer` od dawna wskazuje, która wystawia —
 * więc dokument powinien brać te dane z bazy, a nie z literału w kodzie.
 *
 * `null` = brak wskazanej spółki; wtedy wołający decyduje, czy pokazać stopkę
 * domyślną, czy żadną. Nie zgadujemy tu spółki „na wszelki wypadek", bo zły NIP
 * na dokumencie handlowym jest gorszy niż brak stopki.
 */
import type { Company } from "./api";

const esc = (s: string | null | undefined) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Adres w jednej linii: „03-876 Warszawa, ul. Matuszewska 20". */
export function companyAddressLine(company: Company): string {
  const cityPart = [company.postalCode, company.city].filter(Boolean).join(" ");
  return [cityPart, company.address].filter(Boolean).join(", ");
}

/**
 * Zawartość stopki jako HTML (bez kontenera — opakowanie należy do szablonu).
 * Puste pola są pomijane, żeby nie zostawały sieroty w rodzaju „NIP: ".
 */
export function companyFooterHtml(company: Company | null): string {
  if (!company) return "";

  const title = esc(company.fullName || company.name);
  const address = esc(companyAddressLine(company));
  const ids = [
    company.krs && `KRS ${esc(company.krs)}`,
    company.nip && `NIP ${esc(company.nip)}`,
    company.regon && `REGON ${esc(company.regon)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return [`<b>${title}</b>`, address, ids].filter(Boolean).join(" · ");
}
