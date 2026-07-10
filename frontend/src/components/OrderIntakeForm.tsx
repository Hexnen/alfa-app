import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Card, CardContent } from "./ui/card";
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
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Send,
} from "lucide-react";
import { createOrder, type OrderInput } from "@/lib/api";
import { autoFormatNIP, normalizeNIP, validateNIP } from "@/lib/nip";
import {
  INVOICE_ISSUERS,
  OBJECT_KINDS,
  emptyIntakeState,
  useOrderIntakeWizard,
  type OrderIntakeFormState,
} from "@/lib/orderIntakeSteps";
import { LocationPicker } from "./LocationPicker";

interface OrderIntakeFormProps {
  /** Wywoływane po utworzeniu zlecenia — pozwala odświeżyć listę zleceń. */
  onCreated?: () => void;
}

const num = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);

const inputCls =
  "bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500";

/** Small yes/no segmented toggle in the app's slate/indigo theme. */
function YesNoToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const base =
    "rounded-md px-4 py-1.5 text-sm font-medium transition-colors border";
  return (
    <div className="inline-flex gap-2">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`${base} ${
          value
            ? "bg-indigo-600 border-indigo-600 text-white"
            : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"
        }`}
      >
        Tak
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`${base} ${
          !value
            ? "bg-indigo-600 border-indigo-600 text-white"
            : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"
        }`}
      >
        Nie
      </button>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  children,
}: {
  icon: typeof User;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-slate-700">
      <Icon className="h-4 w-4" />
      <h3 className="text-sm font-semibold uppercase tracking-wide">
        {children}
      </h3>
    </div>
  );
}

export function OrderIntakeForm({ onCreated }: OrderIntakeFormProps) {
  const [form, setForm] = useState<OrderIntakeFormState>(emptyIntakeState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdNumber, setCreatedNumber] = useState<string | null>(null);

  const wizard = useOrderIntakeWizard(form);

  const set = <K extends keyof OrderIntakeFormState>(
    key: K,
    value: OrderIntakeFormState[K]
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleInput =
    (key: keyof OrderIntakeFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(key, e.target.value as OrderIntakeFormState[typeof key]);

  const resetForm = () => {
    setForm(emptyIntakeState);
    setCreatedNumber(null);
    setError(null);
    wizard.reset();
  };

  const handleNext = () => {
    const result = wizard.validateCurrent();
    if (!result.ok) {
      setError(result.message ?? "Uzupełnij wymagane pola.");
      return;
    }
    setError(null);
    wizard.next();
  };

  const handleBack = () => {
    setError(null);
    wizard.back();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // If not on the last step, "Enter" acts as Dalej.
    if (!wizard.isLast) {
      handleNext();
      return;
    }

    const result = wizard.validateCurrent();
    if (!result.ok) {
      setError(result.message ?? "Uzupełnij wymagane pola.");
      return;
    }
    if (!validateNIP(form.payerNip)) {
      setError("Podaj prawidłowy NIP płatnika (10 cyfr).");
      return;
    }
    setError(null);

    const payload: OrderInput = {
      requesterName: form.requesterName,
      requesterPhone: form.requesterPhone,
      requesterEmail: form.requesterEmail,
      payerName: form.payerName,
      payerNip: normalizeNIP(form.payerNip),
      objectName: form.objectName,
      objectKind: form.objectKind || undefined,
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
      internetIncluded: form.internetIncluded,
      interventionGroup: form.interventionGroup,
      videoReception: form.videoReception,
      installationStartDate: form.isCameraInstallation
        ? form.installationStartDate || undefined
        : undefined,
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

  const { currentStep, stepIndex, totalSteps, isFirst, isLast } = wizard;
  const progress = ((stepIndex + 1) / totalSteps) * 100;

  return (
    <Card>
      <CardContent className="p-6">
        {/* Step indicator */}
        <div className="mb-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
              Krok {stepIndex + 1} z {totalSteps}
            </span>
            <span className="text-sm font-semibold text-slate-900">
              {currentStep.title}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Step 1: Osoba zlecająca */}
          {currentStep.id === "requester" && (
            <section className="space-y-4">
              <SectionHeader icon={User}>Osoba zlecająca</SectionHeader>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="requesterName" className="text-slate-700">
                    Osoba zlecająca <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="requesterName"
                    value={form.requesterName}
                    onChange={handleInput("requesterName")}
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
                      className={`pl-10 ${inputCls}`}
                    />
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Step 2: Kontrahent (płatnik) */}
          {currentStep.id === "payer" && (
            <section className="space-y-4">
              <SectionHeader icon={Building2}>Kontrahent (płatnik)</SectionHeader>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="payerName" className="text-slate-700">
                    Nazwa płatnika <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="payerName"
                    value={form.payerName}
                    onChange={handleInput("payerName")}
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
                    className={inputCls}
                  />
                </div>
              </div>
              <div className="space-y-2 md:max-w-md">
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
            </section>
          )}

          {/* Step 3: Pytania */}
          {currentStep.id === "questions" && (
            <section className="space-y-4">
              <SectionHeader icon={HelpCircle}>Pytania</SectionHeader>
              <div className="space-y-3">
                {[
                  {
                    key: "isCameraInstallation" as const,
                    label: "Potrzebny montaż?",
                  },
                  { key: "internetIncluded" as const, label: "Internet?" },
                  {
                    key: "interventionGroup" as const,
                    label: "Grupa interwencyjna?",
                  },
                ].map((q) => (
                  <div
                    key={q.key}
                    className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3"
                  >
                    <Label className="text-sm font-medium text-slate-700">
                      {q.label}
                    </Label>
                    <YesNoToggle
                      value={form[q.key]}
                      onChange={(v) => set(q.key, v)}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Step 4: Dane obiektu */}
          {currentStep.id === "object" && (
            <section className="space-y-4">
              <SectionHeader icon={MapPin}>Dane obiektu</SectionHeader>
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
                    className={inputCls}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="objectKind" className="text-slate-700">
                    Rodzaj obiektu
                  </Label>
                  <Select
                    value={form.objectKind || undefined}
                    onValueChange={(value) => set("objectKind", value)}
                  >
                    <SelectTrigger id="objectKind" className="bg-white border-slate-300">
                      <SelectValue placeholder="— wybierz —" />
                    </SelectTrigger>
                    <SelectContent>
                      {OBJECT_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {kind}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <LocationPicker
                variant="light"
                value={form.objectLocationUrl}
                onChange={(url) => set("objectLocationUrl", url)}
              />

              <div className="pt-2">
                <SectionHeader icon={User}>
                  Osoba kontaktowa na miejscu
                </SectionHeader>
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
          )}

          {/* Step 5: Montaż (only when isCameraInstallation) */}
          {currentStep.id === "installation" && (
            <section className="space-y-4">
              <SectionHeader icon={Camera}>Montaż</SectionHeader>
              <div className="space-y-2 md:max-w-md">
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
            </section>
          )}

          {/* Step 6: Zakres i warunki usługi */}
          {currentStep.id === "scope" && (
            <section className="space-y-4">
              <SectionHeader icon={Wallet}>
                Zakres i warunki usługi
              </SectionHeader>
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
                <div className="space-y-2">
                  <Label htmlFor="monthlyAmount" className="text-slate-700">
                    Abonament (zł)
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
                    Dzierżawa (zł)
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
              </div>
              <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3 md:max-w-md">
                <Label className="text-sm font-medium text-slate-700">
                  Wideo recepcja
                </Label>
                <YesNoToggle
                  value={form.videoReception}
                  onChange={(v) => set("videoReception", v)}
                />
              </div>

              {/* Read-only recap of step-3 answers */}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <span>
                    Internet:{" "}
                    <strong className="text-slate-900">
                      {form.internetIncluded ? "Tak" : "Nie"}
                    </strong>
                  </span>
                  <span>
                    Grupa interwencyjna:{" "}
                    <strong className="text-slate-900">
                      {form.interventionGroup ? "Tak" : "Nie"}
                    </strong>
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* Step 7: Terminy */}
          {currentStep.id === "terms" && (
            <section className="space-y-4">
              <SectionHeader icon={Calendar}>Terminy</SectionHeader>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {form.isCameraInstallation && (
                  <div className="space-y-2">
                    <Label
                      htmlFor="installationStartDate"
                      className="text-slate-700"
                    >
                      Przewidywany termin rozpoczęcia montażu
                    </Label>
                    <Input
                      id="installationStartDate"
                      type="date"
                      value={form.installationStartDate}
                      onChange={handleInput("installationStartDate")}
                      className={inputCls}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="serviceStartDate" className="text-slate-700">
                    Przewidywany termin rozpoczęcia usługi
                  </Label>
                  <Input
                    id="serviceStartDate"
                    type="date"
                    value={form.serviceStartDate}
                    onChange={handleInput("serviceStartDate")}
                    className={inputCls}
                  />
                </div>
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
          )}

          {/* Wizard controls */}
          <div className="flex items-center justify-between border-t border-slate-200 pt-6">
            <Button
              type="button"
              variant="outline"
              onClick={handleBack}
              disabled={isFirst}
              className="border-slate-300"
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Wstecz
            </Button>
            {isLast ? (
              <Button
                key="submit"
                type="submit"
                disabled={loading}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                <Send className="mr-2 h-4 w-4" />
                {loading ? "Tworzenie..." : "Wyślij zlecenie"}
              </Button>
            ) : (
              <Button
                key="next"
                type="button"
                onClick={handleNext}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                Dalej
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
