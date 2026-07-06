ALTER TABLE `cma_mail_settings` ADD `send_mode` text DEFAULT 'after_import' NOT NULL;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `send_times` text;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `last_scheduled_send_key` text;