# Audyt uprawnień A — zależności ekranów od kluczy innych modułów

Data: 2026-10-20 · zakres: Techniczny (`technical/*`), Ogólne (objects, contractors, contracts, orders, spolki, handlowcy), Kadry (`kadry/*`, `/hr`), Kalendarz techniczny i jego dialogi.
Poza zakresem (drugi agent): CMA, Handlowy, `/technik`, Analityka. Audyt bez zmian w kodzie.

## Metoda

1. Funkcje z `frontend/src/lib/api.ts` zmapowano skryptem na endpointy, a endpointy na klucze z `API_TAB_MAP` (`src/middleware/auth.ts`), z uwzględnieniem `writeTabs`, bramek w trasach (`canView`/`canEdit` w `src/routes/*.ts`) i `calendar-scope`.
2. Dla każdego pliku z zakresu wypisano wywołania API i porównano wymagany klucz z kluczem, który otwiera ekran (`tabKeyForPath` / `AccessGuard`).
3. Każdego kandydata sprawdzono ręcznie w kodzie: czy wywołanie jest za `canView(...)`, czy błąd jest połykany, czy wspólny `Promise.all` zabiera przy okazji inne dane. Fałszywe trafienia odrzucono (np. `TechnicalObjects` woła `monitoredObjectsApi.getObjects`, nie `/objects`; sekcje Umów/Projektów w `ObjectDetails` są już za `canView`).

## Tabela luk

| # | Prio | Ekran (klucz) | Front plik:linia | Endpoint → wymagany klucz | Skutek |
|---|---|---|---|---|---|
| 1 | **wysoki** | Kalendarz techniczny (`technical/kalendarz`), też Kalendarz handlowy | `components/CalendarEventDialog.tsx:2131` | `GET /objects` → `objects` | wspólny `Promise.all` z `cfg.assignees.load()` (`/technicians`, ten jest OK) → 403 z obiektów zeruje **też listę techników**; błąd połyka `.catch(()=>{})` |
| 2 | **wysoki** | Kadry: Godziny, Działy, Obiekty, Normy, Historia (`kadry/godziny`, `kadry/dzialy`, `kadry/obiekty`, `kadry/normy`, `kadry/historia`) | `pages/Kadry.tsx:497-516` (`getCompanies()` w l. 502) | `GET /companies` → `spolki`/`objects`/`kadry/wynagrodzenia`/`kadry/pracownicy` | `Promise.all` bez `catch` → pracownicy, obiekty kadrowe, umowy, katalog obiektów, działy i „umowy do przedłużenia” puste. Zakładki **Działy** i **Obiekty** dostają puste propsy (`Kadry.tsx:2056`, `:2070`), więc nie działają w ogóle |
| 3 | **wysoki** | Kadry → Wynagrodzenia (`kadry/wynagrodzenia: edit` bez `kadry/godziny`) | `pages/Kadry.tsx:389-390` (`useEditLock` payroll/office), `lib/hrLive.ts:264,362`, `components/kadry/PayrollTab.tsx:495` | `/hr/locks/*` → tylko `HOURS_TABS` (`kadry/godziny` + portale) | trasa (`hr-locks.ts`, `canLockWholeList`) przepuściłaby scope `payroll`/`office` przy `kadry/wynagrodzenia: edit`, ale prefiks w `API_TAB_MAP` zwraca 403 wcześniej. Tryb edycji wymaga `lock.mine` → **płac i rozliczenia biura nie da się edytować**. Do tego `/hr/live` (też tylko `HOURS_TABS`) → brak odświeżania na żywo, a SSE ponawia połączenie z backoffem i dostaje 403 |
| 4 | **wysoki** | Umowy (`contracts`) | `pages/Contracts.tsx:270` (`getObjects`), `:299` (`getContractorCatalog`), select w formularzu `:902` | `GET /objects` → `objects`; `GET /contractors/catalog` → bez `contracts` w `tabs` | select „Obiekt” w formularzu pusty, a `objectId` jest wymagany (`routes/contracts.ts:52`, `nullable:false`), więc **nie da się dodać umowy**. Filtry Kontrahent i Obiekt też puste |
| 5 | **wysoki** | Zlecenia → formularz (`orders`) | `components/OrderForm.tsx:660` (`NIPField` → `NIPField.tsx:188`), `:278` (`getContractorObjects`) | `GET /contractors/by-nip/:nip`, `GET /contractors/:id/objects` → `contractors` | sprawdzenie NIP-u kończy się „Błąd sprawdzania NIP”, a formularz traktuje płatnika jak nowego (`createContractor`). Backend odrzuca zapis: „Contractor with this NIP already exists” (`services/orders.ts`). **Zlecenia dla istniejącego klienta nie da się złożyć**, a obiektów płatnika i tak by nie było widać |
| 6 | średni | Zlecenia → formularz przyjęcia `/orders/formularz` (`orders`) | `components/OrderIntakeForm.tsx:686` | `GET /contractors/by-nip` → `contractors` | gałąź `catch` w `NIPField` pomija `fetchCompany`, więc nie działa też autouzupełnienie z wykazu MF i dane płatnika trzeba wpisać ręcznie |
| 7 | średni | Oferty (`technical/oferty`) | `pages/Oferty.tsx:239-247` (`Promise.allSettled`) | `/warehouse/items`, `/warehouse/stock` → `technical/magazyn`; `/salespeople` → bez `technical/oferty`; `/companies` → bez `technical/oferty` | baner „niedostępne” działa, ale bez magazynu **do oferty nie da się dodać sprzętu**. Bez spółek nie ma stopki z NIP-em na wydruku, bez handlowców nie ma przypisania ani filtra |
| 8 | średni | Oferty, Protokoły (`technical/oferty`, `technical/protokoly`) | `components/offers/OfferEditor.tsx:667`, `components/ProtocolForm.tsx:266` → `components/ContractorPicker.tsx:75` | `GET /contractors?search=` → `contractors` | podpowiedzi kontrahenta puste, w pickerze komunikat 403. Zostaje wpisywanie z ręki, bez NIP-u i miasta |
| 9 | średni | Kalendarz techniczny (`technical/kalendarz`) | `CalendarEventDialog.tsx:816` (protokoły), `:988` (realizacje), `:1140` (wyceny) | `/protocols` → `technical/protokoly`, `/realizations` → `technical/realizacje`, `/quotes` → `technical/wyceny` | pickery „podepnij protokół / realizację / wycenę” są puste (błąd połknięty), więc z kalendarza nie da się powiązać wydarzenia z dokumentem |
| 10 | średni | Techniczny → Realizacje (`technical/realizacje`) | `components/RealizationForm.tsx:234` | `GET /objects` → `objects` | brak wyboru obiektu z kartoteki, zostaje wolny tekst w `site` (komentarz w kodzie to akceptuje, ale realizacja traci powiązanie z obiektem) |
| 11 | średni | Techniczny → Cennik (`technical/cennik`) | `components/pricelist/PriceListTab.tsx:154` | `GET /technicians` → `technical/technicy`/`technical/kalendarz` | lista techników pusta, więc w `AssignTechniciansDialog` nie da się przypisać cennika technikowi (błąd tylko w konsoli) |
| 12 | średni | Kontrahenci (`contractors`) | `pages/Contractors.tsx:269` | `GET /objects` → `objects` | po włączeniu „Rozwiń obiekty” każdy kontrahent pokazuje „Brak obiektów u tego kontrahenta”, co jest **mylące**, bo obiekty istnieją |
| 13 | niski | Kontrahenci (`contractors`) | `pages/Contractors.tsx:261` | `GET /companies` → bez `contractors` | filtr „Spółka” pusty (błąd połknięty) |
| 14 | niski | Zlecenia (`orders`) | `pages/Orders.tsx:180` | `GET /salespeople` → bez `orders` | filtr „Handlowiec” pusty (świadomie połknięte) |
| 15 | niski | Techniczny → Technicy (`technical/technicy` bez `technical/cennik`) | `pages/Technical.tsx:786-794` (`priceListsApi.list`) | `/pricelist` → `technical/cennik` | kolumna „Cennik” pokazuje wszędzie „—”/„Główny”, a select w `TechnicianForm` jest pusty. Wartość nie ginie, bo `formData` trzyma `priceListId`, ale widok wprowadza w błąd |
| 16 | niski | Techniczny → Realizacje (`technical/realizacje` bez technicy/kalendarz) | `pages/Technical.tsx:573`, przekazanie do formularza `:3508` | `/technicians` | brak podpowiedzi (datalist) „Opiekun/Wykonawca”. Pola są wolnym tekstem |
| 17 | niski | Asystent AI w kalendarzu (edytor kalendarza) | `components/assistant/ObjectPeek.tsx:94` | `GET /objects/:id` → `objects` | podgląd obiektu z czatu pokazuje błąd „Brak dostępu do tej sekcji” |
| 18 | niski | Kadry dla kluczy innych niż `kadry/godziny` | `lib/hrLive.ts:112,362`, `components/kadry/MonthStatusBar.tsx` | `/hr/live`, `GET /hr/locks` → `HOURS_TABS`; `/hr/month-status` → bez `kadry/dzialy`/`obiekty`/`normy` | szum 403 (SSE ponawia z backoffem), brak paska stanu miesiąca. Funkcjonalnie drobne, przy okazji #3 warto domknąć |

### Znalezisko poboczne (bezpieczeństwo, nie brak dostępu)

| # | Prio | Gdzie | Problem |
|---|---|---|---|
| S1 | **wysoki** | `src/middleware/auth.ts`, wpis `{ prefix: "/technicians", tabs: ["technical/technicy", "technical/kalendarz"] }` bez `writeTabs`; `src/routes/technicians.ts` nie ma własnej bramki | `maxLevel()` liczy zapis z obu kluczy, więc **`technical/kalendarz: edit` pozwala tworzyć, edytować i usuwać techników** (POST/PUT/DELETE `/technicians`), także pole `userId` (powiązanie z kontem panelu technika). Poprawka: `writeTabs: ["technical/technicy"]`, tak jak przy `/salespeople` i `/companies` |

## Proponowane poprawki (per luka)

### #1, #4, #10, #12, #17: wspólny słownik obiektów `GET /objects/catalog`
- Trasa w `src/routes/objects.ts`, zarejestrowana **przed** `GET /:id`. Oparta na `fetchObjectCatalog()` z `src/lib/object-catalog.ts`, rozszerzonym o `address`, `contractorId` i `status`. Opcjonalny filtr `?contractorId=` przyda się w #5.
- Wpis w `API_TAB_MAP` **przed** `"/objects"`: `{ prefix: "/objects/catalog", tabs: ["objects","technical/kalendarz","handlowy/kalendarz","contracts","technical/realizacje","orders","contractors"], writeTabs: ["objects"] }`.
- Front: `CalendarEventDialog`, `Contracts`, `RealizationForm` i rozwinięcie w `Contractors` przechodzą z `getObjects({pageSize:1000})` na katalog. Picker w dialogu używa tylko `name/address/city/contractor.name`, więc katalog wystarcza.
- **Dodatkowo w #1:** rozdzielić `Promise.all`, żeby technicy ładowali się niezależnie od obiektów (osobne `.then/.catch`).
- **Wyciek:** `GET /objects` zwraca `monthly_zdw/ofi/rental`, `monthly_cost`, `setup_cost` i usługi z kwotami. **Nie** dopisywać nowych kluczy do `/objects`, tylko katalog bez kwot. W #12 (Kontrahenci) rozwinięcie pokazuje kwoty per obiekt. Ekran Kontrahentów i tak pokazuje sumy wartości/kosztów, ale jeśli kolumny kwot w rozwinięciu mają zostać, lepszy jest dedykowany `GET /contractors/objects-summary` pod prefiksem `/contractors` (te same pola, które rysuje tabela) zamiast otwierania `/objects`.
- #17 (ObjectPeek): albo ukryć podgląd bez `canView("objects")`, albo karmić go z katalogu (nazwa, adres, kontrahent).

### #2: Kadry, słowniki
- `pages/Kadry.tsx:497`: `Promise.allSettled` albo osobny `getCompanies().catch(() => ({data: []}))`, wzorem `Oferty.tsx`.
- Opcjonalnie dopisać `...HR_TABS` do `tabs` wpisu `/companies` (`writeTabs` zostaje `["spolki"]`). Spółki to dane własnych spółek (NIP, adres, narzuty składek), bez danych osobowych i bez kwot wypłat, więc ryzyko jest niskie.

### #3, #18: Kadry, rezerwacje i SSE
- `/hr/locks`: `tabs` i `writeTabs` = `[...HOURS_TABS, "kadry/wynagrodzenia"]`. Właściwą kontrolę per scope i tak robi `canLockWholeList` (`FULL_SCOPE_TAB`: payroll/office → `kadry/wynagrodzenia`, hours → `kadry/godziny`). Sekcja działowa nadal rezerwuje tylko swoje wiersze godzin.
- `/hr/live`: `tabs: [...HR_TABS, ...HOURS_PORTAL_TABS]`, `writeTabs: []`. Strumień niesie sam sygnał bez danych, więc otwarcie jest bezpieczne.
- `/hr/month-status`: można dopisać resztę `HR_TABS` do odczytu (sam status miesiąca).
- Test regresji: user `{"kadry/wynagrodzenia":"edit"}` robi `POST /hr/locks/acquire` z `scope=payroll` → 200, a z `scope=hours` → 403.

### #5, #6: Zlecenia, płatnik
- Wpis `{ prefix: "/contractors/by-nip", tabs: ["contractors","orders"], writeTabs: ["contractors"] }` przed `"/contractors"`. W trasie (`routes/contractors.ts:20`) dla użytkownika bez `canView("contractors")` zwracać **zawężony** rekord (`id, name, nip, address, city, postalCode, exists`) zamiast `select()` całego wiersza (notatki, opiekun, kontakty).
- Obiekty płatnika: `GET /objects/catalog?contractorId=` (patrz wyżej). `latestAction` w `OrderForm` jest ozdobą i można go pominąć albo dodać do katalogu tylko typ ostatniej akcji.
- `OrderForm.tsx:381` (`getObject` → podgląd usług obiektu) przy zleceniu powiązanym z obiektem również dostaje 403. Błąd jest połknięty i podgląd znika. Usługi obiektu zawierają okresy, ale **nie** dopisywać `orders` do `/objects`. Można dodać lekkie `GET /orders/object-services/:objectId` albo pola `services` w katalogu przy `?withServices=1`.
- `NIPField`: w gałęzi `catch` dalej wołać `fetchCompany` (MF), bo błąd bazy nie powinien blokować wykazu. Poprawia też #6.

### #7: Oferty
- **Nie** dopisywać `technical/oferty` do `/warehouse`: tam są `purchasePrice`, dokumenty PZ/WZ i faktury. Zamiast tego `GET /offers/catalog/items` (towary + stany + `salePrice`), z `purchasePrice` wycinanym przez istniejący `redactCosts` / `canView("technical/oferty-koszty")` (wzór: `services.ts:139`).
- Handlowcy: **nie** dopisywać `technical/oferty`/`orders` do `/salespeople`, bo odpowiedź zawiera `monthlyCost`, `commissionRate` i agregaty portfela (`objectsMonthlyValue/Cost`, `objectsSetupCost`). Zamiast tego nowy `GET /salespeople/catalog` (id, imię, nazwisko, `active`, `userId`) z wpisem przed `/salespeople`: `tabs: [..., "technical/oferty", "orders"]`, `writeTabs: ["handlowcy"]`. Naprawia też #14.
- Spółki: `technical/oferty` dopisać do `tabs` `/companies` (ryzyko niskie, j.w.).

### #8: ContractorPicker
- Przełączyć `ContractorPicker` na `/contractors/catalog` z wyszukiwaniem po stronie serwera (`?search=`, limit). Katalog rozszerzyć o `city`, `address`, `postalCode`, bo picker uzupełnia NIP i miasto (`ProtocolForm.tsx:266-272`). W `tabs` katalogu dopisać `contracts`, `technical/oferty`, `technical/protokoly`, `technical/wyceny`. Dane firm z rejestru (NIP/adres) nie są wrażliwe, a katalog nie zwraca agregatów kwot (lista `/contractors` je ma).

### #9: pickery dokumentów w kalendarzu
- Lekkie trasy pod prefiksem `/calendar` (bramka kalendarza + `calendar-scope`, tylko dział techniczny): `GET /calendar/pick/protocols?q=`, `/calendar/pick/quotes?q=`, `/calendar/pick/realizations?y=&m=`. Zwracają wyłącznie `id`, numer, datę i klienta/obiekt.
- **Wyciek:** pełne `/quotes` mają kwoty wycen, `/realizations` mają `hourlyCost`, `actualHours/Km` i koszty. Nie dopisywać `technical/kalendarz` do tych prefiksów.

### #11: Cennik → technicy
- Dopisać `technical/cennik` do `tabs` `/technicians` **razem z** `writeTabs: ["technical/technicy"]` (patrz S1). Technik ma telefon, e-mail i NIP podwykonawcy, czyli dane kontaktowe (niewielka wrażliwość). Ostrożniejsza wersja: `GET /pricelist/technicians-catalog` (id, nazwisko, `priceListId`).

### #13, #15, #16: drobne
- #13: dopisać `contractors` do `tabs` `/companies` (ryzyko niskie).
- #15: dopisać `technical/technicy` do odczytu `/pricelist` przez wąski `GET /pricelist/lists` (id, nazwa, `active`), bez pozycji i cen. Alternatywnie ukryć kolumnę bez `canView("technical/cennik")`.
- #16: dopisać `technical/realizacje` do odczytu `/technicians` (po S1 zapis i tak zostaje przy `technical/technicy`).

## Sprawdzone i OK (bez luk)

- `ObjectDetails`: sekcje Umowy (`canView("contracts")`), Projekty CCTV (`technical/projekty`), Grupy interwencyjne i kalendarz obiektu są za `canView`. `/contacts`, `/history/object` i `/activity/object` mają `objects` w `tabs`.
- `Objects` / `ObjectForm`: katalog kontrahentów, handlowcy i spółki mają `objects` w `tabs`.
- `Monitoring`: własny `/monitoring/pick/objects`, a „Wyceń” jest za `canEdit("technical/oferty")`.
- `Manuals`: własne pick-endpointy. `Uslugi`, `Templates`, `Warehouse` i `Spolki` nie mają zależności spoza swojego klucza.
- `Salespeople`, `Technical` (Technicy): `/hr/directory` ma `handlowcy` i `technical/technicy`.
- `DeptHours` (portale): wszystkie trasy godzin mają `HOURS_PORTAL_TABS`.
- `EmployeeHistory` / `EntityHistory`: render za `canView("kadry/historia")`. Fetch leci przed bramką, ale bez skutku.
- Kalendarz: kopiowanie notatki do obiektu za `canEditTab("objects")`, tak samo jak w trasie. `/company/travel` i `/activity/recent` mają `technical/kalendarz`. Sugestia obiektu z `.msg` jest świadomie pusta bez `objects` (`calendar.ts:752`).
- `Technical.tsx` pobiera realizacje i podsumowanie przy montażu niezależnie od zakładki. 403 ląduje tylko w konsoli i nie wpływa na inne zakładki.

## Do przekazania drugiemu agentowi (Handlowy)

- Kalendarz handlowy ma `objectPicker: true` (`lib/calendar-config.ts:204`), więc luka #1 dotyka też handlowców bez `objects`. Poprawka przez `/objects/catalog` z `handlowy/kalendarz` (i `handlowy/leady`?) w `tabs`.
- `CalendarPage.tsx:2485` (`activityApi.recent`) ma bramkę `technical/kalendarz` w `routes/activity.ts:87`, więc w kalendarzu handlowym da 403, jeśli jest tam wołane.

## Status napraw — paczka „Kadry / Zlecenia / Oferty / CMA” (2026-10-20)

Test: `npx tsx scripts/test-on-copy.ts scripts/test-perms-audit.ts` (47 asercji, in-process z prawdziwym `tabPermissionGuard`).
Luki #1, #4, #9, #10 i S1 robi druga paczka (`/objects/catalog`, `/salespeople/catalog`, dialog kalendarza, Umowy, Realizacje); tu nie są opisane.

| # | Status | Co zrobiono |
|---|---|---|
| 2 | naprawione | `Kadry.tsx` `loadDictionaries` na `Promise.allSettled` (każdy słownik osobno). `/companies` czytają wszystkie `HR_TABS`. Pole `objectsMonthlyValue` w `GET /companies` zostaje tylko dla `spolki`/`objects` |
| 3 | naprawione | `/hr/locks`: `tabs`/`writeTabs` = `HOURS_TABS + kadry/wynagrodzenia`. O tym, kto może wziąć który scope, nadal decyduje `canLockWholeList` (płace nie wezmą godzin, jest na to test) |
| 5 | naprawione | wpis `/contractors/by-nip` (`contractors`, `orders`; zapis tylko `contractors`). Bez `canView("contractors")` trasa oddaje zawężony rekord (id, nazwa, NIP, adres, miasto, kod, active). Obiekty płatnika: `GET /orders/payer-objects/:contractorId` (id, nazwa, adres, miasto, status, bez kwot). Podgląd usług: `GET /orders/object-services/:objectId` zamiast `getObject`. `OrderForm` przełączony |
| 6 | naprawione | `NIPField`: w gałęzi `catch` wykaz MF (`fetchCompany`) leci dalej |
| 7 | naprawione | `GET /offers/catalog/items` (nazwa, sku, producent, jednostka, `effectiveSalePrice`, bez `purchasePrice` i marży) oraz `GET /offers/catalog/stock` (stan zsumowany po towarze), oba pod kluczem ofert. Handlowców bierze `getSalespeopleCatalog` (z drugiej paczki), spółki `/companies` (dopisane `technical/oferty`). Do `/warehouse` nie dopisano żadnego klucza |
| 8 | naprawione | `GET /contractors/pick?q=&limit=` (dane rejestrowe), wpis w mapie: `contractors`, `technical/oferty`, `technical/protokoly`, `technical/wyceny`. Przełączony na nią `ContractorPicker` (typ `ContractorPick`) |
| 11 | naprawione | `GET /pricelist/technicians` (id, imię, nazwisko, firma, active, `priceListId`, bez kontaktów i NIP-u). `PriceListTab` i `AssignTechniciansDialog` używają typu `PriceListTechnician`. Wpisu `/technicians` nie ruszano (to S1 w drugiej paczce) |
| 12 | naprawione | przełącznik „Widok rozwinięty” w Kontrahentach widać tylko z `canView("objects")`. Rozwinięcie pokazuje kwoty abonamentów, więc `/objects` celowo zostaje zamknięte |
| 13 | naprawione | `/companies` ma w `tabs` także `contractors` |
| 14 | naprawione | `Orders.tsx` filtr handlowca z `getSalespeopleCatalog` |
| 15 | naprawione | wpis `/pricelist/lists` (`technical/cennik`, `technical/technicy`; zapis tylko cennik). Nazwy cenników bez pozycji i cen |
| 16 | naprawione | `GET /realizations/technician-names` (same nazwiska aktywnych). `Technical.tsx` sięga po nią, kiedy pełna lista techników jest pusta |
| 17 | odłożone | podgląd obiektu w asystencie pokazuje „Brak dostępu do tej sekcji”, czyli prawdę. Asystent jest dla wąskiej grupy, a pełny podgląd (usługi, kontrahent, wydarzenia) wymagałby osobnego endpointu |
| 18 | naprawione | `/hr/live`: `HR_TABS + HOURS_PORTAL_TABS` (sam sygnał). `/hr/month-status`: odczyt dla całego `HR_TABS + HOURS_PORTAL_TABS`, zapis bez zmian (`kadry/wynagrodzenia`) |

## Status napraw — paczka „katalogi i pickery” (2026-10-20)

Test: `npx tsx scripts/test-on-copy.ts scripts/test-catalog-perms.ts` (63 asercje, prawdziwy `tabPermissionGuard`).

| # | Status | Co zrobiono / dlaczego odłożone |
|---|---|---|
| 1 | **naprawione** | `GET /objects/catalog` (`src/routes/objects.ts`, zapytanie `fetchObjectPickCatalog` w `src/lib/object-catalog.ts`): id, nazwa, adres, miasto, status, `contractorId`, `contractor{id,name}`, bez kwot, opcjonalny `?contractorId=`. Wpis w `API_TAB_MAP` przed `/objects`: objects, technical/kalendarz, handlowy/kalendarz\|leady\|pulpit\|aktywnosci, contracts, orders, technical/realizacje, contractors; `writeTabs: ["objects"]`. `CalendarEventDialog`: technicy/handlowcy (`cfg.assignees.load()`) i obiekty ładują się NIEZALEŻNIE (dwa osobne łańcuchy zamiast `Promise.all`) |
| 4 | **naprawione** | `Contracts.tsx` → `getObjectCatalog()`; `contracts` dopisane do `tabs` `/contractors/catalog` (filtr Kontrahent) |
| 9 | **naprawione** | `GET /calendar/pick/protocols?q=&limit=`, `/calendar/pick/quotes?q=&limit=`, `/calendar/pick/realizations?year=&month=` (`src/lib/calendar-doc-pick.ts`, trasy w `calendar.ts`), tylko dla działu technicznego (`canViewDepartment`). Kształt = skrót, który kalendarz już pokazuje przy podpiętym dokumencie (`CalendarEvent{Protocol,Quote,Realization}`, z sumą netto wyceny/realizacji) + pola identyfikacji. Bez pozycji/cen wycen, bez `hourlyCost`/rzeczywistych godzin/kosztów realizacji, bez pozycji i podpisów protokołów. Pickery w dialogu przepięte na `calendarApi.pick*` |
| 10 | **naprawione** | `RealizationForm.tsx` → `getObjectCatalog()` (`technical/realizacje` w `tabs` katalogu) |
| 12 | bez zmian (już OK) | `Contractors.tsx` chowa „Rozwiń obiekty” bez `canView("objects")` (komentarz przy l. 447). Rozwinięcie pokazuje kwoty per obiekt, więc katalog bez kwot by go nie zastąpił; `contractors` jest w `tabs` katalogu na przyszłość |
| 14 | endpoint gotowy | `GET /salespeople/catalog` ma `orders` w `tabs`; przepięcie `Orders.tsx` należy do paczki Zleceń |
| 7 (handlowcy) | endpoint gotowy | `/salespeople/catalog` ma `technical/oferty` w `tabs`; `Oferty.tsx` należy do paczki Ofert |
| 17 | odłożone | `ObjectPeek` (asystent) nadal woła `GET /objects/:id`; do zrobienia: karmić z katalogu albo chować bez `canView("objects")` |
| S1 | **naprawione** | `/technicians`: `writeTabs: ["technical/technicy"]` — `technical/kalendarz: edit` czyta słownik, ale POST/PUT/DELETE → 403 (test) |
| 11, 16 | odłożone | dopisanie `technical/cennik` / `technical/realizacje` do odczytu `/technicians` — Cennik jest w paczce drugiego agenta; po S1 można to zrobić bez ryzyka zapisu |

Dodatkowo: wszystkie formularze/filtry, które potrzebowały tylko nazwisk handlowców (`ContractorForm`, `ObjectForm`, `Objects`, `Contractors`, `LeadDialog`, `HandlowyLeady`, `calendar-config` SALES_CALENDAR), przepięte z `getSalespeople()` na `getSalespeopleCatalog()`; pełne `/salespeople` zostało wyłącznie przy kluczu `handlowcy` (patrz B #3).

Pułapka: `src/lib/offer-costs.ts` ma KOPIĘ listy `COST_FIELDS` z `src/routes/offers.ts` (plik Ofert był w tym czasie edytowany przez inną paczkę). Docelowo `offers.ts` ma importować `OFFER_COST_FIELDS`/`redactOfferCosts` z lib; do tego czasu zmiany listy robić w OBU miejscach.
