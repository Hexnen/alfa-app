import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  servicesApi,
  SERVICE_CATEGORIES,
  type Service,
  type ServiceInput,
} from "@/lib/api";
import { ServiceForm } from "@/components/ServiceForm";
import {
  SERVICE_CATEGORY_LABEL,
  SERVICE_CATEGORY_TONE,
  SERVICE_SYSTEM_LABEL,
} from "@/components/servicesShared";
import {
  fmtPct,
  fmtPln,
} from "@/components/warehouse/warehouseShared";
import { pillClass } from "@/lib/calendar-labels";

const alertError = (err: unknown, fallback: string) =>
  window.alert(err instanceof Error ? err.message : fallback);

const selectClass =
  "flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm";

export function Uslugi() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/uslugi");

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);

  // Zawsze pobieramy komplet (z archiwum) i filtrujemy lokalnie — katalog usług
  // jest mały, a dzięki temu przełącznik „pokaż archiwum" nie odpytuje serwera.
  const load = useCallback(async () => {
    try {
      const res = await servicesApi.list({ includeInactive: true });
      setServices(res.data || []);
    } catch (err) {
      alertError(err, "Błąd wczytywania usług");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return services
      .filter((s) => showInactive || s.active)
      .filter((s) => !categoryFilter || s.category === categoryFilter)
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q)
      )
      .sort(
        (a, b) =>
          a.position - b.position || a.name.localeCompare(b.name, "pl")
      );
  }, [services, search, categoryFilter, showInactive]);

  const handleSubmit = async (data: ServiceInput) => {
    if (editing) {
      await servicesApi.update(editing.id, data);
    } else {
      await servicesApi.create(data);
    }
    await load();
  };

  const handleArchive = async (s: Service) => {
    if (!window.confirm(`Zarchiwizować usługę „${s.name}"?`)) return;
    try {
      await servicesApi.archive(s.id);
      await load();
    } catch (err) {
      alertError(err, "Błąd archiwizacji usługi");
    }
  };

  const handleRestore = async (s: Service) => {
    try {
      await servicesApi.update(s.id, {
        name: s.name,
        category: s.category,
        system: s.system ?? "",
        unit: s.unit,
        cost: s.cost,
        price: s.price,
        description: s.description ?? undefined,
        active: true,
        position: s.position,
      });
      await load();
    } catch (err) {
      alertError(err, "Błąd przywracania usługi");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Usługi</h1>
        <p className="text-sm text-muted-foreground">
          Robocizna, uruchomienia i abonamenty wchodzące do ofert. Każda pozycja
          ma koszt własny obok ceny — z tego liczy się marża oferty.
        </p>
      </div>

      {!editable && <ReadOnlyBanner className="mb-4" />}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Szukaj usługi…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <select
          className={selectClass}
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">Wszystkie kategorie</option>
          {SERVICE_CATEGORIES.map((k) => (
            <option key={k} value={k}>
              {SERVICE_CATEGORY_LABEL[k]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Pokaż zarchiwizowane
        </label>
        {editable && (
          <Button
            className="ml-auto"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> Nowa usługa
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Usługa</th>
                  <th className="px-3 py-2 font-medium">Kategoria</th>
                  <th className="px-3 py-2 font-medium">System</th>
                  <th className="px-3 py-2 font-medium">Jedn.</th>
                  <th className="px-3 py-2 text-right font-medium">Koszt</th>
                  <th className="px-3 py-2 text-right font-medium">Cena</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Marża / narzut
                  </th>
                  {editable && (
                    <th className="px-3 py-2 text-right font-medium">Akcje</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={editable ? 8 : 7}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      Ładowanie…
                    </td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={editable ? 8 : 7}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      Katalog usług jest pusty. Dodaj pierwszą pozycję, np.
                      „Montaż kamery IP".
                    </td>
                  </tr>
                ) : (
                  visible.map((s) => (
                    <tr
                      key={s.id}
                      className={`border-b last:border-0 ${
                        s.active ? "" : "opacity-60"
                      }`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{s.name}</div>
                        {s.description && (
                          <div className="text-xs text-muted-foreground">
                            {s.description}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={pillClass(SERVICE_CATEGORY_TONE[s.category])}>
                          {SERVICE_CATEGORY_LABEL[s.category]}
                        </span>
                        {!s.active && (
                          <span className={pillClass("muted", { className: "ml-1" })}>
                            archiwum
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {s.system ? SERVICE_SYSTEM_LABEL[s.system] : "—"}
                      </td>
                      <td className="px-3 py-2">{s.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtPln(s.cost)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtPln(s.price)}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        title={
                          s.marginAmount !== null
                            ? `Zysk ${fmtPln(s.marginAmount)} na ${s.unit}`
                            : "Brak kosztu lub ceny — marży nie da się policzyć"
                        }
                      >
                        {s.marginPct !== null ? (
                          <>
                            {fmtPct(s.marginPct)}
                            <span className="text-muted-foreground">
                              {" / "}
                              {fmtPct(s.markupPct)}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      {editable && (
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edytuj"
                              onClick={() => {
                                setEditing(s);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {s.active ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Archiwizuj"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => handleArchive(s)}
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Przywróć z archiwum"
                                onClick={() => handleRestore(s)}
                              >
                                <ArchiveRestore className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {formOpen && (
        <ServiceForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          onSubmit={handleSubmit}
          service={editing}
        />
      )}
    </div>
  );
}
