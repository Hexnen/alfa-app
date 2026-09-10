import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
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
  FileText,
  ShieldCheck,
  ExternalLink,
  Handshake
} from "lucide-react";
import { isServicePeriodEnded, servicePeriodLabel } from "@/lib/utils";
import {
  getOrder,
  getOrderMailLog,
  isMissingEndpoint,
  type MailLogEntry,
  type Order,
} from "@/lib/api";
import { MailLogTable } from "@/components/MailLogTable";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { RichText } from "@/components/RichText";

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
  /** Dziennik wysyłek tego zlecenia — pusty także wtedy, gdy backend go nie ma. */
  const [mailLog, setMailLog] = useState<MailLogEntry[]>([]);
  const [mailLogError, setMailLogError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getOrder(parseInt(id))
      .then((res) => {
        setOrder(res.data!);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
    getOrderMailLog(parseInt(id))
      .then(setMailLog)
      .catch((e) =>
        setMailLogError(
          isMissingEndpoint(e) ? null : "Nie udało się wczytać historii wysyłek.",
        ),
      );
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

      {/* Pochodzenie z lejka handlowego — pasek nad treścią, nie karta na dole:
          to kontekst całego dokumentu („skąd to zlecenie"), a nie jego pole. */}
      {(order.leadId || order.salespersonName) && (
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900"
          data-testid="zlecenie-lead-box"
        >
          <span className="flex items-center gap-2">
            <Handshake className="h-4 w-4" />
            {order.leadId ? (
              <>
                Szansa:{" "}
                <Link
                  to={`/handlowy/leady/${order.leadId}`}
                  className="font-semibold underline underline-offset-2"
                  data-testid="zlecenie-lead-link"
                >
                  {order.leadTitle || `#${order.leadId}`}
                </Link>
              </>
            ) : (
              <span>Zlecenie spoza lejka handlowego</span>
            )}
          </span>
          {order.salespersonName && (
            <span>
              Handlowiec: <strong>{order.salespersonName}</strong>
            </span>
          )}
        </div>
      )}

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
                  <dd className="font-medium flex flex-wrap items-center gap-2">
                    {order.objectName}
                    {/* Zlecenie zakłada albo podpina obiekt — stąd skrót do
                        kartoteki, gdzie usługi da się faktycznie zmienić. */}
                    {order.objectId != null && (
                      <Link
                        to={`/objects/${order.objectId}`}
                        className="inline-flex items-center gap-1 text-xs font-normal text-primary hover:underline"
                        data-testid="order-object-link"
                      >
                        Kartoteka obiektu
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </Link>
                    )}
                  </dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Rodzaj obiektu</dt>
                  <dd className="font-medium">{order.objectKind || "-"}</dd>
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
                {/* USŁUGI ZE ZLECENIA — okresy zapamiętane przy jego tworzeniu
                    (kolumna `orders.object_services`). Zlecenia sprzed tej zmiany
                    pola nie mają, więc wtedy pokazujemy to, co dało się z nich
                    odczytać: montaż kamer i wideorecepcję. */}
                <div className="space-y-1 col-span-2">
                  <dt className="text-sm text-muted-foreground flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4" />
                    Usługi
                  </dt>
                  <dd className="font-medium" data-testid="order-object-services">
                    {order.objectServices && order.objectServices.length > 0 ? (
                      <ul className="space-y-0.5">
                        {order.objectServices.map((s, i) => (
                          <li
                            key={s.id ?? `${s.service}-${s.startDate}-${i}`}
                            data-testid={`order-service-${i}`}
                            className={
                              isServicePeriodEnded(s)
                                ? "text-muted-foreground line-through"
                                : undefined
                            }
                          >
                            {servicePeriodLabel(s)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      [
                        order.isCameraInstallation
                          ? `Kamery: ${order.cameraCount ?? 0} szt.`
                          : null,
                        order.videoReception ? "Wideo recepcja" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "-"
                    )}
                  </dd>
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
                {order.installationStartDate && (
                  <div className="space-y-1">
                    <dt className="text-sm text-muted-foreground flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      Przewidywany termin rozpoczęcia montażu
                    </dt>
                    <dd className="font-medium">
                      {new Date(order.installationStartDate).toLocaleDateString("pl-PL")}
                    </dd>
                  </div>
                )}
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Internet</dt>
                  <dd className="font-medium">{order.internetIncluded ? "Tak" : "Nie"}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Grupa interwencyjna</dt>
                  <dd className="font-medium">{order.interventionGroup ? "Tak" : "Nie"}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Wideo recepcja</dt>
                  <dd className="font-medium">{order.videoReception ? "Tak" : "Nie"}</dd>
                </div>
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
                <RichText text={order.notes} />
              </CardContent>
            </Card>
          )}

          {/* Wysłane maile — ten sam dziennik co w oknie „Podgląd maila".
              Karta stoi w szerokiej kolumnie: w wąskiej bocznej tabela ucinałaby
              status i użytkownika. */}
          {(mailLog.length > 0 || mailLogError) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="h-5 w-5 text-indigo-600" />
                  Wysłane maile
                </CardTitle>
              </CardHeader>
              <CardContent>
                {mailLogError ? (
                  <p className="text-sm text-muted-foreground">{mailLogError}</p>
                ) : (
                  <MailLogTable items={mailLog} compact />
                )}
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
                {order.payerInvoiceEmail && (
                  <div>
                    <dt className="text-sm text-muted-foreground">Mail do faktur</dt>
                    <dd className="font-medium">{order.payerInvoiceEmail}</dd>
                  </div>
                )}
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
                {order.contractLengthMonths != null && (
                  <div>
                    <dt className="text-sm text-muted-foreground">Długość kontraktu</dt>
                    <dd className="font-medium">
                      {order.contractLengthMonths} mies.
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
                {order.rentalLengthMonths != null && (
                  <div>
                    <dt className="text-sm text-muted-foreground">Długość dzierżawy</dt>
                    <dd className="font-medium">
                      {order.rentalLengthMonths} mies.
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
