import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ChevronLeft,
  ClipboardList,
  Package,
  PenLine,
  Plus,
  Route,
  Save,
  Trash2,
  User,
} from "lucide-react";
import {
  technikApi,
  type TechnikJobDistance,
  type TechnikProtocol,
  type ProtocolInput,
  type ProtocolItem,
  type ProtocolWorkType,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { SignatureDialog } from "@/components/SignatureDialog";
import { Section } from "../ui/section";
import { SegmentedControl } from "../ui/segmented";
import { EmptyState } from "../ui/empty-state";
import { Chip } from "../ui/chip";
import { ClearableInput, ClearableTextarea } from "../ui/clearable-input";
import { useToast } from "../ui/toast";
import { useJob } from "../lib/useJob";
import { useTechnikAccess } from "../lib/access";
import { clockOf, dayOf, todayIso } from "../lib/dates";
import { scrollFieldIntoView } from "../lib/keyboard";
import { hasActivityLine, toggleActivityLine } from "../lib/activities";

const WORK_TYPES: { value: ProtocolWorkType; label: string }[] = [
  { value: "serwis", label: "Serwis" },
  { value: "montaz", label: "Montaż" },
  { value: "wizja", label: "Wizja" },
  { value: "inne", label: "Inne" },
];

/**
 * Jednostki pozycji protokołu. Wpisywane z palca bywały przypadkowe („sz”,
 * „SZT”, puste), a na papierze mają wyglądać jednakowo — stąd zamknięta lista
 * i natywny `<select>` (na tablecie otwiera systemowy picker; Select Radixa
 * zostaje dla desktopu, zgodnie z zasadami panelu).
 *
 * „mb” jest w liście, bo tak zapisane jednostki naprawdę siedzą w bazie
 * (protokoły: „MB”, cennik: „MB”, „RBH”, „KM”). Wartość spoza listy nigdy nie
 * znika — `unitOptions` dokleja ją jako dodatkową pozycję.
 */
const UNITS = ["szt.", "kpl.", "m", "mb", "m²", "godz.", "rbh", "usł."] as const;
const DEFAULT_UNIT = "szt.";

/** Lista opcji dla jednej pozycji — z wartością z bazy, nawet jeśli jest nietypowa. */
function unitOptions(current: string): string[] {
  const v = current.trim();
  return !v || UNITS.includes(v as (typeof UNITS)[number]) ? [...UNITS] : [v, ...UNITS];
}

const EMPTY_ITEM: ProtocolItem = { name: "", serial: "", unit: DEFAULT_UNIT, qty: "1" };

/** „23.4” → „23,4” — na protokole i w podpowiedzi liczby są po polsku. */
const pl = (n: number): string => String(n).replace(".", ",");

/**
 * Kontakt z prefillu bywa sklejką: „Jan Nowak (kierownik), +48 600…, jan@x.pl”.
 * W polu „Osoba odbierająca” — i pod podpisem klienta — ma stać samo nazwisko,
 * bo to ono trafia na dokument jako `signerName`. Całą sklejkę pokazujemy pod
 * polem jako podpowiedź; prefillu po stronie backendu NIE ruszamy, bo dzieli go
 * z nami moduł biurowy.
 */
function shortContactName(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!/[(,]/.test(trimmed)) return trimmed;
  return trimmed.split(/[(,]/)[0].trim() || trimmed;
}

/** Edytowalny stan formularza — reszta protokołu jest tylko do odczytu. */
interface FormState {
  workDate: string;
  workType: ProtocolWorkType;
  actualHours: string;
  actualKm: string;
  activities: string;
  contact: string;
  items: ProtocolItem[];
}

function toForm(p: TechnikProtocol): FormState {
  return {
    workDate: dayOf(p.workDate || todayIso()),
    workType: p.workType,
    actualHours: String(p.actualHours ?? ""),
    actualKm: String(p.actualKm ?? ""),
    activities: p.activities ?? "",
    contact: shortContactName(p.contact ?? ""),
    items: p.items?.length ? p.items.map((i) => ({ ...i })) : [],
  };
}

/**
 * PROTOKÓŁ U KLIENTA — pełnoekranowy, jednokolumnowy formularz.
 *
 * Świadomie NIE reużywa biurowego `ProtocolForm` (dialog, `grid-cols-4`,
 * przyciski druku): tamten jest projektowany pod mysz i monitor, tu liczy się
 * jedna kolumna, cele 44 px i pasek akcji nad klawiaturą. Wspólny zostaje
 * `SignatureDialog` — podpis palcem jest dokładnie ten sam.
 *
 * Nagłówek z danymi klienta jest READ-ONLY: przychodzi z prefillu (obiekt →
 * kontrahent) i technik nie ma go u klienta poprawiać. Po podpisie protokół
 * jest niezmienny, więc wszystkie pola się blokują — bez „cofnij podpis”.
 */
export function Protokol() {
  const { id } = useParams<{ id: string }>();
  const jobId = id ? Number(id) : null;
  const { job, loading: jobLoading, notFound } = useJob(jobId);
  const { canEdit } = useTechnikAccess();
  const { toast, toastError } = useToast();
  const navigate = useNavigate();

  const [protocol, setProtocol] = useState<TechnikProtocol | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  /** Słownik czynności z panelu admina (pusty = rząd chipów się nie renderuje). */
  const [activities, setActivities] = useState<string[]>([]);
  const [distance, setDistance] = useState<TechnikJobDistance | null>(null);
  const [distanceLoading, setDistanceLoading] = useState(false);
  /** Czy kilometry wstawił automat (wtedy pod polem stoi adnotacja skąd). */
  const [kmFromDistance, setKmFromDistance] = useState(false);

  const protocolId = job?.protocol?.id ?? null;

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
      .then((list) => alive && setActivities(list))
      .catch(() => alive && setActivities([]));
    return () => {
      alive = false;
    };
  }, []);

  const signed = !!protocol && (protocol.status === "final" || !!protocol.signedAt);
  const readOnly = signed || !canEdit;

  // Ostrzeżenie przy wyjściu z niezapisanym protokołem. Autozapisu szkicu
  // świadomie nie ma (poza v1), więc to jedyny bezpiecznik przed zamknięciem
  // karty z godziną roboty w polu „wykonane czynności”.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
  }, []);

  const setItem = useCallback((idx: number, patch: Partial<ProtocolItem>) => {
    setForm((prev) =>
      prev
        ? { ...prev, items: prev.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }
        : prev,
    );
    setDirty(true);
  }, []);

  /**
   * KILOMETRY Z ODLEGŁOŚCI OD BIURA. Liczymy raz, po wczytaniu protokołu,
   * i wpisujemy TYLKO do pustego pola świeżego protokołu — wartości wpisanej
   * ręcznie (albo policzonej wcześniej w biurze) automat nie nadpisuje. Od
   * ręcznego przeliczenia jest chip „Policz z biura” obok pola.
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
        if (suggested == null || Number(protocol.actualKm ?? 0) > 0 || dirty) return;
        setForm((prev) => (prev ? { ...prev, actualKm: String(suggested) } : prev));
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
    // `dirty` celowo poza zależnościami: efekt ma się wykonać RAZ dla protokołu,
    // a nie odpalać ponownie przy każdej literce wpisanej w formularzu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, protocol, readOnly, distance, distanceLoading]);

  /** Sugestia kilometrów do wpisania (null = nie ma czego proponować). */
  const suggestedKm = distance?.km == null ? null : (distance.suggestedKm ?? distance.km);

  const applySuggestedKm = () => {
    if (suggestedKm == null) return;
    set("actualKm", String(suggestedKm));
    setKmFromDistance(true);
  };

  const payload = useMemo<ProtocolInput | null>(() => {
    if (!protocol || !form) return null;
    return {
      workDate: form.workDate,
      workType: form.workType,
      actualHours: form.actualHours,
      actualKm: form.actualKm,
      contractor: protocol.contractor ?? "",
      salesperson: protocol.salesperson ?? "",
      clientName: protocol.clientName ?? "",
      clientNip: protocol.clientNip ?? "",
      clientCity: protocol.clientCity ?? "",
      installationAddress: protocol.installationAddress ?? "",
      contact: form.contact,
      activities: form.activities,
      // Puste wiersze (technik dodał i nie wypełnił) nie mają lądować na papierze.
      items: form.items.filter((i) => i.name.trim() || i.serial.trim()),
      status: protocol.status,
    };
  }, [protocol, form]);

  const save = async () => {
    if (!protocol || !payload || saving) return;
    setSaving(true);
    try {
      const next = await technikApi.updateProtocol(protocol.id, payload, protocol.updatedAt);
      setProtocol(next);
      setForm(toForm(next));
      setDirty(false);
      setSavedAt(clockOf(next.updatedAt) || nowClock());
    } catch (e) {
      const status = (e as { status?: number }).status;
      toastError(
        status === 409
          ? "Protokół zmienił się w biurze — odśwież i wpisz zmiany jeszcze raz."
          : e instanceof Error
            ? e.message
            : "Nie udało się zapisać protokołu.",
      );
    } finally {
      setSaving(false);
    }
  };

  const sign = async (signaturePng: string, signerName: string) => {
    if (!protocol) return;
    // Podpis zamyka protokół, więc najpierw zapisujemy to, co technik zdążył
    // wpisać — inaczej ostatnie zdanie „wykonanych czynności” przepadłoby.
    // `expectedUpdatedAt` idzie z WERSJI po tym zapisie, nie sprzed niego.
    const base = dirty && payload
      ? await technikApi.updateProtocol(protocol.id, payload, protocol.updatedAt)
      : protocol;
    if (base !== protocol) setProtocol(base);
    const after = await technikApi.signProtocol(base.id, {
      signaturePng,
      signerName,
      expectedUpdatedAt: base.updatedAt,
    });
    setProtocol(after);
    setForm(toForm(after));
    setDirty(false);
    toast({ message: "Protokół podpisany", kind: "success" });
  };

  const back = () => navigate(`/technik/zlecenie/${jobId}`);

  /** Sklejka z kartoteki, gdy w polu stoi już samo nazwisko z niej wycięte. */
  const contactHint =
    protocol?.contact && protocol.contact.trim() !== (form?.contact ?? "").trim()
      ? protocol.contact.trim()
      : null;

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
          description={error ?? "Załóż go na ekranie zlecenia."}
          action={
            <Button className="h-11" onClick={back}>
              Wróć do zlecenia
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <>
      {/* --- STICKY NAGŁÓWEK ------------------------------------------- */}
      <header className="sticky top-0 z-30 -mx-4 mb-3 border-b bg-background/95 px-2 pt-safe backdrop-blur-sm">
        <div className="flex min-h-12 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Wstecz"
            className="h-11 w-11 shrink-0"
            onClick={back}
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1 pl-1">
            <h1 className="truncate text-base font-semibold leading-tight tabular-nums">
              Protokół {protocol.number}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {signed
                ? `Podpisany${protocol.signerName ? ` — ${protocol.signerName}` : ""}`
                : savedAt
                  ? `Zapisano ${savedAt}`
                  : dirty
                    ? "Niezapisane zmiany"
                    : "Szkic"}
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-4 pb-28">
        {/* Prefill danych klienta wisi na obiekcie — bez niego protokół wyjdzie
            pusty w nagłówku i biuro będzie go poprawiać ręcznie. */}
        {job && !job.objectName && (
          <p className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              Zlecenie nie ma przypiętego obiektu, więc dane klienta mogły się nie uzupełnić.
              Zgłoś to biuru po zakończeniu.
            </span>
          </p>
        )}

        {/* --- DANE KLIENTA (read-only) ------------------------------- */}
        <Section id="klient" icon={User} title="Klient">
          <dl className="space-y-1 text-sm">
            <ReadRow label="Nazwa" value={protocol.clientName} />
            <ReadRow label="NIP" value={protocol.clientNip} />
            <ReadRow label="Miejscowość" value={protocol.clientCity} />
            <ReadRow label="Adres montażu" value={protocol.installationAddress} />
            <ReadRow label="Obiekt" value={protocol.site ?? job?.objectName ?? null} />
          </dl>
        </Section>

        {/* --- PODSTAWOWE DANE ---------------------------------------- */}
        <Section id="dane" icon={ClipboardList} title="Wykonanie">
          <div className="space-y-1.5">
            <Label htmlFor="p-date">Data</Label>
            <Input
              id="p-date"
              type="date"
              value={form.workDate}
              disabled={readOnly}
              onChange={(e) => set("workDate", e.target.value)}
              className="h-12 text-base"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Rodzaj prac</Label>
            <SegmentedControl
              label="Rodzaj prac"
              value={form.workType}
              onChange={(v) => !readOnly && set("workType", v)}
              options={WORK_TYPES.map((t) => ({ ...t, disabled: readOnly }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-hours">Godziny</Label>
              <ClearableInput
                id="p-hours"
                type="number"
                inputMode="decimal"
                step="0.5"
                min="0"
                value={form.actualHours}
                disabled={readOnly}
                onChange={(v) => set("actualHours", v)}
                onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
                clearLabel="Wyczyść godziny"
                className="h-12 text-base tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-km">Kilometry</Label>
              <ClearableInput
                id="p-km"
                type="number"
                inputMode="numeric"
                step="1"
                min="0"
                value={form.actualKm}
                disabled={readOnly}
                onChange={(v) => {
                  set("actualKm", v);
                  // Ręczna poprawka — adnotacja „z odległości od biura” przestaje
                  // opisywać to, co jest w polu.
                  setKmFromDistance(false);
                }}
                onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
                clearLabel="Wyczyść kilometry"
                className="h-12 text-base tabular-nums"
              />
              {/* Podpowiedź kilometrów: na tablecie nie ma hovera, więc powód
                  braku wyniku stoi tekstem pod polem, a nie w tooltipie. */}
              {!readOnly && (
                <div className="text-xs leading-snug text-muted-foreground" data-testid="km-hint">
                  {distanceLoading ? (
                    "Liczę odległość od biura…"
                  ) : suggestedKm != null && distance ? (
                    kmFromDistance ? (
                      <span>
                        z odległości od biura: {pl(distance.km ?? suggestedKm)} km
                        {distance.roundTrip ? " × 2" : ""}
                      </span>
                    ) : (
                      <Chip
                        type="button"
                        tone="neutral"
                        className="h-9 min-h-0 px-3 text-xs"
                        data-testid="km-from-office"
                        onClick={applySuggestedKm}
                      >
                        <Route className="h-3.5 w-3.5" aria-hidden />
                        Policz z biura ({pl(suggestedKm)} km)
                      </Chip>
                    )
                  ) : distance?.reason ? (
                    <span>Nie policzę km: {distance.reason}</span>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-activities">Wykonane czynności</Label>

            {/* Chipy ze słownika admina: tap = dopisanie linii, ponowny tap =
                usunięcie. Stoją NAD polem, bo pod nim siedziałyby za klawiaturą.
                Rząd przewija się poziomo i nie zawija — wysokość formularza ma
                być przewidywalna. */}
            {activities.length > 0 && !readOnly && (
              <div
                className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5"
                data-testid="activity-chips"
              >
                {activities.map((a) => {
                  const on = hasActivityLine(form.activities, a);
                  return (
                    <Chip
                      key={a}
                      selected={on}
                      showCheck
                      tone="primary"
                      className="max-w-[15rem] shrink-0"
                      onClick={() => set("activities", toggleActivityLine(form.activities, a))}
                    >
                      <span className="truncate">{a}</span>
                    </Chip>
                  );
                })}
              </div>
            )}

            <AutoGrowTextarea
              id="p-activities"
              value={form.activities}
              disabled={readOnly}
              onChange={(v) => set("activities", v)}
              placeholder="Co zostało zrobione na obiekcie…"
            />
          </div>
        </Section>

        {/* --- POZYCJE -------------------------------------------------- */}
        <Section
          id="pozycje"
          icon={Package}
          title={`Zamontowane urządzenia (${form.items.length})`}
        >
          {/* Pusta lista to jedno zdanie, nie duży EmptyState: „brak urządzeń”
              jest normalnym wynikiem serwisu i nie ma czego celebrować. */}
          {form.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nic nie zamontowano. Dodaj urządzenie, jeśli coś zostało na obiekcie.
            </p>
          )}

          {/*
            KARTA URZĄDZENIA — jeden zwarty wiersz zamiast czterech pól jedno pod
            drugim: nazwa (jedyne pole, którego szuka oko) w pełnej szerokości,
            a pod nią linia szczegółów: nr seryjny · ilość · jednostka. Trzy
            pozycje mieszczą się teraz na jednym ekranie 390 px, a na 820 px nie
            robią się z tego pasy na pół strony.
          */}
          <ul className="space-y-2">
            {form.items.map((item, idx) => {
              const unitValue = item.unit?.trim() || DEFAULT_UNIT;
              return (
                <li key={idx} className="rounded-lg border bg-card p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-4 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">
                      {idx + 1}
                    </span>
                    <ClearableInput
                      aria-label={`Nazwa urządzenia ${idx + 1}`}
                      value={item.name}
                      disabled={readOnly}
                      onChange={(v) => setItem(idx, { name: v })}
                      onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
                      placeholder="Nazwa urządzenia"
                      clearLabel={`Wyczyść nazwę urządzenia ${idx + 1}`}
                      wrapperClassName="min-w-0 flex-1"
                      className="h-11 text-base"
                    />
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Usuń urządzenie ${idx + 1}`}
                        className="h-11 w-11 shrink-0 text-destructive"
                        onClick={() => {
                          setForm((prev) =>
                            prev ? { ...prev, items: prev.items.filter((_, i) => i !== idx) } : prev,
                          );
                          setDirty(true);
                        }}
                      >
                        <Trash2 className="h-5 w-5" />
                      </Button>
                    )}
                  </div>

                  <div className="mt-1.5 flex items-center gap-1.5 pl-[1.375rem]">
                    <ClearableInput
                      aria-label={`Numer seryjny urządzenia ${idx + 1}`}
                      value={item.serial}
                      disabled={readOnly}
                      onChange={(v) => setItem(idx, { serial: v })}
                      onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
                      placeholder="Nr seryjny"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      clearLabel={`Wyczyść numer seryjny urządzenia ${idx + 1}`}
                      wrapperClassName="min-w-0 flex-1"
                      className="h-11 text-base"
                    />
                    <Input
                      aria-label={`Ilość urządzenia ${idx + 1}`}
                      value={item.qty}
                      disabled={readOnly}
                      inputMode="decimal"
                      onChange={(e) => setItem(idx, { qty: e.target.value })}
                      onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
                      placeholder="Ilość"
                      className="h-11 w-16 shrink-0 px-2 text-center text-base tabular-nums"
                    />
                    {/*
                      Jednostka z listy zamiast wolnego tekstu — na papierze mają
                      wyglądać tak samo. Natywny `<select>` jest CELOWY: na
                      tablecie otwiera systemowy picker (Select Radixa dopiero od
                      `lg`), a wartość spoza listy zostaje jako dodatkowa opcja.
                    */}
                    <select
                      aria-label={`Jednostka urządzenia ${idx + 1}`}
                      value={unitValue}
                      disabled={readOnly}
                      onChange={(e) => setItem(idx, { unit: e.target.value })}
                      className="h-11 w-[4.75rem] shrink-0 rounded-md border border-input bg-background px-2 text-base disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {unitOptions(unitValue).map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              );
            })}
          </ul>
          {!readOnly && (
            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => {
                setForm((prev) => (prev ? { ...prev, items: [...prev.items, { ...EMPTY_ITEM }] } : prev));
                setDirty(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Dodaj urządzenie
            </Button>
          )}
        </Section>

        {/* --- ODBIÓR --------------------------------------------------- */}
        <Section id="odbior" icon={PenLine} title="Odbiór">
          <div className="space-y-1.5">
            <Label htmlFor="p-contact">Osoba odbierająca</Label>
            <ClearableInput
              id="p-contact"
              value={form.contact}
              disabled={readOnly}
              onChange={(v) => set("contact", v)}
              onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
              placeholder="Imię i nazwisko"
              autoComplete="off"
              clearLabel="Wyczyść osobę odbierającą"
              className="h-12 text-base"
            />
            {/* Pełna sklejka z kartoteki (telefon, mail, rola) zostaje pod polem
                jako podpowiedź — w polu ma być samo nazwisko, bo to ono idzie
                na dokument jako podpisujący. */}
            {contactHint && (
              <p className="text-xs leading-snug text-muted-foreground" data-testid="contact-hint">
                Kontakt z kartoteki: {contactHint}
              </p>
            )}
          </div>

          {signed && protocol.signaturePng && (
            <div className="rounded-lg border bg-white p-2">
              <img
                src={protocol.signaturePng}
                alt={`Podpis: ${protocol.signerName ?? "klient"}`}
                className="mx-auto max-h-32"
              />
              <p className="mt-1 text-center text-xs text-muted-foreground">
                {protocol.signerName || "—"}
                {protocol.signedAt ? ` · ${clockOf(protocol.signedAt)}` : ""}
              </p>
            </div>
          )}
        </Section>
      </div>

      {/* --- STICKY PASEK AKCJI (nad klawiaturą) ---------------------- */}
      {!readOnly && (
        <div className="fixed inset-x-0 bottom-kb z-40 border-t bg-background/95 backdrop-blur-sm">
          <div className="mx-auto flex w-full max-w-3xl gap-2 px-4 py-2.5">
            <Button
              variant="outline"
              size="lg"
              className={cn("h-12 flex-1 text-base", !dirty && "opacity-70")}
              disabled={saving}
              onClick={() => void save()}
            >
              <Save className="mr-2 h-5 w-5" />
              {saving ? "Zapisywanie…" : "Zapisz"}
            </Button>
            <Button
              size="lg"
              className="h-12 flex-1 text-base"
              disabled={saving}
              onClick={() => setSignOpen(true)}
            >
              <PenLine className="mr-2 h-5 w-5" />
              Podpis klienta
            </Button>
          </div>
        </div>
      )}

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
          defaultSignerName={form.contact || shortContactName(protocol.contact ?? "")}
        />
      )}
    </>
  );
}

function nowClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ReadRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words font-medium">{value || "—"}</dd>
    </div>
  );
}

/**
 * Textarea rosnąca z treścią — „wykonane czynności” bywa jednym zdaniem
 * i bywa dziesięcioma, a przewijanie wewnątrz małego pola na dotyku walczy
 * z przewijaniem strony.
 */
function AutoGrowTextarea({
  id,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 96)}px`;
  }, [value]);

  return (
    <ClearableTextarea
      id={id}
      ref={ref}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={onChange}
      onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
      rows={3}
      clearLabel="Wyczyść wykonane czynności"
      className="resize-none overflow-hidden text-base leading-relaxed"
    />
  );
}
