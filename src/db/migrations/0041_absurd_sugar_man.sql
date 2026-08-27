CREATE TABLE `geo_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `objects` ADD `latitude` real;--> statement-breakpoint
ALTER TABLE `objects` ADD `longitude` real;--> statement-breakpoint
ALTER TABLE `price_list` ADD `kind` text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE `realizations` ADD `autofill` text;--> statement-breakpoint
-- Dopisane ręcznie (drizzle-kit nie generuje migracji danych): wstępna klasyfikacja
-- istniejących pozycji cennika po jednostce miary. Jednostki towarowe (SZT/KPL/MB/M/M2/KG)
-- → materiał, cała reszta (RBH, KM, USŁ, ...) zostaje usługą z DEFAULT 'service'.
-- Klasyfikacja jest wstępna — user poprawia rodzaj ręcznie w zakładce Cennik.
UPDATE `price_list` SET `kind` = 'material'
WHERE upper(trim(`unit`)) IN ('SZT', 'SZT.', 'SZTUKA', 'KPL', 'KPL.', 'MB', 'M', 'M2', 'M²', 'KG')
  -- ...ale robocizna rozliczana za metr bieżący (prace ziemne, bruzdy, ułożenie
  -- listew, kostka brukowa) zostaje usługą mimo towarowej jednostki.
  AND upper(`name`) NOT LIKE '%PRAC%'
  AND upper(`name`) NOT LIKE '%UŁOŻENIE%'
  AND upper(`name`) NOT LIKE '%MONTAŻ%'
  AND upper(`name`) NOT LIKE '%DEMONTAŻ%'
  AND upper(`name`) NOT LIKE '%BRUZD%'
  AND upper(`name`) NOT LIKE '%WYKONANIE%'
  AND upper(`name`) NOT LIKE '%ROBOCIZN%';
