---
name: commit
description: "Version-aware git commit workflow with two modes: `/commit` (or `/commit here`) commits only changes from the current conversation; `/commit all` commits all working tree changes, analyzing diffs to generate descriptions. Both modes bump the version, add a Polish changelog entry for the „Co nowego” page, and create a structured commit."
user_invocable: true
---

# Commit z podbiciem wersji

Każdy commit w tym repo przechodzi przez ten workflow: podbicie wersji, wpis w
changelogu („Co nowego”) i commit z ustaloną strukturą wiadomości.

## Workflow

### 1. Wybierz tryb

Na podstawie argumentów wywołania:
- **`/commit`** albo **`/commit here`** → tryb „commit here” (domyślny)
- **`/commit all`** → tryb „commit all”

---

### 2a. Tryb „commit here” (domyślny)

Bierzesz pod uwagę tylko zmiany zrobione w bieżącej rozmowie:

- Uruchom `git status` (nigdy `-uall`), `git diff` + `git diff --staged`,
  `git log --oneline -5`
- Wskaż pliki, które były ruszane/omawiane w tej sesji
- Wykorzystaj kontekst rozmowy, żeby zrozumieć intencję i napisać wiadomość commita
- Zastaguj wyłącznie pliki związane z tym, co zrobiono w tej sesji

Przejdź do **kroku 3**.

---

### 2b. Tryb „commit all”

Analizujesz WSZYSTKIE zmiany w drzewie roboczym:

- `git status` (nigdy `-uall`) — wszystkie zmienione i nieśledzone pliki
- `git diff` i `git diff --staged` — przeczytaj diff każdego zmienionego pliku
- `git log --oneline -5` — kontekst ostatnich commitów
- Pogrupuj zmiany po modułach (kadry, cma, technical, handlowy, zlecenia,
  magazyn, kalendarz, oferty, umowy, admin, shared…)
- Napisz opis całości na podstawie diffów

**Gdy cokolwiek jest niejasne** (nieznany cel zmiany, nieoczekiwane pliki,
pomieszane niepowiązane wątki):
- Dopytaj przez AskUserQuestion, zanim ruszysz dalej
- Pytaj o intencję niejasnych zmian albo o to, czy dany plik ma wejść do commita

Zastaguj właściwe pliki, podając konkretne ścieżki (nigdy `git add -A`).

Przejdź do **kroku 3**.

---

### 3. Odczytaj bieżącą wersję

Przeczytaj `frontend/src/lib/version.ts` i wyciągnij wersję z:
```ts
export const APP_VERSION = 'X.Y.Z'
```

Format: standardowy SemVer (`X.Y.Z`), bez zer wiodących. Segmenty nie mają
limitu cyfr (`1.101.899` jest poprawne).

### 4. Zapytaj o rodzaj podbicia

Pokaż bieżącą wersję i zapytaj:
- **patch** (1.2.1 → 1.2.2) — poprawki, drobne zmiany, kosmetyka (domyślna rekomendacja)
- **minor** (1.2.2 → 1.3.0) — nowe funkcje, rozbudowa modułu
- **major** (zarezerwowane — tylko kamień milowy, np. 2.0.0)

Domyślna rekomendacja: patch.

### 5. Zaktualizuj pliki z wersją

Dwa miejsca, zawsze razem:
- `frontend/src/lib/version.ts` — `export const APP_VERSION = 'X.Y.Z'`
- `package.json` w katalogu głównym repo — pole `"version"`

(`frontend/package.json` zostaje na `0.0.0` — to prywatny pakiet builda, nie
wersja aplikacji.)

### 6. Napisz wpis do changelogu

Wpis trafia na stronę „Co nowego” (`/co-nowego`), a dane bierze z
`frontend/src/lib/updates.ts`.

**Gdzie wpis fizycznie trafia:** na początek tablicy `UPDATES_CURRENT`
w `frontend/src/lib/updates.ts`. Pliki roczne (`frontend/src/lib/updates.YYYY.ts`,
np. `updates.2026.ts`) to zamknięta historia — nie dopisuje się do nich przy
zwykłym commicie. Gdy `UPDATES_CURRENT` urośnie ponad ~30 kart albo zmieni się
rok, przenieś nagromadzone wpisy na górę pliku rocznego odpowiadającego ich
datom (zakładając nowy plik `updates.YYYY.ts` + eksport w barrelu, jeśli
trzeba) i wyczyść `UPDATES_CURRENT`. Kolejność w `UPDATES` zawsze:
najnowsze pierwsze.

Jak pisać:

1. Przeanalizuj zmiany z tego samego diffa, z którego powstaje commit
2. Napisz 1–4 krótkie wpisy po polsku — o tym, co widzi UŻYTKOWNIK, nie o
   bebechach
3. Przypisz typ do każdego wpisu: `feat`, `fix`, `tweak`, `style`
4. Przypisz **moduł** do każdego wpisu — pole `module` jest WYMAGANE, wartość
   z listy `ogolne | analityka | kadry | cma | handlowy | techniczny | ofi`
   (patrz „Przypisanie modułu” niżej)
5. **Zawsze pokaż propozycję użytkownikowi** przez AskUserQuestion z opcjami:
   - **zatwierdź** — dopisz na początek `UPDATES_CURRENT`
   - **popraw** — użytkownik podaje korekty, potem dopisz
   - **pomiń** — nie ruszaj `updates.ts` (tylko zmiany czysto wewnętrzne)
6. Po zatwierdzeniu/poprawce sprawdź, czy **pierwsza karta** w `UPDATES_CURRENT`
   ma **dzisiejszą datę**:
   - **Ten sam dzień:** dopisz nowe punkty do jej `entries` i rozszerz zakres
     wersji półpauzą (`'1.2.0'` → `'1.2.0–1.2.1'`, `'1.2.0–1.2.1'` →
     `'1.2.0–1.2.2'`). Zostaw dotychczasowy `title`, chyba że nowa zmiana jest
     wyraźnie ważniejsza
   - **Inny dzień:** dopisz nowy obiekt `VersionUpdate` na początek tablicy —
     nowa wersja, dzisiejsza data, opcjonalny `title`, `entries`
7. Zastaguj `updates.ts` razem z `version.ts` i `package.json` w kroku commita

**Przypisanie modułu** (`module`, jedna wartość na wpis — gdy zmiana dotyka
kilku modułów, rozbij ją na osobne wpisy albo daj `ogolne`):
- `kadry` — sekcja Kadry i kartoteka firmy: godziny, wynagrodzenia, pracownicy,
  normy, działy, a także kontrahenci, obiekty, umowy, spółki, handlowcy jako
  kartoteka i zlecenia ZDW (lista, karta zlecenia, formularz, maile ze zlecenia)
- `cma` — sekcja CMA: raporty, trendy, braki/awarie kamer, grupy interwencyjne,
  obiekty CMA, ustawienia CMA
- `techniczny` — sekcja Techniczny: kalendarz techniczny, magazyn, oferty,
  usługi, manuale, projekty i designer monitoringu, szablony, realizacje
- `handlowy` — sekcja Handlowy: leady i lejek, kontakty, pulpit, aktywności,
  kalendarz handlowy
- `analityka` — sekcja Analityka (kontrahenci, obiekty, handlowcy)
- `ofi` — sekcja OFI
- `ogolne` — logowanie i konta, menu boczne i nawigacja, panel administratora,
  poczta systemowa, asystent AI, wydajność, wygląd całej aplikacji i zmiany
  przekrojowe dotykające wielu sekcji

Moduł widać przy każdym wpisie na stronie „Co nowego” i po nim działa filtr,
więc źle przypisany moduł znika użytkownikowi z oczu — warto się zastanowić.

Kształt karty:
```ts
{
  version: '1.2.1',
  date: '2026-09-11',
  entries: [
    { text: 'Wiek ceny w magazynie widać na pierwszy rzut oka', type: 'feat', module: 'techniczny' },
    { text: 'Lista leadów nie gubi już filtrów po powrocie z karty', type: 'fix', module: 'handlowy' },
  ],
},
```

**Zasady wpisów:**
- **Nigdy nie pomijaj wersji.** Każdy commit ma wpis — nawet zmiana czysto
  wewnętrzna dostaje przyjazny opis („Usprawnienia pod maską”, „Szybsze
  ładowanie list”)
- **Ton: sucha, sytuacyjna ulga.** Lekkość wpisu ma siedzieć **w samym zdaniu
  opisującym zmianę**, nie w komentarzu doklejonym po myślniku. Bierze się stąd,
  że nazywasz po imieniu żmudną czynność, której użytkownik już nie musi robić:
  „zamiast wystukiwać wszystko od zera”, „zamiast przepisywać z ekranu”, „bez
  dzwonienia do biura”, „koniec szukania w mailach”. To wystarczy — nic więcej
  dopisywać nie trzeba.
  - **Test dopisku:** usuń fragment po myślniku. Jeśli wpis nie stracił żadnej
    informacji, ten fragment był dopiskiem i wylatuje.
  **Zakazane:** puenty doklejone po myślniku, absurd, personifikacja („Outlook
  dostaje dzień wolny”, „lista ma amnezję”, „cena udaje świeżą”, „minus jedna
  kamera w naturze nie występuje”), emotki, memy, żarty kosztem użytkownika
  („w końcu ktoś to zauważył”), ironia wobec klienta i błazenada — to system
  firmowy.
  **Dawkowanie.** Na jedną kartę (`VersionUpdate`) przypadają **najwyżej jeden,
  wyjątkowo dwa lżejsze wpisy**; reszta jest po prostu rzeczowa. Karta z jednym
  albo dwoma wpisami ma co najwyżej jeden lżejszy. Karta całkiem bez lekkości
  jest w porządku. **Tytuły kart:** w większości neutralne i opisowe („Moduł
  Oferty”, „Kalendarz”); jeśli tytuł już jest lżejszy, wpisy w tej karcie
  zostają rzeczowe. Zasada nadrzędna: gdy lekkość zaciemnia, co się zmieniło,
  wygrywa jasność.
  - **Wzorzec (dobrze):** „Godziny na nowy miesiąc można przenieść z poprzedniego
    i tylko je uzupełnić, zamiast wystukiwać wszystko od zera”
  - Na siłę: „Stany liczą się z ruchów, a wydanie poniżej zera jest blokowane –
    minus jedna kamera w naturze nie występuje” →
    dobrze: „Stany liczą się z ruchów, a magazyn nie wyda więcej, niż ma na stanie”
  - Na siłę: „Mail ze zlecenia wychodzi wprost z aplikacji – Outlook dostaje
    dzień wolny” →
    dobrze: „Mail ze zlecenia wychodzi wprost z aplikacji, bez przeklejania
    treści do Outlooka”
  - Na siłę: „Lista leadów przestała mieć amnezję: filtry zostają po powrocie
    z karty” →
    dobrze: „Lista leadów pamięta filtry po powrocie z karty, bez ustawiania ich
    od nowa przy każdym wejściu”
  - Na siłę: „Projekt można zapisać jako nazwaną wersję – «wersja przed uwagami
    klienta» bywa bezcenna” →
    dobrze: „Projekt można zapisać jako nazwaną wersję i wrócić do niej później,
    zamiast odtwarzać wcześniejszy układ po uwagach klienta”
  - Rzeczowo, ale wciąż po ludzku: „Towar w Magazynie zakłada się z zapisanej
    strony sklepu dostawcy, zamiast przepisywać nazwę, cenę, kod i zdjęcie
    z drugiego okna”
- **Piszesz dla pracowników firmy, nie dla programistów.** Opisuj, co człowiek
  zobaczy albo poczuje, nigdy jak to działa pod spodem:
  - **Nigdy nie wymieniaj:** nazw bibliotek i narzędzi (React, Hono, Drizzle,
    FullCalendar, Dokploy, SQLite), nazw komponentów i plików, numerów migracji,
    endpointów API, kluczy uprawnień, nazw kolumn i tabel, protokołów (SSE, SMTP,
    IMAP), skryptów testowych
  - **Funkcje admin-only opisuj przez korzyść dla użytkownika**, nie przez panel
    administratora (np. „Maile ze zleceń wychodzą teraz same” zamiast „Nowa
    zakładka ustawień SMTP w panelu admina”)
  - **Dobrze:** „Wiek ceny w magazynie widać na pierwszy rzut oka” /
    **Źle:** „Dodano lib/price-age.ts z progami 6/12 miesięcy”
  - **Dobrze:** „Zlecenie z formularza od razu zakłada obiekt” /
    **Źle:** „orders.objectId ustawiane w handlerze POST /api/orders”
  - **Dobrze:** „Kalendarz odświeża się sam, gdy ktoś inny doda wydarzenie” /
    **Źle:** „Live przez SSE /api/calendar/live”
  - Zmiany wewnętrzne podsumowuj jako „Usprawnienia pod maską”
- **Pojedyncza wersja** — dokładny ciąg: `version: '1.2.1'`
- **Zgrupowane wersje** — zakres z półpauzą: `version: '1.2.0–1.2.3'`
- **Zwykłe commity:** grupuj tylko ściśle powiązane, następujące po sobie
  poprawki tego samego dnia i tematu. Domyślnie osobna karta na wydanie —
  gęsta lista jest w porządku
- **Backfill / porządkowanie historii:** łącz commity z tego samego dnia w jedną
  kartę, chyba że dotyczą wyraźnie różnych obszarów (funkcja w CMA i funkcja
  w Magazynie tego samego dnia → dwie karty; trzy poprawki Magazynu → jedna).
  Celuj w ~1 kartę na dzień i temat, nie na commit
- `title` dodawaj przy kamieniach milowych (wersje x.0, duże funkcje). Tytuł też
  ma być po ludzku, bez technikaliów. Domyślnie neutralny i opisowy („Moduł
  Oferty”, „Kalendarz”); lżejszy tytuł tylko wyjątkowo, przy naprawdę dużym
  kamieniu milowym, w tej samej suchej konwencji i zawsze z rozpoznawalną nazwą
  modułu („Moduł Handlowy, czyli koniec Excela z leadami”). Wzór z oryginału tej
  praktyki: „Buttons that lied, and words that were never words”

### 7. Napisz wiadomość commita

Ustal, co faktycznie zrobiono, na podstawie:
- **Zmienionych plików** — co doszło, zmieniło się, zniknęło w diffie
- **Kontekstu rozmowy** — czego chciał użytkownik, jaki problem został rozwiązany
- **Zakresu** — który moduł aplikacji dotknięty (kadry, cma, technical,
  handlowy, zlecenia, magazyn, kalendarz, oferty, umowy, admin, shared…)

Tytuł po polsku, zwięzły, odpowiadający na „po co”, nie tylko „co”:
- Dobrze: `feat(magazyn): import towarów ze sklepów dostawców`
- Źle: `zmiany w Warehouse.tsx i api.ts`
- Źle: `poprawki`

Prefiks tytułu to najważniejszy typ zmiany.

### 8. Zastaguj i zacommituj

- Zastaguj zmienione pliki + `frontend/src/lib/version.ts` + `package.json` +
  `frontend/src/lib/updates.ts` (konkretne ścieżki, nigdy `git add -A`)
- Wiadomość przez HEREDOC, format:

```
<typ>(<zakres>): <opis> [vX.Y.Z]

Krótki akapit po polsku: co się zmienia z punktu widzenia pracy z aplikacją
i dlaczego.

- punkt: konkret techniczny (plik, zachowanie, przypadek brzegowy)
- punkt: kolejny konkret
- testy: co doszło albo co przeszło

<linie atrybucji>
```

**Ciało wiadomości** pisz jak dotychczasowe commity w repo (`git log -5`):
po polsku, treściwie, akapit wprowadzający + lista konkretów. W przeciwieństwie
do changelogu tutaj technikalia są wskazane — ciało commita czyta programista.

**Linie atrybucji:** użyj DOKŁADNIE tych linii, które podaje system-reminder
o atrybucji w bieżącej sesji (zwykle `Co-Authored-By:` + `Claude-Session:`).
Gdy w sesji nie ma takiego przypomnienia, użyj:
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

Dostępne typy: `feat`, `fix`, `refactor`, `docs`, `style`, `chore`
Zakres: moduł aplikacji (`kadry`, `cma`, `technical`, `handlowy`, `zlecenia`,
`magazyn`, `kalendarz`, `oferty`, `umowy`, `obiekty`, `admin`, `shared`…)

### 9. Sprawdź

Po commicie uruchom `git status`.

### 10. Zaktualizuj pamięć

Po udanym commicie przejrzyj sesję i oceń, czy coś warto zapisać do auto-pamięci
(`/config/.claude/projects/-config-workspace-programming-alfa-app/memory/`):
- Nowe wzorce, rozwiązania błędów, preferencje w pracy
- Nie czekaj na potwierdzenie w kolejnej sesji — jak coś jest przydatne, zapisz teraz
- Nie duplikuj tego, co już jest w `CLAUDE.md`, `AGENTS.md` albo w istniejących plikach pamięci
- Pomiń, jeśli sesja była trywialna (literówka, drobna konfiguracja)

## Zasady

- Nigdy `git push`, chyba że użytkownik wprost poprosi
- Nigdy `git commit --amend`, chyba że użytkownik wprost poprosi
- Nigdy nie pomijaj hooków
- Nigdy `git add -A` — zawsze konkretne ścieżki
- Nigdy nie commituj sekretów (`.env`, hasła, tokeny, dane dostępowe)
- Nie ruszaj `src/index.ts` (serwer/IMAP), chyba że commit właśnie tego dotyczy
- Gdy hook padnie: napraw, zastaguj ponownie, zrób NOWY commit
