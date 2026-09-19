-- ---------------------------------------------------------------------------
-- DZIAŁ OFI DLA PRACOWNIKÓW OCHRONY BEZ DZIAŁU
--
-- Sekcje działowe Kadr („Godziny działu” w CMA, OFI, Handlowym i Technicznym)
-- rozpoznają swoje wiersze po `hr_departments.portal` — a ten wisi na dziale
-- pracownika i dziale wpisu godzin. W kartotece produkcyjnej pracownicy
-- ochrony w OGÓLE nie mają działu (`department_id IS NULL`), bo dotąd nikt go
-- nie potrzebował: przypisanie robiło się per WPIS godzin (obiekt → OFI).
-- Bez tego backfillu sekcja OFI zobaczyłaby swoje wpisy, ale nie mogłaby
-- dodać ani jednego nowego — pracownik bez działu nie należy do żadnej sekcji.
--
-- WSZYSCY obiektowi są w OFI (potwierdzone przez użytkownika 2026-09-16), więc
-- przypisanie jest jednoznaczne. Pracowników BIURA zostawiamy nietkniętych:
-- tam dział (Handlowy, Księgowość, Zarząd) jest decyzją kadrową, a nie
-- konsekwencją posterunku — uzupełni je kierownik w Kadrach → Pracownicy
-- (filtr „Bez działu” pokazuje, kogo to jeszcze dotyczy).
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0110).
-- ---------------------------------------------------------------------------

-- JEDEN wpis zbiorczy w dzienniku, a nie jeden na osobę: „skąd się wziął dział
-- u stu pięćdziesięciu ludzi” to jedno zdarzenie, a sto pięćdziesiąt wpisów
-- przykryłoby wrzesień w Historii. Liczymy PRZED UPDATE-em, bo potem nie ma
-- już czego liczyć; `HAVING` pilnuje, żeby przy pustym zbiorze nie powstał
-- wpis „uzupełniono u 0 osób”.
INSERT INTO `activity_log` (
  `entity_type`, `entity_id`, `user_label`, `action`, `field`, `old_value`, `new_value`, `summary`
)
SELECT
  'hr_employee',
  0,
  'System (migracja 0111)',
  'updated',
  'departmentId',
  NULL,
  (SELECT `name` FROM `hr_departments` WHERE lower(`name`) = 'ofi' LIMIT 1),
  'Uzupełniono dział OFI u ' || COUNT(*) || ' pracowników ochrony bez działu (migracja 0111)'
FROM `hr_employees`
WHERE `kind` = 'ochrona'
  AND `department_id` IS NULL
  AND EXISTS (SELECT 1 FROM `hr_departments` WHERE lower(`name`) = 'ofi')
HAVING COUNT(*) > 0;
--> statement-breakpoint
UPDATE `hr_employees`
SET `department_id` = (SELECT `id` FROM `hr_departments` WHERE lower(`name`) = 'ofi' LIMIT 1),
    `updated_at` = datetime('now')
WHERE `kind` = 'ochrona'
  AND `department_id` IS NULL
  AND EXISTS (SELECT 1 FROM `hr_departments` WHERE lower(`name`) = 'ofi');
