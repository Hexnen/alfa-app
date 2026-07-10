CREATE TABLE `hr_contracts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`company` text NOT NULL,
	`contract_type` text DEFAULT 'zlecenie' NOT NULL,
	`chor` integer DEFAULT false NOT NULL,
	`zua` text DEFAULT '' NOT NULL,
	`zza` text DEFAULT '' NOT NULL,
	`zwua` text DEFAULT '' NOT NULL,
	`object_name` text DEFAULT '' NOT NULL,
	`main_channel` text DEFAULT 'przelew' NOT NULL,
	`bonus_type` text DEFAULT 'brak' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hr_employees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_employees_full_name_unique` ON `hr_employees` (`full_name`);--> statement-breakpoint
CREATE TABLE `hr_hours` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`object_id` integer,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`night_hours` real,
	`worked_hours` real,
	`uw_hours` real,
	`l4_hours` real,
	`max_hours` real,
	`deductions` real,
	`bonuses` real,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_id`) REFERENCES `hr_objects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `hr_month_norms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`work_norm` real NOT NULL,
	`contract_norm` real NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hr_objects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_objects_name_unique` ON `hr_objects` (`name`);--> statement-breakpoint
CREATE TABLE `hr_office_payroll` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`etat_hours` real,
	`uw_l4` real,
	`deductions` real,
	`bonuses` real,
	`hours_for_accounting` real,
	`rate` real,
	`amount` real,
	`ror_base` real,
	`cash_override` real,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hr_payroll` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contract_id` integer NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`main_amount` real,
	`bonus_rate` real,
	`bonus_rate_pending` integer DEFAULT false NOT NULL,
	`rate_adjustment` real,
	`max_hours_override` real,
	`actual_hours_override` real,
	`bonus_amount_override` real,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `hr_contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
