CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'montaz' NOT NULL,
	`system` text,
	`unit` text DEFAULT 'szt' NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`description` text,
	`active` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
