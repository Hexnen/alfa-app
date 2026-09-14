/**
 * Protokół powykonawczy — logika edycji i podpisu, wspólna dla DWÓCH wejść:
 * biurowego (`src/routes/protocols.ts`, dialog na desktopie) i terenowego
 * (`src/routes/technik.ts`, tablet u klienta).
 *
 * Wydzielona z routera, żeby panel technika nie kopiował ani walidacji, ani —
 * co ważniejsze — kolejności rzeczy po podpisie. Podpis nie jest zwykłym
 * UPDATE: liczy `contentHash` z treści zapisanej w bazie (dowód integralności),
 * a PO commicie odpala automat uzupełniający realizację i przeliczenie wyceny.
 * Pominięcie któregokolwiek kroku w drugim wejściu dałoby protokoły podpisane
 * „inaczej” niż te z biura.
 *
 * Funkcje `*Sync` są synchroniczne (better-sqlite3) i pracują w PRZEKAZANEJ
 * transakcji; efekty po commicie są w `afterProtocolSigned` (async).
 */
import { createHash } from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { CALENDAR_NOTE_MAX, type Protocol } from "../db/schema.js";
import { AUTOFILL_SHORT_LABELS, autofillAfterProtocolSigned } from "./realization-autofill.js";
import type { ActivityUser, DbOrTx } from "./activity-log.js";
import { addNote, getNoteRow, type MutationCtx } from "./calendar-mutations.js";
import { refreshQuoteFromProtocolSync } from "../routes/quotes.js";
import type { ProtocolItem } from "./protocol-prefill.js";

/** Typ transakcji drizzle/better-sqlite3 — pozwala współdzielić helpery między db i tx. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Pozycje protokołu trzymamy jako JSON w kolumnie tekstowej, więc każde wyjście
 * do API musi je rozpakować. Uszkodzony JSON (ręczna edycja bazy, import) daje
 * pustą listę, a nie 500 — dokument z brakującymi pozycjami wciąż da się otworzyć
 * i poprawić.
 */
export function withParsedItems<T extends Protocol & { site?: string | null }>(
  p: T
): Omit<T, "items"> & { items: ProtocolItem[] } {
  let items: ProtocolItem[] = [];
  try {
    const parsed: unknown = JSON.parse(p.items);
    // `JSON.parse("{}")` / `"null"` / `"3"` nie rzuca, a niebędąca tablicą
    // wartość rozsypywała wszystko, co po niej iteruje (notatka systemowa
    // przestawała się aktualizować, bo `.filter` leciał wyjątkiem).
    items = Array.isArray(parsed) ? (parsed as ProtocolItem[]) : [];
  } catch {
    items = [];
  }
  return { ...p, items };
}

// ---------------------------------------------------------------------------
// Edycja (PUT /protocols/:id, PUT /technik/protocols/:id)
// ---------------------------------------------------------------------------

export type ProtocolUpdateOutcome =
  | { status: 200; data: Protocol }
  | { status: 404 }
  | { status: 409; signed?: boolean }
  | { status: 400; error: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Pozycje materiałowe z ciała żądania — same stringi, bez kwot (kwoty są w wycenie). */
export function parseProtocolItemsInput(raw: unknown): ProtocolItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    .map((i) => ({
      name: str(i.name),
      serial: str(i.serial),
      unit: str(i.unit),
      qty: str(i.qty),
    }));
}

/**
 * Pola, których panel technika nie ma prawa nadpisać (tożsamość klienta
 * i wykonawcy) — plus `status`.
 *
 * `status` jest tu, bo „final" znaczy PODPISANY, a podpis nadaje wyłącznie
 * `signProtocolSync` (razem z PNG, nazwiskiem i `contentHash`). Bez tej blokady
 * `PUT {"status":"final"}` z tabletu robił z brudnopisu dokument oznaczony jako
 * podpisany — bez podpisu, bez odbierającego i bez dowodu integralności.
 */
const CLIENT_LOCKED_FIELDS = [
  "clientName",
  "clientNip",
  "clientCity",
  "installationAddress",
  "contractor",
  "salesperson",
  "status",
] as const;

/** Tekstowe pola dokumentu — kolumny NULLABLE, więc `null` znaczy „wyczyść". */
const NULLABLE_TEXT_FIELDS = [
  "contractor",
  "salesperson",
  "clientName",
  "clientNip",
  "clientCity",
  "installationAddress",
  "contact",
  "activities",
] as const;

/** Ile dni od terminu zlecenia wolno wpisać jako datę wykonania z panelu. */
export const PANEL_WORK_DATE_TOLERANCE_DAYS = 7;

export interface ProtocolUpdateOptions {
  /**
   * Panel technika: pola identyfikacyjne klienta i wykonawcy są tylko do
   * odczytu. Technik u klienta poprawia zakres prac i materiały, a nie nazwę
   * zleceniodawcy — a starsza wersja panelu (albo ucięte ciało) potrafiła je
   * przysłać pustym stringiem i wyczyścić dokument.
   */
  lockClientFields?: boolean;
  /**
   * Termin zlecenia („RRRR-MM-DD") dla zapisów z panelu. Data wykonania musi
   * się trzymać ±`PANEL_WORK_DATE_TOLERANCE_DAYS` dni od niego: literówka na
   * tablecie („2019" zamiast „2026") wyrzucała protokół poza każdy raport
   * miesięczny i wracała z 200.
   */
  workDateAround?: string | null;
}

/** Dzień („RRRR-MM-DD") → liczba dni od epoki; NaN dla śmiecia. */
function dayNumber(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : NaN;
}

/**
 * Zapis treści protokołu. Odczyt i UPDATE w JEDNEJ transakcji (przekazanej przez
 * wołającego), więc między sprawdzeniem „czy podpisany” a zapisem nic się nie
 * wciśnie. `expectedUpdatedAt` = optimistic concurrency: niezgodność → 409,
 * zamiast po cichu nadpisać cudzą edycję.
 *
 * ZAPIS JEST CZĘŚCIOWY: zmieniają się WYŁĄCZNIE klucze obecne w ciele żądania
 * (`hasOwnProperty`). Wcześniej każde pole leciało przez `str()`, więc żądanie
 * z jednym polem (albo z ciałem uciętym przez zerwane łącze na tablecie)
 * zerowało cały dokument i zwracało na to 200.
 *
 * Podpisanego protokołu nie wolno zmieniać — treść rozjechałaby się z
 * `contentHash` i dowód integralności przestałby cokolwiek dowodzić.
 */
export function updateProtocolSync(
  tx: Tx,
  id: number,
  body: unknown,
  opts: ProtocolUpdateOptions = {}
): ProtocolUpdateOutcome {
  // `null`, tablica, liczba albo nieparsowalny JSON to nie jest protokół —
  // 400, a nie 500 (tak wyglądało `body: null` przed poprawką).
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, error: "Nieprawidłowe dane" };
  }
  const input = body as Record<string, unknown>;
  const locked = opts.lockClientFields ? new Set<string>(CLIENT_LOCKED_FIELDS) : new Set<string>();
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(input, key) && !locked.has(key);

  const workDate = str(input.workDate);
  if (has("workDate") && workDate && !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return { status: 400, error: "Nieprawidłowa data wykonania" };
  }
  // Data wykonania z panelu trzyma się terminu zlecenia (patrz `workDateAround`).
  if (has("workDate") && workDate && opts.workDateAround) {
    const around = dayNumber(opts.workDateAround.slice(0, 10));
    const target = dayNumber(workDate);
    if (Number.isFinite(around) && Number.isFinite(target) && Math.abs(target - around) > PANEL_WORK_DATE_TOLERANCE_DAYS) {
      return {
        status: 400,
        error: `Data wykonania musi mieścić się w ±${PANEL_WORK_DATE_TOLERANCE_DAYS} dniach od terminu zlecenia`,
      };
    }
  }
  // OBECNY KLUCZ Z BEZSENSOWNĄ WARTOŚCIĄ TO 400, NIE CICHE 200.
  // Wcześniej `items: "x"` przechodziło bez zapisu (parser oddawał `undefined`),
  // `activities: null` kasowało czynności do pustego stringa, a
  // `actualHours: null` wpisywało 0 — tablet z uciętym JSON-em dostawał
  // potwierdzenie zapisu, którego nie było albo który skasował treść.
  if (has("items") && !Array.isArray(input.items)) {
    return { status: 400, error: "Pole items: oczekiwano listy pozycji" };
  }
  for (const key of ["actualHours", "actualKm"] as const) {
    if (!has(key)) continue;
    const raw = input[key];
    const n = typeof raw === "string" ? parseFloat(raw.replace(",", ".")) : raw;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      return { status: 400, error: `Pole ${key}: oczekiwano liczby` };
    }
  }
  for (const key of NULLABLE_TEXT_FIELDS) {
    if (!has(key)) continue;
    const raw = input[key];
    if (typeof raw !== "string" && raw !== null) {
      return { status: 400, error: `Pole ${key}: oczekiwano tekstu` };
    }
  }
  const items = has("items") ? parseProtocolItemsInput(input.items) : undefined;
  const expectedUpdatedAt =
    typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : null;

  const rows = tx.select().from(schema.protocols).where(eq(schema.protocols.id, id)).limit(1).all();
  if (rows.length === 0) return { status: 404 };
  const existing = rows[0];

  if (existing.signaturePng || existing.contentHash) return { status: 409, signed: true };
  if (expectedUpdatedAt !== null && existing.updatedAt !== expectedUpdatedAt) return { status: 409 };

  const workType = ["serwis", "montaz", "wizja", "inne"].includes(input.workType as string)
    ? (input.workType as "serwis" | "montaz" | "wizja" | "inne")
    : existing.workType;

  /**
   * Pole tekstowe tylko wtedy, gdy przyszło w ciele (i nie jest zablokowane).
   * `null` = wyczyść kolumnę (wszystkie te kolumny są NULLABLE), a nie „wpisz
   * pusty string" — w dokumencie to ta sama pustka, ale w bazie już nie.
   */
  const text = (key: keyof Protocol & string): Record<string, string | null> =>
    has(key) ? { [key]: input[key] === null ? null : str(input[key]) } : {};

  const updated = tx
    .update(schema.protocols)
    .set({
      ...(has("workDate") ? { workDate: workDate || existing.workDate } : {}),
      ...(has("workType") ? { workType } : {}),
      ...(has("actualHours") ? { actualHours: num(input.actualHours) } : {}),
      ...(has("actualKm") ? { actualKm: num(input.actualKm) } : {}),
      ...text("contractor"),
      ...text("salesperson"),
      ...text("clientName"),
      ...text("clientNip"),
      ...text("clientCity"),
      ...text("installationAddress"),
      ...text("contact"),
      ...text("activities"),
      ...(items !== undefined ? { items: JSON.stringify(items) } : {}),
      // „final" NIE przychodzi z ciała żądania — nadaje go wyłącznie
      // `signProtocolSync` razem z podpisem (S1). Tu zostaje tylko powrót do
      // brudnopisu, żeby stare klienty wysyłające `status` nie dostawały 400.
      ...(has("status") ? { status: "draft" as const } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      expectedUpdatedAt !== null
        ? and(eq(schema.protocols.id, id), eq(schema.protocols.updatedAt, expectedUpdatedAt))
        : eq(schema.protocols.id, id)
    )
    .returning()
    .all();
  if (updated.length === 0) return { status: 409 };
  return { status: 200, data: updated[0] };
}

/** Komunikat 409 przy edycji — jeden tekst dla obu wejść. */
export function protocolConflictMessage(signed?: boolean): string {
  return signed
    ? "Protokół jest podpisany — usuń podpis przed edycją."
    : "Protokół został w międzyczasie zmieniony. Odśwież i spróbuj ponownie.";
}

// ---------------------------------------------------------------------------
// Podpis (POST /protocols/:id/sign, POST /technik/protocols/:id/sign)
// ---------------------------------------------------------------------------

/** Maksymalny rozmiar dataURL podpisu — kilkanaście kresek palcem mieści się z zapasem. */
export const SIGNATURE_MAX_LENGTH = 500_000;
export const SIGNATURE_PREFIX = "data:image/png;base64,";

export type SignatureCheck = { ok: true } | { ok: false; error: string };

/** Walidacja podpisu z ciała żądania (ten sam komunikat w biurze i w terenie). */
export function checkSignaturePng(signaturePng: string): SignatureCheck {
  if (!signaturePng.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, error: "Brak poprawnego podpisu (PNG)" };
  }
  if (signaturePng.length > SIGNATURE_MAX_LENGTH) {
    return { ok: false, error: "Podpis jest zbyt duży" };
  }
  return { ok: true };
}

/** Ile znaków nazwiska odbierającego trafia do dokumentu (reszta to już nie nazwisko). */
export const SIGNER_NAME_MAX = 120;

/**
 * Imię i nazwisko osoby odbierającej — wspólna walidacja obu wejść. `null`
 * znaczy „puste” (biuro potrafiło podpisać protokół bez nazwiska: dokument
 * z podpisem, ale bez wiadomo czyim).
 */
export function parseSignerName(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s ? s.slice(0, SIGNER_NAME_MAX) : null;
}

/** Jeden komunikat 400 dla obu wejść, gdy nazwiska brak. */
export const SIGNER_NAME_REQUIRED = "Podaj imię i nazwisko osoby odbierającej";

/** Komunikat 400, gdy klient nie przysłał znacznika wersji podpisywanej treści. */
export const SIGN_EXPECTED_UPDATED_AT_REQUIRED =
  "Brak znacznika wersji protokołu — odśwież dokument i podpisz ponownie";

export type ProtocolSignOutcome =
  | { status: 200; data: Protocol }
  | { status: 400; error: string }
  | { status: 404 }
  | { status: 409 };

/**
 * Podpisanie protokołu: PNG + imię i nazwisko + czas SERWERA + SHA-256 z treści.
 *
 * Hash liczy się z treści aktualnie zapisanej w bazie, w tej samej transakcji co
 * UPDATE — dzięki temu równoległa edycja nie może rozjechać podpisu z treścią
 * dokumentu, który klient miał przed oczami.
 *
 * `expectedUpdatedAt` jest WYMAGANY. Podpis poświadcza konkretną treść: bez
 * znacznika wersji klient podpisywał to, co akurat było w bazie — także cudzą
 * zmianę, która weszła między wyświetleniem dokumentu na tablecie a tapnięciem
 * „Podpisz”. Brak znacznika to 400, rozjazd to 409.
 */
export function signProtocolSync(
  tx: Tx,
  id: number,
  input: { signaturePng: string; signerName: string; expectedUpdatedAt?: string | null }
): ProtocolSignOutcome {
  const expectedUpdatedAt = input.expectedUpdatedAt ?? null;
  if (!expectedUpdatedAt) return { status: 400, error: SIGN_EXPECTED_UPDATED_AT_REQUIRED };
  const rows = tx.select().from(schema.protocols).where(eq(schema.protocols.id, id)).limit(1).all();
  if (rows.length === 0) return { status: 404 };
  const p = rows[0];
  if (p.updatedAt !== expectedUpdatedAt) return { status: 409 };

  const signedAt = new Date().toISOString();
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        number: p.number,
        workDate: p.workDate,
        workType: p.workType,
        actualHours: p.actualHours,
        actualKm: p.actualKm,
        contractor: p.contractor,
        clientName: p.clientName,
        clientNip: p.clientNip,
        installationAddress: p.installationAddress,
        activities: p.activities,
        items: p.items,
        signerName: input.signerName,
        signedAt,
      })
    )
    .update(input.signaturePng)
    .digest("hex");

  const updated = tx
    .update(schema.protocols)
    .set({
      signaturePng: input.signaturePng,
      signerName: input.signerName,
      signedAt,
      contentHash,
      status: "final",
      updatedAt: signedAt,
    })
    .where(and(eq(schema.protocols.id, id), eq(schema.protocols.updatedAt, expectedUpdatedAt)))
    .returning()
    .all();
  if (updated.length === 0) return { status: 409 };
  return { status: 200, data: updated[0] };
}

export interface ProtocolSignedEffects {
  autofill: { applied: string[]; warnings: string[]; message: string } | null;
  quote: { number: string; items: number; warnings: string[]; message: string } | null;
  /** Gotowy dopisek do komunikatu („Protokół podpisany — …”). */
  message: string;
}

/**
 * Skutki uboczne podpisu — WOŁAĆ PO commicie transakcji podpisu.
 *
 * Po podpisie znane są realne godziny i materiały, więc automat dolicza puste
 * pola realizacji, a wycena (jeśli istnieje i nikt jej nie ruszał) przelicza się
 * z protokołu — podpisany protokół jest dla niej źródłem prawdy.
 *
 * KAŻDY błąd jest połykany: podpis jest już zapisany i nie wolno go wywrócić
 * dlatego, że geokoder nie odpowiedział albo wycena miała nietypową pozycję.
 */
export async function afterProtocolSigned(
  realizationId: number | null,
  user: ActivityUser
): Promise<ProtocolSignedEffects> {
  let autofill: ProtocolSignedEffects["autofill"] = null;
  let quote: ProtocolSignedEffects["quote"] = null;

  if (realizationId != null) {
    const res = await autofillAfterProtocolSigned(realizationId, user);
    if (res && res.applied.length > 0) {
      autofill = {
        applied: res.applied,
        warnings: res.warnings,
        message: `Uzupełniono automatycznie: ${res.applied
          .map((f) => AUTOFILL_SHORT_LABELS[f])
          .join(", ")}`,
      };
    }

    try {
      const res2 = db.transaction((tx) => refreshQuoteFromProtocolSync(tx, realizationId, user));
      if (res2.status === "updated" && res2.number && res2.items) {
        quote = {
          number: res2.number,
          items: res2.items.length,
          warnings: res2.warnings,
          message: `wyceniono ${res2.items.length} ${res2.items.length === 1 ? "pozycję" : "pozycji"} w wycenie ${res2.number}`,
        };
      }
    } catch (err) {
      console.error("Przeliczenie wyceny z protokołu nie powiodło się:", err);
    }
  }

  const parts = [autofill?.message, quote?.message].filter(Boolean);
  return {
    autofill,
    quote,
    message: parts.length > 0 ? `Protokół podpisany — ${parts.join("; ")}` : "Protokół podpisany",
  };
}

// ---------------------------------------------------------------------------
// Notatka systemowa ze streszczeniem protokołu
//
// Biuro patrzy na kalendarz, nie na tablet — bez tego wpisu z wydarzenia widać
// tylko, ŻE protokół istnieje. JEDNA notatka na protokół (wskazuje ją
// `protocols.note_id`, migracja 0102), podmieniana przy każdym zapisie, przy
// podpisie i przy zdjęciu podpisu, żeby dziennik zlecenia nie puchł od kopii.
//
// Mieszka TUTAJ, a nie w routerze panelu, bo dokładnie tak samo musi zadziałać
// zapis z biura (src/routes/protocols.ts): protokół podpisany na desktopie
// zostawiał w kalendarzu notatkę „NIEPODPISANY”.
// ---------------------------------------------------------------------------

/** „14.09.2026 13:41” z ISO serwera — w notatce data ma być do przeczytania, nie do parsowania. */
function plDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** „Kamera IP 4MP, S/N 12345, 2 szt.” — puste części pomijamy. */
function itemLine(it: ProtocolItem): string {
  const name = (it.name ?? "").trim();
  const serial = (it.serial ?? "").trim();
  const qty = String(it.qty ?? "").trim();
  const unit = (it.unit ?? "").trim();
  const parts = [name || "(bez nazwy)"];
  if (serial) parts.push(`S/N ${serial}`);
  if (qty) parts.push(unit ? `${qty} ${unit}` : qty);
  return parts.join(", ");
}

/**
 * Adres protokołu w CRM — WZGLĘDNA ścieżka, ta sama co `protocolHref` we
 * froncie. Bez hosta świadomie: notatka żyje w bazie latami, a host z devu
 * (albo z tunelu) byłby w niej martwym linkiem po pierwszym wdrożeniu.
 * Składnia „tekst <ścieżka>” to wzorzec Outlooka, który rozumie już
 * `frontend/src/lib/linkify.ts` — renderuje ją jako link SPA z etykietą.
 */
export function protocolHrefOf(protocolId: number): string {
  return `/technical/protokoly?protocol=${protocolId}`;
}

export interface ProtocolNoteOptions {
  /**
   * Pominąć sekcję „Wykonane czynności”. Przy świeżo założonym protokole
   * czynności są PREFILLEM z tytułu i opisu wydarzenia (src/lib/protocol-prefill.ts)
   * — w dzienniku wyglądałyby jak praca, której jeszcze nikt nie wykonał.
   */
  skipActivities?: boolean;
}

/** Treść notatki: nagłówek ze stanem podpisu, czynności, urządzenia, link. */
export function protocolNoteText(
  protocol: Protocol,
  href: string,
  opts: ProtocolNoteOptions = {}
): string {
  const parsed = withParsedItems(protocol);
  const head = protocol.signedAt
    ? `Protokół ${protocol.number} — podpisany ${plDateTime(protocol.signedAt)}${
        protocol.signerName ? `, odebrał: ${protocol.signerName}` : ""
      }`
    : `Protokół ${protocol.number} — NIEPODPISANY`;

  const lines: string[] = [head];

  const activities = opts.skipActivities
    ? []
    : (protocol.activities ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
  // Puste sekcje pomijamy — „Wykonane czynności: —” to szum w dzienniku.
  if (activities.length) {
    lines.push("Wykonane czynności:");
    for (const a of activities) lines.push(`- ${a}`);
  }

  const items = parsed.items.filter((i) => (i.name ?? "").trim() || (i.serial ?? "").trim());
  if (items.length) {
    lines.push("Zamontowane urządzenia:");
    for (const it of items) lines.push(`- ${itemLine(it)}`);
  }

  lines.push(`Otwórz protokół <${href}>`);

  const text = lines.join("\n");
  // Protokół bywa dłuższy niż limit notatki (4000 znaków) — wtedy przycinamy
  // treść, ale link zostaje: pełna wersja i tak jest w samym protokole.
  if (text.length <= CALENDAR_NOTE_MAX) return text;
  const tail = `\n…\nOtwórz protokół <${href}>`;
  return `${text.slice(0, CALENDAR_NOTE_MAX - tail.length)}${tail}`;
}

/** Odcisk treści notatki, jaki trafia do `protocols.note_hash`. */
export function protocolNoteHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Czy TA notatka to nadal nasze lustro protokołu.
 *
 * ROZSTRZYGA ODCISK TREŚCI, nie znacznik czasu. Poprzednia wersja porównywała
 * `updated_at` notatki z `updated_at` protokołu — a notatkę odświeżamy w tej
 * samej transakcji, ZARAZ PO zapisie protokołu, więc warunek był zawsze
 * prawdziwy i dopisek biura ginął przy najbliższym zapisie, bez śladu.
 *
 * `note_hash` (migracja 0104) trzyma odcisk treści, którą ostatnio zapisaliśmy
 * SAMI: zgadza się z wierszem → nikt go nie ruszał. Rozjazd → treść jest obca.
 * `null` (protokół sprzed migracji) → zostaje stara heurystyka nagłówka.
 */
function isOwnProtocolNote(row: { text: string }, protocol: Protocol): boolean {
  if (protocol.noteHash) return protocolNoteHash(row.text) === protocol.noteHash;
  return row.text.startsWith(`Protokół ${protocol.number} —`);
}

/**
 * Zakłada albo aktualizuje notatkę systemową protokołu. Aktualizacja idzie
 * BEZPOŚREDNIM UPDATE-em, a nie przez `updateNote`: tamta funkcja wymaga, żeby
 * edytował autor albo admin, a notatkę zakłada ten technik, który pierwszy
 * dotknął protokołu — drugi technik z tej samej ekipy dostałby 403. Mija nas
 * też cały automat wzmianek dat (`@piątek`), bo tekst systemowy ich nie ma.
 *
 * EDYCJI BIURA NIE KASUJEMY. Gdy notatka przestała być naszym lustrem (ktoś
 * dopisał do niej zdanie), zakładamy NOWĄ notatkę systemową i przepinamy
 * `protocols.note_id` — stara zostaje w dzienniku razem z tym, co dopisano.
 *
 * Zwraca `true`, gdy cokolwiek w dzienniku się zmieniło.
 */
export function syncProtocolNote(
  tx: Tx,
  input: {
    eventId: number;
    protocol: Protocol;
    ctx: MutationCtx;
    href?: string;
    noteOptions?: ProtocolNoteOptions;
  }
): boolean {
  const href = input.href ?? protocolHrefOf(input.protocol.id);
  const text = protocolNoteText(input.protocol, href, input.noteOptions);
  const hash = protocolNoteHash(text);
  const existingId = input.protocol.noteId;
  if (existingId) {
    const row = getNoteRow(tx, existingId);
    if (row && !row.deletedAt) {
      if (row.text === text) {
        // Treść bez zmian, ale odcisku mogło nie być (protokół sprzed migracji
        // 0104) — uzupełniamy go, żeby kolejna edycja biura była wykrywalna.
        if (input.protocol.noteHash !== hash) {
          tx.update(schema.protocols)
            .set({ noteHash: hash })
            .where(eq(schema.protocols.id, input.protocol.id))
            .run();
        }
        return false;
      }
      if (isOwnProtocolNote(row, input.protocol)) {
        tx.update(schema.calendarEventNotes)
          .set({ text, updatedAt: sql`(datetime('now'))` })
          .where(eq(schema.calendarEventNotes.id, existingId))
          .run();
        tx.update(schema.protocols)
          .set({ noteHash: hash })
          .where(eq(schema.protocols.id, input.protocol.id))
          .run();
        return true;
      }
    }
  }
  const note = addNote(tx, { eventId: input.eventId, text, ctx: input.ctx, source: "system" });
  tx.update(schema.protocols)
    .set({ noteId: note.id, noteHash: hash })
    .where(eq(schema.protocols.id, input.protocol.id))
    .run();
  return true;
}

/** Wydarzenie kalendarza, w którego dzienniku ma wisieć streszczenie protokołu. */
export function eventIdForProtocol(dbx: DbOrTx, protocol: Protocol): number | null {
  const row = dbx
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(
      and(
        sql`(${schema.calendarEvents.protocolId} = ${protocol.id} OR ${schema.calendarEvents.realizationId} = ${protocol.realizationId})`,
        eq(schema.calendarEvents.department, "technical"),
        // Wydarzenie USUNIĘTE nie ma dziennika, który ktokolwiek czyta — notatka
        // protokołu lądowała w koszu, a biuro nie widziało jej nigdzie.
        isNull(schema.calendarEvents.deletedAt)
      )
    )
    // Bez porządku SQLite oddawał „pierwszy z brzegu" wiersz. Gdy realizację
    // wskazuje więcej niż jedno wydarzenie (przepięcie, kopia terminu),
    // streszczenie skakało między nimi przy kolejnych zapisach.
    .orderBy(desc(schema.calendarEvents.id))
    .get();
  return row?.id ?? null;
}

/**
 * Notatka nie może wywrócić zapisu protokołu — technik stoi u klienta i liczy
 * się dokument, a nie jego streszczenie w kalendarzu. Zwraca true, gdy coś
 * zmieniono (wtedy warto wysłać sygnał „notes” do otwartych kart biura).
 */
export function syncProtocolNoteSafely(
  eventId: number,
  protocol: Protocol,
  ctx: MutationCtx,
  noteOptions?: ProtocolNoteOptions
): boolean {
  try {
    return db.transaction((tx) => syncProtocolNote(tx, { eventId, protocol, ctx, noteOptions }));
  } catch (error) {
    console.error("[protokoły] Nie udało się zsynchronizować notatki protokołu:", error);
    return false;
  }
}

/**
 * To samo, ale wydarzenie odnajdujemy sami — wejście biurowe (PUT/sign/unsign
 * w src/routes/protocols.ts) nie ma go pod ręką. Brak wydarzenia (protokół
 * z realizacji założonej ręcznie) to normalny stan, nie błąd.
 */
export function syncProtocolNoteForOffice(protocol: Protocol, ctx: MutationCtx): boolean {
  const eventId = eventIdForProtocol(db, protocol);
  if (eventId == null) return false;
  return syncProtocolNoteSafely(eventId, protocol, ctx);
}

/**
 * Notatka protokołu, który właśnie znika. Twarde DELETE protokołu zostawiało
 * w dzienniku wpis z linkiem do nieistniejącego dokumentu — soft-usuwamy go
 * tak samo, jak robi to `deleteNote` (kalendarz filtruje po `deleted_at`).
 */
export function softDeleteProtocolNoteSync(tx: Tx, protocol: Protocol): void {
  if (protocol.noteId == null) return;
  tx.update(schema.calendarEventNotes)
    .set({ deletedAt: sql`(datetime('now'))`, updatedAt: sql`(datetime('now'))` })
    .where(
      and(
        eq(schema.calendarEventNotes.id, protocol.noteId),
        isNull(schema.calendarEventNotes.deletedAt)
      )
    )
    .run();
  tx.update(schema.protocols)
    .set({ noteId: null })
    .where(eq(schema.protocols.id, protocol.id))
    .run();
}
