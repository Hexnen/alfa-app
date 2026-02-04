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

No `.env` file is currently used; defaults are in code.

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
