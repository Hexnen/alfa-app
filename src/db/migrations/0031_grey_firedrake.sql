CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`object_id` integer,
	`user_id` integer,
	`user_label` text,
	`action` text NOT NULL,
	`field` text,
	`old_value` text,
	`new_value` text,
	`summary` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_log_entity_idx` ON `activity_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `activity_log_object_id_idx` ON `activity_log` (`object_id`);--> statement-breakpoint
CREATE INDEX `activity_log_created_at_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `calendar_event_assignees` (
	`event_id` integer NOT NULL,
	`technician_id` integer NOT NULL,
	PRIMARY KEY(`event_id`, `technician_id`),
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`technician_id`) REFERENCES `technicians`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calendar_events` (
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
	`deleted_at` text,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`realization_id`) REFERENCES `realizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`series_id`) REFERENCES `calendar_series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `calendar_events_start_at_idx` ON `calendar_events` (`start_at`);--> statement-breakpoint
CREATE INDEX `calendar_events_object_id_idx` ON `calendar_events` (`object_id`);--> statement-breakpoint
CREATE INDEX `calendar_events_deleted_at_idx` ON `calendar_events` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `calendar_events_series_id_idx` ON `calendar_events` (`series_id`);--> statement-breakpoint
CREATE TABLE `calendar_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`freq` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`until` text,
	`count` integer,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `users` ADD `calendar_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_calendar_token_unique` ON `users` (`calendar_token`);