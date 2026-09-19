-- ---------------------------------------------------------------------------
-- ZAMKNIĘCIE MIESIĄCA W KADRACH (hr_month_status)
--
-- Miesiąc rozliczeniowy kończy się raz: kwoty idą do księgowości, wypłaty
-- wychodzą, a arkusz ma przestać się ruszać. Do tej pory nic tego nie pilnowało
-- — poprawka wpisana w październiku w sierpniowe godziny po cichu zmieniała
-- kwotę, którą ktoś już wypłacił, i nikt nie widział różnicy między „miesiąc
-- w toku" a „miesiąc rozliczony".
--
-- Wiersz powstaje DOPIERO przy zamknięciu: brak wiersza = miesiąc otwarty.
-- Dzięki temu nie trzeba zakładać wierszy dla każdego miesiąca wstecz ani
-- pilnować, żeby nowy miesiąc miał swój rekord.
--
-- `status` trzyma tekst ('open'|'closed'), a nie samą datę zamknięcia: miesiąc
-- OTWARTY PONOWNIE to nie to samo, co miesiąc nigdy nie zamknięty — zostaje po
-- nim wiersz z powodem otwarcia i datą poprzedniego zamknięcia.
--
-- `closed_by_label` obok `closed_by_user_id`: konto wolno skasować, a podpis
-- „zamknął Mikołaj Sajdak" ma zostać czytelny także wtedy (ten sam wzorzec, co
-- w activity_log).
--
-- `reopen_reason` — OSTATNI powód ponownego otwarcia, do pokazania w pasku
-- miesiąca. Pełna historia zamknięć i otwarć siedzi w activity_log
-- (entity_type = 'hr_month', entity_id = rok*100 + miesiąc).
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0105) — drizzle-kit generate
-- przy tej bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
CREATE TABLE `hr_month_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_at` text,
	`closed_by_user_id` integer REFERENCES users(id) ON DELETE SET NULL,
	`closed_by_label` text,
	`reopen_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
-- Jeden wiersz na (rok, miesiąc) — dwa równoległe „Zamknij miesiąc" z dwóch
-- kart nie mają prawa zostawić dwóch sprzecznych stanów tego samego okresu.
CREATE UNIQUE INDEX `hr_month_status_ym_uidx` ON `hr_month_status` (`year`,`month`);
