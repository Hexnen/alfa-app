-- ---------------------------------------------------------------------------
-- UDOSTĘPNIANIE WYDARZEŃ — ETAP 2: link „do pracy” (docs/UDOSTEPNIANIE-WYDARZEN.md)
--
-- can_work — 1 = odbiorca linku może dodawać/edytować SWOJE notatki i robić
--            Rozpocznij/Zakończ; 0 = tylko podgląd. Istniejące linki zostają 0.
-- calendar_event_notes.share_id — notatka napisana spod linku (to jest „moja
--            notatka” odbiorcy). Odbiorca widzi i rusza wyłącznie notatki
--            z własnym share_id. NULL = notatka z CRM/panelu technika.
-- ---------------------------------------------------------------------------
ALTER TABLE `calendar_event_shares` ADD `can_work` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `calendar_event_notes` ADD `share_id` integer REFERENCES calendar_event_shares(id) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `calendar_event_notes_share_idx` ON `calendar_event_notes` (`share_id`);
