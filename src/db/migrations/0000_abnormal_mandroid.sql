CREATE TABLE `contractors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`nip` text NOT NULL,
	`address` text,
	`city` text,
	`postal_code` text,
	`phone` text,
	`email` text,
	`contact_person` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contractors_nip_unique` ON `contractors` (`nip`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` integer NOT NULL,
	`contract_number` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`value` real,
	`file_path` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `object_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` integer NOT NULL,
	`action` text NOT NULL,
	`description` text,
	`old_value` text,
	`new_value` text,
	`changed_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `objects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contractor_id` integer NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`city` text,
	`type` text NOT NULL,
	`installation_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`department` text DEFAULT 'sales' NOT NULL,
	`monthly_value` real,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE cascade
);
