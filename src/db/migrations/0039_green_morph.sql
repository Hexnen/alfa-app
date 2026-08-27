CREATE TABLE `calendar_filter_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`filters` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_filter_sets_user_name_uidx` ON `calendar_filter_sets` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `calendar_filter_sets_user_sort_idx` ON `calendar_filter_sets` (`user_id`,`sort_order`);