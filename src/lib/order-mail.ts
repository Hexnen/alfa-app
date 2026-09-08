/**
 * Maile zlecenia — jedno źródło prawdy dla podglądu na liście zleceń
 * (GET /api/orders/:id/mail-preview) i dla przyszłej wysyłki nodemailerem
 * (wzorzec: src/services/cma-mail.ts).
 *
 * Dwa warianty, dwie różne reguły treści:
 *   • `buildOrderConfirmationMail` — DO KLIENTA. Puste i nullowe pola PO PROSTU
 *     ZNIKAJĄ. Zlecenie bez dzierżawy nie może pokazać klientowi „Dzierżawa:
 *     null zł”, a zlecenie bez daty montażu — pustego wiersza „Start montażu:”.
 *   • `buildOrderInternalMail` — DO ZESPOŁU. Odwrotnie: pokazujemy KAŻDE pole
 *     zlecenia, a brak danych to widoczne „—”. Dla dyspozytora informacja
 *     „nie podano numeru oferty Vtools” jest tak samo ważna jak sam numer.
 *
 * Dlatego szablon żyje NA BACKENDZIE, a nie w kodzie frontu jak wydruk protokołu
 * (frontend/src/lib/protocolPrint.ts): mail wysyła serwer i musi wysłać dokładnie
 * to, co człowiek zobaczył w podglądzie. Front tylko renderuje gotowy HTML.
 *
 * HTML jest „email-safe”: tabele zamiast flex/grid, style inline, żadnego
 * zewnętrznego CSS ani webfontów, szerokość 640 px. Klienci pocztowi (Outlook,
 * Gmail) wycinają <style> z <head> i nie znają nowoczesnego layoutu.
 */
import type { orders } from "../db/schema.js";

type OrderRow = typeof orders.$inferSelect;

/**
 * Wiersz zlecenia. Wymagany jest wyłącznie numer (trafia do tematu) — reszta pól
 * jest opcjonalna, żeby ta sama funkcja obsłużyła zarówno pełny rekord z bazy,
 * jak i zlecenie sprzed migracji, w którym połowa kolumn jest pusta.
 */
export type OrderMailInput = Partial<OrderRow> & Pick<OrderRow, "orderNumber">;

export interface OrderMailOptions {
  /** Baza dla absolutnych URL-i (logo). Np. "https://app.example.com" — bez końcowego "/". */
  baseUrl?: string;
}

export interface OrderConfirmationMail {
  subject: string;
  html: string;
  text: string;
}

/** Wewnętrzny mail ma ten sam kształt co klienckie potwierdzenie. */
export type OrderInternalMail = OrderConfirmationMail;

// ---------------------------------------------------------------------------
// Brand i dane firmy (1:1 z nagłówkiem wydruku protokołu)
// ---------------------------------------------------------------------------

const NAVY = "#14447a";
const NAVY_DARK = "#0e3560";
const GREY = "#5a6673";
const INK = "#1c2733";
const LINE = "#d5dce4";
const PAPER = "#f2f5f9";

const COMPANY = {
  name: "ALFA GROUP Sp. z o.o.",
  address: "03-612 Warszawa, ul. Koniczynowa 2a",
  phones: "tel./fax +48 22 678 22 22 · tel. +48 504 155 222",
  email: "helpdesk@alfagroup.com.pl",
  www: "www.alfagroup.com.pl",
  legal:
    "Sąd Rejonowy dla m. st. Warszawy w Warszawie, XIII Wydział Gospodarczy Krajowego Rejestru Sądowego · " +
    "KRS 0000119104 · NIP 693-18-36-206 · REGON 390651040",
  licence: "Koncesja MSWiA Nr L-0264/05 z dnia 14 listopada 2007 roku",
} as const;

/**
 * Telefony do wplecenia w zdanie („zadzwoń pod…”). `COMPANY.phones` to wersja
 * do stopki — z „tel./fax”, kropką w środku i kropką rozdzielającą; wklejona
 * w zdanie czyta się jak literówka.
 */
const PHONES_INLINE = "+48 22 678 22 22 lub +48 504 155 222";

// ---------------------------------------------------------------------------
// Formatowanie
// ---------------------------------------------------------------------------

/** Escapowanie do treści HTML **i** do atrybutów (stąd cudzysłowy i apostrof). */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tekst, który ma sens do pokazania — inaczej `null` (wiersz wypada z maila). */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Data „YYYY-MM-DD” (albo ISO) → „1 marca 2026”. Śmieci → null, nigdy „Invalid Date”. */
function date(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const d = new Date(raw.length === 10 ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Kwota → „1 200,00 zł”. Nie-liczby → null.
 *
 * Separator tysięcy normalizujemy do ZWYKŁEJ spacji: `toLocaleString("pl-PL")`
 * wstawia w zależności od wersji ICU spację niełamliwą (U+00A0) albo wąską
 * (U+202F), a część klientów pocztowych renderuje ten drugi znak jako „?”.
 */
function money(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const formatted = value
    .toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/[\s\u00A0\u202F]/g, " ");
  return `${formatted} zł`;
}

/** Liczba sztuk (kamery, megafony). 0 też pokazujemy — to informacja, nie brak danych. */
function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** `true`/`false` → „Tak”/„Nie”; `null`/`undefined` → null (pytanie bez odpowiedzi). */
function yesNo(value: unknown): string | null {
  if (value === true || value === 1) return "Tak";
  if (value === false || value === 0) return "Nie";
  return null;
}

/** Kwota z okresem: „1 200,00 zł netto/mies. × 24 mies.”. */
function amountPerMonths(amount: unknown, months: unknown): string | null {
  const value = money(amount);
  if (!value) return null;
  const m = count(months);
  return m && m > 0 ? `${value} netto/mies. × ${m} mies.` : `${value} netto/mies.`;
}

/**
 * Znacznik czasu z bazy („2026-03-01 12:34:56” z `datetime('now')`) → „1.03.2026, 12:34”.
 *
 * Spację między datą a godziną zamieniamy na „T”: bez tego Node parsuje taki
 * string ścieżką „legacy”, a Safari/JSC odrzuca go w całości. Śmieci → null.
 */
function dateTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(raw) ? raw.replace(" ", "T") : raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pl-PL", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Status zlecenia → etykieta po polsku i kolor plakietki (jak w tabeli zleceń). */
const STATUS: Record<string, { label: string; color: string }> = {
  new: { label: "Nowe", color: "#2563eb" },
  in_progress: { label: "W realizacji", color: "#b45309" },
  completed: { label: "Zakończone", color: "#15803d" },
  cancelled: { label: "Anulowane", color: "#b91c1c" },
};

function statusOf(value: unknown): { label: string; color: string } {
  const key = text(value) ?? "";
  return STATUS[key] ?? { label: key || "—", color: GREY };
}

// ---------------------------------------------------------------------------
// Klocki HTML
// ---------------------------------------------------------------------------

type Row = { label: string; value: string | null; href?: string | null };

/** Znak braku danych w wariancie wewnętrznym (klient takich wierszy nie widzi wcale). */
const EMPTY = "—";

/**
 * Wiersz „etykieta : wartość” w karcie.
 *
 * @param showEmpty `false` (klient) — pusta wartość nie tworzy wiersza;
 *                  `true` (zespół) — pusta wartość to widoczne „—”.
 */
function rowHtml(row: Row, showEmpty = false): string {
  if (!row.value && !showEmpty) return "";
  const raw = row.value ?? EMPTY;
  // Link tylko przy realnej wartości: „—” nie może być klikalne.
  const value =
    row.href && row.value
      ? `<a href="${esc(row.href)}" style="color:${NAVY};text-decoration:underline;">${esc(raw)}</a>`
      : `<span style="color:${row.value ? INK : GREY};">${esc(raw)}</span>`;
  return `
              <tr>
                <td style="padding:6px 0;border-bottom:1px solid #edf1f5;color:${GREY};font-size:13px;width:42%;vertical-align:top;">${esc(row.label)}</td>
                <td style="padding:6px 0;border-bottom:1px solid #edf1f5;color:${INK};font-size:13px;font-weight:bold;vertical-align:top;">${value}</td>
              </tr>`;
}

/**
 * Karta z tytułem na granatowym pasku.
 *
 * @param showEmpty `false` — karta bez ani jednego wiersza w ogóle się nie renderuje;
 *                  `true` — karta jest zawsze (nawet gdy wszystkie pola puste).
 */
function cardHtml(title: string, rows: Row[], showEmpty = false): string {
  const body = rows.map((r) => rowHtml(r, showEmpty)).join("");
  if (!body) return "";
  return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};margin:0 0 16px;">
          <tr>
            <td style="background:${NAVY};color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:7px 14px;">${esc(title)}</td>
          </tr>
          <tr>
            <td style="padding:6px 14px 10px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${body}
              </table>
            </td>
          </tr>
        </table>`;
}

/** Karta z jednym blokiem tekstu (uwagi) — łamania linii zachowane jako <br>. */
function noteCardHtml(title: string, body: string | null, showEmpty = false): string {
  if (!body && !showEmpty) return "";
  const content = body
    ? esc(body).replace(/\r?\n/g, "<br>")
    : `<span style="color:${GREY};">${EMPTY}</span>`;
  return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};margin:0 0 16px;">
          <tr>
            <td style="background:${NAVY};color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:7px 14px;">${esc(title)}</td>
          </tr>
          <tr>
            <td style="padding:10px 14px;color:${INK};font-size:13px;line-height:1.6;">${content}</td>
          </tr>
        </table>`;
}

/** Karta z listą wypunktowaną (zakres usługi) — kropki jako znak, bez <ul>. */
function bulletCardHtml(title: string, items: string[]): string {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return "";
  const body = visible
    .map(
      (item) => `
              <tr>
                <td style="padding:5px 0;color:${NAVY};font-size:13px;width:16px;vertical-align:top;">&bull;</td>
                <td style="padding:5px 0;color:${INK};font-size:13px;vertical-align:top;">${esc(item)}</td>
              </tr>`
    )
    .join("");
  return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};margin:0 0 16px;">
          <tr>
            <td style="background:${NAVY};color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:7px 14px;">${esc(title)}</td>
          </tr>
          <tr>
            <td style="padding:6px 14px 10px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${body}
              </table>
            </td>
          </tr>
        </table>`;
}

/** Przycisk-link (CTA) w wersji tabelowej — <button> i border-radius Outlook ignoruje. */
function buttonHtml(label: string, href: string): string {
  return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px;">
          <tr>
            <td style="background:${NAVY};padding:11px 22px;">
              <a href="${esc(href)}" style="color:#ffffff;font-size:13px;font-weight:bold;text-decoration:none;display:inline-block;">${esc(label)} &rarr;</a>
            </td>
          </tr>
        </table>`;
}

/**
 * Szkielet wiadomości: granatowy nagłówek z logo, dowolna treść, stopka firmowa.
 * Wspólny dla obu wariantów — różnią się wyłącznie tym, co wstawiamy w `body`.
 *
 * @param logoUrl absolutny URL logo (klient pocztowy nie zna adresu aplikacji)
 * @param headerExtraHtml plakietki pod tytułem (numer zlecenia, status)
 * @param body gotowe wiersze `<tr>` między nagłówkiem a stopką
 */
function shellHtml(params: {
  subject: string;
  logoUrl: string;
  headerTitle: string;
  headerExtraHtml: string;
  /** Tekst podglądu na liście wiadomości (obok tematu) — ukryty w samej treści. */
  preheader: string;
  body: string;
  footerNote: string;
}): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(params.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<!-- Preheader: to, co Gmail/Outlook pokazuje na liście obok tematu. Musi być
     PIERWSZYM tekstem w <body>, inaczej klient weźmie „Dzień dobry…”. -->
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#ffffff;">${esc(params.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAPER};border-collapse:collapse;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="width:640px;max-width:640px;background:#ffffff;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:${INK};">

        <!-- Pasek nagłówka -->
        <tr>
          <td style="background:${NAVY};padding:20px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
              <tr>
                <!-- Białe kółko pod logo: znak jest granatowy, a pasek też —
                     bez podkładki logo znika. border-radius NA KOMÓRCE, bo
                     Outlook ignoruje zaokrąglenie na <img>.
                     width w stylu to 56px, nie 68: komórka liczy się w
                     content-box, więc padding 6px z każdej strony dopiero robi
                     z tego równe koło 68×68 — z 68px wychodziła elipsa 80×70. -->
                <td width="68" height="68" align="center" valign="middle" style="width:56px;height:56px;padding:6px;border-radius:50%;background:#ffffff;line-height:0;">
                  <img src="${esc(params.logoUrl)}" alt="Alfa Group" width="56" height="56" style="display:block;width:56px;height:56px;border:0;">
                </td>
                <td style="vertical-align:middle;padding-left:16px;color:#ffffff;">
                  <div style="font-size:19px;font-weight:bold;letter-spacing:0.3px;">${esc(params.headerTitle)}</div>
                  <div style="font-size:12px;color:#c8d7ea;padding-top:3px;">${esc(COMPANY.name)}</div>
                  ${params.headerExtraHtml}
                </td>
              </tr>
            </table>
          </td>
        </tr>
${params.body}
        <!-- Stopka -->
        <tr>
          <td style="background:${NAVY_DARK};padding:16px 24px;color:#c8d7ea;font-size:10px;line-height:1.7;">
            <strong style="color:#ffffff;">${esc(COMPANY.name)}</strong> · ${esc(COMPANY.address)}<br>
            ${esc(COMPANY.phones)} · ${esc(COMPANY.email)} · ${esc(COMPANY.www)}<br>
            ${esc(COMPANY.legal)}<br>
            ${esc(COMPANY.licence)}
            <div style="padding-top:8px;color:#8ea8c8;">${esc(params.footerNote)}</div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Absolutny URL logo. Bez `baseUrl` zostaje ścieżka względna (podgląd w iframe ją zniesie). */
function logoUrlFrom(opts: OrderMailOptions): string {
  const base = (opts.baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/alfa-logo.png` : "/alfa-logo.png";
}

/** Baza URL bez końcowego ukośnika — do składania linków w CRM. */
function baseFrom(opts: OrderMailOptions): string {
  return (opts.baseUrl || "").replace(/\/+$/, "");
}

/** Plakietka (numer zlecenia, status) w nagłówku. */
function badgeHtml(label: string, background: string, color: string): string {
  return `<span style="display:inline-block;background:${background};color:${color};font-size:13px;font-weight:bold;letter-spacing:0.6px;padding:4px 12px;margin:0 6px 0 0;">${esc(label)}</span>`;
}

// ---------------------------------------------------------------------------
// Zbieranie treści (wspólne dla HTML i wersji tekstowej)
// ---------------------------------------------------------------------------

interface MailContent {
  greeting: string;
  objectRows: Row[];
  scopeItems: string[];
  termsRows: Row[];
  datesRows: Row[];
  contactRows: Row[];
  notes: string | null;
}

function collect(order: OrderMailInput): MailContent {
  const requester = text(order.requesterName);

  const objectRows: Row[] = [
    { label: "Nazwa obiektu", value: text(order.objectName) },
    { label: "Rodzaj obiektu", value: text(order.objectKind) },
    { label: "Adres", value: text(order.objectAddress) },
    { label: "Miejscowość", value: text(order.objectCity) },
    {
      label: "Lokalizacja",
      value: text(order.objectLocationUrl) ? "Zobacz na mapie" : null,
      href: text(order.objectLocationUrl),
    },
  ];

  const cameras = count(order.cameraCount);
  const megaphones = count(order.megaphoneCount);
  const install = yesNo(order.isCameraInstallation);
  const internet = yesNo(order.internetIncluded);
  const intervention = yesNo(order.interventionGroup);
  const video = yesNo(order.videoReception);
  const vtools = text(order.vtoolsOfferNumber);

  // „Zakres usługi” to lista tego, CO KLIENT DOSTAJE. Odpowiedź „Nie” nie jest
  // zakresem — wypunktowanie „Grupa interwencyjna: Nie” brzmi jak wyliczanka
  // tego, czego nie kupił. Komplet Tak/Nie jest w wariancie wewnętrznym.
  const included = (label: string, answer: string | null) => (answer === "Tak" ? label : "");

  const scopeItems: string[] = [
    cameras !== null ? `Kamery: ${cameras} szt.` : "",
    megaphones !== null ? `Megafony: ${megaphones} szt.` : "",
    included("Montaż kamer", install),
    included("Internet w ramach usługi", internet),
    included("Grupa interwencyjna", intervention),
    included("Wideo recepcja", video),
    vtools ? `Numer oferty Vtools: ${vtools}` : "",
  ].filter(Boolean);

  const termsRows: Row[] = [
    { label: "Płatnik", value: text(order.payerName) },
    { label: "NIP", value: text(order.payerNip) },
    { label: "Abonament", value: amountPerMonths(order.monthlyAmount, order.contractLengthMonths) },
    { label: "Dzierżawa", value: amountPerMonths(order.rentalAmount, order.rentalLengthMonths) },
    { label: "Wystawca faktury", value: text(order.invoiceIssuer) },
    { label: "E-mail do faktur", value: text(order.payerInvoiceEmail) },
  ];

  const datesRows: Row[] = [
    { label: "Start usługi", value: date(order.serviceStartDate) },
    { label: "Start montażu", value: date(order.installationStartDate) },
  ];

  const contactRows: Row[] = [
    { label: "Osoba kontaktowa", value: text(order.contactPerson) },
    { label: "Telefon", value: text(order.contactPhone) },
    { label: "E-mail", value: text(order.contactEmail) },
  ];

  return {
    greeting: requester ? `Dzień dobry ${requester},` : "Dzień dobry,",
    objectRows,
    scopeItems,
    termsRows,
    datesRows,
    contactRows,
    notes: text(order.notes),
  };
}

const INTRO =
  "dziękujemy za zgłoszenie. Potwierdzamy przyjęcie Państwa zlecenia do realizacji — " +
  "poniżej znajduje się jego podsumowanie. Skontaktujemy się z Państwem w sprawie " +
  "uzgodnienia terminów montażu i uruchomienia usługi.";

// ---------------------------------------------------------------------------
// Wynik
// ---------------------------------------------------------------------------

/**
 * Buduje potwierdzenie przyjęcia zlecenia: temat, HTML (email-safe) i wersję tekstową.
 *
 * @param order wiersz tabeli `orders` (wystarczy sam `orderNumber` — reszta opcjonalna)
 * @param opts.baseUrl absolutny adres aplikacji, z którego składamy URL logo
 */
export function buildOrderConfirmationMail(
  order: OrderMailInput,
  opts: OrderMailOptions = {}
): OrderConfirmationMail {
  const number = text(order.orderNumber) ?? "";
  const content = collect(order);

  const subject = number
    ? `Potwierdzenie przyjęcia zlecenia ${number} — Alfa Group`
    : "Potwierdzenie przyjęcia zlecenia — Alfa Group";

  const html = shellHtml({
    subject,
    logoUrl: logoUrlFrom(opts),
    headerTitle: "Potwierdzenie przyjęcia zlecenia",
    headerExtraHtml: number
      ? `<div style="margin-top:8px;">${badgeHtml(number, "#ffffff", NAVY_DARK)}</div>`
      : "",
    preheader: `Zlecenie ${number || EMPTY} — ${text(order.objectName) ?? EMPTY}`,
    footerNote: "Wiadomość wygenerowana automatycznie — prosimy na nią nie odpowiadać.",
    body: `
        <!-- Powitanie -->
        <tr>
          <td style="padding:24px 24px 4px;">
            <p style="margin:0 0 10px;font-size:14px;color:${INK};">${esc(content.greeting)}</p>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.65;color:${GREY};">${esc(INTRO)}</p>
          </td>
        </tr>

        <!-- Karty -->
        <tr>
          <td style="padding:0 24px;">
${cardHtml("Dane obiektu", content.objectRows)}
${bulletCardHtml("Zakres usługi", content.scopeItems)}
${cardHtml("Warunki", content.termsRows)}
${cardHtml("Terminy", content.datesRows)}
${cardHtml("Osoba kontaktowa na obiekcie", content.contactRows)}
${noteCardHtml("Uwagi", content.notes)}
          </td>
        </tr>

        <!-- Zamknięcie -->
        <tr>
          <td style="padding:4px 24px 24px;">
            <p style="margin:0;font-size:14px;line-height:1.65;color:${GREY};">
              W razie pytań prosimy o kontakt: <a href="mailto:${esc(COMPANY.email)}" style="color:${NAVY};">${esc(COMPANY.email)}</a>
              lub telefonicznie ${esc(PHONES_INLINE)}.
            </p>
            <p style="margin:14px 0 0;font-size:14px;color:${INK};">Z poważaniem,<br><strong>Zespół ${esc(COMPANY.name)}</strong></p>
          </td>
        </tr>
`,
  });

  // ---- wersja tekstowa ----------------------------------------------------
  const lines: string[] = [];
  const block = (title: string, rows: Row[]) => {
    const visible = rows.filter((r) => r.value);
    if (visible.length === 0) return;
    lines.push("", title.toUpperCase());
    for (const r of visible) lines.push(`  ${r.label}: ${r.href || r.value}`);
  };

  lines.push(subject, "");
  lines.push(content.greeting);
  lines.push(INTRO);
  block("Dane obiektu", content.objectRows);
  if (content.scopeItems.length > 0) {
    lines.push("", "ZAKRES USŁUGI");
    for (const item of content.scopeItems) lines.push(`  - ${item}`);
  }
  block("Warunki", content.termsRows);
  block("Terminy", content.datesRows);
  block("Osoba kontaktowa na obiekcie", content.contactRows);
  if (content.notes) lines.push("", "UWAGI", `  ${content.notes}`);
  lines.push(
    "",
    `W razie pytań prosimy o kontakt: ${COMPANY.email}, ${PHONES_INLINE}.`,
    "",
    `Z poważaniem, Zespół ${COMPANY.name}`,
    `${COMPANY.address} · ${COMPANY.www}`,
    "Wiadomość wygenerowana automatycznie — prosimy na nią nie odpowiadać."
  );

  return { subject, html, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Wariant wewnętrzny (dla zespołu Alfa)
// ---------------------------------------------------------------------------

/** Sekcja wewnętrznego maila — tytuł karty + wiersze klucz→wartość. */
type Section = { title: string; rows: Row[] };

/** `tel:` bez spacji i myślników — inaczej część klientów nie zrobi z tego linku. */
function telHref(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : null;
}

function mailHref(value: unknown): string | null {
  const raw = text(value);
  return raw ? `mailto:${raw}` : null;
}

/** Liczba jako tekst („0 szt.” to informacja, nie brak danych). */
function pieces(value: unknown): string | null {
  const n = count(value);
  return n === null ? null : `${n} szt.`;
}

function months(value: unknown): string | null {
  const n = count(value);
  return n === null ? null : `${n} mies.`;
}

/**
 * Wartość łączna umowy: abonament × długość umowy + dzierżawa × długość dzierżawy.
 * Składnik wchodzi do sumy tylko wtedy, gdy ZNAMY i kwotę, i liczbę miesięcy —
 * inaczej „suma” kłamałaby o zakresie, którego nie obejmuje.
 */
function totalValue(order: OrderMailInput): string | null {
  const parts: number[] = [];
  const add = (amount: unknown, len: unknown) => {
    const a = typeof amount === "number" && Number.isFinite(amount) ? amount : null;
    const m = count(len);
    if (a !== null && m !== null && m > 0) parts.push(a * m);
  };
  add(order.monthlyAmount, order.contractLengthMonths);
  add(order.rentalAmount, order.rentalLengthMonths);
  if (parts.length === 0) return null;
  const sum = parts.reduce((acc, v) => acc + v, 0);
  const formatted = money(sum);
  return formatted ? `${formatted} netto (${parts.length === 2 ? "abonament + dzierżawa" : "za cały okres"})` : null;
}

/** Wszystkie sekcje zlecenia — kolejność i grupowanie jak w schemacie `orders`. */
function collectInternal(order: OrderMailInput, base: string): Section[] {
  const contractorId = count(order.payerContractorId);
  const objectId = count(order.objectId);
  const orderId = count(order.id);
  const status = statusOf(order.status);

  return [
    {
      title: "Osoba zlecająca",
      rows: [
        { label: "Imię i nazwisko", value: text(order.requesterName) },
        { label: "Telefon", value: text(order.requesterPhone), href: telHref(order.requesterPhone) },
        { label: "E-mail", value: text(order.requesterEmail), href: mailHref(order.requesterEmail) },
      ],
    },
    {
      title: "Płatnik",
      rows: [
        { label: "Nazwa", value: text(order.payerName) },
        { label: "NIP", value: text(order.payerNip) },
        {
          label: "E-mail do faktur",
          value: text(order.payerInvoiceEmail),
          href: mailHref(order.payerInvoiceEmail),
        },
        { label: "Wystawca faktury", value: text(order.invoiceIssuer) },
        {
          label: "Kontrahent w CRM",
          // Aplikacja nie ma trasy /contractors/:id — kontrahenta otwiera się
          // z listy. Etykieta mówi to wprost, żeby link nie obiecywał kartoteki.
          value: contractorId !== null ? `#${contractorId} (lista kontrahentów)` : null,
          href: contractorId !== null && base ? `${base}/contractors` : null,
        },
      ],
    },
    {
      title: "Obiekt",
      rows: [
        { label: "Nazwa obiektu", value: text(order.objectName) },
        { label: "Rodzaj obiektu", value: text(order.objectKind) },
        { label: "Adres", value: text(order.objectAddress) },
        { label: "Miejscowość", value: text(order.objectCity) },
        {
          label: "Lokalizacja",
          value: text(order.objectLocationUrl) ? "Zobacz na mapie" : null,
          href: text(order.objectLocationUrl),
        },
        {
          label: "Obiekt w CRM",
          value: objectId !== null ? `#${objectId}` : null,
          href: objectId !== null && base ? `${base}/objects/${objectId}` : null,
        },
      ],
    },
    {
      title: "Osoba kontaktowa na obiekcie",
      rows: [
        { label: "Osoba kontaktowa", value: text(order.contactPerson) },
        { label: "Telefon", value: text(order.contactPhone), href: telHref(order.contactPhone) },
        { label: "E-mail", value: text(order.contactEmail), href: mailHref(order.contactEmail) },
      ],
    },
    {
      title: "Zakres i dane techniczne",
      rows: [
        { label: "Montaż kamer", value: yesNo(order.isCameraInstallation) },
        { label: "Liczba kamer", value: pieces(order.cameraCount) },
        { label: "Liczba megafonów", value: pieces(order.megaphoneCount) },
        { label: "Numer oferty Vtools", value: text(order.vtoolsOfferNumber) },
        { label: "Internet w ramach usługi", value: yesNo(order.internetIncluded) },
        { label: "Grupa interwencyjna", value: yesNo(order.interventionGroup) },
        { label: "Wideo recepcja", value: yesNo(order.videoReception) },
      ],
    },
    {
      title: "Finanse",
      rows: [
        {
          label: "Abonament netto/mies.",
          value: money(order.monthlyAmount),
        },
        { label: "Długość umowy", value: months(order.contractLengthMonths) },
        { label: "Dzierżawa netto/mies.", value: money(order.rentalAmount) },
        { label: "Długość dzierżawy", value: months(order.rentalLengthMonths) },
        { label: "Wartość łączna", value: totalValue(order) },
      ],
    },
    {
      title: "Terminy",
      rows: [
        { label: "Start usługi", value: date(order.serviceStartDate) },
        { label: "Start montażu", value: date(order.installationStartDate) },
      ],
    },
    {
      title: "Metadane",
      rows: [
        { label: "ID zlecenia", value: orderId !== null ? `#${orderId}` : null },
        { label: "Status", value: status.label },
        { label: "Utworzono", value: dateTime(order.createdAt) },
        { label: "Zaktualizowano", value: dateTime(order.updatedAt) },
      ],
    },
  ];
}

/**
 * Buduje wewnętrzne powiadomienie o zleceniu dla zespołu Alfa.
 *
 * W przeciwieństwie do maila klienckiego pokazuje KOMPLET pól zlecenia —
 * brak danych to widoczne „—”, żeby dyspozytor od razu wiedział, czego dopytać.
 *
 * @param order wiersz tabeli `orders` (wystarczy sam `orderNumber` — reszta opcjonalna)
 * @param opts.baseUrl absolutny adres aplikacji (logo + linki do kartotek w CRM)
 */
export function buildOrderInternalMail(
  order: OrderMailInput,
  opts: OrderMailOptions = {}
): OrderInternalMail {
  const number = text(order.orderNumber) ?? "";
  const base = baseFrom(opts);
  const status = statusOf(order.status);
  const sections = collectInternal(order, base);
  const notes = text(order.notes);
  const orderId = count(order.id);

  const payer = text(order.payerName) ?? EMPTY;
  const objectName = text(order.objectName) ?? EMPTY;
  const subject = `[ZDW] Nowe zlecenie ${number || EMPTY} — ${payer} / ${objectName}`;

  const crmHref = orderId !== null && base ? `${base}/orders/${orderId}` : null;

  const html = shellHtml({
    subject,
    logoUrl: logoUrlFrom(opts),
    headerTitle: `Zlecenie ${number || EMPTY}`,
    headerExtraHtml: `<div style="margin-top:8px;">${badgeHtml(status.label, status.color, "#ffffff")}</div>`,
    preheader: `${payer} / ${objectName} · ${status.label}`,
    footerNote: "Wiadomość wewnętrzna — wygenerowana automatycznie przez CRM Alfa Group.",
    body: `
        <!-- Wstęp -->
        <tr>
          <td style="padding:22px 24px 4px;">
            <p style="margin:0 0 18px;font-size:14px;line-height:1.65;color:${GREY};">
              Poniżej komplet danych zlecenia tak, jak zostały zapisane w CRM.
              Pola bez wartości oznaczono znakiem &bdquo;${EMPTY}&rdquo;.
            </p>
          </td>
        </tr>

        <!-- Karty -->
        <tr>
          <td style="padding:0 24px;">
${sections.map((s) => cardHtml(s.title, s.rows, true)).join("\n")}
${noteCardHtml("Uwagi", notes, true)}
${crmHref ? buttonHtml("Otwórz zlecenie w CRM", crmHref) : ""}
          </td>
        </tr>
`,
  });

  // ---- wersja tekstowa ----------------------------------------------------
  const lines: string[] = [subject, ""];
  for (const section of sections) {
    lines.push(section.title.toUpperCase());
    for (const row of section.rows) lines.push(`  ${row.label}: ${row.value ?? EMPTY}`);
    lines.push("");
  }
  lines.push("UWAGI", `  ${notes ?? EMPTY}`, "");
  if (crmHref) lines.push(`Otwórz zlecenie w CRM: ${crmHref}`, "");
  lines.push("Wiadomość wewnętrzna — wygenerowana automatycznie przez CRM Alfa Group.");

  return { subject, html, text: lines.join("\n") };
}
