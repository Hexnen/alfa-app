/**
 * Czytanie plików `.msg` z Outlooka (format CFBF / MS-OXMSG) i zamiana maila
 * na tekst notatki kalendarza.
 *
 * Po co: użytkownik przeciąga mail z Outlooka na kalendarz, a my robimy z niego
 * wydarzenie — temat idzie w tytuł, cała korespondencja w pierwszą notatkę,
 * a oryginalny plik zostaje jej załącznikiem (patrz `.msg` na białej liście
 * w src/lib/calendar-attachments.ts). Trasa: POST /calendar/msg/parse.
 *
 * Moduł jest CZYSTY — nie zna bazy, sesji ani HTTP, żeby dało się go testować
 * bez stawiania aplikacji (scripts/test-outlook-msg.ts).
 */
import MsgReaderNs, { type FieldsData } from "@kenjiuno/msgreader";
import { APP_TZ } from "./tz.js";

/**
 * `@kenjiuno/msgreader` jest paczką CommonJS, a my chodzimy na ESM: `import X from`
 * daje tu CAŁY `module.exports` (obiekt z polem `default`), a nie klasę. Rozwijamy
 * ręcznie zamiast liczyć na interop — inaczej `new MsgReader(...)` wywala się
 * dopiero w czasie działania.
 */
const MsgReader = ((MsgReaderNs as unknown as { default?: typeof MsgReaderNs }).default ??
  MsgReaderNs) as typeof MsgReaderNs;

/** Górna granica treści maila przenoszonej do notatki (znaki). */
export const MSG_BODY_MAX_CHARS = 20_000;
/** Górna granica tytułu proponowanego dla wydarzenia (znaki). */
export const MSG_TITLE_MAX_CHARS = 200;
/** Tytuł, gdy mail nie ma tematu. */
export const MSG_TITLE_FALLBACK = "Mail z Outlooka";

/**
 * Nagłówek maila — dokładnie te pola, które trafiają do kolumn `mail_*`
 * notatki (migracja 0094) i do JSON-a `CalendarNote.mail`.
 */
export interface MsgMail {
  subject: string;
  /** Nadawca w formie „Jan Kowalski <jan@x.pl>” (albo sama nazwa / sam adres). */
  from: string;
  to: string[];
  cc: string[];
  /** ISO 8601 albo null, gdy plik nie niesie żadnej wiarygodnej daty. */
  sentAt: string | null;
  /**
   * NAZWY załączników maila — snapshot wiersza „Załączniki:” z Outlooka.
   * Trzymamy je przy nagłówku (kolumna `mail_attachments`), bo nie każdy
   * załącznik da się wypakować (za duży, nieobsługiwany typ) — bez tej listy
   * UI nie miałoby skąd wiedzieć, że coś w mailu było.
   */
  attachments?: string[];
}

/**
 * Załącznik wypakowany z pliku `.msg` — bajty siedzą w pamięci, więc obiekt
 * żyje tylko do zapisu przez storeUploads.
 */
export interface MsgAttachmentFile {
  name: string;
  /** MIME z `attachMimeTag`; pusty, gdy mail go nie niósł — wtedy typ rozstrzyga rozszerzenie. */
  mime: string;
  data: Buffer;
  /** Obrazek wklejony w treść (logo, podpis) — Outlook oznacza je Content-ID albo ukryciem. */
  inline: boolean;
  contentId: string | null;
}

/** Metadane załącznika BEZ bajtów — tyle oddaje trasa /msg/parse (szkic w dialogu). */
export interface MsgAttachmentMeta {
  name: string;
  mime: string;
  size: number;
  isImage: boolean;
}

/** Mail rozłożony na części — jedyny kontrakt tego modułu z resztą aplikacji. */
export interface ParsedMsg extends MsgMail {
  bodyText: string;
  /** Same nazwy plików (także maili zagnieżdżonych, których nie da się wypakować). */
  attachments: string[];
  /** Załączniki z treścią — bez maili zagnieżdżonych i bez pustych strumieni. */
  attachmentFiles: MsgAttachmentFile[];
}

/** Sam nagłówek (bez treści) — to, co zapisujemy w kolumnach `mail_*`. */
export function mailHeaderOf(p: MsgMail): MsgMail {
  return {
    subject: p.subject,
    from: p.from,
    to: [...p.to],
    cc: [...p.cc],
    sentAt: p.sentAt,
    attachments: [...(p.attachments ?? [])],
  };
}

/** Rozszerzenia, po których poznajemy obrazek bez patrzenia w bajty. */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|tiff?|avif|bmp|heic|heif|svg)$/i;

/** Załączniki → lista dla frontu: nazwa, typ, rozmiar i czy to obrazek. */
export function attachmentsMetaOf(files: MsgAttachmentFile[]): MsgAttachmentMeta[] {
  return files.map((f) => ({
    name: f.name,
    mime: f.mime,
    size: f.data.length,
    isImage: f.mime.toLowerCase().startsWith("image/") || IMAGE_EXT_RE.test(f.name),
  }));
}

/** Adres w nawiasach ostrych albo goły — pola nagłówka są sformatowane „Nazwa <adres>”. */
const ADDRESS_RE = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>|([^<>\s@,;]+@[^<>\s@,;]+)/g;

/**
 * Gołe adresy z nagłówka (nadawca + DO + DW), małymi literami, bez powtórzeń.
 * Po nich src/lib/mail-object-match.ts podpowiada obiekt.
 */
export function emailsOf(p: MsgMail): string[] {
  const out = new Set<string>();
  for (const field of [p.from, ...p.to, ...p.cc]) {
    for (const m of (field ?? "").matchAll(ADDRESS_RE)) {
      // Adres kończący się kropką/przecinkiem to zwykle interpunkcja zdania.
      const addr = (m[1] ?? m[2] ?? "").replace(/[.,;:]+$/, "").toLowerCase();
      if (addr.includes("@")) out.add(addr);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// HTML → tekst
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  oacute: "ó",
  Oacute: "Ó",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  rdquo: "”",
  ldquo: "“",
  rsquo: "’",
  lsquo: "‘",
  middot: "·",
  bull: "•",
  euro: "€",
  copy: "©",
  reg: "®",
  deg: "°",
};

/** Dekoduje encje nazwane (podzbiór realnie spotykany w mailach) i liczbowe. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body] ?? whole;
  });
}

/**
 * Zdejmuje znaczniki z `bodyHtml` (używane tylko wtedy, gdy mail nie ma wersji
 * tekstowej). Bez parsera DOM — wystarczy zamienić bloki na łamania linii,
 * wyciąć `script`/`style` i zdekodować encje.
 */
export function htmlToText(html: string): string {
  let out = html.replace(/\r\n?/g, "\n");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // Elementy blokowe i łamania → nowa linia (akapity → pusta linia).
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|pre)\s*>/gi, "\n");
  out = out.replace(/<(p|div|tr|li|h[1-6]|blockquote|hr)\b[^>]*\/?>/gi, "\n");
  out = out.replace(/<\/t[dh]\s*>/gi, "\t");
  out = out.replace(/<[^>]+>/g, "");
  out = decodeEntities(out);
  // Twarda spacja z Worda/Outlooka to zwykła spacja — inaczej zostaje w tekście na zawsze.
  out = out.replace(/\u00a0/g, " ");
  return normalizeText(out);
}

/** CRLF → LF, bez spacji na końcach linii, maks. 2 puste linie z rzędu. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Dopisek zostawiany w miejscu ucięcia — czytelny sygnał, że to nie cały mail. */
const CLAMP_MARK = "\n[…skrócono]";

/**
 * Przycięcie treści z widocznym dopiskiem. Wynik ZAWSZE mieści się w `max`
 * (dopisek liczy się do limitu) — trasa tnie tym samym helperem do limitu
 * notatki kalendarza, a ten jest twardy po stronie bazy.
 */
export function clampBody(text: string, max = MSG_BODY_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - CLAMP_MARK.length)).trimEnd()}${CLAMP_MARK}`;
}

// ---------------------------------------------------------------------------
// Temat → tytuł wydarzenia
// ---------------------------------------------------------------------------

/**
 * Prefiksy odpowiedzi/przekazania: polskie (ODP.:, PD:, PW:), angielskie
 * (RE:, FW:, FWD:) i niemieckie (AW:, WG:), także w formie „RE[2]:”.
 * Ucinamy wielokrotnie — „FW: ODP.: RE: Oferta” to nadal „Oferta”.
 */
const SUBJECT_PREFIX_RE = /^\s*(re|odp|fw|fwd|pd|pw|aw|wg)\s*\.?\s*(\[\d+\])?\s*:\s*/i;

/** Temat maila → tytuł wydarzenia: bez prefiksów, przycięty, z sensownym fallbackiem. */
export function suggestedTitleFrom(subject: string): string {
  let out = (subject ?? "").replace(/\s+/g, " ").trim();
  // Prefiksów bywa kilka jeden po drugim; pętla z twardym limitem zamiast rekursji.
  for (let i = 0; i < 10 && SUBJECT_PREFIX_RE.test(out); i++) {
    out = out.replace(SUBJECT_PREFIX_RE, "").trim();
  }
  if (!out) return MSG_TITLE_FALLBACK;
  return out.length > MSG_TITLE_MAX_CHARS ? out.slice(0, MSG_TITLE_MAX_CHARS).trimEnd() : out;
}

// ---------------------------------------------------------------------------
// Adresy i daty
// ---------------------------------------------------------------------------

/** Znaki sterujące i twarde spacje z MAPI → zwykła spacja; reszta bez zmian. */
const clean = (v: unknown): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u00a0]/g, " ").trim() : "";

/** „Jan Kowalski <jan@x.pl>”; przy braku jednej ze stron — to, co jest. */
export function formatAddress(name: string | undefined, email: string | undefined): string {
  const n = clean(name);
  const e = clean(email);
  if (n && e && n.toLowerCase() !== e.toLowerCase()) return `${n} <${e}>`;
  return e || n;
}

/**
 * Adres odbiorcy/nadawcy z pól msgreadera. `email` bywa adresem Exchange
 * (`/O=…/CN=…`) — wtedy wolimy `smtpAddress`, a gdy i tego nie ma, zostaje
 * sama nazwa wyświetlana.
 */
function addressOf(f: FieldsData): string {
  const raw = clean(f.email);
  const smtp = clean(f.smtpAddress);
  const email = smtp || (raw.startsWith("/") ? "" : raw);
  return formatAddress(f.name, email);
}

/** Data z pól msgreadera (RFC-1123 UTC) → ISO 8601; null przy braku/śmieciu. */
function toIso(...candidates: Array<string | undefined>): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return null;
}

/** „10.09.2026 14:32” w strefie aplikacji (host może chodzić na UTC). */
export function formatSentAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const f = new Intl.DateTimeFormat("pl-PL", {
    timeZone: APP_TZ,
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const g: Record<string, string> = {};
  for (const p of f.formatToParts(d)) g[p.type] = p.value;
  return `${g.day}.${g.month}.${g.year} ${g.hour}:${g.minute}`;
}

// ---------------------------------------------------------------------------
// Parsowanie
// ---------------------------------------------------------------------------

/**
 * Rozkłada plik `.msg` na części. Rzuca `Error`, gdy pliku nie da się odczytać
 * (nie jest CFBF, jest ucięty, albo msgreader zgłosi własny błąd) — trasa
 * zamienia to na 400 z polskim komunikatem.
 */
export function parseOutlookMsg(buf: Buffer): ParsedMsg {
  if (buf.length === 0) throw new Error("Pusty plik .msg");
  // Buffer bywa widokiem na większy ArrayBuffer (pooling Node) — kopiujemy zakres.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const reader = new MsgReader(ab);
  const data = reader.getFileData();
  if (data.error) throw new Error(data.error);

  const recipients = Array.isArray(data.recipients) ? data.recipients : [];
  const to: string[] = [];
  const cc: string[] = [];
  for (const r of recipients) {
    const label = addressOf(r);
    if (!label) continue;
    // Brak `recipType` traktujemy jak „to” — tak wygląda część maili z Exchange.
    if (r.recipType === "cc") cc.push(label);
    else if (r.recipType === "bcc") continue;
    else to.push(label);
  }

  const plain = clean(data.body) ? normalizeText(data.body as string) : "";
  const bodyText = clampBody(plain || (data.bodyHtml ? htmlToText(data.bodyHtml) : ""));

  const rawAttachments = Array.isArray(data.attachments) ? data.attachments : [];
  const attachments = rawAttachments
    .map((a) => clean(a.fileName) || clean(a.fileNameShort) || clean(a.name))
    .filter((n): n is string => n.length > 0);

  const attachmentFiles: MsgAttachmentFile[] = [];
  for (const a of rawAttachments) {
    // Mail zagnieżdżony to nie plik, tylko druga wiadomość (msgreader „wypaliłby”
    // z niej .msg) — pomijamy; tak samo załącznik bez strumienia danych.
    if (a.innerMsgContent === true || typeof a.dataId !== "number") continue;
    const name = clean(a.fileName) || clean(a.fileNameShort) || clean(a.name);
    if (!name) continue;
    let content: Uint8Array | undefined;
    try {
      content = reader.getAttachment(a).content;
    } catch {
      // Uszkodzony strumień jednego załącznika nie może zabrać całego maila.
      continue;
    }
    if (!content || content.length === 0) continue;
    const contentId = clean(a.pidContentId) || null;
    attachmentFiles.push({
      name,
      mime: clean(a.attachMimeTag),
      // Kopiujemy do własnego bufora — Uint8Array msgreadera jest widokiem na plik.
      data: Buffer.from(content),
      inline: a.attachmentHidden === true || !!contentId,
      contentId,
    });
  }

  return {
    subject: clean(data.subject) || clean(data.normalizedSubject) || clean(data.conversationTopic),
    from: formatAddress(data.senderName, clean(data.senderSmtpAddress) || clean(data.senderEmail)),
    to,
    cc,
    sentAt: toIso(data.clientSubmitTime, data.messageDeliveryTime, data.creationTime),
    bodyText,
    attachments,
    attachmentFiles,
  };
}

/**
 * Mail → czysty tekst: nagłówek (temat, od, do, data, załączniki), pusta linia,
 * treść. Pola bez wartości są POMIJANE — nie pokazujemy pustych etykiet.
 *
 * UWAGA: notatka mailowa trzyma nagłówek w KOLUMNACH (`kind='email'` + `mail_*`),
 * a w `text` samo body — kartę maila składa UI. Ta funkcja jest awaryjnym
 * spłaszczeniem do jednego stringa tam, gdzie karty nie ma: kopia notatki do
 * kartoteki obiektu, eksport, wyszukiwarka.
 */
export function formatMsgAsNote(p: Omit<ParsedMsg, "attachmentFiles">): string {
  const head: string[] = [];
  head.push(`\u{1f4e7} Temat: ${p.subject || "(bez tematu)"}`);
  if (p.from) head.push(`Od: ${p.from}`);
  if (p.to.length) head.push(`Do: ${p.to.join(", ")}`);
  if (p.cc.length) head.push(`DW: ${p.cc.join(", ")}`);
  if (p.sentAt) head.push(`Data: ${formatSentAt(p.sentAt)}`);
  if (p.attachments.length) head.push(`Załączniki: ${p.attachments.join(", ")}`);
  const body = normalizeText(p.bodyText);
  return normalizeText(body ? `${head.join("\n")}\n\n${body}` : head.join("\n"));
}
