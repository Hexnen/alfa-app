/**
 * Wysyłka poczty systemowej (maile ze zleceń, wiadomość testowa z panelu admina).
 *
 * Jedno wejście: `sendMail`. Konfigurację bierze z app_settings przez
 * src/lib/mail-config.ts (bez restartu backendu), a KAŻDĄ próbę — także tę, która
 * nie doszła nawet do połączenia — zapisuje w `mail_log`. Dzięki temu „czy klient
 * dostał potwierdzenie” odpowiada baza, a nie logi procesu.
 *
 * Wzorzec transportu (timeouty, klasyfikacja błędów) przeniesiony z
 * src/services/cma-mail.ts. CELOWO NIE reużywamy tamtego modułu: on jest napisany
 * wokół `cma_mail_settings` i pollera skrzynki CMA, a poczta systemowa ma własną
 * konfigurację z panelu admina. Wspólne jest tylko nodemailer i sposób opisywania
 * błędów po polsku.
 */
import nodemailer from "nodemailer";
import { db, schema } from "../db/index.js";
import type { MailLogEntry } from "../db/schema.js";
import { userLabelOf, type ActivityUser } from "../lib/activity-log.js";
import {
  fromHeader,
  getMailConfig,
  isMailSendingReady,
  normalizeAddresses,
  senderAddress,
  type MailSettingsValues,
} from "../lib/mail-config.js";

/** Nodemailer bywa hojny w zwlekaniu — te limity są przepisane z modułu CMA. */
const CONNECTION_TIMEOUT_MS = 20000;
const GREETING_TIMEOUT_MS = 20000;

/** Błąd SMTP → jedno zdanie po polsku (z technicznym szczegółem w nawiasie). */
export function describeSmtpError(error: unknown): string {
  const err = error as {
    message?: string;
    code?: string;
    hostname?: string;
    responseCode?: number;
    response?: string;
  };

  if (err?.code === "EAUTH" || err?.responseCode === 535) {
    const detail = err.response || err.message;
    return `Błąd logowania SMTP: nieprawidłowy login lub hasło${detail ? ` (${detail})` : ""}.`;
  }
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") {
    return `Błąd połączenia SMTP: nie znaleziono serwera${err.hostname ? ` „${err.hostname}”` : ""} (DNS).`;
  }
  if (err?.code === "ECONNREFUSED") {
    return "Błąd połączenia SMTP: serwer odrzucił połączenie.";
  }
  if (
    err?.code === "ETIMEDOUT" ||
    err?.code === "ESOCKET" ||
    /timed?\s?out|timeout/i.test(err?.message ?? "")
  ) {
    return "Błąd połączenia SMTP: przekroczono limit czasu połączenia.";
  }
  const detail = err?.response || err?.message || String(error);
  return `Błąd SMTP: ${detail}`;
}

/** Transport z ustawień poczty (app_settings). */
export function createMailTransport(values: MailSettingsValues) {
  return nodemailer.createTransport({
    host: values.smtpHost,
    port: values.smtpPort,
    secure: values.smtpSecure,
    auth: { user: values.smtpUser, pass: values.smtpPassword },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
  });
}

export interface SendMailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
  /** Encja, której dotyczy mail — dziś "order". */
  entityType: string;
  entityId: number;
  /** "client" | "internal" | "test" */
  variant?: string | null;
  user?: ActivityUser;
  /**
   * Sprawdzić połączenie (`transporter.verify()`) przed wysyłką. Używa tego wyłącznie
   * wiadomość testowa z panelu admina: tam chcemy odróżnić „serwer nie odpowiada”
   * od „serwer przyjął połączenie, ale odrzucił adresata”. Przy zwykłej wysyłce
   * to zbędna druga runda po sieci.
   */
  verify?: boolean;
}

export type SendMailResult =
  | { ok: true; logEntry: MailLogEntry }
  | { ok: false; error: string; logEntry: MailLogEntry };

/** Lista adresów → tekst do kolumny logu (pusta lista = NULL, nie pusty string). */
function joinAddresses(list: string[]): string | null {
  return list.length ? list.join(", ") : null;
}

function writeLog(entry: {
  entityType: string;
  entityId: number;
  variant: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  status: "sent" | "failed";
  error: string | null;
  messageId: string | null;
  user: ActivityUser;
}): MailLogEntry {
  const row = db
    .insert(schema.mailLog)
    .values({
      entityType: entry.entityType,
      entityId: entry.entityId,
      variant: entry.variant,
      toAddr: joinAddresses(entry.to) ?? "",
      ccAddr: joinAddresses(entry.cc),
      bccAddr: joinAddresses(entry.bcc),
      subject: entry.subject,
      status: entry.status,
      error: entry.error,
      messageId: entry.messageId,
      userId: entry.user?.id ?? null,
      userLabel: userLabelOf(entry.user),
    })
    .returning()
    .get();
  return row;
}

/**
 * Wysyła jedną wiadomość i ZAWSZE zostawia ślad w `mail_log`.
 *
 * Kolejność: gotowość konfiguracji → adresaci → połączenie. Brak konfiguracji nie
 * powoduje próby połączenia — zapisuje się jako `failed` z powodem po polsku, żeby
 * w historii zlecenia było widać, że ktoś kliknął „Wyślij”, a system był wyłączony.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const to = normalizeAddresses(input.to);
  const cc = normalizeAddresses(input.cc ?? []);
  const bcc = normalizeAddresses(input.bcc ?? []);
  const variant = input.variant ?? null;
  const subject = input.subject || "(bez tematu)";

  const fail = (error: string): SendMailResult => ({
    ok: false,
    error,
    logEntry: writeLog({
      entityType: input.entityType,
      entityId: input.entityId,
      variant,
      to,
      cc,
      bcc,
      subject,
      status: "failed",
      error,
      messageId: null,
      user: input.user,
    }),
  });

  const { values } = getMailConfig();

  const readiness = isMailSendingReady(values);
  if (!readiness.ready) {
    return fail(readiness.reason ?? "Wysyłka maili nie jest skonfigurowana");
  }
  if (!to.length) {
    return fail("Brak adresata wiadomości");
  }

  const transporter = createMailTransport(values);
  try {
    if (input.verify) await transporter.verify();
    const info = await transporter.sendMail({
      from: fromHeader(values),
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      replyTo: values.replyTo.trim() || undefined,
      subject,
      text: input.text,
      html: input.html,
    });

    return {
      ok: true,
      logEntry: writeLog({
        entityType: input.entityType,
        entityId: input.entityId,
        variant,
        to,
        cc,
        bcc,
        subject,
        status: "sent",
        error: null,
        messageId: info.messageId ?? null,
        user: input.user,
      }),
    };
  } catch (error) {
    return fail(describeSmtpError(error));
  } finally {
    transporter.close();
  }
}

// ---------------------------------------------------------------------------
// Wiadomość testowa (panel admina)
// ---------------------------------------------------------------------------

/** Prosty, „email-safe” HTML wiadomości testowej (tabela + style inline, jak w order-mail.ts). */
export function buildTestMail(values: MailSettingsValues): { subject: string; html: string; text: string } {
  const sender = senderAddress(values);
  const subject = "Wiadomość testowa — Alfa Group";
  const text = [
    "To jest wiadomość testowa z systemu Alfa Group.",
    "Jeśli ją widzisz, konfiguracja SMTP działa poprawnie.",
    "",
    `Serwer: ${values.smtpHost}:${values.smtpPort}${values.smtpSecure ? " (SSL)" : " (STARTTLS)"}`,
    `Nadawca: ${sender}`,
  ].join("\n");

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:#ffffff;border:1px solid #e3e5e8;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
      <tr><td style="padding:24px 28px 8px 28px;font-size:18px;font-weight:bold;">Wiadomość testowa</td></tr>
      <tr><td style="padding:0 28px 16px 28px;font-size:14px;line-height:20px;">
        To jest wiadomość testowa z systemu <strong>Alfa Group</strong>.<br>
        Jeśli ją widzisz, konfiguracja SMTP działa poprawnie.
      </td></tr>
      <tr><td style="padding:0 28px 24px 28px;font-size:13px;line-height:20px;color:#52606d;">
        Serwer: ${values.smtpHost}:${values.smtpPort}${values.smtpSecure ? " (SSL)" : " (STARTTLS)"}<br>
        Nadawca: ${sender}
      </td></tr>
    </table>
  </td></tr>
</table>`;

  return { subject, html, text };
}
