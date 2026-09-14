/**
 * Mapy tagów wzorów umów + CLI. Silnik (skanowanie akapitów, cięcie runów,
 * asercje, `--verify`) siedzi w `scripts/umowy/docx-tagger.ts`.
 *
 *   # Umowa ZDW (domyślny wzór — wywołanie bez --template działa jak dotąd)
 *   npx tsx scripts/umowy/tag-docx-template.ts \
 *     --in "obiekty/Aktualne Drafty 05.2023/ALFA G/Aktualna Umowa Draft Tylko ZDW.docx" \
 *     --out templates/umowy/zdw-alfa-group.docx --verify
 *
 *   # Umowa powierzenia danych osobowych (RODO)
 *   npx tsx scripts/umowy/tag-docx-template.ts --template rodo --verify
 *
 * Mapa tagów jest ODDZIELNA DLA KAŻDEGO WZORU, bo indeksy akapitów i frazy
 * należą do konkretnego pliku Worda. Wspólny jest tylko sposób wstawiania
 * tagów — stąd podział na ten plik (dane) i silnik (kod).
 *
 * FAIL-LOUD: liczba akapitów i ich dokładna treść są asertowane. Przy nowej
 * wersji dokumentu skrypt powie wprost, co się nie zgadza.
 */
import { runTagger, type TemplateTagSpec } from "./docx-tagger.js";

/** Kropkowany placeholder do wypełnienia: trzy lub więcej wielokropków, czasem z kropką. */
const KROPKI = /…{3,}\.?/;

// ---------------------------------------------------------------------------
// Umowa ZDW — Alfa Group
// ---------------------------------------------------------------------------

const ZDW: TemplateTagSpec = {
  key: "zdw",
  label: "Umowa ZDW — Alfa Group",
  defaultIn: "obiekty/Aktualne Drafty 05.2023/ALFA G/Aktualna Umowa Draft Tylko ZDW.docx",
  defaultOut: "templates/umowy/zdw-alfa-group.docx",
  paragraphCount: 251,
  expectedText: {
    2: "Nr 07/01/S.C./2026",
    4: "zawarta w dniu 07.01.2026r. w Warszawie, dalej jako „Umowa”, pomiędzy:",
    6: "Alfa Group Sp. z o.o. z siedzibą w Warszawie (03-612) przy ul. Koniczynowa 2A, wpisaną do rejestru przedsiębiorców Krajowego Rejestru Sądowego prowadzonego przez Sąd Rejonowy dla m. st. Warszawy w Warszawie XIII Wydział Gospodarczy Krajowego Rejestru Sądowego pod numerem KRS: 0000119104, posiadającą nr NIP: 693-18-36-206, REGON: 390651040, kapitał zakładowy: 50 000,00 zł reprezentowaną przez: ",
    7: "- Sławomira Jaworskiego - Prezesa Zarządu",
    13: "Stacja Napraw Powypadkowych Michał Pawlak",
    //   = twarda spacja — Word wstawił ją po przecinkach; asercja musi o niej wiedzieć.
    14: "ul. Heroldów 7, 01-991 Warszawa,\u00a0NIP:\u00a01180090458,\u00a0",
    16: "- Michał Pawlak ",
    25: 'Usługi, o których mowa w ust. 1 powyżej będą świadczone wobec obiektu Heroldów 7 w Warszawie.  (dalej "Obiekt").',
    26: "Zleceniodawca oświadcza, że Obiekt jest / nie jest*  obiektem podlegającym obowiązkowej ochronie zgodnie z art. 5 ustawy z dnia 22 sierpnia 1997 roku o ochronie osób i mienia (Dz. U. z 2020 r. poz. 838) i zobowiązuje się do pisemnego poinformowania Zleceniobiorcy niezwłocznie po tym, gdy powyższy stan ulegnie zmianie.",
    54: "Zleceniodawca wskazuje \u00a0e-mail m.pawlak@autobielany.pl, na który otrzymuje od CMA informacje bieżące na temat działania / usterek systemu , widoczności na Obiekcie \u00a0itp.",
    67: "W przypadku kiedy Zleceniodawca nie będzie w stanie docierać na Obiekt w czasie do  30 minut istnieje możliwość wezwania grupy interwencyjnej, która zabezpieczy teren do czasu przyjazdu przedstawiciela Zleceniodawcy. Koszt godziny przebywania załogi interwencyjnej na Obiekcie będzie wynosił od 150 zł (słownie: sto pięćdziesiąt złotych) powiększone o podatek VAT w stawce obowiązującej w dniu wystawienia przez Zleceniobiorcę faktury za każdą rozpoczętą godzinę.",
    101: "Z tytułu świadczenia przez Zleceniobiorcę na rzecz Zleceniodawcy usług będących przedmiotem niniejszej umowy, Zleceniodawca zobowiązuje się płacić Zleceniobiorcy wynagrodzenie w formie miesięcznego abonamentu w kwocie 1900 zł (słownie: jeden tysiąc dziewięćset złotych) powiększone o podatek VAT w stawce obowiązującej w dniu wystawienia przez Zleceniobiorcę faktury VAT.",
    103: "Faktura VAT będzie dostarczona do Zleceniodawcy w formie: elektronicznej (e-faktura) wystawianej miesięcznie wysyłanej na wskazany adres e-mail: m.pawlak@autobielany.pl",
    119: "Zleceniodawca oświadcza, że jest/nie jest dużym przedsiębiorcą w rozumieniu ustawy z dnia 8 marca 2013 r. o przeciwdziałaniu nadmiernym opóźnieniom w transakcjach handlowych.",
    194: "……………., tel.: …………….,",
    195: "e-mail: …………….",
    196: "……………., tel.: …………….",
    197: "e-mail: …………….",
  },
  hyperlinks: [
    { paragraph: 54, relId: "rId8" },
    { paragraph: 103, relId: "rId11" },
  ],
  forbiddenInRels: ["m.pawlak@autobielany.pl"],
  tags: [
    // --- Nagłówek umowy ---
    { paragraph: 2, find: "07/01/S.C./2026", tag: "numer" },
    { paragraph: 4, find: "07.01.2026", tag: "data_umowy" },
    { paragraph: 4, find: "Warszawie", tag: "miejsce" },
    // --- Zleceniobiorca (spółka) ---
    { paragraph: 6, find: "Alfa Group Sp. z o.o.", tag: "zleceniobiorca_nazwa" },
    { paragraph: 6, find: "Warszawie (03-612) przy ul. Koniczynowa 2A", tag: "zleceniobiorca_siedziba" },
    { paragraph: 6, find: "0000119104", tag: "zleceniobiorca_krs" },
    { paragraph: 6, find: "693-18-36-206", tag: "zleceniobiorca_nip" },
    { paragraph: 6, find: "390651040", tag: "zleceniobiorca_regon" },
    { paragraph: 6, find: "50 000,00 zł", tag: "zleceniobiorca_kapital" },
    { paragraph: 7, find: "Sławomira Jaworskiego - Prezesa Zarządu", tag: "zleceniobiorca_reprezentant" },
    // --- Zleceniodawca (kontrahent) ---
    { paragraph: 13, find: "Stacja Napraw Powypadkowych Michał Pawlak", tag: "kontrahent_nazwa" },
    { paragraph: 14, find: "ul. Heroldów 7, 01-991 Warszawa", tag: "kontrahent_adres" },
    { paragraph: 14, find: "1180090458", tag: "kontrahent_nip" },
    { paragraph: 16, find: "Michał Pawlak", tag: "kontrahent_reprezentant" },
    // --- Obiekt ---
    { paragraph: 25, find: "Heroldów 7 w Warszawie", tag: "obiekt_adres" },
    // Gwiazdka po wariancie ZOSTAJE — odsyła do przypisu „niepotrzebne skreślić”.
    { paragraph: 26, find: "jest / nie jest", tag: "ochrona_obowiazkowa" },
    { paragraph: 119, find: "jest/nie jest", tag: "duzy_przedsiebiorca" },
    // --- Rozliczenie ---
    { paragraph: 54, find: "m.pawlak@autobielany.pl", tag: "email_cma" },
    { paragraph: 67, find: "150", tag: "stawka_patrol" },
    { paragraph: 67, find: "sto pięćdziesiąt złotych", tag: "stawka_patrol_slownie" },
    { paragraph: 101, find: "1900", tag: "abonament" },
    { paragraph: 101, find: "jeden tysiąc dziewięćset złotych", tag: "abonament_slownie" },
    { paragraph: 103, find: "m.pawlak@autobielany.pl", tag: "email_faktura" },
    // --- Osoby kontaktowe Zleceniodawcy (akapity 194–197 mają identyczną treść,
    //     więc indeks akapitu jest jedynym rozróżnieniem) ---
    { paragraph: 194, find: KROPKI, occurrence: 0, expectedCount: 2, tag: "kontakt1_nazwa" },
    { paragraph: 194, find: KROPKI, occurrence: 1, expectedCount: 2, tag: "kontakt1_telefon" },
    { paragraph: 195, find: KROPKI, tag: "kontakt1_email" },
    { paragraph: 196, find: KROPKI, occurrence: 0, expectedCount: 2, tag: "kontakt2_nazwa" },
    { paragraph: 196, find: KROPKI, occurrence: 1, expectedCount: 2, tag: "kontakt2_telefon" },
    { paragraph: 197, find: KROPKI, tag: "kontakt2_email" },
  ],
};

// ---------------------------------------------------------------------------
// Umowa powierzenia przetwarzania danych osobowych (RODO) — Alfa Group
// ---------------------------------------------------------------------------

/**
 * CO JEST TU INNEGO NIŻ W ZDW.
 *
 * 1. BLOK POWIERZAJĄCEGO TO PUSTE AKAPITY (4–12). W oryginale nie ma tam
 *    żadnej frazy do podmiany — handlowiec wklejał dane kontrahenta w puste
 *    linie. Tagi wstawiamy więc `emptyTags`, po jednym w akapity 5, 6 i 7
 *    (nazwa / adres z NIP-em / reprezentacja), dokładnie tam, gdzie kończyły
 *    się one w wypełnionych umowach (20260701 AutoBielany, 20260107 ODYSSEY).
 *    Pozostałe puste akapity zostają puste — to odstępy przed „zwaną dalej
 *    Powierzający”.
 *
 * 2. TA SAMA DATA W KILKU MIEJSCACH. `data_umowy` idzie w nagłówek i w oba
 *    załączniki (akapity 3, 115, 148), a `data_umowy_glownej` w preambułę
 *    i w § 1 (25, 31) — docxtemplater wstawia jedną wartość w każde wystąpienie.
 *
 * 3. MIASTO ZAWARCIA ZOSTAJE WPISANE („w  Warszawie”). Umowę powierzenia
 *    podpisuje się w siedzibie Przetwarzającego, a ta jest częścią wzoru tak
 *    samo jak nagłówek i stopka.
 *
 * 4. DANE ALFA GROUP (akapity 17, 19, 21) NIE SĄ TAGOWANE — szablon należy do
 *    spółki, więc jej KRS, NIP i reprezentant są treścią dokumentu.
 *
 * 5. LINIE PODKREŚLEŃ w załącznikach (127–129, 139–141, 145, 152–156) zostają
 *    bez tagów: to miejsce na wpisy odręczne przy podpisywaniu.
 */
const RODO: TemplateTagSpec = {
  key: "rodo",
  label: "Umowa powierzenia danych osobowych (RODO) — Alfa Group",
  defaultIn: "obiekty/Aktualne Drafty 05.2023/ALFA G/Umowa_powierzenia_danych_osobowych.docx",
  defaultOut: "templates/umowy/rodo-alfa-group.docx",
  paragraphCount: 163,
  expectedText: {
    3: "Zawarta dnia ………….r., w  Warszawie, pomiędzy: ",
    // Akapity 4–12 są puste; 13 jest kotwicą bloku Powierzającego.
    13: "zwaną dalej ,,Powierzający’’ ",
    25: "Strony zawarły w dniu …………………………………………. r., Umowę o świadczenie usługi zdalnego dozoru wideo (zwaną dalej „Umową główna”),",
    31: "Umowy o świadczenie usługi zdalnego dozoru wideo z dn. ……………………………… r.,",
    115: "Załącznik nr 1  do umowy powierzenia danych osobowych zawartej w dniu ………………………………… r.,",
    148: "Załącznik nr 2 do umowy powierzenia danych osobowych zawartej w dniu …………………………………… r.",
  },
  tags: [
    { paragraph: 3, find: KROPKI, tag: "data_umowy" },
    { paragraph: 25, find: KROPKI, tag: "data_umowy_glownej" },
    { paragraph: 31, find: KROPKI, tag: "data_umowy_glownej" },
    { paragraph: 115, find: KROPKI, tag: "data_umowy" },
    { paragraph: 148, find: KROPKI, tag: "data_umowy" },
  ],
  emptyTags: [
    { paragraph: 5, tag: "powierzajacy_nazwa" },
    { paragraph: 6, tag: "powierzajacy_adres" },
    { paragraph: 7, tag: "powierzajacy_reprezentacja" },
  ],
};

runTagger([ZDW, RODO]);
