CREATE TABLE `camera_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`manufacturer` text DEFAULT '' NOT NULL,
	`camera_type` text DEFAULT '' NOT NULL,
	`resolution` text DEFAULT '' NOT NULL,
	`lens` text DEFAULT '' NOT NULL,
	`ir_range` text DEFAULT '' NOT NULL,
	`power` text DEFAULT '' NOT NULL,
	`interface` text DEFAULT '' NOT NULL,
	`protocol` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
