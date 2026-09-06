ALTER TABLE `hr_objects` ADD `is_cma_pool` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `objects` ADD `has_sswin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `objects` ADD `has_cameras` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `objects` ADD `camera_count` integer;--> statement-breakpoint
ALTER TABLE `objects` ADD `has_ofi` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `objects` ADD `has_videoreception` integer DEFAULT false NOT NULL;