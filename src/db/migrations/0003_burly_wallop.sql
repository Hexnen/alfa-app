CREATE TABLE `cma_mail_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`direction` text NOT NULL,
	`message_uid` integer,
	`subject` text,
	`file_name` text,
	`report_id` integer,
	`status` text NOT NULL,
	`detail` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `cma_reports`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `cma_mail_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`imap_host` text DEFAULT 'imap.zenbox.pl' NOT NULL,
	`imap_port` integer DEFAULT 993 NOT NULL,
	`imap_secure` integer DEFAULT true NOT NULL,
	`smtp_host` text DEFAULT 'smtp.zenbox.pl' NOT NULL,
	`smtp_port` integer DEFAULT 465 NOT NULL,
	`smtp_secure` integer DEFAULT true NOT NULL,
	`email` text,
	`password` text,
	`folder` text DEFAULT 'INBOX' NOT NULL,
	`subject_filter` text,
	`poll_minutes` integer DEFAULT 15 NOT NULL,
	`import_enabled` integer DEFAULT false NOT NULL,
	`send_enabled` integer DEFAULT false NOT NULL,
	`recipients` text,
	`auto_send_after_import` integer DEFAULT true NOT NULL,
	`last_check_at` text,
	`last_check_status` text,
	`last_check_error` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
