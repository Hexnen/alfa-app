import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ArrowLeft, Send } from "lucide-react";
import {
  getObject,
  getObjectHistory,
  transitionObject,
  type ObjectWithDetails,
  type ObjectHistoryRecord,
  type WorkflowTransition,
} from "@/lib/api";
import {
  objectTypeLabels,
  installationTypeLabels,
  statusLabels,
  departmentLabels,
  contractStatusLabels,
  formatCurrency,
  formatDate,
  formatDateTime,
} from "@/lib/utils";

const statusColors: Record<string, "warning" | "info" | "success" | "secondary"> = {
  pending: "warning",
  in_progress: "info",
  active: "success",
  inactive: "secondary",
};

const workflowOptions: Record<
  string,
  Array<{ status: string; department: string; label: string }>
> = {
  "pending-sales": [
    {
      status: "in_progress",
      department: "technical",
      label: "Przekaz do dzialu technicznego",
    },
  ],
  "in_progress-technical": [
    { status: "active", department: "accounting", label: "Zakoncz wdrozenie" },
    { status: "pending", department: "sales", label: "Zwroc do handlowego" },
  ],
  "active-accounting": [
    { status: "inactive", department: "accounting", label: "Dezaktywuj" },
  ],
};

export function ObjectDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [object, setObject] = useState<ObjectWithDetails | null>(null);
  const [history, setHistory] = useState<ObjectHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [transitionData, setTransitionData] = useState<WorkflowTransition>({
    newStatus: "pending",
    newDepartment: "sales",
    description: "",
  });

  useEffect(() => {
    if (!id) return;
    Promise.all([getObject(parseInt(id)), getObjectHistory(parseInt(id))])
      .then(([objRes, historyRes]) => {
        setObject(objRes.data!);
        setHistory(historyRes.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  const handleTransition = async () => {
    if (!object) return;
    try {
      await transitionObject(object.id, transitionData);
      const [objRes, historyRes] = await Promise.all([
        getObject(object.id),
        getObjectHistory(object.id),
      ]);
      setObject(objRes.data!);
      setHistory(historyRes.data);
      setTransitionOpen(false);
    } catch (error) {
      console.error("Error transitioning object:", error);
    }
  };

  if (loading) {
    return <div className="text-center py-8">Ladowanie...</div>;
  }

  if (!object) {
    return <div className="text-center py-8">Obiekt nie znaleziony</div>;
  }

  const currentWorkflowKey = `${object.status}-${object.department}`;
  const availableTransitions = workflowOptions[currentWorkflowKey] || [];

  const actionLabels: Record<string, string> = {
    created: "Utworzono",
    updated: "Zaktualizowano",
    transition: "Zmieniono status",
    contract_created: "Dodano umowe",
    contract_updated: "Zaktualizowano umowe",
    contract_deleted: "Usunieto umowe",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-3xl font-bold">{object.name}</h1>
        <Badge variant={statusColors[object.status]} className="ml-2">
          {statusLabels[object.status]}
        </Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main info */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Informacje o obiekcie</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-muted-foreground">Kontrahent</dt>
                <dd className="font-medium">{object.contractor?.name || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">NIP</dt>
                <dd>{object.contractor?.nip || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Adres</dt>
                <dd>{object.address || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Miasto</dt>
                <dd>{object.city || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Typ ochrony</dt>
                <dd>{objectTypeLabels[object.type]}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Typ instalacji</dt>
                <dd>{installationTypeLabels[object.installationType]}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Dzial</dt>
                <dd>
                  <Badge variant="outline">
                    {departmentLabels[object.department]}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Wartosc miesieczna
                </dt>
                <dd className="font-medium">
                  {formatCurrency(object.monthlyValue)}
                </dd>
              </div>
              {object.notes && (
                <div className="col-span-2">
                  <dt className="text-sm text-muted-foreground">Uwagi</dt>
                  <dd className="whitespace-pre-wrap">{object.notes}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {/* Workflow actions */}
        <Card>
          <CardHeader>
            <CardTitle>Akcje workflow</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {availableTransitions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Brak dostepnych akcji dla obecnego statusu
              </p>
            ) : (
              availableTransitions.map((transition) => (
                <Button
                  key={`${transition.status}-${transition.department}`}
                  className="w-full"
                  onClick={() => {
                    setTransitionData({
                      newStatus: transition.status as WorkflowTransition["newStatus"],
                      newDepartment: transition.department as WorkflowTransition["newDepartment"],
                      description: "",
                    });
                    setTransitionOpen(true);
                  }}
                >
                  <Send className="h-4 w-4 mr-2" />
                  {transition.label}
                </Button>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tabs for contracts and history */}
      <Tabs defaultValue="contracts">
        <TabsList>
          <TabsTrigger value="contracts">
            Umowy ({object.contracts.length})
          </TabsTrigger>
          <TabsTrigger value="history">Historia</TabsTrigger>
        </TabsList>
        <TabsContent value="contracts">
          <Card>
            <CardContent className="pt-6">
              {object.contracts.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  Brak umow dla tego obiektu
                </p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 font-medium">Nr umowy</th>
                      <th className="text-left py-2 font-medium">
                        Data rozpoczecia
                      </th>
                      <th className="text-left py-2 font-medium">
                        Data zakonczenia
                      </th>
                      <th className="text-right py-2 font-medium">Wartosc</th>
                      <th className="text-left py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {object.contracts.map((contract) => (
                      <tr key={contract.id} className="border-b">
                        <td className="py-2">{contract.contractNumber}</td>
                        <td className="py-2">{formatDate(contract.startDate)}</td>
                        <td className="py-2">
                          {formatDate(contract.endDate) || "-"}
                        </td>
                        <td className="py-2 text-right">
                          {formatCurrency(contract.value)}
                        </td>
                        <td className="py-2">
                          <Badge variant="outline">
                            {contractStatusLabels[contract.status]}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="history">
          <Card>
            <CardContent className="pt-6">
              {history.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  Brak historii dla tego obiektu
                </p>
              ) : (
                <div className="space-y-4">
                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start justify-between border-b pb-3 last:border-0"
                    >
                      <div>
                        <p className="font-medium">
                          {actionLabels[item.action] || item.action}
                        </p>
                        {item.description && (
                          <p className="text-sm text-muted-foreground">
                            {item.description}
                          </p>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(item.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Transition dialog */}
      <Dialog open={transitionOpen} onOpenChange={setTransitionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Zmiana statusu obiektu</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Nowy status</Label>
                <Select
                  value={transitionData.newStatus}
                  onValueChange={(value) =>
                    setTransitionData((prev) => ({
                      ...prev,
                      newStatus: value as WorkflowTransition["newStatus"],
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Nowy dzial</Label>
                <Select
                  value={transitionData.newDepartment}
                  onValueChange={(value) =>
                    setTransitionData((prev) => ({
                      ...prev,
                      newDepartment: value as WorkflowTransition["newDepartment"],
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(departmentLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Opis zmiany (opcjonalnie)</Label>
              <Textarea
                value={transitionData.description}
                onChange={(e) =>
                  setTransitionData((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransitionOpen(false)}>
              Anuluj
            </Button>
            <Button onClick={handleTransition}>Zatwierdz zmiane</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
