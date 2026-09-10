CREATE TABLE `calendar_event_salespeople` (
	`event_id` integer NOT NULL,
	`salesperson_id` integer NOT NULL,
	PRIMARY KEY(`event_id`, `salesperson_id`),
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`salesperson_id`) REFERENCES `salespeople`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contractor_id` integer,
	`lead_id` integer,
	`object_id` integer,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`role` text,
	`phone` text,
	`email` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contacts_contractor_id_idx` ON `contacts` (`contractor_id`);--> statement-breakpoint
CREATE INDEX `contacts_lead_id_idx` ON `contacts` (`lead_id`);--> statement-breakpoint
CREATE INDEX `contacts_object_id_idx` ON `contacts` (`object_id`);--> statement-breakpoint
CREATE INDEX `contacts_name_idx` ON `contacts` (`last_name`,`first_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_primary_uidx` ON `contacts` (`contractor_id`) WHERE is_primary = 1 AND contractor_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`stage` text DEFAULT 'nowy' NOT NULL,
	`source` text,
	`contractor_id` integer,
	`prospect_name` text,
	`prospect_nip` text,
	`prospect_phone` text,
	`prospect_email` text,
	`object_kind` text,
	`address` text,
	`city` text,
	`maps_url` text,
	`lat` real,
	`lng` real,
	`services` text,
	`estimated_monthly` real,
	`estimated_setup` real,
	`probability` integer,
	`expected_close_date` text,
	`salesperson_id` integer,
	`object_id` integer,
	`order_id` integer,
	`won_at` text,
	`lost_at` text,
	`lost_reason` text,
	`lost_note` text,
	`last_activity_at` text,
	`notes` text,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`salesperson_id`) REFERENCES `salespeople`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `leads_stage_idx` ON `leads` (`stage`);--> statement-breakpoint
CREATE INDEX `leads_salesperson_stage_idx` ON `leads` (`salesperson_id`,`stage`);--> statement-breakpoint
CREATE INDEX `leads_contractor_id_idx` ON `leads` (`contractor_id`);--> statement-breakpoint
CREATE INDEX `leads_object_id_idx` ON `leads` (`object_id`);--> statement-breakpoint
CREATE INDEX `leads_deleted_at_idx` ON `leads` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `leads_last_activity_at_idx` ON `leads` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `leads_expected_close_date_idx` ON `leads` (`expected_close_date`);--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `lead_id` integer REFERENCES leads(id);--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `contact_id` integer REFERENCES contacts(id);--> statement-breakpoint
CREATE INDEX `calendar_events_lead_id_idx` ON `calendar_events` (`lead_id`);--> statement-breakpoint
ALTER TABLE `offers` ADD `lead_id` integer REFERENCES leads(id);--> statement-breakpoint
CREATE INDEX `offers_lead_id_idx` ON `offers` (`lead_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `lead_id` integer REFERENCES leads(id);--> statement-breakpoint
ALTER TABLE `orders` ADD `salesperson_id` integer REFERENCES salespeople(id);--> statement-breakpoint
ALTER TABLE `salespeople` ADD `user_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `salespeople_user_id_uidx` ON `salespeople` (`user_id`) WHERE user_id IS NOT NULL;