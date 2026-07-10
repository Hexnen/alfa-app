import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  Building2,
  FileText,
  TrendingUp,
  Clock,
  CheckCircle,
} from "lucide-react";
import { getStats, getRecentHistory, type HistoryWithDetails } from "@/lib/api";
import { formatDateTime, formatCurrency } from "@/lib/utils";

interface Stats {
  contractors: number;
  objects: number;
  contracts: number;
  objectsByStatus: { pending: number; inProgress: number; active: number };
  objectsByDepartment: { sales: number; technical: number; accounting: number };
  monthlyRevenue: number;
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentHistory, setRecentHistory] = useState<HistoryWithDetails[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getStats(), getRecentHistory(10)])
      .then(([statsRes, historyRes]) => {
        setStats(statsRes.data!);
        setRecentHistory(historyRes.data!);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-8">Ladowanie...</div>;
  }

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
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Podsumowanie i statystyki systemu
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Kontrahenci</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.contractors || 0}</div>
            <Link
              to="/contractors"
              className="text-xs text-muted-foreground hover:underline"
            >
              Zobacz wszystkich
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Obiekty</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.objects || 0}</div>
            <Link
              to="/objects"
              className="text-xs text-muted-foreground hover:underline"
            >
              Zobacz wszystkie
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Umowy</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.contracts || 0}</div>
            <Link
              to="/contracts"
              className="text-xs text-muted-foreground hover:underline"
            >
              Zobacz wszystkie
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Przychod miesieczny
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(stats?.monthlyRevenue || 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              Z aktywnych obiektow
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Status overview */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Obiekty wg statusu</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-yellow-500" />
                  <span>Oczekujace</span>
                </div>
                <Badge variant="warning">
                  {stats?.objectsByStatus.pending || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-blue-500" />
                  <span>W realizacji</span>
                </div>
                <Badge variant="info">
                  {stats?.objectsByStatus.inProgress || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span>Aktywne</span>
                </div>
                <Badge variant="success">
                  {stats?.objectsByStatus.active || 0}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Obiekty wg dzialu</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span>Handlowy</span>
                <Badge variant="secondary">
                  {stats?.objectsByDepartment.sales || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span>Techniczny</span>
                <Badge variant="secondary">
                  {stats?.objectsByDepartment.technical || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span>Ksiegowosc</span>
                <Badge variant="secondary">
                  {stats?.objectsByDepartment.accounting || 0}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Ostatnie akcje</CardTitle>
        </CardHeader>
        <CardContent>
          {recentHistory.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">
              Brak ostatnich akcji
            </p>
          ) : (
            <div className="space-y-4">
              {recentHistory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between border-b pb-3 last:border-0"
                >
                  <div>
                    <p className="font-medium">
                      {actionLabels[item.action] || item.action}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {item.object?.name || "Nieznany obiekt"}
                      {item.contractor && ` - ${item.contractor.name}`}
                    </p>
                    {item.description && (
                      <p className="text-xs text-muted-foreground mt-1">
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
    </div>
  );
}
