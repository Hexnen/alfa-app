ALTER TABLE `realizations` ADD `work_type` text DEFAULT 'serwis' NOT NULL;--> statement-breakpoint
ALTER TABLE `realizations` ADD `billing` text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
/* Migracja danych — rozbicie starego, jednowymiarowego `kind` na parę
   (work_type = rodzaj prac, billing = typ rozliczenia). */
UPDATE `realizations` SET
  `work_type` = CASE WHEN `kind` = 'installation' THEN 'montaz' ELSE 'serwis' END,
  `billing` = CASE WHEN `kind` = 'warranty' THEN 'warranty' ELSE 'paid' END;--> statement-breakpoint
/* Realizacje powstałe z kalendarza: rodzaj i typ bierzemy z wydarzenia —
   `calendar_events` ma ten podział od początku, więc jest dokładniejszy niż `kind`
   (np. odróżni wizję lokalną i konserwację, które w `kind` były zwykłym „service”). */
UPDATE `realizations` SET
  `work_type` = COALESCE((
    SELECT CASE WHEN e.`type` IN ('serwis','montaz','wizja','demontaz','konserwacja') THEN e.`type` ELSE 'inne' END
    FROM `calendar_events` e WHERE e.`realization_id` = `realizations`.`id` AND e.`deleted_at` IS NULL
  ), `work_type`),
  `billing` = COALESCE((
    SELECT CASE WHEN e.`billing` IN ('warranty','free') THEN e.`billing` ELSE 'paid' END
    FROM `calendar_events` e WHERE e.`realization_id` = `realizations`.`id` AND e.`deleted_at` IS NULL
  ), `billing`)
WHERE EXISTS (
  SELECT 1 FROM `calendar_events` e WHERE e.`realization_id` = `realizations`.`id` AND e.`deleted_at` IS NULL
);--> statement-breakpoint
/* `kind` jest odtąd polem zgodnościowym (wyliczanym) — odtwarzamy je z nowej pary. */
UPDATE `realizations` SET `kind` = CASE
  WHEN `billing` = 'warranty' THEN 'warranty'
  WHEN `work_type` = 'montaz' THEN 'installation'
  ELSE 'service' END;
