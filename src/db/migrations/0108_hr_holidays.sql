-- ---------------------------------------------------------------------------
-- SŁOWNIK ŚWIĄT (hr_holidays) — dni ustawowo wolne obniżające wymiar czasu pracy
--
-- Norma godzin miesiąca liczy się z art. 130 k.p., a jedyną zmienną w tym
-- przepisie są ŚWIĘTA: 40 h × pełne tygodnie + 8 h × dni robocze wystające,
-- minus 8 h za każde święto w dniu innym niż niedziela. Święta dałoby się
-- zaszyć w kodzie — trzynaście dat plus Wielkanoc z algorytmu — ale wtedy
-- każda nowela ustawy z 18.01.1951 oznaczałaby wydanie nowej wersji aplikacji.
-- Tak właśnie wyglądał rok 2025, kiedy doszła Wigilia: firmy z datami w kodzie
-- czekały na aktualizację, a wymiar grudnia był o 8 h za wysoki.
--
-- Dlatego lista jest DANYMI, nie kodem. `source` odróżnia dwa jej rodzaje:
--   'statutory' — zasiane algorytmem przy pierwszym otwarciu roku (ustawa),
--   'custom'    — dopisane ręcznie (nowe święto, dzień wolny spoza ustawy).
-- Kasować wolno tylko wpisy 'custom': usunięcie Bożego Ciała nie jest decyzją
-- kadrową, tylko pomyłką, a rok bez ŻADNEGO wpisu zasiewa się sam od nowa.
--
-- Klucz UNIQUE na dacie: jedno święto w dniu. Podwójny wpis (np. ręcznie
-- dodana „Wigilia” obok zasianej) odjąłby 16 h za jeden dzień wolny.
--
-- Rok NIE jest osobną kolumną — wyciąga go zapytanie po prefiksie daty
-- (`date LIKE '2026-%'`), a indeks po `date` obsługuje to zakresowo. Kolumna
-- `year` byłaby drugim źródłem prawdy o tej samej rzeczy.
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0107) — drizzle-kit generate
-- przy tej bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
CREATE TABLE `hr_holidays` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT 'statutory' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_holidays_date_uidx` ON `hr_holidays` (`date`);
