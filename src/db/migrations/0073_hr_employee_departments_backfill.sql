-- Przypisanie pracowników biura do działów (stan podany przez zarząd, wrzesień 2026).
--
-- Dlaczego migracją, a nie ręcznym UPDATE-em na bazie: to samo przypisanie musi
-- pojawić się na każdym środowisku, a osoby z `kind = "biuro"` nie mają ANI JEDNEGO
-- wiersza w `hr_hours` (rozliczają się przez `hr_office_payroll`), więc nie ma innego
-- miejsca, z którego dałoby się ich dział odtworzyć.
--
-- Dopasowanie po pełnym imieniu i nazwisku — tak, jak trzyma je kartoteka
-- („Nazwisko Imię", kolumna UNIQUE). Każde zdanie jest warunkowe: brak osoby albo
-- brak działu to no-op, nie błąd, żeby migracja przeszła też na bazie bez tych danych.
UPDATE `hr_employees`
SET `department_id` = (SELECT `id` FROM `hr_departments` WHERE `name` = 'Handlowy')
WHERE `full_name` IN ('Sęk Michał', 'Skalski Roman')
  AND EXISTS (SELECT 1 FROM `hr_departments` WHERE `name` = 'Handlowy');
--> statement-breakpoint
UPDATE `hr_employees`
SET `department_id` = (SELECT `id` FROM `hr_departments` WHERE `name` = 'Operacyjny')
WHERE `full_name` IN ('Gocaliński Dariusz')
  AND EXISTS (SELECT 1 FROM `hr_departments` WHERE `name` = 'Operacyjny');
--> statement-breakpoint
UPDATE `hr_employees`
SET `department_id` = (SELECT `id` FROM `hr_departments` WHERE `name` = 'Zarząd')
WHERE `full_name` IN ('Jaworski Sławomir', 'Wilkosz Grzegorz')
  AND EXISTS (SELECT 1 FROM `hr_departments` WHERE `name` = 'Zarząd');
--> statement-breakpoint
UPDATE `hr_employees`
SET `department_id` = (SELECT `id` FROM `hr_departments` WHERE `name` = 'Księgowość')
WHERE `full_name` IN (
    'Jaworska Beata',
    'Jaworska Patrycja',
    'Jaworska Wiktoria',
    'Sęk Anita',
    'Maraszek Paulina',
    'Rosiak Dominika'
  )
  AND EXISTS (SELECT 1 FROM `hr_departments` WHERE `name` = 'Księgowość');
