-- ---------------------------------------------------------------------------
-- RAPORTY Z PODJAZDÓW v2 (docs/PODJAZDY-RAPORTY.md, „Backend v2 — stan”)
--
-- event_kind      — rodzaj zdarzenia wyliczany przy imporcie (src/lib/patrol-report.ts):
--                   patrol (Załoga / „Wysłano PI”), patrol_hint (bez załogi, ale notatka
--                   operatora wspomina wysłanie patrolu / załogę na miejscu),
--                   video_patrol (automatyczny wideopatrol Safestar AI), alarm (reszta).
-- hint_crew       — załoga z notatki („wysłano patrol GROM”), tylko gdy crew puste.
-- hint_arrived_at — przyjazd z notatki („01:24 patrol na miejscu”), tylko gdy arrived_at puste.
-- hint_text       — zdanie(a) źródłowe z notatki (domysł, nie dane z kolumn).
-- ---------------------------------------------------------------------------
ALTER TABLE `patrol_events` ADD `event_kind` text DEFAULT 'alarm' NOT NULL;--> statement-breakpoint
ALTER TABLE `patrol_events` ADD `hint_crew` text;--> statement-breakpoint
ALTER TABLE `patrol_events` ADD `hint_arrived_at` text;--> statement-breakpoint
ALTER TABLE `patrol_events` ADD `hint_text` text;--> statement-breakpoint
UPDATE `patrol_events` SET `event_kind` = 'patrol' WHERE `has_patrol` = 1;--> statement-breakpoint
CREATE INDEX `patrol_events_kind_idx` ON `patrol_events` (`event_kind`,`started_at`);
