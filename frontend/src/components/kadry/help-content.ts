/**
 * TREŚĆ LEGENDY KADR — dane, nie widok.
 *
 * Panel „Legenda i skróty” (`KadryHelp.tsx`) jest kopią formy tej samej pomocy
 * z kalendarza (`HelpPopover` w `components/calendar/CalendarPage.tsx`): popover
 * pod przyciskiem „?”, na telefonie arkusz dolny, sekcje z wersalikową
 * etykietą, klawisze w `alfa-kbd`. Różni się tym, czego w kalendarzu nie ma —
 * legenda Kadr jest INNA W KAŻDEJ ZAKŁADCE, bo „?” przy przypisaniu znaczy coś
 * tylko w Godzinach, a lista wypłat gotówkowych tylko w Wynagrodzeniach.
 *
 * Dlatego treść siedzi tutaj jako STRUKTURA, a nie w JSX: sekcja deklaruje, dla
 * których zakładek jest (`tabs`; brak = wspólna dla wszystkich), a widok wybiera
 * najpierw sekcje bieżącej zakładki, potem wspólne. Dopisanie akapitu nie
 * wymaga wtedy dotykania układu panelu.
 *
 * Próbki wizualne są tu OPISANE (ton pigułki, nazwa znacznika), a renderuje je
 * `KadryHelp` prawdziwymi klockami z `./ui` — legenda pokazuje dokładnie ten
 * sam badge, który stoi w tabeli, a nie jego podobiznę wklejoną w pomoc.
 */
import type { BadgeTone, TEXT_TONE } from "./ui";

/** Zakładka, do której dopasowujemy legendę (`portal` = „Godziny działu”). */
export type KadryHelpTab =
  | "wynagrodzenia"
  | "godziny"
  | "pracownicy"
  | "obiekty"
  | "dzialy"
  | "normy"
  | "historia"
  | "portal";

/** Kolor tekstu z `TEXT_TONE` — legenda kolorów liczb. */
export type HelpToneKey = keyof typeof TEXT_TONE;

/**
 * Znacznik z tabeli, który trzeba pokazać, a nie opisać. Nazwy odpowiadają
 * temu, co widać w wierszu; rysunek każdego z nich jest w `KadryHelp`.
 */
export type HelpMark =
  | "uncertain"
  | "warning"
  | "lock"
  | "dimmed"
  | "monthClosed"
  | "history"
  | "rowActions"
  | "saved"
  | "expiring";

export type HelpItem =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "badges"; items: { tone: BadgeTone; label: string; desc: string }[] }
  | { kind: "tones"; items: { tone: HelpToneKey; label: string; desc: string }[] }
  | { kind: "marks"; items: { mark: HelpMark; desc: string }[] }
  | { kind: "keys"; items: { keys: string[]; desc: string }[] };

export interface HelpSection {
  title: string;
  /** Zakładki, w których sekcja ma sens. Brak = wspólna dla wszystkich. */
  tabs?: KadryHelpTab[];
  items: HelpItem[];
}

/** Nagłówek panelu — nazwa zakładki, żeby było widać, czego dotyczy pierwsza sekcja. */
export const HELP_TAB_TITLE: Record<KadryHelpTab, string> = {
  wynagrodzenia: "Wynagrodzenia",
  godziny: "Godziny",
  pracownicy: "Pracownicy",
  obiekty: "Obiekty",
  dzialy: "Działy",
  normy: "Normy",
  historia: "Historia",
  portal: "Godziny działu",
};

export const HELP_SECTIONS: HelpSection[] = [
  // -------------------------------------------------------------------------
  // 1. Sekcje zakładkowe — pierwsze w panelu, bo odpowiadają na „co tu widzę”.
  // -------------------------------------------------------------------------
  {
    title: "Ta zakładka",
    tabs: ["wynagrodzenia"],
    items: [
      {
        kind: "p",
        text: "Wypłaty miesiąca. Lista „Godzinowe” to umowy ochrony — kwota główna od księgowości plus dodatek liczony z godzin. Lista „Stałe” to rozliczenie biura. Obie idą na te same wydruki.",
      },
      {
        kind: "ul",
        items: [
          "Jedną umowę wpisuje się w oknie (klik w wiersz), całą kolumnę — po przełączeniu na „Edycja”.",
          "„Wklej z arkusza” przyjmuje zestawienie księgowości: nazwisko i imię, opcjonalnie spółka, na końcu kwota główna netto. Podgląd z licznikami jest przed zapisem.",
          "Wydruki biorą to, co widać w tabeli (licznik stoi na przycisku): zestawienie dla księgowości, lista wypłat gotówkowych (strona na spółkę, rubryki na datę i podpis), lista przelewów i ta sama lista w CSV do bankowości.",
        ],
      },
    ],
  },
  {
    title: "Ta zakładka",
    tabs: ["godziny"],
    items: [
      {
        kind: "p",
        text: "Godziny miesiąca. Wiersz to jedna osoba na jednym przypisaniu: dział, a w dziale obiektowym dodatkowo obiekt. Z tych liczb biorą się dodatki w Wynagrodzeniach.",
      },
      {
        kind: "ul",
        items: [
          "Pusty miesiąc zapełnia „Przenieś pracowników z poprzedniego miesiąca”: te same osoby na tych samych przypisaniach, bez godzin.",
          "„Potwierdź przypisania” zdejmuje znak zapytania ze wszystkich wierszy, które widać na ekranie — filtr zawęża też tę operację.",
          "„Wklej z arkusza” przyjmuje grafik: nazwisko i imię, opcjonalnie obiekt albo dział (gdy ktoś ma w miesiącu kilka wpisów), dalej wypracowane, urlop (UW), chorobowe (L4) i godziny nocne. Pusta komórka zostawia dotychczasową wartość, nie zeruje jej.",
          "Kolumna „pop.” pokazuje wartość z poprzedniego miesiąca — Ctrl+D wstawia ją do pola, w którym stoi kursor.",
        ],
      },
    ],
  },
  {
    title: "Ta zakładka",
    tabs: ["pracownicy"],
    items: [
      {
        kind: "p",
        text: "Kartoteka osób i ich umów — jedyna zakładka niezależna od wybranego miesiąca. Klik w wiersz rozwija umowy pracownika i jego wpisy biura z miesiąca z paska.",
      },
      {
        kind: "ul",
        items: [
          "Rodzaj mówi, skąd bierze się wypłata: Ochrona rozlicza się z umów, Biuro z zestawienia biura.",
          "Status umowy liczy serwer z dat „obowiązuje od / do” — nie zegar przeglądarki.",
          "Miesięczne rozliczenie pracowników biura jest w Wynagrodzeniach, na liście „Stałe”.",
        ],
      },
    ],
  },
  {
    title: "Ta zakładka",
    tabs: ["obiekty"],
    items: [
      {
        kind: "p",
        text: "Słownik pozycji kadrowych (posterunków) i ich mapowanie na kartotekę obiektów. Obiekt wskazuje się wyłącznie we wpisie godzin z działu obiektowego.",
      },
      {
        kind: "ul",
        items: [
          "Pozycja bez mapowania to koszt ogólny firmy — nie dolicza się do żadnego obiektu w kartotece.",
          "Nazwę zmienia się wprost w wierszu: Enter zapisuje, Esc cofa.",
        ],
      },
    ],
  },
  {
    title: "Ta zakładka",
    tabs: ["dzialy"],
    items: [
      {
        kind: "p",
        text: "Słownik działów firmy. Każdy wpis godzin należy do działu; tylko dział obiektowy (w praktyce OFI) pozwala wskazać w nim obiekt.",
      },
      {
        kind: "ul",
        items: [
          "Dział-pula CMA: jego koszt rozdziela się na wszystkie dozorowane obiekty, zamiast obciążać jeden. Pula może być tylko jedna i nie może być obiektowa.",
          "Kolor jest cechą działu, nie funkcją nazwy — ta sama pigułka wraca w Godzinach i w kartotece, także na wpisach sprzed zmiany nazwy.",
          "Portal decyduje, która sekcja widzi ten dział w swoich „Godzinach działu”.",
        ],
      },
    ],
  },
  {
    title: "Ta zakładka",
    tabs: ["normy"],
    items: [
      {
        kind: "p",
        text: "Wymiar godzin miesiąca: mianownik stawki godzinowej i limit „maks godzin” dla tych, którzy nie mają własnego. Tabela pokazuje cały rok, więc strzałki chodzą po latach, nie po miesiącach.",
      },
      {
        kind: "ul",
        items: [
          "Norma etatu wynika z artykułu 130 Kodeksu pracy: 40 h × pełne tygodnie + 8 h × wystające dni robocze − 8 h za święto przypadające poza niedzielą.",
          "„Wylicz z Kodeksu pracy” stawia wynik obok wpisanego i pokazuje listę dni wolnych, z której wyszedł — nowe święto można tam dopisać i od razu widać, którym miesiącom zmienił się wymiar.",
          "Norma zlecenia (158) jest ustaleniem firmowym, nie wynikiem z ustawy — okno jej nie rusza.",
        ],
      },
    ],
  },
  {
    title: "Ta zakładka",
    tabs: ["historia"],
    items: [
      {
        kind: "p",
        text: "Dziennik zmian całego modułu: kto, kiedy i co zmienił, z wartością przed i po. Ten sam zapis widać przy pojedynczym wierszu (ikona zegara) i na karcie pracownika.",
      },
      {
        kind: "ul",
        items: [
          "Filtry zawężają po treści, typie wpisu, użytkowniku i zakresie dat; licznik przy „Filtry” mówi, ile z nich działa.",
          "Powód otwarcia zamkniętego miesiąca trafia tutaj — to jedyne miejsce, w którym po kwartale widać, po co dane były ruszane.",
        ],
      },
    ],
  },
  {
    title: "Ten ekran",
    tabs: ["portal"],
    items: [
      {
        kind: "p",
        text: "„Godziny działu” to ta sama tabela godzin co w Kadrach, przycięta do jednej sekcji. Wiersze, działy, posterunki i ludzi spoza sekcji odcina serwer, a nie ukrywa front.",
      },
      {
        kind: "ul",
        items: [
          "Nie ma tu wypłat, kartoteki, norm ani słowników. Potrącenia i dodatki zostają — wpisuje je kierownik razem z godzinami.",
          "Miesiąc zamyka księgowość w Kadrach. Tutaj zamknięcie tylko przełącza ekran w podgląd.",
          "Pusty miesiąc nie zapełnia się sam: wiersze z poprzedniego podstawia przycisk „Przenieś pracowników z poprzedniego miesiąca”.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 2. Sekcje wspólne — kolory, pigułki, znaczniki, skróty, zasady, mapa modułu.
  // -------------------------------------------------------------------------
  {
    title: "Kolory liczb",
    items: [
      {
        kind: "tones",
        items: [
          {
            tone: "override",
            label: "nadpisane ręcznie",
            desc: "Ktoś wpisał wartość wbrew temu, co wyliczyła aplikacja. Wyliczoną podaje dymek.",
          },
          {
            tone: "computed",
            label: "wyliczone automatycznie",
            desc: "Nikt tego nie wpisywał: kwota biura z godzin i stawki, gotówka z kwoty minus ROR, godziny maks z wpisów.",
          },
          {
            tone: "warn",
            label: "ostrzeżenie",
            desc: "Brak kwoty od księgowości, dodatek do przeliczenia, przypisanie do potwierdzenia.",
          },
          {
            tone: "bad",
            label: "błąd albo minus",
            desc: "Nieudany zapis albo kwota ujemna — potrącenie.",
          },
          {
            tone: "good",
            label: "zapisane",
            desc: "Komórka poszła na serwer. Ptaszek gaśnie po chwili.",
          },
        ],
      },
    ],
  },
  {
    title: "Pigułki",
    items: [
      {
        kind: "badges",
        items: [
          {
            tone: "ochrona",
            label: "Ochrona",
            desc: "Wypłata z umowy: kwota główna plus dodatek z godzin.",
          },
          {
            tone: "biuro",
            label: "Biuro",
            desc: "Wypłata z zestawienia biura — lista „Stałe” w Wynagrodzeniach.",
          },
          {
            tone: "aktywny",
            label: "aktywny",
            desc: "Pozycja słownika w użyciu. Klik przełącza.",
          },
          {
            tone: "nieaktywny",
            label: "nieaktywny",
            desc: "Wyłączona ze słownika — nie podpowiada się przy nowych wpisach, starych nie rusza.",
          },
          {
            tone: "pula",
            label: "pula CMA",
            desc: "Dział, którego koszt rozdziela się na wszystkie dozorowane obiekty. Tylko jeden taki.",
          },
          {
            tone: "info",
            label: "obiektowy",
            desc: "Dział, w którym wpis godzin może wskazać obiekt (w praktyce OFI).",
          },
          {
            tone: "violet",
            label: "Dział",
            desc: "Kolor jest cechą działu — ta sama pigułka stoi w Godzinach, w kartotece i w „Godzinach działu”.",
          },
        ],
      },
      {
        kind: "p",
        text: "Statusy umowy (kartoteka, rozwinięcie pracownika):",
      },
      {
        kind: "badges",
        items: [
          {
            tone: "info",
            label: "przyszła",
            desc: "Zacznie obowiązywać dopiero w przyszłości — w bieżącym miesiącu nie wchodzi do wynagrodzeń.",
          },
          {
            tone: "aktywny",
            label: "aktywna",
            desc: "Obowiązuje dziś i liczy się w bieżącym miesiącu.",
          },
          {
            tone: "neutral",
            label: "zakończona",
            desc: "Okres minął; miesiące z zapisanymi kwotami zostają nietknięte.",
          },
          {
            tone: "nieaktywny",
            label: "nieaktywna",
            desc: "Ręcznie wyłączona — niezależnie od dat nie liczy się w żadnym nowym miesiącu.",
          },
        ],
      },
    ],
  },
  {
    title: "Znaczniki w tabelach",
    items: [
      {
        kind: "marks",
        items: [
          {
            mark: "uncertain",
            desc: "Przypisanie przeniesione z poprzedniego miesiąca. Zdejmuje je zapis wpisu albo przycisk „Potwierdź przypisania”.",
          },
          {
            mark: "warning",
            desc: "Ostrzeżenie wiersza, treść w dymku: godziny ponad normę przy umowie bez dodatku albo liczba fizycznie niemożliwa (doba × dni miesiąca).",
          },
          {
            mark: "expiring",
            desc: "Umowa kończy się w ciągu 30 dni albo termin już minął, a nikt nie podpisał następnej w tej spółce.",
          },
          {
            mark: "lock",
            desc: "Listę trzyma teraz ktoś inny. W podglądzie widać do kiedy; o zwolnienie można poprosić jednym kliknięciem.",
          },
          {
            mark: "dimmed",
            desc: "Wyszarzony wiersz — dział wzięty przez swoją sekcję w „Godzinach działu”. Reszta tabeli zostaje do edycji, o ten dział prosi się osobno.",
          },
          {
            mark: "monthClosed",
            desc: "Godziny, wypłaty i biuro tego miesiąca są tylko do odczytu.",
          },
          {
            mark: "history",
            desc: "Historia tego wiersza: kto, kiedy i z czego na co go zmienił.",
          },
          {
            mark: "rowActions",
            desc: "Edycja i usuwanie pokazują się po najechaniu na wiersz (na dotyku są widoczne od razu, na klawiaturze — po Tabie).",
          },
          {
            mark: "saved",
            desc: "Potwierdzenie zapisu komórki — zamiast komunikatu przy każdej wpisanej liczbie.",
          },
        ],
      },
    ],
  },
  {
    title: "Tryb edycji — klawiatura",
    tabs: ["godziny", "wynagrodzenia", "portal"],
    items: [
      {
        kind: "keys",
        items: [
          { keys: ["Enter"], desc: "Niżej, ta sama kolumna" },
          { keys: ["⇧", "Enter"], desc: "Wyżej, ta sama kolumna" },
          { keys: ["Tab"], desc: "Następne pole w wierszu (⇧Tab — poprzednie)" },
          { keys: ["Esc"], desc: "Cofnij wpis w tej komórce" },
        ],
      },
      {
        kind: "p",
        text: "Zapisuje wyjście z pola, nie Enter — jedno żądanie na komórkę, nie dwa.",
      },
    ],
  },
  {
    // Osobna sekcja, nie dopisek do poprzedniej: Ctrl+D jest w Godzinach
    // i w sekcjach, a w Wynagrodzeniach go nie ma — dwa razy ten sam nagłówek
    // czytałoby się jak pomyłka.
    title: "Kopiowanie z poprzedniego miesiąca",
    tabs: ["godziny", "portal"],
    items: [
      {
        kind: "keys",
        items: [
          {
            keys: ["Ctrl", "D"],
            desc: "Wstaw wartość z poprzedniego miesiąca (wypracowane, urlop, chorobowe, nocne)",
          },
        ],
      },
    ],
  },
  {
    title: "Okno wypłaty",
    tabs: ["wynagrodzenia"],
    items: [
      {
        kind: "keys",
        items: [
          { keys: ["Ctrl", "Enter"], desc: "Zapisz i przejdź do następnej umowy" },
          { keys: ["Esc"], desc: "Zamknij okno bez zapisu" },
        ],
      },
      {
        kind: "p",
        text: "„← Poprzedni” i „Następny →” chodzą po tej samej liście, którą widać w tabeli — z jej filtrami i sortowaniem.",
      },
    ],
  },
  {
    title: "Pola i listy",
    items: [
      {
        kind: "keys",
        items: [
          { keys: ["↑", "↓"], desc: "Podpowiedzi pracownika: wybór z listy" },
          { keys: ["Enter"], desc: "Zatwierdź podpowiedź; w polu nazwy — zapisz" },
          { keys: ["Esc"], desc: "Zamknij listę, popover miesiąca albo okno" },
          { keys: ["?"], desc: "Ta ściąga" },
        ],
      },
    ],
  },
  {
    title: "Zasady modułu",
    items: [
      {
        kind: "ul",
        items: [
          "Wszystkie kwoty w Kadrach są netto, „na rękę”. Kwot brutto aplikacja nie zna — księgowość podaje same kwoty do wypłaty i tak też opisane są wydruki.",
          "Wpis godzin rozlicza się na dziale, a w dziale obiektowym dodatkowo na obiekcie. W pozostałych działach godziny są kosztem ogólnym firmy.",
          "Rezerwacja: przełączenie na „Edycja” bierze listę na 15 minut i przedłuża się, dopóki ktoś przy niej siedzi. Sekcja rezerwuje wyłącznie swoje działy, pełne Kadry — całość poza działami zajętymi przez sekcje. O zajętą listę wolno poprosić; właściciel oddaje ją albo dokłada sobie kwadrans.",
          "Zamknięcie miesiąca przełącza godziny, wypłaty i biuro w tryb odczytu. Zamknąć można też z brakami — potwierdzenie mówi, czego brakuje. Otwarcie z powrotem wymaga powodu, który trafia do dziennika zmian.",
          "Nowy miesiąc podstawia wiersze godzin z poprzedniego: te same osoby i przypisania, bez liczb. Przypisania stoją ze znakiem zapytania, dopóki ktoś ich nie potwierdzi.",
          "Normy etatu wynikają z artykułu 130 Kodeksu pracy, więc zależą wyłącznie od świąt — listę dni wolnych widać w oknie „Wylicz z Kodeksu pracy”.",
        ],
      },
    ],
  },
  {
    title: "Gdzie co jest",
    items: [
      {
        kind: "p",
        text: "Zakładki idą od danych stałych do roboty miesiąca:",
      },
      {
        kind: "ul",
        items: [
          "Normy — wymiar godzin na każdy miesiąc roku. Ustawia się raz.",
          "Działy — słownik działów: pula CMA, dział obiektowy, kolor, sekcja.",
          "Obiekty — posterunki i ich mapowanie na kartotekę obiektów.",
          "Pracownicy — osoby, umowy, rodzaj rozliczenia. Bez miesiąca.",
          "Godziny — wypracowane, urlop, chorobowe, nocne, potrącenia i dodatki.",
          "Wynagrodzenia — kwoty od księgowości, wypłaty, rozliczenie biura, wydruki.",
          "Historia — dziennik zmian całego modułu.",
          "„Godziny działu” w sekcjach CMA, OFI, Handlowy i Techniczny — ta sama tabela godzin, przycięta do jednej sekcji.",
        ],
      },
      {
        kind: "p",
        text: "Czego nie widać w menu, tego nie ma też tutaj — podzakładki pokazują się zgodnie z uprawnieniami.",
      },
    ],
  },
];
