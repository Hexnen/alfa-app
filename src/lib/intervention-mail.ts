/**
 * Szablony maili grup interwencyjnych: „Zapytanie o ofertę” (rfq) i „Wypowiedzenie
 * obiektu” (termination).
 *
 * Treść trzyma tabela `app_settings` (klucze `interventions.rfq.*`,
 * `interventions.termination.*`) — jak konfiguracja asystenta i poczty. Brak wpisu
 * = szablon domyślny z tego pliku, więc „Przywróć domyślny” to zwykłe skasowanie
 * klucza, a nie przepisanie tekstu z powrotem.
 *
 * KOLEJNOŚĆ RENDEROWANIA JEST KRYTYCZNA (i tak jest przetestowana):
 *   1. podstawienie placeholderów do SUROWEGO tekstu → `text`,
 *   2. escapowanie CAŁEGO tekstu PO podstawieniu (nazwa firmy „<script>” ma wyjść
 *      jako `&lt;script&gt;`; escapowanie szablonu przed podstawieniem wpuściłoby
 *      HTML z kartoteki prosto do wiadomości),
 *   3. lite-markdown na zescapowanym tekście (**pogrubienie**, listy `- `, akapity),
 *   4. wspólny szkielet maila `wrapMailShell` z src/lib/order-mail.ts.
 *
 * Konsument: src/routes/intervention-groups.ts (podgląd i wysyłka).
 */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getSetting } from "./settings.js";
import { mailLogoUrl, wrapMailShell } from "./order-mail.js";

export const INTERVENTION_MAIL_KINDS = ["rfq", "termination"] as const;
export type InterventionMailKind = (typeof INTERVENTION_MAIL_KINDS)[number];

export function isInterventionMailKind(v: unknown): v is InterventionMailKind {
  return typeof v === "string" && (INTERVENTION_MAIL_KINDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Placeholdery
// ---------------------------------------------------------------------------

export interface PlaceholderDef {
  /** Token dosłownie tak, jak wpisuje się go w szablonie. */
  token: string;
  /** Etykieta PL — podpowiedź nad polem treści na froncie. */
  label: string;
  /** W których szablonach ma sens (front pokazuje tylko pasujące). */
  kinds: InterventionMailKind[];
}

const BOTH: InterventionMailKind[] = ["rfq", "termination"];

export const PLACEHOLDERS: PlaceholderDef[] = [
  { token: "{{firma}}", label: "Nazwa firmy interwencyjnej", kinds: BOTH },
  { token: "{{osoba}}", label: "Osoba kontaktowa w firmie", kinds: BOTH },
  { token: "{{obiekt}}", label: "Nazwa obiektu", kinds: BOTH },
  { token: "{{adres_obiektu}}", label: "Adres obiektu", kinds: BOTH },
  { token: "{{miasto}}", label: "Miasto obiektu", kinds: BOTH },
  { token: "{{data_startu}}", label: "Data rozpoczęcia współpracy", kinds: ["termination"] },
  { token: "{{data_zakonczenia}}", label: "Data zakończenia współpracy", kinds: ["termination"] },
  { token: "{{nadawca}}", label: "Podpis nadawcy", kinds: BOTH },
];

// ---------------------------------------------------------------------------
// Deskryptory pól (wzorzec ASSISTANT_FIELDS / MAIL_FIELDS)
// ---------------------------------------------------------------------------

export interface InterventionMailFieldDef {
  /** Klucz w app_settings. */
  dbKey: string;
  label: string;
  maxLength: number;
  /** Wartość domyślna — używana, gdy w bazie nie ma wpisu. */
  fallback: string;
}

export interface InterventionMailTemplateDef {
  label: string;
  subject: InterventionMailFieldDef;
  body: InterventionMailFieldDef;
}

const RFQ_SUBJECT = "Zapytanie o ofertę — usługa grupy interwencyjnej ({{obiekt}})";

const RFQ_BODY = `Dzień dobry {{osoba}},

zwracamy się z zapytaniem o ofertę na usługę **grupy interwencyjnej** dla obiektu {{obiekt}}, {{adres_obiektu}}, {{miasto}}.

Prosimy o podanie następujących warunków:
- kwota jednego podjazdu (zł netto),
- abonament miesięczny za gotowość (zł netto),
- liczba podjazdów wliczonych w abonament,
- koszt godziny postoju na obiekcie (zł netto),
- deklarowany czas dojazdu na obiekt,
- obszar działania grupy.

Prosimy o odpowiedź na tę wiadomość wraz z warunkami umowy ramowej.

Pozdrawiam,
{{nadawca}}`;

const TERMINATION_SUBJECT = "Wypowiedzenie usługi grupy interwencyjnej — {{obiekt}}";

const TERMINATION_BODY = `Dzień dobry {{osoba}},

informujemy, że z dniem {{data_zakonczenia}} kończymy współpracę z firmą **{{firma}}** w zakresie usługi grupy interwencyjnej dla obiektu {{obiekt}}, {{adres_obiektu}}, {{miasto}} (usługa realizowana od {{data_startu}}).

Prosimy o potwierdzenie przyjęcia wypowiedzenia oraz o rozliczenie podjazdów wykonanych do dnia zakończenia współpracy.

Pozdrawiam,
{{nadawca}}`;

export const SUBJECT_MAX = 200;
export const BODY_MAX = 20000;

export const INTERVENTION_MAIL_FIELDS: Record<InterventionMailKind, InterventionMailTemplateDef> = {
  rfq: {
    label: "Zapytanie o ofertę",
    subject: {
      dbKey: "interventions.rfq.subject",
      label: "Temat zapytania o ofertę",
      maxLength: SUBJECT_MAX,
      fallback: RFQ_SUBJECT,
    },
    body: {
      dbKey: "interventions.rfq.body",
      label: "Treść zapytania o ofertę",
      maxLength: BODY_MAX,
      fallback: RFQ_BODY,
    },
  },
  termination: {
    label: "Wypowiedzenie obiektu",
    subject: {
      dbKey: "interventions.termination.subject",
      label: "Temat wypowiedzenia",
      maxLength: SUBJECT_MAX,
      fallback: TERMINATION_SUBJECT,
    },
    body: {
      dbKey: "interventions.termination.body",
      label: "Treść wypowiedzenia",
      maxLength: BODY_MAX,
      fallback: TERMINATION_BODY,
    },
  },
};

/** Wszystkie klucze app_settings tego modułu (sprzątanie w testach, kasowanie hurtem). */
export const INTERVENTION_MAIL_SETTING_KEYS = INTERVENTION_MAIL_KINDS.flatMap((k) => [
  INTERVENTION_MAIL_FIELDS[k].subject.dbKey,
  INTERVENTION_MAIL_FIELDS[k].body.dbKey,
]);

export interface InterventionTemplateJson {
  kind: InterventionMailKind;
  label: string;
  subject: string;
  body: string;
  subjectDefault: string;
  bodyDefault: string;
  /** true = oba pola pochodzą z wartości domyślnych (w bazie nie ma wpisu). */
  isDefault: boolean;
  /** Kiedy szablon zapisano w bazie; null dla domyślnego. */
  updatedAt: string | null;
}

/** Efektywna treść jednego szablonu (DB → wartość domyślna). */
export function getInterventionTemplate(kind: InterventionMailKind): InterventionTemplateJson {
  const def = INTERVENTION_MAIL_FIELDS[kind];
  const rows = db
    .select()
    .from(schema.appSettings)
    .where(inArray(schema.appSettings.key, [def.subject.dbKey, def.body.dbKey]))
    .all();
  const bySubject = rows.find((r) => r.key === def.subject.dbKey);
  const byBody = rows.find((r) => r.key === def.body.dbKey);
  const stamps = rows.map((r) => r.updatedAt).filter((v): v is string => !!v);
  return {
    kind,
    label: def.label,
    subject: bySubject?.value ?? def.subject.fallback,
    body: byBody?.value ?? def.body.fallback,
    subjectDefault: def.subject.fallback,
    bodyDefault: def.body.fallback,
    isDefault: !bySubject && !byBody,
    updatedAt: stamps.length ? stamps.sort().at(-1)! : null,
  };
}

export function getInterventionTemplates(): InterventionTemplateJson[] {
  return INTERVENTION_MAIL_KINDS.map(getInterventionTemplate);
}

/** Surowa treść szablonu (bez metadanych) — do renderowania. */
function rawTemplate(kind: InterventionMailKind): { subject: string; body: string } {
  const def = INTERVENTION_MAIL_FIELDS[kind];
  return {
    subject: getSetting(def.subject.dbKey) ?? def.subject.fallback,
    body: getSetting(def.body.dbKey) ?? def.body.fallback,
  };
}

// ---------------------------------------------------------------------------
// Renderowanie
// ---------------------------------------------------------------------------

export interface RenderCompany {
  name: string;
  contactPerson?: string | null;
  email?: string | null;
}

export interface RenderObject {
  name: string;
  address?: string | null;
  city?: string | null;
}

export interface RenderTerm {
  startDate?: string | null;
  endDate?: string | null;
}

export interface RenderInterventionMailInput {
  kind: InterventionMailKind;
  company: RenderCompany;
  object?: RenderObject | null;
  term?: RenderTerm | null;
  /** Podpis pod wiadomością — imię i nazwisko zalogowanego użytkownika. */
  sender?: string | null;
  /** Absolutny adres aplikacji (logo w nagłówku) — src/lib/order-mail.ts:resolveBaseUrl. */
  baseUrl?: string;
}

export interface RenderedInterventionMail {
  subject: string;
  text: string;
  html: string;
  /** Tokeny użyte w szablonie, dla których zabrakło danych (front pokazuje ostrzeżenie). */
  missing: string[];
}

const TOKEN_RE = /\{\{[a-z_]+\}\}/g;

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function valuesFor(input: RenderInterventionMailInput): Record<string, string> {
  return {
    "{{firma}}": clean(input.company?.name),
    "{{osoba}}": clean(input.company?.contactPerson),
    "{{obiekt}}": clean(input.object?.name),
    "{{adres_obiektu}}": clean(input.object?.address),
    "{{miasto}}": clean(input.object?.city),
    "{{data_startu}}": clean(input.term?.startDate),
    "{{data_zakonczenia}}": clean(input.term?.endDate),
    "{{nadawca}}": clean(input.sender),
  };
}

/**
 * Podstawia wartości. Token bez danych → pusty string, a jego nazwa ląduje w `missing`.
 * Token, którego nie znamy, ZOSTAJE dosłownie: to literówka autora szablonu i lepiej,
 * żeby zobaczył ją w podglądzie, niż żeby zniknęła po cichu.
 */
function substitute(template: string, values: Record<string, string>, missing: Set<string>): string {
  return template.replace(TOKEN_RE, (token) => {
    if (!(token in values)) return token;
    const v = values[token];
    if (!v) missing.add(token);
    return v;
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Lite-markdown NA JUŻ ZESCAPOWANYM tekście: `**pogrubienie**`, linie `- ` jako lista,
 * pusta linia jako nowy akapit, pojedyncze złamanie jako `<br>`. Celowo nie ma tu
 * linków ani obrazków — mail ma być prosty i przewidywalny w Outlooku.
 */
function liteMarkdown(escaped: string): string {
  const bold = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = escaped.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(
      `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;">${bold(para.join("<br>"))}</p>`
    );
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push(
      `<ul style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.65;">${list
        .map((li) => `<li style="margin:0 0 4px;">${bold(li)}</li>`)
        .join("")}</ul>`
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      flushPara();
      continue;
    }
    if (/^[-*]\s+/.test(line.trim())) {
      flushPara();
      list.push(line.trim().replace(/^[-*]\s+/, ""));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushList();
  flushPara();
  return out.join("\n");
}

/** Pierwsze zdanie treści na listę wiadomości (obok tematu). */
function preheaderOf(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

export function renderInterventionMail(
  input: RenderInterventionMailInput
): RenderedInterventionMail {
  const tpl = rawTemplate(input.kind);
  const values = valuesFor(input);
  const missing = new Set<string>();

  // (1) podstawienie do surowego tekstu
  const subject = substitute(tpl.subject, values, missing);
  const text = substitute(tpl.body, values, missing);

  // (2) escapowanie CAŁEGO tekstu po podstawieniu, (3) lite-markdown
  const content = liteMarkdown(escapeHtml(text));

  // (4) wspólny szkielet maila
  const html = wrapMailShell({
    subject,
    logoUrl: mailLogoUrl(input.baseUrl),
    headerTitle: "Grupa interwencyjna",
    headerExtraHtml: "",
    preheader: preheaderOf(text),
    footerNote: "Wiadomość wysłana z systemu Alfa Group.",
    body: `
        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#1f2933;">
${content}
          </td>
        </tr>`,
  });

  return { subject, text, html, missing: [...missing] };
}

/** Sprząta zapisane szablony (test, „Przywróć domyślny” dla wszystkich). */
export function deleteInterventionTemplate(kind: InterventionMailKind): void {
  const def = INTERVENTION_MAIL_FIELDS[kind];
  for (const key of [def.subject.dbKey, def.body.dbKey]) {
    db.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
  }
}
