-- ---------------------------------------------------------------------------
-- UMOWY SPOZA GENERATORA: WGRANY PDF (contract_drafts.source + contracts.document_*)
--
-- Dotąd każdy draft umowy powstawał z otagowanego wzoru Worda, a wpis w rejestrze
-- mógł mieć dokument WYŁĄCZNIE wtedy, gdy przyszedł z takiego draftu. Tymczasem
-- połowa umów w segregatorze to skany podpisanych egzemplarzy i umowy przysłane
-- przez klienta — dla nich w aplikacji nie było miejsca, więc lądowały na dysku
-- sieciowym, poza kartoteką obiektu.
--
-- DWIE DROGI, DWIE KOLUMNY:
--
-- 1. `contract_drafts.source` ('template' | 'external') mówi, SKĄD wziął się plik
--    draftu. Wariant `external` trzyma wgrany PDF w tych samych kolumnach, co
--    dokument wygenerowany (`generated_file_name`, `generated_stored_path`,
--    `generated_at`, `generated_by`) — ten sam katalog, ten sam cykl życia,
--    to samo „Przenieś do rejestru”. Osobny komplet kolumn dublowałby całą
--    obsługę plików po to, żeby przechować tę samą ścieżkę.
--    `template_key` zostaje NOT NULL i dostaje stałą `external-pdf`, której
--    NIE MA w rejestrze szablonów — kod rozgałęzia się po `source`, a nie po
--    zgadywaniu z klucza.
--
-- 2. `contracts.document_*` to WŁASNY plik wpisu rejestru, niezależny od draftu.
--    Podpisany skan umowy, która wyszła z generatora, jest realnym przypadkiem:
--    draft niesie wersję do podpisu, rejestr — tę z podpisami. Dlatego własny
--    dokument ma w podglądzie pierwszeństwo nad plikiem draftu, a nie zastępuje
--    powiązania z nim.
--
-- Pliki rejestru leżą w `data/attachments/contracts/<id>/`, obok
-- `contract-drafts/<id>/` — kasowanie umowy sprząta katalog jednym `rm -r`.
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098) — drizzle-kit generate przy tej
-- bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
ALTER TABLE `contract_drafts` ADD `source` text DEFAULT 'template' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `document_name` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `document_stored_path` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `document_uploaded_at` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `document_uploaded_by` integer REFERENCES users(id) ON DELETE SET NULL;
