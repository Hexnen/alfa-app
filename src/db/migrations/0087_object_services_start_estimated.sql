ALTER TABLE `object_services` ADD `start_estimated` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- OZNACZENIE DAT STARTU ZMYŚLONYCH PRZEZ BACKFILL 0084.
--
-- Backfill 0084 brał `start_date` z pierwszej znanej daty: umowa → rejestr CMA
-- → `date(objects.created_at)`. Ostatni człon to NIE jest data rozpoczęcia
-- usługi, tylko data założenia kartoteki — a dla obiektów wgranych importem
-- kartoteki jest to jeden i ten sam dzień. Analityka czytała to dosłownie i
-- pokazywała ~147 „rozpoczętych usług" w miesiącu importu: artefakt wgrania
-- danych udający najlepszy miesiąc w historii firmy.
--
-- Ta migracja nie ZMIENIA żadnej daty (nie mamy lepszej), tylko ODDZIELA daty
-- znane od zgadniętych. Wiersz z `start_estimated = 1` nadal jest aktywną
-- usługą — wchodzi do flag, przychodu i mianowników — ale nie liczy się jako
-- „rozpoczęcie" w serii czasowej, a UI dopisuje przy dacie „szacowana".
--
-- WARUNEK jest DOSŁOWNYM powtórzeniem coalesce z 0084: data równa
-- `date(created_at)` ORAZ brak umowy z datą ISO ORAZ brak `monitoring_start`
-- z datą ISO. Sam warunek „start_date = date(created_at)" nie wystarcza —
-- oznaczyłby też obiekty, których PRAWDZIWY start (z umowy albo z rejestru)
-- przypadkiem wypada w dniu założenia kartoteki, czyli akurat te, o których
-- wiemy najwięcej.
-- ---------------------------------------------------------------------------
UPDATE `object_services`
SET `start_estimated` = 1
WHERE `id` IN (
  SELECT s.`id`
  FROM `object_services` s
  JOIN `objects` o ON o.`id` = s.`object_id`
  WHERE s.`start_date` = date(o.`created_at`)
    AND NOT EXISTS (
      SELECT 1 FROM `contracts` c
      WHERE c.`object_id` = o.`id`
        AND c.`start_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )
    AND NOT EXISTS (
      SELECT 1 FROM `monitored_objects` m
      WHERE m.`object_id` = o.`id`
        AND m.`monitoring_start` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )
);
