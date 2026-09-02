CREATE TABLE `hr_departments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_cma_pool` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_departments_name_unique` ON `hr_departments` (`name`);--> statement-breakpoint
ALTER TABLE `hr_hours` ADD `department_id` integer REFERENCES hr_departments(id) ON DELETE SET NULL;