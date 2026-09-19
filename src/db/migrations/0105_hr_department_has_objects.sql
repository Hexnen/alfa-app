-- ---------------------------------------------------------------------------
-- DZIAŁ OBIEKTOWY (has_objects) — obiekt należy DO działu, a nie „albo/albo”
--
-- Model do tej pory: wpis godzin wskazywał obiekt ALBO dział, pola były
-- rozłączne. Rzeczywistość jest inna: wszyscy pracownicy obiektowi siedzą
-- w dziale OFI, więc godzina na posterunku to godzina działu OFI rozliczona na
-- konkretnym obiekcie. Rozłączność gubiła tę informację — wpisy obiektowe nie
-- miały działu i nie dawały się zestawić z resztą firmy.
--
-- Flaga, a nie nazwa: dział wolno przemianować, a rozpoznawanie „OFI” po
-- nazwie zepsułoby po cichu i walidację wpisu, i podpowiedzi w formularzach
-- (ta sama reguła, co przy `is_cma_pool`).
ALTER TABLE hr_departments ADD COLUMN has_objects INTEGER DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE hr_departments SET has_objects = 1 WHERE name = 'OFI';
--> statement-breakpoint
-- Backfill: wpisy godzin na obiekcie dostają dział obiektowy. Bez tego 1094
-- wierszy historii zostałoby „bez działu”, choć od teraz obiekt bez działu jest
-- stanem niedozwolonym.
UPDATE hr_hours
SET department_id = (SELECT id FROM hr_departments WHERE has_objects = 1 LIMIT 1)
WHERE object_id IS NOT NULL
  AND department_id IS NULL
  AND EXISTS (SELECT 1 FROM hr_departments WHERE has_objects = 1);
