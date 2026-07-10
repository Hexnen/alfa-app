import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Shield, UserPlus, Trash2, KeyRound, Save } from "lucide-react";
import {
  getAdminUsers,
  getAdminTabs,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  setAdminUserPassword,
  type AdminUser,
  type AdminTabDef,
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

function levelOf(perms: PermMap, key: string): Level {
  return perms[key] ?? "none";
}

/** Trzystanowy przełącznik poziomu dostępu dla jednej zakładki. */
function LevelToggle({
  value,
  disabled,
  onChange,
}: {
  value: Level;
  disabled?: boolean;
  onChange: (l: Level) => void;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {LEVELS.map((l) => (
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
    <div className="space-y-4">
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

export function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tabs, setTabs] = useState<AdminTabDef[]>(FALLBACK_TABS);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [u, t] = await Promise.all([getAdminUsers(), getAdminTabs()]);
    setUsers(u.data ?? []);
    if (t.data?.length) setTabs(t.data);
  };

  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, []);

  const selected = users.find((u) => u.id === selectedId) ?? null;

  const flashError = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="h-6 w-6" /> Administracja — użytkownicy
          </h1>
          <p className="text-sm text-muted-foreground">
            Zakładanie kont i dostęp do podzakładek (brak / podgląd / edycja).
          </p>
        </div>
        <Button
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
            </button>
          ))}
        </div>

        {/* Edytor / tworzenie */}
        <div>
          {creating ? (
            <CreateUserPanel
              tabs={tabs}
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
  busy,
  onCreate,
  onCancel,
}: {
  tabs: AdminTabDef[];
  busy: boolean;
  onCreate: (p: {
    email: string;
    password: string;
    displayName?: string;
    role: "user" | "admin";
    permissions: PermMap;
  }) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [perms, setPerms] = useState<PermMap>({});

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
            onChange={(e) => setRole(e.target.value as "user" | "admin")}
          >
            <option value="user">Użytkownik</option>
            <option value="admin">Administrator (pełny dostęp)</option>
          </select>
        </label>
      </div>

      {role === "admin" ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Administrator ma pełny dostęp do wszystkich zakładek — macierz uprawnień nieaktywna.
        </p>
      ) : (
        <PermissionMatrix tabs={tabs} perms={perms} onChange={setPerms} />
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
              permissions: role === "admin" ? {} : perms,
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
  isSelf,
  busy,
  onSave,
  onResetPassword,
  onDelete,
}: {
  user: AdminUser;
  tabs: AdminTabDef[];
  isSelf: boolean;
  busy: boolean;
  onSave: (p: { displayName: string; role: "user" | "admin"; permissions: PermMap }) => void;
  onResetPassword: (pw: string) => void;
  onDelete: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<"user" | "admin">(user.role);
  const [perms, setPerms] = useState<PermMap>(user.permissions ?? {});
  const [newPw, setNewPw] = useState("");

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
            onChange={(e) => setRole(e.target.value as "user" | "admin")}
            disabled={isSelf}
            title={isSelf ? "Nie możesz zmienić własnej roli" : undefined}
          >
            <option value="user">Użytkownik</option>
            <option value="admin">Administrator (pełny dostęp)</option>
          </select>
        </label>
      </div>

      {role === "admin" ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Administrator ma pełny dostęp do wszystkich zakładek — macierz uprawnień nieaktywna.
        </p>
      ) : (
        <PermissionMatrix tabs={tabs} perms={perms} onChange={setPerms} />
      )}

      <div className="flex justify-end">
        <Button
          disabled={busy}
          onClick={() =>
            onSave({ displayName: displayName.trim(), role, permissions: role === "admin" ? {} : perms })
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
