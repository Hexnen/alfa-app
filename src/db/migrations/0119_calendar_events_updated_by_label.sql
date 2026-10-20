-- ---------------------------------------------------------------------------
-- UDOSTĘPNIANIE WYDARZEŃ — poprawka autora zmian (docs/UDOSTEPNIANIE-WYDARZEN.md)
--
-- updated_by_label — snapshot „kto zmienił”, gdy autorem nie jest użytkownik:
--   zapisy spod linku (start/finish/notatki) mają updated_by = twórca linku
--   (FK), a etykieta ma brzmieć „<odbiorca> (link)”. Zwykłe zmiany zerują
--   kolumnę (NULL = etykieta z joinu po updated_by).
-- ---------------------------------------------------------------------------
ALTER TABLE `calendar_events` ADD `updated_by_label` text;
