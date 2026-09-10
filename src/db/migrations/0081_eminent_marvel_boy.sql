CREATE TABLE `mail_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`variant` text,
	`to_addr` text NOT NULL,
	`cc_addr` text,
	`bcc_addr` text,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`message_id` text,
	`user_id` integer,
	`user_label` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mail_log_entity_idx` ON `mail_log` (`entity_type`,`entity_id`);