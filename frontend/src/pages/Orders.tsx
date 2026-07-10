import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { OrderForm } from "@/components/OrderForm";
import { OrderIntakeForm } from "@/components/OrderIntakeForm";
import {
  Plus,
  Search,
  Eye,
  Trash2,
  Edit3,
  ClipboardList,
  Camera,
  Phone,
  MapPin,
  Building2,
  User,
  ExternalLink,
} from "lucide-react";
import type { Order, OrderInput } from "@/lib/api";
import {
  getOrders,
  createOrder,
  updateOrder,
  deleteOrder,
} from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

const orderStatuses = [
  { value: "all", label: "Wszystkie" },
  { value: "new", label: "Nowe", color: "bg-blue-500" },
  { value: "in_progress", label: "W trakcie", color: "bg-yellow-500" },
  { value: "completed", label: "Zakończone", color: "bg-green-500" },
  { value: "cancelled", label: "Anulowane", color: "bg-red-500" },
];

export function Orders() {
  const navigate = useNavigate();
  const location = useLocation();
  const { canEdit } = usePerms();
  const editable = canEdit("orders");
  const activeTab = location.pathname.endsWith("/formularz")
    ? "formularz"
    : "lista";
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [orderToDelete, setOrderToDelete] = useState<Order | null>(null);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getOrders({
        search: search || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        page,
        pageSize,
      });
      setOrders(response.data);
      setTotal(response.total);
      setTotalPages(response.totalPages);
    } catch (error) {
      console.error("Error fetching orders:", error);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, page, pageSize]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const handleCreateOrder = async (data: OrderInput) => {
    if (!editable) return;
    await createOrder(data);
    fetchOrders();
    setIsFormOpen(false);
  };

  const handleUpdateOrder = async (data: OrderInput) => {
    if (!editable) return;
    if (editingOrder) {
      await updateOrder(editingOrder.id, data);
      fetchOrders();
      setEditingOrder(null);
    }
  };

  const handleDeleteOrder = async () => {
    if (!editable) return;
    if (orderToDelete) {
      await deleteOrder(orderToDelete.id);
      fetchOrders();
      setDeleteDialogOpen(false);
      setOrderToDelete(null);
    }
  };

  const openEditForm = (order: Order) => {
    setEditingOrder(order);
    setIsFormOpen(true);
  };

  const openDeleteDialog = (order: Order) => {
    setOrderToDelete(order);
    setDeleteDialogOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingOrder(null);
  };

  const getStatusBadge = (status: string) => {
    const statusInfo = orderStatuses.find((s) => s.value === status);
    if (!statusInfo || statusInfo.value === "all") {
      return <Badge variant="secondary">{status}</Badge>;
    }
    return (
      <Badge className={`${statusInfo.color} text-white`}>
        {statusInfo.label}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Zlecenia montażu</h1>
        <p className="text-slate-500 mt-1">
          Zarządzaj zleceniami instalacji i montażu systemów
        </p>
      </div>

      {!editable && <ReadOnlyBanner className="mb-4" />}

      {activeTab === "formularz" ? (
        editable ? (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => window.open("/formularz/zlecenie", "_blank")}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Otwórz samodzielny formularz
              </Button>
            </div>
            <OrderIntakeForm onCreated={fetchOrders} />
          </div>
        ) : (
          <div className="p-8 text-center text-slate-500">
            Brak uprawnień do tworzenia zleceń.
          </div>
        )
      ) : (
        <div className="space-y-6">
          {editable && (
            <div className="flex justify-end">
              <Button
                onClick={() => setIsFormOpen(true)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                <Plus className="w-4 h-4 mr-2" />
                Nowe zlecenie
              </Button>
            </div>
          )}

          {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Wszystkie zlecenia
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Nowe
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {orders.filter((o) => o.status === "new").length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              W trakcie
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {orders.filter((o) => o.status === "in_progress").length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Zakończone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {orders.filter((o) => o.status === "completed").length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 p-4 bg-white rounded-lg border border-slate-200">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Szukaj zleceń..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {orderStatuses.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Orders Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="font-semibold">Numer</TableHead>
              <TableHead className="font-semibold">Status</TableHead>
              <TableHead className="font-semibold">Zlecający</TableHead>
              <TableHead className="font-semibold">Obiekt</TableHead>
              <TableHead className="font-semibold">Płatnik</TableHead>
              <TableHead className="font-semibold">Techniczne</TableHead>
              <TableHead className="font-semibold">Data</TableHead>
              <TableHead className="text-right font-semibold">Akcje</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-slate-500">
                  Ładowanie...
                </TableCell>
              </TableRow>
            ) : orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-slate-500">
                  Brak zleceń. Utwórz pierwsze zlecenie używając przycisku wyżej.
                </TableCell>
              </TableRow>
            ) : (
              orders.map((order) => (
                <TableRow key={order.id} className="hover:bg-slate-50">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ClipboardList className="w-4 h-4 text-indigo-500" />
                      <span className="font-medium text-slate-900">
                        {order.orderNumber}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{getStatusBadge(order.status)}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-sm">
                        <User className="w-3 h-3 text-slate-400" />
                        <span className="font-medium text-slate-700">
                          {order.requesterName}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <Phone className="w-3 h-3" />
                        {order.requesterPhone}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-sm">
                        <MapPin className="w-3 h-3 text-slate-400" />
                        <span className="font-medium text-slate-700">
                          {order.objectName}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500">
                        {order.objectCity || "-"}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-sm">
                        <Building2 className="w-3 h-3 text-slate-400" />
                        <span className="font-medium text-slate-700">
                          {order.payerName}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500">
                        NIP: {order.payerNip}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {order.isCameraInstallation && (
                        <Badge variant="outline" className="text-xs">
                          <Camera className="w-3 h-3 mr-1" />
                          {order.cameraCount || 0} kamer
                        </Badge>
                      )}
                      {order.megaphoneCount ? (
                        <Badge variant="outline" className="text-xs">
                          {order.megaphoneCount} megafonów
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-slate-500">
                    {new Date(order.createdAt).toLocaleDateString("pl-PL")}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`/orders/${order.id}`)}
                        className="text-slate-600 hover:text-indigo-600"
                        title="Szczegóły"
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      {editable && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditForm(order)}
                            className="text-slate-600 hover:text-indigo-600"
                            title="Edytuj"
                          >
                            <Edit3 className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openDeleteDialog(order)}
                            className="text-slate-600 hover:text-red-600"
                            title="Usuń"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="border-t border-slate-200 p-4">
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className={page === 1 ? "pointer-events-none opacity-50" : ""}
                  />
                </PaginationItem>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <PaginationItem key={p}>
                    <PaginationLink
                      onClick={() => setPage(p)}
                      isActive={page === p}
                    >
                      {p}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className={
                      page === totalPages ? "pointer-events-none opacity-50" : ""
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
      </div>
        </div>
      )}

      {/* Order Form Dialog */}
      <OrderForm
        open={isFormOpen}
        onClose={closeForm}
        onSubmit={editingOrder ? handleUpdateOrder : handleCreateOrder}
        order={editingOrder}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Potwierdź usunięcie</AlertDialogTitle>
            <AlertDialogDescription>
              Czy na pewno chcesz usunąć zlecenie{" "}
              <strong>{orderToDelete?.orderNumber}</strong>? Tej operacji nie można
              cofnąć.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOrder}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Usuń
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
