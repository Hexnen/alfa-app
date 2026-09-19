-- ---------------------------------------------------------------------------
-- TRWAŁE METADANE ZDJĘĆ PRZY ZAŁĄCZNIKACH NOTATEK
--
-- Zdjęcie z serwisu jest dowodem: kiedy i gdzie je zrobiono. Dotąd ta wiedza
-- ginęła dwa razy. Raz na telefonie — panel technika zmniejsza zdjęcie przez
-- canvas PRZED wysyłką, a canvas nie przepisuje EXIF-u. Drugi raz na serwerze —
-- `storeUploads` przepuszcza każdy obrazek przez sharp `.rotate().webp()`, co
-- świadomie zrzuca EXIF z pliku na dysku (nie chcemy hostować cudzych numerów
-- seryjnych i współrzędnych w pliku, który leci przeglądarce). Zostawała sama
-- data wgrania, czyli „kiedy ktoś to wysłał”, a nie „kiedy to zrobiono”.
--
-- Metadane wędrują więc do BAZY, przy wierszu załącznika:
--   * `taken_at` / `taken_at_offset` — czas z aparatu (lokalny, „YYYY-MM-DDTHH:mm:ss”)
--     i jego przesunięcie strefowe; razem dają jednoznaczny moment.
--   * `taken_at_source` — „exif” (serwer odczytał z pliku), „file” (klient wziął
--     z daty modyfikacji pliku), „none”. Enum pilnuje TypeScript, nie SQLite:
--     kolumna tekstowa nie wymaga przebudowy tabeli przy dołożeniu wartości.
--   * `captured_via` — „camera”/„gallery” (panel technika wie, skąd wzięto plik),
--     „upload” (biuro), „msg” (załącznik wypakowany z maila).
--   * `gps_*` — stopnie dziesiętne + dokładność i wysokość, gdy są.
--   * `camera_*` — producent, model, obiektyw.
--   * `orig_*` — wymiary, rozmiar i typ ORYGINAŁU (przed canvasem i przed WebP);
--     wiersz obok trzyma już tylko to, co leży na dysku.
--   * `meta_json` — reszta sensownych pól EXIF (ISO, przysłona, czas naświetlania,
--     orientacja…) jako JSON, przycięty do 8 KB. Bez MakerNote, miniatur,
--     UserComment i innych binariów.
--
-- Wszystko NULL-owalne i bez backfillu: stare załączniki nie mają tych danych
-- i mieć ich nie będą (plik na dysku jest już bez EXIF-u). Komplet NULL-i =
-- `meta: null` w API, czyli „nie wiadomo” — front nie pokazuje wtedy nic.
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0104) — drizzle-kit generate
-- przy tej bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
ALTER TABLE `calendar_note_attachments` ADD `taken_at` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `taken_at_offset` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `taken_at_source` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `captured_via` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `gps_lat` real;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `gps_lng` real;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `gps_accuracy_m` real;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `gps_altitude_m` real;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `camera_make` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `camera_model` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `camera_lens` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `orig_width` integer;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `orig_height` integer;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `orig_size` integer;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `orig_mime` text;
--> statement-breakpoint
ALTER TABLE `calendar_note_attachments` ADD `meta_json` text;
