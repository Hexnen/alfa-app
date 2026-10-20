-- ---------------------------------------------------------------------------
-- UDOSTĘPNIANIE WYDARZEŃ LINKIEM (kontrakt: docs/UDOSTEPNIANIE-WYDARZEN.md)
--
-- Jeden wiersz = jeden link do JEDNEGO wydarzenia kalendarza technicznego.
-- Token (256 bit, base64url) widać tylko raz w odpowiedzi POST; w bazie leży
-- wyłącznie sha256(token) w hex (`token_hash`, unikalny).
-- recipient_name    — dla technika: jego nazwa w chwili tworzenia; dla gościa: wpisane
-- expires_at        — ISO UTC (toISOString); revoked_at — ISO UTC albo NULL
-- open_count / last_opened_at — licznik otwarć publicznego GET /api/share/:token
-- ---------------------------------------------------------------------------
CREATE TABLE `calendar_event_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`technician_id` integer,
	`recipient_name` text NOT NULL,
	`created_by_user_id` integer,
	`created_by_label` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`open_count` integer DEFAULT 0 NOT NULL,
	`last_opened_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`technician_id`) REFERENCES `technicians`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_shares_token_hash_uidx` ON `calendar_event_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `calendar_event_shares_event_idx` ON `calendar_event_shares` (`event_id`);
