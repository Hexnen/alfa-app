CREATE TABLE `price_list` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `protocols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realization_id` integer NOT NULL,
	`number` text NOT NULL,
	`work_date` text NOT NULL,
	`work_type` text DEFAULT 'serwis' NOT NULL,
	`actual_hours` real DEFAULT 0 NOT NULL,
	`actual_km` real DEFAULT 0 NOT NULL,
	`contractor` text,
	`salesperson` text,
	`client_name` text,
	`client_nip` text,
	`client_city` text,
	`installation_address` text,
	`contact` text,
	`activities` text,
	`items` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`realization_id`) REFERENCES `realizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocols_realization_id_unique` ON `protocols` (`realization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `protocols_number_unique` ON `protocols` (`number`);