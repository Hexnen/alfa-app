/* Wycena wydarzenia: `quotes.realization_id` (1:1 z realizacją, jak protokół)
   + `calendar_events.quote_id` (jawne przypięcie). Klauzule ON DELETE dopisane
   ręcznie — drizzle-kit ich nie emituje przy ALTER TABLE ADD COLUMN, a bez nich
   usunięcie realizacji/wyceny leciałoby na FOREIGN KEY constraint failed. */
ALTER TABLE `calendar_events` ADD `quote_id` integer REFERENCES quotes(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `quotes` ADD `realization_id` integer REFERENCES realizations(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_realization_id_uidx` ON `quotes` (`realization_id`) WHERE realization_id IS NOT NULL;
