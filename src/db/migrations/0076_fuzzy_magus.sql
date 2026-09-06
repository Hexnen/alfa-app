CREATE INDEX `hr_employees_department_id_idx` ON `hr_employees` (`department_id`);--> statement-breakpoint
CREATE INDEX `hr_hours_employee_id_idx` ON `hr_hours` (`employee_id`);--> statement-breakpoint
CREATE INDEX `hr_hours_object_id_idx` ON `hr_hours` (`object_id`);--> statement-breakpoint
CREATE INDEX `hr_hours_department_id_idx` ON `hr_hours` (`department_id`);--> statement-breakpoint
CREATE INDEX `hr_hours_year_month_idx` ON `hr_hours` (`year`,`month`);