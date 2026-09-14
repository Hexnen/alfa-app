import { eq, ne, and, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, sessions, technicians, salespeople, type User } from "../../db/schema.js";
import { hashPassword } from "./passwords.js";
import {
  parsePermissions,
  sanitizePermissions,
  type PermissionMap,
} from "./permissions.js";

/**
 * Role kont. `users.role` jest zwykłym tekstem (bez migracji), więc to TU jest
 * jedyne źródło prawdy o dozwolonych wartościach.
 *
 * `technik` — konto technika/podwykonawcy z panelu /technik: widzi wyłącznie
 * swoje zlecenia i nic poza tym (patrz `levelFor` w ./permissions.ts oraz
 * `technikRoleGuard` w src/middleware/auth.ts).
 */
export const USER_ROLES = ["user", "admin", "technik"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Dowolne wejście → rola. Jedyna koercja w aplikacji: wcześniej każde miejsce
 * zapisu robiło własne `role === "admin" ? "admin" : "user"`, przez co dołożenie
 * trzeciej roli po cichu degradowałoby technika do zwykłego usera przy KAŻDYM
 * zapisie konta (także przy zapisie samej nazwy wyświetlanej).
 */
export function coerceRole(raw: unknown): UserRole {
  return USER_ROLES.includes(raw as UserRole) ? (raw as UserRole) : "user";
}

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: string;
  permissions: PermissionMap;
  version: number;
  createdAt?: string;
  /** Powiązany technik z kartoteki (`technicians.user_id`); null = brak powiązania. */
  technicianId: number | null;
}

/** Id technika powiązanego z kontem — NULL, gdy konta nikt nie podpiął. */
export function technicianIdOfUser(userId: number): number | null {
  return (
    db
      .select({ id: technicians.id })
      .from(technicians)
      .where(eq(technicians.userId, userId))
      .get()?.id ?? null
  );
}

/**
 * `technicianId` podajemy z zewnątrz tam, gdzie mapa jest już wczytana
 * (listUsers robi jedno zapytanie na całą listę zamiast N+1).
 */
export function publicUser(u: User, technicianId?: number | null): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    permissions: parsePermissions(u.permissions),
    version: u.version,
    createdAt: u.createdAt,
    technicianId: technicianId !== undefined ? technicianId : technicianIdOfUser(u.id),
  };
}

export function findUserByEmail(email: string): User | null {
  return db.select().from(users).where(eq(users.email, email)).get() ?? null;
}

export function findUserById(id: number): User | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

export function listUsers(): PublicUser[] {
  const rows = db.select().from(users).all();
  // Jedno zapytanie na całą listę zamiast N+1 (macierz uprawnień woła listę przy
  // każdym otwarciu panelu).
  const byUser = new Map<number, number>();
  for (const t of db
    .select({ id: technicians.id, userId: technicians.userId })
    .from(technicians)
    .where(isNotNull(technicians.userId))
    .all()) {
    if (t.userId != null) byUser.set(t.userId, t.id);
  }
  return rows.map((u) => publicUser(u, byUser.get(u.id) ?? null));
}

/** Technicy dla selecta w panelu admina (aktywni + aktualnie powiązany z kontem). */
export interface TechnicianLite {
  id: number;
  firstName: string;
  lastName: string;
  company: string | null;
  type: "internal" | "external";
  active: boolean;
  userId: number | null;
}

/**
 * Kto trzyma danego technika: id konta, `null` (wolny) albo `"notfound"`.
 * Do sprawdzenia PRZED założeniem konta — żeby oczywista pomyłka nie zostawiała
 * w bazie konta bez powiązania.
 */
export function findTechnicianOwner(technicianId: number): number | null | "notfound" {
  const row = db
    .select({ userId: technicians.userId })
    .from(technicians)
    .where(eq(technicians.id, technicianId))
    .get();
  if (!row) return "notfound";
  return row.userId ?? null;
}

export type LinkTechnicianResult =
  | { ok: true }
  | { ok: false; reason: "notfound" | "taken" };

/**
 * Ustawia powiązanie konto ↔ technik. Najpierw ZDEJMUJE dotychczasowe powiązanie
 * tego konta (jedno konto = jeden technik), potem przypina nowe — obie operacje
 * w jednej transakcji, żeby przepięcie nie zostawiło konta bez technika, gdy
 * docelowy okaże się zajęty.
 *
 * Świadomie POZA `users.version`: powiązanie nie jest polem konta, tylko kolumną
 * w kartotece techników, więc nie ma czego wersjonować przy optimistic locku.
 */
export function setUserTechnician(userId: number, technicianId: number | null): LinkTechnicianResult {
  return db.transaction((tx): LinkTechnicianResult => {
    if (technicianId != null) {
      const target = tx
        .select({ id: technicians.id, userId: technicians.userId })
        .from(technicians)
        .where(eq(technicians.id, technicianId))
        .get();
      if (!target) return { ok: false, reason: "notfound" };
      if (target.userId != null && target.userId !== userId) return { ok: false, reason: "taken" };
    }
    tx.update(technicians)
      .set({ userId: null, updatedAt: sql`(datetime('now'))` })
      .where(and(eq(technicians.userId, userId), technicianId == null ? undefined : ne(technicians.id, technicianId)))
      .run();
    if (technicianId != null) {
      tx.update(technicians)
        .set({ userId, updatedAt: sql`(datetime('now'))` })
        .where(eq(technicians.id, technicianId))
        .run();
    }
    return { ok: true };
  });
}

/** Lista techników do selecta powiązania (aktywni + ci już podpięci pod konta). */
export function listTechniciansLite(): TechnicianLite[] {
  return db
    .select({
      id: technicians.id,
      firstName: technicians.firstName,
      lastName: technicians.lastName,
      company: technicians.company,
      type: technicians.type,
      active: technicians.active,
      userId: technicians.userId,
    })
    .from(technicians)
    .all()
    .filter((t) => t.active || t.userId != null)
    .sort((a, b) =>
      `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, "pl")
    );
}

export async function createUser(email: string, password: string, displayName: string): Promise<User> {
  const passwordHash = await hashPassword(password);
  return db.insert(users).values({ email, passwordHash, displayName }).returning().get();
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role?: UserRole;
  permissions?: unknown;
}

/** Tworzy konto z pełnym zestawem pól (dla panelu admina). */
export async function createUserFull(input: CreateUserInput): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  return db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      role: coerceRole(input.role),
      permissions: JSON.stringify(sanitizePermissions(input.permissions)),
    })
    .returning()
    .get();
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  permissions?: unknown;
}

export type UpdateUserResult =
  | { ok: true; user: User }
  | { ok: false; reason: "notfound" | "conflict" };

/**
 * Aktualizuje użytkownika i bumpuje `version` w tym samym UPDATE.
 * Gdy podano `expectedVersion`, zapis wykona się tylko jeśli wiersz nadal ma tę
 * wersję (WHERE id=? AND version=?); niezgodność => { ok:false, reason:"conflict" },
 * co pozwala odróżnić kolizję (ktoś zapisał w międzyczasie — 409) od zniknięcia
 * wiersza (równoległy DELETE — 404). Bez `expectedVersion` zachowuje się jak
 * zwykły update (wciąż bumpuje wersję), by starzy klienci działali.
 */
export function updateUser(
  id: number,
  input: UpdateUserInput,
  expectedVersion?: number,
): UpdateUserResult {
  const patch: Partial<User> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.role !== undefined) patch.role = coerceRole(input.role);
  if (input.permissions !== undefined)
    patch.permissions = JSON.stringify(sanitizePermissions(input.permissions));
  if (Object.keys(patch).length === 0) {
    const current = findUserById(id);
    return current ? { ok: true, user: current } : { ok: false, reason: "notfound" };
  }

  const where =
    expectedVersion === undefined
      ? eq(users.id, id)
      : and(eq(users.id, id), eq(users.version, expectedVersion));
  const updated = db
    .update(users)
    .set({ ...patch, version: sql`${users.version} + 1` })
    .where(where)
    .returning()
    .get();
  if (updated) return { ok: true, user: updated };
  // 0 wierszy: albo user zniknął (404), albo wersja się nie zgadza (409).
  return { ok: false, reason: findUserById(id) ? "conflict" : "notfound" };
}

export async function setUserPassword(id: number, password: string): Promise<void> {
  // Reset hasła i unieważnienie sesji muszą pójść razem — inaczej użytkownik
  // z aktywnym tokenem pozostaje zalogowany (getSessionUser uwierzytelnia po
  // tokenie, nie po haśle). Robimy to w jednej synchronicznej transakcji, żeby
  // równoległe żądanie nie zobaczyło nowego hasła przy wciąż żywej sesji.
  // Hash liczymy PRZED otwarciem transakcji — scrypt trwa ~50-100ms, a
  // trzymanie blokady zapisu przez cały czas haszowania serializowałoby resety
  // i blokowało zewnętrznych piszących (backup/CLI) na czas obliczeń.
  //
  // Token ICS też leci: to trzecia „sesja" tego konta (feed kalendarza czyta po
  // nim bez hasła), więc reset hasła po przejęciu konta zostawiałby
  // napastnikowi działający feed z wydarzeniami i urlopami. Użytkownik
  // wygeneruje nowy jednym klikiem w kalendarzu.
  //
  // Z tego samego powodu leci token wtyczki magazynu: to CZWARTA „sesja"
  // (Bearer na /api/plugin/*, bez hasła i bez cookie), a paczka z wtyczką
  // mogła zostać na cudzym komputerze. Nowy token powstaje przy kolejnym
  // pobraniu paczki z /technical/magazyn.
  const passwordHash = await hashPassword(password);
  db.transaction((tx) => {
    tx
      .update(users)
      .set({ passwordHash, calendarToken: null, pluginToken: null, pluginTokenCreatedAt: null })
      .where(eq(users.id, id))
      .run();
    tx.delete(sessions).where(eq(sessions.userId, id)).run();
  });
}

/**
 * Unieważnia token subskrypcji ICS — feed przestaje działać natychmiast.
 * Dla admina: gdy link do kalendarza wyciekł, a resetu hasła nie chcemy.
 * Zwraca false, gdy użytkownika nie ma.
 */
export function revokeCalendarToken(id: number): boolean {
  const res = db.update(users).set({ calendarToken: null }).where(eq(users.id, id)).run();
  return res.changes > 0;
}

/**
 * Zdejmuje powiązania konta z kartotekami osób (technicy, handlowcy).
 *
 * MUSI iść PRZED usunięciem konta: obie kolumny `user_id` są zwykłymi kluczami
 * obcymi bez ON DELETE (migracje 0088 i 0101), więc SQLite z włączonymi kluczami
 * obcymi odrzuca DELETE użytkownika, który jest gdzieś podpięty — panel admina
 * dostawał wtedy 500 zamiast usunąć konto.
 *
 * Kartoteki zostają nietknięte poza wyzerowanym powiązaniem: technik dalej ma
 * swoje zlecenia, handlowiec swój portfel — znika tylko login do nich.
 */
export function unlinkUserFromDirectories(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: number): void {
  tx.update(technicians)
    .set({ userId: null, updatedAt: sql`(datetime('now'))` })
    .where(eq(technicians.userId, id))
    .run();
  tx.update(salespeople)
    .set({ userId: null, updatedAt: sql`(datetime('now'))` })
    .where(eq(salespeople.userId, id))
    .run();
}

export function deleteUser(id: number): void {
  db.transaction((tx) => {
    unlinkUserFromDirectories(tx, id);
    tx.delete(users).where(eq(users.id, id)).run();
  });
}

/** Liczba pozostałych adminów poza wskazanym użytkownikiem — chroni przed usunięciem/degradacją ostatniego admina. */
export function otherAdminsCount(excludeId: number): number {
  return db
    .select()
    .from(users)
    .where(and(eq(users.role, "admin"), ne(users.id, excludeId)))
    .all().length;
}
