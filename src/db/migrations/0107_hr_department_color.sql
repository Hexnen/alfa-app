-- ---------------------------------------------------------------------------
-- KOLOR DZIAŁU (color) — pigułka działu ma ten sam kolor wszędzie
--
-- Dział pokazuje się w kilku miejscach naraz (Godziny w obu trybach, kartoteka
-- pracownika, Działy, dziennik zmian), a wszędzie wyglądał tak samo: szara
-- pigułka z nazwą. Przy siedmiu działach i kilkuset wierszach godzin
-- rozpoznanie „to jest CMA, a to OFI” wymagało PRZECZYTANIA każdej komórki.
-- Kolor robi to samo jednym spojrzeniem — tak jak typ wydarzenia w kalendarzu.
--
-- Kolor jest cechą DZIAŁU, nie jego nazwy: dział wolno przemianować, a
-- kolorowanie po nazwie (hash, mapa „CMA → niebieski”) zmieniałoby wtedy kolor
-- po cichu i wstecznie, także na wpisach z zeszłych miesięcy.
--
-- Wartością jest NAZWA TONU z palety kalendarza (`PillTone` w
-- `frontend/src/lib/calendar-labels.ts`), a nie kod HEX: pigułka działu ma być
-- tą samą pigułką co status wydarzenia, z gotowym wariantem jasnym i ciemnym.
-- HEX z pola tekstowego dałby kolory spoza palety i tekst nie do odczytania
-- w trybie ciemnym. NULL = dział bez koloru (neutralna pigułka).
ALTER TABLE hr_departments ADD COLUMN color TEXT;
--> statement-breakpoint
-- Seed: siedem działów produkcyjnych dostaje różne tony, żeby kolumna „Dział”
-- była czytelna od pierwszego wejścia. Po nazwie, bo to jednorazowe nadanie
-- wartości startowej — dalej kolor żyje własnym życiem w kolumnie.
UPDATE hr_departments SET color = 'sky' WHERE color IS NULL AND name = 'CMA';
--> statement-breakpoint
UPDATE hr_departments SET color = 'violet' WHERE color IS NULL AND name = 'Handlowy';
--> statement-breakpoint
UPDATE hr_departments SET color = 'amber' WHERE color IS NULL AND name = 'Księgowość';
--> statement-breakpoint
UPDATE hr_departments SET color = 'rose' WHERE color IS NULL AND name = 'Zarząd';
--> statement-breakpoint
UPDATE hr_departments SET color = 'emerald' WHERE color IS NULL AND name = 'Techniczny';
--> statement-breakpoint
UPDATE hr_departments SET color = 'teal' WHERE color IS NULL AND name = 'OFI';
--> statement-breakpoint
UPDATE hr_departments SET color = 'orange' WHERE color IS NULL AND name = 'Operacyjny';
