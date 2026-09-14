// Najnowsze pierwsze. Utrzymywane przez skill /commit.

import { UPDATES_2026 } from "./updates.2026";

/** Rodzaj wpisu — decyduje o ikonie i kolorze na stronie „Co nowego”. */
export type UpdateType = "feat" | "fix" | "tweak" | "style";

/**
 * Moduł aplikacji, którego dotyczy wpis — odpowiada sekcjom menu bocznego.
 * `ogolne` to zmiany przekrojowe (logowanie, menu, panel admina, wydajność).
 */
export type UpdateModule =
  | "ogolne"
  | "analityka"
  | "kadry"
  | "cma"
  | "handlowy"
  | "techniczny"
  | "ofi"
  // Panel technika (`/technik`) ma własny numer wersji i własną stronę
  // „Co nowego”, więc jego wpisy żyją w `UPDATES_TECHNIK`, a nie w historii
  // CRM-a — ale moduł jest wspólny, żeby filtr na `/co-nowego` mógł je pokazać.
  | "technik";

/** Etykiety modułów pokazywane przy wpisach i w filtrze. */
export const MODULE_LABELS: Record<UpdateModule, string> = {
  ogolne: "Ogólne",
  analityka: "Analityka",
  kadry: "Kadry",
  cma: "CMA",
  handlowy: "Handlowy",
  techniczny: "Techniczny",
  ofi: "OFI",
  technik: "Panel technika",
};

/** Pojedynczy punkt na liście zmian jednej wersji. */
export interface UpdateEntry {
  text: string;
  type: UpdateType;
  module: UpdateModule;
}

/** Jedna karta na stronie „Co nowego”. */
export interface VersionUpdate {
  /**
   * Wersja aplikacji, np. `'1.2.0'`, albo zakres z półpauzą (`'1.2.0–1.2.3'`),
   * gdy kilka wydań tego samego dnia trafiło do jednej karty. Brak wersji =
   * wpis historyczny sprzed wprowadzenia wersjonowania.
   */
  version?: string;
  /** Data wydania w formacie `YYYY-MM-DD`. */
  date: string;
  /** Tytuł karty — tylko dla kamieni milowych. */
  title?: string;
  entries: UpdateEntry[];
}

/**
 * Wpisy dopisywane na bieżąco przez `/commit` (najnowsze pierwsze). Historia
 * zamknięta leży w plikach rocznych `updates.YYYY.ts` — gdy ta lista urośnie
 * albo zmieni się rok, przenosi się ją na górę pliku bieżącego roku.
 */
export const UPDATES_CURRENT: VersionUpdate[] = [
  {
    version: "1.6.0",
    date: "2026-09-14",
    title: "Panel technika",
    entries: [
      {
        text: "Panel technika: technicy i podwykonawcy logują się na tablecie, widzą swoje zlecenia, rozpoczynają je, kończą i podpisują protokół u klienta",
        type: "feat",
        module: "technik",
      },
      {
        text: "Konta mają nową rolę technik, a pracownikom biura można włączyć panel technika w ustawieniach konta",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Protokół wypełniony przez technika zostawia w wydarzeniu notatkę z czynnościami, urządzeniami i stanem podpisu, z odnośnikiem do protokołu",
        type: "feat",
        module: "techniczny",
      },
      {
        text: "Strona Co nowego ma osobną zakładkę z historią zmian panelu technika",
        type: "tweak",
        module: "ogolne",
      },
    ],
  },
  {
    version: "1.5.0",
    date: "2026-09-14",
    entries: [
      {
        text: "Umowę spoza generatora (skan podpisanej, umowa od klienta) dodaje się jako PDF do draftów i przenosi do rejestru, zamiast trzymać ją na dysku sieciowym",
        type: "feat",
        module: "kadry",
      },
      {
        text: "Wpis w rejestrze umów ma własny dokument z podpisami, niezależnie od wersji z generatora",
        type: "feat",
        module: "kadry",
      },
      {
        text: "Umowa powierzenia danych (RODO) ma osobny szablon i własną serię numerów, więc nie zabiera numerów umowom ZDW",
        type: "feat",
        module: "kadry",
      },
      {
        text: "Projekt CCTV można podpiąć pod obiekt z kartoteki, a karta obiektu pokazuje jego projekty",
        type: "feat",
        module: "techniczny",
      },
    ],
  },
  {
    version: "1.2.0–1.4.0",
    date: "2026-09-10",
    title: "Co nowego w aplikacji",
    entries: [
      {
        text: "Link do Google Maps w notatce pokazuje małą mapkę z pinezką i nazwą miejsca, z przyciskami do otwarcia w Mapach i nawigacji",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Pod mapką od razu widać kilometry i czas dojazdu od biura i od obiektu, bez sprawdzania trasy osobno",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Notatki zajmują całą szerokość karty, a przyciski akcji mają lekkie tło",
        type: "tweak",
        module: "ogolne",
      },
      {
        text: "Karta obiektu pokazuje mapkę pod linkiem do Google Maps",
        type: "tweak",
        module: "kadry",
      },
      {
        text: "Na węższych ekranach panel wydarzenia w kalendarzu wsuwa się z boku, a przy niezapisanych zmianach aplikacja pyta przed podmianą wydarzenia",
        type: "tweak",
        module: "ogolne",
      },
      {
        text: "Mail z Outlooka można upuścić prosto na dzień albo godzinę w kalendarzu, a wydarzenie powstaje z tematem w tytule i treścią maila jako notatką, zamiast przeklejania tego ręcznie",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Notatka z maila pokazuje nadawcę, odbiorców, datę i załączniki, obrazki z maila widać po najechaniu, a obiekt podpowiada się sam po adresach kontaktów",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Linki w notatkach i opisach są klikalne i mają podgląd strony z ikoną i tytułem",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Notatki lepiej się czytają: listy, pogrubienia i cytaty, a w mailach cytowana historia jest zwinięta",
        type: "tweak",
        module: "ogolne",
      },
      {
        text: "W zwiniętym menu bocznym miniaturka konta otwiera menu użytkownika",
        type: "tweak",
        module: "ogolne",
      },
      {
        text: "Nowa strona „Co nowego” z historią zmian od początku aplikacji, z filtrem po module i typie zmiany",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Numer wersji w prawym dolnym rogu prowadzi wprost do listy zmian, bez pytania w firmie, co weszło z ostatnią aktualizacją",
        type: "feat",
        module: "ogolne",
      },
    ],
  },
];

/** Pełna historia zmian — najnowsze pierwsze. */
export const UPDATES: VersionUpdate[] = [...UPDATES_CURRENT, ...UPDATES_2026];

/**
 * HISTORIA PANELU TECHNIKA — osobna lista i osobne numery wersji
 * (`TECHNIK_VERSION`), bo panel wydaje się niezależnie od CRM-a, a jego
 * changelog czyta ktoś inny: technik w aucie, nie biuro. Stąd też inny język
 * wpisów — co się zmienia w robocie, bez nazw modułów i ekranów.
 */
export const UPDATES_TECHNIK: VersionUpdate[] = [
  {
    version: "1.0.0",
    date: "2026-09-14",
    title: "Panel technika",
    entries: [
      {
        text: "Technik widzi swoje zlecenia na dziś i najbliższe dni na tablecie — bez dzwonienia do biura po adres i godzinę",
        type: "feat",
        module: "technik",
      },
      {
        text: "Rozpoczęcie i zakończenie zlecenia jednym dotknięciem; biuro od razu widzi, co jest w toku",
        type: "feat",
        module: "technik",
      },
      {
        text: "Protokół z podpisem klienta wypełnia się na miejscu, zamiast spisywać go potem w biurze",
        type: "feat",
        module: "technik",
      },
      {
        text: "Wykonane czynności wybiera się z podpowiedzi jednym dotknięciem, zamiast wpisywać je za każdym razem",
        type: "feat",
        module: "technik",
      },
      {
        text: "Kilometry w protokole wypełniają się same z odległości od biura",
        type: "feat",
        module: "technik",
      },
      {
        text: "Rozpoczęcie i zakończenie można cofnąć na inną godzinę, gdy zapomniało się kliknąć na miejscu",
        type: "tweak",
        module: "technik",
      },
    ],
  },
];
