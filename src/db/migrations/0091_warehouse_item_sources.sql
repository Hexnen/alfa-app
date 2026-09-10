-- ---------------------------------------------------------------------------
-- ŹRÓDŁA TOWARU: SKLEPY DOSTAWCÓW (warehouse_item_sources)
--
-- Ten sam sprzęt kupujemy w kilku sklepach (SAMAL, Janex, Eltrox, Grodno)
-- i każdy z nich ma WŁASNY indeks, własny adres strony produktu i własną cenę.
-- Trzymanie tego w kartotece towaru (kolumny `shop_url`, `supplier_code`…)
-- pozwoliłoby zapamiętać tylko jednego dostawcę, a przy porównywaniu ofert to
-- właśnie drugi i trzeci sklep są całą wartością — stąd osobna tabela 1:N.
--
-- UNIQUE (item_id, shop) jest tym, co czyni import strony produktu
-- ODŚWIEŻENIEM, a nie zakładaniem duplikatu: wrzucenie zapisanej strony
-- samal.pl po tygodniu nadpisuje cenę i stan w istniejącym wierszu.
--
-- (shop, supplier_code) obsługuje pytanie odwrotne — „mam kod 127117 od SAMAL,
-- czy ten towar jest już w kartotece?” — zadawane przy każdym imporcie.
--
-- `manufacturer_code` w warehouse_items to symbol producenta (MPN). Osobne pole
-- obok `sku` (nasz kod) i `barcode` (EAN), bo tylko ono jest wspólne dla
-- wszystkich sklepów i karty katalogowej → to główny klucz dopasowania towaru
-- przy imporcie, gdy EAN-u nikt nie uzupełnił.
--
-- Migracja pisana RĘCZNIE (jak 0083, 0089) — drizzle-kit generate przy tej
-- bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
CREATE TABLE `warehouse_item_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`shop` text NOT NULL,
	`shop_label` text,
	`product_url` text,
	`supplier_code` text,
	`supplier_product_id` text,
	`last_price_net` real,
	`last_price_gross` real,
	`vat_rate` real,
	`currency` text DEFAULT 'PLN' NOT NULL,
	`last_stock` real,
	`logged_in` integer DEFAULT false NOT NULL,
	`raw_json` text,
	`fetched_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `warehouse_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `warehouse_item_sources_item_idx` ON `warehouse_item_sources` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_item_sources_item_shop_uidx` ON `warehouse_item_sources` (`item_id`,`shop`);--> statement-breakpoint
CREATE INDEX `warehouse_item_sources_shop_code_idx` ON `warehouse_item_sources` (`shop`,`supplier_code`);--> statement-breakpoint
ALTER TABLE `warehouse_items` ADD `manufacturer_code` text;
