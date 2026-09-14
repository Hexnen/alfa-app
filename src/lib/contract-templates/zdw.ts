/**
 * Szablon „Umowa ZDW — Alfa Group”: definicje pól formularza i wstępne
 * wypełnienie z CRM (wzorzec: src/lib/protocol-prefill.ts).
 *
 * ŁAŃCUCH DANYCH jest zawsze ten sam i zawsze idzie po KLUCZACH OBCYCH:
 *   objects (adres, miasto, abonament ZDW, spółka, kontrahent)
 *     → contractors (nazwa, NIP, adres, e-mail, osoba kontaktowa)
 *     → companies  (dane rejestrowe i „Dane do umów”: kod, nazwa w treści,
 *                   reprezentant w dopełniaczu, kapitał zakładowy)
 *     → contacts   (osoby kontaktowe obiektu albo kontrahenta, `is_primary` pierwsza)
 *
 * `prefillZdw` jest CZYSTE względem zapisu — tylko odczyt. Wszystko, czego nie
 * dało się ustalić, wraca jako ostrzeżenie pełnym polskim zdaniem; formularz
 * i tak pozwoli zapisać (człowiek dopisze ręcznie), ale nie udaje, że wie.
 */
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { kwotaSlownie } from "../kwota-slownie.js";
import { zonedToday } from "../tz.js";
import { formatNIP } from "../../utils/nip.js";
import type { ContractFieldDef, ContractPrefillResult, ContractTemplateDef } from "./registry.js";
import { contractorAddressLine, fullName, miejscownik, moneyFieldValue, withStreetPrefix } from "./shared.js";

// ---------------------------------------------------------------------------
// Pola formularza
// ---------------------------------------------------------------------------

const G_NAGLOWEK = "Nagłówek umowy";
const G_ZLECENIOBIORCA = "Zleceniobiorca (spółka)";
const G_ZLECENIODAWCA = "Zleceniodawca (kontrahent)";
const G_OBIEKT = "Obiekt";
const G_ROZLICZENIE = "Rozliczenie";
const G_KONTAKTY = "Osoby kontaktowe Zleceniodawcy";

const GROUPS = [G_NAGLOWEK, G_ZLECENIOBIORCA, G_ZLECENIODAWCA, G_OBIEKT, G_ROZLICZENIE, G_KONTAKTY];

/** Kropki z oryginalnego wzoru — puste pole zostaje miejscem na długopis. */
const KROPKI = "…………….";

/** „jest / nie jest” z gwiazdką odsyłającą do „niepotrzebne skreślić”. */
const WARIANT: { value: string; label: string }[] = [
  { value: "jest", label: "jest" },
  { value: "nie jest", label: "nie jest" },
];

const FIELDS: ContractFieldDef[] = [
  { key: "numer", label: "Numer umowy", group: G_NAGLOWEK, type: "text", readOnly: true, hint: "Nadawany przy zapisie z licznika spółki" },
  { key: "data_umowy", label: "Data zawarcia", group: G_NAGLOWEK, type: "date", required: true },
  { key: "miejsce", label: "Miejsce zawarcia (miejscownik)", group: G_NAGLOWEK, type: "text", hint: "np. Warszawie" },

  { key: "zleceniobiorca_nazwa", label: "Nazwa spółki", group: G_ZLECENIOBIORCA, type: "text" },
  { key: "zleceniobiorca_siedziba", label: "Siedziba", group: G_ZLECENIOBIORCA, type: "text", hint: "np. Warszawie (03-612) przy ul. Koniczynowa 2A" },
  { key: "zleceniobiorca_krs", label: "KRS", group: G_ZLECENIOBIORCA, type: "text" },
  { key: "zleceniobiorca_nip", label: "NIP", group: G_ZLECENIOBIORCA, type: "text" },
  { key: "zleceniobiorca_regon", label: "REGON", group: G_ZLECENIOBIORCA, type: "text" },
  { key: "zleceniobiorca_kapital", label: "Kapitał zakładowy", group: G_ZLECENIOBIORCA, type: "text" },
  { key: "zleceniobiorca_reprezentant", label: "Reprezentant (dopełniacz)", group: G_ZLECENIOBIORCA, type: "text", hint: "np. Sławomira Jaworskiego - Prezesa Zarządu" },

  { key: "kontrahent_nazwa", label: "Nazwa kontrahenta", group: G_ZLECENIODAWCA, type: "text", required: true },
  { key: "kontrahent_adres", label: "Adres", group: G_ZLECENIODAWCA, type: "text", hint: "np. ul. Heroldów 7, 01-991 Warszawa" },
  { key: "kontrahent_nip", label: "NIP", group: G_ZLECENIODAWCA, type: "text" },
  { key: "kontrahent_reprezentant", label: "Reprezentowany przez", group: G_ZLECENIODAWCA, type: "text" },

  { key: "obiekt_adres", label: "Adres obiektu (miejscownik)", group: G_OBIEKT, type: "text", required: true, hint: "np. Heroldów 7 w Warszawie" },
  { key: "ochrona_obowiazkowa", label: "Obiekt podlega obowiązkowej ochronie", group: G_OBIEKT, type: "select", options: WARIANT },
  { key: "duzy_przedsiebiorca", label: "Zleceniodawca jest dużym przedsiębiorcą", group: G_OBIEKT, type: "select", options: WARIANT },

  { key: "abonament", label: "Abonament miesięczny (zł netto)", group: G_ROZLICZENIE, type: "money" },
  { key: "abonament_slownie", label: "Abonament słownie", group: G_ROZLICZENIE, type: "text", derivedFrom: "abonament" },
  { key: "stawka_patrol", label: "Stawka za godzinę patrolu (zł netto)", group: G_ROZLICZENIE, type: "money" },
  { key: "stawka_patrol_slownie", label: "Stawka słownie", group: G_ROZLICZENIE, type: "text", derivedFrom: "stawka_patrol" },
  { key: "email_faktura", label: "E-mail do e-faktur", group: G_ROZLICZENIE, type: "email" },
  { key: "email_cma", label: "E-mail do informacji z CMA", group: G_ROZLICZENIE, type: "email" },

  { key: "kontakt1_nazwa", label: "Osoba 1 — imię i nazwisko", group: G_KONTAKTY, type: "text", emptyPlaceholder: KROPKI },
  { key: "kontakt1_telefon", label: "Osoba 1 — telefon", group: G_KONTAKTY, type: "text", emptyPlaceholder: KROPKI },
  { key: "kontakt1_email", label: "Osoba 1 — e-mail", group: G_KONTAKTY, type: "email", emptyPlaceholder: KROPKI },
  { key: "kontakt2_nazwa", label: "Osoba 2 — imię i nazwisko", group: G_KONTAKTY, type: "text", emptyPlaceholder: KROPKI },
  { key: "kontakt2_telefon", label: "Osoba 2 — telefon", group: G_KONTAKTY, type: "text", emptyPlaceholder: KROPKI },
  { key: "kontakt2_email", label: "Osoba 2 — e-mail", group: G_KONTAKTY, type: "email", emptyPlaceholder: KROPKI },
];

/** Domyślna stawka godziny patrolu z oryginalnego wzoru (zł netto). */
export const DEFAULT_STAWKA_PATROL = 150;

// ---------------------------------------------------------------------------
// Prefill
// ---------------------------------------------------------------------------

export function prefillZdw(objectId: number): ContractPrefillResult {
  const object = db.select().from(schema.objects).where(eq(schema.objects.id, objectId)).get();
  if (!object) throw new Error(`Obiekt ${objectId} nie istnieje`);

  const contractor = db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.id, object.contractorId))
    .get();
  const company = object.companyId
    ? db.select().from(schema.companies).where(eq(schema.companies.id, object.companyId)).get()
    : undefined;

  /*
   * Osoby kontaktowe: najpierw przypisane WPROST do obiektu, potem kontrahenta.
   * Kolejność „obiekt przed kontrahentem” jest celowa — kierownik budowy zna
   * bramę i psa, a księgowość kontrahenta nie; do umowy idzie ten pierwszy.
   */
  const contactRows = db
    .select()
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.active, true),
        contractor
          ? or(eq(schema.contacts.objectId, objectId), eq(schema.contacts.contractorId, contractor.id))
          : eq(schema.contacts.objectId, objectId)
      )
    )
    .orderBy(
      // Kontakt obiektu przed kontaktem kontrahenta, w obu grupach „główny” pierwszy.
      desc(sql`case when ${schema.contacts.objectId} = ${objectId} then 1 else 0 end`),
      desc(schema.contacts.isPrimary),
      asc(schema.contacts.id)
    )
    .all();

  const fields: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const warnings: string[] = [];
  const put = (key: string, value: string, source: string) => {
    fields[key] = value;
    if (value) sources[key] = source;
  };

  // --- Nagłówek ---
  fields.numer = "";
  put("data_umowy", zonedToday(), "domyślne");

  // --- Zleceniobiorca (spółka) ---
  if (!company) {
    warnings.push("Obiekt nie ma przypisanej spółki — dane Zleceniobiorcy trzeba wpisać ręcznie. Uzupełnij spółkę w kartotece obiektu.");
    fields.miejsce = "";
    fields.zleceniobiorca_nazwa = "";
    fields.zleceniobiorca_siedziba = "";
    fields.zleceniobiorca_krs = "";
    fields.zleceniobiorca_nip = "";
    fields.zleceniobiorca_regon = "";
    fields.zleceniobiorca_kapital = "";
    fields.zleceniobiorca_reprezentant = "";
  } else {
    const miasto = company.city ? miejscownik(company.city) : null;
    if (miasto && !miasto.known) {
      warnings.push(`Nie znam miejscownika nazwy „${company.city}” — popraw pole „Miejsce zawarcia” ręcznie.`);
    }
    put("miejsce", miasto?.value ?? "", "spółka");
    put("zleceniobiorca_nazwa", company.contractName ?? company.fullName ?? company.name, "spółka");
    put(
      "zleceniobiorca_siedziba",
      company.city && company.address
        ? `${miasto?.value ?? company.city}${company.postalCode ? ` (${company.postalCode})` : ""} przy ${withStreetPrefix(company.address)}`
        : "",
      "spółka"
    );
    put("zleceniobiorca_krs", company.krs ?? "", "spółka");
    put("zleceniobiorca_nip", company.nip ? formatNIP(company.nip) : "", "spółka");
    put("zleceniobiorca_regon", company.regon ?? "", "spółka");
    put("zleceniobiorca_kapital", company.shareCapital ?? "", "spółka");
    put("zleceniobiorca_reprezentant", company.representativeLine ?? "", "spółka");

    if (!company.contractCode) {
      warnings.push(`Spółka ${company.name} nie ma kodu do numeracji umów — uzupełnij go w Spółki → Dane do umów.`);
    }
    if (!company.representativeLine) {
      warnings.push(`Spółka ${company.name} nie ma wpisanego reprezentanta — uzupełnij go w Spółki → Dane do umów (dopełniacz, np. „Jana Kowalskiego - Prezesa Zarządu”).`);
    }
    if (!company.shareCapital) {
      warnings.push(`Spółka ${company.name} nie ma wpisanego kapitału zakładowego — uzupełnij go w Spółki → Dane do umów.`);
    }
  }

  // --- Zleceniodawca (kontrahent) ---
  if (!contractor) {
    warnings.push("Obiekt nie ma kontrahenta — dane Zleceniodawcy trzeba wpisać ręcznie.");
    fields.kontrahent_nazwa = "";
    fields.kontrahent_adres = "";
    fields.kontrahent_nip = "";
    fields.kontrahent_reprezentant = "";
    fields.email_faktura = "";
    fields.email_cma = "";
  } else {
    put("kontrahent_nazwa", contractor.name, "kontrahent");
    put("kontrahent_adres", contractorAddressLine(contractor), "kontrahent");
    put("kontrahent_nip", contractor.nip ? formatNIP(contractor.nip) : "", "kontrahent");
    put("kontrahent_reprezentant", contractor.contactPerson ?? "", "kontrahent");
    put("email_faktura", contractor.email ?? "", "kontrahent");
    put("email_cma", contractor.email ?? "", "kontrahent");
    if (!contractor.nip) warnings.push(`Kontrahent ${contractor.name} nie ma NIP-u — uzupełnij go w kartotece kontrahenta.`);
    if (!contractor.email) warnings.push(`Kontrahent ${contractor.name} nie ma adresu e-mail — uzupełnij pola „E-mail do e-faktur” i „E-mail do informacji z CMA”.`);
  }

  // --- Obiekt ---
  if (object.address && object.city) {
    const m = miejscownik(object.city);
    if (!m.known) {
      warnings.push(`Nie znam miejscownika nazwy „${object.city}” — popraw pole „Adres obiektu” ręcznie.`);
    }
    put("obiekt_adres", `${object.address} w ${m.value}`, "obiekt");
  } else {
    fields.obiekt_adres = [object.address, object.city].filter(Boolean).join(" ");
    if (fields.obiekt_adres) sources.obiekt_adres = "obiekt";
    warnings.push("Obiekt nie ma pełnego adresu (ulica + miasto) — uzupełnij pole „Adres obiektu”.");
  }
  put("ochrona_obowiazkowa", "nie jest", "domyślne");
  put("duzy_przedsiebiorca", "nie jest", "domyślne");

  // --- Rozliczenie ---
  // NULL ≠ 0: abonament nieuzupełniony zostaje pustym polem, a nie zerem w umowie.
  if (object.monthlyZdw !== null && object.monthlyZdw !== undefined) {
    put("abonament", moneyFieldValue(object.monthlyZdw), "obiekt");
    put("abonament_slownie", kwotaSlownie(object.monthlyZdw), "wyliczone");
  } else {
    fields.abonament = "";
    fields.abonament_slownie = "";
    warnings.push("Obiekt nie ma uzupełnionego abonamentu ZDW — wpisz kwotę abonamentu ręcznie.");
  }
  put("stawka_patrol", moneyFieldValue(DEFAULT_STAWKA_PATROL), "domyślne");
  put("stawka_patrol_slownie", kwotaSlownie(DEFAULT_STAWKA_PATROL), "wyliczone");

  // --- Osoby kontaktowe ---
  const [k1, k2] = contactRows;
  const putContact = (n: 1 | 2, c: (typeof contactRows)[number] | undefined) => {
    fields[`kontakt${n}_nazwa`] = c ? fullName(c) : "";
    fields[`kontakt${n}_telefon`] = c?.phone ?? "";
    fields[`kontakt${n}_email`] = c?.email ?? "";
    if (c) {
      for (const suffix of ["nazwa", "telefon", "email"]) {
        if (fields[`kontakt${n}_${suffix}`]) sources[`kontakt${n}_${suffix}`] = "kontakt obiektu";
      }
    }
  };
  putContact(1, k1);
  putContact(2, k2);
  if (!k1) {
    warnings.push("Obiekt ani kontrahent nie mają osób kontaktowych — w umowie zostaną kropki do wypełnienia.");
  }

  return {
    fields,
    sources,
    warnings,
    companyId: company?.id ?? null,
    companyName: company?.name ?? null,
    contractorId: contractor?.id ?? null,
    contractorName: contractor?.name ?? null,
    objectName: object.name,
  };
}

export const CONTRACT_TEMPLATE_ZDW: ContractTemplateDef = {
  key: "zdw-alfa-group",
  label: "Umowa ZDW — Alfa Group",
  description:
    "Umowa o świadczenie usługi zdalnego dozoru wideo (ZDW) na wzorze Alfa Group. Nagłówek, stopka, koncesja i numeracja paragrafów pochodzą z oryginalnego dokumentu Worda.",
  file: "zdw-alfa-group.docx",
  fileLabel: "Umowa ZDW",
  companyName: "ALFA",
  sourceNote: "Aktualna Umowa Draft Tylko ZDW.docx (ALFA G, 05.2023)",
  groups: GROUPS,
  fields: FIELDS,
  prefill: prefillZdw,
};
