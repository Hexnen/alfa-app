CREATE TABLE `manuals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`created_by` text,
	`updated_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `manual_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manual_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`kind` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`manual_id`) REFERENCES `manuals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manual_attachments_manual_idx` ON `manual_attachments` (`manual_id`);--> statement-breakpoint
CREATE TABLE `manual_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manual_id` integer NOT NULL,
	`warehouse_item_id` integer,
	`service_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`manual_id`) REFERENCES `manuals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`warehouse_item_id`) REFERENCES `warehouse_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manual_links_manual_idx` ON `manual_links` (`manual_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `manual_links_manual_item_unique` ON `manual_links` (`manual_id`,`warehouse_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `manual_links_manual_service_unique` ON `manual_links` (`manual_id`,`service_id`);
