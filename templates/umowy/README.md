# Szablony umów (DOCX)

Pliki w tym katalogu to **otagowane wzory umów** — oryginalne dokumenty Worda,
w których zmienne fragmenty zostały zastąpione znacznikami `{tag}` czytanymi
przez `docxtemplater`. Generowaniem zajmuje się `src/lib/contract-templates/`,
a zakładką w aplikacji — `src/routes/contract-drafts.ts` (Umowy → Drafty umów).

## `zdw-alfa-group.docx`

| | |
|---|---|
| Źródło | `obiekty/Aktualne Drafty 05.2023/ALFA G/Aktualna Umowa Draft Tylko ZDW.docx` (katalog `obiekty/` jest w `.gitignore`) |
| Spółka | ALFA (Alfa Group Sp. z o.o.) — nagłówek, stopka, koncesja i dane rejestrowe są wpisane w dokument |
| Liczba tagów | 29 |

Odtworzenie z oryginału:

```bash
PATH=/config/.nvm/versions/node/v22.22.0/bin:$PATH \
npx tsx scripts/umowy/tag-docx-template.ts \
  --in "obiekty/Aktualne Drafty 05.2023/ALFA G/Aktualna Umowa Draft Tylko ZDW.docx" \
  --out templates/umowy/zdw-alfa-group.docx --verify
```

Mapa tagów (indeksy akapitów, frazy do podmiany, rozpakowywane hiperłącza) siedzi
w `scripts/umowy/tag-docx-template.ts`, a sam silnik tagowania w
`scripts/umowy/docx-tagger.ts` (wspólny dla wszystkich wzorów). `--verify` renderuje szablon próbnymi wartościami i sprawdza,
że nie został ani jeden nawias klamrowy, każdy tag występuje dokładnie raz, XML jest
parsowalny, a zestaw plików w archiwum zgadza się z oryginałem.

Skrypt robi przy okazji dwie rzeczy pod podgląd w aplikacji:

* **usuwa wszystkie `<w:highlight>`** — w oryginale ktoś ręcznie zakreślił żółtym
  miejsca do uzupełnienia (14 × żółty, 7 × biały). Teraz koloruje je aplikacja
  w podglądzie, a plik dla klienta ma być czysty. `<w:shd>` (białe tło) zostaje;
* **daje każdemu `{tagowi}` własny `<w:r>`** (z kopią `<w:rPr>` pierwotnego runu),
  bo `w:highlight` jest własnością całego runu — inaczej podświetlenie pola
  objęłoby pół akapitu. `--verify` pilnuje obu rzeczy.

## `rodo-alfa-group.docx`

| | |
|---|---|
| Źródło | `obiekty/Aktualne Drafty 05.2023/ALFA G/Umowa_powierzenia_danych_osobowych.docx` |
| Spółka | ALFA (Alfa Group Sp. z o.o.) — dane rejestrowe Przetwarzającego są wpisane w dokument |
| Liczba tagów | 5 (w 8 miejscach: daty powtarzają się w załącznikach) |

Umowa powierzenia przetwarzania danych osobowych (art. 28 RODO) — podpisywana
razem z umową ZDW i odsyłająca do jej daty.

```bash
PATH=/config/.nvm/versions/node/v22.22.0/bin:$PATH \
npx tsx scripts/umowy/tag-docx-template.ts --template rodo --verify
```

Dwie rzeczy, których nie ma w ZDW:

* **blok Powierzającego to PUSTE akapity** (4–12 w oryginale) — nie ma tam frazy
  do podmiany, więc skrypt tworzy w akapitach 5, 6 i 7 nowe runy z `{tagami}`
  (nazwa / adres z NIP-em / reprezentacja), kopiując formatowanie ze znacznika
  akapitu. Reszta pustych akapitów zostaje pusta — to odstępy;
* **ta sama data w kilku miejscach**: `{data_umowy}` w nagłówku i w obu
  załącznikach, `{data_umowy_glownej}` w preambule i w § 1.

Miasto zawarcia („w  Warszawie”) i dane Alfa Group zostają wpisane w dokument —
wzór należy do spółki. Linie podkreśleń w załącznikach zostają bez tagów: to
miejsce na wpisy odręczne.

Numer umowy nie wchodzi do treści, ale rejestr draftów i tak go nadaje —
z WŁASNEJ SERII `seq/RODO/rok` (`ContractTemplateDef.numberCode`), żeby umowy
RODO nie zjadały numerów umowom ZDW.

## NIE OTWIERAĆ I NIE ZAPISYWAĆ TYCH PLIKÓW W WORDZIE

Word tnie tekst na „runy” (`<w:r>`) po własnych regułach i przy zapisie potrafi
rozbić `{tag}` na kilka `<w:t>` — docxtemplater przestanie go wtedy widzieć, a wzór
wyjdzie do klienta z gołym `{abonament}` w treści. Każda zmiana wzoru idzie tak:

1. popraw **oryginał** w `obiekty/…` (albo dostań nową wersję od firmy),
2. w razie potrzeby zaktualizuj mapę tagów w `scripts/umowy/tag-docx-template.ts`
   (skrypt asertuje liczbę akapitów i dokładną treść tych, w które wchodzi — przy
   nowej wersji dokumentu powie wprost, co się nie zgadza),
3. uruchom skrypt z `--verify` i podmień plik tutaj.

## Dodanie kolejnego szablonu

1. Dopisz mapę tagów (`TemplateTagSpec`) w `scripts/umowy/tag-docx-template.ts`
   i uruchom skrypt z `--template <klucz> --verify`.
2. Dopisz definicję do `src/lib/contract-templates/` (pola, grupy, prefill; wspólne
   formatowanie danych z kartoteki jest w `shared.ts`) i wpisz ją do
   `CONTRACT_TEMPLATES` w `registry.ts`.
3. Zdecyduj o numeracji: bez `numberCode` dokument wchodzi w serię spółki,
   z `numberCode` dostaje własną (kolumna `contract_drafts.number_code`).

Szablon jest przywiązany do spółki: nagłówek, stopka i numer koncesji są częścią
dokumentu, więc wariant dla innej spółki grupy to **osobny otagowany plik**, a nie
kolejne pole w formularzu.
