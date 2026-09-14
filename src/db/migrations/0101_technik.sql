-- ---------------------------------------------------------------------------
-- PANEL TECHNIKA: KONTO ↔ KARTOTEKA TECHNIKÓW I ZNACZNIKI ROZPOCZĘCIA/ZAKOŃCZENIA
--
-- Technicy i podwykonawcy nie mieli dotąd żadnego wejścia do systemu: ich praca
-- żyła w kalendarzu technicznym, a protokół z podpisem klienta wypełniał ktoś
-- inny, po fakcie, z biura. Panel /technik to zmienia — a żeby technik zobaczył
-- WYŁĄCZNIE swoje zlecenia, musi istnieć twarde powiązanie konta z kartoteką.
--
-- `technicians.user_id` — dokładne odwzorowanie `salespeople.user_id` (migracja
-- 0088). Świadomie NIE opieramy się na dotychczasowej heurystyce nazwiskowej
-- (`findTechnicianForUser`, src/lib/calendar-queries.ts): dopasowanie po
-- `users.display_name` jest dobre do podpowiedzi asystenta, ale autoryzacja po
-- zbieżności literek to wyciek cudzych zleceń przy dwóch Kowalskich.
--
-- Indeks CZĘŚCIOWY (WHERE user_id IS NOT NULL): jedno konto = najwyżej jeden
-- technik, ale niepowiązanych techników w kartotece są dziesiątki i wszystkie
-- mają tu NULL — zwykły UNIQUE przepuszcza wiele NULL-i w SQLite, jednak wersja
-- częściowa mówi wprost, o co nam chodzi, i nie indeksuje pustych wierszy.
-- ON DELETE nie ustawiamy (domyślne NO ACTION), tak samo jak przy handlowcach:
-- kasowanie konta idzie przez panel admina, który sam zdejmuje powiązanie.
--
-- `started_at` / `finished_at` na wydarzeniu — znaczniki „Rozpocznij” i
-- „Zakończ” wciskane u klienta. CELOWO BEZ nowego statusu `in_progress`: enum
-- `CALENDAR_EVENT_STATUSES` czytają filtry, ICS, asystent AI i pół frontu, więc
-- dołożenie wartości znaczyłoby przegląd wszystkich tych miejsc. „W toku” = w
-- pełni wyliczalne: `started_at IS NOT NULL AND status <> 'done'`.
--
-- Migracja pisana RĘCZNIE (jak 0089–0092, 0098–0100) — drizzle-kit generate
-- przy tej bazie potrafi zaproponować przebudowę niezwiązanych tabel.
-- ---------------------------------------------------------------------------
ALTER TABLE `technicians` ADD `user_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `technicians_user_id_uidx` ON `technicians` (`user_id`) WHERE user_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `finished_at` text;
