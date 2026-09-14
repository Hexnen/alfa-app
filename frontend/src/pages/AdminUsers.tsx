import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { UserPlus, Trash2, KeyRound, Save } from "lucide-react";
import {
  getAdminUsers,
  getAdminTabs,
  getAdminTechniciansLite,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  setAdminUserPassword,
  type AdminUser,
  type AdminUserRole,
  type AdminTabDef,
  type AdminTechnicianLite,
} from "@/lib/api";
import { TABS as FALLBACK_TABS } from "@/auth/permissions";
import { useAuth } from "@/auth/AuthProvider";

type Level = "none" | "view" | "edit";
type PermMap = Record<string, "view" | "edit">;

const LEVELS: { value: Level; label: string }[] = [
  { value: "none", label: "Brak" },
  { value: "view", label: "Podgląd" },
  { value: "edit", label: "Edycja" },
];

/**
 * Klucz panelu technika. Nie pokazujemy go w macierzy razem z zakładkami CRM-a,
 * bo to nie jest kolejna zakładka menu, tylko osobna aplikacja na tablet —
 * włącza się ją przełącznikiem w „Ustawieniach użytkownika”.
 */
const TECHNIK_KEY = "technik";

const ROLE_OPTIONS: { value: AdminUserRole; label: string }[] = [
  { value: "user", label: "Użytkownik" },
  { value: "technik", label: "Technik (tylko panel technika)" },
  { value: "admin", label: "Administrator (pełny dostęp)" },
];

function levelOf(perms: PermMap, key: string): Level {
  return perms[key] ?? "none";
}

/** Trzystanowy przełącznik poziomu dostępu dla jednej zakładki. */
function LevelToggle({
  value,
  disabled,
  levels = LEVELS,
  onChange,
}: {
  value: Level;
  disabled?: boolean;
  /** Zawężony zestaw poziomów (panel technika nie ma tu stanu „Brak” — od tego
   *  jest przełącznik obok). */
  levels?: { value: Level; label: string }[];
  onChange: (l: Level) => void;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {levels.map((l) => (
        <button
          key={l.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(l.value)}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            value === l.value
              ? l.value === "edit"
                ? "bg-primary text-primary-foreground"
                : l.value === "view"
                  ? "bg-amber-500 text-white"
                  : "bg-muted text-muted-foreground"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** Macierz uprawnień pogrupowana wg modułu. */
function PermissionMatrix({
  tabs,
  perms,
  disabled,
  onChange,
}: {
  tabs: AdminTabDef[];
  perms: PermMap;
  disabled?: boolean;
  onChange: (next: PermMap) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, AdminTabDef[]>();
    for (const t of tabs) {
      if (!m.has(t.group)) m.set(t.group, []);
      m.get(t.group)!.push(t);
    }
    return Array.from(m.entries());
  }, [tabs]);

  const setLevel = (key: string, level: Level) => {
    const next = { ...perms };
    if (level === "none") delete next[key];
    else next[key] = level;
    onChange(next);
  };

  const setGroup = (items: AdminTabDef[], level: Level) => {
    const next = { ...perms };
    for (const it of items) {
      if (level === "none") delete next[it.key];
      else next[it.key] = level;
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {groups.map(([group, items]) => (
        <div key={group} className="rounded-lg border">
          <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
            <span className="text-sm font-semibold">{group}</span>
            <div className="flex gap-1">
              {LEVELS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => setGroup(items, l.value)}
                  className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
                  title={`Ustaw całą grupę: ${l.label}`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="divide-y">
            {items.map((t) => (
              <div key={t.key} className="flex items-center justify-between px-3 py-1.5">
                <span className="text-sm">{t.label}</span>
                <LevelToggle
                  value={levelOf(perms, t.key)}
                  disabled={disabled}
                  onChange={(l) => setLevel(t.key, l)}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** „Jan Kowalski — podwykonawca (Alfa Serwis)” / „Jan Kowalski — wewnętrzny”. */
function technicianLabel(t: AdminTechnicianLite): string {
  const name = `${t.firstName} ${t.lastName}`.trim() || `Technik #${t.id}`;
  const kind =
    t.type === "internal"
      ? "wewnętrzny"
      : t.company
        ? `podwykonawca (${t.company})`
        : "podwykonawca";
  return `${name} — ${kind}${t.active ? "" : " · nieaktywny"}`;
}

/** Prosty przełącznik dwustanowy (repo nie ma komponentu Switch). */
function Toggle({
  checked,
  disabled,
  label,
  testid,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  testid?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testid}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-background shadow transition-all",
          checked ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/**
 * „Ustawienia użytkownika” — to, czego nie da się wyrazić macierzą zakładek:
 * kto jest kim w terenie (powiązanie z kartoteką Technicy) i czy konto biurowe
 * dostaje dodatkowo panel technika. Powiązanie jest osobno od uprawnień,
 * bo bez niego panel się otworzy, tylko nie będzie miał czyich zleceń pokazać.
 */
function UserSettings({
  role,
  technicians,
  technicianId,
  onTechnicianId,
  perms,
  onPerms,
  disabled,
  currentUserId,
}: {
  role: AdminUserRole;
  technicians: AdminTechnicianLite[];
  technicianId: number | null;
  onTechnicianId: (id: number | null) => void;
  perms: PermMap;
  onPerms: (next: PermMap) => void;
  disabled?: boolean;
  /** Konto, które właśnie edytujemy — jego własne powiązanie nie jest „zajęte”. */
  currentUserId?: number;
}) {
  const technikLevel = perms[TECHNIK_KEY];

  const setTechnikEnabled = (on: boolean) => {
    const next = { ...perms };
    if (on) next[TECHNIK_KEY] = "edit";
    else delete next[TECHNIK_KEY];
    onPerms(next);
  };

  return (
    <div className="rounded-lg border">
      <div className="border-b bg-muted/40 px-3 py-2 text-sm font-semibold">
        Ustawienia użytkownika
      </div>
      <div className="grid gap-4 p-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block text-sm">
            <span className="text-muted-foreground">Powiązany technik</span>
            <select
              className={inputCls}
              value={technicianId == null ? "" : String(technicianId)}
              disabled={disabled}
              data-testid="admin-user-technik-link"
              onChange={(e) =>
                onTechnicianId(e.target.value === "" ? null : Number(e.target.value))
              }
            >
              <option value="">(brak powiązania)</option>
              {technicians.map((t) => {
                // Jeden technik = jedno konto (UNIQUE w bazie); zajętych nie
                // pokazujemy jako wybieralnych, żeby nie zbierać 409 z backendu.
                const taken = t.userId != null && t.userId !== currentUserId;
                return (
                  <option key={t.id} value={t.id} disabled={taken}>
                    {technicianLabel(t)}
                    {taken ? " · zajęty" : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            Bez powiązania panel technika pokaże „brak przypisania” i pustą listę
            zleceń — technik widzi tylko to, do czego przypisał go kalendarz.
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="block text-sm text-muted-foreground">
            Dostęp do panelu technika
          </span>
          {role === "user" ? (
            <>
              <div className="flex items-center gap-3 pt-1">
                <Toggle
                  checked={Boolean(technikLevel)}
                  disabled={disabled}
                  label="Dostęp do panelu technika"
                  testid="admin-user-technik-access"
                  onChange={setTechnikEnabled}
                />
                <span className="text-sm">
                  {technikLevel ? "Włączony" : "Wyłączony"}
                </span>
                {technikLevel && (
                  <LevelToggle
                    value={technikLevel}
                    disabled={disabled}
                    levels={LEVELS.filter((l) => l.value !== "none")}
                    onChange={(l) =>
                      onPerms({ ...perms, [TECHNIK_KEY]: l === "edit" ? "edit" : "view" })
                    }
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Podgląd = tylko lista zleceń. Edycja = Rozpocznij/Zakończ, notatki
                i protokół z podpisem.
              </p>
            </>
          ) : role === "technik" ? (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Rola technik — panel włączony na stałe, konto nie ma dostępu do
              reszty CRM.
            </p>
          ) : (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Administrator ma pełny dostęp — panel technika włącznie.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tabs, setTabs] = useState<AdminTabDef[]>(FALLBACK_TABS);
  const [technicians, setTechnicians] = useState<AdminTechnicianLite[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    // Techników wczytujemy razem z kontami, bo po zapisie powiązania zmienia się
    // też ich lista (kto jest już zajęty).
    const [u, t, tech] = await Promise.all([
      getAdminUsers(),
      getAdminTabs(),
      getAdminTechniciansLite(),
    ]);
    setUsers(u.data ?? []);
    if (t.data?.length) setTabs(t.data);
    setTechnicians(tech.data ?? []);
  };

  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, []);

  const selected = users.find((u) => u.id === selectedId) ?? null;

  const flashError = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
          {notice}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Lista użytkowników */}
        <div className="rounded-lg border divide-y h-fit">
          <div className="p-2">
            <Button
              className="w-full"
              size="sm"
              onClick={() => {
                setCreating(true);
                setSelectedId(null);
                setError(null);
                setNotice(null);
              }}
            >
              <UserPlus className="h-4 w-4 mr-1" /> Nowy użytkownik
            </Button>
          </div>
          {users.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">Brak kont.</div>
          )}
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => {
                setSelectedId(u.id);
                setCreating(false);
                setError(null);
                setNotice(null);
              }}
              className={cn(
                "flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors",
                selectedId === u.id ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {u.displayName || u.email}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {u.email}
                </span>
              </span>
              {u.role === "admin" && (
                <span className="ml-2 shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  ADMIN
                </span>
              )}
              {u.role === "technik" && (
                <span className="ml-2 shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                  TECHNIK
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Edytor / tworzenie */}
        <div>
          {creating ? (
            <CreateUserPanel
              tabs={tabs}
              technicians={technicians}
              busy={busy}
              onCancel={() => setCreating(false)}
              onCreate={async (payload) => {
                setBusy(true);
                setError(null);
                try {
                  const res = await createAdminUser(payload);
                  await reload();
                  setCreating(false);
                  setSelectedId(res.data?.id ?? null);
                  setNotice("Utworzono konto.");
                } catch (e) {
                  flashError(e);
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : selected ? (
            <EditUserPanel
              key={selected.id}
              user={selected}
              tabs={tabs}
              technicians={technicians}
              isSelf={me?.id === selected.id}
              busy={busy}
              onSave={async (patch) => {
                setBusy(true);
                setError(null);
                try {
                  // Odsyłamy wczytaną wersję; przy kolizji (inny admin zapisał
                  // w międzyczasie) backend zwróci 409 zamiast po cichu nadpisać.
                  await updateAdminUser(selected.id, {
                    ...patch,
                    expectedVersion: selected.version,
                  });
                  await reload();
                  setNotice("Zapisano zmiany.");
                } catch (e) {
                  // Odśwież listę, by `selected.version` złapało aktualny stan —
                  // wtedy ponowny zapis (po weryfikacji zmian) przejdzie.
                  await reload().catch(() => {});
                  flashError(e);
                } finally {
                  setBusy(false);
                }
              }}
              onResetPassword={async (pw) => {
                setBusy(true);
                setError(null);
                try {
                  await setAdminUserPassword(selected.id, pw);
                  setNotice("Hasło zmienione.");
                } catch (e) {
                  flashError(e);
                } finally {
                  setBusy(false);
                }
              }}
              onDelete={async () => {
                if (!confirm(`Usunąć konto „${selected.displayName || selected.email}”?`))
                  return;
                setBusy(true);
                setError(null);
                try {
                  await deleteAdminUser(selected.id);
                  await reload();
                  setSelectedId(null);
                  setNotice("Konto usunięte.");
                } catch (e) {
                  flashError(e);
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : (
            <div className="rounded-lg border p-6 text-sm text-muted-foreground">
              Wybierz użytkownika z listy albo utwórz nowe konto.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateUserPanel({
  tabs,
  technicians,
  busy,
  onCreate,
  onCancel,
}: {
  tabs: AdminTabDef[];
  technicians: AdminTechnicianLite[];
  busy: boolean;
  onCreate: (p: {
    email: string;
    password: string;
    displayName?: string;
    role: AdminUserRole;
    permissions: PermMap;
    technicianId: number | null;
  }) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminUserRole>("user");
  const [perms, setPerms] = useState<PermMap>({});
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const matrixTabs = useMemo(() => tabs.filter((t) => t.key !== TECHNIK_KEY), [tabs]);

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <h2 className="text-lg font-semibold">Nowe konto</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Login *</span>
          <input
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="np. jkowalski"
            autoComplete="off"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Nazwa (widoczna)</span>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="np. Jan Kowalski"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Hasło * (min. 6 znaków)</span>
          <input
            type="password"
            className={inputCls}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Rola</span>
          <select
            className={inputCls}
            value={role}
            data-testid="admin-user-rola-new"
            onChange={(e) => setRole(e.target.value as AdminUserRole)}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <UserSettings
        role={role}
        technicians={technicians}
        technicianId={technicianId}
        onTechnicianId={setTechnicianId}
        perms={perms}
        onPerms={setPerms}
      />

      {role === "admin" ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Administrator ma pełny dostęp do wszystkich zakładek — macierz uprawnień nieaktywna.
        </p>
      ) : role === "technik" ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Konto technika nie wchodzi do CRM-a — macierz zakładek nie ma tu zastosowania.
        </p>
      ) : (
        <PermissionMatrix tabs={matrixTabs} perms={perms} onChange={setPerms} />
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Anuluj
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            onCreate({
              email: email.trim().toLowerCase(),
              password,
              displayName: displayName.trim() || undefined,
              role,
              // Admin i technik mają dostęp z roli, więc macierz nie ma czego
              // nieść — wysyłamy pustą, żeby nie zostawiać martwych kluczy.
              permissions: role === "user" ? perms : {},
              technicianId,
            })
          }
        >
          <UserPlus className="h-4 w-4 mr-1" /> Utwórz konto
        </Button>
      </div>
    </div>
  );
}

function EditUserPanel({
  user,
  tabs,
  technicians,
  isSelf,
  busy,
  onSave,
  onResetPassword,
  onDelete,
}: {
  user: AdminUser;
  tabs: AdminTabDef[];
  technicians: AdminTechnicianLite[];
  isSelf: boolean;
  busy: boolean;
  onSave: (p: {
    displayName: string;
    role: AdminUserRole;
    permissions: PermMap;
    technicianId: number | null;
  }) => void;
  onResetPassword: (pw: string) => void;
  onDelete: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<AdminUserRole>(user.role);
  const [perms, setPerms] = useState<PermMap>(user.permissions ?? {});
  const [technicianId, setTechnicianId] = useState<number | null>(user.technicianId ?? null);
  const [newPw, setNewPw] = useState("");
  const matrixTabs = useMemo(() => tabs.filter((t) => t.key !== TECHNIK_KEY), [tabs]);

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{user.email}</h2>
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          disabled={busy || isSelf}
          title={isSelf ? "Nie możesz usunąć własnego konta" : "Usuń konto"}
        >
          <Trash2 className="h-4 w-4 mr-1" /> Usuń
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Nazwa (widoczna)</span>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Rola</span>
          <select
            className={inputCls}
            value={role}
            data-testid="admin-user-rola"
            onChange={(e) => setRole(e.target.value as AdminUserRole)}
            disabled={isSelf}
            title={isSelf ? "Nie możesz zmienić własnej roli" : undefined}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <UserSettings
        role={role}
        technicians={technicians}
        technicianId={technicianId}
        onTechnicianId={setTechnicianId}
        perms={perms}
        onPerms={setPerms}
        currentUserId={user.id}
      />

      {role === "admin" ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Administrator ma pełny dostęp do wszystkich zakładek — macierz uprawnień nieaktywna.
        </p>
      ) : role === "technik" ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Konto technika nie wchodzi do CRM-a — macierz zakładek nie ma tu zastosowania.
        </p>
      ) : (
        <PermissionMatrix tabs={matrixTabs} perms={perms} onChange={setPerms} />
      )}

      <div className="flex justify-end">
        <Button
          disabled={busy}
          onClick={() =>
            onSave({
              displayName: displayName.trim(),
              role,
              permissions: role === "user" ? perms : {},
              technicianId,
            })
          }
        >
          <Save className="h-4 w-4 mr-1" /> Zapisz
        </Button>
      </div>

      <div className="border-t pt-4">
        <div className="text-sm font-semibold mb-2 flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Zmiana hasła
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            className={inputCls}
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="Nowe hasło (min. 6 znaków)"
            autoComplete="new-password"
          />
          <Button
            variant="outline"
            disabled={busy || newPw.length < 6}
            onClick={() => {
              onResetPassword(newPw);
              setNewPw("");
            }}
          >
            Ustaw
          </Button>
        </div>
      </div>
    </div>
  );
}
