/**
 * Szablon „Umowa powierzenia danych osobowych (RODO) — Alfa Group”: definicje
 * pól i wstępne wypełnienie z CRM (wzorzec: src/lib/contract-templates/zdw.ts).
 *
 * CZYM RÓŻNI SIĘ OD ZDW. To umowa TOWARZYSZĄCA — podpisuje się ją razem
 * z umową o zdalny dozór wideo i powołuje się w niej na jej datę („Strony
 * zawarły w dniu … Umowę o świadczenie usługi zdalnego dozoru wideo”). Dlatego
 * formularz ma dwie daty, a tę drugą podpowiadamy z NAJNOWSZEGO draftu ZDW tego
 * obiektu: w praktyce RODO wystawia się zaraz po ZDW, więc data leży już w bazie
 * i przepisywanie jej ręcznie to tylko okazja do pomyłki.
 *
 * Dane Alfa Group (KRS, NIP, reprezentant) są WPISANE W DOKUMENT — szablon
 * należy do spółki, tak samo jak nagłówek i stopka. W formularzu zostaje więc
 * sam Powierzający, czyli kontrahent obiektu.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { zonedToday } from "../tz.js";
import { formatNIP } from "../../utils/nip.js";
import type { ContractFieldDef, ContractPrefillResult, ContractTemplateDef } from "./registry.js";
import { contractorAddressLine } from "./shared.js";
import { CONTRACT_TEMPLATE_ZDW } from "./zdw.js";

// ---------------------------------------------------------------------------
// Pola formularza
// ---------------------------------------------------------------------------

const G_NAGLOWEK = "Nagłówek umowy";
const G_POWIERZAJACY = "Powierzający (kontrahent)";
const G_UMOWA_GLOWNA = "Umowa główna";

const GROUPS = [G_NAGLOWEK, G_POWIERZAJACY, G_UMOWA_GLOWNA];

const FIELDS: ContractFieldDef[] = [
  { key: "data_umowy", label: "Data zawarcia", group: G_NAGLOWEK, type: "date", required: true, hint: "Wchodzi też w oba załączniki" },

  { key: "powierzajacy_nazwa", label: "Nazwa kontrahenta", group: G_POWIERZAJACY, type: "text", required: true },
  {
    key: "powierzajacy_adres",
    label: "Adres i NIP",
    group: G_POWIERZAJACY,
    type: "textarea",
    required: true,
    hint: "np. ul. Heroldów 7, 01-991 Warszawa, NIP: 118-009-04-58",
  },
  {
    key: "powierzajacy_reprezentacja",
    label: "Reprezentacja (opcjonalnie)",
    group: G_POWIERZAJACY,
    type: "textarea",
    hint: "np. reprezentowaną przez: Jana Kowalskiego – Prezesa Zarządu. Puste pole zostawia w umowie pustą linię.",
  },

  {
    key: "data_umowy_glownej",
    label: "Data umowy ZDW",
    group: G_UMOWA_GLOWNA,
    type: "date",
    required: true,
    hint: "Data umowy o świadczenie usługi zdalnego dozoru wideo, do której odsyła ta umowa",
  },
];

// ---------------------------------------------------------------------------
// Prefill
// ---------------------------------------------------------------------------

/**
 * Data zawarcia z NAJNOWSZEGO draftu ZDW tego obiektu albo `null`.
 *
 * Najnowszy = po dacie zawarcia, a przy remisie po id: dwie umowy z tego samego
 * dnia zdarzają się przy korektach i wtedy liczy się ta wystawiona później.
 * Pierwszeństwo ma pole `data_umowy` z formularza (to ono trafia do treści
 * dokumentu), a kolumna `contract_date` jest zapasem na wypadek uszkodzonego
 * JSON-a — obie i tak trzymamy w zgodzie przy zapisie.
 */
function latestZdwDate(objectId: number): string | null {
  const row = db
    .select({ contractDate: schema.contractDrafts.contractDate, fields: schema.contractDrafts.fields })
    .from(schema.contractDrafts)
    .where(
      and(eq(schema.contractDrafts.objectId, objectId), eq(schema.contractDrafts.templateKey, CONTRACT_TEMPLATE_ZDW.key))
    )
    .orderBy(desc(schema.contractDrafts.contractDate), desc(schema.contractDrafts.id))
    .limit(1)
    .get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.fields) as Record<string, unknown>;
    const value = parsed?.data_umowy;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  } catch {
    // Uszkodzony JSON nie ma prawa wywalić formularza — zostaje kolumna.
  }
  return row.contractDate;
}

export function prefillRodo(objectId: number): ContractPrefillResult {
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

  const fields: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const warnings: string[] = [];
  const put = (key: string, value: string, source: string) => {
    fields[key] = value;
    if (value) sources[key] = source;
  };

  // --- Nagłówek ---
  put("data_umowy", zonedToday(), "domyślne");

  // --- Powierzający (kontrahent) ---
  if (!contractor) {
    warnings.push("Obiekt nie ma kontrahenta — dane Powierzającego trzeba wpisać ręcznie.");
    fields.powierzajacy_nazwa = "";
    fields.powierzajacy_adres = "";
  } else {
    put("powierzajacy_nazwa", contractor.name, "kontrahent");
    const adres = contractorAddressLine(contractor);
    const nip = contractor.nip ? `NIP: ${formatNIP(contractor.nip)}` : "";
    put("powierzajacy_adres", [adres, nip].filter(Boolean).join(", "), "kontrahent");
    if (!contractor.nip) {
      warnings.push(`Kontrahent ${contractor.name} nie ma NIP-u — uzupełnij go w kartotece kontrahenta albo dopisz w polu „Adres i NIP”.`);
    }
    if (!adres) {
      warnings.push(`Kontrahent ${contractor.name} nie ma adresu — uzupełnij pole „Adres i NIP”.`);
    }
  }
  /*
   * Reprezentacja zostaje PUSTA z premedytacją. Kartoteka trzyma „osobę
   * kontaktową”, a umowa potrzebuje osoby uprawnionej do reprezentacji wraz
   * z funkcją — to nie to samo i podpowiedź z kontaktu wpisywałaby do umowy
   * kierownika budowy jako członka zarządu.
   */
  fields.powierzajacy_reprezentacja = "";

  // --- Umowa główna (ZDW) ---
  const zdwDate = latestZdwDate(objectId);
  if (zdwDate) {
    put("data_umowy_glownej", zdwDate, "umowa ZDW obiektu");
  } else {
    fields.data_umowy_glownej = "";
    warnings.push(
      "Ten obiekt nie ma w aplikacji żadnej umowy ZDW — wpisz datę umowy o świadczenie usługi zdalnego dozoru wideo ręcznie."
    );
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

export const CONTRACT_TEMPLATE_RODO: ContractTemplateDef = {
  key: "rodo-alfa-group",
  label: "Umowa powierzenia danych osobowych (RODO) — Alfa Group",
  description:
    "Umowa powierzenia przetwarzania danych osobowych (art. 28 RODO) towarzysząca umowie ZDW, na wzorze Alfa Group. Dane spółki, załączniki i numeracja paragrafów pochodzą z oryginalnego dokumentu Worda.",
  file: "rodo-alfa-group.docx",
  fileLabel: "Umowa RODO",
  companyName: "ALFA",
  sourceNote: "Umowa_powierzenia_danych_osobowych.docx (ALFA G, 05.2023)",
  /*
   * WŁASNA SERIA NUMERACJI. Dokument nie ma numeru w treści, ale rejestr
   * draftów wymaga unikalnego — gdyby brał go z serii spółki, umowy RODO
   * zjadałyby numery umowom ZDW i „12/ZDW/2026” w segregatorze nie zgadzałoby
   * się z aplikacją. Stąd stały kod `RODO` i osobny licznik.
   */
  numberCode: "RODO",
  groups: GROUPS,
  fields: FIELDS,
  prefill: prefillRodo,
};
