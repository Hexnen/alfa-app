import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PhotoMetaInfo } from "@/components/PhotoMetaInfo";
import type { AttachmentMeta } from "@/lib/photo-meta";

/**
 * LIGHTBOX — zdjęcie z notatki na cały ekran tabletu.
 *
 * Własny, a nie ten z manuali (`components/manuals/ManualAttachmentsGallery`):
 * tamten jest oknem dialogowym na desktop — z ramką, nagłówkiem i przyciskiem
 * „Pobierz” — a tu zdjęcie ma zająć cały ekran, żeby technik zobaczył numer
 * seryjny na kamerze. Zostaje tylko czarne tło, X 44 px i przewijanie między
 * zdjęciami jednej notatki (strzałki albo przeciągnięcie palcem).
 */

export interface LightboxItem {
  id: number;
  url: string;
  fileName: string;
  /** Metadane zdjęcia — obsługuje je przycisk „i” w pasku. Brak = bez przycisku. */
  meta?: AttachmentMeta | null;
}

/** Minimalna długość gestu, po której uznajemy go za przewinięcie, a nie drgnięcie palca. */
const SWIPE_PX = 50;

export function Lightbox({
  items,
  index,
  onIndexChange,
  onClose,
  createdAt,
  objectLat,
  objectLng,
}: {
  items: LightboxItem[];
  /** Indeks otwartego zdjęcia; `null` = lightbox zamknięty. */
  index: number | null;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  /** Data wpisu, do którego należą zdjęcia — panel „i” dopisuje „dodane …”. */
  createdAt?: Date | null;
  /** Pinezka obiektu zlecenia — panel „i” liczy z niej odległość zdjęcia. */
  objectLat?: number | null;
  objectLng?: number | null;
}) {
  const open = index !== null && index >= 0 && index < items.length;
  const [touchX, setTouchX] = useState<number | null>(null);
  /** Czy to MY dołożyliśmy wpis do historii — tylko taki wolno nam zdjąć. */
  const pushed = useRef(false);
  // Nasłuch `popstate` zakładamy raz na otwarcie, więc callback czytamy z refu
  // — inaczej zamykałby lightbox domknięciem sprzed kilku renderów.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  /**
   * GEST „WSTECZ" ZAMYKA PODGLĄD, A NIE ZLECENIE.
   *
   * Na tablecie zdjęcie na cały ekran wygląda jak osobny ekran, więc technik
   * odruchowo przeciąga od krawędzi — i wracał na listę zleceń, tracąc
   * otwarty protokół. Wejście do lightboxu dokłada własny wpis do historii,
   * a `popstate` go tylko zamyka.
   */
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ lightbox: true }, "");
    pushed.current = true;
    const onPop = () => {
      // Wpis już zdjęła przeglądarka — zamykamy bez ruszania historii.
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Zamknięcie krzyżykiem albo tapnięciem w tło: nasz wpis musi zejść,
      // inaczej pierwsze „wstecz" po zamknięciu nie zrobiłoby nic.
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
      }
    };
    // Świadomie bez `index`: przewijanie zdjęć nie ma dokładać wpisów do
    // historii — dziesięć zdjęć znaczyłoby dziesięć tapnięć „wstecz".
  }, [open]);
  // Klawiatura tabletu z etui i podgląd na desktopie — Esc/strzałki działają tak,
  // jak każdy się spodziewa; bez tego z lightboxu wychodziło się tylko tapnięciem.
  const count = items.length;
  useEffect(() => {
    if (!open || index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (e.key === "ArrowRight" && index < count - 1) onIndexChange(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, index, count, onClose, onIndexChange]);

  if (!open || index === null) return null;
  const item = items[index];
  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < items.length) onIndexChange(next);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={item.fileName}
      data-testid="technik-lightbox"
      onTouchStart={(e) => setTouchX(e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const from = touchX;
        setTouchX(null);
        const to = e.changedTouches[0]?.clientX;
        if (from == null || to == null || Math.abs(to - from) < SWIPE_PX) return;
        go(to < from ? 1 : -1);
      }}
    >
      {/* Pasek: licznik „2 / 5” i zamknięcie. Nad zdjęciem, nie na nim —
          na jasnym kadrze biały X przy słońcu bywa niewidoczny. */}
      <div className="flex items-center justify-between gap-2 pt-safe">
        <span className="pl-4 text-sm tabular-nums text-white/70">
          {items.length > 1 ? `${index + 1} / ${items.length}` : ""}
        </span>
        <span className="flex items-center gap-1">
          {/* Dane zdjęcia także na pełnym ekranie: to tutaj technik ogląda
              numer seryjny i tutaj zwykle pada pytanie „kiedy to było?”. */}
          <PhotoMetaInfo
            meta={item.meta}
            createdAt={createdAt ?? null}
            objectLat={objectLat}
            objectLng={objectLng}
            tone="dark"
            big
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij podgląd"
            className="flex h-11 w-11 items-center justify-center text-white/90"
          >
            <X className="h-6 w-6" />
          </button>
        </span>
      </div>

      {/* Zdjęcie wypełnia resztę ekranu; tap poza nim zamyka. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <img
          src={item.url}
          alt={item.fileName}
          className="max-h-full max-w-full object-contain"
        />
        {items.length > 1 && (
          <>
            <NavButton side="left" disabled={index === 0} onClick={() => go(-1)} />
            <NavButton side="right" disabled={index === items.length - 1} onClick={() => go(1)} />
          </>
        )}
      </div>

      <p className="truncate px-4 pb-safe pt-2 text-center text-xs text-white/60">{item.fileName}</p>
    </div>
  );
}

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "left" ? "Poprzednie zdjęcie" : "Następne zdjęcie"}
      className={cn(
        "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white",
        side === "left" ? "left-2" : "right-2",
        disabled && "opacity-30",
      )}
    >
      <Icon className="h-6 w-6" />
    </button>
  );
}
