ALTER TABLE `monitored_objects` ADD `object_id` integer REFERENCES objects(id);--> statement-breakpoint
ALTER TABLE `quotes` ADD `object_id` integer REFERENCES objects(id);--> statement-breakpoint
ALTER TABLE `realizations` ADD `object_id` integer REFERENCES objects(id);