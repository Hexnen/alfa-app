import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Search, Eye, Pencil, Trash2 } from "lucide-react";
import {
  getContracts,
  getObjects,
  createContract,
  updateContract,
  deleteContract,
  type ContractWithDetails,
  type Contract,
  type ContractInput,
  type ObjectWithContractor,
} from "@/lib/api";
import { contractStatusLabels, formatCurrency, formatDate } from "@/lib/utils";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

const statusColors: Record<string, "default" | "success" | "secondary" | "destructive"> = {
  draft: "secondary",
  active: "success",
  expired: "default",
  terminated: "destructive",
};

export function Contracts() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("contracts");
  const [contracts, setContracts] = useState<ContractWithDetails[]>([]);
  const [objects, setObjects] = useState<ObjectWithContractor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<Contract | null>(null);
  const [formData, setFormData] = useState<ContractInput>({
    objectId: 0,
    contractNumber: "",
    startDate: "",
    endDate: "",
    value: undefined,
    status: "draft",
  });

  const loadContracts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getContracts({
        search,
        status: statusFilter !== "all" ? statusFilter : undefined,
        pageSize: 100,
      });
      setContracts(res.data);
    } catch (error) {
      console.error("Error loading contracts:", error);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  const loadObjects = useCallback(async () => {
    try {
      const res = await getObjects({ pageSize: 1000 });
      setObjects(res.data);
    } catch (error) {
      console.error("Error loading objects:", error);
    }
  }, []);

  useEffect(() => {
    loadContracts();
    loadObjects();
  }, [loadContracts, loadObjects]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editable) return;
    if (!formData.objectId) {
      alert("Wybierz obiekt");
      return;
    }
    try {
      if (editingContract) {
        await updateContract(editingContract.id, formData);
      } else {
        await createContract(formData);
      }
      loadContracts();
      closeForm();
    } catch (error) {
      console.error("Error saving contract:", error);
    }
  };

  const handleDelete = async (id: number) => {
    if (!editable) return;
    if (window.confirm("Czy na pewno chcesz usunac ta umowe?")) {
      try {
        await deleteContract(id);
        loadContracts();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie mozna usunac umowy"
        );
      }
    }
  };

  const openEditForm = (contract: ContractWithDetails) => {
    if (!editable) return;
    setEditingContract(contract);
    setFormData({
      objectId: contract.objectId,
      contractNumber: contract.contractNumber,
      startDate: contract.startDate,
      endDate: contract.endDate || "",
      value: contract.value || undefined,
      status: contract.status,
    });
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingContract(null);
    setFormData({
      objectId: 0,
      contractNumber: "",
      startDate: "",
      endDate: "",
      value: undefined,
      status: "draft",
    });
  };

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Umowy</h1>
        {editable && (
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowa umowa
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Szukaj umowy..."
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
                {Object.entries(contractStatusLabels).map(([value, label]) => (
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
          ) : contracts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Brak umow
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium">Nr umowy</th>
                    <th className="text-left py-3 px-2 font-medium">Obiekt</th>
                    <th className="text-left py-3 px-2 font-medium">
                      Kontrahent
                    </th>
                    <th className="text-left py-3 px-2 font-medium">
                      Data rozpoczecia
                    </th>
                    <th className="text-left py-3 px-2 font-medium">
                      Data zakonczenia
                    </th>
                    <th className="text-right py-3 px-2 font-medium">Wartosc</th>
                    <th className="text-left py-3 px-2 font-medium">Status</th>
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((contract) => (
                    <tr key={contract.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 px-2 font-medium">
                        {contract.contractNumber}
                      </td>
                      <td className="py-3 px-2">
                        {contract.object ? (
                          <button
                            className="text-primary hover:underline text-left"
                            onClick={() =>
                              navigate(`/objects/${contract.objectId}`)
                            }
                          >
                            {contract.object.name}
                          </button>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-3 px-2">
                        {contract.contractor?.name || "-"}
                      </td>
                      <td className="py-3 px-2">
                        {formatDate(contract.startDate)}
                      </td>
                      <td className="py-3 px-2">
                        {formatDate(contract.endDate) || "-"}
                      </td>
                      <td className="py-3 px-2 text-right">
                        {formatCurrency(contract.value)}
                      </td>
                      <td className="py-3 px-2">
                        <Badge variant={statusColors[contract.status]}>
                          {contractStatusLabels[contract.status]}
                        </Badge>
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/contracts/${contract.id}`)}
                            title="Szczegoly"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditForm(contract)}
                                title="Edytuj"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(contract.id)}
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

      {/* Contract form dialog */}
      <Dialog open={formOpen} onOpenChange={closeForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingContract ? "Edytuj umowe" : "Nowa umowa"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Obiekt *</Label>
                <Select
                  value={formData.objectId?.toString() || ""}
                  onValueChange={(value) =>
                    setFormData((prev) => ({
                      ...prev,
                      objectId: parseInt(value),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Wybierz obiekt" />
                  </SelectTrigger>
                  <SelectContent>
                    {objects.map((obj) => (
                      <SelectItem key={obj.id} value={obj.id.toString()}>
                        {obj.name} ({obj.contractor?.name || "Brak kontrahenta"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Numer umowy *</Label>
                <Input
                  value={formData.contractNumber}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      contractNumber: e.target.value,
                    }))
                  }
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Data rozpoczecia *</Label>
                  <Input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        startDate: e.target.value,
                      }))
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Data zakonczenia</Label>
                  <Input
                    type="date"
                    value={formData.endDate}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        endDate: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Wartosc (PLN)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.value || ""}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        value: e.target.value
                          ? parseFloat(e.target.value)
                          : undefined,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={formData.status}
                    onValueChange={(value) =>
                      setFormData((prev) => ({
                        ...prev,
                        status: value as ContractInput["status"],
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(contractStatusLabels).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm}>
                Anuluj
              </Button>
              <Button type="submit">Zapisz</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
