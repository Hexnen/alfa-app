CREATE TABLE `object_services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` integer NOT NULL,
	`service` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`camera_count` integer,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `object_services_object_id_idx` ON `object_services` (`object_id`);--> statement-breakpoint
CREATE INDEX `object_services_object_service_idx` ON `object_services` (`object_id`,`service`);--> statement-breakpoint
ALTER TABLE `objects` ADD `expected_end_date` text;--> statement-breakpoint
ALTER TABLE `objects` ADD `maps_url` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `object_services` text;--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- BACKFILL: flagi `objects.has_*` → okresy w `object_services`.
--
-- Od tej migracji źródłem prawdy o usługach są OKRESY, a flagi zostają jako
-- cache przeliczany z okresów aktywnych (src/lib/object-services.ts). Backfill
-- musi więc dać KAŻDEJ zapalonej fladze wiersz — inaczej pierwszy sync
-- (start backendu) zgasiłby flagę obiektu, o którym nikt nic złego nie wie.
--
-- `end_date` jest ZAWSZE NULL — świadomie. Migracja nie ma prawa zmienić
-- dzisiejszych flag ani przychodu w Analityce, a domknięcie okresu datą z
-- `monitored_objects.monitoring_end` wyłączyłoby część obiektów z filtrów i
-- z podziału kosztu centrum monitorowania. Domykanie to osobna, świadoma
-- decyzja (skrypt z `--apply`), nie efekt uboczny wdrożenia.
--
-- `start_date` z pierwszej znanej daty w kolejności wiarygodności:
--   1. najwcześniejsza data rozpoczęcia UMOWY obiektu,
--   2. najwcześniejszy `monitoring_start` z rejestru CMA dowiązanego do obiektu,
--   3. data założenia kartoteki (`created_at`) — zawsze istnieje (NOT NULL).
-- Obie daty ze źródeł zewnętrznych przechodzą przez GLOB 'RRRR-MM-DD': rejestr
-- potrafi nieść pusty string albo datę w innym formacie, a `start_date` NOT NULL
-- z gramoliną w środku psułby sortowanie i porównania „>= dziś".
-- ---------------------------------------------------------------------------
INSERT INTO `object_services` (`object_id`, `service`, `start_date`, `end_date`, `camera_count`, `created_at`, `updated_at`)
SELECT
  o.`id`,
  'kamery',
  coalesce(
    (SELECT min(c.`start_date`) FROM `contracts` c WHERE c.`object_id` = o.`id` AND c.`start_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    (SELECT min(m.`monitoring_start`) FROM `monitored_objects` m WHERE m.`object_id` = o.`id` AND m.`monitoring_start` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    date(o.`created_at`)
  ),
  NULL,
  o.`camera_count`,
  datetime('now'),
  datetime('now')
FROM `objects` o
WHERE o.`has_cameras` = 1;--> statement-breakpoint
INSERT INTO `object_services` (`object_id`, `service`, `start_date`, `end_date`, `camera_count`, `created_at`, `updated_at`)
SELECT
  o.`id`,
  'sswin',
  coalesce(
    (SELECT min(c.`start_date`) FROM `contracts` c WHERE c.`object_id` = o.`id` AND c.`start_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    (SELECT min(m.`monitoring_start`) FROM `monitored_objects` m WHERE m.`object_id` = o.`id` AND m.`monitoring_start` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    date(o.`created_at`)
  ),
  NULL,
  NULL,
  datetime('now'),
  datetime('now')
FROM `objects` o
WHERE o.`has_sswin` = 1;--> statement-breakpoint
INSERT INTO `object_services` (`object_id`, `service`, `start_date`, `end_date`, `camera_count`, `created_at`, `updated_at`)
SELECT
  o.`id`,
  'wideorecepcja',
  coalesce(
    (SELECT min(c.`start_date`) FROM `contracts` c WHERE c.`object_id` = o.`id` AND c.`start_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    (SELECT min(m.`monitoring_start`) FROM `monitored_objects` m WHERE m.`object_id` = o.`id` AND m.`monitoring_start` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    date(o.`created_at`)
  ),
  NULL,
  NULL,
  datetime('now'),
  datetime('now')
FROM `objects` o
WHERE o.`has_videoreception` = 1;--> statement-breakpoint
INSERT INTO `object_services` (`object_id`, `service`, `start_date`, `end_date`, `camera_count`, `created_at`, `updated_at`)
SELECT
  o.`id`,
  'ofi',
  coalesce(
    (SELECT min(c.`start_date`) FROM `contracts` c WHERE c.`object_id` = o.`id` AND c.`start_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    (SELECT min(m.`monitoring_start`) FROM `monitored_objects` m WHERE m.`object_id` = o.`id` AND m.`monitoring_start` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    date(o.`created_at`)
  ),
  NULL,
  NULL,
  datetime('now'),
  datetime('now')
FROM `objects` o
WHERE o.`has_ofi` = 1;
