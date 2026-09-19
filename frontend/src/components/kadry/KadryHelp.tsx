/**
 * „?” W PASKU KADR — legenda kolorów, znaczników i skrótów, dopasowana do
 * zakładki, w której stoi użytkownik.
 *
 * FORMA JEST PRZEPISANA Z KALENDARZA (`HelpPopover` w
 * `components/calendar/CalendarPage.tsx`), świadomie co do klasy: ghostowy
 * przycisk „?” w pasku narzędzi, dymek ze skrótem, popover `alfa-pop` przy
 * prawej krawędzi na desktopie i arkusz dolny na telefonie, sekcje z małą
 * wersalikową etykietą, klawisze w `alfa-kbd`. Wspólnego komponentu nie ma —
 * tamten popover jest funkcją wewnątrz pliku kalendarza i zna jego typy
 * (`CalendarConfig`, `EVENT_TYPE_META`), więc dałoby się go współdzielić
 * dopiero po wyniesieniu treści na zewnątrz. Zamiast przepisywać kalendarz przy
 * okazji Kadr, powtórzony jest UKŁAD, a nie style: ta sama siatka klas i ten
 * sam `Calendar.css`, z którego biorą się `alfa-kbd` i `alfa-pop`.
 *
 * DLACZEGO TREŚĆ SIEDZI OSOBNO. `help-content.ts` trzyma sekcje jako dane
 * (`tabs: […]`), bo legenda Kadr jest inna w każdej zakładce i będzie się
 * zmieniać częściej niż układ panelu. Ten plik wie tylko, jak narysować
 * paragraf, listę, pigułkę, kropkę koloru, znacznik i klawisz.
 *
 * PRÓBKI SĄ PRAWDZIWE. Pigułkę rysuje `KadryBadge` z `./ui`, kolory liczb —
 * `TEXT_TONE`, ptaszek zapisu — `InlineSavedTick`. Legenda pokazuje więc
 * dokładnie ten element, który stoi w tabeli; kopia w postaci „zielony tekst”
 * rozjechałaby się z oryginałem przy pierwszej zmianie tonu.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  History,
  HelpCircle,
  Lock,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
// Skąd `alfa-kbd` (klawisz) i `alfa-pop` (wejście popovera) — te same klasy,
// których używa pomoc kalendarza. Import arkusza zamiast przepisania klas:
// druga definicja tego samego wyglądu rozjechałaby się po pierwszej poprawce.
import "@/pages/Calendar.css";
import {
  InlineSavedTick,
  KadryBadge,
  TEXT_TONE,
  TOOLBAR_ICON_BTN_CLS,
} from "./ui";
import {
  HELP_SECTIONS,
  HELP_TAB_TITLE,
  type HelpItem,
  type HelpMark,
  type HelpSection,
  type KadryHelpTab,
} from "./help-content";

/** Klucz zakładki — wołający nie musi wiedzieć, że treść mieszka osobno. */
export type { KadryHelpTab } from "./help-content";

/** Etykieta sekcji — jeden rozmiar w całym panelu, jak w pomocy kalendarza. */
const SECTION_LABEL_CLS =
  "mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

/**
 * Znaczniki z tabel narysowane tymi samymi klockami, co w wierszu. Trzymane
 * w jednej mapie, bo to jedyne miejsce w panelu, gdzie „próbka” jest czymś
 * więcej niż pigułką albo kropką.
 */
const MARK_SAMPLE: Record<HelpMark, ReactNode> = {
  uncertain: (
    <KadryBadge tone="ostrzezenie" compact>
      ?
    </KadryBadge>
  ),
  warning: (
    <AlertTriangle className={cn("h-3.5 w-3.5", TEXT_TONE.warn)} aria-hidden />
  ),
  expiring: <span className={cn("text-xs", TEXT_TONE.warn)}>do przedłużenia</span>,
  lock: (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
      <Lock className="h-3 w-3" aria-hidden />
      Edytuje: Jan K.
      <span className="tabular-nums opacity-80">do 14:32</span>
    </span>
  ),
  dimmed: (
    <span className="rounded border border-dashed px-2 py-0.5 text-[10px] text-muted-foreground opacity-60">
      wiersz działu OFI
    </span>
  ),
  monthClosed: (
    <KadryBadge tone="ostrzezenie" icon={Lock} compact>
      Miesiąc zamknięty
    </KadryBadge>
  ),
  history: <History className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />,
  rowActions: (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Pencil className="h-3.5 w-3.5" aria-hidden />
      <Trash2 className="h-3.5 w-3.5" aria-hidden />
    </span>
  ),
  saved: <InlineSavedTick className="text-[11px]" />,
};

function HelpItemView({ item }: { item: HelpItem }) {
  switch (item.kind) {
    case "p":
      return <p className="text-xs text-muted-foreground">{item.text}</p>;
    case "ul":
      return (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {item.items.map((t, i) => (
            <li key={i} className="flex gap-1.5">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      );
    case "badges":
      return (
        <ul className="space-y-1">
          {item.items.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="shrink-0">
                <KadryBadge tone={b.tone} compact>
                  {b.label}
                </KadryBadge>
              </span>
              <span className="text-muted-foreground">{b.desc}</span>
            </li>
          ))}
        </ul>
      );
    case "tones":
      return (
        <ul className="space-y-1">
          {item.items.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span
                aria-hidden
                className={cn("mt-1 h-2 w-2 shrink-0 rounded-full bg-current", TEXT_TONE[t.tone])}
              />
              <span>
                <span className={cn("font-medium", TEXT_TONE[t.tone])}>{t.label}</span>{" "}
                <span className="text-muted-foreground">— {t.desc}</span>
              </span>
            </li>
          ))}
        </ul>
      );
    case "marks":
      // Próbka NAD opisem, nie obok: pigułka „Edytuje: Jan K. do 14:32” jest
      // szersza niż pół kolumny panelu, więc w układzie obok siebie opis
      // schodził do jednego słowa w linii.
      return (
        <ul className="space-y-2">
          {item.items.map((m, i) => (
            <li key={i} className="text-xs text-muted-foreground">
              <span className="mb-0.5 flex items-center">{MARK_SAMPLE[m.mark]}</span>
              {m.desc}
            </li>
          ))}
        </ul>
      );
    case "keys":
      return (
        <ul className="space-y-1">
          {item.items.map((k, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="flex w-20 shrink-0 gap-1">
                {k.keys.map((key) => (
                  <kbd key={key} className="alfa-kbd">
                    {key}
                  </kbd>
                ))}
              </span>
              <span className="text-muted-foreground">{k.desc}</span>
            </li>
          ))}
        </ul>
      );
  }
}

function HelpSectionView({ section }: { section: HelpSection }) {
  return (
    <section className="mb-4 break-inside-avoid">
      <p className={SECTION_LABEL_CLS}>{section.title}</p>
      <div className="space-y-2">
        {section.items.map((it, i) => (
          <HelpItemView key={i} item={it} />
        ))}
      </div>
    </section>
  );
}

/**
 * Sekcje w kolejności: najpierw te dla bieżącej zakładki (odpowiadają na „co tu
 * widzę”), potem wspólne. Zakładka bez własnej sekcji dostaje samą część
 * wspólną — panel nigdy nie jest pusty.
 */
function sectionsFor(tab: KadryHelpTab): HelpSection[] {
  return [
    ...HELP_SECTIONS.filter((s) => s.tabs?.includes(tab)),
    ...HELP_SECTIONS.filter((s) => !s.tabs),
  ];
}

/** Szerokość popovera na desktopie (rem × 16) — potrzebna do wyboru strony. */
const PANEL_W = 512;

function HelpPanel({
  tab,
  onClose,
  sheet,
  align = "right",
}: {
  tab: KadryHelpTab;
  onClose: () => void;
  /** Wariant telefonowy: arkusz dolny zamiast popovera przy przycisku „?”. */
  sheet?: boolean;
  /** Krawędź przycisku, do której przykleja się panel. */
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      // Klik w sam przycisk „?” obsługuje przełącznik rodzica — inaczej panel
      // zamykałby się tu i otwierał tam, czyli nie zamykał się wcale.
      if ((t as HTMLElement).closest?.('[data-testid="kadry-help"]')) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Legenda i skróty"
      data-testid="kadry-help-panel"
      className={cn(
        "alfa-pop overflow-y-auto border bg-popover text-sm text-popover-foreground shadow-xl",
        sheet
          ? "relative z-50 max-h-[85vh] rounded-t-2xl border-t p-4 pb-6"
          : cn(
              "absolute top-11 z-40 max-h-[calc(100vh-12rem)] w-[32rem] max-w-[calc(100vw-2rem)] rounded-lg p-4",
              // W kalendarzu „?” stoi przy prawej krawędzi paska, więc popover
              // zawsze rozwijał się w lewo. W Kadrach ten sam przycisk bywa tuż
              // obok wyboru miesiąca, czyli przy LEWEJ krawędzi — tam panel
              // rozwinięty w lewo wchodzi pod menu boczne i znika.
              align === "right" ? "right-0" : "left-0",
            ),
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Legenda i skróty
          <span className="ml-1.5 font-normal text-muted-foreground">
            · {HELP_TAB_TITLE[tab]}
          </span>
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Zamknij pomoc"
          data-testid="kadry-help-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {/* Dwie kolumny jak w pomocy kalendarza, ale łamane przez CSS, a nie
          ręcznym podziałem na dwie listy: sekcji jest różna liczba w każdej
          zakładce, więc stały podział zostawiałby jedną stronę pustą. */}
      <div className={cn(sheet ? "" : "md:columns-2 md:gap-5")}>
        {sectionsFor(tab).map((s, i) => (
          <HelpSectionView key={`${s.title}-${i}`} section={s} />
        ))}
      </div>
      <p className="border-t pt-2 text-[11px] text-muted-foreground">
        Nazwy kolumn mają własne dymki — najedź na nagłówek tabeli, żeby zobaczyć,
        skąd bierze się liczba pod nim.
      </p>
    </div>
  );
}

/** Czy fokus stoi w polu edycyjnym — wtedy „?” jest znakiem, nie skrótem. */
function inEditable(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/**
 * Przycisk „?” z panelem legendy. Stoi w pasku narzędzi każdej zakładki Kadr
 * i w pasku „Godzin działu”.
 *
 * `tab` wybiera sekcje, które idą na górę panelu — pomoc ma mówić o ekranie,
 * na którym ktoś akurat stoi, a nie o całym module naraz.
 */
export function KadryHelp({
  tab,
  className,
}: {
  tab: KadryHelpTab;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [align, setAlign] = useState<"left" | "right">("right");

  /**
   * Strona rozwinięcia liczona przy otwarciu, z pozycji samego przycisku.
   * Domyślnie w PRAWO, bo po lewej stronie ekranu stoi menu boczne: panel
   * przyklejony do prawej krawędzi przycisku z paska miesiąca wchodziłby pod
   * menu i połowa treści byłaby niewidoczna. Do prawej krawędzi wracamy tylko
   * wtedy, gdy na prawo od przycisku (koniec paska) miejsca już nie ma.
   */
  const toggle = () => {
    setOpen((o) => {
      if (!o) {
        const r = btnRef.current?.getBoundingClientRect();
        setAlign(
          r && window.innerWidth - r.left >= PANEL_W + 16 ? "left" : "right",
        );
      }
      return !o;
    });
  };
  // Telefon dostaje arkusz dolny: popover o szerokości 32 rem nie ma się gdzie
  // zaczepić przy prawej krawędzi ekranu szerokiego na 360 px.
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Skrót „?” (Shift+/) — jak w kalendarzu. Poza polami tekstowymi i bez
  // modyfikatorów: Ctrl+? i Alt+? należą do przeglądarki.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (inEditable()) return;
      // Otwarty dialog (formularz wpisu, okno wypłaty) ma swoje pola i swój
      // Escape — pomoc nie wchodzi mu pod rękę.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={cn("relative", className)}>
      <Button
        variant="ghost"
        size="icon"
        className={cn(TOOLBAR_ICON_BTN_CLS, "text-muted-foreground")}
        ref={btnRef}
        onClick={toggle}
        aria-label="Pomoc: legenda i skróty"
        aria-expanded={open}
        data-testid="kadry-help"
        {...tip("Legenda i skróty", { shortcut: "?" })}
      >
        <HelpCircle className="h-4 w-4" />
      </Button>
      {open && !mobile && (
        <HelpPanel tab={tab} align={align} onClose={() => setOpen(false)} />
      )}
      {open && mobile && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Zamknij pomoc"
            onClick={() => setOpen(false)}
          />
          <HelpPanel tab={tab} onClose={() => setOpen(false)} sheet />
        </div>
      )}
    </div>
  );
}
