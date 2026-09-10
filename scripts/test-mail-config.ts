/**
 * Test konfiguracji poczty systemowej (src/lib/mail-config.ts) i dziennika wysyłek.
 *
 *   ALFA_DB_PATH=/ścieżka/do/kopii.db npx tsx scripts/test-mail-config.ts
 *
 * NIE DOTYKA PRAWDZIWEJ BAZY: bez `ALFA_DB_PATH` (albo gdy wskazuje na ./data/alfa.db)
 * skrypt odmawia startu. Zapisuje ustawienia `mail.*` i wiersze `mail_log`, więc
 * uruchamianie go na produkcji przestawiłoby konto SMTP firmy.
 *
 * Sprawdza: parseAddressList/isEmail/normalizeAddresses, precedencję DB → env → domyślne,
 * isMailSendingReady (każdy powód po kolei), nagłówek From, zapis próby wysyłki
 * do mail_log przy wyłączonej wysyłce (sendMail nie łączy się z siecią) i budowę
 * wiadomości testowej. Sprząta po sobie (usuwa klucze mail.* i swoje wiersze mail_log).
 */
import { resolve } from "path";

const dbPath = process.env.ALFA_DB_PATH ?? "";
if (!dbPath || resolve(dbPath) === resolve("./data/alfa.db")) {
  console.error(
    "Ustaw ALFA_DB_PATH na KOPIĘ bazy (nie ./data/alfa.db) — ten test zapisuje ustawienia poczty."
  );
  process.exit(1);
}

const { db, schema } = await import("../src/db/index.js");
const { eq, like, inArray } = await import("drizzle-orm");
const {
  MAIL_DEFAULTS,
  MAIL_FIELDS,
  fromHeader,
  getMailConfig,
  invalidAddresses,
  isEmail,
  isMailSendingReady,
  mailSettingsMeta,
  normalizeAddresses,
  parseAddressList,
  senderAddress,
} = await import("../src/lib/mail-config.js");
const { deleteSetting, setSetting } = await import("../src/lib/settings.js");
const { buildTestMail, sendMail } = await import("../src/services/mail-sender.js");

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const MAIL_KEYS = Object.values(MAIL_FIELDS).map((f) => f.dbKey);
const createdLogIds: number[] = [];

/** Stan sprzed testu — odtwarzany w `finally`. */
const backup = db
  .select()
  .from(schema.appSettings)
  .where(like(schema.appSettings.key, "mail.%"))
  .all();

function clearMailSettings() {
  for (const key of MAIL_KEYS) deleteSetting(key);
}

function set(key: keyof typeof MAIL_FIELDS, value: string) {
  setSetting(MAIL_FIELDS[key].dbKey, value, null);
}

try {
  // --- 1. parseAddressList / isEmail / normalizeAddresses ------------------
  console.log("\n== Adresy ==");
  ok("isEmail: poprawny", isEmail("jan.kowalski@alfa-group.pl"));
  ok("isEmail: bez domeny", !isEmail("jan@"), "jan@");
  ok("isEmail: ze spacją", !isEmail("jan kowalski@x.pl"));
  ok("isEmail: bez kropki w domenie", !isEmail("jan@localhost"));
  ok("isEmail: nie-string", !isEmail(42 as unknown as string));

  ok(
    "parseAddressList: przecinki, średniki, spacje",
    JSON.stringify(parseAddressList("a@x.pl, b@y.pl; c@z.pl  d@w.pl")) ===
      JSON.stringify(["a@x.pl", "b@y.pl", "c@z.pl", "d@w.pl"]),
    parseAddressList("a@x.pl, b@y.pl; c@z.pl  d@w.pl")
  );
  ok(
    "parseAddressList: deduplikacja bez względu na wielkość liter",
    JSON.stringify(parseAddressList("a@x.pl, A@X.PL")) === JSON.stringify(["a@x.pl"]),
    parseAddressList("a@x.pl, A@X.PL")
  );
  ok("parseAddressList: pusty tekst", parseAddressList("   ").length === 0);
  ok("parseAddressList: pomija śmieci", JSON.stringify(parseAddressList("a@x.pl, nonsens")) === JSON.stringify(["a@x.pl"]));
  ok(
    "invalidAddresses: wskazuje złe wpisy",
    JSON.stringify(invalidAddresses("a@x.pl, nonsens, b@")) === JSON.stringify(["nonsens", "b@"]),
    invalidAddresses("a@x.pl, nonsens, b@")
  );
  ok(
    "normalizeAddresses: trim + dedup",
    JSON.stringify(normalizeAddresses([" a@x.pl ", "A@X.PL", "", 5])) === JSON.stringify(["a@x.pl"]),
    normalizeAddresses([" a@x.pl ", "A@X.PL", "", 5])
  );

  // --- 2. Precedencja DB → env → domyślne ---------------------------------
  console.log("\n== Precedencja ==");
  clearMailSettings();
  delete process.env.ORDER_INTERNAL_MAIL_TO;

  let cfg = getMailConfig();
  ok("domyślny host", cfg.values.smtpHost === MAIL_DEFAULTS.smtpHost && cfg.sources.smtpHost === "default", cfg.values.smtpHost);
  ok("domyślny port 465", cfg.values.smtpPort === 465);
  ok("wysyłka domyślnie wyłączona", cfg.values.sendEnabled === false);
  ok("orderInternalTo domyślnie puste", cfg.values.orderInternalTo === "" && cfg.sources.orderInternalTo === "default");

  process.env.ORDER_INTERNAL_MAIL_TO = "zespol@alfa-group.pl";
  cfg = getMailConfig();
  ok(
    "orderInternalTo z env",
    cfg.values.orderInternalTo === "zespol@alfa-group.pl" && cfg.sources.orderInternalTo === "env",
    { v: cfg.values.orderInternalTo, s: cfg.sources.orderInternalTo }
  );

  set("orderInternalTo", "dyspozytor@alfa-group.pl");
  cfg = getMailConfig();
  ok(
    "DB wygrywa z env",
    cfg.values.orderInternalTo === "dyspozytor@alfa-group.pl" && cfg.sources.orderInternalTo === "db",
    cfg.values.orderInternalTo
  );
  delete process.env.ORDER_INTERNAL_MAIL_TO;

  setSetting(MAIL_FIELDS.smtpPort.dbKey, "nie-liczba", null);
  ok("uszkodzony wpis → wartość domyślna", getMailConfig().values.smtpPort === 465 && getMailConfig().sources.smtpPort === "default");
  deleteSetting(MAIL_FIELDS.smtpPort.dbKey);

  // --- 3. isMailSendingReady ---------------------------------------------
  console.log("\n== Gotowość do wysyłki ==");
  clearMailSettings();
  const reason = (over: Partial<typeof MAIL_DEFAULTS>) =>
    isMailSendingReady({ ...MAIL_DEFAULTS, ...over });

  ok("wyłączona wysyłka", reason({}).ready === false && /wyłączona/i.test(reason({}).reason ?? ""), reason({}));
  ok(
    "brak hosta",
    /serwera SMTP/i.test(reason({ sendEnabled: true, smtpHost: "" }).reason ?? ""),
    reason({ sendEnabled: true, smtpHost: "" })
  );
  ok(
    "zły port",
    /port/i.test(reason({ sendEnabled: true, smtpPort: 0 }).reason ?? ""),
    reason({ sendEnabled: true, smtpPort: 0 })
  );
  ok(
    "brak loginu",
    /loginu/i.test(reason({ sendEnabled: true }).reason ?? ""),
    reason({ sendEnabled: true })
  );
  ok(
    "brak hasła",
    /hasła/i.test(reason({ sendEnabled: true, smtpUser: "biuro@alfa-group.pl" }).reason ?? ""),
    reason({ sendEnabled: true, smtpUser: "biuro@alfa-group.pl" })
  );
  ok(
    "brak nadawcy (login nie jest adresem)",
    /nadawcy/i.test(reason({ sendEnabled: true, smtpUser: "biuro", smtpPassword: "x" }).reason ?? ""),
    reason({ sendEnabled: true, smtpUser: "biuro", smtpPassword: "x" })
  );
  const good = { sendEnabled: true, smtpUser: "biuro@alfa-group.pl", smtpPassword: "tajne" };
  ok("komplet danych → ready", reason(good).ready === true && reason(good).reason === undefined, reason(good));
  ok(
    "przyjmuje też { values }",
    isMailSendingReady({ values: { ...MAIL_DEFAULTS, ...good } }).ready === true
  );

  ok("senderAddress: fallback na login", senderAddress({ fromAddress: "", smtpUser: "biuro@x.pl" }) === "biuro@x.pl");
  ok(
    "senderAddress: fromAddress wygrywa",
    senderAddress({ fromAddress: "kontakt@x.pl", smtpUser: "biuro@x.pl" }) === "kontakt@x.pl"
  );
  ok(
    "fromHeader z nazwą",
    fromHeader({ fromName: "Alfa Group", fromAddress: "biuro@x.pl", smtpUser: "" }) === '"Alfa Group" <biuro@x.pl>',
    fromHeader({ fromName: "Alfa Group", fromAddress: "biuro@x.pl", smtpUser: "" })
  );
  ok(
    "fromHeader bez nazwy",
    fromHeader({ fromName: "", fromAddress: "biuro@x.pl", smtpUser: "" }) === "biuro@x.pl"
  );
  ok("fromHeader bez adresu", fromHeader({ fromName: "Alfa", fromAddress: "", smtpUser: "" }) === "");

  // --- 4. Walidacja pól (ta sama, której używa PUT /settings) --------------
  console.log("\n== Walidacja pól ==");
  ok("port 0 odrzucony", MAIL_FIELDS.smtpPort.validate(0) !== null);
  ok("port 70000 odrzucony", MAIL_FIELDS.smtpPort.validate(70000) !== null);
  ok("port 587 OK", MAIL_FIELDS.smtpPort.validate(587) === null);
  ok("fromAddress: śmieci odrzucone", MAIL_FIELDS.fromAddress.validate("nonsens") !== null);
  ok("fromAddress: pusty OK", MAIL_FIELDS.fromAddress.validate("") === null);
  ok("orderInternalTo: zła lista odrzucona", MAIL_FIELDS.orderInternalTo.validate("a@x.pl, ???") !== null);
  ok("orderInternalTo: dobra lista OK", MAIL_FIELDS.orderInternalTo.validate("a@x.pl; b@y.pl") === null);
  ok("hasło formatuje się bez wartości", MAIL_FIELDS.smtpPassword.format("tajne") === "(ustawione)");
  ok(
    "meta: hasło oznaczone jako sekret",
    mailSettingsMeta().fields.find((f) => f.name === "smtpPassword")?.secret === true
  );
  ok("meta: wszystkie pola opisane", mailSettingsMeta().fields.length === Object.keys(MAIL_DEFAULTS).length);

  // --- 5. sendMail przy wyłączonej wysyłce → wiersz failed -----------------
  console.log("\n== Dziennik wysyłek ==");
  clearMailSettings();
  const res = await sendMail({
    to: ["klient@example.com"],
    cc: ["kopia@example.com"],
    subject: "Test",
    html: "<p>x</p>",
    text: "x",
    entityType: "order",
    entityId: 999999,
    variant: "client",
    user: null,
  });
  createdLogIds.push(res.logEntry.id);
  ok("wyłączona wysyłka → ok:false", res.ok === false, res);
  ok("powód po polsku", res.ok === false && /wyłączona/i.test(res.error), res);
  ok("wiersz zapisany jako failed", res.logEntry.status === "failed", res.logEntry);
  ok("adresaci w logu", res.logEntry.toAddr === "klient@example.com" && res.logEntry.ccAddr === "kopia@example.com", res.logEntry);
  ok("bcc puste = NULL", res.logEntry.bccAddr === null);
  ok("wariant zapisany", res.logEntry.variant === "client");
  ok("brak messageId", res.logEntry.messageId === null);

  // Skonfigurowana poczta, ale bez adresata — też ma zostawić ślad.
  set("sendEnabled", "1");
  set("smtpUser", "biuro@alfa-group.pl");
  set("smtpPassword", "tajne");
  const noRecipient = await sendMail({
    to: [],
    subject: "Test",
    html: "<p>x</p>",
    text: "x",
    entityType: "order",
    entityId: 999999,
    user: null,
  });
  createdLogIds.push(noRecipient.logEntry.id);
  ok("brak adresata → ok:false", noRecipient.ok === false && /adresata/i.test(noRecipient.error), noRecipient);
  ok("brak adresata → wiersz failed", noRecipient.logEntry.status === "failed");

  const stored = db
    .select()
    .from(schema.mailLog)
    .where(eq(schema.mailLog.entityId, 999999))
    .all();
  ok("oba wiersze w mail_log", stored.length === 2, stored.length);

  // --- 6. Wiadomość testowa ----------------------------------------------
  console.log("\n== Wiadomość testowa ==");
  const testMail = buildTestMail(getMailConfig().values);
  ok("temat", testMail.subject === "Wiadomość testowa — Alfa Group", testMail.subject);
  ok("HTML zawiera adres nadawcy", testMail.html.includes("biuro@alfa-group.pl"));
  ok("HTML bez zewnętrznego CSS", !/<link|@import/i.test(testMail.html));
  ok("wersja tekstowa niepusta", testMail.text.length > 20);
} finally {
  // --- Sprzątanie ---------------------------------------------------------
  clearMailSettings();
  for (const row of backup) setSetting(row.key, row.value, row.updatedBy);
  if (createdLogIds.length) {
    db.delete(schema.mailLog).where(inArray(schema.mailLog.id, createdLogIds)).run();
  }
  db.delete(schema.mailLog).where(eq(schema.mailLog.entityId, 999999)).run();
  console.log("\nPosprzątano: ustawienia mail.* przywrócone, testowe wiersze mail_log usunięte.");
}

console.log(failures === 0 ? "\nWSZYSTKO OK" : `\nBŁĘDÓW: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
