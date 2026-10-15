/**
 * Model osi obsługi w panelu podjazdu — zasada „każdy fakt raz”
 * (docs/PODJAZDY-RAPORTY.md → „Panel boczny v3” → „Dedup”):
 * - statusy patrolu z aplikacji („Patrol interwencyjny X - potwierdzony / na miejscu /
 *   zakończenie obsługi”) to te same kamienie milowe co wysłanie/przyjazd/odjazd —
 *   duplikaty (±1 min) scalane, „potwierdzony” → dopisek pod wysłaniem;
 * - krótka notatka zaczynająca się godziną zgodną (±2 min) z kamieniem milowym →
 *   komentarz pod tym kamieniem (bez powtórzonego „Załoga na miejscu”);
 * - kolejne próby kontaktu do tej samej osoby (e-mail, telefon, SMS) → jeden wpis
 *   z kanałami; SMS powtarzający notatkę — zwinięty;
 * - wpisy techniczne („Brak podglądu”, „Zmiana stanu wyjścia…”, rozpoczęcie obsługi)
 *   → jednolinijkowce, a ≥3 pod rząd → zwinięta grupa „Czynności w systemie (n)”.
 * Bez Reacta (fast refresh).
 */
import type { PatrolEventDetail, PatrolEventStep } from "@/lib/api";
import { fmtTime, parseIso } from "./patrolHelpers";
import { isEcho, isLongNote, normKey, stepView, tidyText, type StepView } from "./stepView";

export interface TimelineComment {
  text: string;
  operator: string | null;
}

export interface ContactChannel {
  kind: "email" | "phone" | "sms" | "other";
  step: PatrolEventStep;
  value: string | null;
  quote?: string | null;
  /** SMS powtarza notatkę z tej godziny (HH:MM) — wtedy zwinięty. */
  echoOf?: string | null;
}

export type TimelineEntry =
  | {
      type: "step";
      step: PatrolEventStep;
      v: StepView;
      comments: TimelineComment[];
      /** Dopiski z innych kroków (np. „patrol potwierdził przyjęcie po 28 s”). */
      extras: string[];
      at: string | null;
      lastAt: string | null;
      echoOf?: string | null;
    }
  | { type: "contact"; person: string; channels: ContactChannel[]; at: string | null; lastAt: string | null }
  | { type: "system"; items: { step: PatrolEventStep; text: string; full: string }[]; at: string | null; lastAt: string | null };

const MILESTONES = new Set(["dispatch", "cancel", "arrived", "left", "end"]);

/** Wpis techniczny → krótki tekst; null = zwykły krok. */
export function systemLine(step: PatrolEventStep, v: StepView): string | null {
  const raw = tidyText(step.text);
  if (v.variant === "start" && !v.body) return "Rozpoczęcie obsługi";
  // Start/koniec wideopatrolu — wynik jest w werdykcie, tu tylko znacznik czasu.
  if (step.kind === "ai" && /rozpoczęcie automatycznego wideopatrolu/i.test(raw)) return "Start wideopatrolu";
  if (step.kind === "ai" && /zakończono automatyczny wideopatrol/i.test(raw)) return "Koniec wideopatrolu";
  if (step.kind !== "note") return null;
  if (/^brak podglądu\.?$/i.test(raw)) return "Brak podglądu";
  const m = /^zmiana stanu wyjścia\s+"([^"]+)"(?:\s+w urządzeniu\s+"[^"]+")?\s+na:?\s*([^\n]+?)(?:\s+przez\s+[\s\S]*)?$/i.exec(raw);
  if (m) return `Wyjście „${m[1]}” → ${m[2].trim()}`;
  if (/^zmiana stanu wyjścia/i.test(raw)) return raw.split("\n")[0];
  return null;
}

const personKey = (p: string | null | undefined) => normKey((p ?? "").replace(/\([^)]*\)/g, ""));

/** Minuta doby notatki „22:25 …” najbliższa czasowi `at` (ta sama doba ±12 h). */
function noteTimeNear(text: string, at: string | null): number | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})\b/.exec(text);
  const d = parseIso(at);
  if (!m || !d) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const t = new Date(d);
  t.setHours(h, mi, 0, 0);
  let diff = (t.getTime() - d.getTime()) / 60000;
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

/** „22:25 Załoga na miejscu - Obiekt sprawdzony.” → „Obiekt sprawdzony.” (tytuł kamienia mówi resztę). */
function commentText(text: string): string {
  let t = tidyText(text).replace(/^\s*\d{1,2}[:.]\d{2}\b\s*[-–:]?\s*/, "");
  t = t.replace(/^(?:załoga|patrol)\s+(?:jest\s+)?(?:na miejscu|pod obiektem|na obiekcie)\s*[-–:,.]?\s*/i, "");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function buildTimeline(detail: PatrolEventDetail): TimelineEntry[] {
  const steps = [...(detail.steps ?? [])].sort((a, b) => a.seq - b.seq);
  const out: TimelineEntry[] = [];
  const notesSeen: PatrolEventStep[] = [];
  const views = steps.map((s) => {
    const v = stepView(s);
    // „tryb: 07 - WYSŁANIE -PATROL” powtarza klasyfikację (jest w „Szczegółach”).
    if (v.variant === "end" && v.meta && detail.classification && normKey(v.meta).endsWith(normKey(detail.classification))) v.meta = null;
    return v;
  });
  const minutesBetween = (a: string | null, b: string | null) => {
    const da = parseIso(a);
    const db = parseIso(b);
    return da && db ? (db.getTime() - da.getTime()) / 60000 : null;
  };
  const findMilestone = (variant: string, at: string | null, tol: number) =>
    out.find((e) => e.type === "step" && e.v.variant === variant && Math.abs(minutesBetween(e.at, at) ?? 99) <= tol) as
      | Extract<TimelineEntry, { type: "step" }>
      | undefined;

  steps.forEach((s, i) => {
    const v = views[i];
    const at = s.at;

    // 1. Statusy patrolu: duplikat kamienia milowego (±1 min) → scal; „potwierdzony” → dopisek pod wysłaniem.
    if (v.variant === "arrived" || v.variant === "left") {
      const dup = findMilestone(v.variant, at, 1);
      if (dup) {
        if (v.result && !dup.v.result) dup.v.result = v.result;
        return;
      }
    }
    if (v.variant === "confirm") {
      const disp = [...out].reverse().find((e) => e.type === "step" && e.v.variant === "dispatch") as
        | Extract<TimelineEntry, { type: "step" }>
        | undefined;
      if (disp) {
        const d = minutesBetween(disp.at, at);
        disp.extras.push(
          d != null && d >= 0 ? `patrol potwierdził przyjęcie po ${d < 1 ? `${Math.round(d * 60)} s` : `${Math.round(d)} min`}` : "patrol potwierdził przyjęcie"
        );
        return;
      }
    }

    // 2. Notatka „HH:MM …” zgodna z kamieniem milowym → komentarz pod nim.
    if (v.variant === "note" && !isLongNote(s.text)) {
      let best: { e: Extract<TimelineEntry, { type: "step" }>; d: number } | null = null;
      for (const e of out) {
        if (e.type !== "step" || !MILESTONES.has(e.v.variant)) continue;
        const d = noteTimeNear(s.text, e.at);
        if (d != null && Math.abs(d) <= 2 && (!best || Math.abs(d) < best.d)) best = { e, d: Math.abs(d) };
      }
      if (best) {
        const op = (s.operator ?? "").trim();
        best.e.comments.push({ text: commentText(s.text), operator: op || null });
        notesSeen.push(s);
        return;
      }
    }

    // 2b. Krótkie „Patrol odwołanie” tuż po zakończeniu patrolu (±3 min) → komentarz pod odjazdem.
    if (v.variant === "note" && /^(?:patrol\s+odwołan\w*|odwołanie\s+patrolu|odwołano\s+patrol)\.?$/i.test(tidyText(s.text))) {
      const left = [...out].reverse().find((e) => e.type === "step" && e.v.variant === "left" && Math.abs(minutesBetween(e.at, at) ?? 99) <= 3) as
        | Extract<TimelineEntry, { type: "step" }>
        | undefined;
      if (left) {
        left.comments.push({ text: "Operator odwołał patrol.", operator: (s.operator ?? "").trim() || null });
        return;
      }
    }

    // 3. Wpisy techniczne → jednolinijkowce / grupa.
    const sys = systemLine(s, v);
    if (sys) {
      const last = out[out.length - 1];
      const item = { step: s, text: sys, full: tidyText(s.text) };
      if (last?.type === "system") {
        last.items.push(item);
        last.lastAt = at;
      } else out.push({ type: "system", items: [item], at, lastAt: at });
      return;
    }

    // 4. Kontakty: seria do tej samej osoby → jeden wpis.
    if (v.variant === "call" || v.variant === "sms") {
      const key = personKey(v.person);
      let echoOf: string | null = null;
      if (v.variant === "sms" && v.quote) {
        const src = [...notesSeen].reverse().find((n) => isEcho(v.quote!, [n.text], detail.objectName));
        if (src) echoOf = fmtTime(src.at);
        else if (notesSeen.length && isEcho(v.quote, notesSeen.map((n) => n.text), detail.objectName)) echoOf = fmtTime(notesSeen[notesSeen.length - 1].at);
      }
      const ch: ContactChannel = {
        kind: v.variant === "sms" ? "sms" : v.email ? "email" : v.phone ? "phone" : "other",
        step: s,
        value: v.email ?? v.phone ?? null,
        quote: v.quote ?? null,
        echoOf,
      };
      const last = out[out.length - 1];
      if (key && last?.type === "contact" && personKey(last.person) === key) {
        last.channels.push(ch);
        last.lastAt = at;
        if ((v.person ?? "").length > last.person.length) last.person = v.person!;
      } else {
        out.push({ type: "contact", person: v.person ?? "osoba kontaktowa", channels: [ch], at, lastAt: at });
      }
      return;
    }

    if (v.variant === "note") notesSeen.push(s);
    out.push({ type: "step", step: s, v, comments: [], extras: [], at, lastAt: at });
  });
  return out;
}

/** Wynik obsługi do karty „Co się stało” (z kroku zakończenia patrolu). */
export function patrolResult(detail: PatrolEventDetail): string | null {
  for (const s of detail.steps ?? []) {
    const v = stepView(s);
    if (v.variant === "left" && v.result) return v.result;
  }
  return null;
}
