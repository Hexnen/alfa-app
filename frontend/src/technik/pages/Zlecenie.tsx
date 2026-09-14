import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  Building2,
  Camera,
  ChevronLeft,
  CircleCheckBig,
  FileText,
  MessageSquare,
  Navigation,
  Paperclip,
  Phone,
  Play,
  Plus,
  Send,
  StickyNote,
  Users,
  X,
} from "lucide-react";
import {
  technikApi,
  CALENDAR_ATTACHMENT_MAX_FILES,
  type CalendarNoteAttachment,
  type TechnikJobDistance,
  type TechnikJobNote,
  type TechnikProtocolConflict,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
// Znacznik pogody wprost z kalendarza — ta sama ikona WMO i ta sama paleta.
import { WeatherMark } from "@/components/CalendarWeather";
import { fmtMinutes } from "@/lib/calendar-labels";
import { ClearableTextarea } from "../ui/clearable-input";
import { cn } from "@/lib/utils";
import { Section } from "../ui/section";
import { EmptyState } from "../ui/empty-state";
import { ActionTimeDialog } from "../ui/action-time";
import { ConfirmDialog } from "../ui/confirm";
import { Lightbox } from "../ui/lightbox";
import { shrinkImage } from "../lib/image";
import { useToast } from "../ui/toast";
import { useJob } from "../lib/useJob";
import { useJobWeather } from "../lib/useWeather";
import { useTechnikAccess } from "../lib/access";
import { clockOf, formatDayTitle, dayOf, timeOf } from "../lib/dates";
import {
  JOB_STATE_CLASSES,
  JOB_STATE_LABELS,
  jobStateOf,
  mapsHref,
  telHref,
  JOB_STATE_ICONS,
  jobTypeMeta,
  typeBarClass,
} from "../lib/jobs";

/**
 * SZCZEGÓŁY ZLECENIA — ekran, na którym technik stoi pod bramą.
 *
 * Kolejność sekcji to kolejność pytań: gdzie jadę → jak tam dojadę → do kogo
 * dzwonię → co mam zrobić → co już ustaliliśmy → papier. Adres i telefon są
 * pełnowymiarowymi celami dotykowymi, a nie tekstem do skopiowania.
 *
 * Na dole sticky pasek z JEDNYM głównym przyciskiem, który zmienia się wraz ze
 * stanem: Rozpocznij → Zakończ → Protokół. Primary nigdy nie ląduje na końcu
 * scrolla, bo przy długim opisie technik by go po prostu nie znalazł.
 */
export function Zlecenie() {
  const { id } = useParams<{ id: string }>();
  const jobId = id ? Number(id) : null;
  const { job, loading, notFound, error, reload, patch } = useJob(jobId);
  const { canEdit } = useTechnikAccess();
  const { toast, toastError } = useToast();
  const navigate = useNavigate();

  const [busy, setBusy] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  /** Które działanie pyta o godzinę („Teraz” / „Inna godzina”). */
  const [askTime, setAskTime] = useState<"start" | "finish" | null>(null);

  // --- Zdjęcia do notatki ---------------------------------------------
  // Wybrane, jeszcze niewysłane zdjęcia (z aparatu albo z galerii). Trzymamy
  // przy nich `previewUrl`, bo miniatura ma być widoczna PRZED wysyłką —
  // technik musi zobaczyć, że trafił w kamerę, a nie w swój but.
  const [picked, setPicked] = useState<PickedPhoto[]>([]);
  /** Tekstowy postęp wysyłki („Przygotowuję 2 z 3…”) — kręciołek nic tu nie mówi. */
  const [progress, setProgress] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Otwarty podgląd: notatka + indeks zdjęcia w jej galerii. */
  const [lightbox, setLightbox] = useState<{ noteId: number; index: number } | null>(null);
  /** Załącznik czekający na potwierdzenie usunięcia. */
  const [toDelete, setToDelete] = useState<CalendarNoteAttachment | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Adresy blob żyją tylko na czas wyboru: pojedyncze zwalniamy przy usunięciu
  // i po wysłaniu, a wyjście z ekranu sprząta resztę (seria zdjęć zostałaby
  // inaczej w pamięci tabletu). Ref, bo efekt ma się wykonać TYLKO przy odmontowaniu.
  const pickedRef = useRef<PickedPhoto[]>([]);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);
  useEffect(() => () => revokeAll(pickedRef.current), []);

  // Pogoda dnia zlecenia — ten sam batch co na listach, tu dla jednego id.
  const weather = useJobWeather(job);

  // --- Dojazd z biura (pod „Nawiguj") ---------------------------------
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

  if (loading && !job) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Ładuję zlecenie…</p>;
  }

  if (notFound) {
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

  if (!job) {
    return (
      <div className="pt-4">
        <EmptyState
          icon={AlertTriangle}
          title="Nie udało się wczytać zlecenia"
          description={error ?? "Sprawdź połączenie i spróbuj ponownie."}
          action={
            <Button className="h-11" onClick={reload}>
              Spróbuj ponownie
            </Button>
          }
        />
      </div>
    );
  }

  const state = jobStateOf(job);
  const typeMeta = jobTypeMeta(job.type);
  const TypeIcon = typeMeta?.icon;
  const StateIcon = JOB_STATE_ICONS[state];
  const navHref = mapsHref(job);
  // Backend nie zagnieżdża obiektu ani kontaktu — składa je już po swojej
  // stronie (obiekt → kontrahent) i oddaje jako płaskie pola JobJson.
  const phone = telHref(job.contactPhone);
  const objectName = job.objectName;
  const addressLine = job.address;

  const start = async (at?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await technikApi.start(job.id, at);
      patch(next);
      toast({ message: `Rozpoczęto o ${clockOf(next.startedAt) || timeOf(next.startAt)}`, kind: "success" });
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

  /** Zdjęcia z `<input type="file">` — dokładane do już wybranych, do limitu serwera. */
  const pickPhotos = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const room = CALENDAR_ATTACHMENT_MAX_FILES - picked.length;
    if (room <= 0) {
      toastError(`Do jednej notatki można dodać najwyżej ${CALENDAR_ATTACHMENT_MAX_FILES} zdjęć.`);
      return;
    }
    const files = Array.from(list).slice(0, room);
    if (list.length > room) {
      toastError(`Dodano ${files.length} z ${list.length} — limit to ${CALENDAR_ATTACHMENT_MAX_FILES} zdjęć na notatkę.`);
    }
    setPicked((prev) => [
      ...prev,
      ...files.map((file) => ({ key: `${file.name}-${file.lastModified}-${Math.random()}`, file, previewUrl: URL.createObjectURL(file) })),
    ]);
  };

  const removePicked = (key: string) => {
    setPicked((prev) => {
      const gone = prev.find((p) => p.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  };

  const addNote = async () => {
    const content = noteText.trim();
    if ((!content && picked.length === 0) || noteBusy) return;
    setNoteBusy(true);
    try {
      if (picked.length === 0) {
        await technikApi.addNote(job.id, content);
      } else {
        // Kompresja idzie plik po pliku — na tablecie to sekunda na zdjęcie,
        // więc technik ma widzieć, na którym stoimy.
        const files: File[] = [];
        for (const [i, p] of picked.entries()) {
          setProgress(`Przygotowuję ${i + 1} z ${picked.length}…`);
          files.push(await shrinkImage(p.file));
        }
        setProgress(`Wysyłam ${photoCount(files.length)}…`);
        await technikApi.addNoteWithFiles(job.id, { text: content, files });
      }
      revokeAll(picked);
      setPicked([]);
      setNoteText("");
      toast({ message: picked.length ? "Zdjęcia dodane do notatek" : "Notatka dodana", kind: "success" });
      reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Nie udało się zapisać notatki.");
    } finally {
      setProgress(null);
      setNoteBusy(false);
    }
  };

  /** Usunięcie zdjęcia z notatki — po potwierdzeniu, bo pliku nie da się cofnąć. */
  const deleteAttachment = async (att: CalendarNoteAttachment) => {
    setDeleteBusy(true);
    try {
      await technikApi.deleteAttachment(att.id);
      setLightbox(null);
      setToDelete(null);
      toast({ message: "Zdjęcie usunięte", kind: "success" });
      reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Nie udało się usunąć zdjęcia.");
    } finally {
      setDeleteBusy(false);
    }
  };

  // Jeden główny przycisk, trzy stany. „Protokół” zamiast „Zakończ” tam, gdzie
  // robota jest domknięta — start byłby wtedy pomyłką, nie skrótem.
  const primary =
    state === "planned"
      ? { label: "Rozpocznij", icon: Play, onClick: () => setAskTime("start") }
      : state === "running"
        ? { label: "Zakończ", icon: CircleCheckBig, onClick: () => setAskTime("finish") }
        : { label: job.protocol ? "Protokół" : "Załóż protokół", icon: FileText, onClick: openProtocol };
  const PrimaryIcon = primary.icon;
  const showActions = canEdit && state !== "cancelled";

  return (
    <>
      {/* --- STICKY NAGŁÓWEK — typ, godzina, status --------------------- */}
      <header className="sticky top-0 z-30 -mx-4 mb-3 border-b bg-background/95 px-2 pt-safe backdrop-blur-sm">
        <div className="flex min-h-12 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Wstecz"
            className="h-11 w-11 shrink-0"
            onClick={() => navigate("/technik")}
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          {/* Pasek i ikona typu z kalendarza technicznego — technik ma poznać
              rodzaj roboty tym samym znakiem, co biuro na kafelku. */}
          <span aria-hidden className={cn("h-8 w-1 shrink-0 rounded-full", typeBarClass(job.type))} />
          <div className="min-w-0 flex-1 pl-1">
            <h1 className="flex items-center gap-1.5 truncate text-base font-semibold leading-tight">
              {TypeIcon && <TypeIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
              {typeMeta?.label ?? job.typeLabel}
            </h1>
            {/* Dwie linie: „poniedziałek, 14 września” i pod nią godziny
                z pogodą. W jednej linii na 390 px data ucinała się w połowie
                miesiąca. */}
            <p className="truncate text-xs text-muted-foreground">{formatDayTitle(dayOf(job.startAt))}</p>
            <div className="flex items-center gap-1.5">
              <p className="truncate text-xs tabular-nums text-muted-foreground">
                {job.allDay
                  ? "cały dzień"
                  : `${timeOf(job.startAt)}${timeOf(job.endAt) ? `–${timeOf(job.endAt)}` : ""}`}
              </p>
              <WeatherMark brief={weather} />
            </div>
          </div>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
              JOB_STATE_CLASSES[state],
            )}
          >
            <StateIcon className="h-3 w-3" aria-hidden />
            {JOB_STATE_LABELS[state]}
          </span>
        </div>
      </header>

      <div className={cn("space-y-4", showActions ? "pb-28" : "pb-6")}>
        {job.title && job.title !== objectName && (
          <p className="text-base font-medium leading-snug">{job.title}</p>
        )}

        {/* --- OBIEKT + NAWIGACJA ------------------------------------- */}
        <Section id="obiekt" icon={Building2} title="Obiekt">
          {objectName ? (
            <div>
              <p className="font-medium">{objectName}</p>
              {addressLine && <p className="text-sm text-muted-foreground">{addressLine}</p>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Zlecenie nie ma przypiętego obiektu.
            </p>
          )}
          {navHref && (
            // Przycisk i linijka dojazdu to JEDNO dziecko sekcji — odstępy
            // `space-y-3` sekcji zostają takie same, a przycisk nie zmienia
            // ani wysokości, ani pozycji.
            <div>
              <Button asChild size="lg" className="h-12 w-full text-base">
                <a href={navHref} target="_blank" rel="noreferrer">
                  <Navigation className="mr-2 h-5 w-5" />
                  Nawiguj
                </a>
              </Button>
              {/* „Z biura: 23,4 km · ok. 35 min" — w JEDNĄ stronę, tak jak
                  liczy backend. Brak danych (`km: null`) = nic nie pokazujemy. */}
              {distanceLoading && !distance ? (
                <p className="mt-1 text-center text-xs text-muted-foreground">…</p>
              ) : distance?.km != null ? (
                <p className="mt-1 text-center text-xs tabular-nums text-muted-foreground">
                  {officeTripLabel(distance)}
                </p>
              ) : null}
            </div>
          )}
        </Section>

        {/* --- KONTAKT -------------------------------------------------- */}
        {(job.contactPerson || phone) && (
          <Section id="kontakt" icon={Phone} title="Kontakt">
            {job.contactPerson && <p className="font-medium">{job.contactPerson}</p>}
            {phone ? (
              <Button
                asChild
                variant="outline"
                size="lg"
                className="h-12 w-full text-base tabular-nums"
              >
                <a href={phone}>
                  <Phone className="mr-2 h-5 w-5" />
                  {job.contactPhone}
                </a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Brak numeru telefonu.</p>
            )}
          </Section>
        )}

        {/* --- OPIS ----------------------------------------------------- */}
        {job.description && (
          <Section id="opis" icon={StickyNote} title="Opis">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{job.description}</p>
          </Section>
        )}

        {/* --- WSPÓŁPRACOWNICY ------------------------------------------ */}
        {job.coTechnicians.length > 0 && (
          <Section id="ekipa" icon={Users} title="Na zleceniu ze mną">
            <p className="text-sm">{job.coTechnicians.join(", ")}</p>
          </Section>
        )}

        {/* --- NOTATKI -------------------------------------------------- */}
        <Section id="notatki" icon={MessageSquare} title={`Notatki (${job.notes.length})`}>
          {job.notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Jeszcze nikt nic nie dopisał.</p>
          ) : (
            <ul className="space-y-2">
              {job.notes.map((n) => {
                // Wpisy automatu („Rozpoczęto o 10:12”) są stonowane i kursywą:
                // to ślad systemu, a nie ustalenie z klientem, i nie ma
                // konkurować wzrokowo z tym, co technik dopisał ręcznie.
                const system = n.source === "system";
                const images = imagesOf(n);
                const files = (n.attachments ?? []).filter((a) => a.kind !== "image");
                // Kasować zdjęcia może tylko autor notatki i tylko w trybie edycji —
                // te same zasady, co w kalendarzu biura.
                const canDeleteFiles = canEdit && n.mine === true;
                return (
                  <li
                    key={n.id}
                    className={cn(
                      "rounded-lg border p-2.5",
                      system ? "border-dashed bg-transparent" : "bg-muted/30",
                    )}
                  >
                    {n.text && (
                      <p
                        className={cn(
                          "whitespace-pre-wrap text-sm leading-snug",
                          system && "italic text-muted-foreground",
                        )}
                      >
                        {n.text}
                      </p>
                    )}
                    {images.length > 0 && (
                      <ul className={cn("grid grid-cols-3 gap-1.5", n.text && "mt-2")}>
                        {images.map((a, i) => (
                          <li key={a.id} className="relative">
                            <button
                              type="button"
                              onClick={() => setLightbox({ noteId: n.id, index: i })}
                              className="block w-full overflow-hidden rounded-lg border bg-muted/40"
                              aria-label={`Podgląd: ${a.fileName}`}
                              data-testid="technik-note-photo"
                            >
                              <img
                                src={a.url}
                                alt={a.fileName}
                                loading="lazy"
                                className="aspect-square w-full object-cover"
                              />
                            </button>
                            {canDeleteFiles && (
                              <button
                                type="button"
                                onClick={() => setToDelete(a)}
                                aria-label={`Usuń zdjęcie ${a.fileName}`}
                                className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow ring-1 ring-border"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {files.length > 0 && (
                      <ul className={cn("space-y-1", n.text || images.length ? "mt-2" : "")}>
                        {files.map((a) => (
                          <li key={a.id}>
                            <a
                              href={`${a.url}?download=1`}
                              className="flex min-h-11 items-center gap-2 rounded-lg border bg-background px-2.5 text-sm"
                            >
                              <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="truncate">{a.fileName}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {n.userLabel ? `${n.userLabel} · ` : ""}
                      {clockOf(n.createdAt)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          {canEdit && (
            <div className="space-y-2">
              <ClearableTextarea
                value={noteText}
                onChange={setNoteText}
                clearLabel="Wyczyść notatkę"
                placeholder={picked.length ? "Podpis do zdjęć (opcjonalnie)…" : "Dopisz notatkę…"}
                rows={2}
                className="min-h-[72px] text-base"
                enterKeyHint="enter"
              />

              {/* Miniatury wybranych zdjęć — jeszcze przed wysłaniem. */}
              {picked.length > 0 && (
                <ul className="grid grid-cols-3 gap-1.5">
                  {picked.map((p) => (
                    <li key={p.key} className="relative">
                      <img
                        src={p.previewUrl}
                        alt={p.file.name}
                        className="aspect-square w-full rounded-lg border object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removePicked(p.key)}
                        disabled={noteBusy}
                        aria-label={`Usuń z wyboru: ${p.file.name}`}
                        className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow ring-1 ring-border disabled:opacity-50"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Aparat obok wysyłki: na tablecie „Zdjęcie” otwiera aparat
                  (capture), a przytrzymanie daje wybór z galerii. */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-11 shrink-0"
                  disabled={noteBusy}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="technik-note-photo-button"
                >
                  <Camera className="mr-2 h-4 w-4" />
                  Zdjęcie
                </Button>
                <Button
                  className="h-11 flex-1"
                  disabled={(!noteText.trim() && picked.length === 0) || noteBusy}
                  onClick={() => void addNote()}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {noteBusy
                    ? progress ?? "Zapisywanie…"
                    : picked.length
                      ? `Wyślij (${picked.length})`
                      : "Dodaj notatkę"}
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => {
                  pickPhotos(e.target.files);
                  // Bez tego drugie zdjęcie tego samego pliku nie wywoła `change`.
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </Section>

        {/* --- PROTOKÓŁ ------------------------------------------------- */}
        <Section id="protokol" icon={FileText} title="Protokół">
          {job.protocol ? (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium tabular-nums">{job.protocol.number}</p>
                <p className="text-sm text-muted-foreground">
                  {job.protocol.signed ? "Podpisany przez klienta" : "Do wypełnienia"}
                </p>
              </div>
              <Button asChild variant="outline" className="h-11 shrink-0">
                <Link to={`/technik/zlecenie/${job.id}/protokol`}>Otwórz</Link>
              </Button>
            </div>
          ) : canEdit ? (
            <Button
              variant="outline"
              className="h-11 w-full"
              disabled={busy}
              onClick={() => void openProtocol()}
            >
              <Plus className="mr-2 h-4 w-4" />
              Załóż protokół
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Protokołu jeszcze nie ma.</p>
          )}
        </Section>

        {/* Znaczniki czasu — dowód, że „Rozpocznij” zadziałało. */}
        {(job.startedAt || job.finishedAt) && (
          <p className="text-xs tabular-nums text-muted-foreground">
            {job.startedAt && `Rozpoczęto ${clockOf(job.startedAt)}`}
            {job.startedAt && job.finishedAt && " · "}
            {job.finishedAt && `Zakończono ${clockOf(job.finishedAt)}`}
          </p>
        )}
      </div>

      {/* --- STICKY PASEK AKCJI --------------------------------------- */}
      {showActions && (
        <div className="fixed inset-x-0 bottom-kb-nav z-40 border-t bg-background/95 backdrop-blur-sm">
          <div className="mx-auto flex w-full max-w-3xl gap-2 px-4 py-2.5">
            <Button
              size="lg"
              className="h-12 flex-1 text-base"
              disabled={busy}
              onClick={() => void primary.onClick()}
            >
              <PrimaryIcon className="mr-2 h-5 w-5" />
              {busy ? "Chwileczkę…" : primary.label}
            </Button>
            {/* Protokół bywa potrzebny jeszcze przed „Zakończ” (klient podpisuje
                przy aucie), więc w toku dokładamy go OBOK głównej akcji. */}
            {state === "running" && (
              <Button
                variant="outline"
                size="lg"
                className="h-12 shrink-0"
                disabled={busy}
                onClick={() => void openProtocol()}
              >
                <FileText className="h-5 w-5" />
                <span className="sr-only sm:not-sr-only sm:ml-2">Protokół</span>
              </Button>
            )}
          </div>
        </div>
      )}

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

      {/* Podgląd zdjęcia na cały ekran — galeria jednej notatki. */}
      <Lightbox
        items={lightbox ? imagesOf(job.notes.find((n) => n.id === lightbox.noteId)) : []}
        index={lightbox?.index ?? null}
        onIndexChange={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
        onClose={() => setLightbox(null)}
      />

      {/* Usunięcie zdjęcia jest nieodwracalne — pytamy, jak przy podpisie. */}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && !deleteBusy && setToDelete(null)}
        title="Usunąć zdjęcie?"
        description="Zniknie z notatki także w kalendarzu biura. Tego nie da się cofnąć."
        confirmLabel={deleteBusy ? "Usuwam…" : "Usuń"}
        onConfirm={() => {
          if (toDelete) void deleteAttachment(toDelete);
        }}
      />
    </>
  );
}

/** Zdjęcie wybrane w panelu, jeszcze niewysłane (miniatura żyje na blobie). */
interface PickedPhoto {
  key: string;
  file: File;
  previewUrl: string;
}

function revokeAll(items: PickedPhoto[]): void {
  for (const p of items) URL.revokeObjectURL(p.previewUrl);
}

/** Obrazki notatki (pliki inne niż zdjęcia lecą osobną listą chipów). */
function imagesOf(note: TechnikJobNote | undefined): CalendarNoteAttachment[] {
  return (note?.attachments ?? []).filter((a) => a.kind === "image");
}

/** „1 zdjęcie” / „3 zdjęcia” / „7 zdjęć” — komunikat postępu ma brzmieć po polsku. */
function photoCount(n: number): string {
  if (n === 1) return "1 zdjęcie";
  const last = n % 10;
  const teens = n % 100 >= 12 && n % 100 <= 14;
  return `${n} ${!teens && last >= 2 && last <= 4 ? "zdjęcia" : "zdjęć"}`;
}

/** „23,4” — jedno miejsce po przecinku, z polskim przecinkiem. */
const kmText = (km: number): string => km.toLocaleString("pl-PL", { maximumFractionDigits: 1 });

/**
 * „Z biura: 23,4 km · ok. 35 min” — dystans i czas w JEDNĄ stronę (tak liczy
 * backend). Czas z routera dostaje „ok.”, czas z szacunku (trasa w linii
 * prostej, stary wpis cache'u) — „≈”, żeby nie udawał wyniku nawigacji.
 * Starszy backend bez `minutes` pokazuje same kilometry.
 */
function officeTripLabel(d: TechnikJobDistance): string {
  const head = `Z biura: ${kmText(d.km ?? 0)} km`;
  if (d.minutes == null || !Number.isFinite(d.minutes)) return head;
  // Powyżej godziny „95 min” nic technikowi nie mówi — `fmtMinutes` daje
  // „1 godz. 35 min” (ten sam format, co w kalendarzu).
  const mins = Math.max(1, Math.round(d.minutes));
  return `${head} · ${d.minutesEstimated ? "≈" : "ok."} ${fmtMinutes(mins)}`;
}
