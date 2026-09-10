/**
 * Ustawienia poczty WYCHODZĄCEJ aplikacji (tabela app_settings, klucze `mail.*`) —
 * konto SMTP, nadawca i adresaci maili ze zleceń.
 *
 * Precedencja: DB → env (tylko `orderInternalTo`) → wartość domyślna. Wartości czytane
 * przy KAŻDEJ operacji (bez restartu backendu), z fallbackiem na domyślne, gdy wpis
 * w bazie jest uszkodzony. Panel admina: /admin/poczta (src/routes/admin-mail.ts),
 * wysyłka: src/services/mail-sender.ts.
 *
 * DLACZEGO OSOBNO OD CMA: `cma_mail_settings` to konfiguracja SKRZYNKI CMA (IMAP + SMTP,
 * import raportów i wysyłka usterek) — jeden wiersz, własny panel w module CMA i własny
 * poller. Poczta systemowa (maile ze zleceń) jest ustawieniem CAŁEJ aplikacji z panelu
 * admina i nie może zależeć od tego, czy ktoś włączył import CMA. Dane logowania da się
 * przenieść jednym kliknięciem (POST /api/admin/mail/import-cma), ale od tego momentu
 * żyją niezależnie.
 *
 * SEKRET: `smtpPassword` leży w app_settings jawnie (SQLite na volume — chroń backupy),
 * NIGDY nie wraca do frontu (endpoint zwraca tylko `hasPassword`) i NIGDY nie trafia
 * do activity_log — dokładnie jak `assistant.api_key`.
 */
import { getSetting } from "./settings.js";

// ---------------------------------------------------------------------------
// Adresy e-mail
// ---------------------------------------------------------------------------

/**
 * Prosta walidacja adresu — celowo liberalna. Pełna zgodność z RFC 5322 to regex
 * na kilkaset znaków, który i tak przepuszcza adresy nieistniejące; jedyną prawdziwą
 * weryfikacją jest odpowiedź serwera SMTP. Tu odsiewamy literówki („jan@”, „jan doe”).
 */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+\.[^\s@,;<>"]{2,}$/;

export function isEmail(value: unknown): boolean {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

/**
 * „a@x.pl, b@y.pl; c@z.pl” → ["a@x.pl", "b@y.pl", "c@z.pl"].
 * Rozdzielacze: przecinek, średnik, biały znak i nowa linia (ludzie wklejają listy
 * z Excela i z Outlooka). Duplikaty (bez względu na wielkość liter) znikają,
 * kolejność pierwszego wystąpienia zostaje. Adresy niepoprawne są POMIJANE —
 * walidacja wejścia z API robiona jest osobno (`invalidAddresses`).
 */
export function parseAddressList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const addr = part.trim();
    if (!addr || !isEmail(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** Adresy z listy, które NIE są poprawnymi e-mailami (do komunikatu 400). */
export function invalidAddresses(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isEmail(s));
}

/** Normalizacja tablicy adresów z API: trim, deduplikacja, bez pustych. */
export function normalizeAddresses(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (typeof it !== "string") continue;
    const addr = it.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model ustawień
// ---------------------------------------------------------------------------

export interface MailSettingsValues {
  /** Serwer SMTP (host). */
  smtpHost: string;
  /** Port SMTP: 465 = SSL, 587 = STARTTLS. */
  smtpPort: number;
  /** true = połączenie szyfrowane od razu (SSL, port 465); false = STARTTLS. */
  smtpSecure: boolean;
  /** Login do SMTP — u większości dostawców to pełny adres e-mail. */
  smtpUser: string;
  /** Hasło do SMTP. SEKRET: nie wraca do frontu, nie trafia do activity_log. */
  smtpPassword: string;
  /** Nazwa nadawcy widoczna w kliencie pocztowym („Alfa Group” <biuro@…>). */
  fromName: string;
  /** Adres nadawcy. Pusty = używamy loginu SMTP. */
  fromAddress: string;
  /** Adres do odpowiedzi (Reply-To). Pusty = klient odpowiada na adres nadawcy. */
  replyTo: string;
  /** Skrzynki zespołu dla wewnętrznego maila zlecenia (lista adresów po przecinku). */
  orderInternalTo: string;
  /** Ukryta kopia (BCC) maili wysyłanych do klienta — np. archiwum biura. */
  orderClientBcc: string;
  /** Główny wyłącznik: bez niego aplikacja niczego nie wysyła (tylko podgląd). */
  sendEnabled: boolean;
}

export type MailSettingField = keyof MailSettingsValues;
export type Source = "db" | "env" | "default";

export const MAIL_DEFAULTS: MailSettingsValues = {
  smtpHost: "smtp.zenbox.pl",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: "",
  smtpPassword: "",
  fromName: "Alfa Group",
  fromAddress: "",
  replyTo: "",
  orderInternalTo: "",
  orderClientBcc: "",
  sendEnabled: false,
};

export type MailFieldType = "string" | "password" | "number" | "boolean" | "email" | "emailList";

export interface MailFieldDef<T> {
  /** Klucz w app_settings. */
  dbKey: string;
  /** Zmienna środowiskowa użyta jako wartość domyślna (gdy brak wpisu w DB). */
  envKey?: string;
  /** Etykieta PL — panel admina i summary w activity_log. */
  label: string;
  type: MailFieldType;
  /** Podpowiedź pod polem w panelu. */
  help: string;
  /** true = wartość nigdy nie opuszcza backendu (hasło). */
  secret?: boolean;
  /** Walidacja wartości z API (już w typie docelowym); komunikat błędu albo null. */
  validate: (v: unknown) => string | null;
  /** Normalizacja surowej wartości z JSON-a przed walidacją. */
  coerce?: (v: unknown) => unknown;
  /** Tekst z DB → wartość; undefined = nieprawidłowy wpis (lecimy dalej w precedencji). */
  parse: (raw: string) => T | undefined;
  /** Wartość → tekst do DB. */
  serialize: (v: T) => string;
  /** Formatowanie do summary w activity_log (hasło formatuje się jako „(ustawione)”). */
  format: (v: T) => string;
}

// --- helpery pól -----------------------------------------------------------

function stringField(
  dbKey: string,
  label: string,
  help: string,
  maxLen = 200
): MailFieldDef<string> {
  return {
    dbKey,
    label,
    help,
    type: "string",
    validate: (v) => {
      if (typeof v !== "string") return `${label}: oczekiwano tekstu`;
      if (v.length > maxLen) return `${label}: maks. ${maxLen} znaków`;
      return null;
    },
    coerce: (v) => (typeof v === "string" ? v.trim() : v),
    parse: (raw) => raw,
    serialize: (v) => v,
    format: (v) => v || "(brak)",
  };
}

/** Pojedynczy adres e-mail; pusty string jest dozwolony (= pole nieustawione). */
function emailField(dbKey: string, label: string, help: string): MailFieldDef<string> {
  return {
    dbKey,
    label,
    help,
    type: "email",
    validate: (v) => {
      if (typeof v !== "string") return `${label}: oczekiwano tekstu`;
      if (v.length > 200) return `${label}: maks. 200 znaków`;
      if (v && !isEmail(v)) return `${label}: „${v}” nie wygląda na adres e-mail`;
      return null;
    },
    coerce: (v) => (typeof v === "string" ? v.trim() : v),
    parse: (raw) => raw,
    serialize: (v) => v,
    format: (v) => v || "(brak)",
  };
}

/**
 * Lista adresów w jednym polu tekstowym. Zapisujemy DOKŁADNIE to, co wpisał człowiek
 * (po normalizacji separatorów), a nie tablicę — pole w panelu ma być jednym inputem,
 * a `parseAddressList` i tak jest jedynym miejscem, które je rozbija.
 */
function emailListField(dbKey: string, label: string, help: string, envKey?: string): MailFieldDef<string> {
  return {
    dbKey,
    envKey,
    label,
    help,
    type: "emailList",
    validate: (v) => {
      if (typeof v !== "string") return `${label}: oczekiwano tekstu`;
      if (v.length > 1000) return `${label}: maks. 1000 znaków`;
      const bad = invalidAddresses(v);
      if (bad.length) return `${label}: nieprawidłowe adresy: ${bad.join(", ")}`;
      return null;
    },
    coerce: (v) => (typeof v === "string" ? parseAddressList(v).join(", ") || v.trim() : v),
    parse: (raw) => raw,
    serialize: (v) => v,
    format: (v) => (parseAddressList(v).join(", ") || "(brak)"),
  };
}

function passwordField(dbKey: string, label: string, help: string): MailFieldDef<string> {
  return {
    dbKey,
    label,
    help,
    type: "password",
    secret: true,
    validate: (v) => {
      if (typeof v !== "string") return `${label}: oczekiwano tekstu`;
      if (v.length > 400) return `${label}: maks. 400 znaków`;
      return null;
    },
    // Hasła NIE trymujemy z obu stron do zera — ale spacje na krańcach to zawsze
    // wynik wklejania, nigdy część hasła aplikacyjnego.
    coerce: (v) => (typeof v === "string" ? v.trim() : v),
    parse: (raw) => raw,
    serialize: (v) => v,
    format: (v) => (v ? "(ustawione)" : "(brak)"),
  };
}

function portField(dbKey: string, label: string, help: string): MailFieldDef<number> {
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  return {
    dbKey,
    label,
    help,
    type: "number",
    validate: (v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${label}: oczekiwano liczby`;
      if (!ok(v)) return `${label}: dozwolony zakres 1–65535`;
      return null;
    },
    coerce: (v) => {
      if (typeof v === "string") {
        const t = v.trim();
        if (t === "") return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : v;
      }
      return v;
    },
    parse: (raw) => {
      const n = Number(raw.trim());
      return ok(n) ? n : undefined;
    },
    serialize: (v) => String(v),
    format: (v) => String(v),
  };
}

function booleanField(dbKey: string, label: string, help: string): MailFieldDef<boolean> {
  return {
    dbKey,
    label,
    help,
    type: "boolean",
    validate: (v) => (typeof v === "boolean" ? null : `${label}: oczekiwano true/false`),
    parse: (raw) => {
      const v = raw.trim().toLowerCase();
      if (v === "1" || v === "true") return true;
      if (v === "0" || v === "false") return false;
      return undefined;
    },
    serialize: (v) => (v ? "1" : "0"),
    format: (v) => (v ? "tak" : "nie"),
  };
}

export const MAIL_FIELDS: { [K in MailSettingField]: MailFieldDef<MailSettingsValues[K]> } = {
  smtpHost: stringField("mail.smtp_host", "Serwer SMTP", "Adres serwera poczty wychodzącej, np. smtp.zenbox.pl."),
  smtpPort: portField("mail.smtp_port", "Port SMTP", "465 dla połączenia SSL, 587 dla STARTTLS."),
  smtpSecure: booleanField(
    "mail.smtp_secure",
    "Szyfrowanie SSL",
    "Włączone = SSL od razu (port 465). Wyłączone = STARTTLS (port 587)."
  ),
  smtpUser: stringField("mail.smtp_user", "Login SMTP", "Zwykle pełny adres e-mail skrzynki."),
  smtpPassword: passwordField(
    "mail.smtp_password",
    "Hasło SMTP",
    "Zapisane w bazie; nigdy nie wraca do przeglądarki. Puste pole przy zapisie = bez zmian."
  ),
  fromName: stringField("mail.from_name", "Nazwa nadawcy", "Widoczna w skrzynce odbiorcy przed adresem.", 120),
  fromAddress: emailField(
    "mail.from_address",
    "Adres nadawcy",
    "Adres w nagłówku From. Pusty = używany jest login SMTP."
  ),
  replyTo: emailField(
    "mail.reply_to",
    "Adres do odpowiedzi",
    "Reply-To. Pusty = odpowiedzi trafiają na adres nadawcy."
  ),
  orderInternalTo: emailListField(
    "mail.order_internal_to",
    "Adresaci maila wewnętrznego (zlecenia)",
    "Skrzynki zespołu dostające komplet danych zlecenia. Kilka adresów rozdziel przecinkiem.",
    "ORDER_INTERNAL_MAIL_TO"
  ),
  orderClientBcc: emailListField(
    "mail.order_client_bcc",
    "Ukryta kopia maili do klienta",
    "BCC dodawane do potwierdzeń wysyłanych klientom — np. archiwum biura."
  ),
  sendEnabled: booleanField(
    "mail.send_enabled",
    "Wysyłka maili",
    "Główny wyłącznik. Wyłączona = aplikacja tylko pokazuje podgląd, nic nie wychodzi."
  ),
};

export const MAIL_FIELD_NAMES = Object.keys(MAIL_FIELDS) as MailSettingField[];

/** Pola, których wartość nigdy nie opuszcza backendu. */
export const MAIL_SECRET_FIELDS: readonly MailSettingField[] = MAIL_FIELD_NAMES.filter(
  (n) => MAIL_FIELDS[n].secret === true
);

/** Wartość efektywna jednego pola + źródło (DB → env → domyślna). */
export function resolveMailField<K extends MailSettingField>(
  name: K
): { value: MailSettingsValues[K]; source: Source } {
  const def = MAIL_FIELDS[name] as MailFieldDef<MailSettingsValues[K]>;
  const fromDb = getSetting(def.dbKey);
  if (fromDb !== null) {
    const v = def.parse(fromDb);
    if (v !== undefined) return { value: v, source: "db" };
  }
  if (def.envKey) {
    const raw = (process.env[def.envKey] || "").trim();
    if (raw) {
      const v = def.parse(raw);
      if (v !== undefined) return { value: v, source: "env" };
    }
  }
  return { value: MAIL_DEFAULTS[name], source: "default" };
}

export interface MailConfig {
  values: MailSettingsValues;
  sources: Record<MailSettingField, Source>;
}

/** Wszystkie ustawienia poczty (tanie zapytania po PK — wołane przy każdej wysyłce). */
export function getMailConfig(): MailConfig {
  const values = {} as MailSettingsValues;
  const sources = {} as Record<MailSettingField, Source>;
  for (const name of MAIL_FIELD_NAMES) {
    const r = resolveMailField(name);
    (values as unknown as Record<string, unknown>)[name] = r.value;
    sources[name] = r.source;
  }
  return { values, sources };
}

// ---------------------------------------------------------------------------
// Gotowość do wysyłki
// ---------------------------------------------------------------------------

/** Adres w nagłówku From: jawny adres nadawcy, a gdy go nie ma — login SMTP. */
export function senderAddress(values: Pick<MailSettingsValues, "fromAddress" | "smtpUser">): string {
  return (values.fromAddress || "").trim() || (values.smtpUser || "").trim();
}

/** Nagłówek From w postaci „"Alfa Group" <biuro@example.com>”. */
export function fromHeader(values: Pick<MailSettingsValues, "fromName" | "fromAddress" | "smtpUser">): string {
  const address = senderAddress(values);
  const name = (values.fromName || "").trim();
  if (!address) return "";
  // Cudzysłowy dookoła nazwy: bez nich przecinek albo dwukropek w nazwie firmy
  // rozjeżdża nagłówek (nazwa staje się drugim adresatem).
  return name ? `"${name.replace(/"/g, "'")}" <${address}>` : address;
}

export interface MailReadiness {
  ready: boolean;
  reason?: string;
}

/**
 * Czy aplikacja może w tej chwili cokolwiek wysłać. Kolejność sprawdzeń jest
 * kolejnością, w jakiej człowiek wypełnia panel — pierwszy brak jest tym,
 * który ma zobaczyć, a nie listą wszystkich naraz.
 */
export function isMailSendingReady(
  cfg: MailSettingsValues | { values: MailSettingsValues }
): MailReadiness {
  const values = "values" in cfg ? cfg.values : cfg;

  if (!values.sendEnabled) {
    return { ready: false, reason: "Wysyłka maili jest wyłączona w ustawieniach poczty" };
  }
  if (!(values.smtpHost || "").trim()) {
    return { ready: false, reason: "Nie ustawiono serwera SMTP" };
  }
  if (!Number.isInteger(values.smtpPort) || values.smtpPort < 1 || values.smtpPort > 65535) {
    return { ready: false, reason: "Nieprawidłowy port SMTP" };
  }
  if (!(values.smtpUser || "").trim()) {
    return { ready: false, reason: "Nie ustawiono loginu SMTP" };
  }
  if (!(values.smtpPassword || "").trim()) {
    return { ready: false, reason: "Nie ustawiono hasła SMTP" };
  }
  const from = senderAddress(values);
  if (!from) {
    return { ready: false, reason: "Nie ustawiono adresu nadawcy" };
  }
  if (!isEmail(from)) {
    return { ready: false, reason: `Adres nadawcy „${from}” nie jest poprawnym adresem e-mail` };
  }
  return { ready: true };
}

/** Słowniki i opis pól dla panelu admina (meta w GET /admin/mail/settings). */
export function mailSettingsMeta() {
  return {
    fields: MAIL_FIELD_NAMES.map((name) => {
      const def = MAIL_FIELDS[name];
      return {
        name,
        label: def.label,
        type: def.type,
        help: def.help,
        secret: def.secret === true,
        envKey: def.envKey ?? null,
      };
    }),
    fieldTypes: Object.fromEntries(MAIL_FIELD_NAMES.map((n) => [n, MAIL_FIELDS[n].type])) as Record<
      MailSettingField,
      MailFieldType
    >,
    fieldLabels: Object.fromEntries(MAIL_FIELD_NAMES.map((n) => [n, MAIL_FIELDS[n].label])) as Record<
      MailSettingField,
      string
    >,
    secretFields: [...MAIL_SECRET_FIELDS],
    portHints: [
      { value: 465, label: "465 — SSL" },
      { value: 587, label: "587 — STARTTLS" },
    ],
  };
}
