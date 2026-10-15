/**
 * Czyste drobiazgi modułu „Podjazdy”: formaty dat, wyliczenie dojazdu vs limit,
 * kamienie milowe paska czasu i etykiety anomalii. Bez Reacta (fast refresh).
 */
import type { PatrolEventKind, PatrolEventRow, PatrolRelatedEvent, PatrolStepKind } from "@/lib/api";

export const DASH = "—";

export const errMsg = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

/** `2026-10-08T01:12:13` → Date (czas lokalny, bez strefy — tak przychodzi z systemu). */
export function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** „teraz” jako lokalne ISO bez strefy (ten sam format, co daty z raportu). */
export function localNowIso(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** „01:12” — godzina bez sekund. */
export function fmtTime(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : DASH;
}

/** „01:12:13” — z sekundami (oś kroków; operatorzy liczą czasem co do sekundy). */
export function fmtTimeSec(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` : DASH;
}

/** „08.10.2026” */
export function fmtDate(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}` : DASH;
}

/** „08.10.2026, 01:12” */
export function fmtDateTime(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${fmtDate(iso)}, ${fmtTime(iso)}` : DASH;
}

/** „czw. 08.10.2026” — nagłówek raportu (krótko, mieści się w kolumnie na telefonie). */
export function fmtLongDate(iso: string | null | undefined): string {
  const d = parseIso(iso);
  if (!d) return DASH;
  const wd = d.toLocaleDateString("pl-PL", { weekday: "short" }).replace(/\.$/, "");
  return `${wd}. ${fmtDate(iso)}`;
}

/** Różnica w minutach (b − a), z ułamkiem; null, gdy brakuje którejś daty. */
export function diffMin(a: string | null | undefined, b: string | null | undefined): number | null {
  const da = parseIso(a);
  const db = parseIso(b);
  if (!da || !db) return null;
  return (db.getTime() - da.getTime()) / 60000;
}

/** Minuty po polsku: 7 → „7 min”, 75 → „1 h 15 min”. */
export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return DASH;
  const sign = min < 0 ? "−" : "";
  const abs = Math.round(Math.abs(min));
  if (abs < 60) return `${sign}${abs} min`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h} h${m ? ` ${m} min` : ""}`;
}

/** Odmiana „podjazd”: 1 podjazd, 3 podjazdy, 5 podjazdów. */
export function pluralPatrols(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n === 1) return "podjazd";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "podjazdy";
  return "podjazdów";
}

/** Odmiana „zdarzenie”. */
export function pluralEvents(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n === 1) return "zdarzenie";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "zdarzenia";
  return "zdarzeń";
}

export const isTrue = (v: number | boolean | null | undefined) => v === true || v === 1;

/** Adres obiektu jedną linią: „ul. Plac Biały 5, 52-200 Wrocław”. */
export function fmtAddress(r: Pick<PatrolEventRow, "street" | "no" | "postal" | "city">): string | null {
  const street = [r.street, r.no].filter(Boolean).join(" ").trim();
  const town = [r.postal, r.city].filter(Boolean).join(" ").trim();
  return [street, town].filter(Boolean).join(", ") || null;
}

export type TravelVerdict = "ontime" | "late" | "invalid" | "unknown";

export interface TravelInfo {
  /**
   * Czas dojazdu w minutach (z ułamkiem). JEDNA definicja w całym froncie:
   * przyjazd − wyjazd z godzin, gdy obie są; inaczej „Czas dojazdu” z raportu.
   */
  travel: number | null;
  /** Czy `travel` policzyliśmy z godzin (a nie wzięli z kolumny raportu). */
  computed: boolean;
  limit: number | null;
  /** Spóźnienie (> 0) albo zapas (< 0) względem limitu. */
  delay: number | null;
  verdict: TravelVerdict;
  /** „Czas dojazdu” z kolumny raportu (system zaokrągla po swojemu). */
  reported: number | null;
  /** System ocenił inaczej niż nasze wyliczenie (spóźnienie vs w limicie). */
  systemDisagrees: boolean;
}

/**
 * Dojazd vs limit. Raport bywa niekompletny (pusty „Czas dojazdu” przy znanych
 * godzinach) albo sprzeczny (przyjazd przed wyjazdem → ujemny dojazd) — wtedy
 * werdykt „invalid”, a nie „w limicie”, bo −3 min to błąd danych, nie rekord.
 * Kolumna „Czas dojazdu” systemu bywa zaokrąglona w górę / liczona od innej bazy
 * (Wieliszew 3400122441: 22:08:46 → 22:25:54 = 17 min 8 s, raport: 18) — liczymy
 * z godzin, a status systemu (`late`) pokazujemy tylko, gdy przeczy wyliczeniu.
 */
export function travelInfo(
  r: Pick<PatrolEventRow, "travelMin" | "maxTravelMin" | "delayMin" | "departedAt" | "arrivedAt"> & { late?: boolean | number }
): TravelInfo {
  const reported = r.travelMin;
  const fromTimes = diffMin(r.departedAt, r.arrivedAt);
  const travel = fromTimes ?? reported;
  const computed = fromTimes != null;
  const limit = r.maxTravelMin;
  const sysLate = r.late === true || r.late === 1;
  let delay: number | null = null;
  let verdict: TravelVerdict = "unknown";
  if (travel != null && travel < 0) {
    verdict = "invalid";
  } else if (travel != null && limit != null) {
    delay = travel - limit;
    verdict = delay > 0 ? "late" : "ontime";
  } else if (sysLate || (r.delayMin != null && r.delayMin > 0)) {
    delay = r.delayMin;
    verdict = "late";
  }
  const systemDisagrees = (verdict === "ontime" && sysLate) || (verdict === "late" && r.late != null && !sysLate);
  return { travel, computed, limit, delay, verdict, reported, systemDisagrees };
}

/**
 * Uwagi do danych bez tego, co już mówi werdykt/chip dojazdu (spóźnienie, brak
 * przyjazdu, przyjazd przed wyjazdem) — wspólne dla listy (⚠) i panelu.
 */
export function extraAnomalies(anomalies: string[] | null | undefined, info: Pick<TravelInfo, "verdict">): string[] {
  return (anomalies ?? []).filter(
    (a) =>
      !/^Spóźniony dojazd/i.test(a) &&
      !(info.verdict === "unknown" && /brak godziny przyjazdu|missing_arrival/i.test(a)) &&
      !(info.verdict === "invalid" && /wcześniejsza niż godzina wyjazdu|ujemny czas dojazdu|arrived_before_departed|negative_travel/i.test(a))
  );
}

/** Czas z sekundami: 17.13 → „17 min 8 s”, 0.5 → „30 s”, 75 → „1 h 15 min”. */
export function fmtDuration(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return DASH;
  const sign = min < 0 ? "−" : "";
  const totalS = Math.round(Math.abs(min) * 60);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const sec = totalS % 60;
  if (h > 0) return `${sign}${h} h${m ? ` ${m} min` : ""}`;
  if (m === 0) return `${sign}${sec} s`;
  return `${sign}${m} min${sec ? ` ${sec} s` : ""}`;
}

export interface Milestone {
  key: "start" | "departed" | "arrived" | "left" | "end";
  label: string;
  at: string | null;
}

export function milestones(r: Pick<PatrolEventRow, "startedAt" | "departedAt" | "arrivedAt" | "leftAt" | "endedAt">): Milestone[] {
  return [
    { key: "start", label: "Zdarzenie", at: r.startedAt },
    { key: "departed", label: "Wyjazd", at: r.departedAt },
    { key: "arrived", label: "Przyjazd", at: r.arrivedAt },
    { key: "left", label: "Odjazd", at: r.leftAt },
    { key: "end", label: "Koniec", at: r.endedAt },
  ];
}

/** Etykiety kodów anomalii (gdy backend odda kod zamiast zdania — pokazujemy zdanie). */
const ANOMALY_LABELS: Record<string, string> = {
  arrived_before_departed: "Godzina przyjazdu jest wcześniejsza niż godzina wyjazdu — dane z systemu monitoringu.",
  step_before_start: "Część kroków obsługi ma czas sprzed rozpoczęcia zdarzenia.",
  missing_arrival: "Brak godziny przyjazdu patrolu.",
  missing_departure: "Brak godziny wyjazdu patrolu.",
  negative_travel: "Czas dojazdu w raporcie jest ujemny.",
  left_before_arrived: "Godzina odjazdu jest wcześniejsza niż godzina przyjazdu.",
};

export const anomalyLabel = (a: string) => ANOMALY_LABELS[a] ?? a;

export const STEP_KIND_LABEL: Record<PatrolStepKind, string> = {
  start: "Rozpoczęcie",
  dispatch: "Wysłanie patrolu",
  arrived: "Patrol na miejscu",
  left: "Zakończenie patrolu",
  contact: "Kontakt",
  ai: "Analiza AI",
  note: "Notatka",
  end: "Zakończenie",
};

/** Rodzaj zdarzenia; stary backend (bez `eventKind`) → z `hasPatrol`. */
export function eventKindOf(r: Pick<PatrolEventRow, "hasPatrol"> & { eventKind?: PatrolEventKind | null }): PatrolEventKind {
  return r.eventKind ?? (isTrue(r.hasPatrol) ? "patrol" : "alarm");
}

export const KIND_META: Record<PatrolEventKind, { label: string; short: string; chip: string; badge: string }> = {
  patrol: {
    label: "Podjazdy",
    short: "Podjazd",
    chip: "bg-indigo-600 text-white ring-indigo-600",
    badge: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  },
  patrol_hint: {
    label: "Możliwe podjazdy",
    short: "Możliwy podjazd",
    chip: "bg-amber-500 text-white ring-amber-500",
    badge: "bg-amber-100 text-amber-900 ring-amber-300",
  },
  alarm: {
    label: "Alarmy bez wyjazdu",
    short: "Bez wyjazdu",
    chip: "bg-slate-700 text-white ring-slate-700",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
  },
  video_patrol: {
    label: "Wideopatrol AI",
    short: "Wideopatrol AI",
    chip: "bg-violet-600 text-white ring-violet-600",
    badge: "bg-violet-50 text-violet-800 ring-violet-200",
  },
};

/** Kolejność chipów filtra „Rodzaj”. */
export const KIND_ORDER: PatrolEventKind[] = ["patrol", "patrol_hint", "alarm", "video_patrol"];
export const DEFAULT_KINDS: PatrolEventKind[] = ["patrol", "patrol_hint"];

export interface RelatedGroup {
  /** Pojedyncze zdarzenie (podjazd, możliwy podjazd) albo paczka podobnych alarmów. */
  items: PatrolRelatedEvent[];
  kind: PatrolEventKind;
  eventType: string | null;
}

/**
 * Burza alarmów: podjazdy i możliwe podjazdy zostają pojedynczo, reszta łączy się
 * w paczki po (rodzaj, typ zdarzenia) — „+17 podobnych alarmów”. Kolejność paczek
 * wg najwcześniejszego zdarzenia, w środku chronologicznie.
 */
export function groupRelated(list: PatrolRelatedEvent[]): RelatedGroup[] {
  const sorted = [...list].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const groups: RelatedGroup[] = [];
  const bucket = new Map<string, RelatedGroup>();
  for (const r of sorted) {
    const kind = eventKindOf(r);
    if (kind === "patrol" || kind === "patrol_hint") {
      groups.push({ items: [r], kind, eventType: r.eventType });
      continue;
    }
    const key = `${kind}|${r.eventType ?? ""}`;
    let g = bucket.get(key);
    if (!g) {
      g = { items: [], kind, eventType: r.eventType };
      bucket.set(key, g);
      groups.push(g);
    }
    g.items.push(r);
  }
  return groups;
}

const TYPE_FORMS: Record<string, [string, string, string]> = {
  alarm: ["alarm", "alarmy", "alarmów"],
  powiadomienie: ["powiadomienie", "powiadomienia", "powiadomień"],
  ostrzeżenie: ["ostrzeżenie", "ostrzeżenia", "ostrzeżeń"],
  awaria: ["awaria", "awarie", "awarii"],
};

/** „17 podobnych alarmów”, „3 podobne powiadomienia”, „1 alarm” — po typie zdarzenia z raportu. */
export function similarLabel(eventType: string | null, n: number): string {
  const f = TYPE_FORMS[(eventType ?? "").trim().toLowerCase()] ?? ["zdarzenie", "zdarzenia", "zdarzeń"];
  const n10 = n % 10;
  const n100 = n % 100;
  if (n === 1) return `1 ${f[0]}`;
  const few = n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14);
  return `${n} ${few ? "podobne" : "podobnych"} ${few ? f[1] : f[2]}`;
}

/** Czy backend wyczytał coś z notatki operatora (załoga / przyjazd / zdanie). */
export function hasHint(d: Pick<PatrolEventRow, "hintCrew" | "hintArrivedAt" | "hintText">): boolean {
  return Boolean(d.hintCrew || d.hintArrivedAt || d.hintText);
}
