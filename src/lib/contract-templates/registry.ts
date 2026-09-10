/**
 * Rejestr szablonów umów — typy pól, lista dostępnych wzorów i kształt JSON
 * wysyłany do formularza „Nowa umowa” (Umowy → Drafty umów).
 *
 * DLACZEGO REJESTR, A NIE JEDEN ZAHARDKODOWANY WZÓR. Firma ma w `obiekty/` kilka
 * wzorów (ZDW, RODO, karta zgłoszenia, warianty spółki ALFA S) i będzie ich
 * dokładać. Dołożenie kolejnego ma kosztować jeden otagowany plik `.docx`
 * + jedną definicję pól, a nie przerabianie routera.
 *
 * SZABLON JEST PRZYWIĄZANY DO SPÓŁKI. Nagłówek, stopka, numer koncesji i sąd
 * rejestrowy są WPISANE W DOKUMENT — nie da się ich podmienić tagiem. Dlatego
 * `companyName` jest częścią definicji, a szablon dla innej spółki grupy to
 * osobny plik, nie kolejne pole w formularzu.
 */
import { eq, sql } from "drizzle-orm";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { db, schema } from "../../db/index.js";
import { CONTRACT_TEMPLATE_ZDW } from "./zdw.js";

export type ContractFieldType = "text" | "textarea" | "email" | "money" | "date" | "select";

export interface ContractFieldOption {
  value: string;
  label: string;
}

export interface ContractFieldDef {
  key: string;
  label: string;
  /** Nazwa sekcji formularza; musi być jedną z `groups` szablonu. */
  group: string;
  type: ContractFieldType;
  options?: ContractFieldOption[];
  required?: boolean;
  /** Pole wypełniane przez serwer (numer umowy) — front pokazuje, nie pozwala edytować. */
  readOnly?: boolean;
  hint?: string;
  /**
   * Co wstawić do DOCX, gdy pole zostało puste. Dzięki temu nieuzupełniona osoba
   * kontaktowa zostaje w dokumencie kropkami do wypełnienia długopisem, a nie
   * pustą dziurą w zdaniu.
   */
  emptyPlaceholder?: string;
  /** Pole wyliczane z innego (kwota → kwota słownie). Serwer dolicza je przy zapisie. */
  derivedFrom?: string;
}

/** Skąd wzięła się podpowiedziana wartość (etykieta pod polem formularza). */
export type ContractPrefillSource =
  | "obiekt"
  | "kontrahent"
  | "spółka"
  | "kontakt obiektu"
  | "wyliczone"
  | "domyślne";

export interface ContractPrefillResult {
  fields: Record<string, string>;
  sources: Record<string, string>;
  warnings: string[];
  companyId: number | null;
  companyName: string | null;
  contractorId: number | null;
  contractorName: string | null;
  objectName: string;
}

export interface ContractTemplateDef {
  key: string;
  label: string;
  description: string;
  /** Nazwa pliku w `templates/umowy/`. */
  file: string;
  /**
   * Człon nazwy pobieranego pliku przed numerem („Umowa ZDW 12-ZDW-2026.docx”).
   * Osobny od `label`, bo etykieta niesie jeszcze spółkę, a to w nazwie pliku
   * tylko przeszkadza.
   */
  fileLabel: string;
  /** `companies.name` spółki, do której przywiązany jest nagłówek i stopka. */
  companyName: string;
  /**
   * Skąd wzięty wzór — nazwa oryginalnego pliku Worda i data wydania. Panel
   * „Wzory umów” pokazuje to wprost, żeby dało się sprawdzić, czy aplikacja
   * generuje z tej samej wersji, którą firma trzyma w segregatorze.
   */
  sourceNote: string;
  /** Kolejność sekcji formularza. */
  groups: string[];
  fields: ContractFieldDef[];
  prefill(objectId: number): ContractPrefillResult;
}

// ---------------------------------------------------------------------------
// Kształt JSON (kontrakt z frontem — frontend/src/lib/api.ts, contractDraftsApi)
// ---------------------------------------------------------------------------

export interface ContractDraftFieldDefJson {
  key: string;
  label: string;
  group: string;
  type: ContractFieldType;
  options?: ContractFieldOption[];
  required: boolean;
  readOnly: boolean;
  hint: string | null;
  emptyPlaceholder: string | null;
  derivedFrom: string | null;
}

export interface ContractTemplateJson {
  key: string;
  label: string;
  description: string;
  companyId: number | null;
  companyName: string;
  /** Czy szablon pasuje do spółki obiektu (bez obiektu w zapytaniu — zawsze true). */
  available: boolean;
  warning: string | null;
  groups: string[];
  fields: ContractDraftFieldDefJson[];
  /** Skąd wzięty wzór (oryginalny plik Worda + data wydania). */
  sourceNote: string;
  /** Nazwa otagowanego pliku w `templates/umowy/`. */
  fileName: string;
  /** Rozmiar tego pliku w bajtach; 0, gdy pliku nie ma na dysku. */
  fileSize: number;
  /** `fields.length` — front pokazuje liczbę bez rozwijania listy pól. */
  fieldCount: number;
  /** Ile draftów powstało z tego wzoru (cała baza, bez filtrów). */
  draftCount: number;
}

/**
 * Katalog szablonów liczony z położenia TEGO pliku, a nie z `process.cwd()`.
 * Skrypty testowe i narzędzia startują z różnych katalogów roboczych, a plik
 * `.docx` leży zawsze obok źródeł (w obrazie: `COPY templates ./templates`).
 */
export const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../templates/umowy");

export const CONTRACT_TEMPLATES: ContractTemplateDef[] = [CONTRACT_TEMPLATE_ZDW];

export function getTemplate(key: string): ContractTemplateDef | undefined {
  return CONTRACT_TEMPLATES.find((t) => t.key === key);
}

/** Id spółki, do której przywiązany jest szablon (null, gdy nie ma jej w słowniku). */
export function templateCompanyId(def: ContractTemplateDef): number | null {
  const row = db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.name, def.companyName))
    .get();
  return row?.id ?? null;
}

/**
 * Ile draftów powstało z tego wzoru. Liczymy przy każdym odczycie, bo to jedyna
 * liczba w panelu „Wzory umów”, która się zmienia — a przy krótkim rejestrze
 * jest to jeden `count(*)`.
 */
export function templateDraftCount(key: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.contractDrafts)
    .where(eq(schema.contractDrafts.templateKey, key))
    .get();
  return Number(row?.n ?? 0);
}

/** Rozmiar otagowanego pliku wzoru; 0, gdy pliku nie ma na dysku. */
export function templateFileSize(def: ContractTemplateDef): number {
  try {
    return statSync(join(TEMPLATES_DIR, def.file)).size;
  } catch {
    return 0;
  }
}

function fieldJson(f: ContractFieldDef): ContractDraftFieldDefJson {
  return {
    key: f.key,
    label: f.label,
    group: f.group,
    type: f.type,
    ...(f.options ? { options: f.options } : {}),
    required: f.required === true,
    readOnly: f.readOnly === true,
    hint: f.hint ?? null,
    emptyPlaceholder: f.emptyPlaceholder ?? null,
    derivedFrom: f.derivedFrom ?? null,
  };
}

/** Kontekst obiektu, dla którego sprawdzamy dostępność szablonu. */
export interface TemplateObjectContext {
  companyId: number | null;
  companyName: string | null;
}

/**
 * JSON szablonu. `available=false` NIE blokuje zapisu na sztywno — to ostrzeżenie
 * dla człowieka: dokument ma w nagłówku i stopce inną spółkę niż ta, która
 * fakturuje obiekt, więc prawie na pewno wybrano zły wzór.
 */
export function templateJson(def: ContractTemplateDef, object?: TemplateObjectContext | null): ContractTemplateJson {
  const companyId = templateCompanyId(def);
  let available = true;
  let warning: string | null = null;

  if (object) {
    if (object.companyId === null) {
      available = false;
      warning = `Obiekt nie ma przypisanej spółki — szablon jest wystawiany przez ${def.companyName}. Uzupełnij spółkę w kartotece obiektu.`;
    } else if (companyId !== null && object.companyId !== companyId) {
      available = false;
      warning = `Obiekt należy do spółki ${object.companyName ?? "—"}, a ten wzór ma w nagłówku i stopce ${def.companyName}. Wybierz szablon właściwej spółki.`;
    } else if (companyId === null) {
      available = false;
      warning = `W słowniku spółek nie ma pozycji „${def.companyName}”, do której przywiązany jest ten wzór.`;
    }
  }

  return {
    key: def.key,
    label: def.label,
    description: def.description,
    companyId,
    companyName: def.companyName,
    available,
    warning,
    groups: def.groups,
    fields: def.fields.map(fieldJson),
    sourceNote: def.sourceNote,
    fileName: def.file,
    fileSize: templateFileSize(def),
    fieldCount: def.fields.length,
    draftCount: templateDraftCount(def.key),
  };
}
