# Alfa App — zasady dla Claude

Szczegóły techniczne projektu (uruchamianie, stack, struktura) są w `AGENTS.md`.

## Styl odpowiedzi

- Każdą wiadomość do użytkownika kończ emotką tarczy: 🛡️

## Commity

- Commity robimy wyłącznie przez skill `/commit` — podbija wersję (`frontend/src/lib/version.ts` + `package.json`) i pilnuje formatu wiadomości.
- Każdy commit ma wpis w changelogu (`frontend/src/lib/updates.ts`), widoczny dla użytkowników na stronie „Co nowego” (`/co-nowego`).
