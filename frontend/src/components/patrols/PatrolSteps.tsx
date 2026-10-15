/**
 * Oś obsługi w panelu podjazdu — gęsta, skanowalna, JEDNA chronologia bez powtórek
 * (model: timeline.ts). Wiersz = godzina · ikona · opis · odstęp od poprzedniego.
 * Ikony tylko przy kamieniach milowych (wysłanie, odwołanie, przyjazd, odjazd,
 * koniec), reszta z małą kropką. Notatki, komentarze i SMS jako wcięty cytat 13 px,
 * maks. 3 linie z „więcej” (na wydruku zawsze w całości).
 */
import { useState, type ReactNode } from "react";
import { Car, Flag, LogOut, MapPin, RotateCcw } from "lucide-react";
import type { PatrolEventDetail, PatrolEventStep } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtDuration, fmtTimeSec, parseIso } from "./patrolHelpers";
import { normKey, parseNote, splitTimes, telHref, tidyText, type StepVariant } from "./stepView";
import { buildTimeline, type ContactChannel, type TimelineEntry } from "./timeline";

const MILESTONE_ICON: Partial<Record<StepVariant, typeof Car>> = {
  dispatch: Car,
  cancel: RotateCcw,
  arrived: MapPin,
  left: LogOut,
  end: Flag,
};

/** Tekst z pogrubionymi godzinami „01:24”. */
export function WithTimes({ text }: { text: string }) {
  return (
    <>
      {splitTimes(text).map((p, i) =>
        p.time ? (
          <strong key={i} className="tnum font-semibold text-slate-800">
            {p.t}
          </strong>
        ) : (
          <span key={i}>{p.t}</span>
        )
      )}
    </>
  );
}

/** Notatka operatora jako czytelny tekst: bez powtórzonej nazwy obiektu, wpisy oddzielone pustą linią. */
function noteText(step: PatrolEventStep, objectName: string | null): string {
  const entries = parseNote(step.text, objectName);
  if (entries.length === 0) return tidyText(step.text);
  return entries
    .map((e) => e.lines.map((l) => (l.type === "gap" ? "" : l.type === "time" ? `${l.time} ${l.text}` : l.text)).join("\n"))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

const isLong = (t: string) => t.split("\n").length > 3 || t.length > 230;

/** Wcięty cytat 13 px, maks. 3 linie z „więcej”. */
function Quote({ text, testid }: { text: string; testid?: string }) {
  const [open, setOpen] = useState(false);
  const long = isLong(text);
  return (
    <div className="mt-0.5 border-l-2 border-slate-200 pl-2.5" data-testid={testid}>
      <p className={cn("patrol-clamp whitespace-pre-line break-words text-[13px] leading-[1.45] text-slate-600", long && !open && "line-clamp-3")}>
        <WithTimes text={text} />
      </p>
      {long && (
        <button
          type="button"
          className="patrol-noprint text-xs font-medium text-slate-500 hover:text-slate-900"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="podjazdy-report-summary-toggle"
        >
          {open ? "mniej" : "więcej"}
        </button>
      )}
    </div>
  );
}

function PhoneLink({ phone }: { phone: string }) {
  return (
    <a href={telHref(phone)} className="tnum whitespace-nowrap text-slate-700 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-600">
      {phone}
    </a>
  );
}

const ROW = "grid min-h-8 grid-cols-[64px_16px_minmax(0,1fr)_auto] items-start gap-x-3 py-1.5";

function Row({
  at,
  strong,
  icon,
  children,
  gap,
  testid,
  attrs,
}: {
  at: string | null;
  strong?: boolean;
  icon: ReactNode;
  children: ReactNode;
  gap: number | null;
  testid: string;
  attrs?: Record<string, string | undefined>;
}) {
  return (
    <li className={ROW} data-testid={testid} {...attrs}>
      <span className={cn("tnum pt-px text-[13px]", strong ? "font-semibold text-slate-900" : "text-slate-500")}>{fmtTimeSec(at)}</span>
      <span className="flex h-5 items-center justify-center">{icon}</span>
      <div className="min-w-0 text-sm leading-5 text-slate-700">{children}</div>
      <span className="tnum pt-px text-right text-xs text-slate-400">{gap != null && gap >= 1 ? `+${fmtDuration(gap)}` : ""}</span>
    </li>
  );
}

const Dot = () => <span className="h-1.5 w-1.5 rounded-full bg-slate-300" aria-hidden />;

const CHANNEL: Record<ContactChannel["kind"], string> = { email: "e-mail", phone: "telefon", sms: "SMS", other: "próba kontaktu" };

function ContactLine({ e }: { e: Extract<TimelineEntry, { type: "contact" }> }) {
  const [smsOpen, setSmsOpen] = useState(false);
  const name = e.person.replace(/\s*\([^)]*\)\s*$/, "");
  const role = /\(([^)]*)\)\s*$/.exec(e.person)?.[1];
  const phones = new Set(e.channels.filter((c) => c.kind === "phone").map((c) => c.value));
  const sms = e.channels.find((c) => c.kind === "sms" && c.quote);
  return (
    <>
      <span>
        Kontakt: <span className="font-medium text-slate-900">{name}</span>
        {role && <span className="text-[13px] text-slate-400"> ({role})</span>}
        <span className="text-slate-400"> — </span>
        {e.channels.map((ch, i) => {
          // Numer SMS-a = numer, na który już dzwoniono → nie powtarzamy.
          const value = ch.kind === "sms" && phones.has(ch.value) ? null : ch.value;
          return (
            <span key={ch.step.id ?? i}>
              {i > 0 && ", "}
              {CHANNEL[ch.kind]}
              {value && (ch.kind === "email" ? <span className="text-slate-500"> {value}</span> : <> <PhoneLink phone={value} /></>)}
            </span>
          );
        })}
        {sms?.echoOf && (
          <span className="text-[13px] text-slate-400">
            {" "}
            (treść SMS = notatka z {sms.echoOf}{" "}
            <button
              type="button"
              className="patrol-noprint text-slate-500 underline decoration-slate-300 hover:text-slate-900"
              onClick={() => setSmsOpen((o) => !o)}
              aria-expanded={smsOpen}
              data-testid="podjazdy-report-sms-toggle"
            >
              {smsOpen ? "ukryj" : "pokaż"}
            </button>
            )
          </span>
        )}
      </span>
      {sms && (!sms.echoOf || smsOpen) && <Quote text={sms.quote!} testid="podjazdy-report-sms" />}
    </>
  );
}

function SystemFold({ e, gaps }: { e: Extract<TimelineEntry, { type: "system" }>; gaps: (number | null)[] }) {
  const [open, setOpen] = useState(false);
  if (e.items.length < 3 || open) {
    return (
      <>
        {e.items.map((it, i) => (
          <Row key={it.step.id ?? i} at={it.step.at} icon={<Dot />} gap={gaps[i]} testid="podjazdy-report-step" attrs={{ "data-kind": it.step.kind, "data-variant": "system" }}>
            <span className="text-[13px] text-slate-500" title={it.full !== it.text ? it.full : undefined}>
              {it.text}
            </span>
          </Row>
        ))}
      </>
    );
  }
  return (
    <Row at={e.at} icon={<Dot />} gap={gaps[0]} testid="podjazdy-report-system">
      <button type="button" className="text-[13px] text-slate-500 underline decoration-slate-300 hover:text-slate-900" onClick={() => setOpen(true)} data-testid="podjazdy-report-system-toggle">
        Czynności w systemie ({e.items.length})
      </button>
    </Row>
  );
}

/**
 * Odstępy „od poprzedniego wpisu” liczone z góry (czysto, bez mutacji w renderze).
 * Wyjątek: przyjazd liczony od wysłania, odjazd od przyjazdu — wtedy odstęp na osi
 * to dokładnie „Dojazd” / „Czas na miejscu” z podsumowania (jedna definicja, te same sekundy).
 */
function computeGaps(entries: TimelineEntry[]): (number | null)[][] {
  let prevT: number | null = null;
  const ms: Partial<Record<string, number>> = {};
  const step = (at: string | null, from?: number) => {
    const t = parseIso(at)?.getTime() ?? null;
    const base = from ?? prevT;
    const g = base != null && t != null ? (t - base) / 60000 : null;
    if (t != null) prevT = Math.max(prevT ?? t, t);
    return g;
  };
  return entries.map((e) => {
    if (e.type === "system") return e.items.map((it) => step(it.step.at));
    if (e.type === "contact") {
      const g = step(e.at);
      step(e.lastAt);
      return [g];
    }
    const variant = e.v.variant;
    const from = variant === "arrived" ? ms.dispatch : variant === "left" ? ms.arrived : undefined;
    const g = step(e.at, from);
    const t = parseIso(e.at)?.getTime();
    if (t != null && variant === "dispatch" && ms.dispatch == null) ms.dispatch = t;
    if (t != null && variant === "arrived" && ms.arrived == null) ms.arrived = t;
    return [g];
  });
}

export function StepsTimeline({ detail, lateArrival }: { detail: PatrolEventDetail; lateArrival?: boolean }) {
  const entries = buildTimeline(detail);
  if (entries.length === 0) return <p className="text-sm text-slate-500">Raport nie zawiera kroków obsługi.</p>;
  const gaps = computeGaps(entries);
  const startT = parseIso(detail.startedAt)?.getTime() ?? null;
  const mainOperator = (detail.operator ?? "").trim().toLowerCase();
  const rows: ReactNode[] = entries.map((e, i) => {
    if (e.type === "system") return <SystemFold key={`s${i}`} e={e} gaps={gaps[i]} />;
    if (e.type === "contact") {
      return (
        <Row key={`c${i}`} at={e.at} icon={<Dot />} gap={gaps[i][0]} testid="podjazdy-report-contact">
          <ContactLine e={e} />
        </Row>
      );
    }
    const { step: s, v } = e;
    const MIcon = v.key ? MILESTONE_ICON[v.variant] : undefined;
    const tone = v.variant === "cancel" ? "text-orange-600" : v.variant === "arrived" && lateArrival ? "text-rose-600" : "text-slate-700";
    const early = startT != null && s.at != null && (parseIso(s.at)?.getTime() ?? 0) < startT && s.kind !== "ai";
    const op = (s.operator ?? "").trim();
    const showOp = op && op.toLowerCase() !== mainOperator && !/^\(system\)$/i.test(op);
    const crewOther = v.crew && (v.variant === "cancel" || normKey(v.crew) !== normKey(detail.crew));
    const body = v.variant === "note" ? noteText(s, detail.objectName) : v.body ?? null;
    const noteInline = v.variant === "note" && body && !body.includes("\n") && body.length <= 90;
    return (
      <Row
        key={s.id ?? i}
        at={s.at}
        strong={v.key}
        icon={MIcon ? <MIcon className={cn("h-3.5 w-3.5", tone)} aria-hidden /> : <Dot />}
        gap={gaps[i][0]}
        testid="podjazdy-report-step"
        attrs={{ "data-kind": s.kind, "data-variant": v.variant }}
      >
        <span>
          {v.variant === "note" ? (
            <span className="text-slate-500">Notatka{noteInline ? ": " : ""}</span>
          ) : (
            <span className={cn(v.key ? "font-medium text-slate-900" : "text-slate-700", v.variant === "cancel" && "text-orange-700")}>{v.title}</span>
          )}
          {noteInline && <span className="text-slate-700">{body}</span>}
          {crewOther && <span className={cn("ml-1.5 text-[13px] font-medium text-slate-500", v.variant === "cancel" && "line-through decoration-orange-400")}>{v.crew}</span>}
          {v.variant === "ai" && v.aiObjects && <span className="ml-1.5 text-[13px] font-medium text-violet-700">{v.aiObjects}</span>}
          {e.extras.map((x) => (
            <span key={x} className="text-[13px] text-slate-400">
              {" "}
              · {x}
            </span>
          ))}
          {v.meta && <span className="text-[13px] text-slate-400"> · {v.meta}</span>}
          {early && <span className="text-[13px] text-amber-700" title="Krok ma czas sprzed rozpoczęcia zdarzenia"> · przed rozpoczęciem</span>}
          {showOp && <span className="text-[13px] text-slate-400"> · {op}</span>}
        </span>
        {body && !noteInline && <Quote text={body} testid={v.variant === "note" ? "podjazdy-report-note" : undefined} />}
        {e.comments.map((c, j) => (
          <Quote key={j} text={c.text} testid="podjazdy-report-comment" />
        ))}
      </Row>
    );
  });
  return <ol data-testid="podjazdy-report-steps">{rows}</ol>;
}
