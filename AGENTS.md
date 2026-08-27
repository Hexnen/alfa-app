# Alfa App - Agent Documentation

## Quick Start

To run the application, use the provided management script:

```bash
./alfa start    # Start both frontend and backend in background
./alfa stop     # Stop all processes
./alfa status   # Check if services are running
./alfa logs     # View logs
```

Or run services separately:
```bash
# Terminal 1 - Backend
npm run dev

# Terminal 2 - Frontend
cd frontend && npm run dev
```

## Project Overview

Alfa App (also referred to as "Alfa Group - System Wdrozen Obiektow Ochrony") is a full-stack web application for managing security object deployments. It provides workflow management for security companies to track contractors, objects (security installations), and contracts through various departments (sales, technical, accounting).

The application supports Polish locale and business terminology.

## Technology Stack

### Backend
- **Runtime**: Node.js with TypeScript (ES modules)
- **Framework**: [Hono](https://hono.dev/) - lightweight, fast web framework
- **Database**: SQLite via `better-sqlite3`
- **ORM**: Drizzle ORM with Drizzle Kit for migrations
- **Server**: `@hono/node-server` for production
- **Dev Tool**: `tsx` for TypeScript execution with watch mode

### Frontend
- **Framework**: React 19 (with StrictMode)
- **Build Tool**: Vite 7
- **Language**: TypeScript
- **Styling**: Tailwind CSS 3.4 with custom design tokens
- **UI Components**: Radix UI primitives (Dialog, Label, Select, Slot, Tabs)
- **Icons**: Lucide React
- **Routing**: React Router DOM 7
- **Tables**: GridJS with React wrapper

### Development Tools
- **Package Manager**: npm (with Bun configuration support)
- **Linting**: ESLint (frontend only)
- **Path Aliases**: `@/` maps to `src/` in both frontend and backend

## Project Structure

```
alfa-app/
├── alfa                    # Bash management script (Polish language)
├── package.json            # Backend dependencies and scripts
├── tsconfig.json           # Backend TypeScript config
├── drizzle.config.ts       # Drizzle ORM configuration
├── bunfig.toml            # Bun package manager config
├── data/                  # SQLite database directory (.db files, gitignored)
├── src/                   # Backend source code
│   ├── index.ts          # Server entry point
│   ├── db/               # Database layer
│   │   ├── index.ts      # Database connection setup
│   │   ├── schema.ts     # Drizzle table definitions
│   │   ├── migrate.ts    # Migration runner script
│   │   └── migrations/   # SQL migration files
│   ├── routes/           # API route handlers
│   │   ├── index.ts      # Main API router + stats endpoint
│   │   ├── contractors.ts
│   │   ├── objects.ts
│   │   ├── contracts.ts
│   │   └── history.ts
│   └── types/            # Shared TypeScript types
│       └── index.ts
├── frontend/              # React frontend (separate package)
│   ├── package.json
│   ├── vite.config.ts    # Vite config with proxy
│   ├── tailwind.config.js
│   ├── tsconfig.json     # References tsconfig.app.json & tsconfig.node.json
│   ├── index.html
│   └── src/
│       ├── main.tsx      # React entry point
│       ├── App.tsx       # Router configuration
│       ├── lib/
│       │   ├── api.ts    # API client functions
│       │   └── utils.ts  # Utility functions (cn, formatters, labels)
│       ├── components/
│       │   ├── Layout.tsx     # Sidebar navigation layout
│       │   ├── DataTable.tsx  # GridJS table wrapper
│       │   ├── ObjectForm.tsx
│       │   ├── ContractorForm.tsx
│       │   └── ui/            # shadcn/ui style components
│       │       ├── button.tsx
│       │       ├── card.tsx
│       │       ├── dialog.tsx
│       │       ├── input.tsx
│       │       ├── label.tsx
│       │       ├── select.tsx
│       │       ├── tabs.tsx
│       │       ├── textarea.tsx
│       │       └── badge.tsx
│       ├── pages/
│       │   ├── Dashboard.tsx
│       │   ├── Contractors.tsx
│       │   ├── Objects.tsx
│       │   ├── ObjectDetails.tsx
│       │   └── Contracts.tsx
│       └── styles/
│           └── globals.css    # Tailwind + CSS variables
```

## Build and Development Commands

### Backend Commands (root directory)
```bash
# Development with hot reload
npm run dev              # tsx watch src/index.ts

# Production start
npm start                # tsx src/index.ts

# Database operations
npm run db:generate      # drizzle-kit generate - creates migrations
npm run db:migrate       # tsx src/db/migrate.ts - runs migrations
npm run db:studio        # drizzle-kit studio - visual DB explorer
```

### Frontend Commands (frontend/ directory)
```bash
# Development server (port 4000, proxies /api to :4001)
npm run dev              # vite

# Production build
npm run build            # tsc -b && vite build

# Preview production build
npm run preview          # vite preview

# Linting
npm run lint             # eslint .
```

### Application Management (root directory)
The project includes an `alfa` bash script for managing both services:

```bash
./alfa start             # Start both frontend and backend in background
./alfa stop              # Stop all processes
./alfa restart           # Restart application
./alfa status            # Check if services are running
./alfa logs              # Tail logs from both services
```

Log files: `/tmp/alfa-frontend.log`, `/tmp/alfa-backend.log`

## Runtime Architecture

### Ports and URLs
| Service | Local URL | External URL | Notes |
|---------|-----------|--------------|-------|
| Frontend | http://localhost:4000 | https://ts150.korat-egret.ts.net:4000 | Vite dev server |
| Backend API | http://localhost:4001 | https://ts150.korat-egret.ts.net:4001 | Hono server |

### CORS Configuration
Backend allows requests from:
- `http://localhost:4000`
- `http://localhost:5173` (Vite default)
- `https://ts150.korat-egret.ts.net:4000`

### Database
- **Location**: `./data/alfa.db`
- **Mode**: WAL (Write-Ahead Logging) enabled
- **Foreign Keys**: Enforced

## Data Model

### Core Entities

1. **Contractors** (Kontrahenci)
   - Business entities with NIP (Polish tax ID)
   - Contact information, address details
   - Unique constraint on NIP

2. **Objects** (Obiekty)
   - Security installations belonging to contractors
   - Types: monitoring, physical, alarm, mixed
   - Installation types: new, takeover
   - Status workflow: pending → in_progress → active → inactive
   - Departments: sales, technical, accounting
   - Monthly value tracking

3. **Contracts** (Umowy)
   - Linked to objects
   - Contract numbers, dates, values
   - Status: draft, active, expired, terminated
   - File attachment support (file_path field)

4. **ObjectHistory**
   - Audit trail for all object changes
   - Tracks status transitions, updates, contract operations
   - JSON storage for old/new values

### API Response Format
All API endpoints return a consistent format:
```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
```

### Key API Endpoints
- `GET /` - Health check
- `GET /api/stats` - Dashboard statistics
- `GET /api/contractors` - List/search contractors (paginated)
- `GET /api/contractors/:id` - Get contractor details
- `GET /api/contractors/:id/objects` - Get contractor's objects
- `POST /api/contractors` - Create contractor
- `PUT /api/contractors/:id` - Update contractor
- `DELETE /api/contractors/:id` - Delete contractor
- `GET /api/objects` - List/search objects (with filters)
- `GET /api/objects/:id` - Get object with contractor and contracts
- `POST /api/objects` - Create object
- `PUT /api/objects/:id` - Update object
- `POST /api/objects/:id/transition` - Workflow transition (status/department)
- `DELETE /api/objects/:id` - Delete object
- `GET /api/contracts` - List contracts
- `POST /api/contracts` - Create contract
- `PUT /api/contracts/:id` - Update contract
- `DELETE /api/contracts/:id` - Delete contract
- `GET /api/history/object/:objectId` - Get object history
- `GET /api/history/recent` - Get recent activity across all objects

## Code Style Guidelines

### TypeScript
- Strict mode enabled
- ES2022 target, ESNext modules
- Bundler module resolution
- Path aliasing with `@/*` → `src/*`

### Naming Conventions
- Components: PascalCase (e.g., `ObjectForm.tsx`)
- Hooks: camelCase with `use` prefix
- API functions: camelCase (e.g., `getContractors`, `createObject`)
- Database tables: snake_case in SQL, camelCase in TypeScript
- Types/Interfaces: PascalCase with descriptive names

### Backend Patterns
- Route handlers use Hono's `app.get/post/put/delete` methods
- Database queries use Drizzle ORM with async/await
- Consistent error handling with ApiResponse format
- Input validation through TypeScript types

### Frontend Patterns
- Functional components with hooks
- shadcn/ui component structure (variants via class-variance-authority)
- Tailwind CSS for styling with `cn()` utility for conditional classes
- API calls centralized in `lib/api.ts`
- Polish labels/terminology in UI, English in code

### Polish UI Labels (Reference)
The frontend uses these Polish translations:
- Contractors: "Kontrahenci"
- Objects: "Obiekty"  
- Contracts: "Umowy"
- Statuses: Oczekujący (pending), W realizacji (in_progress), Aktywny (active), Nieaktywny (inactive)
- Departments: Handlowy (sales), Techniczny (technical), Księgowość (accounting)
- Object Types: Monitoring, Ochrona fizyczna (physical), Alarm, Mieszany (mixed)

## Database Migrations

Migrations are managed by Drizzle Kit:

```bash
# Generate migration after schema changes
npm run db:generate

# Apply migrations to database
npm run db:migrate

# Open visual database explorer
npm run db:studio
```

Migration files are stored in `src/db/migrations/`. The migration system:
- Uses SQL files with timestamp-based naming
- Tracks applied migrations in `_journal.json`
- Supports rollback via migration files

## Testing

**No testing framework is currently configured.** The project would benefit from:
- Backend: Vitest or Jest for API testing
- Frontend: Vitest + React Testing Library
- E2E: Playwright for workflow testing

## Security Considerations

1. **Database**: SQLite file should have restricted permissions
2. **CORS**: Currently allows multiple origins including external domains
3. **No Authentication**: The application currently has no user authentication/authorization
4. **Input Validation**: Relies on TypeScript types; runtime validation should be added (e.g., Zod)
5. **SQL Injection**: Protected by Drizzle ORM parameterized queries

## Environment Variables

The backend supports these environment variables:
- `PORT` - Server port (default: 4001)
- `HOST` - Server host (default: 0.0.0.0)
- `OPENROUTER_API_KEY`, `OPENROUTER_KEY_FILE`, `OPENROUTER_MODEL` - Asystent AI (patrz sekcja "Asystent AI (kalendarz)")

No `.env` file is currently used; defaults are in code.

## Asystent AI (kalendarz)

Chatbot dla adminów (`user.role === "admin"`) na stronie Kalendarza: proponuje wydarzenia jako karty do zatwierdzenia; zapis wyłącznie przez istniejący `POST /api/calendar/events` po kliknięciu Zatwierdź na froncie — bot nigdy nie zapisuje sam.

- Backend: `src/routes/assistant.ts` (montowane pod `/api/assistant` z `requireAdmin`), `src/lib/ai/{provider,calendarPrompt,calendarTools,context}.ts`, wspólne zapytania kalendarza w `src/lib/calendar-queries.ts`. Tabele: `assistant_chats`, `assistant_messages` (parts JSON = `UIMessage.parts`), `assistant_usage` (tokeny/czas per tura).
- Stack: Vercel AI SDK `ai@7` + `@ai-sdk/openai-compatible` (OpenRouter). `POST /api/assistant/chats/:id/message` zwraca UI Message Stream (SSE), pozostałe endpointy `{ success, data }`.
- Klucz API (kolejność): tabela `app_settings` (`assistant.api_key`, panel admina) → env `OPENROUTER_API_KEY` → plik wskazany przez `OPENROUTER_KEY_FILE` → `./data/openrouter.key` (volume `/app/data` na Dokploy). Bez klucza strumień zwraca part `data-error` z kodem `no_key`, a `GET /api/assistant/status` → `configured: false`.
- Model: DB `assistant.model` → env `OPENROUTER_MODEL` → `deepseek/deepseek-v4-flash` (musi wspierać tool-calling). Routing: DB `assistant.provider_sort` → env `OPENROUTER_PROVIDER_SORT` → `latency` (`price`, `throughput`, pusty = bez sortowania; tylko gdy baseUrl to OpenRouter). Endpoint: DB `assistant.base_url` → env `OPENROUTER_BASE_URL` → OpenRouter (dowolne API zgodne z OpenAI).
- Lokalny test: `OPENROUTER_KEY_FILE=/ścieżka/do/klucza npm run dev` — nie kopiuj klucza do repo ani do `data/` na stałe.

### Konfiguracja z panelu admina (`/admin/asystent`)

- Wszystkie ustawienia asystenta żyją w generycznej tabeli `app_settings` (key/value, `src/lib/settings.ts`: `getSetting/setSetting/deleteSetting`), klucze `assistant.*`. Precedencja KAŻDEGO pola: **DB → env → domyślne**; wartości czytane przy każdej turze (bez restartu). Jedno źródło prawdy: `src/lib/ai/assistantConfig.ts` — `ASSISTANT_FIELDS` (klucz DB, env, typ, walidacja, etykieta PL), `ASSISTANT_DEFAULTS`, `getAssistantConfig()` → `{ values, sources, isOpenRouter, enabledTools }`. Nowe pole = wpis w `ASSISTANT_FIELDS` + `ASSISTANT_DEFAULTS` + użycie w turze; front dostaje je automatycznie w `values/sources/defaults`.
- Pola: dostawca (`enabled`, `baseUrl`, `providerLabel`, `model`, `providerSort`, klucz API), generowanie (`temperature`, `maxOutputTokens`, `maxSteps`, `historyTokenBudget`, `reasoningEffort` → `providerOptions.openrouter.reasoning.effort`), prompt/osobowość (`customInstructions` — sekcja „Dodatkowe instrukcje administratora” na końcu system promptu, `personaName`, `greeting`, `suggestions` — tylko UI), reguły kalendarza (`workStart/workEnd`, `defaultDurationHours`, `allDayTypes`, `defaultStatus`, `allowRecurrence`, `maxHorizonDays` — wstrzykiwane do promptu w `calendarPrompt.ts` i jako defaults `propose_event`/limit `list_events` w `calendarTools.ts`), narzędzia (`disabledTools` — `buildCalendarTools(user, config)` pomija wyłączone; `propose_event` nie do wyłączenia), dostęp i limity (`access`: `admins` | `calendar_editors` = admin LUB edycja `technical/kalendarz`; `retentionDays` — `src/lib/ai/retention.ts`, prune przy starcie i co 24 h; `dailyTurnLimit` — z `assistant_usage` per user/dzień, przekroczenie → `data-error` `quota`).
- Dostęp do `/api/assistant/*`: middleware `requireAssistantAccess` (`src/middleware/auth.ts`, czyta `assistant.access` przy każdym żądaniu); `GET /api/assistant/status` jest dla każdego zalogowanego i zwraca `allowed`, `enabled`, `configured`, `reason`, `persona`, `access` — front chowa po nim przycisk. Bez dostępu: 403 `Brak dostępu do asystenta`.
- Endpointy admina (`src/routes/admin-assistant.ts`, `requireAdmin`, `{ success, data }`): `GET/PUT /api/admin/assistant/settings` (`{ values, sources, defaults, apiKey: { set, source, masked }, isOpenRouter, env, meta }`; PUT: pole pominięte = bez zmian, `null` = usuń z DB, `apiKey: ""` = bez zmian; błędy 400 z listą po `; `), `GET /models?refresh=1` (OpenRouter: filtr `supported_parameters ∋ tools`, ceny USD/1M; inne API: `data[].id`; cache 1 h / negatywny 60 s), `POST /test` (`generateText` bez narzędzi, zawsze HTTP 200, wynik w `data.ok`), `GET /prompt-preview`, `GET /usage?days=7|30|90` (koszt z cen z cache modeli, `costCoverage`), `GET /turns` (paginacja), `DELETE /chats` (wszystkie czaty; usage zostaje z `chat_id = NULL`).
- Każda zmiana trafia do `activity_log` (`entityType: "app_settings"`, `entityId: 0`, `field` = klucz DB, summary PL). **Bezpieczeństwo klucza:** klucz w DB jest przechowywany jawnie w SQLite (`data/alfa.db` na volume — chroń backupy), NIGDY nie wraca do frontu poza maską (`sk-or-…abcd`) i NIGDY nie trafia do `activity_log` (old/new = NULL). Błędy generacji klasyfikuje wspólny `src/lib/ai/errors.ts` (`classifyError/describeError`).

## Deployment Notes

1. **Database**: SQLite file at `./data/alfa.db` should be backed up regularly
2. **Frontend**: Build produces static files in `frontend/dist/` (already included in repo)
3. **Backend**: Node.js process with `npm start`
4. **Process Management**: Use the `alfa` script or configure as systemd services

## Common Development Tasks

### Adding a New API Endpoint
1. Add route handler in appropriate file in `src/routes/`
2. Use existing patterns for response formatting
3. Add type definitions in `src/types/index.ts` if needed

### Adding a Database Field
1. Update `src/db/schema.ts` with new column
2. Run `npm run db:generate` to create migration
3. Run `npm run db:migrate` to apply migration
4. Update types in `src/types/index.ts`
5. Update frontend types in `frontend/src/lib/api.ts`

### Adding a UI Component
1. Create component in `frontend/src/components/ui/` following shadcn patterns
2. Use `cva` for variants, `cn` for class merging
3. Re-export from component files

### Adding a New Page
1. Create page component in `frontend/src/pages/`
2. Add route in `frontend/src/App.tsx`
3. Add navigation link in `frontend/src/components/Layout.tsx` if needed
