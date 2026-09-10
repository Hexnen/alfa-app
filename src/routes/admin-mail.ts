/**
 * Panel admina — Poczta (/api/admin/mail/*): konto SMTP, nadawca, adresaci maili
 * ze zleceń, wiadomość testowa i dziennik wysyłek.
 *
 * Ustawienia żyją w app_settings (klucze `mail.*`, opis pól: src/lib/mail-config.ts),
 * precedencja DB → env → domyślne; czytane przy każdej wysyłce — bez restartu backendu.
 * Kształt odpowiedzi 1:1 z /api/admin/company/settings: { values, sources, defaults, meta },
 * z jedną różnicą: `values.smtpPassword` NIGDY nie wraca do frontu — zamiast niego
 * jest `values.hasPassword`.
 */
import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { requireAdmin, getUser } from "../middleware/auth.js";
import { logActivity } from "../lib/activity-log.js";
import { deleteSetting, getSetting, setSetting } from "../lib/settings.js";
import {
  MAIL_DEFAULTS,
  MAIL_FIELDS,
  MAIL_FIELD_NAMES,
  getMailConfig,
  isEmail,
  isMailSendingReady,
  mailSettingsMeta,
  senderAddress,
  type MailFieldDef,
  type MailSettingField,
  type MailSettingsValues,
} from "../lib/mail-config.js";
import { buildTestMail, sendMail } from "../services/mail-sender.js";

const app = new Hono();
app.use("*", requireAdmin);

// ---------------------------------------------------------------------------
// Ustawienia
// ---------------------------------------------------------------------------

/** Wartości bez sekretu: `smtpPassword` wychodzi z odpowiedzi, wchodzi `hasPassword`. */
export type SafeMailValues = Omit<MailSettingsValues, "smtpPassword"> & { hasPassword: boolean };

function safeValues(values: MailSettingsValues): SafeMailValues {
  const { smtpPassword, ...rest } = values;
  return { ...rest, hasPassword: smtpPassword.trim().length > 0 };
}

function settingsPayload() {
  const cfg = getMailConfig();
  const { smtpPassword: _pwdDefault, ...defaults } = MAIL_DEFAULTS;
  return {
    values: safeValues(cfg.values),
    sources: cfg.sources,
    defaults,
    meta: mailSettingsMeta(),
    // Gotowość liczona z pełnej konfiguracji (z hasłem) — front pokazuje ją
    // przy przełączniku wysyłki, żeby nie trzeba było zgadywać, czego brakuje.
    sending: isMailSendingReady(cfg.values),
  };
}

app.get("/settings", (c) => c.json({ success: true, data: settingsPayload() }));

type Op = {
  dbKey: string;
  /** null = usunięcie wpisu (powrót do wartości domyślnej / z env). */
  value: string | null;
  summary: string;
  /** Sekret nigdy nie trafia do activity_log — old/new zostają NULL. */
  secret: boolean;
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
};

function toLogValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

app.put("/settings", async (c) => {
  const user = getUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ success: false, error: "Nieprawidłowe body" }, 400);
  }

  const errors: string[] = [];
  const ops: Op[] = [];
  const before = getMailConfig();

  for (const name of MAIL_FIELD_NAMES) {
    if (!(name in body)) continue;
    const raw = body[name];
    const def = MAIL_FIELDS[name] as MailFieldDef<MailSettingsValues[MailSettingField]>;
    const prev = before.values[name];
    const secret = def.secret === true;

    // null = „przywróć domyślne” (dla hasła: skasuj je z bazy — jedyny sposób,
    // bo pusty string znaczy „zostaw stare”).
    if (raw === null) {
      if (getSetting(def.dbKey) !== null) {
        ops.push({
          dbKey: def.dbKey,
          value: null,
          summary: `Przywrócono domyślne ustawienie poczty „${def.label}”${
            secret ? "" : ` (było: ${def.format(prev)})`
          }`,
          secret,
          oldValue: secret ? null : toLogValue(prev),
          newValue: null,
        });
      }
      continue;
    }

    // Puste hasło = „bez zmian”. Inaczej każde otwarcie panelu z pustym polem
    // kasowałoby działającą konfigurację SMTP (ten sam kontrakt ma CMA).
    if (secret && typeof raw === "string" && raw.trim() === "") continue;

    const val: unknown = def.coerce ? def.coerce(raw) : raw;
    const err = def.validate(val);
    if (err) {
      errors.push(err);
      continue;
    }
    const next = val as MailSettingsValues[MailSettingField];
    const serialized = def.serialize(next);
    // Ta sama wartość efektywna = nic do zapisania (bez pustych wpisów w activity_log).
    if (def.serialize(prev) === serialized) continue;
    ops.push({
      dbKey: def.dbKey,
      value: serialized,
      summary: secret
        ? `Zmieniono ustawienie poczty „${def.label}”`
        : `Zmieniono ustawienie poczty „${def.label}”: ${def.format(prev)} → ${def.format(next)}`,
      secret,
      oldValue: secret ? null : toLogValue(prev),
      newValue: secret ? null : toLogValue(next),
    });
  }

  if (errors.length) return c.json({ success: false, error: errors.join("; ") }, 400);

  db.transaction((tx) => {
    for (const op of ops) {
      if (op.value === null) deleteSetting(op.dbKey, tx);
      else setSetting(op.dbKey, op.value, user.id, tx);
      logActivity(tx, {
        entityType: "app_settings",
        entityId: 0,
        user,
        action: "updated",
        field: op.dbKey,
        oldValue: op.oldValue,
        newValue: op.newValue,
        summary: op.summary,
      });
    }
  });

  return c.json({ success: true, data: settingsPayload() });
});

// ---------------------------------------------------------------------------
// Przeniesienie danych logowania z konfiguracji CMA
// ---------------------------------------------------------------------------

/**
 * POST /import-cma — kopiuje konto SMTP ze skrzynki CMA (`cma_mail_settings`, id=1)
 * do ustawień poczty systemowej. Jednorazowa wygoda przy wdrożeniu: obie konfiguracje
 * zwykle wskazują tę samą skrzynkę, ale od tej chwili żyją niezależnie —
 * zmiana w CMA NIE przepisuje się tutaj po cichu.
 *
 * Adres e-mail z CMA ląduje w dwóch polach: jako login SMTP i jako adres nadawcy
 * (u dostawców pokroju Zenboxa to zawsze ta sama wartość). `sendEnabled` zostaje
 * nietknięte — włączenie wysyłki jest świadomą decyzją admina.
 */
app.post("/import-cma", async (c) => {
  const user = getUser(c);
  const cma = db
    .select()
    .from(schema.cmaMailSettings)
    .where(eq(schema.cmaMailSettings.id, 1))
    .get();

  if (!cma) {
    return c.json({ success: false, error: "Brak konfiguracji poczty CMA do skopiowania" }, 400);
  }

  const email = (cma.email || "").trim();
  const password = (cma.password || "").trim();
  if (!email && !password) {
    return c.json(
      { success: false, error: "Konfiguracja poczty CMA nie ma ustawionego adresu ani hasła" },
      400
    );
  }

  const patch: Partial<MailSettingsValues> = {
    smtpHost: cma.smtpHost,
    smtpPort: cma.smtpPort,
    smtpSecure: cma.smtpSecure,
  };
  if (email) {
    patch.smtpUser = email;
    patch.fromAddress = email;
  }
  if (password) patch.smtpPassword = password;

  const before = getMailConfig();
  const changed: string[] = [];

  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch) as [MailSettingField, unknown][]) {
      const def = MAIL_FIELDS[key] as MailFieldDef<MailSettingsValues[MailSettingField]>;
      const next = value as MailSettingsValues[MailSettingField];
      const serialized = def.serialize(next);
      if (def.serialize(before.values[key]) === serialized) continue;
      setSetting(def.dbKey, serialized, user.id, tx);
      changed.push(def.label);
      const secret = def.secret === true;
      logActivity(tx, {
        entityType: "app_settings",
        entityId: 0,
        user,
        action: "updated",
        field: def.dbKey,
        oldValue: secret ? null : toLogValue(before.values[key]),
        newValue: secret ? null : toLogValue(next),
        summary: `Skopiowano z konfiguracji CMA ustawienie poczty „${def.label}”`,
      });
    }
  });

  return c.json({
    success: true,
    message: changed.length
      ? `Skopiowano z CMA: ${changed.join(", ")}.`
      : "Ustawienia poczty były już zgodne z konfiguracją CMA.",
    data: { ...settingsPayload(), imported: changed },
  });
});

// ---------------------------------------------------------------------------
// Wiadomość testowa
// ---------------------------------------------------------------------------

/**
 * POST /test-smtp { to? } — weryfikuje połączenie i wysyła wiadomość testową.
 * Bez `to` idzie na adres nadawcy (najbezpieczniejszy domyślny adresat: to skrzynka,
 * którą admin właśnie skonfigurował). Zapisuje się w mail_log jako wariant "test".
 */
app.post("/test-smtp", async (c) => {
  const user = getUser(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { values } = getMailConfig();

  const requested = typeof body.to === "string" ? body.to.trim() : "";
  const to = requested || senderAddress(values);
  if (!to) {
    return c.json(
      { success: false, error: "Podaj adresata wiadomości testowej (brak adresu nadawcy w ustawieniach)" },
      400
    );
  }
  if (!isEmail(to)) {
    return c.json({ success: false, error: `„${to}” nie jest poprawnym adresem e-mail` }, 400);
  }

  const mail = buildTestMail(values);
  const result = await sendMail({
    to: [to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    entityType: "admin_mail",
    entityId: 0,
    variant: "test",
    user,
    verify: true,
  });

  if (!result.ok) {
    return c.json({ success: false, error: result.error, data: result.logEntry }, 400);
  }
  return c.json({
    success: true,
    message: `Wysłano wiadomość testową do: ${to}.`,
    data: { messageId: result.logEntry.messageId, to, logEntry: result.logEntry },
  });
});

// ---------------------------------------------------------------------------
// Dziennik wysyłek
// ---------------------------------------------------------------------------

/** GET /log?limit=50&offset=0&entityType=order&entityId=12 → { items, total }. */
app.get("/log", (c) => {
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const offsetRaw = Number(c.req.query("offset") ?? 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

  const conds: SQL[] = [];
  const entityType = (c.req.query("entityType") ?? "").trim();
  if (entityType) conds.push(eq(schema.mailLog.entityType, entityType));
  const entityIdRaw = (c.req.query("entityId") ?? "").trim();
  if (entityIdRaw) {
    const entityId = Number(entityIdRaw);
    if (!Number.isInteger(entityId)) {
      return c.json({ success: false, error: "Parametr entityId musi być liczbą" }, 400);
    }
    conds.push(eq(schema.mailLog.entityId, entityId));
  }
  const where = conds.length ? and(...conds) : undefined;

  const items = db
    .select()
    .from(schema.mailLog)
    .where(where)
    .orderBy(desc(schema.mailLog.id))
    .limit(limit)
    .offset(offset)
    .all();

  const total =
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.mailLog)
      .where(where)
      .get()?.count ?? 0;

  return c.json({ success: true, data: { items, total } });
});

export default app;
