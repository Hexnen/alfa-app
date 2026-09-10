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
const WHITE = "#ffffff";
/** Jasny błękit na granacie (podtytuł w nagłówku, treść stopki). */
const ON_NAVY = "#c8d7ea";
/** Przygaszony błękit na granacie (dopisek pod stopką). */
const ON_NAVY_FAINT = "#8ea8c8";

/** Jedyny krój, jaki mamy pewny w Outlooku — powtarzany przy KAŻDYM napisie. */
const FONT = "Arial,Helvetica,sans-serif";

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

/**
 * OKRESY USŁUG ZE ZLECENIA (`orders.object_services`, kolumna JSON).
 *
 * Czytane defensywnie: kolumna bywa stringiem (surowy odczyt przez better-sqlite3
 * z pominięciem drizzle), tablicą (mode: "json") albo śmieciem ze starszej wersji
 * klienta. Mail NIE MA PRAWA wywalić się na danych — nierozpoznany kształt to
 * `null`, czyli powrót do wariantu sprzed okresów (`cameraCount`/`videoReception`).
 */
interface MailServicePeriod {
  service: string;
  startDate: string | null;
  endDate: string | null;
  cameraCount: number | null;
}

const SERVICE_NAMES: Record<string, string> = {
  kamery: "Kamery",
  sswin: "SSWiN",
  wideorecepcja: "Wideo recepcja",
  ofi: "Ochrona fizyczna",
};

function servicePeriodsOf(order: OrderMailInput): MailServicePeriod[] | null {
  const raw: unknown = (order as { objectServices?: unknown }).objectServices;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const out: MailServicePeriod[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const service = text(r.service);
    if (!service || !(service in SERVICE_NAMES)) continue;
    out.push({
      service,
      startDate: text(r.startDate),
      endDate: text(r.endDate),
      cameraCount: count(r.cameraCount),
    });
  }
  return out.length > 0 ? out : null;
}

/** „Kamery 8 szt. · od 1 października 2026 do 30 września 2028”. */
function servicePeriodLine(p: MailServicePeriod): string {
  const name = SERVICE_NAMES[p.service] ?? p.service;
  const head = p.service === "kamery" && p.cameraCount !== null ? `${name} ${p.cameraCount} szt.` : name;
  const from = date(p.startDate);
  const to = date(p.endDate);
  if (from && to) return `${head} · od ${from} do ${to}`;
  if (from) return `${head} · od ${from}`;
  if (to) return `${head} · do ${to}`;
  return head;
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
//
// Wszystko poniżej jest pisane pod NAJGŁUPSZY silnik, jaki dostanie ten mail:
// Outlook desktop renderuje HTML Wordem, a użytkownik dodatkowo wkleja podgląd
// przez schowek (Ctrl+V), czyli Word dostaje sam fragment <body>. Stąd trzy
// żelazne reguły, których łamanie kosztowało nas czarne napisy na granacie:
//
//   1. KOLOR TEKSTU NA ELEMENCIE INLINE. Word nie dziedziczy `color` z <td>
//      ani z <div> — dziedziczy dopiero z <span>/<a>/<font>. Napis bez własnego
//      koloru wychodzi czarny, więc biały tytuł na granatowym pasku znika.
//   2. TŁO JAKO ATRYBUT `bgcolor` + styl. Word gubi `background` z CSS na <td>.
//   3. SZEROKOŚĆ I ODSTĘPY JAKO ATRYBUTY tabeli (`width`, `cellpadding`,
//      `cellspacing`, `border`) — `max-width` i `border-collapse` bywają
//      ignorowane, a bez `cellspacing="0"` Word wstawia własne szczeliny.
//
// Nie używamy `border-radius` (Word go nie zna) — okrągła podkładka pod logo
// jest wypalona w samym pliku PNG (patrz `scripts/build-mail-logo.ts`).
// ---------------------------------------------------------------------------

/** Atrybuty każdej tabeli w mailu — bez nich Word dokłada własne odstępy. */
const TABLE_ATTRS = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

/**
 * Fragment tekstu z kolorem USTAWIONYM NA SOBIE (reguła 1).
 *
 * @param onDark dokłada `<font color>` — jedyny zapis koloru, który Word
 *               respektuje bezwarunkowo. Używamy go tam, gdzie pomyłka jest
 *               najdroższa: biały/jasny napis na ciemnym tle (czarny tekst na
 *               granacie jest po prostu nieczytelny).
 */
function inkHtml(content: string, color: string, style = "", onDark = false): string {
  const span = `<span style="color:${color};font-family:${FONT};${style}">${content}</span>`;
  return onDark ? `<font color="${color}">${span}</font>` : span;
}

/** Biały napis na ciemnym tle (nagłówek, paski kart, stopka, CTA). */
function whiteHtml(content: string, style = ""): string {
  return inkHtml(content, WHITE, style, true);
}

/** Tło komórki: atrybut `bgcolor` **i** styl (reguła 2). */
function cellBg(color: string, style: string): string {
  return `bgcolor="${color}" style="background-color:${color};background:${color};${style}"`;
}

/** Link z kolorem na sobie; na ciemnym tle dodatkowo w `<font color>`. */
function linkHtml(
  href: string,
  content: string,
  color: string,
  style = "",
  onDark = false
): string {
  const a = `<a href="${esc(href)}" style="color:${color};font-family:${FONT};${style}">${content}</a>`;
  return onDark ? `<font color="${color}">${a}</font>` : a;
}

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
      ? linkHtml(row.href, esc(raw), NAVY, "font-size:13px;font-weight:bold;text-decoration:underline;")
      : inkHtml(esc(raw), row.value ? INK : GREY, "font-size:13px;font-weight:bold;");
  return `
              <tr>
                <td style="padding:6px 0;border-bottom:1px solid #edf1f5;font-size:13px;width:42%;vertical-align:top;">${inkHtml(esc(row.label), GREY, "font-size:13px;")}</td>
                <td style="padding:6px 0;border-bottom:1px solid #edf1f5;font-size:13px;vertical-align:top;">${value}</td>
              </tr>`;
}

/** Granatowy pasek z tytułem karty — powtarza się w trzech rodzajach kart. */
function cardTitleRowHtml(title: string): string {
  return `
          <tr>
            <td ${cellBg(NAVY, "padding:6px 14px;font-size:11px;line-height:14px;mso-line-height-rule:exactly;")}>${whiteHtml(esc(title.toUpperCase()), "font-size:11px;line-height:14px;font-weight:bold;letter-spacing:1px;")}</td>
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
        <table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse;border:1px solid ${LINE};margin:0 0 16px;">${cardTitleRowHtml(title)}
          <tr>
            <td ${cellBg(WHITE, "padding:6px 14px 10px;")}>
              <table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse;">${body}
              </table>
            </td>
          </tr>
        </table>`;
}

/** Karta z jednym blokiem tekstu (uwagi) — łamania linii zachowane jako <br>. */
function noteCardHtml(title: string, body: string | null, showEmpty = false): string {
  if (!body && !showEmpty) return "";
  const content = body
    ? inkHtml(esc(body).replace(/\r?\n/g, "<br>"), INK, "font-size:13px;line-height:1.6;")
    : inkHtml(EMPTY, GREY, "font-size:13px;line-height:1.6;");
  return `
        <table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse;border:1px solid ${LINE};margin:0 0 16px;">${cardTitleRowHtml(title)}
          <tr>
            <td ${cellBg(WHITE, "padding:10px 14px;font-size:13px;line-height:1.6;")}>${content}</td>
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
                <td style="padding:5px 0;font-size:13px;width:16px;vertical-align:top;">${inkHtml("&bull;", NAVY, "font-size:13px;")}</td>
                <td style="padding:5px 0;font-size:13px;vertical-align:top;">${inkHtml(esc(item), INK, "font-size:13px;")}</td>
              </tr>`
    )
    .join("");
  return `
        <table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse;border:1px solid ${LINE};margin:0 0 16px;">${cardTitleRowHtml(title)}
          <tr>
            <td ${cellBg(WHITE, "padding:6px 14px 10px;")}>
              <table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse;">${body}
              </table>
            </td>
          </tr>
        </table>`;
}

/** Przycisk-link (CTA) w wersji tabelowej — <button> i border-radius Outlook ignoruje. */
function buttonHtml(label: string, href: string): string {
  return `
        <table ${TABLE_ATTRS} style="border-collapse:collapse;margin:0 0 16px;">
          <tr>
            <td ${cellBg(NAVY, "padding:11px 22px;")}>
              ${linkHtml(
                href,
                whiteHtml(`${esc(label)} &rarr;`, "font-size:13px;font-weight:bold;"),
                WHITE,
                "font-size:13px;font-weight:bold;text-decoration:none;",
                true
              )}
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
export function wrapMailShell(params: {
  subject: string;
  logoUrl: string;
  headerTitle: string;
  headerExtraHtml: string;
  /** Tekst podglądu na liście wiadomości (obok tematu) — ukryty w samej treści. */
  preheader: string;
  body: string;
  footerNote: string;
}): string {
  const footerText = (content: string) => inkHtml(content, ON_NAVY, "font-size:10px;line-height:1.7;", true);
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(params.subject)}</title>
</head>
<body bgcolor="${PAPER}" style="margin:0;padding:0;background-color:${PAPER};background:${PAPER};">
<!-- Preheader: to, co Gmail/Outlook pokazuje na liście obok tematu. Musi być
     PIERWSZYM tekstem w <body>, inaczej klient weźmie „Dzień dobry…”.
     Samo display:none Wordowi nie wystarcza (potrafi je pokazać), więc
     dokładamy zerową wysokość, przezroczystość, kolor tła i mso-hide:all. -->
<div style="display:none;font-size:1px;color:${PAPER};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${inkHtml(esc(params.preheader), PAPER, "font-size:1px;line-height:1px;")}</div>
<table ${TABLE_ATTRS} width="100%" ${cellBg(PAPER, "width:100%;border-collapse:collapse;")}>
  <tr>
    <td align="center" ${cellBg(PAPER, "padding:24px 12px;")}>
      <!-- width JAKO ATRYBUT: Word ignoruje max-width, więc bez tego mail
           rozjeżdża się na całą szerokość okna Outlooka. -->
      <table ${TABLE_ATTRS} width="640" ${cellBg(WHITE, `width:640px;max-width:640px;border-collapse:collapse;font-family:${FONT};`)}>

        <!-- Pasek nagłówka -->
        <tr>
          <td ${cellBg(NAVY, "padding:20px 24px;")}>
            <table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse;">
              <tr>
                <!-- Logo ma białą podkładkę WYPALONĄ W PLIKU (alfa-logo-mail.png,
                     bez kanału alfa, narożniki w kolorze paska): Word ignoruje
                     border-radius, a przezroczysty PNG potrafi spłaszczyć na
                     czarno. Dlatego komórka nie ma ani tła, ani paddingu. -->
                <td width="68" height="68" align="center" valign="middle" style="width:68px;height:68px;line-height:0;font-size:0;">
                  <img src="${esc(params.logoUrl)}" alt="Alfa Group" width="68" height="68" style="display:block;width:68px;height:68px;border:0;">
                </td>
                <td valign="middle" style="vertical-align:middle;padding-left:16px;">
                  <div style="font-size:19px;line-height:1.3;">${whiteHtml(esc(params.headerTitle), "font-size:19px;font-weight:bold;letter-spacing:0.3px;")}</div>
                  <div style="font-size:12px;padding-top:3px;line-height:1.4;">${inkHtml(esc(COMPANY.name), ON_NAVY, "font-size:12px;", true)}</div>
                  ${params.headerExtraHtml}
                </td>
              </tr>
            </table>
          </td>
        </tr>
${params.body}
        <!-- Stopka -->
        <tr>
          <td ${cellBg(NAVY_DARK, "padding:16px 24px;font-size:10px;line-height:1.7;")}>
            ${whiteHtml(esc(COMPANY.name), "font-size:10px;font-weight:bold;line-height:1.7;")}${footerText(` · ${esc(COMPANY.address)}`)}<br>
            ${footerText(`${esc(COMPANY.phones)} · ${esc(COMPANY.email)} · ${esc(COMPANY.www)}`)}<br>
            ${footerText(esc(COMPANY.legal))}<br>
            ${footerText(esc(COMPANY.licence))}
            <div style="padding-top:8px;font-size:10px;line-height:1.7;">${inkHtml(esc(params.footerNote), ON_NAVY_FAINT, "font-size:10px;line-height:1.7;", true)}</div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * Absolutny URL logo. Bez `baseUrl` zostaje ścieżka względna (podgląd w iframe ją zniesie).
 *
 * To NIE jest `alfa-logo.png` z aplikacji: mail używa wersji „mailowej” — bez
 * kanału alfa, z białym krążkiem i granatowym tłem wypalonymi w pikselach
 * (`scripts/build-mail-logo.ts`). Outlook potrafi spłaszczyć przezroczysty PNG
 * na czarno i nie zna `border-radius`, więc podkładki nie da się zrobić w HTML.
 */
function logoUrlFrom(opts: OrderMailOptions): string {
  const base = (opts.baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/alfa-logo-mail.png` : "/alfa-logo-mail.png";
}

/** Baza URL bez końcowego ukośnika — do składania linków w CRM. */
function baseFrom(opts: OrderMailOptions): string {
  return (opts.baseUrl || "").replace(/\/+$/, "");
}

/**
 * Plakietka (numer zlecenia, status) w nagłówku.
 *
 * Tło zewnętrznego <span> Word czasem zgubi, ale kolor napisu jest ustawiony na
 * samym tekście (i przez `<font color>` przy jasnym napisie), więc w najgorszym
 * razie plakietka traci prostokąt — nigdy czytelność.
 */
function badgeHtml(label: string, background: string, color: string): string {
  const inner =
    color.toLowerCase() === WHITE
      ? whiteHtml(esc(label), "font-size:13px;font-weight:bold;letter-spacing:0.6px;")
      : inkHtml(esc(label), color, "font-size:13px;font-weight:bold;letter-spacing:0.6px;", true);
  return `<span style="display:inline-block;background-color:${background};background:${background};padding:4px 12px;margin:0 6px 0 0;">${inner}</span>`;
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

  // Zlecenie z okresami usług pokazuje je z datami („Kamery 8 szt. · od …”) —
  // klient dostaje wtedy zakres i termin w jednej linii. Zlecenie sprzed
  // września 2026 nie ma tej listy i wraca na stary wariant z samych liczb.
  const periods = servicePeriodsOf(order);

  const scopeItems: string[] = [
    ...(periods
      ? periods.map(servicePeriodLine)
      : [cameras !== null ? `Kamery: ${cameras} szt.` : ""]),
    megaphones !== null ? `Megafony: ${megaphones} szt.` : "",
    included("Montaż kamer", install),
    included("Internet w ramach usługi", internet),
    included("Grupa interwencyjna", intervention),
    // Przy okresach wideorecepcja jest już wypisana wyżej, z własnymi datami.
    periods ? "" : included("Wideo recepcja", video),
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
/**
 * Temat maila wg ustaleń z 2026-09-08: `[TYP] NAZWA OBIEKTU / KONTRAHENT`.
 * Typ zlecenia — dziś wszystkie zlecenia to „Zlecenie do ZDW”, więc stała ZDW
 * (numer zlecenia, np. ZL-2026-33112, nie niesie typu).
 */
const ORDER_TYPE = "ZDW";

function mailSubject(order: OrderMailInput): string {
  const typ = ORDER_TYPE;
  const objectName = (text(order.objectName) ?? EMPTY).toUpperCase();
  const payer = text(order.payerName) ?? EMPTY;
  return `[${typ}] ${objectName} / ${payer}`;
}

export function buildOrderConfirmationMail(
  order: OrderMailInput,
  opts: OrderMailOptions = {}
): OrderConfirmationMail {
  const number = text(order.orderNumber) ?? "";
  const content = collect(order);

  const subject = mailSubject(order);

  const html = wrapMailShell({
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
          <td ${cellBg(WHITE, "padding:24px 24px 4px;")}>
            <p style="margin:0 0 10px;font-size:14px;">${inkHtml(esc(content.greeting), INK, "font-size:14px;")}</p>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.65;">${inkHtml(esc(INTRO), GREY, "font-size:14px;line-height:1.65;")}</p>
          </td>
        </tr>

        <!-- Karty -->
        <tr>
          <td ${cellBg(WHITE, "padding:0 24px;")}>
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
          <td ${cellBg(WHITE, "padding:4px 24px 24px;")}>
            <p style="margin:0;font-size:14px;line-height:1.65;">${inkHtml("W razie pytań prosimy o kontakt: ", GREY, "font-size:14px;line-height:1.65;")}${linkHtml(
              `mailto:${COMPANY.email}`,
              esc(COMPANY.email),
              NAVY,
              "font-size:14px;text-decoration:underline;"
            )}${inkHtml(` lub telefonicznie ${esc(PHONES_INLINE)}.`, GREY, "font-size:14px;line-height:1.65;")}</p>
            <p style="margin:14px 0 0;font-size:14px;">${inkHtml("Z poważaniem,", INK, "font-size:14px;")}<br>${inkHtml(`Zespół ${esc(COMPANY.name)}`, INK, "font-size:14px;font-weight:bold;")}</p>
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
  if (number) lines.push(`Zlecenie nr ${number}`, "");
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
        // Wariant wewnętrzny pokazuje KAŻDE pole, więc wiersz „Usługi” stoi
        // tu zawsze — pusty („—”) dla zleceń sprzed okresów usług, gdzie zakres
        // trzeba czytać z „Liczba kamer” i „Wideo recepcja” niżej.
        {
          label: "Usługi",
          value:
            servicePeriodsOf(order)
              ?.map(servicePeriodLine)
              .join("; ") ?? null,
        },
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
  const subject = mailSubject(order);

  const crmHref = orderId !== null && base ? `${base}/orders/${orderId}` : null;

  const html = wrapMailShell({
    subject,
    logoUrl: logoUrlFrom(opts),
    headerTitle: `Zlecenie ${number || EMPTY}`,
    headerExtraHtml: `<div style="margin-top:8px;">${badgeHtml(status.label, status.color, "#ffffff")}</div>`,
    preheader: `${payer} / ${objectName} · ${status.label}`,
    footerNote: "Wiadomość wewnętrzna — wygenerowana automatycznie przez CRM Alfa Group.",
    body: `
        <!-- Wstęp -->
        <tr>
          <td ${cellBg(WHITE, "padding:22px 24px 4px;")}>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.65;">${inkHtml(
              `Poniżej komplet danych zlecenia tak, jak zostały zapisane w CRM. Pola bez wartości oznaczono znakiem &bdquo;${EMPTY}&rdquo;.`,
              GREY,
              "font-size:14px;line-height:1.65;"
            )}</p>
          </td>
        </tr>

        <!-- Karty -->
        <tr>
          <td ${cellBg(WHITE, "padding:0 24px;")}>
${sections.map((s) => cardHtml(s.title, s.rows, true)).join("\n")}
${noteCardHtml("Uwagi", notes, true)}
${crmHref ? buttonHtml("Otwórz zlecenie w CRM", crmHref) : ""}
          </td>
        </tr>
`,
  });

  // ---- wersja tekstowa ----------------------------------------------------
  const lines: string[] = [subject, ""];
  if (number) lines.push(`Zlecenie nr ${number}`, "");
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

/**
 * Absolutny adres aplikacji dla zasobów i linków wklejanych do maila (logo, CRM).
 *
 * Kolejność: `APP_PUBLIC_URL` (wdrożenie) → `Origin` (żądanie z przeglądarki) →
 * `X-Forwarded-Host` (proxy) → `Host`. Gdy nic nie da się ustalić — pusty string,
 * czyli szablon zostawi ścieżkę względną.
 *
 * `X-Forwarded-Host` MUSI iść przed `Host`: w devie front woła /api przez proxy
 * Vite z `changeOrigin: true`, które przepisuje Host na `localhost:4001` i nie
 * przesyła Origin. Bez tego kroku mail wskazywałby backend zamiast aplikacji.
 *
 * Mieszka TUTAJ, a nie w trasach zleceń, bo z tego samego szablonu (logo w nagłówku)
 * korzystają też maile grup interwencyjnych — src/lib/intervention-mail.ts.
 */
export function resolveBaseUrl(c: { req: { header(name: string): string | undefined } }): string {
  const configured = (process.env.APP_PUBLIC_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  const origin = (c.req.header("origin") || "").trim();
  if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");

  // Nagłówki proxy bywają listą („a, b”) — liczy się pierwszy wpis, czyli klient.
  const first = (name: string) => (c.req.header(name) || "").split(",")[0].trim();

  const host = first("x-forwarded-host") || (c.req.header("host") || "").trim();
  if (!host) return "";
  const proto = first("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

/** Absolutny URL logo dla nagłówka maila (klient pocztowy nie zna adresu aplikacji). */
export function mailLogoUrl(baseUrl: string | undefined): string {
  const base = (baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/alfa-logo-mail.png` : "/alfa-logo-mail.png";
}
