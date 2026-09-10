import type { VersionUpdate } from './updates'

// Historia zmian sprzed wprowadzenia wersjonowania (backfill z git log, 2026).
// Najnowsze pierwsze. Wpisy historyczne nie mają numeru wersji — numerowanie
// zaczyna się od 1.2.0.
export const UPDATES_2026: VersionUpdate[] = [
  {
    date: '2026-09-09',
    title: 'Moduł Handlowy, czyli koniec Excela z leadami',
    entries: [
      { text: 'Nowa sekcja Handlowy: lejek szans sprzedaży, kontakty, pulpit i kalendarz handlowca', type: 'feat', module: 'handlowy' },
      { text: 'Szansa bez zaplanowanego następnego kroku albo z ciszą dłuższą niż tydzień podświetla się sama', type: 'feat', module: 'handlowy' },
      { text: 'Szansę sprzedaży można jednym kliknięciem zamienić w zlecenie albo w kontrahenta z obiektem, zamiast wpisywać te same dane drugi raz', type: 'feat', module: 'handlowy' },
      { text: 'Karty obiektu i kontrahenta pokazują powiązane z nimi szanse i osoby kontaktowe', type: 'feat', module: 'handlowy' },
      { text: 'W Analityce doszedł przekrój lejka sprzedaży: widać, na którym etapie szanse się kończą', type: 'feat', module: 'analityka' },
    ],
  },
  {
    date: '2026-09-09',
    title: 'Import towarów ze sklepów',
    entries: [
      { text: 'Towar w Magazynie zakłada się z zapisanej strony sklepu dostawcy, zamiast przepisywać nazwę, cenę, kod i zdjęcie z drugiego okna', type: 'feat', module: 'techniczny' },
      { text: 'Wtyczka do przeglądarki dodaje towar wprost ze sklepu albo odkłada go do kolejki „Do dodania z wtyczki”', type: 'feat', module: 'techniczny' },
      { text: 'Przy towarze widać źródła u dostawców z kodem, ceną, stanem i datą odczytu, bez otwierania stron kolejnych sklepów', type: 'feat', module: 'techniczny' },
      { text: 'Wiek ceny widać kolorem: żółty po pół roku, czerwony po roku', type: 'feat', module: 'techniczny' },
      { text: 'W tabeli towarów pojawiły się miniatury zdjęć z podglądem po kliknięciu', type: 'tweak', module: 'techniczny' },
    ],
  },
  {
    date: '2026-09-09',
    title: 'Grupy interwencyjne',
    entries: [
      { text: 'Nowa zakładka CMA → Grupy interwencyjne: firmy interwencyjne i warunki współpracy osobno dla każdego obiektu, z historią zmian, zamiast szukania ustaleń sprzed roku w mailach', type: 'feat', module: 'cma' },
      { text: 'Rejestr podjazdów z rozliczeniem liczonym na bieżąco — widać, co i komu się należy', type: 'feat', module: 'cma' },
      { text: 'Gotowe szablony zapytania ofertowego i wypowiedzenia, z możliwością dopięcia załączników', type: 'feat', module: 'cma' },
    ],
  },
  {
    date: '2026-09-09',
    title: 'Manuale',
    entries: [
      { text: 'Nowa zakładka Techniczny → Manuale: instrukcje i dokumentacja sprzętu w jednym miejscu, koniec szukania po mailach i pendrive’ach', type: 'feat', module: 'techniczny' },
      { text: 'Do manuala można dopiąć pliki i powiązać go z towarem z magazynu albo z usługą', type: 'feat', module: 'techniczny' },
    ],
  },
  {
    date: '2026-09-09',
    title: 'Drafty umów',
    entries: [
      { text: 'Umowy → Drafty umów: gotowy dokument w Wordzie powstaje z szablonu i danych z systemu, zamiast przerabiania zeszłorocznej umowy', type: 'feat', module: 'kadry' },
      { text: 'Numer draftu nadaje się sam, osobno dla każdej spółki i rocznika', type: 'feat', module: 'kadry' },
    ],
  },
  {
    date: '2026-09-09',
    entries: [
      { text: 'Obiekt ma okresy usług z datami — widać, od kiedy i do kiedy coś realnie działa, bez ustalania tego z pamięci', type: 'feat', module: 'kadry' },
      { text: 'Abonament rozbity na poszczególne usługi zamiast jednej zbiorczej kwoty', type: 'feat', module: 'kadry' },
      { text: 'Notatkę z kalendarza można skopiować do obiektu — zostaje przy nim niezależnie od wydarzenia', type: 'feat', module: 'kadry' },
    ],
  },
  {
    date: '2026-09-09',
    entries: [
      { text: 'Mail ze zlecenia wychodzi wprost z aplikacji, bez przeklejania treści do Outlooka', type: 'feat', module: 'kadry' },
      { text: 'Ustawienia poczty zebrane w Administracja → Poczta; wysyłka jest domyślnie wyłączona, dopóki ktoś jej świadomie nie włączy', type: 'feat', module: 'ogolne' },
      { text: 'Kolejne poprawki asystenta AI w planowaniu wydarzeń', type: 'tweak', module: 'ogolne' },
    ],
  },
  {
    date: '2026-09-08',
    entries: [
      { text: 'Na liście zleceń doszła ikona koperty: podgląd maila do klienta i wersji wewnętrznej', type: 'feat', module: 'kadry' },
      { text: '„Kopiuj do Outlooka” przenosi gotową treść z formatowaniem, bez poprawiania układu po wklejeniu; temat i adresata kopiuje się osobnymi przyciskami', type: 'feat', module: 'kadry' },
      { text: 'Temat maila układa się sam: „[ZDW] NAZWA OBIEKTU / KONTRAHENT”', type: 'feat', module: 'kadry' },
      { text: 'Szablon maila poprawiony tak, żeby wyglądał dobrze także w Outlooku', type: 'style', module: 'kadry' },
    ],
  },
  {
    date: '2026-09-08',
    entries: [
      { text: 'W notatkach wydarzeń można wspomnieć osobę, żeby wiedziała, że sprawa jej dotyczy, bez osobnego telefonu', type: 'feat', module: 'techniczny' },
      { text: 'Wyszukiwanie współrzędnych adresu radzi sobie ze skrótem „ul.” i kodem pocztowym, więc rzadziej kończy się pustym wynikiem', type: 'fix', module: 'ogolne' },
      { text: 'Uzupełnione kontakty i numery NIP w kartotece kontrahentów', type: 'tweak', module: 'kadry' },
    ],
  },
  {
    date: '2026-09-07',
    entries: [
      { text: 'Do notatki przy wydarzeniu można dorzucić zdjęcia i dokumenty — także przeciągnięciem na okno', type: 'feat', module: 'techniczny' },
      { text: 'Zdjęcia z telefonu są zmniejszane w locie, więc nie trzeba ich wcześniej pomniejszać ani czekać na wysyłkę', type: 'tweak', module: 'techniczny' },
      { text: 'Rozpisana notatka nie ginie przy zamknięciu okna — aplikacja pyta, co z nią zrobić', type: 'fix', module: 'techniczny' },
      { text: 'Przy wydarzeniach widać pogodę na termin razem z ostrzeżeniami meteorologicznymi', type: 'feat', module: 'techniczny' },
      { text: 'Szczegółowa prognoza na dobę i na tydzień w oknie wydarzenia', type: 'feat', module: 'techniczny' },
      { text: 'Przeciągnięcie wydarzenia zapisuje się nawet wtedy, gdy widok odświeży się w trakcie', type: 'fix', module: 'techniczny' },
    ],
  },
  {
    date: '2026-09-07',
    entries: [
      { text: 'Wszystkie listy w systemie sortuje się klikiem w nagłówek i filtruje tak samo jak listę obiektów, bez uczenia się każdego ekranu od nowa', type: 'feat', module: 'ogolne' },
      { text: 'Doszły filtry po wartości z widełkami kwot i przycisk „Wyczyść filtry”', type: 'feat', module: 'ogolne' },
      { text: 'Liczniki nad listami pokazują to, co faktycznie widać po nałożeniu filtrów', type: 'fix', module: 'ogolne' },
      { text: 'Kartoteka obiektów uzupełniona danymi z rejestru kontrahentów i monitoringu', type: 'tweak', module: 'kadry' },
    ],
  },
  {
    date: '2026-09-07',
    entries: [
      { text: 'Usprawnienia pod maską: wpisywane dane są sprawdzane dokładniej, a hasła muszą spełnić ostrzejsze wymagania', type: 'tweak', module: 'ogolne' },
    ],
  },
  {
    date: '2026-09-06',
    entries: [
      { text: 'Usprawnienia pod maską: poprawki wdrożenia, żeby aktualizacje wchodziły na serwer bez potknięć', type: 'tweak', module: 'ogolne' },
    ],
  },
  {
    date: '2026-09-05',
    entries: [
      { text: 'Odrzucona oferta znika spod linku dla klienta, zamiast dalej wyglądać na aktualną', type: 'fix', module: 'techniczny' },
      { text: 'Link dla klienta wystawi się dopiero wtedy, gdy oferta ma choć jedną pozycję wliczoną w kwotę', type: 'fix', module: 'techniczny' },
      { text: 'Aktualizacja cen nie kasuje już wpisanych kosztów, a marża w wierszu liczy się tak samo jak w podsumowaniu', type: 'fix', module: 'techniczny' },
      { text: 'Nowa wersja oferty udostępnionej klientowi przestała kończyć się błędem', type: 'fix', module: 'techniczny' },
    ],
  },
  {
    date: '2026-09-05',
    entries: [
      { text: 'Działu z przypisanymi pracownikami nie da się już skasować jednym kliknięciem — aplikacja mówi, kogo to dotyczy', type: 'fix', module: 'kadry' },
      { text: 'Dział z pulą centrum monitorowania jest chroniony przed usunięciem, żeby rozliczanie kosztów nie wyłączyło się po cichu', type: 'fix', module: 'kadry' },
      { text: 'Błędnie wpisana liczba godzin wraca z czytelnym komunikatem zamiast zapisywać się jako pusta', type: 'fix', module: 'kadry' },
      { text: 'Ewidencja godzin otwiera się od razu, bez czekania na wczytanie tabeli', type: 'tweak', module: 'kadry' },
      { text: 'W projektach rozdzielone „Usuń wszystko” i „Usuń wszystkie kamery”, poprawione zaznaczanie zakresu kamer', type: 'fix', module: 'techniczny' },
    ],
  },
  {
    date: '2026-09-04',
    entries: [
      { text: 'Biblioteka gotowych opisów do ofert — gwarancja, wsparcie, warunki płatności — zamiast kopiowania ze starych dokumentów', type: 'feat', module: 'techniczny' },
      { text: 'Poprawka wzorca nie zmienia treści oferty, która już poszła do klienta', type: 'feat', module: 'techniczny' },
      { text: 'Ofertę można udostępnić klientowi linkiem: bez kosztów, marż, uwag wewnętrznych i niewybranych wariantów', type: 'feat', module: 'techniczny' },
      { text: 'Aktualizacja cen pokazuje najpierw „z czego na co” i pozwala ruszyć tylko wybrane pozycje', type: 'feat', module: 'techniczny' },
      { text: 'Wydruk dla klienta z blokiem sprzedawcy i nabywcy oraz miejscem na podpisy', type: 'feat', module: 'techniczny' },
    ],
  },
  {
    date: '2026-09-04',
    entries: [
      { text: 'Pracownik ma macierzysty dział w kartotece, a wpis godzin sam go podpowiada', type: 'feat', module: 'kadry' },
      { text: 'Filtr „Bez działu” pokazuje, kogo jeszcze trzeba uzupełnić', type: 'feat', module: 'kadry' },
    ],
  },
  {
    date: '2026-09-04',
    entries: [
      { text: 'Kamery w projekcie można układać w grupy, przeciągać między nimi i zaznaczać po kilka naraz', type: 'feat', module: 'techniczny' },
      { text: 'Kolor grupy jest kolorem jej kamer, więc plan czyta się bez sprawdzania legendy przy każdej pozycji', type: 'feat', module: 'techniczny' },
      { text: 'Eksport dokumentu z zakładkami, stroną zbliżenia na każdą grupę i stroną danych projektu', type: 'feat', module: 'techniczny' },
      { text: 'Doszedł typ kamery do odczytu tablic rejestracyjnych', type: 'feat', module: 'techniczny' },
    ],
  },
  {
    date: '2026-09-02',
    title: 'Działy w Kadrach',
    entries: [
      { text: 'Nowa zakładka Kadry → Działy: praca, która nie dotyczy żadnego obiektu, ma wreszcie swoje miejsce', type: 'feat', module: 'kadry' },
      { text: 'Wpis godzin wskazuje obiekt albo dział — nigdy jedno i drugie naraz', type: 'feat', module: 'kadry' },
      { text: 'Koszt centrum monitorowania rozdziela się po dozorowanych obiektach na podstawie działu, a nie nazwy pozycji', type: 'feat', module: 'analityka' },
      { text: 'Usunięcie działu, na którym wiszą godziny, wymaga potwierdzenia', type: 'fix', module: 'kadry' },
    ],
  },
  {
    date: '2026-09-02',
    entries: [
      { text: 'Pakiety ofertowe z własnym edytorem: jedna pozycja rozwija się na komplet sprzętu i montaży', type: 'feat', module: 'techniczny' },
      { text: 'Przy cenach w Magazynie i w Usługach widać, od kiedy nie były aktualizowane', type: 'feat', module: 'techniczny' },
    ],
  },
  {
    date: '2026-08-31',
    title: 'Moduł Oferty',
    entries: [
      { text: 'Nowa zakładka Techniczny → Oferty zastępuje wystawianie ofert w zewnętrznym narzędziu', type: 'feat', module: 'techniczny' },
      { text: 'Jeden dokument liczy trzy strumienie: jednorazówkę, abonament i dzierżawę sprzętu', type: 'feat', module: 'techniczny' },
      { text: 'Gotowe pakiety: „CCTV → 8 kamer” rozwija się na kamery, rejestrator i montaże, zamiast wpisywania ośmiu pozycji z ręki', type: 'feat', module: 'techniczny' },
      { text: 'Nowa zakładka Techniczny → Usługi: robocizna i abonamenty z kosztem własnym obok ceny', type: 'feat', module: 'techniczny' },
      { text: 'Magazyn dostał cenę zakupu, cenę sprzedaży i producenta, a oferta liczy z nich marżę', type: 'feat', module: 'techniczny' },
      { text: 'Zaakceptowana oferta od razu zakłada zlecenie i szkic wydania sprzętu z magazynu', type: 'feat', module: 'techniczny' },
    ],
  },
  {
    date: '2026-08-31',
    entries: [
      { text: 'W kalendarzu doszedł widok „Trasa”: punkty dnia, podział na samochody i kolejność zjazdów', type: 'feat', module: 'techniczny' },
      { text: 'Kadry → Godziny: komórki wypełnia się wprost w tabeli, bez otwierania okna przy każdym wierszu', type: 'feat', module: 'kadry' },
      { text: 'Analityka mówi wprost, które miesiące nie zostały jeszcze rozliczone, zamiast pokazywać zagadkowe „dane za 2”', type: 'fix', module: 'analityka' },
    ],
  },
  {
    date: '2026-08-29',
    title: 'Handlowcy i Spółki',
    entries: [
      { text: 'Nowa zakładka Handlowcy — opiekuna przypisuje się kontrahentowi albo konkretnemu obiektowi', type: 'feat', module: 'kadry' },
      { text: 'Nowa zakładka Spółki, wspólna z kadrami; dane firmowe zaciągają się z oficjalnych rejestrów, zamiast przepisywania ich z pieczątki', type: 'feat', module: 'kadry' },
      { text: 'Kontrahenci i obiekty rozdzieleni na „aktualnych” i „archiwalnych”, z licznikami przy zakładkach', type: 'feat', module: 'kadry' },
      { text: 'Lista obiektów z filtrami po kontrahencie, opiekunie, spółce, statusie i widełkach kwot oraz sortowaniem po każdej kolumnie', type: 'feat', module: 'kadry' },
      { text: 'Firmę można wyszukać po numerze NIP wprost w formularzu', type: 'feat', module: 'kadry' },
    ],
  },
  {
    date: '2026-08-29',
    title: 'Analityka',
    entries: [
      { text: 'Nowa sekcja Analityka: rentowność kontrahentów, obiektów i handlowców', type: 'feat', module: 'analityka' },
      { text: 'Obok przychodu można wpisać koszt obiektu i koszt handlowca, a system liczy marżę i czas zwrotu, bez arkusza obok', type: 'feat', module: 'analityka' },
      { text: 'Nieuzupełniony koszt nie jest liczony jako zero — marża zostaje pusta zamiast pokazywać 100%', type: 'feat', module: 'analityka' },
      { text: 'Koszt osobowy obiektu liczy się z wynagrodzeń i przepracowanych godzin, razem ze składkami pracodawcy', type: 'feat', module: 'analityka' },
      { text: 'Kadry → Obiekty: ekran do powiązania słownika kadrowego z kartoteką obiektów', type: 'feat', module: 'kadry' },
      { text: 'CMA → Obiekty: ekran do powiązania rejestru monitoringu z kartoteką obiektów', type: 'feat', module: 'cma' },
      { text: 'W całej aplikacji widać, czy kwota jest netto czy brutto', type: 'tweak', module: 'ogolne' },
    ],
  },
  {
    date: '2026-08-29',
    entries: [
      { text: 'Zamiast jednego „typu ochrony” obiekt ma niezależne usługi: alarm, kamery, wideorecepcja i OFI', type: 'feat', module: 'kadry' },
      { text: 'Kamery można policzyć, a koszt centrum monitorowania rozkłada się po dozorowanych jednostkach', type: 'feat', module: 'analityka' },
      { text: 'Realizacje, wyceny i protokoły trzymają się obiektu na stałe — koniec z podpinaniem pod bliźniaczy obiekt o tej samej nazwie', type: 'fix', module: 'techniczny' },
    ],
  },
  {
    date: '2026-08-29',
    entries: [
      { text: 'Godziny i kilometry policzone w realizacji trafiają do niepodpisanego protokołu i tylko do pustych pól', type: 'feat', module: 'techniczny' },
      { text: 'Po podpisaniu protokołu wycena przelicza się z jego materiałów, godzin i kilometrów, bez liczenia wszystkiego drugi raz', type: 'feat', module: 'techniczny' },
      { text: 'Kafelki w Analityce przestały pokazywać przychód, koszt i zysk, które do siebie nie pasowały', type: 'fix', module: 'analityka' },
    ],
  },
  {
    date: '2026-08-29',
    entries: [
      { text: 'Usprawnienia pod maską: bezpieczniejsze usuwanie powiązanych danych i testy, które nie ruszają prawdziwej bazy', type: 'tweak', module: 'ogolne' },
    ],
  },
  {
    date: '2026-08-27',
    title: 'Asystent AI',
    entries: [
      { text: 'Asystent planuje wydarzenia w kalendarzu z rozmowy i zapisuje je dopiero po zatwierdzeniu propozycji', type: 'feat', module: 'ogolne' },
      { text: 'Umie też zmieniać istniejące wydarzenia — przesunąć, zamknąć, anulować — z podglądem „było → będzie” na siatce', type: 'feat', module: 'ogolne' },
      { text: 'Skrót „Podsumuj dzisiejszy dzień” oraz zestawienia grupowane po dniu, techniku, obiekcie lub typie, zamiast przeglądania kalendarza wydarzenie po wydarzeniu', type: 'feat', module: 'ogolne' },
      { text: 'Wyniki wyszukiwania są klikalne, z szybkimi akcjami Wykonane, Anuluj i Przesuń', type: 'feat', module: 'ogolne' },
      { text: 'Rozpoczęta odpowiedź przeżywa odświeżenie strony', type: 'fix', module: 'ogolne' },
      { text: 'Administracja → Asystent AI: konfiguracja zachowania, reguł kalendarza, dostępu i limitów', type: 'feat', module: 'ogolne' },
    ],
  },
  {
    date: '2026-08-27',
    entries: [
      { text: 'Wydarzenie ma dziennik notatek — kto, kiedy i co dopisał, bez odtwarzania ustaleń z pamięci tydzień później', type: 'feat', module: 'techniczny' },
      { text: 'Rozliczenie wydarzenia (gwarancja, darmowe, płatne) i podpięty protokół widać już na kafelku', type: 'feat', module: 'techniczny' },
      { text: 'Wykonane serwisy same zakładają realizację i protokół; zafakturowane są pomijane', type: 'feat', module: 'techniczny' },
      { text: 'Kalendarz na pełną wysokość okna, ukrywanie weekendów i zapisywane zestawy filtrów', type: 'feat', module: 'techniczny' },
      { text: 'Własne dymki podglądu wydarzenia zamiast systemowych', type: 'style', module: 'techniczny' },
    ],
  },
  {
    date: '2026-08-27',
    entries: [
      { text: 'Realizacja podlicza się sama: godziny z kalendarza, kwoty z cennika, kilometry z trasy biuro → obiekt', type: 'feat', module: 'techniczny' },
      { text: 'Protokół uzupełnia się danymi z łańcucha wydarzenie → obiekt → kontrahent', type: 'feat', module: 'techniczny' },
      { text: 'Można prowadzić kilka cenników naraz i przypisywać je technikom', type: 'feat', module: 'techniczny' },
      { text: 'Mapa realizacji miesiąca obok podsumowania rocznego', type: 'feat', module: 'techniczny' },
      { text: 'Przy techniku doszły e-mail, firma i NIP', type: 'feat', module: 'techniczny' },
      { text: 'Administracja → Firma: adres biura, stawki i sterowanie automatycznymi wyliczeniami', type: 'feat', module: 'ogolne' },
    ],
  },
  {
    date: '2026-08-26',
    title: 'Kalendarz',
    entries: [
      { text: 'Nowa zakładka Techniczny → Kalendarz: serwisy, montaże, wizje, konserwacje, prace biurowe i urlopy', type: 'feat', module: 'techniczny' },
      { text: 'Widoki miesiąc, tydzień, dzień, lista i tablica, z przeciąganiem wydarzeń i skrótami klawiszowymi', type: 'feat', module: 'techniczny' },
      { text: 'Wydarzenia cykliczne z wyborem, czy zmiana dotyczy jednego terminu, kolejnych czy wszystkich', type: 'feat', module: 'techniczny' },
      { text: 'Urlopy i wykrywanie konfliktów pokazują, kto naprawdę jest dostępny', type: 'feat', module: 'techniczny' },
      { text: 'Kalendarz można podpiąć do telefonu jako subskrypcję', type: 'feat', module: 'techniczny' },
      { text: 'Historia zmian „kto, co i kiedy” działa w całej aplikacji i zbiera się na karcie obiektu, więc nie trzeba obdzwaniać zespołu, kto co poprawił', type: 'feat', module: 'ogolne' },
    ],
  },
  {
    date: '2026-08-21',
    title: 'Magazyn',
    entries: [
      { text: 'Nowa zakładka Techniczny → Magazyn: kartoteka towarów ze zdjęciami oraz magazyny główne, samochodowe, pracownicze i obiektowe', type: 'feat', module: 'techniczny' },
      { text: 'Dokumenty przyjęcia, wydania, rozchodu i przesunięcia ze szkicami, numeracją nadawaną przy zatwierdzeniu i stornem', type: 'feat', module: 'techniczny' },
      { text: 'Stany liczą się z ruchów, a magazyn nie wyda więcej, niż ma na stanie', type: 'feat', module: 'techniczny' },
      { text: 'Do dokumentu można dopiąć skan faktury, zamiast trzymać go w osobnym segregatorze', type: 'feat', module: 'techniczny' },
      { text: 'Archiwizacja towaru albo magazynu z niezerowym stanem jest blokowana, z możliwością przywrócenia', type: 'fix', module: 'techniczny' },
    ],
  },
  {
    date: '2026-08-21',
    entries: [
      { text: 'Godziny na nowy miesiąc można przenieść z poprzedniego i tylko je uzupełnić, zamiast wystukiwać wszystko od zera', type: 'feat', module: 'kadry' },
      { text: 'Przeniesione wpisy mają znacznik „obiekt do potwierdzenia”, który znika po zapisaniu wiersza', type: 'feat', module: 'kadry' },
    ],
  },
  {
    date: '2026-08-11',
    entries: [
      { text: 'Do projektu można wczytać rysunek DWG — aplikacja sama rozpoznaje jednostkę rysunku i wymiary terenu w metrach', type: 'feat', module: 'techniczny' },
      { text: 'Wczytywanie pokazuje etapy i postęp, a „Anuluj” przerywa je bez śladu w projekcie', type: 'feat', module: 'techniczny' },
      { text: 'Przy niepewnym odczycie aplikacja wyraźnie ostrzega i proponuje kalibrację dwoma punktami', type: 'feat', module: 'techniczny' },
      { text: 'Etykiety z długościami boków nie przekręcają się już na obróconym wydruku', type: 'fix', module: 'techniczny' },
    ],
  },
  {
    date: '2026-07-22',
    entries: [
      { text: 'Plan zagospodarowania z pliku PDF wchodzi na mapę w prawdziwej skali — skala odczytuje się z samego rysunku, bez mierzenia i przeliczania z ręki', type: 'feat', module: 'techniczny' },
      { text: 'Kalibracja dwoma kliknięciami i podaniem rzeczywistej odległości, gdy skala się nie zgadza', type: 'feat', module: 'techniczny' },
      { text: 'Tryb „Samodzielny”: plan zamiast mapy, bez podkładu, z dopasowaniem do ekranu', type: 'feat', module: 'techniczny' },
      { text: 'Wczytany plan można zablokować kłódką, żeby nie przesunął się przy pracy', type: 'feat', module: 'techniczny' },
      { text: 'Wczytywanie planu z paskiem postępu, przyciskiem „Anuluj” i bez zamrażania okna', type: 'feat', module: 'techniczny' },
      { text: 'Import planu jest około dwa razy szybszy, a przy lewej krawędzi mapy doszedł pionowy suwak zoomu', type: 'tweak', module: 'techniczny' },
    ],
  },
  {
    date: '2026-07-13',
    entries: [
      { text: 'Projekt można zapisać jako nazwaną wersję i wrócić do niej później, zamiast odtwarzać wcześniejszy układ po uwagach klienta', type: 'feat', module: 'techniczny' },
    ],
  },
  {
    date: '2026-07-11',
    entries: [
      { text: 'Wydruk map osobno dla każdego obszaru: każdy na własnej stronie, obrócony tak, żeby wypełnić kartkę', type: 'feat', module: 'techniczny' },
      { text: 'Dwa warianty wydruku do wyboru: sam plan albo wersja opisowa', type: 'feat', module: 'techniczny' },
      { text: 'Numery kamer i etykiety zostają czytelne niezależnie od obrotu strony', type: 'fix', module: 'techniczny' },
    ],
  },
  {
    date: '2026-07-11',
    entries: [
      { text: 'Formularz zlecenia przyjmuje e-mail do faktury oraz warunki umowy i dzierżawy', type: 'feat', module: 'kadry' },
      { text: 'Miejsce zlecenia wskazuje się na mapie, zamiast opisywać je słowami', type: 'feat', module: 'kadry' },
    ],
  },
  {
    date: '2026-07-11',
    entries: [
      { text: 'Usprawnienia pod maską: aplikacja działa jako jedna paczka na serwerze firmowym i sama przygotowuje bazę przy starcie', type: 'tweak', module: 'ogolne' },
    ],
  },
  {
    date: '2026-07-10',
    title: 'Panel administracyjny',
    entries: [
      { text: 'Administracja → Użytkownicy: konta i dostęp do każdej podzakładki osobno — brak, podgląd albo edycja', type: 'feat', module: 'ogolne' },
      { text: 'Bez uprawnienia zakładka w ogóle się nie pokazuje, a w trybie podglądu widać pasek „tylko do odczytu”, więc nikt nie wypełnia formularza, którego i tak nie zapisze', type: 'feat', module: 'ogolne' },
      { text: 'Zakładanie kont z ulicy zostało wyłączone — konta zakłada administrator', type: 'feat', module: 'ogolne' },
    ],
  },
  {
    date: '2026-07-10',
    title: 'Kadry i dział techniczny',
    entries: [
      { text: 'Nowa sekcja Kadry: wynagrodzenia, godziny i pracownicy w jednym miejscu', type: 'feat', module: 'kadry' },
      { text: 'Nowa sekcja Techniczny: realizacje, protokoły, wyceny i cennik', type: 'feat', module: 'techniczny' },
      { text: 'Szablony modeli kamer i wyposażenia do wykorzystania w projektach, zamiast wpisywania tych samych parametrów przy każdym planie', type: 'feat', module: 'techniczny' },
      { text: 'Nowe menu boczne: sekcje z podzakładkami zamiast zakładek na górze ekranu', type: 'feat', module: 'ogolne' },
      { text: 'Sekcja OFI zarezerwowana na przyszłość', type: 'tweak', module: 'ofi' },
    ],
  },
  {
    date: '2026-07-10',
    entries: [
      { text: 'Kamery na ogrodzeniu rozstawiają się automatycznie: aplikacja liczy pokrycie, łączy krótkie odcinki i sama radzi sobie z narożnikami', type: 'feat', module: 'techniczny' },
      { text: 'Dwa tryby rozstawienia — „Równomiernie” i „Mniej słupów” — z liczbą kamer i słupów widoczną przy każdym', type: 'feat', module: 'techniczny' },
      { text: 'Zmiana trybu, zakładanego pokrycia albo szablonu od razu przestawia kamery na planie, bez przesuwania ich pojedynczo', type: 'feat', module: 'techniczny' },
    ],
  },
  {
    date: '2026-07-10',
    entries: [
      { text: 'Formularz przyjęcia zlecenia ZDW — wewnętrzny i publiczny — kieruje zlecenie prosto do systemu, bez etapu kartki na biurku', type: 'feat', module: 'kadry' },
    ],
  },
  {
    date: '2026-07-06',
    title: 'Moduł CMA',
    entries: [
      { text: 'Nowa sekcja CMA: raporty z przeglądu kamer, trendy i bieżące braki obrazu', type: 'feat', module: 'cma' },
      { text: 'Raporty wczytują się same ze skrzynki pocztowej albo ręcznie z pliku, bez powtórek', type: 'feat', module: 'cma' },
      { text: 'Zgłoszenie braków do klienta wychodzi z aplikacji: od razu po imporcie, o wyznaczonej godzinie albo na żądanie', type: 'feat', module: 'cma' },
      { text: 'Braki kamer pokazują zmianę względem poprzedniego raportu, z rozwijaniem obiektów i filtrami, bez zestawiania dwóch plików obok siebie', type: 'feat', module: 'cma' },
      { text: 'Wejście do aplikacji wymaga zalogowania', type: 'feat', module: 'ogolne' },
    ],
  },
  {
    date: '2026-02-04',
    title: 'Zlecenia',
    entries: [
      { text: 'Pierwsza wersja modułu Zlecenia: lista z filtrami i karta zlecenia', type: 'feat', module: 'kadry' },
      { text: 'Formularz zlecenia zakłada od razu kontrahenta i obiekt, jeśli jeszcze ich nie ma', type: 'feat', module: 'kadry' },
      { text: 'Numer NIP jest sprawdzany i formatowany w trakcie wpisywania, a duplikat nie przechodzi', type: 'feat', module: 'kadry' },
      { text: 'Karty szczegółów umowy i zlecenia zamiast pustych ekranów', type: 'fix', module: 'kadry' },
    ],
  },
  {
    date: '2026-02-01',
    entries: [
      { text: 'Usprawnienia pod maską: aplikacja dostępna także spoza firmowej sieci', type: 'tweak', module: 'ogolne' },
    ],
  },
  {
    date: '2026-01-28',
    title: 'Początek',
    entries: [
      { text: 'Pierwsza wersja Alfa App — zalążek systemu, na którym stanęła cała reszta', type: 'feat', module: 'ogolne' },
    ],
  },
]
