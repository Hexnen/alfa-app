/**
 * Seed BIBLIOTEKI OPISÓW ofertowych (`offer_texts`) — zakładka „Opisy"
 * w /technical/oferty. Uruchomienie:
 *
 *   npx tsx scripts/seed-offer-texts.ts
 *
 * To NIE są dane deweloperskie (te siedzą w scripts/seed-dev/ i znikają przy
 * `--reset`), tylko punkt startowy dla firmy: gotowe akapity, które handlowiec
 * dokleja do oferty zamiast wklejać je za każdym razem ze starego dokumentu.
 *
 * IDEMPOTENCJA PO NAZWIE, nie po pustej tabeli. Skrypt pomija wzorzec, którego
 * nazwa już jest w bazie, a dokłada resztę — dzięki temu można go uruchomić
 * ponownie po dopisaniu nowych pozycji do tej listy i nie nadpisze się przy tym
 * treści, którą ktoś zdążył poprawić na ekranie.
 *
 * TREŚĆ JEST PROPOZYCJĄ, NIE USTALENIEM. Okresy gwarancji, procenty zaliczki,
 * czasy reakcji i terminy przechowywania nagrań wpisano tak, jak wyglądają
 * typowo w tej branży — przed pierwszym wysłaniem oferty trzeba je przejrzeć
 * i dopasować do własnych umów. Po to jest edytor wzorca.
 *
 * SKŁADNIA: podzbiór markdownu z frontend/src/lib/markdownLite.ts — nagłówki
 * `###`, listy `-` i `1.`, `**pogrubienie**`, `*kursywa*`. W treści bloku
 * używamy `###`, bo `##` renderuje się do tego samego poziomu co nagłówek
 * bloku drukowany nad nim.
 */
import { inArray } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";

type NewText = typeof schema.offerTexts.$inferInsert;

/*
 * `isDefault` dostają WYŁĄCZNIE trzy uniwersalne bloki. Domyślny opis dokleja
 * się do każdej nowej oferty — także tej z designera CCTV — więc wszystko, co
 * dotyczy konkretnej technologii, zostaje do dołożenia ręcznie.
 */
const TEXTS: NewText[] = [
  {
    name: "Warunki gwarancji",
    category: "inne",
    title: "Warunki gwarancji",
    isDefault: true,
    position: 10,
    body: `Na zamontowane urządzenia udzielamy **24 miesięcy gwarancji**, licząc od daty podpisania protokołu odbioru. Na wykonane prace instalacyjne — **36 miesięcy**.

### Gwarancja obejmuje

- naprawę lub wymianę urządzenia, które uległo awarii z przyczyn niezależnych od użytkownika,
- dojazd i robociznę w ramach napraw gwarancyjnych,
- zdalną diagnozę systemu.

### Gwarancja nie obejmuje

- uszkodzeń po przepięciach w sieci energetycznej, wyładowaniach atmosferycznych i zdarzeniach losowych,
- skutków ingerencji w system osób nieupoważnionych,
- celowego uszkodzenia i dewastacji urządzeń,
- materiałów eksploatacyjnych, w tym akumulatorów.

Warunkiem utrzymania gwarancji jest wykonywanie **przeglądów okresowych** zgodnie z zaleceniami producenta urządzeń.`,
  },
  {
    name: "Warunki płatności i realizacji",
    category: "inne",
    title: "Warunki płatności i realizacji",
    isDefault: true,
    position: 20,
    body: `- Wszystkie kwoty podano w **złotych netto**; do ceny doliczany jest podatek VAT według stawki obowiązującej w dniu wystawienia faktury.
- Płatność: zaliczka **40%** wartości zamówienia przy podpisaniu umowy, pozostałe **60%** po podpisaniu protokołu odbioru, przelewem w terminie 14 dni.
- Termin realizacji uzgadniamy po przyjęciu zlecenia — zależy od dostępności sprzętu i gotowości obiektu do prac.
- Do chwili uregulowania pełnej należności zamontowane urządzenia pozostają własnością wykonawcy.`,
  },
  {
    name: "Zakres prac i wyłączenia",
    category: "inne",
    title: "Co obejmuje oferta",
    isDefault: true,
    position: 30,
    body: `Cena obejmuje dostawę i montaż urządzeń wymienionych w ofercie, ułożenie okablowania, konfigurację i uruchomienie systemu oraz szkolenie personelu z obsługi.

Oferta **nie obejmuje**:

- prac budowlanych i wykończeniowych — przekuć, zabudów, malowania po bruzdach,
- doprowadzenia zasilania 230 V do wskazanych punktów,
- łącza internetowego i abonamentu operatora,
- prac na wysokości wymagających podnośnika, o ile nie ujęto ich w pozycjach oferty.`,
  },
  {
    name: "Serwis i wsparcie techniczne",
    category: "inne",
    title: "Serwis i wsparcie techniczne",
    isDefault: false,
    position: 40,
    body: `- Zgłoszenia serwisowe przyjmujemy telefonicznie i mailowo w dni robocze w godzinach 8:00–16:00.
- Reakcja na zgłoszenie awarii krytycznej: **do 24 godzin roboczych** od przyjęcia zgłoszenia.
- Usterki możliwe do usunięcia zdalnie podejmujemy niezwłocznie po zgłoszeniu.
- Prace serwisowe poza zakresem gwarancji rozliczamy według obowiązującego cennika usług serwisowych.`,
  },
  {
    name: "Przygotowanie obiektu przed montażem",
    category: "inne",
    title: "Przygotowanie obiektu",
    isDefault: false,
    position: 50,
    body: `Żeby prace przebiegły bez przestojów, prosimy o przygotowanie przed rozpoczęciem montażu:

1. dostępu do wszystkich pomieszczeń objętych instalacją,
2. zasilania 230 V w miejscach wskazanych podczas wizji lokalnej,
3. łącza internetowego z możliwością podłączenia rejestratora,
4. osoby kontaktowej po stronie Zamawiającego, uprawnionej do bieżących ustaleń.

Prace prowadzimy w uzgodnionych godzinach, a po ich zakończeniu porządkujemy stanowisko pracy.`,
  },
  {
    name: "CCTV — opis rozwiązania",
    category: "cctv",
    title: "System telewizji dozorowej",
    isDefault: false,
    position: 60,
    body: `Proponowany system opiera się na kamerach IP i rejestratorze sieciowym z dyskami przystosowanymi do pracy ciągłej.

Rozwiązanie zapewnia:

- obraz w rozdzielczości pozwalającej na **rozpoznanie osoby** w kluczowych strefach obiektu,
- pracę po zmroku dzięki doświetleniu podczerwienią,
- podgląd na żywo i dostęp do nagrań z komputera oraz telefonu,
- rejestrację wyzwalaną detekcją ruchu, co wydłuża czas przechowywania nagrań.

Rozmieszczenie kamer dobrano tak, aby pokryć drogi dojścia i dojazdu oraz punkty newralgiczne obiektu.`,
  },
  {
    name: "CCTV — nagrania i RODO",
    category: "cctv",
    title: "Nagrania i ochrona danych osobowych",
    isDefault: false,
    position: 70,
    body: `Zaproponowana pojemność dysków pozwala przechowywać nagrania przez okres uzgodniony z Zamawiającym. Przepisy o ochronie danych osobowych przewidują przechowywanie nagrań z monitoringu **nie dłużej niż 3 miesiące** od dnia nagrania, o ile nie stanowią one dowodu w postępowaniu.

Obowiązki administratora danych — oznaczenie obszaru monitorowanego, klauzula informacyjna i rejestr czynności przetwarzania — pozostają po stronie Zamawiającego. Na życzenie pomagamy przygotować dokumentację i tabliczki informacyjne.`,
  },
  {
    name: "SSWiN — opis rozwiązania",
    category: "sswin",
    title: "System sygnalizacji włamania i napadu",
    isDefault: false,
    position: 80,
    body: `System chroni obiekt czujkami ruchu oraz kontaktronami na drzwiach i oknach, a o naruszeniu strefy informuje sygnalizatorem i powiadomieniem.

- Podział na strefy pozwala dozorować część obiektu przy pracy w pozostałych pomieszczeniach.
- Uzbrajanie i rozbrajanie: manipulatorem, pilotem albo z aplikacji w telefonie.
- Podtrzymanie akumulatorowe utrzymuje gotowość systemu również przy zaniku zasilania.
- System przygotowany jest do podłączenia do stacji monitorowania alarmów.`,
  },
  {
    name: "Kontrola dostępu — opis rozwiązania",
    category: "kd",
    title: "System kontroli dostępu",
    isDefault: false,
    position: 90,
    body: `System ogranicza wejście do wskazanych pomieszczeń do osób uprawnionych i rejestruje każde przejście.

- Identyfikacja kartą zbliżeniową lub breloczkiem; uprawnienia nadaje się indywidualnie.
- Harmonogramy czasowe otwierają strefę tylko w wyznaczonych godzinach.
- Rejestr zdarzeń pokazuje, kto i kiedy wszedł do pomieszczenia.
- Przejścia na drogach ewakuacyjnych wyposażamy w zwory rewersyjne, które zwalniają blokadę po zaniku napięcia.`,
  },
  {
    name: "Wideoweryfikacja alarmów",
    category: "wideoweryfikacja",
    title: "Wideoweryfikacja alarmów",
    isDefault: false,
    position: 100,
    body: `Wideoweryfikacja łączy system alarmowy z kamerami: po naruszeniu strefy operator stacji monitorowania ogląda materiał z chwili zdarzenia i dopiero na tej podstawie decyduje o interwencji.

- Ogranicza koszty wyjazdów grupy interwencyjnej do fałszywych alarmów.
- Skraca czas reakcji, bo operator wie, co dzieje się na obiekcie.
- Materiał z weryfikacji zostaje zapisany i jest dostępny na życzenie Zamawiającego.`,
  },
  {
    name: "Monitoring i abonament",
    category: "abonament",
    title: "Monitoring obiektu",
    isDefault: false,
    position: 110,
    body: `Obiekt zostaje podłączony do stacji monitorowania alarmów pracującej całodobowo. Sygnał przesyłany jest torem GPRS z podtrzymaniem, więc przecięcie linii telefonicznej nie odcina obiektu od stacji.

W ramach abonamentu:

- całodobowy odbiór i obsługa sygnałów alarmowych,
- powiadomienie osób wskazanych przez Zamawiającego,
- interwencja grupy patrolowej na zasadach określonych w umowie,
- test łączności i nadzór nad stanem systemu.

Abonament rozliczany jest miesięcznie, z góry, na podstawie faktury.`,
  },
];

const names = TEXTS.map((t) => t.name);
const existing = new Set(
  db
    .select({ name: schema.offerTexts.name })
    .from(schema.offerTexts)
    .where(inArray(schema.offerTexts.name, names))
    .all()
    .map((r) => r.name)
);

const toInsert = TEXTS.filter((t) => !existing.has(t.name));

if (toInsert.length === 0) {
  console.log(`Biblioteka opisów jest już kompletna — wszystkie ${TEXTS.length} wzorców w bazie.`);
} else {
  db.insert(schema.offerTexts).values(toInsert).run();
  console.log(`Dodano ${toInsert.length} opisów ofertowych:`);
  for (const t of toInsert) {
    console.log(`  - ${t.name}${t.isDefault ? "  (domyślny — na każdej ofercie)" : ""}`);
  }
  if (existing.size > 0) {
    console.log(`Pominięto ${existing.size}, bo wzorce o tych nazwach już były.`);
  }
}
process.exit(0);
