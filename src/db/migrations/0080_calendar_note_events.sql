ALTER TABLE `calendar_events` ADD `note_id` integer REFERENCES calendar_event_notes(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `note_mention` text;--> statement-breakpoint
CREATE INDEX `calendar_events_note_id_idx` ON `calendar_events` (`note_id`);
