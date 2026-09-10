CREATE TABLE `intervention_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`intervention_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`kind` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`intervention_id`) REFERENCES `interventions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intervention_attachments_intervention_idx` ON `intervention_attachments` (`intervention_id`);--> statement-breakpoint
CREATE TABLE `intervention_companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`area` text,
	`contact_person` text,
	`phone` text,
	`email` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intervention_companies_active_name_idx` ON `intervention_companies` (`active`,`name`);--> statement-breakpoint
CREATE TABLE `intervention_company_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`kind` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `intervention_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intervention_company_attachments_company_idx` ON `intervention_company_attachments` (`company_id`);--> statement-breakpoint
CREATE TABLE `intervention_term_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`term_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`kind` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`term_id`) REFERENCES `intervention_terms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intervention_term_attachments_term_idx` ON `intervention_term_attachments` (`term_id`);--> statement-breakpoint
CREATE TABLE `intervention_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` integer NOT NULL,
	`company_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`callout_fee` real,
	`subscription_fee` real,
	`free_callouts` integer,
	`hourly_standby_fee` real,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `intervention_companies`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `intervention_terms_object_idx` ON `intervention_terms` (`object_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `intervention_terms_company_idx` ON `intervention_terms` (`company_id`);--> statement-breakpoint
CREATE TABLE `interventions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` integer NOT NULL,
	`term_id` integer NOT NULL,
	`company_id` integer NOT NULL,
	`happened_at` text NOT NULL,
	`reason` text,
	`reported_by` text,
	`standby_hours` real,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`term_id`) REFERENCES `intervention_terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`company_id`) REFERENCES `intervention_companies`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `interventions_object_idx` ON `interventions` (`object_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `interventions_term_idx` ON `interventions` (`term_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `interventions_company_idx` ON `interventions` (`company_id`);