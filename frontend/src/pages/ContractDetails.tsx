import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, FileText, Building2, User, Calendar, Coins } from "lucide-react";
import {
  getContract,
  type ContractWithDetails,
} from "@/lib/api";
import {
  contractStatusLabels,
  formatCurrency,
  formatDate,
} from "@/lib/utils";

const statusColors: Record<string, "default" | "success" | "secondary" | "destructive"> = {
  draft: "secondary",
  active: "success",
  expired: "default",
  terminated: "destructive",
};

export function ContractDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [contract, setContract] = useState<ContractWithDetails | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    getContract(parseInt(id))
      .then((res) => {
        setContract(res.data!);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="text-center py-8">Ladowanie...</div>;
  }

  if (!contract) {
    return <div className="text-center py-8">Umowa nie znaleziona</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <FileText className="h-6 w-6 text-primary" />
            <h1 className="text-3xl font-bold">{contract.contractNumber}</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            Umowa dla obiektu: {contract.object?.name || "-"}
          </p>
        </div>
        <Badge variant={statusColors[contract.status]} className="text-sm px-3 py-1">
          {contractStatusLabels[contract.status]}
        </Badge>
      </div>

      {/* Main content grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Contract details */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              Szczegóły umowy
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-6">
              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Numer umowy
                </dt>
                <dd className="font-medium text-lg">{contract.contractNumber}</dd>
              </div>
              
              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground flex items-center gap-2">
                  <Coins className="h-4 w-4" />
                  Wartość umowy
                </dt>
                <dd className="font-medium text-lg">{formatCurrency(contract.value)}</dd>
              </div>

              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Data rozpoczęcia
                </dt>
                <dd className="font-medium">{formatDate(contract.startDate) || "-"}</dd>
              </div>

              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Data zakończenia
                </dt>
                <dd className="font-medium">{formatDate(contract.endDate) || "-"}</dd>
              </div>

              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground">Status</dt>
                <dd>
                  <Badge variant={statusColors[contract.status]}>
                    {contractStatusLabels[contract.status]}
                  </Badge>
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground">Data utworzenia</dt>
                <dd className="font-medium">
                  {new Date(contract.createdAt).toLocaleDateString("pl-PL")}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Related entities */}
        <div className="space-y-6">
          {/* Object info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" />
                Obiekt
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contract.object ? (
                <div className="space-y-3">
                  <button
                    className="font-medium text-primary hover:underline text-left"
                    onClick={() => navigate(`/objects/${contract.objectId}`)}
                  >
                    {contract.object.name}
                  </button>
                  <p className="text-sm text-muted-foreground">
                    {contract.object.address || "-"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {contract.object.city || "-"}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">Brak informacji o obiekcie</p>
              )}
            </CardContent>
          </Card>

          {/* Contractor info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5 text-primary" />
                Kontrahent
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contract.contractor ? (
                <div className="space-y-3">
                  <button
                    className="font-medium text-primary hover:underline text-left"
                    onClick={() => navigate(`/objects?contractorId=${contract.contractor?.id}`)}
                  >
                    {contract.contractor.name}
                  </button>
                  <p className="text-sm text-muted-foreground">
                    NIP: {contract.contractor.nip}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {contract.contractor.city || "-"}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">Brak informacji o kontrahencie</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
