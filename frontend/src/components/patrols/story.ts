/**
 * Jedno krótkie zdanie „co się stało” w nagłówku raportu — TYLKO to, czego nie
 * mówią chip statusu, typ zdarzenia i linia liczb (zasada „każdy fakt raz”):
 * odwołanie patrolu, wynik obsługi, wzmianka o patrolu w notatce. Gdy nie ma nic
 * nowego → null (nie wypełniamy miejsca). Bez Reacta (fast refresh).
 */
import type { PatrolEventDetail } from "@/lib/api";
import { eventKindOf, fmtDuration, isTrue, travelInfo } from "./patrolHelpers";
import { splitVideoSteps, stepView, tidyText } from "./stepView";
import { patrolResult } from "./timeline";

/** „FAŁSZYWY ALARM Z POWIADOMIENIEM KLIENTA” → „fałszywy alarm z powiadomieniem klienta”. */
const calm = (s: string) => {
  const t = tidyText(s).replace(/\.$/, "");
  return t === t.toUpperCase() ? t.toLowerCase() : t[0].toLowerCase() + t.slice(1);
};

export function storySentence(d: PatrolEventDetail): string | null {
  const kind = eventKindOf(d);
  if (kind === "patrol") {
    const parts: string[] = [];
    const cancel = (d.steps ?? []).map((s) => stepView(s)).find((v) => v.variant === "cancel");
    if (cancel) {
      const why = (cancel.body ?? "").split(/(?<=\.)\s/)[0]?.replace(/\.$/, "");
      const reason = why && why.length <= 60 ? ` (${calm(why)})` : "";
      parts.push(/nowego/.test(cancel.title) ? `Pierwszy patrol odwołano${reason} i wysłano ponownie.` : `Patrol odwołano${reason}.`);
    }
    const res = patrolResult(d);
    if (res) parts.push(`Wynik: ${calm(res)}.`);
    return parts.length ? parts.join(" ") : null;
  }
  return null;
}

export type StatusTone = "late" | "ok" | "hint" | "warn" | "video" | "neutral";

/** Status podjazdu do chipu pod tytułem i paska koloru panelu. */
export function statusOf(d: PatrolEventDetail): { key: string; text: string; tone: StatusTone } {
  const kind = eventKindOf(d);
  if (!isTrue(d.hasPatrol)) {
    if (kind === "patrol_hint") return { key: "hint", text: "Możliwy podjazd", tone: "hint" };
    if (kind === "video_patrol") {
      const bad = splitVideoSteps(d.steps ?? []).checks.filter((c) => !c.ok).length;
      return { key: "video", text: bad ? `Wideopatrol AI — nieprawidłowości: ${bad}` : "Wideopatrol AI — bez nieprawidłowości", tone: bad ? "late" : "video" };
    }
    return { key: "none", text: "Bez wyjazdu patrolu", tone: "neutral" };
  }
  const info = travelInfo(d);
  switch (info.verdict) {
    case "late":
      return { key: "late", text: info.delay != null && info.delay > 0 ? `Spóźniony +${fmtDuration(info.delay)}` : "Spóźniony", tone: "late" };
    case "ontime":
      return { key: "ontime", text: info.delay != null && info.delay < 0 ? `W czasie, zapas ${fmtDuration(-info.delay)}` : "W czasie", tone: "ok" };
    case "invalid":
      return { key: "invalid", text: "Czas dojazdu niewiarygodny", tone: "warn" };
    default:
      return { key: "unknown", text: "Nie da się ocenić dojazdu", tone: "neutral" };
  }
}

/** Treść alarmu ma sens? „01 Meldunek CMA - :” → nie (ukryta, zostaje w „Szczegółach”). */
export function meaningfulAlarm(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter((w) => w.length > 1);
  const generic = /^(meldunek|alarm|powiadomienie|ostrzeżenie)( cma)?$/i.test(t);
  return !generic && (words.length >= 3 || t.length >= 12);
}
