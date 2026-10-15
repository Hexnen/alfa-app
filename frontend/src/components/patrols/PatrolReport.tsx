/**
 * Raport z jednego podjazdu — sam widok (bez pobierania danych i akcji), panel boczny v3.
 * Czytelne grupowanie, zasada „każdy fakt raz”: pola z etykietą (Dojazd | Czas na
 *   miejscu | Obsługa łącznie) → domysł z notatki jako osobny bursztynowy wiersz →
 *   zdanie tylko z nowym faktem (odwołanie, wynik) → cytat alarmu (gdy ma sens) →
 *   oś (godziny tylko tu) → kartoteka → zwijane: uwagi, inne zdarzenia, szczegóły.
 * Nagłówek (nazwa obiektu, metadane, chip statusu) to `ReportHeading` w lepkim
 * nagłówku panelu. Ten sam markup idzie do druku (patrol-report.css).
 */
import { useState, type ReactNode } from "react";
import { Car, ChevronRight, Info, MapPin, UserRound } from "lucide-react";
import type { PatrolEventDetail } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  DASH,
  anomalyLabel,
  diffMin,
  eventKindOf,
  extraAnomalies,
  fmtAddress,
  fmtDateTime,
  fmtDuration,
  fmtLongDate,
  fmtMinutes,
  fmtTime,
  isTrue,
  localNowIso,
  travelInfo,
  type TravelInfo,
} from "./patrolHelpers";
import { StepsTimeline } from "./PatrolSteps";
import { RelatedEvents, VideoPatrolSummary } from "./PatrolExtras";
import { splitVideoSteps, tidyAddress, type CameraCheck } from "./stepView";
import { meaningfulAlarm, statusOf, storySentence, type StatusTone } from "./story";
import "./patrol-report.css";

/* ------------------------------------------------------------------ */
/* Nagłówek (w lepkim pasku panelu)                                    */
/* ------------------------------------------------------------------ */

const STATUS_CHIP: Record<StatusTone, string> = {
  late: "bg-rose-50 text-rose-700 ring-rose-200",
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  hint: "bg-amber-50 text-amber-800 ring-amber-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  video: "bg-violet-50 text-violet-700 ring-violet-200",
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
};

/** Tytuł (18 px) → metadane (12–13 px szare, dwie krótkie linie) → status (chip w osobnej linii). */
export function ReportHeading({ detail }: { detail: PatrolEventDetail }) {
  const hasPatrol = isTrue(detail.hasPatrol);
  const address = tidyAddress(fmtAddress(detail));
  const status = statusOf(detail);
  const type = (detail.eventType ?? "").trim().replace(/\s{2,}/g, " ") || "Zdarzenie";
  const sep = <span className="text-slate-300">·</span>;
  return (
    <div className="min-w-0">
      <h2 className="text-lg font-semibold leading-snug tracking-tight text-slate-950" data-testid="podjazdy-report-title">
        {detail.objectName?.replace(/\s{2,}/g, " ") || "Obiekt bez nazwy"}
      </h2>
      <p className="tnum mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-slate-500" data-testid="podjazdy-report-meta">
        <span className="text-slate-700">{type}</span>
        {isTrue(detail.manual) && (
          <>
            {sep}
            <span>zgłoszone ręcznie</span>
          </>
        )}
        {sep}
        <span>{fmtLongDate(detail.startedAt)}</span>
        {detail.dayPart && (
          <>
            {sep}
            <span>{detail.dayPart}</span>
          </>
        )}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-slate-500">
        {address && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            {address}
          </span>
        )}
        {detail.crew ? (
          <span className="inline-flex items-center gap-1 font-medium text-slate-700">
            <Car className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            {detail.crew}
          </span>
        ) : detail.hintCrew ? (
          <span className="inline-flex items-center gap-1 font-medium text-amber-800" title="Załoga wyczytana z notatki operatora — nie z danych systemu" data-testid="podjazdy-report-hint-crew">
            <Car className="h-3.5 w-3.5" aria-hidden />
            {detail.hintCrew}? (z notatki)
          </span>
        ) : (
          hasPatrol && <span>załoga nieznana</span>
        )}
        {detail.operator && (
          <span className="inline-flex items-center gap-1">
            <UserRound className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            {detail.operator}
          </span>
        )}
      </p>
      <div className="mt-2">
        <span
          className={cn("tnum inline-flex items-center rounded-md px-2 py-0.5 text-[13px] font-medium ring-1 ring-inset", STATUS_CHIP[status.tone])}
          data-testid="podjazdy-report-verdict"
          data-verdict={status.key}
        >
          {status.text}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kluczowe fakty                                                      */
/* ------------------------------------------------------------------ */

/** Pole z etykietą: etykieta 12 px → wartość 16 px → opcjonalny podpis 12 px. */
function Field({ label, value, sub, tone, testid }: { label: string; value: string; sub?: (string | null)[] | string | null; tone?: string; testid?: string }) {
  const subs = (Array.isArray(sub) ? sub : [sub]).filter(Boolean);
  return (
    <div className="min-w-0 px-3 first:pl-0 sm:px-4" data-testid={testid}>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={cn("tnum mt-0.5 whitespace-nowrap text-base font-semibold leading-6 text-slate-900", tone)}>{value}</dd>
      {subs.map((x) => (
        <dd key={x} className="text-xs leading-4 text-slate-500">
          {x}
        </dd>
      ))}
    </div>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{children}</h3>
      {aside}
    </div>
  );
}

function Summary({ detail, info, video }: { detail: PatrolEventDetail; info: TravelInfo; video: CameraCheck[] | null }) {
  const hasPatrol = isTrue(detail.hasPatrol);
  const kind = eventKindOf(detail);
  const onSite = diffMin(detail.arrivedAt, detail.leftAt);
  const total = diffMin(detail.startedAt, detail.endedAt);
  const measured = info.travel != null && (info.verdict === "ontime" || info.verdict === "late");
  const sentence = storySentence(detail);
  const alarm = meaningfulAlarm(detail.alarmText) ? detail.alarmText!.trim() : null;
  const sims = (video ?? []).map((c) => c.similarity).filter((v): v is number => v != null);
  const limit = info.limit != null ? `limit ${fmtMinutes(info.limit)}` : "brak limitu w raporcie";

  const fields: ReactNode[] = [];
  if (hasPatrol) {
    fields.push(
      <Field
        key="travel"
        label="Dojazd"
        value={measured ? fmtDuration(info.travel) : DASH}
        sub={[info.verdict === "invalid" ? "przyjazd przed wyjazdem" : info.verdict === "unknown" ? "brak godziny przyjazdu" : null, limit]}
        tone={info.verdict === "late" ? "text-rose-700" : undefined}
        testid="podjazdy-report-field-travel"
      />,
      <Field
        key="onsite"
        label="Czas na miejscu"
        value={onSite != null && onSite >= 0 ? fmtDuration(onSite) : DASH}
        sub={onSite != null && onSite >= 0 ? null : "nie da się policzyć"}
        testid="podjazdy-report-field-onsite"
      />
    );
  }
  if (video && video.length > 0) {
    fields.push(
      <Field key="cams" label="Kamery" value={String(video.length)} sub={sims.length ? `min. podobieństwo ${Math.min(...sims)}%` : null} testid="podjazdy-report-field-cameras" />
    );
  }
  fields.push(
    <Field
      key="total"
      label="Obsługa łącznie"
      value={total != null && total >= 0 ? fmtDuration(total) : DASH}
      sub={total == null ? "brak godzin w raporcie" : null}
      testid="podjazdy-report-field-total"
    />
  );

  // Domysł z notatki — osobny, wyraźnie oznaczony wiersz (nie w polach z danymi).
  const hint =
    kind === "patrol_hint"
      ? `System nie zapisał wyjazdu, ale notatka operatora wspomina patrol${detail.hintCrew ? ` ${detail.hintCrew}` : ""}${
          detail.hintArrivedAt ? `, który był na miejscu ok. ${fmtTime(detail.hintArrivedAt)}` : ""
        }.`
      : hasPatrol && !detail.arrivedAt && detail.hintArrivedAt
        ? `Wg notatki operatora patrol był na miejscu ok. ${fmtTime(detail.hintArrivedAt)} — nie liczymy z tego dojazdu.`
        : null;

  return (
    <section className="patrol-summary space-y-4" data-testid="podjazdy-report-story">
      <dl className="grid grid-cols-3 divide-x divide-slate-200" data-testid="podjazdy-report-facts">
        {fields}
      </dl>
      {info.systemDisagrees && (
        <p className="text-xs text-slate-500" data-testid="podjazdy-report-system-status">
          System monitoringu ocenił inaczej: {detail.travelStatus || (isTrue(detail.late) ? "spóźnienie" : "w limicie")}
          {info.reported != null && ` (${fmtMinutes(info.reported)})`}.
        </p>
      )}
      {hint && (
        <p
          className="flex gap-2 rounded-r-md border-l-[3px] border-amber-400 bg-amber-50/60 py-2 pl-3 pr-3 text-[13px] leading-5 text-amber-900"
          data-testid={kind === "patrol_hint" ? "podjazdy-report-hint" : "podjazdy-report-hint-arrived"}
          title={detail.hintText ?? undefined}
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <span>
            {hint} <span className="text-amber-700">(domysł)</span>
          </span>
        </p>
      )}
      {sentence && (
        <p className="text-sm leading-6 text-slate-800" data-testid="podjazdy-report-story-text">
          {sentence}
        </p>
      )}
      {alarm && <AlarmQuote text={alarm} />}
    </section>
  );
}

function AlarmQuote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <div className="border-l-[3px] border-slate-300 pl-3" data-testid="podjazdy-report-alarm">
      <div className="text-xs text-slate-500">Treść alarmu</div>
      <p className={cn("patrol-clamp mt-0.5 text-[13px] leading-5 text-slate-700", long && !open && "line-clamp-3")}>{text}</p>
      {long && (
        <button type="button" className="patrol-noprint text-xs font-medium text-slate-500 hover:text-slate-900" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "mniej" : "więcej"}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sekcje zwijane                                                      */
/* ------------------------------------------------------------------ */

/** Sekcja zwijana: nagłówek 12 px uppercase z licznikiem; na wydruku treść widoczna (`printOpen`). */
function Fold({
  title,
  count,
  children,
  testid,
  defaultOpen = false,
  printOpen = true,
}: {
  title: string;
  count?: number | string;
  children: ReactNode;
  testid?: string;
  defaultOpen?: boolean;
  printOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="patrol-fold border-t border-slate-200 py-2.5" data-testid={testid} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-900"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={testid ? `${testid}-toggle` : undefined}
      >
        <ChevronRight className={cn("patrol-noprint h-3.5 w-3.5 text-slate-400 transition-transform", open && "rotate-90")} aria-hidden />
        {title}
        {count != null && <span className="tnum font-normal normal-case text-slate-400">{count}</span>}
      </button>
      <div className={cn("patrol-fold-body pl-5 pt-2", !open && "hidden", printOpen && "patrol-print-open")}>{children}</div>
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-0.5 text-[13px]">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words text-slate-800">{children}</dd>
    </div>
  );
}

export function PatrolReport({
  detail,
  objectSlot,
  onOpenEvent,
}: {
  detail: PatrolEventDetail;
  objectSlot?: ReactNode;
  /** Klik w „Inne zdarzenia na obiekcie” — otwiera raport tamtego zdarzenia. */
  onOpenEvent?: (id: number) => void;
}) {
  const info = travelInfo(detail);
  const kind = eventKindOf(detail);
  const video = kind === "video_patrol" ? splitVideoSteps(detail.steps ?? []) : null;
  const timelineDetail = video ? { ...detail, steps: video.rest } : detail;
  // Uwagi, które już mówi chip/linia liczb albo oś („przed rozpoczęciem”), nie powtarzamy.
  const anomalies = extraAnomalies(detail.anomalies, info).filter((a) => !/sprzed rozpoczęcia|step_before_start/i.test(a));
  const groups = (detail.groups ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  const related = detail.related ?? [];
  const badCams = video ? video.checks.filter((c) => !c.ok).length : 0;

  return (
    <article className="patrol-report text-slate-900" data-testid="podjazdy-report">
      <Summary detail={detail} info={info} video={video?.checks ?? null} />

      <section className="patrol-section mt-6 border-t border-slate-200 pt-4" data-testid="podjazdy-report-timeline">
        <SectionTitle aside={<span className="tnum text-xs text-slate-400">{detail.steps?.length ?? 0} kroków w raporcie</span>}>Przebieg obsługi</SectionTitle>
        <StepsTimeline detail={timelineDetail} lateArrival={info.verdict === "late"} />
      </section>

      <div className="mt-6">
        {objectSlot && (
          <section className="border-t border-slate-200 py-3">
            <SectionTitle>Obiekt w kartotece</SectionTitle>
            {objectSlot}
          </section>
        )}

        {video && video.checks.length > 0 && (
          <Fold title="Kamery wideopatrolu" count={video.checks.length} testid="podjazdy-report-cameras-fold" defaultOpen={badCams > 0} printOpen={false}>
            <VideoPatrolSummary checks={video.checks} />
          </Fold>
        )}

        {anomalies.length > 0 && (
          <Fold title="Uwagi do danych" count={anomalies.length} testid="podjazdy-report-anomalies">
            <ul className="space-y-0.5">
              {anomalies.map((a) => (
                <li key={a} className="text-[13px] text-amber-900">
                  {anomalyLabel(a)}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-500">Tak, jak przyszły z systemu monitoringu — bez poprawiania.</p>
          </Fold>
        )}

        {related.length > 0 && (
          <Fold title="Inne zdarzenia na obiekcie ±90 min" count={related.length} testid="podjazdy-related" printOpen={false}>
            <RelatedEvents detail={detail} onOpen={onOpenEvent} />
          </Fold>
        )}

        <Fold title="Szczegóły" testid="podjazdy-report-details">
          <dl>
            <DetailRow label="Nr zdarzenia">
              <span className="tnum">{detail.eventRef}</span>
            </DetailRow>
            <DetailRow label="Klasyfikacja">{detail.classification || DASH}</DetailRow>
            {/* Treść alarmu tu tylko, gdy nie ma jej w podsumowaniu (np. „01 Meldunek CMA - :”). */}
            {detail.alarmText && !meaningfulAlarm(detail.alarmText) && <DetailRow label="Treść alarmu">{detail.alarmText}</DetailRow>}
            {detail.serviceType && <DetailRow label="Usługa">{detail.serviceType}</DetailRow>}
            {groups.length > 0 && <DetailRow label="Grupy">{groups.join(", ")}</DetailRow>}
            <DetailRow label="Źródło">
              {detail.report?.fileName ?? "raport z systemu monitoringu"}
              {detail.report?.receivedAt && <span className="text-slate-500"> · otrzymano {fmtDateTime(detail.report.receivedAt)}</span>}
            </DetailRow>
            {detail.interventionId && <DetailRow label="Rozliczenie">utworzone w Grupach interwencyjnych</DetailRow>}
          </dl>
        </Fold>
      </div>

      <footer className="mt-4 hidden text-right text-xs text-slate-400 print:block">Wydruk: {fmtDateTime(localNowIso())}</footer>
    </article>
  );
}
