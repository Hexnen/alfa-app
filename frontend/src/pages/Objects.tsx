import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ObjectForm } from "@/components/ObjectForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import { Plus, Search, Eye, Pencil, Trash2 } from "lucide-react";
import {
  getObjects,
  createObject,
  updateObject,
  deleteObject,
  type ObjectWithContractor,
  type ObjectInput,
} from "@/lib/api";
import {
  objectTypeLabels,
  statusLabels,
  departmentLabels,
  formatCurrency,
} from "@/lib/utils";

const statusColors: Record<string, "warning" | "info" | "success" | "secondary"> = {
  pending: "warning",
  in_progress: "info",
  active: "success",
  inactive: "secondary",
};

const departmentColors: Record<string, "default" | "secondary" | "outline"> = {
  sales: "default",
  technical: "secondary",
  accounting: "outline",
};

export function Objects() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("objects");
  const [objects, setObjects] = useState<ObjectWithContractor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [contractorFilter, setContractorFilter] = useState<number | undefined>(undefined);
  const [formOpen, setFormOpen] = useState(false);
  const [editingObject, setEditingObject] = useState<ObjectWithContractor | null>(
    null
  );

  // Read contractorId from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const contractorId = params.get("contractorId");
    if (contractorId) {
      setContractorFilter(parseInt(contractorId));
    }
  }, []);

  const loadObjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getObjects({
        search,
        status: statusFilter !== "all" ? statusFilter : undefined,
        department: departmentFilter !== "all" ? departmentFilter : undefined,
        contractorId: contractorFilter,
        pageSize: 100,
      });
      setObjects(res.data);
    } catch (error) {
      console.error("Error loading objects:", error);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, departmentFilter, contractorFilter]);

  useEffect(() => {
    loadObjects();
  }, [loadObjects]);

  const handleCreate = async (data: ObjectInput) => {
    if (!editable) return;
    await createObject(data);
    loadObjects();
  };

  const handleUpdate = async (data: ObjectInput) => {
    if (!editable) return;
    if (editingObject) {
      await updateObject(editingObject.id, data);
      loadObjects();
    }
  };

  const handleDelete = async (id: number) => {
    if (!editable) return;
    if (window.confirm("Czy na pewno chcesz usunac ten obiekt?")) {
      try {
        await deleteObject(id);
        loadObjects();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie mozna usunac obiektu"
        );
      }
    }
  };

  const openEditForm = (obj: ObjectWithContractor) => {
    setEditingObject(obj);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingObject(null);
  };

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Obiekty</h1>
        {editable && (
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy obiekt
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Szukaj obiektu..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie statusy</SelectItem>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Dzial" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie dzialy</SelectItem>
                {Object.entries(departmentLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8">Ladowanie...</div>
          ) : objects.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Brak obiektow
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium">Nazwa</th>
                    <th className="text-left py-3 px-2 font-medium">
                      Kontrahent
                    </th>
                    <th className="text-left py-3 px-2 font-medium">Miasto</th>
                    <th className="text-left py-3 px-2 font-medium">Typ</th>
                    <th className="text-left py-3 px-2 font-medium">Status</th>
                    <th className="text-left py-3 px-2 font-medium">Dzial</th>
                    <th className="text-right py-3 px-2 font-medium">
                      Wartosc mies.
                    </th>
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((obj) => (
                    <tr key={obj.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 px-2">
                        <button
                          className="font-medium text-primary hover:underline text-left"
                          onClick={() => navigate(`/objects/${obj.id}`)}
                        >
                          {obj.name}
                        </button>
                      </td>
                      <td className="py-3 px-2">
                        {obj.contractor?.name || "-"}
                      </td>
                      <td className="py-3 px-2">{obj.city || "-"}</td>
                      <td className="py-3 px-2">
                        {objectTypeLabels[obj.type] || obj.type}
                      </td>
                      <td className="py-3 px-2">
                        <Badge variant={statusColors[obj.status]}>
                          {statusLabels[obj.status] || obj.status}
                        </Badge>
                      </td>
                      <td className="py-3 px-2">
                        <Badge variant={departmentColors[obj.department]}>
                          {departmentLabels[obj.department] || obj.department}
                        </Badge>
                      </td>
                      <td className="py-3 px-2 text-right">
                        {formatCurrency(obj.monthlyValue)}
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/objects/${obj.id}`)}
                            title="Szczegoly"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditForm(obj)}
                                title="Edytuj"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(obj.id)}
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

      <ObjectForm
        open={formOpen}
        onClose={closeForm}
        onSubmit={editingObject ? handleUpdate : handleCreate}
        object={editingObject}
        preselectedContractorId={contractorFilter}
      />
    </div>
  );
}
