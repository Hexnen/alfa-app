CREATE TABLE `price_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_lists_name_unique` ON `price_lists` (`name`);--> statement-breakpoint
INSERT INTO `price_lists` (`name`, `description`, `is_default`, `active`, `position`) VALUES ('Cennik podstawowy', 'Domyślny cennik usług serwisowych', 1, 1, 1);--> statement-breakpoint
CREATE TABLE `__new_price_list` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`price_list_id` integer NOT NULL REFERENCES `price_lists`(`id`) ON UPDATE no action ON DELETE restrict,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_price_list`(`id`, `price_list_id`, `name`, `unit`, `price`, `position`, `active`, `created_at`, `updated_at`) SELECT `id`, (SELECT `id` FROM `price_lists` WHERE `is_default` = 1 LIMIT 1), `name`, `unit`, `price`, `position`, `active`, `created_at`, `updated_at` FROM `price_list`;--> statement-breakpoint
DROP TABLE `price_list`;--> statement-breakpoint
ALTER TABLE `__new_price_list` RENAME TO `price_list`;--> statement-breakpoint
ALTER TABLE `technicians` ADD `price_list_id` integer REFERENCES price_lists(id);
