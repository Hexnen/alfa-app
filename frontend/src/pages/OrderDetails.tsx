import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  ArrowLeft, 
  ClipboardList, 
  User, 
  Phone, 
  Mail, 
  Building2, 
  MapPin, 
  Camera, 
  Volume2,
  Calendar,
  Banknote,
  FileText
} from "lucide-react";
import {
  getOrder,
  type Order,
} from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

const orderStatusLabels: Record<string, string> = {
  new: "Nowe",
  in_progress: "W trakcie",
  completed: "Zakończone",
  cancelled: "Anulowane",
};

const statusColors: Record<string, "default" | "success" | "secondary" | "destructive"> = {
  new: "secondary",
  in_progress: "default",
  completed: "success",
  cancelled: "destructive",
};

export function OrderDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("orders");
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    getOrder(parseInt(id))
      .then((res) => {
        setOrder(res.data!);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="text-center py-8">Ładowanie...</div>;
  }

  if (!order) {
    return <div className="text-center py-8">Zlecenie nie znalezione</div>;
  }

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <ClipboardList className="h-6 w-6 text-indigo-600" />
            <h1 className="text-3xl font-bold">{order.orderNumber}</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            Zlecenie montażu dla: {order.objectName}
          </p>
        </div>
        <Badge 
          variant={statusColors[order.status]} 
          className="text-sm px-3 py-1"
        >
          {orderStatusLabels[order.status]}
        </Badge>
      </div>

      {/* Main content grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column - Main info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Requester info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5 text-indigo-600" />
                Zlecający
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Nazwa / Imię i nazwisko</dt>
                  <dd className="font-medium">{order.requesterName}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground flex items-center gap-2">
                    <Phone className="h-4 w-4" />
                    Telefon
                  </dt>
                  <dd className="font-medium">{order.requesterPhone}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    Email
                  </dt>
                  <dd className="font-medium">{order.requesterEmail || "-"}</dd>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Object info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-indigo-600" />
                Obiekt
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Nazwa obiektu</dt>
                  <dd className="font-medium">{order.objectName}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    Adres
                  </dt>
                  <dd className="font-medium">{order.objectAddress || "-"}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Miasto</dt>
                  <dd className="font-medium">{order.objectCity || "-"}</dd>
                </div>
                {order.objectLocationUrl && (
                  <div className="space-y-1">
                    <dt className="text-sm text-muted-foreground">Lokalizacja (URL)</dt>
                    <dd>
                      <a 
                        href={order.objectLocationUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        Zobacz na mapie
                      </a>
                    </dd>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Technical details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5 text-indigo-600" />
                Szczegóły techniczne
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-6">
                {order.isCameraInstallation && (
                  <div className="space-y-1">
                    <dt className="text-sm text-muted-foreground flex items-center gap-2">
                      <Camera className="h-4 w-4" />
                      Instalacja kamer
                    </dt>
                    <dd className="font-medium">{order.cameraCount || 0} kamer</dd>
                  </div>
                )}
                {order.megaphoneCount ? (
                  <div className="space-y-1">
                    <dt className="text-sm text-muted-foreground flex items-center gap-2">
                      <Volume2 className="h-4 w-4" />
                      Megafony
                    </dt>
                    <dd className="font-medium">{order.megaphoneCount} szt.</dd>
                  </div>
                ) : null}
                {order.vtoolsOfferNumber && (
                  <div className="space-y-1">
                    <dt className="text-sm text-muted-foreground">Nr oferty VTools</dt>
                    <dd className="font-medium">{order.vtoolsOfferNumber}</dd>
                  </div>
                )}
                {order.serviceStartDate && (
                  <div className="space-y-1">
                    <dt className="text-sm text-muted-foreground flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      Data rozpoczęcia usługi
                    </dt>
                    <dd className="font-medium">
                      {new Date(order.serviceStartDate).toLocaleDateString("pl-PL")}
                    </dd>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          {order.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-indigo-600" />
                  Uwagi
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap">{order.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column - Payer & Contact */}
        <div className="space-y-6">
          {/* Payer info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Banknote className="h-5 w-5 text-emerald-600" />
                Płatnik
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <dt className="text-sm text-muted-foreground">Nazwa</dt>
                  <dd className="font-medium">{order.payerName}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">NIP</dt>
                  <dd className="font-medium">{order.payerNip}</dd>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Contact person */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5 text-blue-600" />
                Osoba kontaktowa
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <dt className="text-sm text-muted-foreground">Imię i nazwisko</dt>
                  <dd className="font-medium">{order.contactPerson}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground flex items-center gap-2">
                    <Phone className="h-4 w-4" />
                    Telefon
                  </dt>
                  <dd className="font-medium">{order.contactPhone}</dd>
                </div>
                {order.contactEmail && (
                  <div>
                    <dt className="text-sm text-muted-foreground flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Email
                    </dt>
                    <dd className="font-medium">{order.contactEmail}</dd>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Financial info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Banknote className="h-5 w-5 text-amber-600" />
                Finanse
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {order.monthlyAmount && (
                  <div>
                    <dt className="text-sm text-muted-foreground">Kwota miesięczna</dt>
                    <dd className="font-medium text-lg">
                      {order.monthlyAmount.toLocaleString("pl-PL", {
                        style: "currency",
                        currency: "PLN",
                      })}
                    </dd>
                  </div>
                )}
                {order.rentalAmount && (
                  <div>
                    <dt className="text-sm text-muted-foreground">Kwota najmu</dt>
                    <dd className="font-medium text-lg">
                      {order.rentalAmount.toLocaleString("pl-PL", {
                        style: "currency",
                        currency: "PLN",
                      })}
                    </dd>
                  </div>
                )}
                {order.invoiceIssuer && (
                  <div>
                    <dt className="text-sm text-muted-foreground">Wystawca faktury</dt>
                    <dd className="font-medium">{order.invoiceIssuer}</dd>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Created date */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Informacje systemowe</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Utworzono:</span>
                  <span>{new Date(order.createdAt).toLocaleString("pl-PL")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Zaktualizowano:</span>
                  <span>{new Date(order.updatedAt).toLocaleString("pl-PL")}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
