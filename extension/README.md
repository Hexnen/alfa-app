# Alfa — magazyn (wtyczka do przeglądarki)

Wtyczka Chrome/Edge (Manifest V3, bez builda — czysty JS) dokładająca na stronach
obsługiwanych sklepów dostawców panel „Dodaj do towarów Alfa”.

## Instalacja

Paczkę ZIP pobiera się z aplikacji: **Techniczny → Magazyn → zakładka Towary →
przycisk „Wtyczka”**. Dalej:

1. Rozpakuj ZIP do **stałego** katalogu (Chrome ładuje wtyczkę z dysku przy
   każdym starcie — po usunięciu katalogu przestanie działać).
2. Wejdź na `chrome://extensions` (Edge: `edge://extensions`).
3. Włącz **Tryb dewelopera**.
4. **Załaduj rozpakowane** → wskaż rozpakowany katalog.
5. Wejdź na stronę produktu w obsługiwanym sklepie — w prawym górnym rogu
   pojawi się panel.

Paczka zawiera Twój osobisty token — nie przekazuj jej innym. Zmiana hasła oraz
wygenerowanie nowego tokenu w Magazynie unieważniają starą paczkę (trzeba pobrać
nową).

## Jak to działa

- `content-shop.js` — panel w Shadow DOM na stronie sklepu. Po wejściu na stronę
  pyta service worker o `lookup` (czy ten adres jest już w kartotece) i pokazuje
  status: „Masz w Alfa: … — cena z …” albo „Nowy towar dla Alfa”.
  - **„Dodaj do towarów Alfa” / „Aktualizuj w Alfa: …”** — wysyła HTML strony
    i przełącza przeglądarkę na już otwartą kartę Alfa z panelem importu
    (nowa karta tylko wtedy, gdy żadnej nie ma).
  - **„Dodaj do kolejki (n)”** — zostawia Cię w sklepie, towar czeka w sekcji
    „Do dodania z wtyczki” w Magazynie (wpisy wygasają po 7 dniach).
  - **Zalogowanie w sklepie** — panel sprawdza markery z `shops.js` (te same
    wagi co backendowa heurystyka `src/lib/shop-import/login.ts`). Zalogowany:
    dyskretne „✓ Zalogowany w sklepie”. Niezalogowany: żółte ostrzeżenie, że
    ceny będą detaliczne, a przycisk główny zmienia się w „Dodaj mimo to”
    (import nadal możliwy). Brak jednoznacznych sygnałów: panel milczy.
    Po imporcie wynik z backendu (`loggedIn`) nadpisuje detekcję lokalną i przy
    stronie bez logowania dochodzi toast „sprawdź ceny w Alfa”.
- `background.js` — service worker, **jedyne miejsce z `fetch`**. Fetch z content
  scriptu podlegałby CORS strony sklepu, a token nie ma czego szukać w kontekście
  cudzej witryny. Trzyma też licznik kolejki na ikonie (badge).
- `content-app.js` — w samej aplikacji Alfa: przenosi sygnał „otwórz import”
  do Reacta przez `window.postMessage`, żeby nie przeładowywać karty.
- `options.html` / `options.js` — podgląd adresu, użytkownika, zamaskowanego
  tokenu i wersji + „Sprawdź połączenie”.
- Parsowanie strony, dopasowanie do kartoteki i pobranie zdjęcia robi **backend**
  tym samym kodem, co import z zapisanego pliku. Wtyczka jest cienkim klientem.

## Pliki generowane / do pilnowania

- `config.js` — w repo to **wersja przykładowa** (localhost, pusty token).
  Przy pobraniu paczki backend podmienia ten plik na wersję z adresem aplikacji,
  tokenem użytkownika i wersją aplikacji.
- **Build paczki** — `config.js` ma pole `build`: 8-znakowy skrót plików, które
  backend włożył do ZIP-a. Panel pokazuje go w stopce (`v1.4.2 · 3f8ac91b`) i w
  tooltipie przypinacza, a gdy `pluginBuild` z `/plugin/lookup` (albo
  `/plugin/me` w opcjach) jest inny — dopisuje bursztynową linię „Wtyczka
  nieaktualna” i pomarańczową kropkę na przypinaczu. Po buildzie, a nie po
  numerze wersji, bo pliki wtyczki poprawiamy między wydaniami aplikacji.
  Import działa dalej — komunikat informuje, nie blokuje.
- `manifest.json` — `__ALFA_MATCH__` (w `host_permissions` i w `matches` content
  scriptu aplikacji) oraz `version: "0.0.0"` podstawia backend przy pobraniu.
  Wzorce Chrome nie przyjmują portu, więc placeholder to `protokół//host/*`.
- `shops.js` — lustro rejestru parserów `src/lib/shop-import/parsers/registry.ts`.
  Dodanie sklepu = trzy miejsca naraz: `registry.ts`, `shops.js` i `manifest.json`
  (`content_scripts` + `host_permissions`). Parzystość sprawdza
  `scripts/test-plugin-api.ts`.
- `icons/*.png` — render z `scripts/build-plugin-icons.ts` (sharp + inline SVG);
  PNG-i są commitowane, bo paczkę składa backend bez uruchamiania sharpa.
