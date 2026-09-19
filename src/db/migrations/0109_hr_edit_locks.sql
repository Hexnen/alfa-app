-- ---------------------------------------------------------------------------
-- REZERWACJA LISTY DO EDYCJI W KADRACH (hr_edit_locks)
--
-- Wypłaty, godziny i biuro danego miesiąca wypełnia w praktyce JEDNA osoba,
-- ale przez godzinę i z kartki. Dwie osoby w tej samej tabeli to nie „konflikt
-- wersji” (ten pilnuje `expectedUpdatedAt` przy wierszu godzin), tylko dwie
-- serie zapisów w tych samych komórkach — druga cicho zamazuje pierwszą.
-- Przełącznik „Podgląd → Edycja” rezerwuje więc listę na 15 minut, a pozostali
-- widzą, kto ją trzyma, i mogą poprosić o zwolnienie.
--
-- JEDEN WIERSZ NA (scope, rok, miesiąc) — `scope` to lista: 'payroll'
-- (wypłaty ochrony), 'hours' (godziny), 'office' (rozliczenie biura). Słowniki
-- (pracownicy, umowy, obiekty, działy, normy, święta) rezerwacji NIE mają:
-- tam zmiany są pojedyncze i nie serią, więc blokada byłaby samym utrudnieniem.
--
-- WYGAŚNIĘCIE ZAMIAST SPRZĄTANIA. Zamknięty laptop nie zwolni rezerwacji, więc
-- każdy wiersz ma `expires_at` (now + 15 min, przedłużane heartbeatem co 60 s
-- i przy każdym zapisie). Wiersz po terminie jest MARTWY: wolno go przejąć, a
-- kasuje go leniwie pierwsze `acquire`/`GET /hr/locks` — bez crona.
--
-- CZASY PISZE APLIKACJA (ISO 8601 UTC, `new Date().toISOString()`), a nie
-- DEFAULT (datetime('now')): SQLite zapisałby „2026-09-15 12:00:00”, a JS
-- „2026-09-15T12:00:00.000Z” — porównanie tekstów obu formatów daje bzdurę,
-- a od niego zależy, czy rezerwacja jeszcze żyje.
--
-- `user_label` obok `user_id`: konto wolno skasować, a komunikat „Listę edytuje
-- Jan Kowalski” ma zostać czytelny (ten sam wzorzec, co w activity_log).
--
-- PROŚBA O ZWOLNIENIE siedzi w kolumnach tego samego wiersza
-- (`requested_by_*`), a nie w osobnej tabeli: prośba bez rezerwacji nie ma
-- sensu, znika razem z nią i zawsze jest tylko jedna (kolejne w ciągu 2 minut
-- odbija 429).
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0108) — drizzle-kit generate
-- przy tej bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
CREATE TABLE `hr_edit_locks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`user_id` integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	`user_label` text,
	`client_id` text,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`requested_by_user_id` integer REFERENCES users(id) ON DELETE SET NULL,
	`requested_by_label` text,
	`requested_at` text,
	`request_message` text
);
--> statement-breakpoint
-- Jedna rezerwacja na listę i miesiąc. To NIE jest tylko porządek: dwa równoległe „Edycja” z dwóch przeglądarek muszą skończyć się
-- tak, że jedno wstawienie przechodzi, a drugie odbija się o unikat (i dostaje
-- 409 z nazwą właściciela) — zamiast zostawić dwie rezerwacje tego samego.
CREATE UNIQUE INDEX `hr_edit_locks_scope_ym_uidx` ON `hr_edit_locks` (`scope`,`year`,`month`);
