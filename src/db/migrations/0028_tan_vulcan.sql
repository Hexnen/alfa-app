CREATE TABLE `warehouse_doc_sequences` (
	`doc_type` text NOT NULL,
	`year` integer NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`doc_type`, `year`)
);
--> statement-breakpoint
CREATE TABLE `warehouse_document_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real,
	`position_no` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `warehouse_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `warehouse_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `warehouse_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_type` text NOT NULL,
	`doc_number` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`warehouse_from_id` integer,
	`warehouse_to_id` integer,
	`contractor_name` text,
	`invoice_number` text,
	`invoice_file_name` text,
	`invoice_file_data` text,
	`issued_at` text NOT NULL,
	`confirmed_at` text,
	`notes` text,
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`warehouse_from_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_to_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_documents_doc_number_unique` ON `warehouse_documents` (`doc_number`);--> statement-breakpoint
CREATE TABLE `warehouse_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sku` text,
	`name` text NOT NULL,
	`category` text,
	`unit` text DEFAULT 'szt' NOT NULL,
	`description` text,
	`photo_data` text,
	`min_stock` real,
	`is_asset` integer DEFAULT false NOT NULL,
	`barcode` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_items_sku_unique` ON `warehouse_items` (`sku`);--> statement-breakpoint
CREATE TABLE `warehouse_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`warehouse_id` integer NOT NULL,
	`quantity_delta` real NOT NULL,
	`document_id` integer,
	`document_item_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`item_id`) REFERENCES `warehouse_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `warehouse_documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_item_id`) REFERENCES `warehouse_document_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `warehouse_stock` (
	`item_id` integer NOT NULL,
	`warehouse_id` integer NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`item_id`, `warehouse_id`),
	FOREIGN KEY (`item_id`) REFERENCES `warehouse_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `warehouses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`type` text DEFAULT 'main' NOT NULL,
	`parent_id` integer,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action
);
