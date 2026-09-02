-- Działy firmy: zasianie słownika i przeniesienie CMA z pozycji obiektowych.
--
-- Do tej pory praca, która nie należy do żadnego obiektu, siedziała w słowniku
-- obiektów jako pozycja rozpoznawana PO NAZWIE (frontowe `overheadKind`:
-- prefiks "#" = pozycja techniczna, literalne "CMA" = koszt wspólny). Nazwa
-- przestaje być kluczem — działy dostają własną tabelę i własną kolumnę
-- w `hr_hours`.
--
-- Zakres celowo wąski: przenosimy WYŁĄCZNIE CMA, bo tylko ona jest działem
-- w rozumieniu firmy i tylko ona niesie flagę puli centrum monitorowania.
-- Pozycje "#..." zostają obiektami — nie ma ich na liście działów i o ich
-- losie decyduje użytkownik ręcznie.
INSERT OR IGNORE INTO `hr_departments` (`name`, `is_cma_pool`, `sort_order`) VALUES
  ('CMA', 1, 10),
  ('Handlowy', 0, 20),
  ('Księgowość', 0, 30),
  ('Zarząd', 0, 40),
  ('Techniczny', 0, 50),
  ('OFI', 0, 60),
  ('Operacyjny', 0, 70);
--> statement-breakpoint
-- Przepięcie godzin jednym zdaniem: gdyby `department_id` i `object_id` były
-- ustawiane osobno, między nimi istniałby stan łamiący rozłączność przypisania.
UPDATE `hr_hours`
SET `department_id` = (SELECT `id` FROM `hr_departments` WHERE `name` = 'CMA'),
    `object_id` = NULL
WHERE `object_id` IN (
    SELECT `id` FROM `hr_objects` WHERE `is_cma_pool` = 1 OR upper(trim(`name`)) = 'CMA'
  )
  AND EXISTS (SELECT 1 FROM `hr_departments` WHERE `name` = 'CMA');
--> statement-breakpoint
-- `NOT EXISTS` jest bezpiecznikiem: jeśli przepięcie czegoś nie objęło, pozycja
-- zostaje widoczna w Kadry → Obiekty zamiast zniknąć po cichu razem
-- z przypisaniem godzin (FK to `ON DELETE SET NULL`).
DELETE FROM `hr_objects`
WHERE (`is_cma_pool` = 1 OR upper(trim(`name`)) = 'CMA')
  AND NOT EXISTS (SELECT 1 FROM `hr_hours` `h` WHERE `h`.`object_id` = `hr_objects`.`id`);
--> statement-breakpoint
-- Nowa podzakładka Kadry → Działy dziedziczy poziom po Kadry → Obiekty: bez tego
-- kadrowa nie zobaczyłaby słownika, dopóki admin nie przeklika macierzy uprawnień.
UPDATE `users`
SET `permissions` = json_set(`permissions`, '$."kadry/dzialy"', json_extract(`permissions`, '$."kadry/obiekty"'))
WHERE json_valid(`permissions`)
  AND json_extract(`permissions`, '$."kadry/obiekty"') IS NOT NULL;
