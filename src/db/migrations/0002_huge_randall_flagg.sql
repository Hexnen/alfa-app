CREATE TABLE `cma_report_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` integer NOT NULL,
	`object_category` text,
	`object_name` text NOT NULL,
	`address` text,
	`identifier1` text,
	`identifier2` text,
	`identifier3` text,
	`generated_at` text,
	`patrol_name` text,
	`started_at` text,
	`ended_at` text,
	`end_type` text,
	`description` text,
	`video_device` text,
	`video_channel` text,
	`user_name` text,
	FOREIGN KEY (`report_id`) REFERENCES `cma_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cma_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_name` text NOT NULL,
	`title` text NOT NULL,
	`date_from` text,
	`date_to` text,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`imported_at` text DEFAULT (datetime('now')) NOT NULL
);
