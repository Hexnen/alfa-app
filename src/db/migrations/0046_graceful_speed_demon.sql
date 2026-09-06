CREATE TABLE `salespeople` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`phone` text,
	`email` text,
	`region` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `contractors` ADD `salesperson_id` integer REFERENCES salespeople(id);--> statement-breakpoint
ALTER TABLE `objects` ADD `salesperson_id` integer REFERENCES salespeople(id);