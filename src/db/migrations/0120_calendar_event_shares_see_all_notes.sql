-- ---------------------------------------------------------------------------
-- UDOSTĘPNIANIE WYDARZEŃ — przełącznik „Widzi wszystkie notatki” per link
-- (docs/UDOSTEPNIANIE-WYDARZEN.md, sekcja „Korekta: widoczność wszystkich notatek”).
--
-- see_all_notes — 1 = odbiorca linku „do pracy” (can_work = 1) widzi WSZYSTKIE
--   notatki wydarzenia (biuro, technicy, inne linki, systemowe), ale zmienia tylko
--   własne. 0 = tylko notatki tego linku (dotychczasowe zachowanie; istniejące linki).
-- ---------------------------------------------------------------------------
ALTER TABLE `calendar_event_shares` ADD `see_all_notes` integer DEFAULT 0 NOT NULL;
