-- ---------------------------------------------------------------------------
-- CACHE PODGLĄDÓW LINKÓW (link_previews)
--
-- Adresy wpisywane w notatkach renderują się na froncie jako karty z tytułem,
-- ikoną i miniaturą. Metadane pochodzą z CUDZYCH stron, więc pobranie jest
-- wolne i zawodne — cache jest tu warunkiem, żeby otwarcie notatki nie było
-- serią wyjść w internet.
--
-- Klucz główny to adres ZNORMALIZOWANY (bez fragmentu `#...`, przycięty) —
-- ten sam link w dwóch notatkach to jeden wiersz i jedno pobranie.
--
-- Wiersze `status = 'error'` są zapisywane celowo: bez nich martwy adres
-- oznaczałby wyjście w sieć przy każdym renderze. TTL liczy `src/lib/link-preview.ts`
-- przy odczycie (7 dni dla `ok`, 1 h dla `error`) — nie ma zadania czyszczącego.
-- ---------------------------------------------------------------------------
CREATE TABLE `link_previews` (
	`url` text PRIMARY KEY NOT NULL,
	`final_url` text,
	`host` text NOT NULL,
	`title` text,
	`description` text,
	`image` text,
	`favicon` text,
	`site_name` text,
	`status` text NOT NULL,
	`error` text,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL
);
