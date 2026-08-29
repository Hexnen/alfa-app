import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SalespersonForm } from "@/components/SalespersonForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  Archive,
  ArchiveRestore,
  Building2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import {
  getSalespeople,
  createSalesperson,
  updateSalesperson,
  deleteSalesperson,
  type Salesperson,
  type SalespersonInput,
} from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

/**
 * Handlowcy — słownik opiekunów przypisywanych kontrahentom i obiektom.
 * Zakładki „Aktualni / Archiwalni” działają jak przy technikach: archiwum jest
 * miękkie (flaga `active`), a kasowanie możliwe tylko dla osoby bez przypisań.
 */
export function Salespeople() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("handlowcy");

  const [rows, setRows] = useState<Salesperson[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Salesperson | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getSalespeople();
      setRows(res.data ?? []);
    } catch (error) {
      console.error("Error loading salespeople:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const matches = (s: Salesperson) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [s.firstName, s.lastName, s.email, s.phone, s.region]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  };

  const visible = rows.filter(matches);
  const active = visible.filter((s) => s.active);
  const archived = visible.filter((s) => !s.active);

  const handleCreate = async (data: SalespersonInput) => {
    await createSalesperson(data);
    load();
  };

  const handleUpdate = async (data: SalespersonInput) => {
    if (!editing) return;
    await updateSalesperson(editing.id, data);
    load();
  };

  const toggleArchive = async (s: Salesperson) => {
    if (!editable) return;
    try {
      await updateSalesperson(s.id, { active: !s.active });
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie udało się zmienić statusu");
    }
  };

  const handleDelete = async (s: Salesperson) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć handlowca ${s.firstName} ${s.lastName}?`)) return;
    try {
      await deleteSalesperson(s.id);
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie można usunąć handlowca");
    }
  };

  const openEdit = (s: Salesperson) => {
    setEditing(s);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const renderTable = (list: Salesperson[], emptyText: string) => {
    if (loading) return <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>;
    if (list.length === 0) {
      return <div className="py-10 text-center text-muted-foreground">{emptyText}</div>;
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="text-left py-3 px-2 font-medium">Handlowiec</th>
              <th className="text-left py-3 px-2 font-medium">Telefon</th>
              <th className="text-left py-3 px-2 font-medium">E-mail</th>
              <th className="text-left py-3 px-2 font-medium">Region</th>
              <th className="text-right py-3 px-2 font-medium">Kontrahenci</th>
              <th
                className="text-right py-3 px-2 font-medium"
                title="Obiekty handlowca — własne oraz te, które dziedziczą go po kontrahencie"
              >
                Obiekty
              </th>
              <th
                className="text-right py-3 px-2 font-medium"
                title="Suma abonamentów z obiektów handlowca (własnych i odziedziczonych po kontrahencie)"
              >
                Portfel
              </th>
              <th className="text-right py-3 px-2 font-medium">Koszt mies.</th>
              <th className="text-right py-3 px-2 font-medium">Prowizja</th>
              <th className="text-right py-3 px-2 font-medium">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className="border-b hover:bg-muted/50">
                <td className="py-3 px-2 font-medium">
                  {`${s.firstName} ${s.lastName}`.trim()}
                  {s.notes && (
                    <span className="block text-xs text-muted-foreground">{s.notes}</span>
                  )}
                </td>
                <td className="py-3 px-2">{s.phone || "-"}</td>
                <td className="py-3 px-2">{s.email || "-"}</td>
                <td className="py-3 px-2">{s.region || "-"}</td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.contractorsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate(`/contractors?salespersonId=${s.id}`)}
                      title="Pokaż kontrahentów tego handlowca"
                    >
                      {s.contractorsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.objectsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate(`/objects?salespersonId=${s.id}`)}
                      title="Pokaż obiekty tego handlowca"
                    >
                      {s.objectsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.objectsMonthlyValue ? formatCurrency(s.objectsMonthlyValue) : "-"}
                </td>
                {/* Pusty koszt / prowizja = nieuzupełnione, nie 0 — stąd kreska. */}
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.monthlyCost === null || s.monthlyCost === undefined ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatCurrency(s.monthlyCost)
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.commissionRate === null || s.commissionRate === undefined ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    `${s.commissionRate}%`
                  )}
                </td>
                <td className="py-3 px-2">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigate(`/objects?salespersonId=${s.id}`)}
                      title="Obiekty handlowca"
                    >
                      <Building2 className="h-4 w-4" />
                    </Button>
                    {editable && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(s)}
                          title="Edytuj"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleArchive(s)}
                          title={s.active ? "Przenieś do archiwum" : "Przywróć"}
                          data-testid={`salesperson-archive-${s.id}`}
                        >
                          {s.active ? (
                            <Archive className="h-4 w-4" />
                          ) : (
                            <ArchiveRestore className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(s)}
                          title="Usuń"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj handlowca..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="h-4 w-4" />
          Opiekunowie przypisywani kontrahentom i obiektom
        </p>
        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy handlowiec
          </Button>
        )}
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as "active" | "archived")}>
        <TabsList>
          <TabsTrigger value="active">Aktualni ({active.length})</TabsTrigger>
          <TabsTrigger value="archived">Archiwalni ({archived.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(
                active,
                "Brak handlowców. Kliknij „Nowy handlowiec”, aby dodać pierwszego."
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="archived" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(archived, "Brak archiwalnych handlowców.")}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {formOpen && (
        <SalespersonForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={closeForm}
          onSubmit={editing ? handleUpdate : handleCreate}
          salesperson={editing}
        />
      )}
    </div>
  );
}
