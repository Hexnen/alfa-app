ALTER TABLE `calendar_events` ADD `billing` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `protocol_id` integer REFERENCES protocols(id);