-- Porządki w danych kadrowych przed UNIQUE na rozliczeniu biura (migracja 0078).
--
-- 1. PUSTE STUBY CARRY-OVER OBOK WYPEŁNIONYCH WIERSZY.
-- Na produkcji 263 wiersze (2026-07: 131, 2026-08: 132): carry-over założył stub
-- `object_uncertain = 1` z godzinami NULL, a potem seed-dev DOKLEIŁ do tego samego
-- miesiąca wypełnione wiersze tej samej osoby na tym samym obiekcie zamiast je
-- podmienić („doklejamy, nie podmieniamy"). Efekt: para (pracownik, miesiąc,
-- przypisanie) występuje dwa razy, tabela godzin pokazuje 132 „puste" wiersze
-- do uzupełnienia, których nikt nie ma uzupełniać, a licznik „bez godzin" kłamie.
--
-- Kasujemy WYŁĄCZNIE stub, który:
--   - jest oznaczony jako przeniesiony (`object_uncertain = 1`),
--   - nie ma ŻADNEJ wartości (godziny, kwoty, notatka puste),
--   - ma w tym samym miesiącu bliźniaka tej samej osoby o TYM SAMYM przypisaniu
--     (obiekt/dział porównywane z NULL-em przez COALESCE) z jakąkolwiek wartością.
-- Stub bez takiego bliźniaka (np. 2026-09: 132 wiersze czekające na wpisanie)
-- zostaje — to legalny efekt carry-over. Idempotentne: po pierwszym przebiegu
-- warunek nie trafia w nic.
DELETE FROM `hr_hours`
WHERE `object_uncertain` = 1
  AND `night_hours` IS NULL AND `worked_hours` IS NULL AND `uw_hours` IS NULL
  AND `l4_hours` IS NULL AND `max_hours` IS NULL
  AND `deductions` IS NULL AND `bonuses` IS NULL
  AND `notes` = ''
  AND EXISTS (
    SELECT 1 FROM `hr_hours` AS `f`
    WHERE `f`.`id` <> `hr_hours`.`id`
      AND `f`.`employee_id` = `hr_hours`.`employee_id`
      AND `f`.`year` = `hr_hours`.`year`
      AND `f`.`month` = `hr_hours`.`month`
      AND COALESCE(`f`.`object_id`, -1) = COALESCE(`hr_hours`.`object_id`, -1)
      AND COALESCE(`f`.`department_id`, -1) = COALESCE(`hr_hours`.`department_id`, -1)
      AND (
        `f`.`worked_hours` IS NOT NULL OR `f`.`uw_hours` IS NOT NULL
        OR `f`.`l4_hours` IS NOT NULL OR `f`.`night_hours` IS NOT NULL
        OR `f`.`max_hours` IS NOT NULL OR `f`.`deductions` IS NOT NULL
        OR `f`.`bonuses` IS NOT NULL
      )
  );
--> statement-breakpoint
-- 2. DUPLIKATY ROZLICZENIA BIURA po kluczu (pracownik, rok, miesiąc, spółka).
-- Na produkcji nie ma ani jednego (168 wierszy, 0 kolizji), ale `POST /office`
-- do tej pory robił goły INSERT, więc inne środowiska mogły je mieć — a UNIQUE
-- z migracji 0078 nie założy się na tabeli z kolizją. Zostaje NAJWCZEŚNIEJSZY
-- wiersz (najniższe id): późniejszy to powtórzone kliknięcie „Dodaj" z tymi samymi
-- danymi. Spółka jest częścią klucza — dwa wiersze tej samej osoby w dwóch
-- spółkach są legalne i zostają.
DELETE FROM `hr_office_payroll`
WHERE `id` NOT IN (
  SELECT MIN(`id`) FROM `hr_office_payroll`
  GROUP BY `employee_id`, `year`, `month`, `company`
);
