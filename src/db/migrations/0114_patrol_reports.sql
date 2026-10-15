-- ---------------------------------------------------------------------------
-- RAPORTY Z PODJAZDÓW (CMA → „Podjazdy”), kontrakt: docs/PODJAZDY-RAPORTY.md
--
-- patrol_reports      — jeden zaimportowany plik (dedup po sha256 treści),
-- patrol_events       — jedno zdarzenie z monitoringu (UNIQUE event_ref =
--                       „Identyfikator zdarzenia”; kolejny raport = upsert),
-- patrol_event_steps  — kroki obsługi (przy upsercie zastępowane w całości).
-- ---------------------------------------------------------------------------
CREATE TABLE `patrol_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`file_hash` text NOT NULL,
	`mail_message_id` text,
	`received_at` text NOT NULL,
	`events_total` integer DEFAULT 0 NOT NULL,
	`events_new` integer DEFAULT 0 NOT NULL,
	`events_updated` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `patrol_reports_file_hash_uidx` ON `patrol_reports` (`file_hash`);--> statement-breakpoint
CREATE TABLE `patrol_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_ref` text NOT NULL,
	`report_id` integer,
	`object_id` integer,
	`object_name` text NOT NULL,
	`street` text,
	`no` text,
	`postal` text,
	`city` text,
	`groups` text,
	`alarm_text` text,
	`classification` text,
	`event_type` text,
	`manual` integer DEFAULT false NOT NULL,
	`service_type` text,
	`started_at` text,
	`ended_at` text,
	`day_part` text,
	`has_patrol` integer DEFAULT false NOT NULL,
	`crew` text,
	`departed_at` text,
	`arrived_at` text,
	`left_at` text,
	`max_travel_min` integer,
	`travel_min` integer,
	`delay_min` integer,
	`travel_status` text,
	`delay_bucket` text,
	`late` integer DEFAULT false NOT NULL,
	`operator` text,
	`anomalies` text DEFAULT '[]' NOT NULL,
	`intervention_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `patrol_reports`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`intervention_id`) REFERENCES `interventions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `patrol_events_event_ref_uidx` ON `patrol_events` (`event_ref`);--> statement-breakpoint
CREATE INDEX `patrol_events_started_idx` ON `patrol_events` (`has_patrol`,`started_at`);--> statement-breakpoint
CREATE INDEX `patrol_events_object_idx` ON `patrol_events` (`object_id`);--> statement-breakpoint
CREATE TABLE `patrol_event_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`at` text,
	`text` text NOT NULL,
	`operator` text,
	`kind` text NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `patrol_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `patrol_event_steps_event_idx` ON `patrol_event_steps` (`event_id`,`seq`);
