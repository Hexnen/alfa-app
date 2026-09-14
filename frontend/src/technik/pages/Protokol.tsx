import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, ClipboardList } from "lucide-react";
import {
  technikApi,
  type TechnikJobDistance,
  type TechnikProtocol,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SignatureDialog } from "@/components/SignatureDialog";
import { EmptyState } from "../ui/empty-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../ui/confirm";
import { useToast } from "../ui/toast";
import { useJob } from "../lib/useJob";
import { useTechnikAccess } from "../lib/access";
import { clockOf } from "../lib/dates";
import { rememberDeviceNames } from "../lib/devices";
import {
  STEP_KEYS,
  shortContactName,
  stepMarks,
  toForm,
  toPayload,
  type FormState,
  type StepKey,
} from "../lib/protocol";
import { Naglowek } from "../protokol/Naglowek";
import { KrokDane } from "../protokol/KrokDane";
import { KrokCzynnosci } from "../protokol/KrokCzynnosci";
import { KrokUrzadzenia } from "../protokol/KrokUrzadzenia";
import { KrokOdbior } from "../protokol/KrokOdbior";
import { PasekAkcji, type SaveState } from "../protokol/PasekAkcji";

/** Debounce autozapisu. Tyle mniej więcej trwa przerwa między zdaniami. */
const AUTOSAVE_MS = 1500;

/**
 * PROTOKÓŁ U KLIENTA — cztery kroki, jeden ekran na krok.
 *
 * Wcześniej był to jeden długi formularz: technik przewijał go w kółko, szukał
 * pola „Zapisz” i nie wiedział, czy czegoś nie pominął. Teraz kolejność jest
 * kolejnością pracy (kto i ile → co zrobiłem → co zostawiłem → odbiór),
 * a pasek kroków u góry mówi kropką, gdzie są braki.
 *
 * Świadomie NIE reużywa biurowego `ProtocolForm` (dialog, `grid-cols-4`,
 * przyciski druku): tamten jest projektowany pod mysz i monitor. Wspólny
 * zostaje `SignatureDialog` — podpis palcem jest dokładnie ten sam.
 *
 * ZAPIS: autozapis z debounce 1,5 s i przy każdym przejściu między krokami,
 * zawsze z `expectedUpdatedAt` z ostatniej odpowiedzi serwera. 409 (biuro
 * ruszyło ten sam protokół z desktopa) wstrzymuje autozapis i pyta — nigdy nie
 * nadpisujemy cudzej zmiany po cichu. Danych klienta technik nie edytuje:
 * przychodzą z prefillu i idą w PUT nietknięte. Po podpisie protokół jest
 * niezmienny, więc wszystkie pola się blokują — bez „cofnij podpis”.
 */
export function Protokol() {
  const { id } = useParams<{ id: string }>();
  const jobId = id ? Number(id) : null;
  const { job, loading: jobLoading, notFound, reload: reloadJob } = useJob(jobId);
  const { canEdit } = useTechnikAccess();
  const { toast, toastError } = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [protocol, setProtocol] = useState<TechnikProtocol | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  /** Słownik czynności z panelu admina (pusty = rząd chipów się nie renderuje). */
  const [dictionary, setDictionary] = useState<string[]>([]);
  const [distance, setDistance] = useState<TechnikJobDistance | null>(null);
  const [distanceLoading, setDistanceLoading] = useState(false);
  /** Czy kilometry wstawił automat (wtedy pod polem stoi adnotacja skąd). */
  const [kmFromDistance, setKmFromDistance] = useState(false);

  const protocolId = job?.protocol?.id ?? null;
  const signed = !!protocol && (protocol.status === "final" || !!protocol.signedAt);
  const readOnly = signed || !canEdit;

  /* ---------------------------------------------------------------- *
   * Wczytanie
   * ---------------------------------------------------------------- */

  const loadProtocol = useCallback(async () => {
    if (!protocolId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const p = await technikApi.protocol(protocolId);
      setProtocol(p);
      setForm(toForm(p));
      setDirty(false);
      setConflict(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się wczytać protokołu.");
    } finally {
      setLoading(false);
    }
  }, [protocolId]);

  useEffect(() => {
    void loadProtocol();
  }, [loadProtocol]);

  // Słownik czynności — brak albo błąd znaczy „bez podpowiedzi”, nigdy błąd
  // na ekranie: protokół musi dać się wypełnić także wtedy, gdy admin nic nie
  // ustawił, a technik jest w piwnicy z jedną kreską zasięgu.
  useEffect(() => {
    let alive = true;
    technikApi
      .activities()
      .then((list) => alive && setDictionary(list))
      .catch(() => alive && setDictionary([]));
    return () => {
      alive = false;
    };
  }, []);

  /* ---------------------------------------------------------------- *
   * Krok w adresie (?krok=2) — obrót ekranu i odświeżenie nie cofają
   * ---------------------------------------------------------------- */

  const stepParam = Number(params.get("krok"));
  const stepFromUrl: StepKey | null =
    stepParam >= 1 && stepParam <= STEP_KEYS.length ? STEP_KEYS[stepParam - 1] : null;
  // Podpisany protokół otwiera się na odbiorze: tam jest ekran zamknięcia.
  const step: StepKey = stepFromUrl ?? (signed ? "odbior" : "dane");
  const stepIndex = STEP_KEYS.indexOf(step);

  /* ---------------------------------------------------------------- *
   * Autozapis
   * ---------------------------------------------------------------- */

  // Referencje z najświeższym stanem: zapis odpala się z timera i z handlerów
  // nawigacji, więc nie może polegać na domknięciu sprzed 1,5 sekundy.
  const protocolRef = useRef<TechnikProtocol | null>(null);
  const formRef = useRef<FormState | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  useEffect(() => {
    protocolRef.current = protocol;
    formRef.current = form;
    dirtyRef.current = dirty;
    conflictRef.current = conflict;
  });

  /**
   * Zapis na serwer. Formularza po zapisie NIE podmieniamy odpowiedzią: backend
   * odsyła pozycje bez pustych wierszy, a świeżo dodane, jeszcze niewypełnione
   * urządzenie zniknęłoby technikowi spod palca. Z odpowiedzi bierzemy to, co
   * naprawdę jest nam potrzebne — nowe `updatedAt` do kolejnego PUT-a.
   */
  const flush = useCallback(async () => {
    const p = protocolRef.current;
    const f = formRef.current;
    if (!p || !f) return;
    if (!dirtyRef.current || savingRef.current || conflictRef.current) return;
    if (p.status === "final" || p.signedAt) return;
    savingRef.current = true;
    setSaving(true);
    const body = toPayload(p, f);
    try {
      const next = await technikApi.updateProtocol(p.id, body, p.updatedAt);
      setProtocol(next);
      protocolRef.current = next;
      setSavedAt(clockOf(next.updatedAt) || nowClock());
      // Ściągawka „ostatnio montowane” rośnie na zapisanych pozycjach, nie na
      // tym, co technik właśnie stuka w polu.
      rememberDeviceNames(body.items.map((i) => i.name));
      // Zmiana w trakcie lotu zostaje brudna — inaczej ostatnia literka nigdy
      // by nie poleciała na serwer.
      if (formRef.current === f) {
        dirtyRef.current = false;
        setDirty(false);
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        conflictRef.current = true;
        setConflict(true);
      } else {
        toastError(e instanceof Error ? e.message : "Nie udało się zapisać protokołu.");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [toastError]);

  // Debounce: każda zmiana formularza przesuwa zapis o 1,5 s do przodu.
  useEffect(() => {
    if (!dirty || readOnly || conflict) return;
    const t = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [form, dirty, readOnly, conflict, flush]);

  // Ostatni bezpiecznik: karta zamykana z niezapisanym protokołem. Autozapis
  // zwykle zdąży, ale „zwykle” to za mało przy godzinie roboty w polu.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /* ---------------------------------------------------------------- *
   * Zmiany formularza
   * ---------------------------------------------------------------- */

  const update = useCallback((fn: (prev: FormState) => FormState) => {
    setForm((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
  }, []);

  const set = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      // Ręczna poprawka kilometrów kasuje adnotację „z odległości od biura” —
      // przestałaby opisywać to, co stoi w polu.
      if (key === "actualKm") setKmFromDistance(false);
      update((prev) => ({ ...prev, [key]: value }));
    },
    [update],
  );

  /* ---------------------------------------------------------------- *
   * Kilometry z odległości od biura
   * ---------------------------------------------------------------- */

  /**
   * Liczymy raz, po wczytaniu protokołu, i wpisujemy TYLKO do pustego pola
   * świeżego protokołu — wartości wpisanej ręcznie (albo policzonej wcześniej
   * w biurze) automat nie nadpisuje. Od ręcznego przeliczenia jest chip
   * „Policz z biura”.
   *
   * Mnożnik „w obie strony” siedzi po stronie backendu (`suggestedKm`), bo to
   * ustawienie firmy — panel nie ma własnej kopii tej reguły.
   */
  useEffect(() => {
    if (!jobId || !protocol || readOnly || distance || distanceLoading) return;
    let alive = true;
    setDistanceLoading(true);
    technikApi
      .jobDistance(jobId)
      .then((d) => {
        if (!alive) return;
        setDistance(d);
        const suggested = d.km == null ? null : (d.suggestedKm ?? d.km);
        // `protocol.actualKm` to stan ZAPISANY — świeży protokół ma tu 0.
        if (suggested == null || Number(protocol.actualKm ?? 0) > 0 || dirtyRef.current) return;
        setForm((prev) => (prev ? { ...prev, actualKm: suggested } : prev));
        setKmFromDistance(true);
        setDirty(true);
      })
      .catch(() => {
        if (alive) setDistance({ km: null, reason: "Nie udało się policzyć odległości" });
      })
      .finally(() => {
        if (alive) setDistanceLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [jobId, protocol, readOnly, distance, distanceLoading]);

  const applySuggestedKm = () => {
    const suggested = distance?.km == null ? null : (distance.suggestedKm ?? distance.km);
    if (suggested == null) return;
    update((prev) => ({ ...prev, actualKm: suggested }));
    setKmFromDistance(true);
  };

  /* ---------------------------------------------------------------- *
   * Nawigacja
   * ---------------------------------------------------------------- */

  const back = useCallback(() => navigate(`/technik/zlecenie/${jobId}`), [navigate, jobId]);

  /** Skok na krok — z zapisem tego, co technik zdążył wpisać na poprzednim. */
  const goStep = useCallback(
    (next: StepKey) => {
      void flush();
      const p = new URLSearchParams(params);
      p.set("krok", String(STEP_KEYS.indexOf(next) + 1));
      setParams(p, { replace: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [flush, params, setParams],
  );

  /* ---------------------------------------------------------------- *
   * Podpis
   * ---------------------------------------------------------------- */

  const sign = async (signaturePng: string, signerName: string) => {
    const p = protocolRef.current;
    const f = formRef.current;
    if (!p || !f) return;
    try {
      // Podpis zamyka protokół, więc najpierw zapisujemy to, co technik zdążył
      // wpisać — inaczej ostatnie zdanie „wykonanych czynności” przepadłoby.
      // `expectedUpdatedAt` idzie z WERSJI po tym zapisie, nie sprzed niego.
      const base = dirtyRef.current
        ? await technikApi.updateProtocol(p.id, toPayload(p, f), p.updatedAt)
        : p;
      const after = await technikApi.signProtocol(base.id, {
        signaturePng,
        signerName,
        expectedUpdatedAt: base.updatedAt,
      });
      setProtocol(after);
      setForm(toForm(after));
      setDirty(false);
      dirtyRef.current = false;
      setSavedAt(clockOf(after.updatedAt) || nowClock());
      toast({ message: "Protokół podpisany", kind: "success" });
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        conflictRef.current = true;
        setConflict(true);
        throw new Error("Protokół zmienił się w biurze — wczytaj go ponownie i podpisz jeszcze raz.");
      }
      throw e;
    }
  };

  /** Założenie protokołu z poziomu tego ekranu (wejście z linku, świeże zlecenie). */
  const createProtocol = async () => {
    if (!jobId || creating) return;
    setCreating(true);
    try {
      await technikApi.createProtocol(jobId);
      // Numer protokołu przychodzi ze zlecenia — po założeniu wystarczy je
      // przeczytać jeszcze raz, a `protocolId` pociągnie wczytanie protokołu.
      reloadJob();
    } catch (e) {
      // 409 z protokołem w ciele znaczy „już jest” — to nie błąd, tylko wyścig
      // z drugim tapnięciem albo z ekranem zlecenia.
      if ((e as { protocol?: { id: number } | null }).protocol) reloadJob();
      else toastError(e instanceof Error ? e.message : "Nie udało się założyć protokołu.");
    } finally {
      setCreating(false);
    }
  };

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const marks = useMemo(() => (form ? stepMarks(form) : {}), [form]);

  const saveState: SaveState = signed
    ? "signed"
    : conflict
      ? "conflict"
      : saving
        ? "saving"
        : dirty
          ? "dirty"
          : savedAt
            ? "saved"
            : "idle";

  if (jobLoading || loading) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Ładuję protokół…</p>;
  }

  if (notFound || (!job && !protocol)) {
    return (
      <div className="pt-4">
        <EmptyState
          icon={AlertTriangle}
          title="Nie ma takiego zlecenia"
          description="Zlecenie zostało usunięte albo nie jesteś do niego przypisany."
          action={
            <Button asChild className="h-11">
              <Link to="/technik">Wróć do listy</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!protocol || !form) {
    return (
      <div className="pt-4">
        <EmptyState
          icon={ClipboardList}
          title="Protokołu jeszcze nie ma"
          description={error ?? "Załóż go tutaj albo na ekranie zlecenia."}
          action={
            <div className="flex flex-col gap-2 sm:flex-row">
              {canEdit && !error && (
                <Button className="h-11" disabled={creating} onClick={() => void createProtocol()}>
                  {creating ? "Zakładam…" : "Załóż protokół"}
                </Button>
              )}
              <Button variant="outline" className="h-11" onClick={back}>
                Wróć do zlecenia
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const stepProps = { protocol, job, form, set, update, readOnly };

  return (
    <>
      <Naglowek
        protocol={protocol}
        job={job}
        signed={signed}
        step={step}
        marks={marks}
        onStep={goStep}
        onBack={back}
      />

      <div className="pb-28">
        {step === "dane" && (
          <KrokDane
            {...stepProps}
            distance={distance}
            distanceLoading={distanceLoading}
            kmFromDistance={kmFromDistance}
            onKmFromOffice={applySuggestedKm}
          />
        )}
        {step === "czynnosci" && <KrokCzynnosci {...stepProps} dictionary={dictionary} />}
        {step === "urzadzenia" && <KrokUrzadzenia {...stepProps} />}
        {step === "odbior" && (
          <KrokOdbior
            {...stepProps}
            signed={signed}
            onSign={() => setSignOpen(true)}
            onGap={goStep}
          />
        )}
      </div>

      <PasekAkcji
        state={saveState}
        savedAt={savedAt}
        canBack={stepIndex > 0}
        lastStep={stepIndex === STEP_KEYS.length - 1}
        signed={signed}
        disabled={readOnly}
        onBack={() => (stepIndex > 0 ? goStep(STEP_KEYS[stepIndex - 1]) : back())}
        onNext={() => goStep(STEP_KEYS[Math.min(stepIndex + 1, STEP_KEYS.length - 1)])}
        onSign={() => setSignOpen(true)}
        onFinish={back}
      />

      {/* Montowany DOPIERO przy otwarciu: `SignatureDialog` czyta
          `defaultSignerName` tylko raz, w `useState` przy montażu. Trzymany na
          stałe w drzewie (ekran protokołu żyje przez cały czas wypełniania)
          zapamiętywał prefill z chwili wejścia i podpisywał nim protokół, mimo
          że technik wpisał w „Osoba odbierająca” kogoś innego. */}
      {signOpen && (
        <SignatureDialog
          open
          onClose={() => setSignOpen(false)}
          onSave={sign}
          defaultSignerName={form.contact || shortContactName(protocol.contact)}
        />
      )}

      {/* 409 — biuro ruszyło ten sam protokół z desktopa. Cicha nadpiska
          skasowałaby cudzą zmianę, więc autozapis staje i technik wybiera. */}
      <AlertDialog open={conflict} onOpenChange={(o) => !o && setConflict(false)}>
        <AlertDialogContent>
          <AlertDialogTitle>Protokół zmienił się w biurze</AlertDialogTitle>
          <AlertDialogDescription>
            Ktoś zapisał ten protokół z komputera, więc Twoje ostatnie zmiany nie poszły na serwer.
            Wczytaj wersję z biura (to, co masz na ekranie, przepadnie) albo przepisz swoje zmiany
            do notatki i dopiero wczytaj.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Jeszcze nie</AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              data-testid="protokol-wczytaj-ponownie"
              onClick={() => {
                setConflict(false);
                conflictRef.current = false;
                void loadProtocol();
              }}
            >
              Wczytaj ponownie
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function nowClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
