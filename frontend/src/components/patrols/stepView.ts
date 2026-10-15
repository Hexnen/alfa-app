/**
 * Kroki obsługi z raportu monitoringu → model do wyświetlenia. Backend daje
 * `kind` (start/dispatch/…) i surowy tekst operatora; tu rozpoznajemy warianty
 * (odwołanie patrolu, próba kontaktu, SMS, AI), wyciągamy załogę/osobę/telefon
 * i czyścimy typowe śmieci z Safestara (cyfry ze spacjami, wielokrotne spacje,
 * puste linie). Bez Reacta (fast refresh).
 */
import type { PatrolEventStep, PatrolStepKind } from "@/lib/api";
import { STEP_KIND_LABEL } from "./patrolHelpers";

export type StepVariant =
  | "start"
  | "dispatch"
  | "cancel"
  | "arrived"
  | "left"
  | "confirm"
  | "call"
  | "sms"
  | "contact"
  | "ai"
  | "note"
  | "end";

export interface StepView {
  variant: StepVariant;
  title: string;
  /** Kamień milowy obsługi — mocniej wyróżniony na osi. */
  key: boolean;
  crew?: string | null;
  person?: string | null;
  /** Telefon już sformatowany („570 707 709”). */
  phone?: string | null;
  /** Cytowana treść (SMS) — z zachowanym podziałem na linie. */
  quote?: string | null;
  /** Reszta treści po wyciągnięciu pól; null, gdy tytuł mówi wszystko. */
  body?: string | null;
  /** Drobny dopisek pod tytułem (np. tryb zakończenia, źródło obrazu AI). */
  meta?: string | null;
  aiObjects?: string | null;
  /** Wynik obsługi patrolu („FAŁSZYWY ALARM Z POWIADOMIENIEM KLIENTA”) — idzie do karty „Co się stało”. */
  result?: string | null;
  /** Adres e-mail przy próbie kontaktu mailem. */
  email?: string | null;
}

/**
 * Sprzątanie tekstu operatora: „1 0 4  5 9 8 9 5” → „10459895”, „5( Solid” →
 * „5 (Solid”, „naruszeń ,” → „naruszeń,”, wielokrotne spacje → jedna,
 * ≥2 puste linie → jedna.
 */
export function tidyText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/\r/g, "")
    .replace(/(?<![\d:.,])\d(?:[ \u00a0]{1,3}\d){3,}(?![\d:])/g, (m) => m.replace(/[ \u00a0]/g, ""))
    .split("\n")
    .map((l) =>
      l
        .replace(/[ \t\u00a0]{2,}/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .replace(/([^\s(])\((?=[^\s)])/g, "$1 (")
        .replace(/\s+([,;!?])(?=\s|$)/g, "$1")
        .replace(/\s+\.(?=\s|$)/g, ".")
        .trim()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Spacje i wielkość liter bez znaczenia — do porównań nagłówków notatek. */
export const normKey = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Telefon do czytania: 9 cyfr → „570 707 709”, z prefiksem 48 → „+48 570 707 709”. */
export function fmtPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  const g3 = (x: string) => x.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
  if (d.length === 9) return g3(d);
  if (d.length === 11 && d.startsWith("48")) return `+48 ${g3(d.slice(2))}`;
  return raw.trim();
}

/** `tel:` z samymi cyframi (i plusem). */
export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** „ul.Plac Biały” → „ul. Plac Biały”. */
export const tidyAddress = (s: string | null) =>
  s ? s.replace(/\b(ul|al|pl|os)\.(?=\S)/gi, "$1. ").replace(/\s{2,}/g, " ") : s;

export function stepView(step: Pick<PatrolEventStep, "kind" | "text">): StepView {
  const raw = (step.text ?? "").trim();
  const kind: PatrolStepKind = step.kind;
  const fallback: StepView = {
    variant: kind,
    title: STEP_KIND_LABEL[kind] ?? "Krok",
    key: kind === "dispatch" || kind === "arrived" || kind === "left" || kind === "end",
    body: tidyText(raw) || null,
  };
  let m: RegExpExecArray | null;

  switch (kind) {
    case "start":
      if (/^rozpoczęcie obsługi zdarzenia\.?$/i.test(raw)) return { variant: "start", title: "Rozpoczęcie obsługi", key: false };
      return { ...fallback, title: "Rozpoczęcie obsługi" };
    case "end":
      if ((m = /^zakończenie obsługi zdarzenia(?:\s+w trybie:?\s*(.+))?$/is.exec(raw))) {
        return { variant: "end", title: "Zakończenie obsługi", key: true, meta: m[1] ? `tryb: ${tidyText(m[1])}` : null };
      }
      return { ...fallback, title: "Zakończenie obsługi" };
    case "dispatch":
      if ((m = /^odwołanie\s+pi\s+o\s+nazwie\s+(.+?)\s*[-–]\s*([\s\S]*)$/i.exec(raw))) {
        return {
          variant: "cancel",
          title: /wysłano nowy patrol/i.test(raw) ? "Odwołanie patrolu i wysłanie nowego" : "Odwołanie patrolu",
          key: true,
          crew: m[1].trim(),
          body: cap(tidyText(m[2])) || null,
        };
      }
      if (/^odwołanie\b/i.test(raw)) return { ...fallback, variant: "cancel", title: "Odwołanie patrolu" };
      if ((m = /^wysłano\s+(?:pi|patrol)\s+o\s+nazwie\s+(.+?)\s*$/i.exec(raw))) {
        return { variant: "dispatch", title: "Wysłanie patrolu", key: true, crew: m[1].trim() };
      }
      return { ...fallback, title: "Wysłanie patrolu" };
    case "arrived":
      if ((m = /^patrol\s+interwencyjny\s+(.+?)\s*[-–]\s*na miejscu\.?$/i.exec(raw))) {
        return { variant: "arrived", title: "Patrol na miejscu", key: true, crew: m[1].trim() };
      }
      return { ...fallback, title: "Patrol na miejscu" };
    case "left":
      if ((m = /^patrol\s+interwencyjny\s+(.+?)\s*[-–]\s*zakończenie obsługi(?::\s*([\s\S]+?))?\.?$/i.exec(raw))) {
        return { variant: "left", title: "Patrol kończy obsługę", key: true, crew: m[1].trim(), result: m[2] ? tidyText(m[2]) : null };
      }
      return { ...fallback, title: "Odjazd patrolu" };
    case "contact":
      if ((m = /^wysłano\s+sms\s+"([\s\S]*)"\s+na\s+numer\s+"([^"]+)"(?:\s*\(([\s\S]+)\))?\s*\.?$/i.exec(raw))) {
        return {
          variant: "sms",
          title: "Wysłano SMS",
          key: false,
          quote: tidyText(m[1]) || null,
          phone: fmtPhone(m[2]),
          person: m[3]?.trim() || null,
        };
      }
      if ((m = /^podjęto próbę skontaktowania\s+z\s+osobą\s+"([^"]+)"(?:\s+poprzez\s+nr\s+telefonu\s+"([^"]+)")?\s*\.?$/i.exec(raw))) {
        return { variant: "call", title: "Próba kontaktu", key: false, person: tidyText(m[1]), phone: fmtPhone(m[2]) };
      }
      if ((m = /^podjęto próbę skontaktowania\s+z\s+osobą\s+"([^"]+)"\s+poprzez\s+adres\s+e-?mail\s+"([^"]+)"\s*\.?$/i.exec(raw))) {
        return { variant: "call", title: "Próba kontaktu (e-mail)", key: false, person: tidyText(m[1]), email: m[2].trim() };
      }
      return { ...fallback, variant: "contact", title: "Kontakt" };
    case "ai": {
      // Statusy patrolu z aplikacji (krok „(system)”): to te same kamienie milowe co wysłanie/przyjazd/odjazd.
      if ((m = /^patrol\s+interwencyjny\s+(.+?)\s*[-–]\s*(potwierdzony|na miejscu|zakończenie obsługi)(?::\s*([\s\S]+?))?\.?$/i.exec(raw))) {
        const st = m[2].toLowerCase();
        if (st === "potwierdzony") return { variant: "confirm", title: "Patrol potwierdził przyjęcie", key: false, crew: m[1].trim() };
        if (st === "na miejscu") return { variant: "arrived", title: "Patrol na miejscu", key: true, crew: m[1].trim() };
        return { variant: "left", title: "Patrol kończy obsługę", key: true, crew: m[1].trim(), result: m[3] ? tidyText(m[3]) : null };
      }
      const body = raw.replace(/^safestar ai:\s*/i, "");
      const objs = /wykryto obiekty:\s*([^.\n]+)/i.exec(body)?.[1]?.trim() ?? null;
      const src = /\(([^)]*)\)\s*$/.exec(body)?.[1] ?? null;
      if (objs) {
        const [where, ...rest] = (src ?? "").split(";").map((x) => x.trim());
        const camera = rest.join("; ") || null;
        return {
          variant: "ai",
          title: "Analiza AI",
          key: false,
          aiObjects: objs,
          body: camera ? tidyText(camera) : null,
          meta: where ? tidyText(where) : null,
        };
      }
      return { ...fallback, title: "Analiza AI", body: tidyText(body) || null };
    }
    case "note":
    default:
      return { ...fallback, variant: "note", title: "Notatka operatora", key: false };
  }
}

/** Notatka „długa” (>2 wiersze lub >180 zn.) — na osi czytana jako chronologia, nie jedna linia. */
export function isLongNote(text: string): boolean {
  const t = tidyText(text);
  return t.split("\n").filter((l) => l.trim()).length > 2 || t.length > 180;
}

export type NoteLine = { type: "time"; time: string; text: string } | { type: "text"; text: string } | { type: "gap" };

export interface NoteEntry {
  lines: NoteLine[];
}

const CHRONO_RE = /^(\d{1,2})[:.](\d{2})\b\s*[-–:]?\s*(.*)$/;

/**
 * Notatka operatora → wpisy. Operator zwykle zaczyna każdy wpis od nazwy obiektu
 * (powtórzonej) i pisze mini-chronologię „01:24 patrol na miejscu…”. Nazwę obiektu
 * zdejmujemy (jest w nagłówku), powtórzony nagłówek dzieli notatkę na wpisy,
 * linie z godziną stają się wierszami chronologii.
 */
export function parseNote(text: string, objectName: string | null): NoteEntry[] {
  const lines = tidyText(text).split("\n");
  const obj = normKey(objectName);
  // Nagłówek wpisu: nazwa obiektu albo pierwsza linia powtórzona dokładnie w notatce.
  const first = normKey(lines[0]);
  const repeatedFirst = first.length > 0 && !CHRONO_RE.test(lines[0]) && lines.filter((l) => normKey(l) === first).length >= 2;
  const isHeader = (l: string) => {
    const k = normKey(l);
    return (obj.length > 0 && k === obj) || (repeatedFirst && k === first);
  };
  const entries: NoteEntry[] = [];
  let cur: NoteEntry = { lines: [] };
  const push = () => {
    while (cur.lines.length && cur.lines[cur.lines.length - 1].type === "gap") cur.lines.pop();
    if (cur.lines.length) entries.push(cur);
    cur = { lines: [] };
  };
  for (const l of lines) {
    if (isHeader(l)) {
      push();
      continue;
    }
    if (!l.trim()) {
      if (cur.lines.length && cur.lines[cur.lines.length - 1].type !== "gap") cur.lines.push({ type: "gap" });
      continue;
    }
    const m = CHRONO_RE.exec(l);
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60 && m[3]) {
      cur.lines.push({ type: "time", time: `${m[1].padStart(2, "0")}:${m[2]}`, text: m[3] });
    } else {
      cur.lines.push({ type: "text", text: l });
    }
  }
  push();
  return entries;
}

/**
 * Czy treść (np. SMS) powtarza wcześniejsze notatki operatora — wtedy na osi
 * pokazujemy ją zwiniętą. Linia z samą nazwą obiektu się nie liczy; wystarczy,
 * że ≥75% pozostałych linii występuje w notatkach.
 */
export function isEcho(text: string, sources: string[], objectName: string | null): boolean {
  const norm = (s: string) => normKey(tidyText(s)).replace(/[^\p{L}\p{N}:]+/gu, " ").trim();
  const hay = norm(sources.join("\n"));
  if (!hay) return false;
  const obj = norm(objectName ?? "");
  const lines = tidyText(text)
    .split("\n")
    .map(norm)
    .filter((l) => l && l !== obj);
  if (lines.length === 0) return false;
  return lines.filter((l) => hay.includes(l)).length / lines.length >= 0.75;
}

/** Liczba widocznych wierszy notatki (do decyzji o zwinięciu). */
export const noteLineCount = (entries: NoteEntry[]) =>
  entries.reduce((n, e) => n + e.lines.filter((l) => l.type !== "gap").length, 0) + Math.max(0, entries.length - 1);

/** Podział tekstu na kawałki z godzinami „01:24” do pogrubienia. */
export function splitTimes(s: string): { t: string; time: boolean }[] {
  const out: { t: string; time: boolean }[] = [];
  const re = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: s.slice(last, m.index), time: false });
    out.push({ t: m[0], time: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last), time: false });
  return out;
}

/* Wideopatrol AI: kontrole kamer z kroków „Safestar AI: Obraz …”. */
export interface CameraCheck {
  step: PatrolEventStep;
  camera: string;
  source: string;
  ok: boolean;
  result: string;
  similarity: number | null;
}

const CAMERA_RE = /Obraz\s+([^(]+?)\s*(?:\(podobie[ńn]stwo\s*(\d+)\s*%\))?\.?\s*\(([^)]+)\)\s*$/i;

/** „Safestar AI: Obraz poprawny (podobieństwo 92%).\n(RolosWyszkow: R.10)” → kamera R.10, 92%. */
export function parseCameraCheck(step: PatrolEventStep): CameraCheck | null {
  if (step.kind !== "ai") return null;
  const m = CAMERA_RE.exec(step.text.replace(/\s+/g, " ").trim());
  if (!m) return null;
  const result = m[1].trim();
  const src = m[3].trim();
  const idx = src.lastIndexOf(":");
  return {
    step,
    result,
    ok: /^poprawny$/i.test(result),
    similarity: m[2] != null ? Number(m[2]) : null,
    camera: idx >= 0 ? src.slice(idx + 1).trim() : src,
    source: idx >= 0 ? src.slice(0, idx).trim() : "",
  };
}

/** Kroki wideopatrolu rozdzielone na kontrole kamer i resztę (start/koniec/uwagi). */
export function splitVideoSteps(steps: PatrolEventStep[]) {
  const checks: CameraCheck[] = [];
  const rest: PatrolEventStep[] = [];
  for (const s of steps) {
    const c = parseCameraCheck(s);
    if (c) checks.push(c);
    else rest.push(s);
  }
  const camKey = (c: string) => c.replace(/\d+/g, (d) => d.padStart(4, "0"));
  checks.sort((a, b) => camKey(a.camera).localeCompare(camKey(b.camera)));
  return { checks, rest };
}
