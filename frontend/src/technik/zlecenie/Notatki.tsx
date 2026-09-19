import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Camera,
  ChevronDown,
  ChevronRight,
  FileText,
  Images,
  MessageSquare,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import {
  technikApi,
  CALENDAR_ATTACHMENT_MAX_FILES,
  type CalendarNoteAttachment,
  type TechnikJobNote,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PhotoMetaInfo } from "@/components/PhotoMetaInfo";
import {
  readPhotoMeta,
  takenAtEpoch,
  toAttachmentMeta,
  type PhotoCapturedVia,
  type PhotoMetaInput,
} from "@/lib/photo-meta";
import { cn } from "@/lib/utils";
import { ClearableTextarea } from "../ui/clearable-input";
import { ConfirmDialog } from "../ui/confirm";
import { Lightbox } from "../ui/lightbox";
import { useToast } from "../ui/toast";
import { isImageLike, prepareForUpload } from "../lib/image";
import { clockOf, parseStamp, photoTakenLabel } from "../lib/dates";

/**
 * NOTATKI — sekcja zwinięta domyślnie.
 *
 * Rozwinięta lista notatek z fotorelacją potrafiła mieć dwa ekrany wysokości
 * i spychała protokół oraz pasek akcji poza zasięg. Zwinięty nagłówek pokazuje
 * licznik i JEDNĄ linijkę ostatniego wpisu — tyle, żeby wiedzieć, czy warto
 * zaglądać.
 *
 * Po rozwinięciu pole dodawania stoi NA DOLE sekcji, zaraz nad paskiem akcji:
 * technik pisze notatkę po tym, jak przeczyta poprzednie, a nie przed. Dodanie
 * notatki nie zwija sekcji — po wysłaniu ma być widać, że wpis wpadł na listę.
 */
export function Notatki({
  jobId,
  notes,
  canEdit,
  onChanged,
  objectLat,
  objectLng,
}: {
  jobId: number;
  notes: TechnikJobNote[];
  canEdit: boolean;
  /** Przeładowanie zlecenia po zapisie / usunięciu załącznika. */
  onChanged: () => void;
  /** Pinezka obiektu — panel „i” liczy z niej „~120 m od obiektu”. */
  objectLat?: number | null;
  objectLng?: number | null;
}) {
  const { toast, toastError } = useToast();
  const [open, setOpen] = useState(false);

  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  /** Tekstowy postęp wysyłki („Przygotowuję 2 z 3…”) — kręciołek nic tu nie mówi. */
  const [progress, setProgress] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedPhoto[]>([]);
  /** Aparat (`capture`) i galeria (`multiple`) to DWA różne inputy — patrz pasek niżej. */
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
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

  // Backend oddaje notatki od najnowszej — podgląd w nagłówku to po prostu
  // pierwszy wiersz listy.
  const latest = notes[0];

  /**
   * Zdjęcia z `<input type="file">` — dokładane do już wybranych, do limitu
   * serwera. Oba przyciski (aparat i galeria) wchodzą TĄ SAMĄ drogą.
   *
   * Multiwybór z galerii bywa hojny: przy przekroczeniu limitu bierzemy tyle,
   * ile się mieści, i mówimy ile zostało za burtą — odrzucenie całej paczki
   * kazałoby technikowi zaczynać wybór od zera. Filmy i inne nie-obrazki
   * (Android pokazuje je w tym samym selektorze) wypadają od razu, zamiast
   * wracać błędem serwera po minucie wysyłki.
   */
  const pickPhotos = (list: FileList | null, capturedVia: PhotoCapturedVia) => {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const images = all.filter(isImageLike);
    const skipped: string[] = [];
    if (images.length < all.length) {
      skipped.push(
        all.length - images.length === 1
          ? `„${all.find((f) => !isImageLike(f))?.name ?? "plik"}” to nie zdjęcie`
          : `${all.length - images.length} plików to nie zdjęcia`,
      );
    }
    const room = Math.max(0, CALENDAR_ATTACHMENT_MAX_FILES - picked.length);
    const files = images.slice(0, room);
    if (images.length > files.length) {
      skipped.push(
        `limit to ${CALENDAR_ATTACHMENT_MAX_FILES} zdjęć na notatkę, pominięto ${images.length - files.length}`,
      );
    }
    if (skipped.length) {
      // Część zdjęć weszła — to informacja, nie awaria; czerwień zostaje dla
      // wyboru, z którego nie wpadło nic.
      toast({
        message: `${files.length ? `Dodano ${photoCount(files.length)}` : "Nic nie dodano"} — ${skipped.join("; ")}.`,
        kind: files.length ? "info" : "error",
        duration: 8000,
      });
    }
    if (files.length === 0) return;
    const now = new Date();
    const added: PickedPhoto[] = files.map((file) => ({
      key: `${file.name}-${file.lastModified}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      // Zdjęcie z galerii bywa sprzed tygodnia — notatka dostanie dzisiejszą
      // datę, więc dzień wykonania musi być widać przy miniaturze. Zanim
      // dojedzie EXIF, znacznik bierzemy z daty pliku: miniatura ma się
      // pokazać od razu, a nie po odczycie serii z galerii.
      taken: photoTakenLabel(file.lastModified, now),
      meta: null,
    }));
    setPicked((prev) => [...prev, ...added]);

    // EXIF czytamy z ORYGINAŁU i ZARAZ PO WYBORZE — kompresja przez canvas
    // (`prepareForUpload`) kasuje wszystkie metadane, więc po niej nie byłoby
    // już czego czytać. Odczyt nie może niczego blokować: `readPhotoMeta` sam
    // pilnuje limitu czasu i nigdy nie rzuca, a wynik tylko podmienia stan.
    void Promise.all(
      added.map(async (p) => {
        const meta = await readPhotoMeta(p.file, capturedVia);
        setPicked((prev) =>
          prev.map((item) =>
            item.key === p.key
              ? { ...item, meta, taken: photoTakenLabel(takenAtEpoch(toAttachmentMeta(meta)), now) }
              : item,
          ),
        );
      }),
    );
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
        await technikApi.addNote(jobId, content);
      } else {
        // Kompresja idzie plik po pliku — na tablecie to sekunda na zdjęcie,
        // więc technik ma widzieć, na którym stoimy.
        const files: File[] = [];
        // Metadane jadą OSOBNYM polem, wyrównane indeksami z `files` — plik
        // po kompresji nie ma już ani daty, ani pinezki, więc to jedyna droga.
        const photoMeta: (PhotoMetaInput | null)[] = [];
        for (const [i, p] of picked.entries()) {
          setProgress(`Przygotowuję ${i + 1} z ${picked.length}…`);
          // Rzuca czytelnym zdaniem przy HEIC-u, którego nie zdekodowała ani
          // przeglądarka, ani (za chwilę) serwer — wtedy nie leci NIC, a wybór
          // zostaje na ekranie, żeby było co poprawić.
          files.push(await prepareForUpload(p.file));
          photoMeta.push(p.meta);
        }
        setProgress(`Wysyłam ${photoCount(files.length)}…`);
        await technikApi.addNoteWithFiles(jobId, { text: content, files, photoMeta });
      }
      revokeAll(picked);
      setPicked([]);
      setNoteText("");
      toast({ message: picked.length ? "Zdjęcia dodane do notatek" : "Notatka dodana", kind: "success" });
      onChanged();
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
      onChanged();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Nie udało się usunąć zdjęcia.");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <section
      className="rounded-xl border bg-card text-card-foreground"
      data-testid="zlecenie-notatki"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="zlecenie-notatki-tresc"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="zlecenie-notatki-przelacz"
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Notatki ({notes.length})
          </span>
          {/* Zwinięta sekcja pokazuje ostatni wpis JEDNĄ linią — po to, żeby
              nie trzeba było jej rozwijać tylko po to, by zobaczyć, że nic nowego. */}
          {!open && (
            <span className="block truncate text-sm leading-snug text-foreground/80">
              {latest ? previewOf(latest) : "Jeszcze nikt nic nie dopisał."}
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>

      {open && (
        <div id="zlecenie-notatki-tresc" className="space-y-3 border-t p-3">
          {notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Jeszcze nikt nic nie dopisał.</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <Wpis
                  key={n.id}
                  note={n}
                  jobId={jobId}
                  canDeleteFiles={canEdit && n.mine === true}
                  onPreview={(index) => setLightbox({ noteId: n.id, index })}
                  onDelete={setToDelete}
                  objectLat={objectLat}
                  objectLng={objectLng}
                />
              ))}
            </ul>
          )}

          {/* --- DODAWANIE — zawsze na dole rozwiniętej sekcji ------------- */}
          {canEdit && (
            <div className="space-y-2 border-t pt-3">
              <ClearableTextarea
                value={noteText}
                onChange={setNoteText}
                clearLabel="Wyczyść notatkę"
                placeholder={picked.length ? "Podpis do zdjęć (opcjonalnie)…" : "Dopisz notatkę…"}
                rows={2}
                className="min-h-[72px] text-base"
                enterKeyHint="enter"
              />

              {/* Miniatury wybranych zdjęć — jeszcze przed wysłaniem: technik ma
                  zobaczyć, że trafił w kamerę, a nie w swój but. */}
              {picked.length > 0 && (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {picked.map((p) => (
                    <li key={p.key} className="relative overflow-hidden rounded-lg border">
                      {/* Podkładka spod miniatury — widać ją, gdy przeglądarka
                          nie zdekoduje pliku (HEIC z Androida). Bez niej
                          w kafelku zostawał połamany obrazek z nazwą pliku
                          wylewającą się poza ramkę. */}
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted px-1 text-center text-[10px] leading-tight text-muted-foreground">
                        <Images className="h-4 w-4" aria-hidden />
                        <span className="line-clamp-2 break-all">{p.file.name}</span>
                      </span>
                      <img
                        src={p.previewUrl}
                        alt={p.file.name}
                        className="relative aspect-square w-full object-cover"
                        onError={(e) => {
                          e.currentTarget.hidden = true;
                        }}
                      />
                      {/* Data wykonania tylko przy zdjęciu z galerii — przy
                          świeżym z aparatu byłaby powtórzeniem „teraz”.
                          Na pasku sam znacznik, pełne zdanie w dymku: przy
                          trzech miniaturach w rzędzie „zrobione” urywało się
                          w połowie i zostawało „zrobione 17.09 1…”. */}
                      {p.taken && (
                        <span
                          className="pointer-events-none absolute inset-x-0 bottom-0 truncate rounded-b-lg bg-background/85 px-1 py-0.5 text-center text-[10px] leading-tight text-muted-foreground"
                          title={`zrobione ${p.taken}`}
                          data-testid="technik-note-photo-taken"
                        >
                          {p.taken}
                        </span>
                      )}
                      {/* Dane zdjęcia JESZCZE PRZED wysyłką: jak aparat nie
                          złapał GPS-u albo ma zegar z zeszłego roku, lepiej
                          zobaczyć to teraz niż w kalendarzu biura za tydzień. */}
                      <PhotoMetaInfo
                        meta={p.meta ? toAttachmentMeta(p.meta) : null}
                        objectLat={objectLat}
                        objectLng={objectLng}
                        big
                        className="absolute left-0 top-0 items-start justify-start p-1"
                      />
                      <button
                        type="button"
                        onClick={() => removePicked(p.key)}
                        disabled={noteBusy}
                        aria-label={`Usuń z wyboru: ${p.file.name}`}
                        className="absolute right-0 top-0 flex h-11 w-11 items-start justify-end p-1 disabled:opacity-50"
                      >
                        {/* Cel dotykowy ma 44 px, ale widoczne kółko 28 px —
                            pełnowymiarowy krzyżyk zasłaniał pół miniatury. */}
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow ring-1 ring-border">
                          <X className="h-4 w-4" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* DWA WEJŚCIA NA ZDJĘCIA, bo telefon nie umie ich pogodzić
                  w jednym: `capture="environment"` otwiera od razu celownik
                  aparatu i przy okazji UNIEWAŻNIA `multiple` — z galerii nie
                  dało się wtedy wziąć nic, a już na pewno nie serii. Więc
                  „Aparat” to input z `capture`, a „Galeria” osobny, bez niego,
                  za to z `multiple`. Oba lecą do tego samego `pickPhotos`.

                  Na telefonie (390 px) galeria jest kwadratem 44 px z samą
                  ikoną — inaczej trzy podpisy nie mieszczą się w jednym pasku
                  z „Wyślij”; na tablecie dostaje podpis. */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-11 shrink-0 px-3"
                  disabled={noteBusy}
                  onClick={() => cameraInputRef.current?.click()}
                  data-testid="technik-note-photo-button"
                >
                  <Camera className="mr-2 h-4 w-4" />
                  Aparat
                </Button>
                <Button
                  variant="outline"
                  className="h-11 w-11 shrink-0 p-0 sm:w-auto sm:px-3"
                  disabled={noteBusy}
                  onClick={() => galleryInputRef.current?.click()}
                  aria-label="Wybierz z galerii"
                  title="Wybierz z galerii"
                  data-testid="technik-note-gallery-button"
                >
                  <Images className="h-4 w-4 sm:mr-2" aria-hidden />
                  <span className="hidden sm:inline">Galeria</span>
                </Button>
                <Button
                  className="h-11 min-w-0 flex-1"
                  disabled={(!noteText.trim() && picked.length === 0) || noteBusy}
                  onClick={() => void addNote()}
                  data-testid="zlecenie-notatka-zapisz"
                >
                  <Send className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {noteBusy
                      ? (progress ?? "Zapisywanie…")
                      : picked.length
                        ? `Wyślij (${picked.length})`
                        : "Dodaj notatkę"}
                  </span>
                </Button>
              </div>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                data-testid="technik-note-camera-input"
                onChange={(e) => {
                  pickPhotos(e.target.files, "camera");
                  // Bez tego drugie zdjęcie tego samego pliku nie wywoła `change`.
                  e.target.value = "";
                }}
              />
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                data-testid="technik-note-gallery-input"
                onChange={(e) => {
                  pickPhotos(e.target.files, "gallery");
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Podgląd zdjęcia na cały ekran — galeria jednej notatki. */}
      <Lightbox
        items={lightbox ? imagesOf(notes.find((n) => n.id === lightbox.noteId)) : []}
        index={lightbox?.index ?? null}
        onIndexChange={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
        onClose={() => setLightbox(null)}
        createdAt={parseStamp(notes.find((n) => n.id === lightbox?.noteId)?.createdAt)}
        objectLat={objectLat}
        objectLng={objectLng}
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
    </section>
  );
}

/**
 * Jeden wpis. Notatki automatu („Rozpoczęto o 10:12”) są stonowane i kursywą:
 * to ślad systemu, a nie ustalenie z klientem, i nie ma konkurować wzrokowo
 * z tym, co technik dopisał ręcznie.
 */
function Wpis({
  note,
  jobId,
  canDeleteFiles,
  onPreview,
  onDelete,
  objectLat,
  objectLng,
}: {
  note: TechnikJobNote;
  jobId: number;
  canDeleteFiles: boolean;
  onPreview: (index: number) => void;
  onDelete: (att: CalendarNoteAttachment) => void;
  objectLat?: number | null;
  objectLng?: number | null;
}) {
  const system = note.source === "system";
  const images = imagesOf(note);
  const createdAt = parseStamp(note.createdAt);
  const files = (note.attachments ?? []).filter((a) => a.kind !== "image");
  // Notatka systemowa protokołu kończy się linkiem do CRM-a — rola „technik”
  // nie ma tam wstępu, więc w panelu prowadzi on do TEGO SAMEGO protokołu
  // ekranem technika. Sama ścieżka `/technical/…` znika z treści: w notatce ma
  // stać zdanie, nie martwy adres.
  const { body, protocolLink } = withoutCrmProtocolLink(note.text);

  return (
    <li className={cn("rounded-lg border p-2.5", system ? "border-dashed" : "bg-muted/30")}>
      {body && (
        <p
          className={cn(
            "whitespace-pre-wrap text-sm leading-snug",
            system && "italic text-muted-foreground",
          )}
        >
          {body}
        </p>
      )}

      {protocolLink && (
        <p className={cn(body && "mt-1")}>
          <Link
            to={`/technik/zlecenie/${jobId}/protokol`}
            data-testid="zlecenie-notatka-protokol"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline decoration-primary/40 underline-offset-2"
          >
            <FileText className="h-4 w-4 shrink-0" aria-hidden />
            Otwórz protokół
          </Link>
        </p>
      )}

      {images.length > 0 && (
        <ul className={cn("grid grid-cols-3 gap-2 sm:grid-cols-5", body && "mt-2")}>
          {images.map((a, i) => {
            const taken = sentTakenLabel(a, createdAt);
            return (
            <li key={a.id} className="relative">
              <button
                type="button"
                onClick={() => onPreview(i)}
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
              {/* Zdjęcie zrobione wcześniej niż wpis ma to napisane wprost —
                  notatka nosi datę DODANIA, a różnica bywa całą jej treścią. */}
              {taken && (
                <span
                  className="pointer-events-none absolute inset-x-0 bottom-0 truncate rounded-b-lg bg-background/85 px-1 py-0.5 text-center text-[10px] leading-tight text-muted-foreground"
                  title={`zrobione ${taken}`}
                  data-testid="technik-note-sent-taken"
                >
                  {taken}
                </span>
              )}
              <PhotoMetaInfo
                meta={a.meta}
                createdAt={createdAt}
                objectLat={objectLat}
                objectLng={objectLng}
                big
                className="absolute left-0 top-0 items-start justify-start p-1"
              />
              {canDeleteFiles && (
                <button
                  type="button"
                  onClick={() => onDelete(a)}
                  aria-label={`Usuń zdjęcie ${a.fileName}`}
                  className="absolute right-0 top-0 flex h-11 w-11 items-start justify-end p-1"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow ring-1 ring-border">
                    <X className="h-4 w-4" />
                  </span>
                </button>
              )}
            </li>
            );
          })}
        </ul>
      )}

      {files.length > 0 && (
        <ul className={cn("space-y-1", (body || images.length) && "mt-2")}>
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
        {note.userLabel ? `${note.userLabel} · ` : ""}
        {clockOf(note.createdAt)}
      </p>
    </li>
  );
}

/**
 * Link do protokołu w CRM-ie (`Otwórz protokół </technical/protokoly?protocol=12>`,
 * składnia Outlooka z `lib/linkify.ts`) wycięty z treści notatki.
 *
 * Panel nie renderuje notatek przez `RichText`, więc technik widział surowy
 * adres — i tak nie do otwarcia, bo router biurowy odsyła rolę `technik` do
 * `/technik`. Ścieżkę zdejmujemy tu, a nie w backendzie: ta sama notatka wisi
 * w kalendarzu biura, gdzie link jest jak najbardziej na miejscu.
 */
const CRM_PROTOCOL_LINK =
  /(?:^|\n)[^\n<]*<\/technical\/protokoly\?protocol=\d+>[ \t]*(?=\n|$)/;

function withoutCrmProtocolLink(text: string | null | undefined): {
  body: string;
  protocolLink: boolean;
} {
  const raw = text ?? "";
  if (!CRM_PROTOCOL_LINK.test(raw)) return { body: raw, protocolLink: false };
  return { body: raw.replace(CRM_PROTOCOL_LINK, "").replace(/[ \t\n]+$/, ""), protocolLink: true };
}

/** Zdjęcie wybrane w panelu, jeszcze niewysłane (miniatura żyje na blobie). */
interface PickedPhoto {
  key: string;
  file: File;
  previewUrl: string;
  /** „zrobione 17.09 14:20” dla zdjęcia z galerii; `null` dla świeżego z aparatu. */
  taken: string | null;
  /** EXIF oryginału; `null` dopóki trwa odczyt albo gdy plik nic nie niesie. */
  meta: PhotoMetaInput | null;
}

function revokeAll(items: PickedPhoto[]): void {
  for (const p of items) URL.revokeObjectURL(p.previewUrl);
}

/**
 * „17.09 14:20” pod miniaturą WYSŁANEGO zdjęcia — tylko wtedy, gdy data
 * wykonania rozjeżdża się z datą wpisu o więcej niż `PHOTO_FRESH_MIN`.
 * Reszta metadanych siedzi pod „i”; tu ma być sam fakt „to nie jest z dziś”.
 */
function sentTakenLabel(att: CalendarNoteAttachment, createdAt: Date | null): string | null {
  if (!att.meta || !createdAt) return null;
  return photoTakenLabel(takenAtEpoch(att.meta), createdAt);
}

/** Obrazki notatki (pliki inne niż zdjęcia lecą osobną listą chipów). */
function imagesOf(note: TechnikJobNote | undefined): CalendarNoteAttachment[] {
  return (note?.attachments ?? []).filter((a) => a.kind === "image");
}

/** Jednoliniowy podgląd wpisu: tekst, a przy notatce bez tekstu — liczba zdjęć. */
function previewOf(note: TechnikJobNote): string {
  const text = withoutCrmProtocolLink(note.text).body.trim();
  if (text) return text.replace(/\s+/g, " ");
  const images = imagesOf(note).length;
  return images ? photoCount(images) : "Załącznik";
}

/** „1 zdjęcie” / „3 zdjęcia” / „7 zdjęć” — komunikat postępu ma brzmieć po polsku. */
function photoCount(n: number): string {
  if (n === 1) return "1 zdjęcie";
  const last = n % 10;
  const teens = n % 100 >= 12 && n % 100 <= 14;
  return `${n} ${!teens && last >= 2 && last <= 4 ? "zdjęcia" : "zdjęć"}`;
}
