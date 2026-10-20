# Audyt uprawnień B — CMA, Handlowy, Analityka, /technik, Dashboard

Data: 2026-10-20. Tylko audyt (bez zmian w kodzie). Zakres: ekrany i wspólne komponenty
CMA, Handlowego (w tym kalendarz handlowy na `SALES_CALENDAR`), Analityki, panelu technika
i Dashboardu. Techniczny/Ogólne/Kadry/kalendarz techniczny robi audyt A.

Metoda: dla każdego ekranu spisałem wywołania z `frontend/src/lib/api.ts` (skrypt
mapujący funkcja → endpoint), przypisałem każdemu wymagany klucz (`API_TAB_MAP`
w `src/middleware/auth.ts`, `writeTabs`, bramki w trasach, `src/lib/calendar-scope.ts`)
i porównałem z kluczem ekranu (`frontend/src/auth/permissions.ts`, gating w stronach).

## Podsumowanie

| # | Prio | Ekran / komponent (plik:linia) | Endpoint | Wymagany klucz | Kto traci | Skutek |
|---|------|-------------------------------|----------|----------------|-----------|--------|
| 1 | **WYSOKI** | `components/CalendarEventDialog.tsx:2131` (wersja handlowa: Kalendarz, Pulpit, Aktywności, karta szansy) | `GET /objects?pageSize=1000` | `objects` | każdy handlowiec bez `objects` | 403 wywala wspólny `Promise.all` → **pusta lista handlowców** (w trybie tworzenia nie da się nikogo przypisać) i pusty picker obiektu; błąd połknięty |
| 2 | **WYSOKI (wyciek)** | `pages/HandlowyLeadDetails.tsx:797` ← `src/routes/leads.ts:651, 709–745` (`offerRows`) | `GET /leads/:id` | `handlowy/leady` / `handlowy/pulpit` | — | odpowiedź niesie `offers[].totals` z `oneTimeCost*`, `monthlyCost`, `horizonCost`, `margin`, `belowMinMargin` **bez** sprawdzenia `technical/oferty-koszty` (brak `redactCosts`) |
| 3 | **WYSOKI (wyciek)** | `lib/calendar-config.ts:181` (SALES_CALENDAR.load), `sales/LeadDialog.tsx:144`, `HandlowyLeady` | `GET /salespeople` | 7 kluczy słownikowych (contractors, objects, handlowy/*) | — | każdy z kluczem słownikowym (np. sam `handlowy/kalendarz`) dostaje `commissionRate` oraz `objectsMonthlyValue`/`objectsMonthlyCost`/`objectsSetupCost` każdego handlowca (`src/routes/salespeople.ts:154–217`) — dane z poziomu `analityka/handlowcy` |
| 4 | ŚREDNI | `sales/LeadPicker.tsx:64`, `calendar/CalendarPage.tsx:5185` (LeadFilter), `CalendarEventDialog.tsx:2253` (`leadsApi.get`) | `GET /leads`, `GET /leads/:id` | `handlowy/leady` lub `handlowy/pulpit` | `handlowy/kalendarz`, `handlowy/aktywnosci` bez leadów | picker „Szansa” i filtr szans w kalendarzu puste; błąd połknięty |
| 5 | ŚREDNI | `CalendarEventDialog.tsx:2280–2281` (ContactPicker) | `GET /contacts?leadId=…` / `?contractorId=…` | `handlowy/kontakty`, `handlowy/leady`, `contractors`, `objects` | `handlowy/kalendarz`, `handlowy/pulpit`, `handlowy/aktywnosci` | lista „Osoba kontaktowa” pusta mimo wybranej szansy |
| 6 | ŚREDNI | `pages/HandlowyKontakty.tsx:174` (panel boczny „wydarzenia z tą osobą”) | `GET /calendar/events?contactId=…&department=handlowy` | klucz kalendarza handlowego (`/calendar` tabs + `calendar-scope` VIEW) | sam `handlowy/kontakty` | 403 połknięte → panel mówi „brak wydarzeń” (mylące) |
| 7 | ŚREDNI | `sales/ContactDialog.tsx:221` → LeadPicker; także `ContactsSection` w `SalesEntitySections` (Kontrahenci, karta obiektu) | `GET /leads` | `handlowy/leady` / `handlowy/pulpit` | `handlowy/kontakty` bez leadów | nie da się podpiąć kontaktu pod szansę (wyszukiwarka pusta) |
| 8 | ŚREDNI | `calendar/CalendarPage.tsx:2485` (przycisk „Aktywność”, widoczny też w kalendarzu handlowym, `:3242`, `:2890`) | `GET /activity/recent` | `technical/kalendarz` (bramka w `src/routes/activity.ts:87`) | każdy handlowiec bez kalendarza technicznego | toast „Błąd wczytywania aktywności” przy każdym otwarciu panelu |
| 9 | ŚREDNI | `pages/CmaReportDetails.tsx:377` (przycisk „wyślij e-mailem”, widoczny przy `canEdit("cma/raporty")`, `:1281`) | `POST /cma/mail/send-issues/:reportId` | `cma/ustawienia` (edit) | `cma/raporty:edit` bez ustawień | 403 „Brak dostępu do tej sekcji” (błąd widoczny) |
| 10 | NISKI | linki do innych modułów bez `canView` (lista niżej) | — (nawigacja) | `objects`, `contractors`, `orders`, `technical/oferty`, `cma/grupy-interwencyjne` | różni | `AccessGuard` przerzuca na Dashboard bez komunikatu |
| 11 | NISKI | `components/patrols/PatrolReportPanel.tsx:145` | `POST /cma/podjazdy/:id/intervention` | `cma/podjazdy` (edit) | — | zapis do rejestru grup interwencyjnych (stawki) z samym kluczem Podjazdów — do potwierdzenia, czy zamierzone |
| 12 | NISKI | `pages/CmaReports.tsx:195, 221` | `POST /cma/reports/import`, `DELETE /cma/reports/:id` | maxLevel z `cma/raporty|trendy|braki-kamer` | — | backend pozwala importować/kasować raporty z `cma/trendy:edit` (front chowa) — znana granulacja modułowa |

**Luk razem: 12** (3 wysokie, w tym 2 wycieki danych; 6 średnich; 3 niskie).
Bez luk: CMA Grupy interwencyjne, Podjazdy, Obiekty, Trendy, Braki kamer, Ustawienia;
Analityka (3 widoki + lejek); Dashboard (`/stats`, `/history/recent` same zwracają `null`/`[]`);
panel `/technik` (wszystko pod `/api/technik/*`, załączniki przez `/api/technik/attachments`,
`WeatherMark` nie woła API); Godziny działu CMA/Handlowy (wszystkie trasy w `HOURS_PORTAL_TABS`).

---

## Opisy i proponowane poprawki

### 1. [WYSOKI] Dialog wydarzenia handlowego: obiekty wywalają handlowców

`CalendarEventDialog.tsx:2128–2143`:
```ts
Promise.all([cfg.assignees.load(), cfg.features.objectPicker ? getObjects({ pageSize: 1000 }) : null])
  .then(([aRows, oRes]) => { setAssignees(aRows || []); setObjects(oRes?.data || []); })
  .catch(() => { /* słowniki opcjonalne */ });
```
`SALES_CALENDAR.features.objectPicker = true`, a `GET /objects` wymaga klucza `objects`.
Handlowiec z kluczami `handlowy/*` (bez Obiektów) dostaje 403 → odrzucony cały `Promise.all`
→ `assignees` = [] → `assigneeList` (`:3045`) w trybie tworzenia jest pusta. Dotyczy: Kalendarz
handlowy, Pulpit (`HandlowyPulpit.tsx`), Aktywności, „Nowa aktywność” na karcie szansy.
(To samo dzieje się w kalendarzu technicznym z technikami — audyt A.)

Poprawka:
- natychmiast: `Promise.allSettled` / dwa osobne efekty — słownik przypisanych niezależnie od obiektów;
- docelowo: lekki picker `GET /calendar/pick/objects?q=` (wzorzec: `/cma/intervention-groups/pick/objects`,
  `/cma/podjazdy/pick/objects`, `/contracts/drafts/pick/objects`, `/monitoring/pick/objects`), zwracający
  `id, name, address, city, contractorName` (+ ewentualnie lat/lng), limit 30, bramka
  „ma jakikolwiek kalendarz” (już daje ją prefiks `/calendar`). Przy okazji zdejmuje to pobieranie
  1000 obiektów przy każdym otwarciu dialogu.
- **Nie** rozszerzać `tabs` dla `/objects`: lista obiektów niesie `monthlyValue`, koszty, wartości umów
  (filtry `minValue/minCost` w `src/routes/objects.ts:143+`).

### 2. [WYSOKI, wyciek] Karta szansy zdradza koszty i marżę ofert

`GET /leads/:id` dokleja `offers: offerRows(id)` (`src/routes/leads.ts:651`), a `offerRows`
(`:709–745`) zwraca `totals: computeOffer(...)` — `OfferTotals` zawiera `oneTimeCost`,
`oneTimeCostMaterial`, `oneTimeCostLabour`, `monthlyCost`, `horizonCost`, `margin`, `belowMinMargin`
(dokładnie `COST_FIELDS` z `src/routes/offers.ts:358`). W `/offers` są one przycinane przez
`redactCosts`, gdy brak `technical/oferty-koszty`; w `/leads/:id` — nie ma żadnej redakcji.
Widzi to każdy z `handlowy/leady` albo `handlowy/pulpit` (front pokazuje tylko `monthlyTotal`, ale
JSON jest w DevTools).

Poprawka: wydzielić `redactCosts`/`canSeeCosts` z `offers.ts` do `src/lib/` i stosować w `leads.ts`
(odpowiedź karty szansy), test: konto bez `technical/oferty-koszty` nie dostaje pól kosztowych.

### 3. [WYSOKI, wyciek] Słownik handlowców = prowizje i portfel z kosztami

`GET /salespeople` (`src/routes/salespeople.ts:154–217`) zwraca pełny wiersz (`commissionRate`)
plus `objectsMonthlyValue`, `objectsMonthlyCost`, `objectsSetupCost`, `employeeName`, `userEmail`.
Prefiks jest otwarty do odczytu dla `handlowcy, contractors, objects, handlowy/leady,
handlowy/kalendarz, handlowy/pulpit, handlowy/aktywnosci` — bo formularze potrzebują tylko listy
nazwisk. Efekt: ktoś z samym `handlowy/kalendarz` widzi prowizję i przychód/koszt portfela każdego
handlowca, choć tę wiedzę celowo zamknięto w osobnym kluczu `analityka/handlowcy`.

Poprawka: `GET /salespeople/catalog` (id, firstName, lastName, active, userId) z wpisem w
`API_TAB_MAP` PRZED `/salespeople` (tabs = obecna lista, `writeTabs: ["handlowcy"]`), a szeroki
`/salespeople` zawęzić do `["handlowcy"]` (ewentualnie `contractors`/`objects`, jeśli ich formularze
potrzebują więcej niż nazwiska — sprawdzić w audycie A). Front: `getSalespeople` w
`lib/calendar-config.ts:181`, `sales/LeadDialog.tsx:144`, `HandlowyLeady.tsx` (filtr), formularze
kontrahenta/obiektu przełączyć na catalog.

### 4. [ŚREDNI] Picker i filtr szans w kalendarzu bez klucza Leadów

`LeadPicker.tsx:64` i `LeadFilter` (`CalendarPage.tsx:5185`) wołają `leadsApi.list`, dialog
dociąga `leadsApi.get` (`CalendarEventDialog.tsx:2253`). `/leads` ma tabs
`["handlowy/leady","handlowy/pulpit"]`, a kalendarz handlowy edytuje się także z samego
`handlowy/kalendarz` (`SALES_CALENDAR.editTabs`) i ogląda z `handlowy/aktywnosci`. Wynik: puste
listy, błędy połknięte.

Poprawka: `GET /leads/pick?q=` (wpis przed `/leads`, tabs: leady, pulpit, kalendarz, aktywnosci,
kontakty; `writeTabs: []`) zwracający `id, title, stage, clientLabel, salespersonId, contractorId` —
**bez** `estimatedMonthly`/`estimatedSetup` i bez ofert. Nie dopisywać `handlowy/kalendarz` do
szerokiego `/leads` (wartości szans, oferty — patrz #2). `leadsApi.get` w dialogu zastąpić danymi
z pickera / pola `event.lead*` z `/calendar/events`.

### 5. [ŚREDNI] Osoba kontaktowa w wydarzeniu handlowym

`CalendarEventDialog.tsx:2276–2288` — `contactsApi.list({leadId})` i `({contractorId})`.
`/contacts` nie obejmuje `handlowy/kalendarz|pulpit|aktywnosci` → pusta lista.

Poprawka: `GET /calendar/pick/contacts?leadId=` — dokładnie zbiór, który backend i tak akceptuje
w `contactId` (`src/lib/calendar-mutations.ts`): kontakty szansy + jej kontrahenta, pola
`id, name, role, phone, email`. Dane osobowe, ale ograniczone do jednej szansy; rozszerzanie tabs
`/contacts` otworzyłoby całą bazę kontaktów (RODO) — odradzam.

### 6. [ŚREDNI] Kontakty: panel wydarzeń osoby

`HandlowyKontakty.tsx:174` — `calendarApi.getEvents({contactId, department:"handlowy"})`. Z samym
`handlowy/kontakty` 403 na prefiksie `/calendar` (i dalej `calendar-scope` VIEW_TABS handlowy
nie zna tego klucza). Panel pokazuje „brak” zamiast „brak dostępu”.

Poprawka (wąska): `GET /contacts/:id/events` w `contacts.ts` (prefiks `/contacts` już otwarty dla
Kontaktów), tylko `department='handlowy'`, pola: data, typ, tytuł, status, handlowiec. Alternatywa
(szersza): dopisać `handlowy/kontakty` do tabs `/calendar` i VIEW_TABS handlowy — otwiera wtedy
cały kalendarz handlowy do odczytu. Minimum: odróżnić 403 od pustej listy w UI.

### 7. [ŚREDNI] Dialog kontaktu: nie da się wybrać szansy

`ContactDialog.tsx:221` używa `LeadPicker` → `/leads`. Z samym `handlowy/kontakty` (Kontakty,
oraz `ContactsSection` w `SalesEntitySections` na kartach kontrahenta/obiektu) wyszukiwarka jest
pusta. Poprawka: ten sam `/leads/pick` co #4 (z `handlowy/kontakty` w tabs). Zapis kontaktu
z `leadId` i tak przechodzi (`/contacts` writeTabs zawiera `handlowy/kontakty`).

### 8. [ŚREDNI] Panel „Aktywność” w kalendarzu handlowym

Przycisk jest bezwarunkowy (`CalendarPage.tsx:3242`, menu „Więcej” `:2890`), `loadActivity`
(`:2485`) woła `/activity/recent`, którego bramka to wyłącznie `technical/kalendarz`
(`src/routes/activity.ts:87`). Handlowiec dostaje toast z błędem.

Poprawka: w kalendarzu handlowym ukryć przycisk, dopóki nie ma bezpiecznego feedu; ALBO dodać
`?department=` i wpuszczać klucze `calendar-scope` VIEW danego działu, zwracając **wyłącznie**
`entityType='calendar_event'` z działów widocznych dla użytkownika.

> **Uwaga poza zakresem (dla audytu A, prawdopodobny wyciek):** `/activity/recent` filtruje tylko
> wpisy `calendar_event` z cudzego działu; wszystkie inne `entityType` z globalnego `activity_log`
> przechodzą — a do tej tabeli logują też `src/routes/hr.ts` (m.in. `hr_payroll`, `hr_contract`
> z old/new wartościami) i `src/routes/offers.ts`. Parametr `?entityType=` pozwala je wręcz
> wybrać. Czyli posiadacz `technical/kalendarz` może czytać dziennik zmian wypłat i ofert.
> Dlatego NIE otwierać tego endpointu handlowcom bez filtra po typie.

### 9. [ŚREDNI] CMA: wysyłka zestawienia braków z raportu

`CmaReportDetails.tsx:377` — przycisk pokazany przy `canEdit("cma/raporty")`, a
`POST /cma/mail/send-issues/:reportId` (`src/routes/cma-mail.ts:532`) siedzi pod prefiksem
`/cma/mail` → tylko `cma/ustawienia`.

Poprawka: wpis `{ prefix: "/cma/mail/send-issues", tabs: ["cma/raporty","cma/ustawienia"],
writeTabs: ["cma/raporty","cma/ustawienia"] }` przed `/cma/mail` (wysyłka idzie do adresatów
z ustawień — nic nie wycieka), albo przenieść trasę do `/cma/reports/:id/send-issues`. Alternatywnie
chować przycisk bez `canEdit("cma/ustawienia")`.

### 10. [NISKI] Linki do modułów bez sprawdzenia `canView`

Kliknięcie przerzuca na Dashboard (AccessGuard) bez wyjaśnienia:
- `components/patrols/PatrolReportPanel.tsx:179` (`/objects/:id`), `:270` (`/cma/grupy-interwencyjne`);
- `pages/CmaInterventionGroups.tsx:1125, 1483` (`/objects/:id`);
- `pages/HandlowyLeadDetails.tsx:324` („Nowa oferta” → `/technical/oferty`), `:646` (`/contractors`),
  `:765` (`/objects/:id`), `:836` (`/orders/:id`);
- `components/analytics/views/*View.tsx` — drill-down do `/objects…` (Kontrahenci `:341, 383, 465, 566`;
  Obiekty `:609, 644, 682, 736, 930`; Handlowcy `:543, 579, 659, 675`) i do `/handlowy/leady` (`:1043, 1104`);
- `pages/Dashboard.tsx` — „Zobacz wszystkich” w kartach (liczby i tak są `null` bez klucza).

Poprawka: zwykły tekst zamiast `<Link>`, gdy `!canView(klucz)`.

### 11. [NISKI] Podjazd → rozliczenie w grupach interwencyjnych

`POST /cma/podjazdy/:id/intervention` (`src/routes/patrol-events.ts:470`) tworzy wiersz w
`interventions` (moduł z kluczem `cma/grupy-interwencyjne`, warunki/stawki podwykonawców) przy
samym `cma/podjazdy:edit`. Nie jest to 403, tylko zapis między modułami — jeśli niezamierzony,
wymagać dodatkowo `canEdit(user, "cma/grupy-interwencyjne")` w trasie i chować przycisk na froncie.

### 12. [NISKI] Zapis w `/cma` liczony z trzech kluczy

`/cma` ma tabs `cma/raporty|trendy|braki-kamer` bez `writeTabs`, więc `cma/trendy:edit` pozwala
na import/kasowanie raportów przez API. Front chowa akcje (`canEdit("cma/raporty")`). Jeśli ma to
być twarde: `writeTabs: ["cma/raporty"]`.

---

## Wspólne wnioski

- Wzorzec, który działa w CMA: **własny endpoint pickera w module** (`/pick/objects`) zamiast
  sięgania po kartotekę. Kalendarz handlowy powinien dostać to samo: `/calendar/pick/objects`,
  `/leads/pick`, `/calendar/pick/contacts`, `/salespeople/catalog`.
- Słowniki ładowane `Promise.all` + `.catch(() => {})` ukrywają 403 i wywalają dane niezależne —
  rozdzielać (`allSettled`) i odróżniać „brak dostępu” od „pusto”.
- Przy otwieraniu prefiksów pamiętać, że szerokie odpowiedzi (`/objects`, `/salespeople`, `/leads/:id`)
  niosą kwoty i koszty; wąski kształt odpowiedzi jest bezpieczniejszy niż dopisanie klucza do `tabs`.

## Status napraw — paczka „Kadry / Zlecenia / Oferty / CMA” (2026-10-20)

Test: `npx tsx scripts/test-on-copy.ts scripts/test-perms-audit.ts`. Pozycje #1–#5 i #7 robi druga paczka (picker obiektów, wycieki leads/salespeople, `/leads/pick`, kontakty w dialogu).

| # | Status | Co zrobiono |
|---|---|---|
| 6 | naprawione | `GET /contacts/:id` zwraca wydarzenia osoby **odsiane po działach**: `viewableDepartments(user)` plus `handlowy` dla `handlowy/kontakty`. Wcześniej oddawał wydarzenia obu działów każdemu z `contractors`/`objects`, więc był to też wyciek. Panel w `HandlowyKontakty` czyta tę kartę zamiast `/calendar/events` |
| 8 | naprawione | `/activity/recent` oddaje **wyłącznie** `entityType='calendar_event'` z działów, które użytkownik ogląda. Filtr jest w SQL (podzapytanie po `calendar_events.department`), więc limit liczy się po odsianiu. Bramka: dowolny kalendarz zamiast `technical/kalendarz`. `?department=` zawęża, a cudzy dział daje 403. `?entityType=` jest ignorowany. **Potwierdzony wyciek zamknięty:** wcześniej `technical/kalendarz` czytał `hr_payroll`/`hr_contract` (stare i nowe kwoty) oraz dziennik ofert. `CalendarPage` woła feed z `cfg.department`, więc w kalendarzu handlowym przycisk „Aktywność” działa |
| 9 | naprawione | wpis `/cma/mail/send-issues` (`cma/raporty`, `cma/ustawienia`) przed `/cma/mail`. Własny adres `to` w body wymaga `cma/ustawienia: edit` (403), więc z samymi raportami wysyłka idzie tylko do adresatów z ustawień |
| 10 | częściowo | nowy `components/PermLink.tsx`: bez klucza zostaje zwykły tekst. Podpięty w `PatrolReportPanel` (obiekt, „Rozliczony”) i `CmaInterventionGroups` (2× obiekt). **Odłożone:** `HandlowyLeadDetails` (plik drugiej paczki), drill-downy Analityki (~15 miejsc) i Dashboard. Sama nawigacja, bez danych, więc można je przepiąć na `PermLink` później |
| 11 | odłożone | rozliczenie podjazdu w grupach interwencyjnych z samym `cma/podjazdy: edit` wygląda na celowy przepływ (v1.19.0, docs/PODJAZDY-RAPORTY.md). Zmianę musi zatwierdzić użytkownik |
| 12 | naprawione | `/cma` dostało `writeTabs: ["cma/raporty"]` (jedyne zapisy to import i kasowanie raportu) |

## Status napraw — paczka „katalogi i pickery” (2026-10-20)

Test: `npx tsx scripts/test-on-copy.ts scripts/test-catalog-perms.ts`.

| # | Status | Co zrobiono / dlaczego odłożone |
|---|---|---|
| 1 | **naprawione** | Dialog wydarzenia: przypisani i obiekty ładują się niezależnie; obiekty z `GET /objects/catalog` (bez kwot; `handlowy/kalendarz\|leady\|pulpit\|aktywnosci` w `tabs`). Zamiast proponowanego `/calendar/pick/objects` jeden wspólny katalog pod `/objects` — ten sam kształt dla kalendarzy, umów, zleceń i realizacji |
| 2 | **naprawione** | `GET /leads/:id`: `offers[]` przepuszczane przez `redactOfferCosts` (`src/lib/offer-costs.ts`), gdy brak `technical/oferty-koszty`. Test: bez klucza `totals` bez `oneTimeCost/monthlyCost/horizonCost/margin/belowMinMargin`, z kluczem — z nimi |
| 3 | **naprawione** | `GET /salespeople/catalog` (id, imię, nazwisko, active, userId); wpis przed `/salespeople` z dotychczasową listą kluczy + `orders`, `technical/oferty`; pełne `/salespeople` → `tabs: ["handlowcy"]`. Front: wszystkie słowniki handlowców na `getSalespeopleCatalog()` |
| 4 | **naprawione** | `GET /leads/pick?q=&includeClosed=1&limit=&id=` (id, tytuł, etap, clientLabel, contractorId, objectId, salespersonId, salespersonName — bez `estimated*`, `probability`, prospektu, ofert). Wpis przed `/leads`: leady, pulpit, kalendarz, aktywnosci, kontakty; `writeTabs: []`. `LeadPicker`, `LeadFilter` w `CalendarPage` i dociąganie szansy po id w dialogu (`leadsApi.pick({id})` zamiast `leadsApi.get`) |
| 5 | **naprawione** | `GET /calendar/pick/contacts?leadId=` (kontakty szansy + jej kontrahenta; id, imię, nazwisko, fullName, rola, telefon, e-mail, isPrimary, active, leadId, contractorId — bez notatek). Bramka: `canViewDepartment(user, "handlowy")`. Dialog woła jedno zapytanie zamiast dwóch `contactsApi.list` |
| 6 | odłożone | panel „wydarzenia z tą osobą” w Kontaktach — wymaga `GET /contacts/:id/events`; nie było w tej paczce |
| 7 | **naprawione** | `ContactDialog` używa `LeadPicker` → `/leads/pick` (z `handlowy/kontakty` w `tabs`) |
| 8, 9 | poza paczką | `/activity/recent` i CMA-mail — drugi agent |
| 10–12 | odłożone | niskie, poza zakresem tej paczki |
