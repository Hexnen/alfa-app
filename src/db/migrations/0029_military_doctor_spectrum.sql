CREATE INDEX `warehouse_document_items_document_id_idx` ON `warehouse_document_items` (`document_id`);--> statement-breakpoint
CREATE INDEX `warehouse_movements_item_id_idx` ON `warehouse_movements` (`item_id`);--> statement-breakpoint
CREATE INDEX `warehouse_movements_warehouse_id_idx` ON `warehouse_movements` (`warehouse_id`);--> statement-breakpoint
CREATE INDEX `warehouse_movements_document_id_idx` ON `warehouse_movements` (`document_id`);