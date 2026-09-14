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
    version: "1.11.0",
    date: "2026-09-15",
    entries: [
      {
        text: "Wydarzenie, które technik właśnie realizuje, świeci w kalendarzu złotą pulsującą poświatą, aż do zakończenia",
        type: "feat",
        module: "techniczny",
      },
      {
        text: "Panel technika: zmiany z kalendarza pojawiają się na tablecie od razu, bez odświeżania",
        type: "feat",
        module: "technik",
      },
    ],
  },
  {
    version: "1.6.0–1.10.0",
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
      {
        text: "Panel technika: instalacja na ekranie tabletu, powiadomienia o zleceniach, pogoda i dojazd z biura",
        type: "feat",
        module: "technik",
      },
      {
        text: "Panel technika: liczniki zleceń na dolnym pasku, żółte przy zmianach z biura",
        type: "tweak",
        module: "technik",
      },
      {
        text: "Panel technika: zdjęcia z aparatu jako notatki zlecenia (widoczne też w kalendarzu) i protokół w czterech krokach",
        type: "feat",
        module: "technik",
      },
      {
        text: "Panel technika: mapa zleceń, nowy ekran zlecenia i poprawki po pierwszej fali testów",
        type: "feat",
        module: "technik",
      },
      {
        text: "Zmiana roli konta przy błędzie zapisu nie degraduje już administratora",
        type: "fix",
        module: "ogolne",
      },
      {
        text: "Protokół podpisuje się tylko na wersji, którą widać na ekranie, a usunięty protokół nie oddaje numeru",
        type: "fix",
        module: "techniczny",
      },
      {
        text: "Panel technika: poprawki po drugiej fali testów, „Wznów” po omyłkowym zakończeniu, lista kontaktów do zlecenia",
        type: "fix",
        module: "technik",
      },
      {
        text: "Dopisek biura w notatce protokołu nie ginie już przy zapisie z tabletu, a puste „Wykonane czynności” nie dostają tytułu zlecenia",
        type: "fix",
        module: "techniczny",
      },
      {
        text: "Aplikacja ładuje się szybciej po aktualizacji: niezmienione pliki nie są pobierane ponownie",
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
    version: "1.5.0",
    date: "2026-09-15",
    entries: [
      {
        text: "Zmiany z biura (termin, opis, notatka, odwołanie, przypisanie) pojawiają się na liście i w zleceniu od razu, bez odświeżania",
        type: "feat",
        module: "technik",
      },
      {
        text: "Kafelek zlecenia pokazuje, ile nowych notatek dopisało biuro od ostatniego zajrzenia",
        type: "feat",
        module: "technik",
      },
      {
        text: "Dojazd z biura liczy się raz na zlecenie, więc protokół ma kilometry od razu, bez czekania",
        type: "tweak",
        module: "technik",
      },
    ],
  },
  {
    version: "1.0.0–1.4.0",
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
      {
        text: "Panel można zainstalować na ekranie głównym tabletu i otwierać jak zwykłą aplikację, bez paska przeglądarki",
        type: "feat",
        module: "technik",
      },
      {
        text: "Powiadomienie o nowym zleceniu, zmianie terminu i odwołaniu przychodzi na tablet, bez sprawdzania listy co chwilę",
        type: "feat",
        module: "technik",
      },
      {
        text: "Przy każdym zleceniu widać pogodę z temperaturą, a pod „Nawiguj” kilometry i czas dojazdu z biura",
        type: "feat",
        module: "technik",
      },
      {
        text: "Ekrany zakładek nie mają już powtórzonego tytułu u góry, więcej miejsca na listę",
        type: "tweak",
        module: "technik",
      },
      {
        text: "Liczba zleceń na dziś i nadchodzących stoi na dolnym pasku, a plakietka żółknie, gdy biuro coś dodało lub przesunęło od ostatniego zajrzenia",
        type: "feat",
        module: "technik",
      },
      {
        text: "Data na ekranie Dziś i w nagłówku zlecenia mieści się w całości, w dwóch liniach zamiast uciętej jednej",
        type: "tweak",
        module: "technik",
      },
      {
        text: "Zdjęcie z aparatu dodaje się do zlecenia jako notatka, kilka naraz, bez wysyłania ich potem mailem do biura",
        type: "feat",
        module: "technik",
      },
      {
        text: "Protokół wypełnia się w czterech krokach: dane, czynności, urządzenia, odbiór — z podsumowaniem i listą braków przed podpisem",
        type: "feat",
        module: "technik",
      },
      {
        text: "Godziny, kilometry, typ pracy i data wybiera się dotknięciem z wartości ze zlecenia, zamiast wpisywać je z klawiatury",
        type: "tweak",
        module: "technik",
      },
      {
        text: "Protokół zapisuje się sam w trakcie wypełniania, a stan zapisu widać na dole z godziną",
        type: "tweak",
        module: "technik",
      },
      {
        text: "Zakładka Mapa pokazuje zlecenia na dziś lub 14 dni jako pinezki z rodzajem pracy i nazwą obiektu, dopasowane tak, żeby wszystko było widoczne",
        type: "feat",
        module: "technik",
      },
      {
        text: "Ekran zlecenia: obiekt i godzina na górze, Nawiguj i Zadzwoń pod kciukiem, notatki i protokół zwinięte, jeden główny przycisk",
        type: "feat",
        module: "technik",
      },
      {
        text: "Bez zasięgu panel mówi „Brak połączenia” zamiast wylogowywać, a logowanie nie zawiesza się na zawsze",
        type: "fix",
        module: "technik",
      },
      {
        text: "Zapis protokołu przy zerwanym połączeniu nie czyści już wypełnionych pól",
        type: "fix",
        module: "technik",
      },
      {
        text: "„Zakończ” bez wcześniejszego „Rozpocznij” i ponowne dotknięcie nie blokują już poprawki godziny",
        type: "fix",
        module: "technik",
      },
      {
        text: "Powiadomienia: seria terminów to jedno powiadomienie, a przełącznik pokazuje prawdziwy stan konta",
        type: "tweak",
        module: "technik",
      },
      {
        text: "Po podpisaniu protokołu panel od razu pyta, czy zakończyć wizytę",
        type: "feat",
        module: "technik",
      },
      {
        text: "„Zadzwoń” pyta przed połączeniem, a przy kilku osobach pokazuje listę kontaktów do zlecenia",
        type: "feat",
        module: "technik",
      },
      {
        text: "Omyłkowe „Zakończ” da się cofnąć przyciskiem „Wznów” do 24 godzin",
        type: "feat",
        module: "technik",
      },
      {
        text: "Odwołane zlecenie otwiera się z informacją od biura zamiast komunikatu o braku dostępu",
        type: "feat",
        module: "technik",
      },
      {
        text: "W uwagach protokołu działają spacje i nowe linie, a wyjście z protokołu zapisuje ostatnie zmiany",
        type: "fix",
        module: "technik",
      },
      {
        text: "Mapa nie gubi już zbliżenia po powrocie z nawigacji, obrocie ekranu ani zmianie zakresu",
        type: "fix",
        module: "technik",
      },
      {
        text: "Czas trwania wizyty w godzinach i minutach, jedna informacja o odbiorze po podpisie",
        type: "tweak",
        module: "technik",
      },
    ],
  },
];
