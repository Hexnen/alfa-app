import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useParams } from "react-router-dom";
import { Eye, LinkIcon, WifiOff, Wrench } from "lucide-react";
import {
  eventSharesApi,
  type SharedJobView,
  type TechnikJobDetails,
  type TechnikJobNote,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { fmtTimestamp } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { WarnNote } from "../ui/panel";
import { InfoNotice, ToastProvider, useToast } from "../ui/toast";
import { ActionTimeDialog } from "../ui/action-time";
import { jobStateOf } from "../lib/jobs";
import { clockOf, dayOf, timeOf } from "../lib/dates";
import { useKeyboardVar } from "../lib/keyboard";
import { Naglowek } from "../zlecenie/Naglowek";
import { KafleAkcji } from "../zlecenie/KafleAkcji";
import { CoDoZrobienia } from "../zlecenie/CoDoZrobienia";
import { Notatki, type NotesApi } from "../zlecenie/Notatki";
import { PasekAkcji } from "../zlecenie/PasekAkcji";
import "../technik.css";

/**
 * PUBLICZNY PODGLĄD ZLECENIA — `/u/:token` (docs/UDOSTEPNIANIE-WYDARZEN.md).
 *
 * Link z dialogu „Udostępnij” w kalendarzu: podwykonawca bez konta albo gość
 * otwiera go na telefonie i widzi to samo, co technik na ekranie zlecenia —
 * nagłówek, „Nawiguj”/„Zadzwoń”, „Co do zrobienia”.
 *
 * Dwa NIEZALEŻNE przełączniki linku:
 *  - `canWork` („Może pracować”) — pasek Rozpocznij/Zakończ (bez „Wznów”
 *    i protokołu) oraz dodawanie/edycja/usuwanie WŁASNYCH notatek;
 *  - `seeAllNotes` („Widzi wszystkie notatki”) — w sekcji „Notatki” także
 *    notatki biura, techników, innych linków i systemowe (z podpisami, zdjęciami).
 * Macierz: 0/0 podgląd bez notatek; 1/0 tylko własne; 0/1 wszystkie tylko do
 * odczytu; 1/1 wszystkie, zmiany tylko przy `mine`. TE SAME komponenty co
 * w panelu (`Notatki`, `PasekAkcji`), z adapterem API na `/api/share/:token/*`.
 * Zakres notatek ustala backend — strona pokazuje, co dostała.
 *
 * Każdy nieważny link (wygasły, unieważniony, nieistniejący, wydarzenie
 * usunięte) to dla backendu to samo 404 — i tu też jeden ekran. Także 404
 * przy ZAPISIE (link unieważniony, gdy ekran był otwarty) kończy się nim.
 */
export function Udostepnione() {
  const { token = "" } = useParams<{ token: string }>();
  const [view, setView] = useState<SharedJobView | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useSharePageHead();

  /** Ponowienie po błędzie sieci — zmienia klucz, efekt pobiera od nowa. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    eventSharesApi
      .publicView(token)
      .then((data) => {
        if (cancelled) return;
        setView(data);
        setState("ok");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 400) {
          setState("gone");
        } else {
          // 429 ma od backendu ludzki komunikat; 5xx / brak sieci daje surowe
          // „Request failed (500)” — odbiorcy spoza firmy pokazujemy zwykłe zdanie.
          setError(status === 429 && e instanceof Error ? e.message : null);
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  const retry = () => {
    setState("loading");
    setError(null);
    setAttempt((n) => n + 1);
  };

  const markGone = useCallback(() => setState("gone"), []);

  return (
    <div className="technik-root">
      <ToastProvider>
      <div className="min-h-dvh bg-background">
        <main className="mx-auto w-full max-w-3xl px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
          {state === "loading" && <Szkielet />}
          {state === "gone" && <Wygasl />}
          {state === "error" && (
            <Karta
              icon={WifiOff}
              title="Nie udało się wczytać zlecenia"
              description={error ?? "Serwer chwilowo nie odpowiada albo nie ma połączenia — spróbuj ponownie za chwilę."}
              action={
                <Button className="h-12 w-full text-base" onClick={retry}>
                  Spróbuj ponownie
                </Button>
              }
            />
          )}
          {state === "ok" && view && (
            <Podglad token={token} view={view} setView={setView} onGone={markGone} />
          )}
        </main>
      </div>
      </ToastProvider>
    </div>
  );
}

/** Błąd z `request()` — `status` to kod HTTP. */
const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;

function Podglad({
  token,
  view,
  setView,
  onGone,
}: {
  token: string;
  view: SharedJobView;
  setView: Dispatch<SetStateAction<SharedJobView | null>>;
  onGone: () => void;
}) {
  useKeyboardVar();
  const { toast, toastFailure } = useToast();
  const [busy, setBusy] = useState(false);
  /** Które działanie pyta o godzinę („Teraz” / „Inna godzina”). */
  const [askTime, setAskTime] = useState<"start" | "finish" | null>(null);

  const canWork = view.canWork === true;
  const canNotes = canWork && view.canNotes !== false;
  const seeAll = view.seeAllNotes === true;
  /** Sekcja „Notatki”: własne (canNotes) albo cudze do odczytu (seeAll). */
  const showNotes = canNotes || seeAll;
  const notes = useMemo(() => view.notes ?? [], [view.notes]);

  // Komponenty ekranu zlecenia znają pełny typ panelu — dopełniamy pola, których
  // publiczny widok celowo nie niesie (protokół, cudze notatki).
  const job: TechnikJobDetails = {
    ...view.job,
    notes,
    notesCount: notes.length,
    protocol: null,
    coTechnicians: view.job.coTechnicians ?? [],
    canProtocol: false,
    canProgress: canWork && view.canProgress === true,
  };
  const state = jobStateOf(job);
  const cancelled = state === "cancelled";

  /**
   * Każdy zapis przez link. 404 znaczy „link nieaktywny” ALBO „tej notatki już
   * nie ma” (biuro ją skasowało) — rozstrzyga ponowny odczyt widoku: martwy
   * link → ekran „Link wygasł”, żywy → świeże dane, a błąd idzie do toastu.
   */
  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (statusOf(e) === 404) {
          let fresh: SharedJobView | null = null;
          try {
            fresh = await eventSharesApi.publicView(token);
          } catch (e2) {
            const s2 = statusOf(e2);
            if (s2 === 404 || s2 === 400) {
              onGone();
              throw new Error("Link wygasł lub został unieważniony.", { cause: e });
            }
          }
          if (fresh) {
            setView(fresh);
            // Biuro przełączyło link na „tylko podgląd” — strona sama przechodzi
            // w podgląd (pasek i notatki znikają), a toast mówi dlaczego.
            // To zmiana stanu, nie porażka — `InfoNotice` = toast informacyjny.
            if (fresh.canWork !== true && canWork) {
              throw new InfoNotice("Biuro zmieniło ten link na „tylko podgląd” — zapis nie jest już możliwy.", {
                cause: e,
              });
            }
          }
        }
        throw e;
      }
    },
    [token, onGone, setView, canWork],
  );

  const patchNotes = useCallback(
    (fn: (notes: TechnikJobNote[]) => TechnikJobNote[]) =>
      setView((v) => {
        if (!v) return v;
        const next = fn(v.notes ?? []);
        return { ...v, notes: next, job: { ...v.job, notesCount: next.length } };
      }),
    [setView],
  );

  // Adapter dla `Notatki`: zamiast przeładowania całego widoku (każdy GET
  // podbija licznik otwarć linku w biurze) wynik zapisu wpada od razu w stan.
  const notesApi = useMemo<NotesApi>(
    () => ({
      addNote: async (text) => {
        const n = await guard(() => eventSharesApi.publicAddNote(token, text));
        patchNotes((list) => [{ ...n, mine: true }, ...list.filter((x) => x.id !== n.id)]);
      },
      addNoteWithFiles: async (payload) => {
        const n = await guard(() => eventSharesApi.publicAddNoteWithFiles(token, payload));
        patchNotes((list) => [{ ...n, mine: true }, ...list.filter((x) => x.id !== n.id)]);
      },
      updateNote: async (noteId, text) => {
        const n = await guard(() => eventSharesApi.publicUpdateNote(token, noteId, text));
        patchNotes((list) => list.map((x) => (x.id === noteId ? { ...x, ...n, mine: true } : x)));
      },
      deleteNote: async (noteId) => {
        await guard(() => eventSharesApi.publicDeleteNote(token, noteId));
        patchNotes((list) => list.filter((x) => x.id !== noteId));
      },
      deleteAttachment: async (attachmentId) => {
        await guard(() => eventSharesApi.publicDeleteAttachment(token, attachmentId));
        patchNotes((list) =>
          list.map((x) =>
            x.attachments?.some((a) => a.id === attachmentId)
              ? { ...x, attachments: x.attachments.filter((a) => a.id !== attachmentId) }
              : x,
          ),
        );
      },
    }),
    [guard, patchNotes, token],
  );

  const progress = async (action: "start" | "finish", at?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const { job: next, notes: fresh } = await guard(() =>
        action === "start"
          ? eventSharesApi.publicStart(token, at)
          : eventSharesApi.publicFinish(token, at),
      );
      // Notatki z odpowiedzi zapisu (systemowe „Rozpoczęto/Zakończono …”) — bez
      // ponownego GET widoku, który podbijałby licznik otwarć linku w biurze.
      // `mine` z backendu: przy „widzi wszystkie” lista zawiera też cudze.
      setView((v) =>
        v
          ? {
              ...v,
              job: { ...v.job, ...next, ...(fresh ? { notesCount: fresh.length } : {}) },
              ...(fresh ? { notes: fresh.map((n) => ({ ...n, mine: n.mine === true })) } : {}),
            }
          : v,
      );
      toast({
        message:
          action === "start"
            ? `Rozpoczęto o ${clockOf(next.startedAt) || timeOf(next.startAt)}`
            : `Zakończono o ${clockOf(next.finishedAt)}`,
        kind: "success",
      });
    } catch (e) {
      toastFailure(
        e,
        action === "start" ? "Nie udało się rozpocząć zlecenia." : "Nie udało się zakończyć zlecenia.",
      );
    } finally {
      setBusy(false);
    }
  };

  const BannerIcon = canWork ? Wrench : Eye;
  const bannerHint = canWork
    ? seeAll
      ? "Możesz rozpocząć i zakończyć zlecenie oraz dodawać własne notatki i zdjęcia; widzisz też notatki biura i techników"
      : "Możesz rozpocząć i zakończyć zlecenie oraz dodawać własne notatki i zdjęcia"
    : seeAll
      ? "Tylko do odczytu — z notatkami biura i techników"
      : "Tylko do odczytu";

  return (
    <>
      <Naglowek job={job} weather={null} />

      {/* Pasek akcji jest `fixed` — treść musi mieć pod sobą jego wysokość. */}
      <div className={cn("space-y-3", canWork && "pb-20")} data-testid="share-view">
        <div
          className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm"
          data-testid="share-banner"
          data-mode={canWork ? "work" : "view"}
          data-notes={seeAll ? "all" : canWork ? "own" : "none"}
        >
          <BannerIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium leading-snug">
              {canWork ? "Zlecenie udostępnione do pracy dla: " : "Podgląd udostępniony dla: "}
              <span className="break-words">{view.share.recipientName}</span>
            </p>
            <p className="text-xs leading-snug text-muted-foreground">
              {bannerHint}
              {" · "}link ważny do {fmtTimestamp(view.share.expiresAt)}
            </p>
          </div>
        </div>

        {cancelled && (
          <WarnNote data-testid="share-cancelled">
            To zlecenie zostało odwołane — nie trzeba na nie jechać.
          </WarnNote>
        )}

        <KafleAkcji job={job} distance={null} distanceLoading={false} showTrip={false} />
        <CoDoZrobienia job={job} coLabel="Technicy" />

        {showNotes && (
          <Notatki
            jobId={job.id}
            notes={notes}
            canEdit={canNotes && !cancelled}
            onChanged={() => {
              /* adapter sam wpisuje wynik w stan — nic do przeładowania */
            }}
            objectLat={job.lat}
            objectLng={job.lng}
            api={notesApi}
            title="Notatki"
            defaultOpen
            emptyText={seeAll ? "Nikt jeszcze nic nie dopisał." : "Nie ma jeszcze Twoich notatek."}
            hint={
              seeAll
                ? "Notatki i zdjęcia trafiają do biura. Widzisz notatki wszystkich, zmieniać możesz tylko własne."
                : "Notatki i zdjęcia trafiają do biura. Widzisz tu tylko te, które dodano z tego linku."
            }
          />
        )}

        <p className="pt-2 text-center text-xs text-muted-foreground">
          Masz pytania do zlecenia? Skontaktuj się z biurem, które wysłało Ci ten link.
        </p>
      </div>

      {canWork && (
        <>
          <PasekAkcji
            state={state}
            startedAt={job.startedAt}
            finishedAt={job.finishedAt}
            canEdit
            busy={busy}
            hasProtocol={false}
            canProtocol={false}
            canProgress={job.canProgress}
            allowReopen={false}
            withTabBar={false}
            onStart={() => setAskTime("start")}
            onFinish={() => setAskTime("finish")}
            onProtocol={() => {}}
            onReopen={() => {}}
          />
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
              if (action) void progress(action, at);
            }}
          />
        </>
      )}
    </>
  );
}

function Wygasl() {
  return (
    <Karta
      icon={LinkIcon}
      title="Link wygasł lub został unieważniony"
      description="Ten podgląd zlecenia nie jest już dostępny. Jeśli nadal go potrzebujesz, poproś biuro o nowy link."
      testId="share-gone"
    />
  );
}

/**
 * Meta tagi tylko na czas życia podglądu: link jest uprawnieniem, więc nie
 * może wyciec przez nagłówek Referer (klik w „Nawiguj” → Google Maps) ani
 * trafić do indeksu wyszukiwarki.
 */
function useSharePageHead() {
  useEffect(() => {
    const added: HTMLMetaElement[] = [];
    const put = (name: string, content: string) => {
      const m = document.createElement("meta");
      m.name = name;
      m.content = content;
      m.setAttribute("data-share-head", "");
      document.head.prepend(m);
      added.push(m);
    };
    put("referrer", "no-referrer");
    put("robots", "noindex, nofollow");
    const prevTitle = document.title;
    document.title = "Podgląd zlecenia";
    return () => {
      added.forEach((m) => m.remove());
      document.title = prevTitle;
    };
  }, []);
}

function Szkielet() {
  return (
    <div className="animate-pulse pt-3" aria-hidden data-testid="share-skeleton">
      <div className="mb-3 flex items-center gap-2 border-b pb-2">
        <div className="h-9 w-1 rounded-full bg-muted" />
        <div className="flex-1 space-y-1.5">
          <div className="h-4 w-2/3 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted/70" />
        </div>
      </div>
      <div className="h-12 rounded-xl bg-muted" />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="h-14 rounded-xl bg-muted" />
        <div className="h-14 rounded-xl bg-muted" />
      </div>
      <div className="mt-3 h-28 rounded-xl bg-muted" />
    </div>
  );
}

function Karta({
  icon: Icon,
  title,
  description,
  action,
  testId,
}: {
  icon: typeof LinkIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="pt-safe-3">
      <section className="mt-6 rounded-xl border bg-card p-4 text-card-foreground" data-testid={testId}>
        <Icon className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h1 className="mt-2 text-base font-semibold leading-snug">{title}</h1>
        <p className="mt-1 text-sm leading-snug text-muted-foreground">{description}</p>
        {action && <div className="mt-4">{action}</div>}
      </section>
    </div>
  );
}
