-- ---------------------------------------------------------------------------
-- WTYCZKA PRZEGLĄDARKI: TOKEN UŻYTKOWNIKA + KOLEJKA IMPORTÓW
--
-- Sesja aplikacji to cookie `alfa_session` z SameSite=Lax, więc wtyczka
-- (Chrome MV3, żądania z service workera) NIE MA jak się nim posłużyć —
-- potrzebuje własnego sekretu. Wzór jest już w bazie: `users.calendar_token`
-- dla feedu ICS. Tak samo tutaj: `plugin_token` to jedyne poświadczenie
-- tras /api/plugin/* (me, lookup, import, queue-count).
--
-- Token trzymamy JAWNIE (nie hash), świadomie: ZIP z wtyczką generujemy
-- wielokrotnie (użytkownik pobiera paczkę na drugi komputer) i za każdym
-- razem musimy wpisać do niej DZIAŁAJĄCY token. Z hashem dałoby się tylko
-- rotować sekret przy każdym pobraniu, czyli psuć wszystkie wcześniejsze
-- paczki. Zakres tokenu jest za to wąski (tylko /api/plugin/*, bez panelu
-- i bez zapisu kartoteki), a reset hasła i rotacja unieważniają go od razu.
--
-- KOLEJKA `warehouse_import_inbox`. Każdy klik w sklepie kończy się wierszem
-- tutaj, także ten z „otwórz teraz” — inaczej kliknięcie przy zamkniętej
-- karcie Magazynu przepadałoby bez śladu. Wiersz jest PROPOZYCJĄ do przejrzenia
-- przez człowieka, nie zapisem kartoteki: `parsed_json` niesie dokładnie ten
-- kształt, który zwraca `POST /warehouse/import/parse`, więc formularz towaru
-- dostaje z kolejki to samo, co przy imporcie z pliku.
--
-- Czego tu NIE MA: surowego HTML strony (kilka MB na wiersz, a po sparsowaniu
-- jest zbędny) i `accountLabel` (e-mail konta w sklepie — dana osobowa, do
-- niczego w kartotece nie potrzebna; wycinamy przed zapisem).
--
-- `expires_at` (+7 dni) jest po to, żeby kolejka nie rosła bez końca: wiersze
-- czyścimy leniwie przy każdym imporcie z wtyczki. Bez tego porzucone
-- „dodam później” zostawałyby w panelu na zawsze.
--
-- Migracja pisana RĘCZNIE (jak 0083, 0089, 0091) — drizzle-kit generate przy
-- tej bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
ALTER TABLE `users` ADD `plugin_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_plugin_token_unique` ON `users` (`plugin_token`);--> statement-breakpoint
ALTER TABLE `users` ADD `plugin_token_created_at` text;--> statement-breakpoint
CREATE TABLE `warehouse_import_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`mode` text DEFAULT 'open' NOT NULL,
	`shop` text,
	`shop_label` text,
	`product_url` text,
	`page_title` text,
	`name` text,
	`price_net` real,
	`parsed_json` text NOT NULL,
	`photo_data` text,
	`photo_warning` text,
	`match_count` integer DEFAULT 0 NOT NULL,
	`match_item_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`opened_at` text,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `warehouse_import_inbox_user_status_idx` ON `warehouse_import_inbox` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `warehouse_import_inbox_user_url_idx` ON `warehouse_import_inbox` (`user_id`,`product_url`);
