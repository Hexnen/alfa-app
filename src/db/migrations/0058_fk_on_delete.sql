-- Naprawa klauzul ON DELETE, których zabrakło przy dodawaniu kluczy obcych.
--
-- `ALTER TABLE ... ADD COLUMN ... REFERENCES t(id)` w migracjach 0052 i 0056 nie
-- niosło `ON DELETE`, więc w bazie powstały klucze `NO ACTION` — mimo że
-- src/db/schema.ts i snapshoty drizzle deklarują `set null`. Rozjazd był
-- NIEWYKRYWALNY narzędziowo: `drizzle-kit generate` porównuje schemat ze
-- snapshotem, a oba mówiły to samo; rozjeżdżał się dopiero wykonany SQL.
--
-- Skutki, które to wywoływało:
--  * DELETE obiektu z realizacją/wyceną/mapowaniem kończył się wyjątkiem FK,
--    czyli HTTP 500 zamiast czytelnej odmowy (24 ze 120 obiektów);
--  * `--reset` generatora danych deweloperskich przerywał się w połowie i
--    zostawiał bazę w stanie nie do naprawienia dostępnymi narzędziami.
--
-- Przy okazji domykamy starszy dryf z 0043: plik .sql został tam poprawiony PO
-- zaaplikowaniu na produkcji, więc baza produkcyjna miała inne FK niż baza
-- postawiona od zera z tych samych migracji (`quotes.realization_id` i
-- `calendar_events.quote_id`). Po tej migracji jedno i drugie jest identyczne.
--
-- SQLite nie potrafi zmienić klucza obcego w miejscu — stąd przebudowa tabel
-- (nowa tabela, przepisanie danych, podmiana nazwy, odtworzenie indeksów).
-- Wyzwalaczy w tej bazie nie ma, więc nie ma czego odtwarzać.
CREATE TABLE `__new_realizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`site` text NOT NULL,
	`kind` text DEFAULT 'service' NOT NULL,
	`amount_hours` real DEFAULT 0 NOT NULL,
	`amount_material` real DEFAULT 0 NOT NULL,
	`amount_km` real DEFAULT 0 NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`note` text,
	`invoiced` integer DEFAULT false NOT NULL,
	`invoiced_at` text,
	`caretaker` text,
	`contractor_1` text,
	`contractor_2` text,
	`actual_hours` real DEFAULT 0 NOT NULL,
	`actual_km` real DEFAULT 0 NOT NULL,
	`hourly_cost` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
, `autofill` text, `work_type` text DEFAULT 'serwis' NOT NULL, `billing` text DEFAULT 'paid' NOT NULL, `object_id` integer REFERENCES objects(id) ON DELETE SET NULL);
--> statement-breakpoint
INSERT INTO `__new_realizations` (`id`, `date`, `site`, `kind`, `amount_hours`, `amount_material`, `amount_km`, `discount`, `note`, `invoiced`, `invoiced_at`, `caretaker`, `contractor_1`, `contractor_2`, `actual_hours`, `actual_km`, `hourly_cost`, `created_at`, `updated_at`, `autofill`, `work_type`, `billing`, `object_id`) SELECT `id`, `date`, `site`, `kind`, `amount_hours`, `amount_material`, `amount_km`, `discount`, `note`, `invoiced`, `invoiced_at`, `caretaker`, `contractor_1`, `contractor_2`, `actual_hours`, `actual_km`, `hourly_cost`, `created_at`, `updated_at`, `autofill`, `work_type`, `billing`, `object_id` FROM `realizations`;
--> statement-breakpoint
DROP TABLE `realizations`;
--> statement-breakpoint
ALTER TABLE `__new_realizations` RENAME TO `realizations`;
--> statement-breakpoint
CREATE TABLE `__new_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text NOT NULL,
	`date` text NOT NULL,
	`site` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
, `realization_id` integer REFERENCES realizations(id) ON DELETE CASCADE, `object_id` integer REFERENCES objects(id) ON DELETE SET NULL);
--> statement-breakpoint
INSERT INTO `__new_quotes` (`id`, `number`, `date`, `site`, `address`, `items`, `created_at`, `updated_at`, `realization_id`, `object_id`) SELECT `id`, `number`, `date`, `site`, `address`, `items`, `created_at`, `updated_at`, `realization_id`, `object_id` FROM `quotes`;
--> statement-breakpoint
DROP TABLE `quotes`;
--> statement-breakpoint
ALTER TABLE `__new_quotes` RENAME TO `quotes`;
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_number_unique` ON `quotes` (`number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_realization_id_uidx` ON `quotes` (`realization_id`) WHERE realization_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `__new_monitored_objects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` integer NOT NULL,
	`account` text,
	`category` text,
	`name` text NOT NULL,
	`identifier1` text,
	`identifier2` text,
	`identifier3` text,
	`extra_data1` text,
	`extra_data2` text,
	`extra_data3` text,
	`extra_data4` text,
	`extra_data5` text,
	`address` text,
	`street` text,
	`house_number` text,
	`postal_code` text,
	`city` text,
	`latitude` text,
	`longitude` text,
	`location_description` text,
	`object_description` text,
	`phones` text,
	`devices` text,
	`default_crew` text,
	`all_crews` text,
	`groups` text,
	`monitoring_start` text,
	`monitoring_end` text,
	`object_status` text,
	`added_at` text,
	`authorized_persons` text,
	`authorized_phones` text,
	`authorized_passwords` text,
	`duress_passwords` text,
	`day_arrival_time` text,
	`night_arrival_time` text,
	`related_objects` text,
	`service_types` text,
	`service_monitoring_from` text,
	`service_monitoring_to` text,
	`active` integer DEFAULT true NOT NULL,
	`first_import_id` integer,
	`last_import_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL, `object_id` integer REFERENCES objects(id) ON DELETE SET NULL,
	FOREIGN KEY (`first_import_id`) REFERENCES `object_imports`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_import_id`) REFERENCES `object_imports`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_monitored_objects` (`id`, `external_id`, `account`, `category`, `name`, `identifier1`, `identifier2`, `identifier3`, `extra_data1`, `extra_data2`, `extra_data3`, `extra_data4`, `extra_data5`, `address`, `street`, `house_number`, `postal_code`, `city`, `latitude`, `longitude`, `location_description`, `object_description`, `phones`, `devices`, `default_crew`, `all_crews`, `groups`, `monitoring_start`, `monitoring_end`, `object_status`, `added_at`, `authorized_persons`, `authorized_phones`, `authorized_passwords`, `duress_passwords`, `day_arrival_time`, `night_arrival_time`, `related_objects`, `service_types`, `service_monitoring_from`, `service_monitoring_to`, `active`, `first_import_id`, `last_import_id`, `created_at`, `updated_at`, `object_id`) SELECT `id`, `external_id`, `account`, `category`, `name`, `identifier1`, `identifier2`, `identifier3`, `extra_data1`, `extra_data2`, `extra_data3`, `extra_data4`, `extra_data5`, `address`, `street`, `house_number`, `postal_code`, `city`, `latitude`, `longitude`, `location_description`, `object_description`, `phones`, `devices`, `default_crew`, `all_crews`, `groups`, `monitoring_start`, `monitoring_end`, `object_status`, `added_at`, `authorized_persons`, `authorized_phones`, `authorized_passwords`, `duress_passwords`, `day_arrival_time`, `night_arrival_time`, `related_objects`, `service_types`, `service_monitoring_from`, `service_monitoring_to`, `active`, `first_import_id`, `last_import_id`, `created_at`, `updated_at`, `object_id` FROM `monitored_objects`;
--> statement-breakpoint
DROP TABLE `monitored_objects`;
--> statement-breakpoint
ALTER TABLE `__new_monitored_objects` RENAME TO `monitored_objects`;
--> statement-breakpoint
CREATE UNIQUE INDEX `monitored_objects_external_id_unique` ON `monitored_objects` (`external_id`);
--> statement-breakpoint
CREATE TABLE `__new_hr_objects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
, `object_id` integer REFERENCES objects(id) ON DELETE SET NULL, `is_cma_pool` integer DEFAULT false NOT NULL);
--> statement-breakpoint
INSERT INTO `__new_hr_objects` (`id`, `name`, `active`, `created_at`, `updated_at`, `object_id`, `is_cma_pool`) SELECT `id`, `name`, `active`, `created_at`, `updated_at`, `object_id`, `is_cma_pool` FROM `hr_objects`;
--> statement-breakpoint
DROP TABLE `hr_objects`;
--> statement-breakpoint
ALTER TABLE `__new_hr_objects` RENAME TO `hr_objects`;
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_objects_name_unique` ON `hr_objects` (`name`);
--> statement-breakpoint
CREATE TABLE `__new_calendar_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`department` text DEFAULT 'technical' NOT NULL,
	`object_id` integer,
	`order_id` integer,
	`realization_id` integer,
	`series_id` integer,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text, `billing` text, `protocol_id` integer REFERENCES protocols(id), `realization_optout` integer DEFAULT false NOT NULL, `quote_id` integer REFERENCES quotes(id) ON DELETE SET NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`realization_id`) REFERENCES `realizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`series_id`) REFERENCES `calendar_series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_calendar_events` (`id`, `type`, `title`, `description`, `location`, `start_at`, `end_at`, `all_day`, `status`, `department`, `object_id`, `order_id`, `realization_id`, `series_id`, `created_by`, `updated_by`, `created_at`, `updated_at`, `deleted_at`, `billing`, `protocol_id`, `realization_optout`, `quote_id`) SELECT `id`, `type`, `title`, `description`, `location`, `start_at`, `end_at`, `all_day`, `status`, `department`, `object_id`, `order_id`, `realization_id`, `series_id`, `created_by`, `updated_by`, `created_at`, `updated_at`, `deleted_at`, `billing`, `protocol_id`, `realization_optout`, `quote_id` FROM `calendar_events`;
--> statement-breakpoint
DROP TABLE `calendar_events`;
--> statement-breakpoint
ALTER TABLE `__new_calendar_events` RENAME TO `calendar_events`;
--> statement-breakpoint
CREATE INDEX `calendar_events_start_at_idx` ON `calendar_events` (`start_at`);
--> statement-breakpoint
CREATE INDEX `calendar_events_object_id_idx` ON `calendar_events` (`object_id`);
--> statement-breakpoint
CREATE INDEX `calendar_events_deleted_at_idx` ON `calendar_events` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX `calendar_events_series_id_idx` ON `calendar_events` (`series_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_realization_id_uidx` ON `calendar_events` (`realization_id`) WHERE realization_id IS NOT NULL;
