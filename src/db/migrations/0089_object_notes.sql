-- ---------------------------------------------------------------------------
-- NOTATKI KARTOTEKI OBIEKTU (object_notes)
--
-- Dziennik przy obiekcie — ta sama konwencja co `calendar_event_notes` (autor
-- + snapshot etykiety, soft delete), ale wiersz wisi przy obiekcie, a nie przy
-- dacie w kalendarzu.
--
-- `source_event_id` / `source_note_id` są niepuste wyłącznie dla notatek, które
-- POWSTAŁY jako kopia notatki wydarzenia („Zapisz też w obiekcie”). Kopia jest
-- samodzielnym wierszem — późniejsza edycja oryginału jej nie rusza; łącze służy
-- do pokazania źródła i do IDEMPOTENCJI kopiowania.
--
-- Partial UNIQUE na `source_note_id` (tylko wiersze niepuste i nieusunięte) jest
-- tym, co czyni „skopiuj do obiektu” idempotentnym na poziomie BAZY, a nie tylko
-- w kodzie: dwa równoległe kliknięcia nie zrobią dwóch kopii. Warunek
-- `deleted_at IS NULL` celowo ZWALNIA miejsce po skasowaniu kopii — użytkownik,
-- który usunął notatkę z kartoteki, musi móc skopiować ją ponownie.
-- ---------------------------------------------------------------------------
CREATE TABLE `object_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` integer NOT NULL,
	`user_id` integer,
	`user_label` text,
	`text` text NOT NULL,
	`source_event_id` integer,
	`source_note_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_note_id`) REFERENCES `calendar_event_notes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `object_notes_object_created_idx` ON `object_notes` (`object_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `object_notes_source_note_uidx` ON `object_notes` (`source_note_id`) WHERE source_note_id IS NOT NULL AND deleted_at IS NULL;
