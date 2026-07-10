ALTER TABLE `orders` ADD `internet_included` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `orders` ADD `intervention_group` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `orders` ADD `video_reception` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `orders` ADD `installation_start_date` text;