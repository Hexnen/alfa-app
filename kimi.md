# Alfa App - Dokumentacja

## Komendy zarządzania aplikacją (`alfa`)

Skrypt `alfa` służy do zarządzania aplikacją full-stack (React frontend + Hono backend).

### Dostępne komendy

| Komenda | Opis |
|---------|------|
| `alfa start` | Uruchamia frontend i backend w tle |
| `alfa stop` | Zatrzymuje wszystkie procesy (Vite + tsx) |
| `alfa restart` | Restartuje aplikację (stop + start) |
| `alfa status` | Sprawdza status serwerów (czy działają na portach 4000/4001) |
| `alfa logs` | Wyświetla logi z obu serwerów (Ctrl+C aby wyjść) |

### Użycie

```bash
# Uruchomienie aplikacji
alfa start

# Sprawdzenie czy działa
alfa status

# Podgląd logów
alfa logs

# Zatrzymanie aplikacji
alfa stop
```

### Adresy aplikacji

Po uruchomieniu aplikacja jest dostępna pod:

| Usługa | URL lokalny | URL zewnętrzny |
|--------|-------------|----------------|
| Frontend (React + Vite) | http://localhost:4000/ | https://ts150.korat-egret.ts.net:4000/ |
| Backend (Hono API) | http://localhost:4001/ | https://ts150.korat-egret.ts.net:4001/ |

### Logi

Logi zapisywane są do plików tymczasowych:
- Frontend: `/tmp/alfa-frontend.log`
- Backend: `/tmp/alfa-backend.log`

Podgląd logów:
```bash
# Przez komendę alfa
alfa logs

# Bezpośrednio przez tail
tail -f /tmp/alfa-frontend.log /tmp/alfa-backend.log
```

### Troubleshooting

**Port jest zajęty:**
```bash
alfa stop
sleep 2
alfa start
```

**Ręczne zatrzymanie wszystkiego:**
```bash
pkill -f "vite"
pkill -f "tsx"
```

**Sprawdzenie co działa na portach:**
```bash
netstat -tlnp | grep -E "400[01]"
```

---

## Struktura projektu

```
alfa-app/
├── alfa                  # Skrypt zarządzania aplikacją
├── kimi.md              # Ta dokumentacja
├── package.json         # Backend dependencies
├── src/                 # Kod backendu (Hono)
│   ├── index.ts        # Entry point serwera
│   └── routes/         # API routes
├── frontend/           # Kod frontendu (React + Vite)
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
└── data/               # Baza danych SQLite
```

## Technologie

- **Backend**: Hono (framework), Drizzle ORM, SQLite (better-sqlite3)
- **Frontend**: React 19, Vite, Tailwind CSS, Radix UI
- **Zarządzanie**: Node.js, tsx (TypeScript executor)
