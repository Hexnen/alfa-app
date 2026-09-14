-- ---------------------------------------------------------------------------
-- SUBSKRYPCJE WEB PUSH (panel technika)
--
-- Technik dowiadywał się o nowym zleceniu dopiero wtedy, gdy sam otworzył
-- panel — a zlecenie wpadające na dziś po południu ma dojść do niego wcześniej.
-- Web Push (VAPID) dowozi to bez żadnego sklepu z aplikacjami: subskrybuje
-- service worker panelu, a serwer pcha powiadomienie przez push service
-- przeglądarki.
--
-- `endpoint` UNIQUE — to jest właściwa TOŻSAMOŚĆ subskrypcji. Przeglądarka po
-- ponownym `subscribe()` potrafi oddać ten sam endpoint (ta sama instalacja),
-- więc zapis idzie jako upsert po tej kolumnie; bez UNIQUE jeden tablet
-- zbierałby dziesiątki wierszy i dostawał dziesięć kopii tego samego alertu.
--
-- ON DELETE CASCADE: skasowanie konta ma zabrać jego subskrypcje — inaczej
-- zostałyby wiersze, do których nikt nie ma już prawa, a wysyłka i tak nie
-- miałaby komu ich przypisać.
--
-- `failures` — licznik nieudanych prób INNYCH niż 404/410. Na 404/410 push
-- service mówi wprost „ta subskrypcja już nie istnieje" i wiersz kasujemy od
-- ręki; reszta (5xx, timeout) bywa chwilowa, więc tylko ją liczymy, żeby dało
-- się odróżnić martwy tablet od jednorazowej awarii.
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0102) — drizzle-kit generate
-- przy tej bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_used_at` text,
	`failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uidx` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);
