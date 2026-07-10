DROP TABLE IF EXISTS `__new_technicians`;--> statement-breakpoint
ALTER TABLE `technicians` ADD `first_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `technicians` ADD `last_name` text DEFAULT '' NOT NULL;
