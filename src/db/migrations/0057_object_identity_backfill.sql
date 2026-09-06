-- Odzyskanie tożsamości obiektu dla realizacji i wycen.
--
-- DLACZEGO NIE PO NAZWIE. `realizations.site` identyfikował obiekt tekstem, a na
-- żywych danych 29 z 289 realizacji (10%) dopasowywało się przez to do INNEGO
-- obiektu, niż wskazywał kalendarz — dwanaście obiektów ma zduplikowane nazwy
-- („Stacja paliw Bochnia" ×2). Backfill idzie więc wyłącznie po powiązaniu
-- strukturalnym: wydarzenie kalendarza wskazuje i realizację, i obiekt.
-- Pokrycie: 289 z 289, bez zgadywania.
UPDATE `realizations` SET `object_id` = (
  SELECT e.`object_id` FROM `calendar_events` e
  WHERE e.`realization_id` = `realizations`.`id` AND e.`object_id` IS NOT NULL
  ORDER BY e.`id` LIMIT 1
)
WHERE `object_id` IS NULL;
--> statement-breakpoint
-- Wyceny dziedziczą obiekt po realizacji, do której są przypięte (31 z 41).
-- Pozostałe zostają bez obiektu — wycena bywa robiona zanim obiekt powstanie.
UPDATE `quotes` SET `object_id` = (
  SELECT r.`object_id` FROM `realizations` r WHERE r.`id` = `quotes`.`realization_id`
)
WHERE `object_id` IS NULL AND `realization_id` IS NOT NULL;
