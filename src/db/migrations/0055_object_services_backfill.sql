-- Przeniesienie dotychczasowego `objects.type` na rozdzielne usługi.
-- Jeden wybór („monitoring" / „alarm" / „fizyczna" / „mieszany") nie opisywał
-- obiektu, na którym jest i alarm, i kamery, i warta — a od tego zależy, którym
-- kluczem liczy się koszt osobowy. Mapowanie 1:1 z dotychczasowego znaczenia:
UPDATE `objects` SET `has_cameras` = 1 WHERE `type` IN ('monitoring', 'mixed');
--> statement-breakpoint
UPDATE `objects` SET `has_sswin` = 1 WHERE `type` IN ('alarm', 'mixed');
--> statement-breakpoint
UPDATE `objects` SET `has_ofi` = 1 WHERE `type` = 'physical';
--> statement-breakpoint
-- `camera_count` zostaje NULL świadomie: liczby kamer nie ma dziś nigdzie przy
-- obiekcie (rejestr CMA jej nie oddaje — 0 dopasowań do kartoteki po nazwie
-- i po adresie). NULL znaczy „usługa jest, ilości nikt nie policzył" i taki
-- obiekt nie wchodzi do podziału kosztu centrum monitorowania, dopóki ktoś
-- ilości nie uzupełni. Zero udawałoby wiedzę, której nie mamy.

-- Pula centrum monitorowania: pozycja kadrowa „CMA" (31 tys. godzin) nie należy
-- do żadnego obiektu, tylko rozdziela się po dozorowanych jednostkach.
UPDATE `hr_objects` SET `is_cma_pool` = 1 WHERE upper(trim(`name`)) = 'CMA';
