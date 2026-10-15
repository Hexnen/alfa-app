-- ---------------------------------------------------------------------------
-- RAPORTY Z PODJAZDÓW — własne ustawienia poczty (docs/PODJAZDY-RAPORTY.md,
-- „Ustawienia podjazdów — stan”). Skan IMAP podjazdów ma własny włącznik,
-- foldery i filtry; filtry raportów kamer przestają obejmować podjazdy.
--
-- patrol_folder          — foldery po przecinku; '' = te same co `folder`
-- patrol_subject_filter  — frazy tematu po przecinku (OR); NULL = dowolny temat
-- patrol_from_filter     — nadawca zawiera; NULL = dowolny
-- patrol_lookback_days   — zakres „Sprawdź skrzynkę” / „Pobierz teraz”
-- patrol_last_check_*    — stan ostatniego skanu podjazdów
-- ---------------------------------------------------------------------------
ALTER TABLE `cma_mail_settings` ADD `patrol_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `patrol_folder` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `patrol_subject_filter` text;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `patrol_from_filter` text;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `patrol_lookback_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `patrol_last_check_at` text;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `patrol_last_check_status` text;--> statement-breakpoint
ALTER TABLE `cma_mail_settings` ADD `patrol_last_check_error` text;
