CREATE TABLE `offer_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offer_id` integer NOT NULL,
	`section_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`warehouse_item_id` integer,
	`service_id` integer,
	`name` text NOT NULL,
	`unit` text DEFAULT 'szt' NOT NULL,
	`qty` real DEFAULT 1 NOT NULL,
	`kind` text DEFAULT 'material' NOT NULL,
	`billing` text DEFAULT 'one_time' NOT NULL,
	`unit_cost` real,
	`unit_price` real DEFAULT 0 NOT NULL,
	`discount_pct` real DEFAULT 0 NOT NULL,
	`is_optional` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `offer_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`warehouse_item_id`) REFERENCES `warehouse_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `offer_items_offer_id_idx` ON `offer_items` (`offer_id`);--> statement-breakpoint
CREATE INDEX `offer_items_section_id_idx` ON `offer_items` (`section_id`);--> statement-breakpoint
CREATE TABLE `offer_package_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'warehouse' NOT NULL,
	`warehouse_item_id` integer,
	`service_id` integer,
	`name` text DEFAULT '' NOT NULL,
	`unit` text DEFAULT 'szt' NOT NULL,
	`kind` text DEFAULT 'material' NOT NULL,
	`billing` text DEFAULT 'one_time' NOT NULL,
	`qty_base` real DEFAULT 0 NOT NULL,
	`qty_per_param` real DEFAULT 0 NOT NULL,
	`param_key` text,
	`qty_round` text DEFAULT 'none' NOT NULL,
	`unit_price_override` real,
	FOREIGN KEY (`package_id`) REFERENCES `offer_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`warehouse_item_id`) REFERENCES `warehouse_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offer_package_items_package_id_idx` ON `offer_package_items` (`package_id`);--> statement-breakpoint
CREATE TABLE `offer_packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'inne' NOT NULL,
	`manufacturer` text,
	`description` text,
	`mode` text DEFAULT 'parametric' NOT NULL,
	`params` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `offer_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offer_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`category` text DEFAULT 'inne' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`package_id` integer,
	`params` text DEFAULT '{}' NOT NULL,
	`is_optional` integer DEFAULT false NOT NULL,
	`variant_group` text,
	`variant_selected` integer DEFAULT true NOT NULL,
	`notes` text,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_id`) REFERENCES `offer_packages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `offer_sections_offer_id_idx` ON `offer_sections` (`offer_id`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text NOT NULL,
	`parent_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`date` text NOT NULL,
	`valid_until` text,
	`sent_at` text,
	`kind` text DEFAULT 'montaz' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`contractor_id` integer,
	`client_name` text DEFAULT '' NOT NULL,
	`client_nip` text DEFAULT '' NOT NULL,
	`object_id` integer,
	`site` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`salesperson_id` integer,
	`company_id` integer,
	`discount_pct` real DEFAULT 0 NOT NULL,
	`lease_mode` text DEFAULT 'none' NOT NULL,
	`lease_months` integer,
	`lease_annual_rate` real,
	`lease_include_labour` integer DEFAULT false NOT NULL,
	`order_id` integer,
	`warehouse_doc_id` integer,
	`notes` text,
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`salesperson_id`) REFERENCES `salespeople`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`warehouse_doc_id`) REFERENCES `warehouse_documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offers_number_unique` ON `offers` (`number`);--> statement-breakpoint
CREATE INDEX `offers_contractor_id_idx` ON `offers` (`contractor_id`);--> statement-breakpoint
CREATE INDEX `offers_object_id_idx` ON `offers` (`object_id`);--> statement-breakpoint
CREATE INDEX `offers_status_idx` ON `offers` (`status`);--> statement-breakpoint
CREATE INDEX `offers_parent_id_idx` ON `offers` (`parent_id`);