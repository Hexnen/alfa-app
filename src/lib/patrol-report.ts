/**
 * Parser „raportu z podjazdów” (xlsx z systemu monitoringu, mailem jako
 * `raport_z_podjazdow_<data>_<godz>_<hash>.xlsx`). Kontrakt: docs/PODJAZDY-RAPORTY.md.
 *
 * Raport to DZIENNIK: jeden wiersz = jeden krok obsługi, wiersze zdarzenia łączy
 * „Identyfikator zdarzenia”. Kolumny zdarzenia (obiekt, załoga, godziny wyjazdu/
 * przyjazdu/odjazdu…) są powielone na każdym wierszu — bierzemy pierwszą
 * niepustą wartość w grupie.
 *
 * Danych NIE poprawiamy (przyjazd przed wyjazdem, kroki sprzed rozpoczęcia
 * zdarzenia, ujemny czas dojazdu to fakty z systemu) — tylko je oznaczamy
 * w `anomalies`, żeby raport per podjazd mógł je pokazać.
 *
 * Czysta funkcja (bez bazy) — import i dopasowanie obiektu: src/utils/patrol-import.ts.
 */
import * as XLSX from "xlsx";
import type { PatrolEventKind, PatrolStepKind } from "../db/schema.js";

export class PatrolParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatrolParseError";
  }
}

export interface ParsedPatrolStep {
  at: string | null;
  text: string;
  operator: string | null;
  kind: PatrolStepKind;
  seq: number;
}

export interface ParsedPatrolEvent {
  eventRef: string;
  objectName: string;
  street: string | null;
  no: string | null;
  postal: string | null;
  city: string | null;
  groups: string | null;
  alarmText: string | null;
  classification: string | null;
  eventType: string | null;
  manual: boolean;
  serviceType: string | null;
  startedAt: string | null;
  endedAt: string | null;
  dayPart: string | null;
  hasPatrol: boolean;
  crew: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  leftAt: string | null;
  maxTravelMin: number | null;
  travelMin: number | null;
  delayMin: number | null;
  travelStatus: string | null;
  delayBucket: string | null;
  late: boolean;
  operator: string | null;
  anomalies: string[];
  /** Rodzaj zdarzenia (v2) — patrz `detectPatrolHint` i `eventKindOf`. */
  eventKind: PatrolEventKind;
  /** Załoga wg notatki operatora (tylko gdy `crew` puste). */
  hintCrew: string | null;
  /** Przyjazd wg notatki (tylko gdy `arrivedAt` puste) — domysł, nie dane. */
  hintArrivedAt: string | null;
  /** Zdanie(a) źródłowe podpowiedzi, rozdzielone \n. */
  hintText: string | null;
  steps: ParsedPatrolStep[];
}

export interface ParsedPatrolReport {
  events: ParsedPatrolEvent[];
  rowCount: number;
}

/** Nagłówki kolumn (po nazwie — nie zakładamy pozycji). */
const H = {
  name: "Nazwa",
  street: "Ulica",
  no: "Nr",
  postal: "Kod pocztowy",
  city: "Miasto",
  groups: "Grupy",
  alarm: "Zdarzenie",
  startDate: "Data zdarzenia",
  startTime: "Godzina zdarzenia",
  endDate: "Data zakończenia zdarzenia",
  endTime: "Godzina zakończenia zdarzenia",
  classification: "Klasyfikacja",
  user: "Użytkownik",
  stepDate: "Data obsługi",
  stepTime: "Godzina obsługi",
  stepText: "Obsługa",
  startUser: "Użytkownik rozpoczynający obsługę",
  endUser: "Użytkownik kończący obsługę",
  crew: "Załoga",
  departed: "Godzina wyjazdu",
  arrived: "Godzina przyjazdu",
  left: "Godzina odjazdu",
  dayPart: "Pora dnia",
  maxTravel: "Maksymalny czas dojazdu",
  travel: "Czas dojazdu",
  delay: "Spóźnienie",
  travelStatus: "Status dojazdu",
  delayBucket: "Przedział spóźnienia",
  eventType: "Typ zdarzenia",
  eventRef: "Identyfikator zdarzenia",
  manual: "Zdarzenie manualne",
  serviceType: "Typ usługi",
} as const;

const REQUIRED: (keyof typeof H)[] = ["name", "eventRef", "stepText", "startDate", "startTime"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Komórka → przycięty tekst ('' dla pustej). Daty/liczby z Excela zamieniamy na tekst. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  return String(v).trim();
}

/** Data: „2026-10-08”, „08.10.2026”, serial Excela albo Date → `YYYY-MM-DD` | null. */
export function normDate(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
  }
  const s = cellText(v);
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return null;
}

/** Godzina: „1:00:14”, „19:30”, ułamek doby z Excela albo Date → `HH:MM:SS` | null. */
export function normTime(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const total = Math.round((v % 1) * 86400);
    return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }
  const s = cellText(v);
  if (!s) return null;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  const se = m[3] ? +m[3] : 0;
  if (h > 23 || mi > 59 || se > 59) return null;
  return `${pad(h)}:${pad(mi)}:${pad(se)}`;
}

function intOrNull(v: unknown): number | null {
  const s = cellText(v).replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function orNull(s: string): string | null {
  return s ? s : null;
}

function join(date: string | null, time: string | null): string | null {
  return date && time ? `${date}T${time}` : null;
}

function toMs(iso: string): number {
  return Date.parse(`${iso}Z`);
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * Godzina bez daty (wyjazd/przyjazd/odjazd) → pełny czas zakotwiczony przy
 * rozpoczęciu zdarzenia. Zdarzenie o 23:50 z wyjazdem 00:05 to następny dzień —
 * bierzemy dzień, przy którym odległość od kotwicy jest najmniejsza (±12 h).
 */
function anchorTime(time: string | null, anchor: string | null): string | null {
  if (!time || !anchor) return null;
  const base = toMs(`${anchor.slice(0, 10)}T${time}`);
  const a = toMs(anchor);
  const DAY = 86400_000;
  let best = base;
  for (const cand of [base - DAY, base + DAY]) {
    if (Math.abs(cand - a) < Math.abs(best - a)) best = cand;
  }
  return fromMs(best);
}

const hhmm = (iso: string | null) => (iso ? iso.slice(11, 19) : "?");

/** Klasyfikacja kroku obsługi po treści. Kolejność reguł ma znaczenie. */
export function classifyStep(text: string, operator: string | null): PatrolStepKind {
  const t = text.trim();
  if (/^safestar ai\b/i.test(t) || /^\(system\)$/i.test(operator ?? "")) return "ai";
  if (/^zakończenie obsługi zdarzenia/i.test(t)) return "end";
  if (/^rozpoczęcie obsługi zdarzenia/i.test(t)) return "start";
  if (/^patrol\s+interwencyjny\b.*-\s*na miejscu/i.test(t) || /^patrol na miejscu/i.test(t)) return "arrived";
  if (/^patrol\s+interwencyjny\b.*-\s*zakończenie obsługi/i.test(t) || /^odjazd patrolu/i.test(t)) return "left";
  if (/^wysłano\s+(pi|patrol)\b/i.test(t) || /^odwołanie pi\b.*wysłano nowy patrol/is.test(t)) return "dispatch";
  if (/^(podjęto próbę skontaktowania|wysłano sms|wysłano e-?mail|połączenie|rozmowa|zadzwoniono|nawiązano kontakt)/i.test(t)) {
    return "contact";
  }
  return "note";
}

/** Nazwa patrolu z kroku „Wysłano PI o nazwie X”. */
function crewFromStep(text: string): string | null {
  const m = /^wysłano\s+pi\s+o\s+nazwie\s+(.+?)\s*$/im.exec(text.trim());
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// v2: wzmianki o patrolu w notatkach operatora (patrol_hint) i wideopatrol AI.
// Dopasowane do prawdziwych tekstów z raportów 04–15.10 (docs/PODJAZDY-RAPORTY.md,
// „Backend v2 — stan”). Patrzymy WYŁĄCZNIE na kroki note/contact/dispatch — kroki
// AI („Safestar AI: … wideopatrol”, „Patrol interwencyjny … - na miejscu” od (system))
// i start/end (tryb „07 - WYSŁANIE -PATROL” ma KAŻDE zdarzenie) są pomijane.
// `(?<!\p{L})` przed „patrol” wyklucza „wideopatrol”.
// ---------------------------------------------------------------------------

/** Wysłanie patrolu: „wysłano patrol GROM”, „został wysłany patrol”, „Patrol na sprawdzenie obiektu”. */
const HINT_DISPATCH_RE: RegExp[] = [
  /(?<!\p{L})(?:wys[łl]ano|wys[łl]any|zadysponowano|skierowano)\s+(?:nowy\s+|kolejny\s+)?patrol(?!\p{L})/iu,
  /(?<!\p{L})patrol(?:\s+interwencyjny)?\s+(?:został\s+)?wys[łl]any(?!\p{L})/iu,
  /(?<!\p{L})patrol\s+na\s+sprawdzeni/iu,
];
/** Patrol/załoga na miejscu: „20:07 Załoga pod obiektem”, „01:24 patrol na miejscu”, „Patrol na obiekcie”. */
const HINT_ONSITE_RE =
  /(?<!\p{L})(?:patrol|załoga|zaloga)(?:\s+interwencyjn\p{L}*)?\s+(?:jest\s+|był\s+|była\s+)?(?:pod\s+obiektem|na\s+miejscu|na\s+obiekcie|przy\s+obiekcie|dojecha\p{L}*)(?!\p{L})/iu;
/** Odwołanie patrolu — samo w sobie dowód, że patrol był wysłany. */
const HINT_CANCEL_RE = /(?<!\p{L})odwoł\p{L}*\s+patrol|(?<!\p{L})patrol\p{L}*\s+odwoł/iu;
/** Godzina tuż przed „patrol/załoga … na miejscu”. */
const HINT_ONSITE_TIME_RE = /(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)\s*[-–:]?\s*(?:patrol|załoga|zaloga)(?!\p{L})/iu;
/** Nazwa załogi po „wysłano patrol”: wielka litera (GROM, SOLID, GROM GDAŃSK). Bez flagi i. */
const HINT_CREW_RE =
  /(?<!\p{L})[Pp]atrol\s+([A-ZĄĆĘŁŃÓŚŹŻ][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9-]*(?:\s+[A-ZĄĆĘŁŃÓŚŹŻ0-9][A-ZĄĆĘŁŃÓŚŹŻ0-9-]+)*)/u;
const HINT_CREW_STOP = new Set(["na", "do", "pod", "w", "z", "po", "przy", "nie", "jest", "został"]);
/** Segmenty o automatyce/wideopatrolu nigdy nie są podpowiedzią. */
const HINT_EXCLUDE_RE = /wideopatrol|safestar\s*ai/i;

export interface PatrolHint {
  /** Czy notatki wspominają wysłanie/obecność patrolu. */
  mentioned: boolean;
  crew: string | null;
  arrivedAt: string | null;
  /** Zdania źródłowe (wysłanie, przyjazd), unikalne, rozdzielone \n, max 500 zn. */
  text: string | null;
}

/** Notatka → segmenty: linie oraz podział przed wpisem „HH:MM …” po kropce. */
function hintSegments(text: string): string[] {
  return text
    .split(/\n+|(?<=[.;!])\s+(?=\d{1,2}[:.]\d{2}(?!\d))/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Szuka w krokach note/contact/dispatch wzmianek o patrolu. Czysta funkcja (eksport
 * dla testów). `anchor` (zwykle startedAt) kotwiczy godzinę z notatki przy dacie.
 */
export function detectPatrolHint(
  steps: Pick<ParsedPatrolStep, "kind" | "text" | "at">[],
  anchor: string | null
): PatrolHint {
  let dispatchSeg: string | null = null;
  let onsiteSeg: string | null = null;
  let crew: string | null = null;
  let arrivedAt: string | null = null;
  let mentioned = false;
  for (const s of steps) {
    if (s.kind !== "note" && s.kind !== "contact" && s.kind !== "dispatch") continue;
    let text = s.text;
    if (s.kind === "contact") {
      // SMS z treścią notatki — bierzemy samą treść w cudzysłowie.
      const m = /^wysłano\s+sms\s+"([\s\S]*)"\s+na\s+numer/i.exec(text.trim());
      if (!m) continue;
      text = m[1];
    }
    for (const seg of hintSegments(text)) {
      if (HINT_EXCLUDE_RE.test(seg)) continue;
      const isDispatch = HINT_DISPATCH_RE.some((re) => re.test(seg));
      const isOnsite = HINT_ONSITE_RE.test(seg);
      if (!isDispatch && !isOnsite && !HINT_CANCEL_RE.test(seg)) continue;
      mentioned = true;
      if (isDispatch) {
        if (!dispatchSeg) dispatchSeg = seg;
        if (!crew) {
          const m = HINT_CREW_RE.exec(seg);
          if (m && !HINT_CREW_STOP.has(m[1].toLowerCase())) crew = m[1].trim();
        }
      }
      if (isOnsite) {
        const t = HINT_ONSITE_TIME_RE.exec(seg);
        if (t && +t[1] <= 23 && +t[2] <= 59) {
          if (!arrivedAt) {
            arrivedAt = anchorTime(`${pad(+t[1])}:${t[2]}:00`, anchor ?? s.at);
            onsiteSeg = seg;
          }
        } else if (!onsiteSeg) {
          onsiteSeg = seg;
        }
      }
    }
  }
  const parts = [...new Set([dispatchSeg, onsiteSeg].filter((x): x is string => !!x))];
  const text = parts.length ? parts.join("\n").slice(0, 500) : null;
  return { mentioned, crew, arrivedAt, text };
}

/** Automatyczny wideopatrol Safestar AI (krok AI z „wideopatrol”). */
export function isVideoPatrol(steps: Pick<ParsedPatrolStep, "kind" | "text">[]): boolean {
  return steps.some((s) => s.kind === "ai" && /wideopatrol/i.test(s.text));
}

/**
 * Spóźnienie: liczba z kolumny „Spóźnienie” > 0, albo status dojazdu mówiący
 * o spóźnieniu, albo (gdy raport nie policzył) czas dojazdu > limit.
 */
function isLate(e: Pick<ParsedPatrolEvent, "delayMin" | "travelMin" | "maxTravelMin" | "travelStatus">): boolean {
  if (e.delayMin !== null && e.delayMin > 0) return true;
  const st = (e.travelStatus ?? "").toLowerCase();
  if (st && /spó[źz]n/.test(st) && !/(bez|nie)\s*spó[źz]n/.test(st)) return true;
  if (e.delayMin === null && e.travelMin !== null && e.travelMin >= 0 && e.maxTravelMin !== null) {
    return e.travelMin > e.maxTravelMin;
  }
  return false;
}

/** Wczytuje arkusz i zwraca wiersze jako tablice (raw — liczby/daty zostają typami). */
function readRows(buffer: Buffer): unknown[][] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  } catch {
    throw new PatrolParseError("Nie udało się odczytać pliku — to nie jest poprawny plik Excela.");
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new PatrolParseError("Plik nie zawiera żadnego arkusza.");
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: "", raw: true });
}

export function parsePatrolReport(buffer: Buffer): ParsedPatrolReport {
  const rows = readRows(buffer);

  // Wiersz nagłówka szukamy w pierwszych 20 (nad tabelą bywa tytuł raportu).
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => cellText(c));
    if (cells.includes(H.eventRef) && cells.includes(H.stepText)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new PatrolParseError(
      "To nie wygląda na raport z podjazdów — brak kolumn „Identyfikator zdarzenia” i „Obsługa”."
    );
  }
  const header = rows[headerIdx].map((c) => cellText(c));
  const col = {} as Record<keyof typeof H, number>;
  for (const [k, label] of Object.entries(H) as [keyof typeof H, string][]) {
    col[k] = header.indexOf(label);
  }
  const missing = REQUIRED.filter((k) => col[k] < 0).map((k) => H[k]);
  if (missing.length) {
    throw new PatrolParseError(`W raporcie brakuje kolumn: ${missing.join(", ")}.`);
  }
  const get = (r: unknown[], k: keyof typeof H): unknown => (col[k] >= 0 ? r[col[k]] : "");
  const txt = (r: unknown[], k: keyof typeof H): string => cellText(get(r, k));

  // Grupowanie po Identyfikatorze zdarzenia, z zachowaniem kolejności pierwszego wystąpienia.
  const groups = new Map<string, unknown[][]>();
  let rowCount = 0;
  for (const r of rows.slice(headerIdx + 1)) {
    const ref = txt(r, "eventRef");
    if (!ref) continue;
    rowCount++;
    let g = groups.get(ref);
    if (!g) groups.set(ref, (g = []));
    g.push(r);
  }
  if (groups.size === 0) throw new PatrolParseError("Raport nie zawiera żadnych zdarzeń.");

  const events: ParsedPatrolEvent[] = [];
  for (const [eventRef, grp] of groups) {
    /** Pierwsza niepusta wartość kolumny w grupie (kolumny zdarzenia są powielone). */
    const first = (k: keyof typeof H): unknown => {
      for (const r of grp) {
        const v = get(r, k);
        if (cellText(v)) return v;
      }
      return "";
    };
    const firstTxt = (k: keyof typeof H) => cellText(first(k));

    const startedAt = join(normDate(first("startDate")), normTime(first("startTime")));
    const endedAt = join(normDate(first("endDate")), normTime(first("endTime")));
    const anomalies: string[] = [];

    // Kroki: sortowane po czasie (stabilnie — remis zostaje w kolejności z pliku).
    const rawSteps = grp
      .map((r, i) => {
        const text = cellText(get(r, "stepText"));
        const operator = orNull(txt(r, "user"));
        return {
          i,
          at: join(normDate(get(r, "stepDate")), normTime(get(r, "stepTime"))),
          text,
          operator,
        };
      })
      .filter((s) => s.text);
    rawSteps.sort((a, b) => {
      if (a.at && b.at && a.at !== b.at) return a.at < b.at ? -1 : 1;
      if (!a.at !== !b.at) return a.at ? -1 : 1;
      return a.i - b.i;
    });
    const steps: ParsedPatrolStep[] = rawSteps.map((s, seq) => ({
      at: s.at,
      text: s.text,
      operator: s.operator,
      kind: classifyStep(s.text, s.operator),
      seq,
    }));

    // Załoga: kolumna, a gdy pusta — nazwa z kroku „Wysłano PI o nazwie X”.
    let crew = orNull(firstTxt("crew"));
    const dispatchStep = steps.find((s) => s.kind === "dispatch");
    if (!crew) {
      for (const s of steps) {
        const c = crewFromStep(s.text);
        if (c) {
          crew = c;
          break;
        }
      }
    }
    const hasPatrol = !!crew || steps.some((s) => /^wysłano\s+pi\b/i.test(s.text));

    let departedAt = anchorTime(normTime(first("departed")), startedAt);
    let arrivedAt = anchorTime(normTime(first("arrived")), startedAt);
    let leftAt = anchorTime(normTime(first("left")), startedAt);

    if (hasPatrol) {
      // Brakujące godziny uzupełniamy z kroków (i to oznaczamy — to nie dane z kolumn).
      const arrivedStep = steps.find((s) => s.kind === "arrived" && s.at);
      const leftStep = steps.find((s) => s.kind === "left" && s.at);
      if (!departedAt && dispatchStep?.at) {
        departedAt = dispatchStep.at;
        anomalies.push(`Godzina wyjazdu uzupełniona z kroku obsługi (${hhmm(departedAt)})`);
      }
      if (!arrivedAt && arrivedStep?.at) {
        arrivedAt = arrivedStep.at;
        anomalies.push(`Godzina przyjazdu uzupełniona z kroku obsługi (${hhmm(arrivedAt)})`);
      }
      if (!leftAt && leftStep?.at) {
        leftAt = leftStep.at;
        anomalies.push(`Godzina odjazdu uzupełniona z kroku obsługi (${hhmm(leftAt)})`);
      }
      if (!departedAt) anomalies.push("Brak godziny wyjazdu patrolu");
      if (!arrivedAt) anomalies.push("Brak godziny przyjazdu patrolu");
    }

    if (departedAt && arrivedAt && arrivedAt < departedAt) {
      anomalies.push(
        `Godzina przyjazdu (${hhmm(arrivedAt)}) jest wcześniejsza niż godzina wyjazdu (${hhmm(departedAt)})`
      );
    }
    if (arrivedAt && leftAt && leftAt < arrivedAt) {
      anomalies.push(`Godzina odjazdu (${hhmm(leftAt)}) jest wcześniejsza niż godzina przyjazdu (${hhmm(arrivedAt)})`);
    }
    if (startedAt && departedAt && departedAt < startedAt) {
      anomalies.push(`Wyjazd patrolu (${hhmm(departedAt)}) przed rozpoczęciem zdarzenia (${hhmm(startedAt)})`);
    }
    if (startedAt && endedAt && endedAt < startedAt) {
      anomalies.push(`Zakończenie zdarzenia (${hhmm(endedAt)}) przed jego rozpoczęciem (${hhmm(startedAt)})`);
    }
    if (startedAt) {
      const early = steps.filter((s) => s.at && s.at < startedAt && s.kind !== "ai");
      if (early.length) {
        anomalies.push(
          early.length === 1
            ? `Krok obsługi „${early[0].text.split("\n")[0].slice(0, 80)}” ma czas (${hhmm(early[0].at)}) sprzed rozpoczęcia zdarzenia (${hhmm(startedAt)})`
            : `${early.length} kroki obsługi mają czas sprzed rozpoczęcia zdarzenia (${hhmm(startedAt)}), najwcześniejszy ${hhmm(early[0].at)}`
        );
      }
    }

    const maxTravelMin = intOrNull(first("maxTravel"));
    let travelMin = intOrNull(first("travel"));
    if (travelMin !== null && travelMin < 0) {
      anomalies.push(`Ujemny czas dojazdu w raporcie (${travelMin} min)`);
    }
    if (travelMin === null && departedAt && arrivedAt && arrivedAt >= departedAt) {
      travelMin = Math.round((toMs(arrivedAt) - toMs(departedAt)) / 60000);
    }
    let delayMin = intOrNull(first("delay"));
    if (delayMin === null && travelMin !== null && travelMin >= 0 && maxTravelMin !== null && hasPatrol) {
      delayMin = Math.max(0, travelMin - maxTravelMin);
    }
    const travelStatus = orNull(firstTxt("travelStatus"));
    const late = hasPatrol && isLate({ delayMin, travelMin, maxTravelMin, travelStatus });
    if (late && delayMin !== null && delayMin > 0) {
      anomalies.push(`Spóźniony dojazd: ${delayMin} min ponad limit ${maxTravelMin ?? "?"} min`);
    }

    const manualTxt = firstTxt("manual").toLowerCase();

    // v2: rodzaj zdarzenia i podpowiedzi z notatek (has_patrol się NIE zmienia).
    const hint = detectPatrolHint(steps, startedAt);
    let eventKind: PatrolEventKind;
    let hintCrew: string | null = null;
    let hintArrivedAt: string | null = null;
    let hintText: string | null = null;
    if (hasPatrol) {
      eventKind = "patrol";
      if (!crew) hintCrew = hint.crew;
      if (!arrivedAt && hint.arrivedAt) {
        hintArrivedAt = hint.arrivedAt;
        // przy podjeździe pokazujemy tylko zdanie o przyjeździe
        hintText = hint.text?.split("\n").find((l) => HINT_ONSITE_RE.test(l)) ?? null;
      }
    } else if (hint.mentioned) {
      eventKind = "patrol_hint";
      hintCrew = hint.crew;
      hintArrivedAt = hint.arrivedAt;
      hintText = hint.text;
    } else {
      eventKind = isVideoPatrol(steps) ? "video_patrol" : "alarm";
    }

    events.push({
      eventRef,
      objectName: firstTxt("name") || "(bez nazwy)",
      street: orNull(firstTxt("street")),
      no: orNull(firstTxt("no")),
      postal: orNull(firstTxt("postal")),
      city: orNull(firstTxt("city")),
      groups: orNull(firstTxt("groups")),
      alarmText: orNull(firstTxt("alarm")),
      classification: orNull(firstTxt("classification")),
      eventType: orNull(firstTxt("eventType")),
      manual: manualTxt === "tak" || manualTxt === "1" || manualTxt === "true",
      serviceType: orNull(firstTxt("serviceType")),
      startedAt,
      endedAt,
      dayPart: orNull(firstTxt("dayPart")),
      hasPatrol,
      crew,
      departedAt,
      arrivedAt,
      leftAt,
      maxTravelMin,
      travelMin,
      delayMin,
      travelStatus,
      delayBucket: orNull(firstTxt("delayBucket")),
      late,
      operator: orNull(firstTxt("startUser")) ?? steps.find((s) => s.operator && s.kind !== "ai")?.operator ?? null,
      anomalies,
      eventKind,
      hintCrew,
      hintArrivedAt,
      hintText,
      steps,
    });
  }

  return { events, rowCount };
}
