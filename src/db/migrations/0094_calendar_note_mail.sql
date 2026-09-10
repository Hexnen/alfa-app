-- ---------------------------------------------------------------------------
-- NOTATKA MAILOWA — mail z Outlooka upuszczony na kalendarz
--
-- Mail przeciągnięty z Outlooka na siatkę kalendarza tworzy wydarzenie, a jego
-- treść ląduje w PIERWSZEJ NOTATCE wydarzenia (oryginalny plik .msg zostaje jej
-- załącznikiem). Do tej pory notatka miała tylko `text`, więc nagłówek maila
-- (temat, nadawca, odbiorcy, data) trzeba by w nim skleić — a wtedy nie da się
-- go ani sensownie wyświetlić, ani później po nim szukać.
--
-- Stąd `kind` i pola `mail_*`: notatka mailowa to OSOBNY RODZAJ wpisu.
--   * `text`        — SAMA treść maila (body), bez nagłówka,
--   * `mail_*`      — nagłówek w polach; UI składa z nich kartę „Mail z Outlooka",
--   * `mail_to`/`mail_cc` — tablice JSON stringów (SQLite nie ma typu tablicowego;
--     lista odbiorców bywa długa i nie ma sensu jej normalizować — to snapshot
--     tego, co było w mailu, a nie kartoteka kontaktów).
--
-- `kind` z DEFAULT 'text' + NOT NULL: wszystkie istniejące notatki są tekstowe,
-- więc backfill nie jest potrzebny. Bez indeksu — notatek jednego wydarzenia są
-- jednostki, a globalnego filtrowania po rodzaju nie ma.
-- ---------------------------------------------------------------------------
ALTER TABLE calendar_event_notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
--> statement-breakpoint
ALTER TABLE calendar_event_notes ADD COLUMN mail_subject TEXT;
--> statement-breakpoint
ALTER TABLE calendar_event_notes ADD COLUMN mail_from TEXT;
--> statement-breakpoint
ALTER TABLE calendar_event_notes ADD COLUMN mail_to TEXT;
--> statement-breakpoint
ALTER TABLE calendar_event_notes ADD COLUMN mail_cc TEXT;
--> statement-breakpoint
ALTER TABLE calendar_event_notes ADD COLUMN mail_sent_at TEXT;
