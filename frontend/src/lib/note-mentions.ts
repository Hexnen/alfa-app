/**
 * Wzmianki dat w notatkach wydarzeń: `@piątek`, `@jutro`, `@15.09`, `@2026-09-15`…
 * Czysty moduł bez zależności — IDENTYCZNA kopia leży w frontend/src/lib/note-mentions.ts
 * (front nie importuje z backendu). Zmieniając jeden plik, zmień drugi.
 *
 * Zasady rozstrzygania (kotwica `today` = "YYYY-MM-DD" w czasie warszawskim):
 * - dzień tygodnia → NAJBLIŻSZY taki dzień PO dniu kotwicy (1–7 dni; „@piątek” w piątek = za tydzień),
 * - @dziś/@dzisiaj = kotwica, @jutro = +1, @pojutrze = +2,
 * - data bez roku (@15.09, @15/09, @15.9) → bieżący rok; jeśli wypada > 30 dni PRZED kotwicą, następny rok,
 * - data z rokiem (@15.09.2026, @2026-09-15, @15.09.26) → dosłownie,
 * - nieznany token po „@” (np. e-mail, @Jan) → pomijany (nie jest wzmianką).
 * Token kończy się na białym znaku / interpunkcji (.,;:!?) / końcu tekstu; wielkość liter i
 * polskie znaki bez znaczenia (piatek == Piątek).
 */

export interface NoteMention {
  /** Dokładny fragment tekstu, np. "@piątek" */
  raw: string;
  /** Klucz znormalizowany — identyfikuje wzmiankę przy resynchronizacji (np. "piatek", "jutro", "2026-09-15") */
  key: string;
  /** Pozycja w tekście [start, end) */
  start: number;
  end: number;
  /** Rozstrzygnięta data "YYYY-MM-DD" */
  date: string;
  /** Etykieta do wyświetlenia, np. "piątek 11.09" */
  label: string;
}

const WEEKDAYS = ["niedziela", "poniedzialek", "wtorek", "sroda", "czwartek", "piatek", "sobota"];
const WEEKDAY_LABELS = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];
const WEEKDAY_ALIASES: Record<string, number> = {
  niedziela: 0, nd: 0, ndz: 0, niedz: 0,
  poniedzialek: 1, pon: 1, pn: 1,
  wtorek: 2, wt: 2,
  sroda: 3, sr: 3,
  czwartek: 4, czw: 4,
  piatek: 5, pt: 5,
  sobota: 6, sob: 6, sb: 6,
};
const RELATIVE: Record<string, number> = { dzis: 0, dzisiaj: 0, jutro: 1, pojutrze: 2 };

/** Znormalizowany token: małe litery, bez polskich znaków. */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e").replace(/ł/g, "l")
    .replace(/ń/g, "n").replace(/ó/g, "o").replace(/ś/g, "s").replace(/ż/g, "z").replace(/ź/g, "z");
}

const pad = (n: number) => String(n).padStart(2, "0");
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDateStr(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
export function addDays(dateStr: string, n: number): string {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}
function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(y, m - 1, d, 12);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}
function daysBetween(a: string, b: string): number {
  return Math.round((parseDateStr(b).getTime() - parseDateStr(a).getTime()) / 86_400_000);
}

/** Etykieta wzmianki, np. "piątek 11.09" / "jutro 09.09" / "15.09.2026". */
export function mentionLabel(date: string, key: string): string {
  const d = parseDateStr(date);
  const dm = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  if (key in RELATIVE) return `${key === "dzis" ? "dziś" : key} ${dm}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return `${WEEKDAY_LABELS[d.getDay()]} ${dm}.${d.getFullYear()}`;
  return `${WEEKDAY_LABELS[d.getDay()]} ${dm}`;
}

/** Rozstrzyga pojedynczy token (bez „@”) na datę; null = to nie jest wzmianka daty. */
export function resolveToken(rawToken: string, today: string): { key: string; date: string } | null {
  const tok = normalizeToken(rawToken);
  if (!tok) return null;
  if (tok in RELATIVE) return { key: tok, date: addDays(today, RELATIVE[tok]) };
  if (tok in WEEKDAY_ALIASES) {
    const target = WEEKDAY_ALIASES[tok];
    const cur = parseDateStr(today).getDay();
    let diff = (target - cur + 7) % 7;
    if (diff === 0) diff = 7;
    return { key: WEEKDAYS[target], date: addDays(today, diff) };
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tok);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isValidYmd(y, mo, d)) return null;
    const date = `${y}-${pad(mo)}-${pad(d)}`;
    return { key: date, date };
  }
  m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/.exec(tok);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      if (!isValidYmd(y, mo, d)) return null;
      const date = `${y}-${pad(mo)}-${pad(d)}`;
      return { key: date, date };
    }
    const y0 = parseDateStr(today).getFullYear();
    let y = y0;
    if (!isValidYmd(y, mo, d)) {
      // np. 29.02 w roku nieprzestępnym — spróbuj następnego roku
      if (!isValidYmd(y + 1, mo, d)) return null;
      y = y + 1;
    }
    let date = `${y}-${pad(mo)}-${pad(d)}`;
    if (daysBetween(today, date) < -30 && isValidYmd(y + 1, mo, d)) date = `${y + 1}-${pad(mo)}-${pad(d)}`;
    return { key: `${pad(d)}.${pad(mo)}`, date };
  }
  return null;
}

const TOKEN_RE = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}./-]+)/gu;

/** Wszystkie wzmianki dat w tekście (w kolejności wystąpienia). Powtórzony klucz zwracany wielokrotnie. */
export function parseMentions(text: string, today: string): NoteMention[] {
  const out: NoteMention[] = [];
  if (!text) return out;
  for (const m of text.matchAll(TOKEN_RE)) {
    let token = m[2];
    // odetnij interpunkcję na końcu (np. "@piątek." / "@15.09,")
    token = token.replace(/[./-]+$/, "");
    if (!token) continue;
    const res = resolveToken(token, today);
    if (!res) continue;
    const start = (m.index ?? 0) + m[1].length;
    const raw = `@${token}`;
    out.push({ raw, key: res.key, start, end: start + raw.length, date: res.date, label: mentionLabel(res.date, res.key) });
  }
  return out;
}

/** Unikalne klucze wzmianek → data (pierwsze wystąpienie wygrywa). */
export function mentionKeys(text: string, today: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of parseMentions(text, today)) if (!map.has(m.key)) map.set(m.key, m.date);
  return map;
}

/** Podpowiedzi autouzupełniania po „@” — do UI. */
export function mentionSuggestions(prefix: string, today: string): Array<{ token: string; date: string; label: string }> {
  const base = ["dziś", "jutro", "pojutrze", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];
  const p = normalizeToken(prefix);
  return base
    .filter((t) => !p || normalizeToken(t).startsWith(p))
    .map((t) => {
      const r = resolveToken(t, today)!;
      return { token: t, date: r.date, label: mentionLabel(r.date, r.key) };
    });
}
