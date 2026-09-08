CREATE TABLE `calendar_note_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`kind` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `calendar_event_notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_note_attachments_note_idx` ON `calendar_note_attachments` (`note_id`);