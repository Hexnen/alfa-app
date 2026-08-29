ALTER TABLE `hr_objects` ADD `object_id` integer REFERENCES objects(id);--> statement-breakpoint
ALTER TABLE `salespeople` ADD `employee_id` integer REFERENCES hr_employees(id);--> statement-breakpoint
ALTER TABLE `technicians` ADD `employee_id` integer REFERENCES hr_employees(id);