ALTER TABLE `camera_models` ADD `fov` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `camera_models` ADD `range_m` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `camera_models` ADD `height` real DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `camera_models` ADD `color` text DEFAULT '#38bdf8' NOT NULL;
