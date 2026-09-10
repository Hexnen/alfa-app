-- Drafty umów: dane spółki potrzebne w treści dokumentu + rejestr wygenerowanych
-- draftów i ich załączników. Migracja pisana RĘCZNIE (drizzle-kit generate nie
-- zna seeda), numer 0090, bo 0089 zajmuje `0089_object_notes`.
ALTER TABLE `companies` ADD `contract_code` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `contract_name` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `representative_line` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `share_capital` text;--> statement-breakpoint
CREATE TABLE `contract_drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` integer NOT NULL,
	`contractor_id` integer,
	`company_id` integer NOT NULL,
	`template_key` text NOT NULL,
	`contract_number` text NOT NULL,
	`seq` integer NOT NULL,
	`year` integer NOT NULL,
	`contract_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`notes` text,
	`generated_file_name` text,
	`generated_stored_path` text,
	`generated_at` text,
	`generated_hash` text,
	`generated_by` integer,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`generated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_drafts_contract_number_unique` ON `contract_drafts` (`contract_number`);--> statement-breakpoint
CREATE INDEX `contract_drafts_object_idx` ON `contract_drafts` (`object_id`);--> statement-breakpoint
CREATE INDEX `contract_drafts_company_year_idx` ON `contract_drafts` (`company_id`,`year`);--> statement-breakpoint
CREATE INDEX `contract_drafts_status_idx` ON `contract_drafts` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `contract_drafts_company_year_seq_uidx` ON `contract_drafts` (`company_id`,`year`,`seq`);--> statement-breakpoint
CREATE TABLE `contract_draft_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`kind` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `contract_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contract_draft_attachments_draft_idx` ON `contract_draft_attachments` (`draft_id`);--> statement-breakpoint
-- Seed danych do umów dla spółki ALFA — wartości wzięte wprost z oryginalnego
-- szablonu „Aktualna Umowa Draft Tylko ZDW.docx". ALFA S zostaje pusta: ma
-- własny wzór dokumentu, a UI ostrzeże, że brakuje kodu do numeracji.
UPDATE `companies` SET
	`contract_code` = 'ZDW',
	`contract_name` = 'Alfa Group Sp. z o.o.',
	`representative_line` = 'Sławomira Jaworskiego - Prezesa Zarządu',
	`share_capital` = '50 000,00 zł'
WHERE `name` = 'ALFA';
