import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ContractorForm } from "@/components/ContractorForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import { Plus, Search, Pencil, Trash2, Building2 } from "lucide-react";
import {
  getContractors,
  createContractor,
  updateContractor,
  deleteContractor,
  type Contractor,
  type ContractorInput,
} from "@/lib/api";

export function Contractors() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("contractors");
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(
    null
  );

  const loadContractors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getContractors({ search, pageSize: 100 });
      setContractors(res.data);
    } catch (error) {
      console.error("Error loading contractors:", error);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadContractors();
  }, [loadContractors]);

  const handleCreate = async (data: ContractorInput) => {
    if (!editable) return;
    await createContractor(data);
    loadContractors();
  };

  const handleUpdate = async (data: ContractorInput) => {
    if (!editable) return;
    if (editingContractor) {
      await updateContractor(editingContractor.id, data);
      loadContractors();
    }
  };

  const handleDelete = async (id: number) => {
    if (!editable) return;
    if (window.confirm("Czy na pewno chcesz usunac tego kontrahenta?")) {
      try {
        await deleteContractor(id);
        loadContractors();
      } catch (error) {
        alert(
          error instanceof Error
            ? error.message
            : "Nie mozna usunac kontrahenta"
        );
      }
    }
  };

  const openEditForm = (contractor: Contractor) => {
    setEditingContractor(contractor);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingContractor(null);
  };

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Kontrahenci</h1>
        {editable && (
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy kontrahent
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Szukaj kontrahenta..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8">Ladowanie...</div>
          ) : contractors.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Brak kontrahentow
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium">Nazwa</th>
                    <th className="text-left py-3 px-2 font-medium">NIP</th>
                    <th className="text-left py-3 px-2 font-medium">Miasto</th>
                    <th className="text-left py-3 px-2 font-medium">Telefon</th>
                    <th className="text-left py-3 px-2 font-medium">
                      Osoba kontaktowa
                    </th>
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {contractors.map((contractor) => (
                    <tr
                      key={contractor.id}
                      className="border-b hover:bg-muted/50"
                    >
                      <td className="py-3 px-2">
                        <button
                          className="font-medium text-primary hover:underline text-left"
                          onClick={() =>
                            navigate(`/objects?contractorId=${contractor.id}`)
                          }
                        >
                          {contractor.name}
                        </button>
                      </td>
                      <td className="py-3 px-2">{contractor.nip}</td>
                      <td className="py-3 px-2">{contractor.city || "-"}</td>
                      <td className="py-3 px-2">{contractor.phone || "-"}</td>
                      <td className="py-3 px-2">
                        {contractor.contactPerson || "-"}
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              navigate(`/objects?contractorId=${contractor.id}`)
                            }
                            title="Zobacz obiekty"
                          >
                            <Building2 className="h-4 w-4" />
                          </Button>
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditForm(contractor)}
                                title="Edytuj"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(contractor.id)}
                                title="Usun"
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
          )}
        </CardContent>
      </Card>

      <ContractorForm
        open={formOpen}
        onClose={closeForm}
        onSubmit={editingContractor ? handleUpdate : handleCreate}
        contractor={editingContractor}
      />
    </div>
  );
}
