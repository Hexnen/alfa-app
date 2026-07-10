CREATE TABLE `monitoring_overlays` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`data` text NOT NULL,
	`sw_lat` real NOT NULL,
	`sw_lng` real NOT NULL,
	`ne_lat` real NOT NULL,
	`ne_lng` real NOT NULL,
	`rotation` real DEFAULT 0 NOT NULL,
	`opacity` real DEFAULT 0.7 NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `monitoring_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
