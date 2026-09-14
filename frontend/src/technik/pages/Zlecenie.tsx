import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, WifiOff } from "lucide-react";
import {
  technikApi,
  type TechnikJobDistance,
  type TechnikProtocol,
  type TechnikProtocolConflict,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActionTimeDialog } from "../ui/action-time";
import { WarnNote } from "../ui/panel";
import { useToast } from "../ui/toast";
import { useJob } from "../lib/useJob";
import { useJobWeather } from "../lib/useWeather";
import { useTechnikAccess } from "../lib/access";
import { clockOf, dayOf, timeOf } from "../lib/dates";
import { jobStateOf } from "../lib/jobs";
import { Naglowek } from "../zlecenie/Naglowek";
import { KafleAkcji } from "../zlecenie/KafleAkcji";
import { CoDoZrobienia } from "../zlecenie/CoDoZrobienia";
import { Notatki } from "../zlecenie/Notatki";
import { ProtokolKarta } from "../zlecenie/ProtokolKarta";
import { PasekAkcji } from "../zlecenie/PasekAkcji";

/**
 * SZCZEGÓŁY ZLECENIA — ekran, na którym technik stoi pod bramą.
 *
 * Kolejność bloków to kolejność pytań przy kierownicy: gdzie jestem (nagłówek)
 * → jak tam dojadę i do kogo dzwonię (dwa kafle pod kciukiem) → co mam zrobić
 * → co już ustaliliśmy (notatki, zwinięte) → papier. Wszystko poza notatkami
 * mieści się bez scrolla na 390 px, bo pierwsze spojrzenie na ten ekran zdarza
 * się w ruchu.
 *
 * Ten plik jest wyłącznie orkiestracją: dane, akcje i stany brzegowe. Każdy
 * blok mieszka w `technik/zlecenie/*`, bo razem miały 780 linii i nikt nie
 * potrafił powiedzieć, gdzie kończy się nagłówek, a zaczyna pasek akcji.
 */
export function Zlecenie() {
  const { id } = useParams<{ id: string }>();
  const jobId = id ? Number(id) : null;
  const { job, loading, notFound, error, reload, patch } = useJob(jobId);
  const { canEdit } = useTechnikAccess();
  const { toast, toastError } = useToast();
  const navigate = useNavigate();

  const [busy, setBusy] = useState(false);
  /** Które działanie pyta o godzinę („Teraz” / „Inna godzina”). */
  const [askTime, setAskTime] = useState<"start" | "finish" | null>(null);

  // Pogoda dnia zlecenia — ten sam batch co na listach, tu dla jednego id.
  const weather = useJobWeather(job);

  // --- Dojazd z biura (pod „Nawiguj”) ---------------------------------
  // Ta sama trasa, z której protokół bierze kilometry; dokłada tylko `minutes`.
  // Bez obiektu nie ma dokąd liczyć, więc w ogóle nie pytamy.
  const [distance, setDistance] = useState<TechnikJobDistance | null>(null);
  const [distanceLoading, setDistanceLoading] = useState(false);
  const distanceJobId = job?.objectId != null ? job.id : null;
  useEffect(() => {
    if (distanceJobId == null) {
      setDistance(null);
      return;
    }
    let cancelled = false;
    setDistanceLoading(true);
    technikApi
      .jobDistance(distanceJobId)
      .then((d) => {
        if (!cancelled) setDistance(d);
      })
      .catch(() => {
        // Geokoder/sieć: linijka po prostu się nie pojawi.
        if (!cancelled) setDistance(null);
      })
      .finally(() => {
        if (!cancelled) setDistanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [distanceJobId]);

  // --- Treść protokołu (tylko do opisu karty) -------------------------
  // `job.protocol` niesie sam numer i flagę podpisu, a karta ma powiedzieć,
  // CZEGO brakuje albo KTO podpisał. To zwykły odczyt istniejącej trasy —
  // gdy się nie uda, karta pokazuje po prostu numer i stan.
  const [protocolDetail, setProtocolDetail] = useState<TechnikProtocol | null>(null);
  const protocolId = job?.protocol?.id ?? null;
  useEffect(() => {
    if (protocolId == null) {
      setProtocolDetail(null);
      return;
    }
    let cancelled = false;
    technikApi
      .protocol(protocolId)
      .then((p) => {
        if (!cancelled) setProtocolDetail(p);
      })
      .catch(() => {
        if (!cancelled) setProtocolDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [protocolId]);

  // --- Stany brzegowe -------------------------------------------------
  if (loading && !job) return <Szkielet />;

  if (notFound) {
    return (
      <Karta
        icon={AlertTriangle}
        title="Zlecenie nie jest już przypisane do Ciebie"
        description="Biuro mogło je przepisać komuś innemu albo usunąć. Na liście „Dziś” masz aktualny komplet."
        action={
          <Button asChild className="h-12 w-full text-base">
            <Link to="/technik">Wróć do Dziś</Link>
          </Button>
        }
      />
    );
  }

  if (!job) {
    return (
      <Karta
        icon={WifiOff}
        title="Nie udało się wczytać zlecenia"
        description={error ?? "Sprawdź połączenie i spróbuj ponownie."}
        action={
          <Button className="h-12 w-full text-base" onClick={reload}>
            Spróbuj ponownie
          </Button>
        }
      />
    );
  }

  const state = jobStateOf(job);

  const start = async (at?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await technikApi.start(job.id, at);
      patch(next);
      toast({
        message: `Rozpoczęto o ${clockOf(next.startedAt) || timeOf(next.startAt)}`,
        kind: "success",
      });
      reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Nie udało się rozpocząć zlecenia.");
    } finally {
      setBusy(false);
    }
  };

  const finish = async (at?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await technikApi.finish(job.id, { at });
      patch(next);
      toast({ message: `Zakończono o ${clockOf(next.finishedAt)}`, kind: "success" });
      reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Nie udało się zakończyć zlecenia.");
    } finally {
      setBusy(false);
    }
  };

  /** Otwiera protokół; gdy go jeszcze nie ma — zakłada i od razu otwiera. */
  const openProtocol = async () => {
    if (job.protocol) {
      navigate(`/technik/zlecenie/${job.id}/protokol`);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await technikApi.createProtocol(job.id);
      navigate(`/technik/zlecenie/${job.id}/protokol`);
    } catch (e) {
      const err = e as TechnikProtocolConflict;
      // 409 z protokołem w `data.protocol` = protokół po prostu już jest (ktoś
      // założył go z biura). To nie jest błąd dla technika — otwieramy istniejący.
      if (err.status === 409 && err.protocol) {
        navigate(`/technik/zlecenie/${job.id}/protokol`);
        return;
      }
      toastError(err instanceof Error ? err.message : "Nie udało się założyć protokołu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Naglowek job={job} weather={weather} onBack={() => navigate("/technik")} />

      {/* Pasek akcji stoi nad tab barem — treść musi mieć pod sobą tyle miejsca,
          żeby ostatnia linijka nie chowała się za „Rozpocznij”. */}
      <div className={cn("space-y-3", canEdit && state !== "cancelled" ? "pb-24" : "pb-16")}>
        <KafleAkcji job={job} distance={distance} distanceLoading={distanceLoading} />

        {/* Zlecenie bez obiektu: protokół wyjdzie niepełny, a dojazdu nie ma
            z czego policzyć. To informacja, nie blokada. */}
        {job.objectId == null && (
          <WarnNote data-testid="zlecenie-bez-obiektu">
            Zlecenie nie ma przypiętego obiektu — adres i dane klienta w protokole trzeba będzie
            sprawdzić z biurem.
          </WarnNote>
        )}

        <CoDoZrobienia job={job} />

        <Notatki jobId={job.id} notes={job.notes} canEdit={canEdit} onChanged={reload} />

        <ProtokolKarta
          jobId={job.id}
          protocol={job.protocol}
          detail={protocolDetail}
          canEdit={canEdit}
          busy={busy}
          onCreate={() => void openProtocol()}
        />
      </div>

      <PasekAkcji
        state={state}
        startedAt={job.startedAt}
        finishedAt={job.finishedAt}
        canEdit={canEdit}
        busy={busy}
        hasProtocol={job.protocol != null}
        onStart={() => setAskTime("start")}
        onFinish={() => setAskTime("finish")}
        onProtocol={() => void openProtocol()}
      />

      {/* Jedno okno dla obu akcji: „Teraz” (jeden tap) albo wpisana godzina.
          Przy „Zakończ” zastępuje dawne osobne potwierdzenie — pytanie o czas
          jest i tak wyraźniejsze niż „na pewno?”. */}
      <ActionTimeDialog
        open={askTime !== null}
        onOpenChange={(o) => !o && setAskTime(null)}
        busy={busy}
        defaultDay={dayOf(job.startAt)}
        title={askTime === "finish" ? "Zakończyć zlecenie?" : "Rozpocząć zlecenie?"}
        description={
          askTime === "finish"
            ? "Zlecenie dostanie status „zakończone”, a biuro zobaczy je jako zrobione."
            : "Zapiszemy godzinę rozpoczęcia i damy znać biuru, że jesteś na obiekcie."
        }
        nowLabel={askTime === "finish" ? "Zakończ teraz" : "Rozpocznij teraz"}
        onSubmit={(at) => {
          const action = askTime;
          setAskTime(null);
          if (action === "finish") void finish(at);
          else if (action === "start") void start(at);
        }}
      />
    </>
  );
}

/**
 * ŁADOWANIE = SZKIELET, nie kręciołek. Bloki stoją tam, gdzie za chwilę
 * pojawi się treść, więc ekran nie podskakuje, a technik w słabym zasięgu
 * widzi, że coś się dzieje, i gdzie.
 */
function Szkielet() {
  return (
    <div className="animate-pulse pt-3" aria-hidden data-testid="zlecenie-szkielet">
      <div className="mb-3 flex items-center gap-2 border-b pb-2">
        <div className="h-9 w-1 rounded-full bg-muted" />
        <div className="flex-1 space-y-1.5">
          <div className="h-4 w-2/3 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted/70" />
        </div>
        <div className="h-6 w-20 rounded-full bg-muted" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="h-14 rounded-xl bg-muted" />
        <div className="h-14 rounded-xl bg-muted" />
      </div>
      <div className="mt-3 h-28 rounded-xl bg-muted" />
      <div className="mt-3 h-12 rounded-xl bg-muted" />
      <div className="mt-3 h-20 rounded-xl bg-muted" />
    </div>
  );
}

/** Karta stanu brzegowego (404, błąd sieci) — ta sama krawędź co reszta ekranu. */
function Karta({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof AlertTriangle;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="pt-6">
      <section className="rounded-xl border bg-card p-4 text-card-foreground">
        <Icon className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h1 className="mt-2 text-base font-semibold leading-snug">{title}</h1>
        <p className="mt-1 text-sm leading-snug text-muted-foreground">{description}</p>
        <div className="mt-4">{action}</div>
      </section>
    </div>
  );
}
