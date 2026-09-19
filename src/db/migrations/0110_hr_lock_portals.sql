-- ---------------------------------------------------------------------------
-- PORTALE DZIAŁOWE W REZERWACJI LIST (hr_edit_locks.portal + hr_departments.portal)
--
-- Rezerwacja z 0109 brała CAŁĄ listę miesiąca — a Kadry to nie jedna kolejka do
-- jednego arkusza: OFI wpisuje swoje godziny obiektowe, CMA swoje, księgowość
-- domyka całość. Jedna blokada na listę kazałaby im czekać na siebie po pół
-- godziny, choć piszą w zupełnie innych wierszach.
--
-- Po tej migracji blokada ma trzy współrzędne: (lista, miesiąc, PORTAL):
--  - portal (np. 'ofi') rezerwuje WYŁĄCZNIE wiersze swoich działów,
--  - pełne Kadry (portal '') rezerwują całość, ale Z WYŁĄCZENIEM działów,
--    które ktoś już trzyma — ich wiersze są w tabeli wygaszone i wolno o nie
--    poprosić z osobna,
--  - „lista zajęta” zostaje tylko wtedy, gdy nie da się edytować niczego.
--
-- `''` ZAMIAST NULL-a w `hr_edit_locks.portal`: w SQLite dwa NULL-e są
-- w indeksie UNIQUE RÓŻNE, więc unikat (scope, rok, miesiąc, portal) z NULL-em
-- przepuściłby dowolnie wiele rezerwacji całości — czyli dokładnie to, przed
-- czym ma bronić. Na zewnątrz (API, front) `''` pokazuje się jako `null`.
--
-- OSOBNA MIGRACJA, a nie poprawka w 0109: tamta jest już zastosowana na bazie
-- deweloperskiej, a migrator porównuje znaczniki czasu z journala — dopisanie
-- kolumn do 0109 nie wykonałoby się tam nigdy (i backend 4001 przewracałby się
-- na „no such column: portal”).
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0109).
-- ---------------------------------------------------------------------------
ALTER TABLE `hr_edit_locks` ADD `portal` text DEFAULT '' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `hr_edit_locks_scope_ym_uidx`;
--> statement-breakpoint
-- Jedna rezerwacja na (lista, rok, miesiąc, portal). To NIE jest tylko
-- porządek: dwa równoległe „Edycja” z dwóch przeglądarek muszą skończyć się
-- tak, że jedno wstawienie przechodzi, a drugie odbija się o unikat (i dostaje
-- 409 z nazwą właściciela) — zamiast zostawić dwóch właścicieli tego samego.
CREATE UNIQUE INDEX `hr_edit_locks_scope_ym_uidx` ON `hr_edit_locks` (`scope`,`year`,`month`,`portal`);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- PORTAL DZIAŁU (hr_departments.portal)
--
-- Który dział należy do której sekcji Kadr. Rezerwacja potrzebuje tego, żeby
-- powiedzieć, KTÓRE wiersze trzyma portal OFI, a które zostają wolne dla
-- pozostałych (godziny — po dziale wpisu, wypłaty i biuro — po dziale
-- pracownika w kartotece).
--
-- NULL = dział bez portalu: jego wiersze należą wyłącznie do pełnych Kadr.
-- Kilka działów może wskazywać ten sam portal (OFI i Operacyjny → 'ofi'),
-- dlatego to tekst, a nie klucz obcy.
-- ---------------------------------------------------------------------------
ALTER TABLE `hr_departments` ADD `portal` text;
--> statement-breakpoint
-- Dopasowanie po NAZWIE (nie po id): działy są słownikiem CRUD-owym i numery
-- w bazie produkcyjnej nie muszą się zgadzać z niczyim wyobrażeniem. Nazwy,
-- których tu nie ma (Księgowość, Zarząd), zostają bez portalu.
UPDATE `hr_departments` SET `portal` = 'cma' WHERE lower(`name`) = 'cma';
--> statement-breakpoint
UPDATE `hr_departments` SET `portal` = 'ofi' WHERE lower(`name`) IN ('ofi', 'operacyjny');
--> statement-breakpoint
UPDATE `hr_departments` SET `portal` = 'handlowy' WHERE lower(`name`) = 'handlowy';
--> statement-breakpoint
UPDATE `hr_departments` SET `portal` = 'technical' WHERE lower(`name`) = 'techniczny';
