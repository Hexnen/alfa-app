CREATE TABLE `manual_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manual_id` integer NOT NULL,
	`parent_id` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text,
	`body` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`manual_id`) REFERENCES `manuals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `manual_sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manual_sections_manual_idx` ON `manual_sections` (`manual_id`);--> statement-breakpoint
CREATE INDEX `manual_sections_parent_idx` ON `manual_sections` (`parent_id`);--> statement-breakpoint
ALTER TABLE `manual_attachments` ADD `section_id` integer REFERENCES manual_sections(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `manual_attachments` ADD `position` integer DEFAULT 0 NOT NULL;