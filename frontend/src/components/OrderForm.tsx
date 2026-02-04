import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { ScrollArea } from "./ui/scroll-area";
import {
  User,
  Phone,
  Mail,
  Building2,
  MapPin,
  Camera,
  Megaphone,
  Wallet,
  FileText,
  Calendar,
  ClipboardList,
  Search,
} from "lucide-react";
import type { Order, OrderInput, Contractor, ObjectRecord } from "@/lib/api";
import { getContractors, getObjects } from "@/lib/api";

interface OrderFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: OrderInput) => Promise<void>;
  order?: Order | null;
}

const orderStatuses = [
  { value: "new", label: "Nowe", color: "bg-blue-500" },
  { value: "in_progress", label: "W trakcie", color: "bg-yellow-500" },
  { value: "completed", label: "Zakończone", color: "bg-green-500" },
  { value: "cancelled", label: "Anulowane", color: "bg-red-500" },
];

export function OrderForm({ open, onClose, onSubmit, order }: OrderFormProps) {
  const [loading, setLoading] = useState(false);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [objects, setObjects] = useState<ObjectRecord[]>([]);
  const [showContractorSearch, setShowContractorSearch] = useState(false);
  const [showObjectSearch, setShowObjectSearch] = useState(false);

  const [formData, setFormData] = useState<OrderInput>({
    requesterName: order?.requesterName || "",
    requesterPhone: order?.requesterPhone || "",
    requesterEmail: order?.requesterEmail || "",
    payerName: order?.payerName || "",
    payerNip: order?.payerNip || "",
    payerContractorId: order?.payerContractorId ?? undefined,
    objectName: order?.objectName || "",
    objectAddress: order?.objectAddress || "",
    objectCity: order?.objectCity || "",
    objectLocationUrl: order?.objectLocationUrl || "",
    objectId: order?.objectId ?? undefined,
    contactPerson: order?.contactPerson || "",
    contactPhone: order?.contactPhone || "",
    contactEmail: order?.contactEmail || "",
    isCameraInstallation: order?.isCameraInstallation || false,
    cameraCount: order?.cameraCount ?? undefined,
    megaphoneCount: order?.megaphoneCount ?? undefined,
    vtoolsOfferNumber: order?.vtoolsOfferNumber || "",
    monthlyAmount: order?.monthlyAmount || undefined,
    rentalAmount: order?.rentalAmount || undefined,
    invoiceIssuer: order?.invoiceIssuer || "",
    status: order?.status || "new",
    serviceStartDate: order?.serviceStartDate || "",
    notes: order?.notes || "",
  });

  useEffect(() => {
    if (open) {
      loadContractors();
      loadObjects();
    }
  }, [open]);

  const loadContractors = async () => {
    try {
      const response = await getContractors({ pageSize: 100 });
      setContractors(response.data);
    } catch (error) {
      console.error("Error loading contractors:", error);
    }
  };

  const loadObjects = async () => {
    try {
      const response = await getObjects({ pageSize: 100 });
      setObjects(response.data);
    } catch (error) {
      console.error("Error loading objects:", error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      console.error("Error submitting form:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value === "" ? undefined : Number(value),
    }));
  };

  const selectContractor = (contractor: Contractor) => {
    setFormData((prev) => ({
      ...prev,
      payerContractorId: contractor.id,
      payerName: contractor.name,
      payerNip: contractor.nip,
    }));
    setShowContractorSearch(false);
  };

  const selectObject = (obj: ObjectRecord) => {
    setFormData((prev) => ({
      ...prev,
      objectId: obj.id,
      objectName: obj.name,
      objectAddress: obj.address || "",
      objectCity: obj.city || "",
    }));
    setShowObjectSearch(false);
  };

  const getStatusLabel = (status: string) => {
    return orderStatuses.find((s) => s.value === status)?.label || status;
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[95vh] p-0 overflow-hidden bg-slate-50">
        <DialogHeader className="px-6 py-4 bg-white border-b border-slate-200">
          <DialogTitle className="flex items-center gap-3 text-xl font-semibold text-slate-800">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <ClipboardList className="w-5 h-5 text-indigo-600" />
            </div>
            {order ? `Zlecenie ${order.orderNumber}` : "Nowe zlecenie montażu"}
          </DialogTitle>
          {order && (
            <div className="flex items-center gap-2 mt-2">
              <Badge
                variant="secondary"
                className={`${
                  orderStatuses.find((s) => s.value === formData.status)
                    ?.color || "bg-gray-500"
                } text-white`}
              >
                {getStatusLabel(formData.status || "new")}
              </Badge>
              <span className="text-sm text-slate-500">
                Utworzono: {new Date(order.createdAt).toLocaleDateString("pl-PL")}
              </span>
            </div>
          )}
        </DialogHeader>

        <ScrollArea className="max-h-[calc(95vh-140px)]">
          <form onSubmit={handleSubmit} className="p-6 space-y-8">
            {/* Osoba zlecająca */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-slate-700">
                <User className="w-4 h-4" />
                <h3 className="font-semibold uppercase tracking-wide text-sm">
                  Osoba zlecająca
                </h3>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="requesterName" className="text-slate-700">
                    Imię i nazwisko <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="requesterName"
                    name="requesterName"
                    value={formData.requesterName}
                    onChange={handleChange}
                    required
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="requesterPhone" className="text-slate-700">
                    Telefon <span className="text-red-500">*</span>
                  </Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="requesterPhone"
                      name="requesterPhone"
                      type="tel"
                      value={formData.requesterPhone}
                      onChange={handleChange}
                      required
                      className="pl-10 bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="requesterEmail" className="text-slate-700">
                    Email <span className="text-red-500">*</span>
                  </Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="requesterEmail"
                      name="requesterEmail"
                      type="email"
                      value={formData.requesterEmail}
                      onChange={handleChange}
                      required
                      className="pl-10 bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              </div>
            </section>

            <Separator className="bg-slate-200" />

            {/* Dane płatnika */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-700">
                  <Building2 className="w-4 h-4" />
                  <h3 className="font-semibold uppercase tracking-wide text-sm">
                    Dane płatnika
                  </h3>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowContractorSearch(!showContractorSearch)}
                  className="text-indigo-600 border-indigo-200 hover:bg-indigo-50"
                >
                  <Search className="w-4 h-4 mr-1" />
                  Wybierz z bazy
                </Button>
              </div>

              {showContractorSearch && (
                <div className="p-3 bg-white border border-slate-200 rounded-lg">
                  <p className="text-sm text-slate-500 mb-2">Wybierz kontrahenta:</p>
                  <ScrollArea className="h-32">
                    <div className="space-y-1">
                      {contractors.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => selectContractor(c)}
                          className="w-full text-left px-3 py-2 text-sm rounded hover:bg-slate-100 transition-colors"
                        >
                          <span className="font-medium">{c.name}</span>
                          <span className="text-slate-500 ml-2">NIP: {c.nip}</span>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="payerName" className="text-slate-700">
                    Nazwa płatnika <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="payerName"
                    name="payerName"
                    value={formData.payerName}
                    onChange={handleChange}
                    required
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payerNip" className="text-slate-700">
                    NIP płatnika <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="payerNip"
                    name="payerNip"
                    value={formData.payerNip}
                    onChange={handleChange}
                    required
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
              </div>
            </section>

            <Separator className="bg-slate-200" />

            {/* Dane obiektu */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-700">
                  <MapPin className="w-4 h-4" />
                  <h3 className="font-semibold uppercase tracking-wide text-sm">
                    Dane obiektu
                  </h3>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowObjectSearch(!showObjectSearch)}
                  className="text-indigo-600 border-indigo-200 hover:bg-indigo-50"
                >
                  <Search className="w-4 h-4 mr-1" />
                  Wybierz z bazy
                </Button>
              </div>

              {showObjectSearch && (
                <div className="p-3 bg-white border border-slate-200 rounded-lg">
                  <p className="text-sm text-slate-500 mb-2">Wybierz obiekt:</p>
                  <ScrollArea className="h-32">
                    <div className="space-y-1">
                      {objects.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => selectObject(o)}
                          className="w-full text-left px-3 py-2 text-sm rounded hover:bg-slate-100 transition-colors"
                        >
                          <span className="font-medium">{o.name}</span>
                          <span className="text-slate-500 ml-2">
                            {o.city || ""} {o.address || ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="objectName" className="text-slate-700">
                  Nazwa obiektu w SAFESTAR <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="objectName"
                  name="objectName"
                  value={formData.objectName}
                  onChange={handleChange}
                  required
                  className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="objectAddress" className="text-slate-700">
                    Adres obiektu
                  </Label>
                  <Input
                    id="objectAddress"
                    name="objectAddress"
                    value={formData.objectAddress}
                    onChange={handleChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="objectCity" className="text-slate-700">
                    Miejscowość
                  </Label>
                  <Input
                    id="objectCity"
                    name="objectCity"
                    value={formData.objectCity}
                    onChange={handleChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="objectLocationUrl" className="text-slate-700">
                  Lokalizacja Google (URL)
                </Label>
                <Input
                  id="objectLocationUrl"
                  name="objectLocationUrl"
                  type="url"
                  value={formData.objectLocationUrl}
                  onChange={handleChange}
                  placeholder="https://maps.google.com/..."
                  className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>
            </section>

            <Separator className="bg-slate-200" />

            {/* Osoba kontaktowa na miejscu */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-slate-700">
                <User className="w-4 h-4" />
                <h3 className="font-semibold uppercase tracking-wide text-sm">
                  Osoba kontaktowa na miejscu
                </h3>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contactPerson" className="text-slate-700">
                    Imię i nazwisko <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="contactPerson"
                    name="contactPerson"
                    value={formData.contactPerson}
                    onChange={handleChange}
                    required
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactPhone" className="text-slate-700">
                    Telefon <span className="text-red-500">*</span>
                  </Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="contactPhone"
                      name="contactPhone"
                      type="tel"
                      value={formData.contactPhone}
                      onChange={handleChange}
                      required
                      className="pl-10 bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactEmail" className="text-slate-700">
                    Email
                  </Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="contactEmail"
                      name="contactEmail"
                      type="email"
                      value={formData.contactEmail}
                      onChange={handleChange}
                      className="pl-10 bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              </div>
            </section>

            <Separator className="bg-slate-200" />

            {/* Szczegóły techniczne */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-slate-700">
                <Camera className="w-4 h-4" />
                <h3 className="font-semibold uppercase tracking-wide text-sm">
                  Szczegóły techniczne
                </h3>
              </div>
              <div className="flex items-center space-x-2 p-3 bg-white border border-slate-200 rounded-lg">
                <Checkbox
                  id="isCameraInstallation"
                  checked={formData.isCameraInstallation}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({
                      ...prev,
                      isCameraInstallation: checked as boolean,
                    }))
                  }
                />
                <Label
                  htmlFor="isCameraInstallation"
                  className="text-sm font-medium cursor-pointer"
                >
                  Czy montaż kamer?
                </Label>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cameraCount" className="text-slate-700">
                    <Camera className="w-3 h-3 inline mr-1" />
                    Ilość kamer
                  </Label>
                  <Input
                    id="cameraCount"
                    name="cameraCount"
                    type="number"
                    min="0"
                    value={formData.cameraCount || ""}
                    onChange={handleNumberChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="megaphoneCount" className="text-slate-700">
                    <Megaphone className="w-3 h-3 inline mr-1" />
                    Ilość megafonów
                  </Label>
                  <Input
                    id="megaphoneCount"
                    name="megaphoneCount"
                    type="number"
                    min="0"
                    value={formData.megaphoneCount || ""}
                    onChange={handleNumberChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vtoolsOfferNumber" className="text-slate-700">
                    <FileText className="w-3 h-3 inline mr-1" />
                    Nr oferty Vtools
                  </Label>
                  <Input
                    id="vtoolsOfferNumber"
                    name="vtoolsOfferNumber"
                    value={formData.vtoolsOfferNumber}
                    onChange={handleChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
              </div>
            </section>

            <Separator className="bg-slate-200" />

            {/* Dane finansowe */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-slate-700">
                <Wallet className="w-4 h-4" />
                <h3 className="font-semibold uppercase tracking-wide text-sm">
                  Dane finansowe
                </h3>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="monthlyAmount" className="text-slate-700">
                    Ustalona kwota abonamentu (zł)
                  </Label>
                  <Input
                    id="monthlyAmount"
                    name="monthlyAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.monthlyAmount || ""}
                    onChange={handleNumberChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rentalAmount" className="text-slate-700">
                    Kwota dzierżawy (zł)
                  </Label>
                  <Input
                    id="rentalAmount"
                    name="rentalAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.rentalAmount || ""}
                    onChange={handleNumberChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invoiceIssuer" className="text-slate-700">
                    Faktury wystawia
                  </Label>
                  <Input
                    id="invoiceIssuer"
                    name="invoiceIssuer"
                    value={formData.invoiceIssuer}
                    onChange={handleChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
              </div>
            </section>

            <Separator className="bg-slate-200" />

            {/* Status i daty */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-slate-700">
                <Calendar className="w-4 h-4" />
                <h3 className="font-semibold uppercase tracking-wide text-sm">
                  Status i daty
                </h3>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="status" className="text-slate-700">
                    Status zlecenia
                  </Label>
                  <Select
                    value={formData.status}
                    onValueChange={(value) =>
                      setFormData((prev) => ({ ...prev, status: value as OrderInput["status"] }))
                    }
                  >
                    <SelectTrigger className="bg-white border-slate-300">
                      <SelectValue />
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
                <div className="space-y-2">
                  <Label htmlFor="serviceStartDate" className="text-slate-700">
                    Początek usługi
                  </Label>
                  <Input
                    id="serviceStartDate"
                    name="serviceStartDate"
                    type="date"
                    value={formData.serviceStartDate}
                    onChange={handleChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
              </div>
            </section>

            <Separator className="bg-slate-200" />

            {/* Uwagi */}
            <section className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="notes" className="text-slate-700">
                  Uwagi
                </Label>
                <Textarea
                  id="notes"
                  name="notes"
                  value={formData.notes}
                  onChange={handleChange}
                  rows={4}
                  className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>
            </section>
          </form>
        </ScrollArea>

        <DialogFooter className="px-6 py-4 bg-white border-t border-slate-200">
          <Button type="button" variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {loading ? "Zapisywanie..." : order ? "Zapisz zmiany" : "Utwórz zlecenie"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
