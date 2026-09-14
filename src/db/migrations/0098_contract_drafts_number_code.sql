-- ---------------------------------------------------------------------------
-- OSOBNA SERIA NUMERACJI NA SZABLON (contract_drafts.number_code)
--
-- Dotąd licznik draftów szedł per (spółka, rok), a kod w numerze (`12/ZDW/2026`)
-- brał się z kartoteki spółki. Przy drugim wzorze — umowie powierzenia danych
-- osobowych (RODO) — to by znaczyło, że umowa towarzysząca zjada numer umowie
-- głównej: po „3/ZDW/2026” dla RODO kolejna umowa ZDW dostałaby „5/ZDW/2026”
-- i numeracja w segregatorze przestałaby się zgadzać z aplikacją.
--
-- Kod wędruje więc do WIERSZA: szablon z własnym `numberCode` (RODO) prowadzi
-- swoją serię, a szablon bez niego dalej bierze kod ze spółki (ZDW). Unikalny
-- indeks pilnuje teraz (spółka, rok, kod, seq) — to on, a nie `max(seq)+1`,
-- jest gwarancją przy wyścigu dwóch POST-ów.
--
-- BACKFILL bierze kod Z ISTNIEJĄCEGO NUMERU (środkowy człon `seq/KOD/rok`),
-- bo to on faktycznie poszedł do klienta; kartoteka spółki jest tylko zapasem,
-- gdyby numer miał nietypowy kształt. Kolumna dostaje DEFAULT '' wyłącznie po
-- to, żeby ALTER TABLE przeszedł bez przebudowy tabeli — każdy INSERT z kodu
-- podaje wartość wprost.
--
-- Migracja pisana RĘCZNIE (jak 0089–0092) — drizzle-kit generate przy tej bazie
-- potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
ALTER TABLE `contract_drafts` ADD `number_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `contract_drafts`
SET `number_code` = COALESCE(
	NULLIF(
		substr(
			substr(`contract_number`, instr(`contract_number`, '/') + 1),
			1,
			instr(substr(`contract_number`, instr(`contract_number`, '/') + 1), '/') - 1
		),
		''
	),
	(SELECT `contract_code` FROM `companies` WHERE `companies`.`id` = `contract_drafts`.`company_id`),
	''
);--> statement-breakpoint
DROP INDEX IF EXISTS `contract_drafts_company_year_seq_uidx`;--> statement-breakpoint
CREATE UNIQUE INDEX `contract_drafts_company_year_code_seq_uidx` ON `contract_drafts` (`company_id`,`year`,`number_code`,`seq`);
