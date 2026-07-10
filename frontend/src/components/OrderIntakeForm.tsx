import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Checkbox } from "./ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Card, CardContent } from "./ui/card";
import { Separator } from "./ui/separator";
import { Alert, AlertDescription } from "./ui/alert";
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
  Check,
  AlertCircle,
  Plus,
} from "lucide-react";
import { createOrder, type OrderInput } from "@/lib/api";
import { autoFormatNIP, normalizeNIP, validateNIP } from "@/lib/nip";

const INVOICE_ISSUERS = [
  "ALFA GROUP SP Z O.O.",
  "ALFA GROUP S SP Z O.O.",
] as const;

interface OrderIntakeFormProps {
  /** Wywoływane po utworzeniu zlecenia — pozwala odświeżyć listę zleceń. */
  onCreated?: () => void;
}

interface IntakeFormState {
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  isCameraInstallation: boolean;
  vtoolsOfferNumber: string;
  payerName: string;
  payerNip: string;
  monthlyAmount: string;
  rentalAmount: string;
  invoiceIssuer: string;
  cameraCount: string;
  megaphoneCount: string;
  objectName: string;
  objectAddress: string;
  objectCity: string;
  objectLocationUrl: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string;
  serviceStartDate: string;
  notes: string;
}

const emptyState: IntakeFormState = {
  requesterName: "",
  requesterPhone: "",
  requesterEmail: "",
  isCameraInstallation: false,
  vtoolsOfferNumber: "",
  payerName: "",
  payerNip: "",
  monthlyAmount: "",
  rentalAmount: "",
  invoiceIssuer: INVOICE_ISSUERS[0],
  cameraCount: "",
  megaphoneCount: "",
  objectName: "",
  objectAddress: "",
  objectCity: "",
  objectLocationUrl: "",
  contactPerson: "",
  contactPhone: "",
  contactEmail: "",
  serviceStartDate: "",
  notes: "",
};

const num = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);

export function OrderIntakeForm({ onCreated }: OrderIntakeFormProps) {
  const [form, setForm] = useState<IntakeFormState>(emptyState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdNumber, setCreatedNumber] = useState<string | null>(null);

  const set = <K extends keyof IntakeFormState>(
    key: K,
    value: IntakeFormState[K]
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleInput =
    (key: keyof IntakeFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(key, e.target.value as IntakeFormState[typeof key]);

  const resetForm = () => {
    setForm(emptyState);
    setCreatedNumber(null);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validateNIP(form.payerNip)) {
      setError("Podaj prawidłowy NIP płatnika (10 cyfr).");
      return;
    }

    const payload: OrderInput = {
      requesterName: form.requesterName,
      requesterPhone: form.requesterPhone,
      requesterEmail: form.requesterEmail,
      payerName: form.payerName,
      payerNip: normalizeNIP(form.payerNip),
      objectName: form.objectName,
      objectAddress: form.objectAddress || undefined,
      objectCity: form.objectCity || undefined,
      objectLocationUrl: form.objectLocationUrl || undefined,
      contactPerson: form.contactPerson,
      contactPhone: form.contactPhone,
      contactEmail: form.contactEmail || undefined,
      isCameraInstallation: form.isCameraInstallation,
      cameraCount: num(form.cameraCount),
      megaphoneCount: num(form.megaphoneCount),
      vtoolsOfferNumber: form.isCameraInstallation
        ? form.vtoolsOfferNumber || undefined
        : undefined,
      monthlyAmount: num(form.monthlyAmount),
      rentalAmount: num(form.rentalAmount),
      invoiceIssuer: form.invoiceIssuer || undefined,
      serviceStartDate: form.serviceStartDate || undefined,
      notes: form.notes || undefined,
      status: "new",
      createContractor: true,
      createObject: true,
      objectType: "monitoring",
      objectInstallationType: "new",
    };

    setLoading(true);
    try {
      const res = await createOrder(payload);
      setCreatedNumber(res.data?.orderNumber ?? "");
      onCreated?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Wystąpił błąd podczas tworzenia zlecenia."
      );
    } finally {
      setLoading(false);
    }
  };

  if (createdNumber !== null) {
    return (
      <Card className="max-w-2xl">
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <div className="rounded-full bg-green-100 p-3">
            <Check className="h-8 w-8 text-green-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Utworzono zlecenie {createdNumber}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Zlecenie zostało zapisane i pojawi się na liście zleceń.
            </p>
          </div>
          <Button
            onClick={resetForm}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Plus className="mr-2 h-4 w-4" />
            Dodaj kolejne zlecenie
          </Button>
        </CardContent>
      </Card>
    );
  }

  const inputCls =
    "bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500";

  return (
    <Card>
      <CardContent className="p-6">
        <form onSubmit={handleSubmit} className="space-y-8">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Osoba zlecająca */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-700">
              <User className="h-4 w-4" />
              <h3 className="text-sm font-semibold uppercase tracking-wide">
                Osoba zlecająca
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="requesterName" className="text-slate-700">
                  Osoba zlecająca <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="requesterName"
                  value={form.requesterName}
                  onChange={handleInput("requesterName")}
                  required
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="requesterPhone" className="text-slate-700">
                  Telefon <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="requesterPhone"
                    type="tel"
                    value={form.requesterPhone}
                    onChange={handleInput("requesterPhone")}
                    required
                    className={`pl-10 ${inputCls}`}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="requesterEmail" className="text-slate-700">
                  Email <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="requesterEmail"
                    type="email"
                    value={form.requesterEmail}
                    onChange={handleInput("requesterEmail")}
                    required
                    className={`pl-10 ${inputCls}`}
                  />
                </div>
              </div>
            </div>
          </section>

          <Separator className="bg-slate-200" />

          {/* Szczegóły techniczne */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-700">
              <Camera className="h-4 w-4" />
              <h3 className="text-sm font-semibold uppercase tracking-wide">
                Szczegóły techniczne
              </h3>
            </div>
            <div className="flex items-center space-x-2 rounded-lg border border-slate-200 bg-white p-3">
              <Checkbox
                id="isCameraInstallation"
                checked={form.isCameraInstallation}
                onCheckedChange={(checked) =>
                  set("isCameraInstallation", checked as boolean)
                }
              />
              <Label
                htmlFor="isCameraInstallation"
                className="cursor-pointer text-sm font-medium"
              >
                Czy montaż kamer?
              </Label>
            </div>
            {form.isCameraInstallation && (
              <div className="space-y-2">
                <Label htmlFor="vtoolsOfferNumber" className="text-slate-700">
                  <FileText className="mr-1 inline h-3 w-3" />
                  Nr oferty Vtools
                </Label>
                <Input
                  id="vtoolsOfferNumber"
                  value={form.vtoolsOfferNumber}
                  onChange={handleInput("vtoolsOfferNumber")}
                  className={inputCls}
                />
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cameraCount" className="text-slate-700">
                  <Camera className="mr-1 inline h-3 w-3" />
                  Ilość kamer
                </Label>
                <Input
                  id="cameraCount"
                  type="number"
                  min="0"
                  value={form.cameraCount}
                  onChange={handleInput("cameraCount")}
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="megaphoneCount" className="text-slate-700">
                  <Megaphone className="mr-1 inline h-3 w-3" />
                  Ilość megafonów
                </Label>
                <Input
                  id="megaphoneCount"
                  type="number"
                  min="0"
                  value={form.megaphoneCount}
                  onChange={handleInput("megaphoneCount")}
                  className={inputCls}
                />
              </div>
            </div>
          </section>

          <Separator className="bg-slate-200" />

          {/* Dane płatnika */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-700">
              <Building2 className="h-4 w-4" />
              <h3 className="text-sm font-semibold uppercase tracking-wide">
                Dane płatnika
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="payerName" className="text-slate-700">
                  Nazwa płatnika <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="payerName"
                  value={form.payerName}
                  onChange={handleInput("payerName")}
                  required
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payerNip" className="text-slate-700">
                  NIP Płatnika <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="payerNip"
                  value={autoFormatNIP(form.payerNip)}
                  onChange={(e) => set("payerNip", normalizeNIP(e.target.value))}
                  placeholder="123-456-78-90"
                  maxLength={13}
                  required
                  className={inputCls}
                />
              </div>
            </div>
          </section>

          <Separator className="bg-slate-200" />

          {/* Dane finansowe */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-700">
              <Wallet className="h-4 w-4" />
              <h3 className="text-sm font-semibold uppercase tracking-wide">
                Dane finansowe
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="monthlyAmount" className="text-slate-700">
                  Ustalona kwota abonamentu (zł)
                </Label>
                <Input
                  id="monthlyAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.monthlyAmount}
                  onChange={handleInput("monthlyAmount")}
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rentalAmount" className="text-slate-700">
                  Kwota dzierżawy (zł)
                </Label>
                <Input
                  id="rentalAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.rentalAmount}
                  onChange={handleInput("rentalAmount")}
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoiceIssuer" className="text-slate-700">
                  Faktury wystawia
                </Label>
                <Select
                  value={form.invoiceIssuer}
                  onValueChange={(value) => set("invoiceIssuer", value)}
                >
                  <SelectTrigger className="bg-white border-slate-300">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INVOICE_ISSUERS.map((issuer) => (
                      <SelectItem key={issuer} value={issuer}>
                        {issuer}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <Separator className="bg-slate-200" />

          {/* Dane obiektu */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-700">
              <MapPin className="h-4 w-4" />
              <h3 className="text-sm font-semibold uppercase tracking-wide">
                Dane obiektu
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="objectName" className="text-slate-700">
                  Nazwa obiektu w SAFESTAR{" "}
                  <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="objectName"
                  value={form.objectName}
                  onChange={handleInput("objectName")}
                  required
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="objectAddress" className="text-slate-700">
                  Adres obiektu <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="objectAddress"
                  value={form.objectAddress}
                  onChange={handleInput("objectAddress")}
                  required
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="objectCity" className="text-slate-700">
                  Miejscowość <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="objectCity"
                  value={form.objectCity}
                  onChange={handleInput("objectCity")}
                  required
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="objectLocationUrl" className="text-slate-700">
                  Lokalizacja Google
                </Label>
                <Input
                  id="objectLocationUrl"
                  type="url"
                  value={form.objectLocationUrl}
                  onChange={handleInput("objectLocationUrl")}
                  placeholder="https://maps.google.com/..."
                  className={inputCls}
                />
              </div>
            </div>
          </section>

          <Separator className="bg-slate-200" />

          {/* Osoba kontaktowa */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-700">
              <User className="h-4 w-4" />
              <h3 className="text-sm font-semibold uppercase tracking-wide">
                Osoba kontaktowa
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="contactPerson" className="text-slate-700">
                  Osoba kontaktowa <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="contactPerson"
                  value={form.contactPerson}
                  onChange={handleInput("contactPerson")}
                  required
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactPhone" className="text-slate-700">
                  Telefon <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="contactPhone"
                    type="tel"
                    value={form.contactPhone}
                    onChange={handleInput("contactPhone")}
                    required
                    className={`pl-10 ${inputCls}`}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail" className="text-slate-700">
                  Adres mailowy
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="contactEmail"
                    type="email"
                    value={form.contactEmail}
                    onChange={handleInput("contactEmail")}
                    className={`pl-10 ${inputCls}`}
                  />
                </div>
              </div>
            </div>
          </section>

          <Separator className="bg-slate-200" />

          {/* Termin i uwagi */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-700">
              <Calendar className="h-4 w-4" />
              <h3 className="text-sm font-semibold uppercase tracking-wide">
                Termin i uwagi
              </h3>
            </div>
            <div className="space-y-2 md:max-w-xs">
              <Label htmlFor="serviceStartDate" className="text-slate-700">
                Początek usługi
              </Label>
              <Input
                id="serviceStartDate"
                type="date"
                value={form.serviceStartDate}
                onChange={handleInput("serviceStartDate")}
                className={inputCls}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes" className="text-slate-700">
                Uwagi
              </Label>
              <Textarea
                id="notes"
                value={form.notes}
                onChange={handleInput("notes")}
                rows={4}
                className={inputCls}
              />
            </div>
          </section>

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {loading ? "Tworzenie..." : "Utwórz zlecenie"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
