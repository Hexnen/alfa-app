/* eslint-disable react-refresh/only-export-components */
// Wspólne klocki wizualne modułu Kadry — ten sam język co kalendarz i Techniczny.
//
// Kadry powstały obok kalendarza i dorobiły się własnych wariantów tych samych
// rzeczy: badge w `rounded-md bg-emerald-100` (kalendarz: pigułka `rounded-full`
// z wariantem ciemnym), kafelek KPI z `text-xl font-bold` bez `tabular-nums`
// (Realizacje: `text-lg font-semibold tabular-nums`), pusta tabela jako goły
// tekst w komórce, tooltip przez natywny `title` (reszta aplikacji: dymek
// z `ui/tooltip`). Różnice są drobne z osobna, ale razem robią z Kadr osobną
// wyspę w tej samej aplikacji.
//
// Ten plik NIE wprowadza nowego stylu — tylko zamyka w komponentach ten, który
// już obowiązuje w kalendarzu (`lib/calendar-labels`: `pillClass`/`PILL_TONE`)
// i w Technicznym. Dzięki temu zmiana tonu w jednym miejscu idzie na oba moduły,
// a Kadry nie muszą powtarzać listy klas `dark:` przy każdym badge'u.
import type { ComponentType, ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { tip } from "@/components/ui/tooltip";
import { pillClass, type PillTone } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Klasy wspólne (do miejsc, gdzie komponent byłby przerostem formy)
// ---------------------------------------------------------------------------

/**
 * Wysokość przycisku w pasku narzędzi — jak w kalendarzu i Realizacjach:
 * palec na telefonie dostaje 40 px, mysz na desktopie 36 px.
 */
export const TOOLBAR_BTN_CLS = "h-10 md:h-9";

/** To samo dla przycisku ikonowego w pasku (kwadrat). */
export const TOOLBAR_ICON_BTN_CLS = "h-10 w-10 md:h-9 md:w-9";

/** Nagłówek tabeli — jedna klasa zamiast czterech kopii tego samego łańcucha. */
export const THEAD_CLS =
  "border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground";

/**
 * Wiersz podsumowania tabeli. Kadry miały `border-t-2` + `font-semibold` na
 * całym wierszu, Techniczny `border-t` + `font-medium` i pogrubienie dopiero na
 * sumie sum — stopka nie ma krzyczeć głośniej niż dane nad nią.
 */
export const TFOOT_ROW_CLS = "border-t bg-muted/40 font-medium";

/** Komórka liczbowa stopki (i każda inna kolumna z liczbą). */
export const NUM_CELL_CLS = "px-3 py-2 text-right tabular-nums";

/** Etykieta grupy chipów/filtrów („RODZAJ", „STATUS") — jak nad chipami Realizacji. */
export const FILTER_GROUP_LABEL_CLS =
  "text-xs font-medium uppercase tracking-wide text-muted-foreground";

/**
 * Kolumna akcji wiersza: ikony wyłażą dopiero pod kursorem.
 *
 * Trzy ikony przy każdym wierszu (ołówek, zegar historii, kosz) robiły z prawej
 * krawędzi tabeli szum, który konkurował z danymi — a używa się ich rzadko.
 * Dlatego wiersz dostaje `group`, a akcje `opacity-0 → group-hover:opacity-100`.
 *
 * Dwa wyjątki, żeby ukrycie nie było odebraniem funkcji:
 *  - `focus-within` / `group-focus-within` — na klawiaturze Tab wprowadza fokus
 *    w niewidoczny przycisk, który natychmiast się pokazuje,
 *  - `(hover: none)` — na dotyku nie ma czego najechać, więc akcje są widoczne
 *    od razu (telefon, tablet).
 *
 * Zmienia się tylko przezroczystość, nigdy `display` — kolumna trzyma szerokość,
 * więc tabela nie drga przy przesuwaniu myszy po wierszach.
 */
export const ROW_ACTIONS_CLS =
  "flex items-center justify-end gap-1 opacity-0 transition-opacity duration-150 " +
  "focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 " +
  "[@media(hover:none)]:opacity-100";

/**
 * Kolor samego TEKSTU (kwota na minusie, ostrzeżenie, „zapisano") — zawsze
 * z wariantem ciemnym. Kadry miały tu gołe `text-red-600` / `text-emerald-700`,
 * które w trybie ciemnym gasną do nieczytelnego.
 */
export const TEXT_TONE = {
  good: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-300",
  muted: "text-muted-foreground",
  /**
   * Wartość NADPISANA RĘCZNIE — ktoś wpisał ją wbrew temu, co wyliczyła
   * aplikacja. Wcześniej znaczyła to gwiazdka przy liczbie: gwiazdka nie
   * mówiła, jaka była wartość wyliczona, rozpychała kolumnę liczbową i myliła
   * się z przypisem. Kolor niesie to samo rozróżnienie bez znaku w treści,
   * a wyliczoną wartość podaje dymek.
   *
   * Indygo, nie bursztyn: bursztyn w całym module znaczy OSTRZEŻENIE („brak
   * kwoty", „do przeliczenia"), a nadpisanie nie jest usterką — to decyzja.
   */
  override: "text-indigo-600 dark:text-indigo-300",
  /**
   * Wartość WYLICZONA AUTOMATYCZNIE, której nikt nie wpisał ręcznie (kwota
   * biura z godzin × stawki, gotówka z kwoty − ROR, indywidualne godziny maks
   * z wpisów godzin). Druga strona tego samego rozróżnienia co `override`.
   */
  computed: "text-teal-700 dark:text-teal-300",
} as const;

// ---------------------------------------------------------------------------
// Badge / pigułka
// ---------------------------------------------------------------------------

/**
 * Tony używane w Kadrach, nazwane znaczeniem, nie kolorem — żeby „ochrona" i
 * „biuro" znaczyły to samo we wszystkich zakładkach i żeby zmiana koloru była
 * jedną linijką tutaj, a nie przeszukiwaniem `bg-violet-100` po plikach.
 *
 * Mapowanie na tony kalendarza (`PillTone`), więc badge Kadr jest dokładnie
 * tą samą pigułką co status wydarzenia czy typ rozliczenia.
 */
export type KadryTone =
  | "ochrona"
  | "biuro"
  | "aktywny"
  | "nieaktywny"
  | "ostrzezenie"
  | "braki"
  | "blad"
  | "pula"
  | "info"
  | "neutral";

/**
 * Ton pigułki: albo nazwa ZNACZENIA (`aktywny`, `braki`), albo wprost ton
 * palety kalendarza (`sky`, `violet`) — tego drugiego używa kolor działu,
 * który jest wyborem użytkownika, a nie stanem do nazwania.
 */
export type BadgeTone = KadryTone | PillTone;

export const KADRY_TONE: Record<KadryTone, PillTone> = {
  // Ochrona rozlicza się z umów (sky — jak „zaplanowane" w kalendarzu),
  // biuro z zestawienia biura (violet — ten sam kolor, co wcześniej w Kadrach).
  ochrona: "sky",
  biuro: "violet",
  aktywny: "emerald",
  nieaktywny: "muted",
  // „Do przeliczenia", „przeniesione z poprzedniego miesiąca" — tak samo jak
  // „brak protokołu" w kalendarzu.
  ostrzezenie: "amber",
  braki: "amber",
  blad: "red",
  pula: "sky",
  info: "indigo",
  neutral: "neutral",
};

/**
 * Tony do wyboru jako kolor działu — ta sama lista, którą przyjmuje backend
 * (`DEPARTMENT_COLORS` w `src/routes/hr.ts`). Bez `neutral`/`muted`: te znaczą
 * „brak koloru" i zapisują się jako `null`.
 */
export const DEPARTMENT_COLOR_TONES: PillTone[] = [
  "sky",
  "emerald",
  "amber",
  "violet",
  "orange",
  "indigo",
  "teal",
  "rose",
  "red",
];

/** Polskie nazwy tonów — do dymka przy kropce palety. */
/**
 * Sekcje sidebara z własną mini-wersją Kadr („Godziny działu”) — wartości
 * kolumny `hr_departments.portal`. Lustro `HR_PORTALS` z src/lib/hr-scope.ts;
 * rozjazd skończyłby się działem-widmem, którego nie widzi ani sekcja, ani nikt.
 */
export const DEPARTMENT_PORTALS = [
  { value: "cma", label: "CMA" },
  { value: "ofi", label: "OFI" },
  { value: "handlowy", label: "Handlowy" },
  { value: "technical", label: "Techniczny" },
] as const;

export const TONE_LABELS: Partial<Record<PillTone, string>> = {
  sky: "błękitny",
  emerald: "zielony",
  amber: "bursztynowy",
  violet: "fioletowy",
  orange: "pomarańczowy",
  indigo: "granatowy",
  teal: "morski",
  rose: "różowy",
  red: "czerwony",
  neutral: "bez koloru",
};

/**
 * Ton pigułki działu. Kolor jest CECHĄ DZIAŁU (kolumna `hr_departments.color`),
 * a nie funkcją nazwy: dział wolno przemianować, a kolorowanie po nazwie (hash
 * albo mapa „CMA → niebieski") zmieniałoby wtedy kolor po cichu i wstecznie,
 * także na wpisach z zeszłych miesięcy.
 *
 * Nieznana wartość i `null` dają pigułkę neutralną — front nie zgaduje koloru
 * za dział, który go nie ma.
 */
export function departmentTone(
  dep: { color?: string | null } | null | undefined,
): BadgeTone {
  const raw = dep?.color;
  return raw && (DEPARTMENT_COLOR_TONES as string[]).includes(raw)
    ? (raw as PillTone)
    : "neutral";
}

/**
 * Pigułka Kadr. Kształt i kolory biorą się z `pillClass` kalendarza, więc
 * badge działa w obu motywach (klasa `bg-*-100` bez wariantu `dark:` daje
 * ciemny tekst na jasnym tle tylko w jasnym motywie).
 *
 * Z `onClick` renderuje `<button>` — w Działach badge jest przełącznikiem
 * („aktywny" / „nieaktywny"), a nie tylko etykietą.
 */
export function KadryBadge({
  tone = "neutral",
  icon: Icon,
  compact,
  hint,
  onClick,
  disabled,
  testId,
  className,
  children,
}: {
  tone?: BadgeTone;
  icon?: LucideIcon;
  /** Wersja do gęstych tabel — mniejsza czcionka i padding. */
  compact?: boolean;
  /** Dymek (`ui/tooltip`), nie natywny `title`. */
  hint?: ReactNode;
  onClick?: () => void;
  /** Wyłączony przełącznik: bez kursora „pointer", bez wygaszenia treści. */
  disabled?: boolean;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  // Ton znaczeniowy tłumaczy się przez mapę, ton palety (kolor działu) idzie
  // wprost — jedno `KadryBadge` obsługuje oba bez rozgałęzień u wołającego.
  const pill = KADRY_TONE[tone as KadryTone] ?? (tone as PillTone);
  const cls = pillClass(pill, { compact, className });
  const body = (
    <>
      {Icon && <Icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />}
      {children}
    </>
  );
  if (!onClick) {
    return (
      <span className={cls} data-testid={testId} {...(hint ? tip(hint) : {})}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      // Jak w `IconButton`: `aria-disabled` zamiast `disabled`, żeby dymek
      // z powodem blokady dało się w ogóle pokazać (przeglądarka nie wysyła
      // zdarzeń myszy do wyłączonych kontrolek).
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={cn(
        cls,
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled ? "cursor-default" : "hover:brightness-95 dark:hover:brightness-110",
      )}
      {...(hint ? tip(hint) : {})}
    >
      {body}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Nagłówek sekcji
// ---------------------------------------------------------------------------

/**
 * SAM nagłówek sekcji — mała wersalikowa etykieta z ikoną, jak w dialogu
 * wydarzenia; nie `<h2>` wielkości tytułu strony.
 *
 * Do pełnej sekcji (separator `border-t`, zwijanie, `aria-controls`) służy
 * `Section` z `@/components/ui/section` — to ten sam wygląd wyniesiony
 * z kalendarza i używany już przez Oferty, kartotekę obiektu i historię Kadr.
 * `SectionHeading` jest dla miejsc, gdzie sekcji nie ma: podpis nad tabelą,
 * nad kartą, nad grupą pól.
 *
 * `summary` to krótki dopisek po prawej stronie etykiety (np. liczba wierszy),
 * `action` — przycisk przy prawej krawędzi.
 */
export function SectionHeading({
  icon: Icon,
  title,
  summary,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  summary?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-2", className)}>
      <span className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        {title}
        {summary != null && (
          <span className="ml-1 truncate font-normal normal-case tracking-normal text-foreground/80">
            — {summary}
          </span>
        )}
      </span>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stan pusty
// ---------------------------------------------------------------------------

/**
 * Pusty stan w układzie kalendarza: ikona, jedno zdanie „co się stało", jedno
 * „co z tym zrobić" i akcje. Sam tekst „Brak danych" w komórce tabeli nie mówi,
 * czy filtr jest za wąski, czy słownik jest pusty.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  testId,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center gap-2 px-4 py-10 text-center", className)}
      data-testid={testId}
    >
      {Icon && <Icon className="h-8 w-8 text-muted-foreground/50" aria-hidden />}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-md text-xs text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * Ten sam pusty stan wewnątrz tabeli — jeden `<tr><td colSpan>` zamiast
 * powtarzanego w każdej zakładce „Ładowanie… / Brak wierszy".
 */
export function EmptyRow({
  colSpan,
  loading,
  ...rest
}: Parameters<typeof EmptyState>[0] & { colSpan: number; loading?: boolean }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">Ładowanie…</p>
        ) : (
          <EmptyState {...rest} />
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Kafelek KPI
// ---------------------------------------------------------------------------

/**
 * Kafelek podsumowania — 1:1 z Realizacjami (`text-lg font-semibold
 * tabular-nums`). Liczby w kolumnie kafelków muszą mieć stałą szerokość cyfr,
 * inaczej „0,00 zł" i „18 240,00 zł" rozjeżdżają sąsiadujące kafelki przy
 * każdym przeliczeniu.
 *
 * `onClick` robi z kafelka filtr (klikalny wariant): cały kafelek staje się
 * przyciskiem, a `active` zaznacza go obwódką — bez zmiany wysokości.
 */
export function KpiTile({
  label,
  value,
  sub,
  hint,
  accent,
  active,
  onClick,
  tone,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Dymek z wyjaśnieniem, z czego liczy się wartość. */
  hint?: ReactNode;
  /** Kafelek-podsumowanie („razem") — delikatna obwódka, jak w Realizacjach. */
  accent?: boolean;
  /** Wariant klikalny: filtr włączony. */
  active?: boolean;
  onClick?: () => void;
  /** Kolor samej liczby (np. `text-amber-600 dark:text-amber-400` dla braków). */
  tone?: string;
  testId?: string;
}) {
  const body = (
    <CardContent className="p-4 text-left">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", tone)}>{value}</div>
      {sub != null && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </CardContent>
  );
  const cardCls = cn(
    accent && "border-primary/50",
    active && "border-primary ring-1 ring-primary",
    onClick && "transition-colors hover:bg-accent/40",
  );
  if (!onClick) {
    return (
      <Card
        className={cn(cardCls, hint && "cursor-help")}
        data-testid={testId}
        {...(hint ? tip(hint) : {})}
      >
        {body}
      </Card>
    );
  }
  return (
    <Card className={cardCls}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        data-testid={testId}
        className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...(hint ? tip(hint) : {})}
      >
        {body}
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Przełącznik segmentowy
// ---------------------------------------------------------------------------

/**
 * Pasek wzajemnie wykluczających się przycisków — „Wszyscy / Ochrona / Biuro"
 * w kartotece, „Godzinowe / Stałe" w Wynagrodzeniach, „Podgląd / Edycja"
 * w tabelach wpisywania.
 *
 * Kadry miały ten sam układ wklejony w trzech miejscach (`flex overflow-hidden
 * rounded-md border` + `bg-primary text-primary-foreground` na aktywnym),
 * za każdym razem z inną wysokością: raz `py-2`, raz domyślne `h-10`. Tutaj
 * jest jeden wariant o wysokości paska narzędzi (`TOOLBAR_BTN_CLS`), więc
 * przełącznik stoi w linii z szukajką i selectami, a nie pół piksela wyżej.
 *
 * `count` to liczba przy etykiecie („Godzinowe 147") — przełącznik, który jest
 * zarazem spisem treści, ma mówić, ile jest po drugiej stronie, zanim się
 * kliknie.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  testId,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: {
    value: T;
    label: ReactNode;
    icon?: LucideIcon;
    /** Liczba wierszy po tej stronie przełącznika. */
    count?: ReactNode;
    /** Dymek (`ui/tooltip`), nie natywny `title`. */
    hint?: ReactNode;
    testId?: string;
  }[];
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn("flex overflow-hidden rounded-md border", className)}
    >
      {options.map((o) => {
        const Icon = o.icon;
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            data-testid={o.testId}
            className={cn(
              "flex items-center gap-1.5 px-3 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              TOOLBAR_BTN_CLS,
              active
                ? "bg-primary font-medium text-primary-foreground"
                : "hover:bg-accent",
            )}
            {...(o.hint ? tip(o.hint) : {})}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden />}
            {o.label}
            {o.count != null && (
              <span className="tabular-nums opacity-70">{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legenda kolorów
// ---------------------------------------------------------------------------

/**
 * Wiersz pod tabelą tłumaczący, co znaczy kolor liczby („nadpisane ręcznie",
 * „wyliczone automatycznie"). Zastępuje dawną legendę gwiazdki — kropka w tym
 * samym kolorze, co liczba w tabeli, zamiast znaku, którego w kolumnie liczb
 * i tak nie dało się odróżnić od przypisu.
 */
export function ToneLegend({
  items,
  className,
  testId,
}: {
  items: { tone: string; label: ReactNode; hint?: ReactNode }[];
  className?: string;
  testId?: string;
}) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
      data-testid={testId}
    >
      {items.map((it, i) => (
        <span
          key={i}
          className={cn("inline-flex items-center gap-1.5", it.hint && "cursor-help")}
          {...(it.hint ? tip(it.hint) : {})}
        >
          <span
            aria-hidden
            className={cn("h-2 w-2 rounded-full bg-current", it.tone)}
          />
          {it.label}
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Drobiazgi
// ---------------------------------------------------------------------------

/**
 * Kontener akcji wiersza — patrz `ROW_ACTIONS_CLS`. Wiersz MUSI mieć klasę
 * `group`, inaczej ikony nigdy się nie pokażą (poza dotykiem i fokusem).
 *
 * Domyślnie zatrzymuje `click`, bo w Kadrach kliknięcie wiersza otwiera dialog
 * albo rozwija umowy — bez tego kosz otwierałby przy okazji formularz.
 */
export function RowActions({
  children,
  className,
  stopPropagation = true,
}: {
  children: ReactNode;
  className?: string;
  stopPropagation?: boolean;
}) {
  return (
    <div
      className={cn(ROW_ACTIONS_CLS, className)}
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
    >
      {children}
    </div>
  );
}

/**
 * „Zapisano ✓" przy polu albo w pasku — ten sam znacznik co w karcie propozycji
 * asystenta. Zielony tekst z wariantem ciemnym, bez własnego tła.
 */
export function InlineSavedTick({
  label = "Zapisano",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300",
        className,
      )}
    >
      <Check className="h-3.5 w-3.5" aria-hidden /> {label}
    </span>
  );
}

/**
 * Przycisk ikonowy akcji wiersza (ołówek, kosz) z dymkiem zamiast `title`.
 * Opis idzie i do dymka, i do `aria-label` — czytnik ekranu dostaje to samo,
 * co widzi mysz.
 *
 * `size` domyślnie „sm" (32 px), bo akcje wiersza w gęstej tabeli Kadr nie
 * mieszczą się w standardowych 40 px.
 *
 * `disabled` NIE ustawia atrybutu `disabled`, tylko `aria-disabled` i blokadę
 * `onClick`. Powód: `Button` ma `disabled:pointer-events-none`, więc na
 * wyłączonym przycisku nie odpala się ani natywny `title`, ani dymek — a to
 * właśnie na wyłączonej akcji podpowiedź „dlaczego nie da się kliknąć" jest
 * najbardziej potrzebna (kosz przy dziale-puli CMA).
 */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  variant = "ghost",
  size = "sm",
  danger,
  testId,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  /** Opis akcji — dymek + `aria-label`. */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "ghost" | "outline" | "secondary";
  /** „sm" = 32 px (wiersz tabeli), „md" = 40/36 px (pasek narzędzi). */
  size?: "sm" | "md";
  /** Akcja niszcząca — czerwień dopiero na hoverze, jak w Technicznym. */
  danger?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="icon"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      aria-label={label}
      data-testid={testId}
      className={cn(
        size === "sm" ? "h-8 w-8" : TOOLBAR_ICON_BTN_CLS,
        danger && !disabled && "hover:bg-destructive/10 hover:text-destructive",
        disabled && "cursor-default opacity-50 hover:bg-transparent hover:text-current",
        className,
      )}
      {...tip(label)}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
