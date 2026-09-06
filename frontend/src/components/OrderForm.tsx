import { useState, useEffect, useCallback } from "react";
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
import { Alert, AlertDescription } from "./ui/alert";
import { NIPField } from "./NIPField";
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
  Check,
  AlertCircle,
  Home,
} from "lucide-react";
import type { Order, OrderInput, Contractor, CompanyData, ObjectRecord, ObjectHistoryRecord } from "@/lib/api";
import { getContractorObjects } from "@/lib/api";
import { OBJECT_KINDS } from "@/lib/orderIntakeSteps";
import { normalizeNIP, validateNIP } from "@/lib/nip";
import { installationTypeLabels, statusLabels } from "@/lib/utils";

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
  const [error, setError] = useState<string | null>(null);
  
  // Contractor state
  const [contractorNIP, setContractorNIP] = useState(order?.payerNip || "");
  const [selectedContractor, setSelectedContractor] = useState<Contractor | null>(null);
  const [createContractor, setCreateContractor] = useState(!order);
  const [showContractorForm, setShowContractorForm] = useState(!order);
  
  // Object state
  const [contractorObjects, setContractorObjects] = useState<Array<ObjectRecord & { latestAction: ObjectHistoryRecord | null }>>([]);
  const [createObject, setCreateObject] = useState(!order);
  const [selectedObject, setSelectedObject] = useState<ObjectRecord | null>(null);
  
  // Form data
  const [formData, setFormData] = useState<OrderInput>({
    requesterName: "",
    requesterPhone: "",
    requesterEmail: "",
    payerName: "",
    payerNip: "",
    payerInvoiceEmail: "",
    objectName: "",
    objectKind: "",
    objectAddress: "",
    objectCity: "",
    objectLocationUrl: "",
    contactPerson: "",
    contactPhone: "",
    contactEmail: "",
    isCameraInstallation: false,
    internetIncluded: false,
    interventionGroup: false,
    videoReception: false,
    status: "new",
    serviceStartDate: "",
    installationStartDate: "",
    notes: "",
    // New fields
    createContractor: true,
    createObject: true,
    contractorAddress: "",
    contractorCity: "",
    contractorPhone: "",
    contractorEmail: "",
    contractorContactPerson: "",
    objectHasCameras: false,
    objectCameraCount: null,
    objectHasSswin: false,
    objectHasVideoreception: false,
    objectHasOfi: false,
    objectInstallationType: "new",
  });

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      const hasOrder = !!order;
      const hasContractor = hasOrder && order.payerContractorId != null;
      const hasObject = hasOrder && order.objectId != null;
      
      setContractorNIP(order?.payerNip || "");
      setSelectedContractor(order?.contractor || null);
      setCreateContractor(!hasContractor);
      setShowContractorForm(!hasContractor);
      setCreateObject(!hasObject);
      setSelectedObject(order?.object || null);
      setError(null);
      
      setFormData({
        requesterName: order?.requesterName || "",
        requesterPhone: order?.requesterPhone || "",
        requesterEmail: order?.requesterEmail || "",
        payerName: order?.payerName || "",
        payerNip: order?.payerNip || "",
        payerInvoiceEmail: order?.payerInvoiceEmail || "",
        payerContractorId: order?.payerContractorId ?? undefined,
        objectName: order?.objectName || "",
        objectKind: order?.objectKind || "",
        objectAddress: order?.objectAddress || "",
        objectCity: order?.objectCity || "",
        objectLocationUrl: order?.objectLocationUrl || "",
        objectId: order?.objectId ?? undefined,
        contactPerson: order?.contactPerson || "",
        contactPhone: order?.contactPhone || "",
        contactEmail: order?.contactEmail || "",
        isCameraInstallation: order?.isCameraInstallation || false,
        internetIncluded: order?.internetIncluded || false,
        interventionGroup: order?.interventionGroup || false,
        videoReception: order?.videoReception || false,
        cameraCount: order?.cameraCount ?? undefined,
        megaphoneCount: order?.megaphoneCount ?? undefined,
        vtoolsOfferNumber: order?.vtoolsOfferNumber || "",
        monthlyAmount: order?.monthlyAmount ?? undefined,
        contractLengthMonths: order?.contractLengthMonths ?? undefined,
        rentalAmount: order?.rentalAmount ?? undefined,
        rentalLengthMonths: order?.rentalLengthMonths ?? undefined,
        invoiceIssuer: order?.invoiceIssuer || "",
        status: order?.status || "new",
        serviceStartDate: order?.serviceStartDate || "",
        installationStartDate: order?.installationStartDate || "",
        notes: order?.notes || "",
        createContractor: !hasContractor,
        createObject: !hasObject,
        contractorAddress: "",
        contractorCity: "",
        contractorPhone: "",
        contractorEmail: "",
        contractorContactPerson: "",
        // Usługi zakładanego obiektu podpowiadamy z samego zlecenia: montaż
        // kamer i wideorecepcja są już w formularzu, więc nie każemy wpisywać
        // tego drugi raz. SSWiN i OFI zlecenie ZDW opisuje, więc zostają puste.
        objectHasCameras: order?.isCameraInstallation || false,
        objectCameraCount: order?.cameraCount ?? null,
        objectHasSswin: false,
        objectHasVideoreception: order?.videoReception || false,
        objectHasOfi: false,
        objectInstallationType: "new",
      });
      
      if (order?.payerContractorId) {
        loadContractorObjects(order.payerContractorId);
      }
    }
  }, [open, order]);

  const loadContractorObjects = async (contractorId: number) => {
    try {
      const response = await getContractorObjects(contractorId);
      setContractorObjects(response.data || []);
    } catch (err) {
      console.error("Error loading contractor objects:", err);
    }
  };

  const handleNIPChange = useCallback((nip: string, contractor: Contractor | null) => {
    setContractorNIP(nip);
    setFormData((prev) => ({
      ...prev,
      payerNip: nip,
    }));
    
    if (contractor) {
      // NIP exists - contractor found
      setSelectedContractor(contractor);
      setCreateContractor(false);
      setShowContractorForm(false);
      setFormData((prev) => ({
        ...prev,
        payerName: contractor.name,
        payerContractorId: contractor.id,
        createContractor: false,
      }));
      // Load contractor's objects
      loadContractorObjects(contractor.id);
    } else if (nip.length === 10 && validateNIP(nip)) {
      // NIP is valid but doesn't exist - show form to create new contractor
      setSelectedContractor(null);
      setCreateContractor(true);
      setShowContractorForm(true);
      setFormData((prev) => ({
        ...prev,
        payerContractorId: undefined,
        createContractor: true,
      }));
      setContractorObjects([]);
    }
  }, []);

  /** Dane z wykazu VAT MF → pola nowego kontrahenta (telefon i mail zostają ręczne). */
  const handleCompanyFound = useCallback((company: CompanyData) => {
    setFormData((prev) => ({
      ...prev,
      payerName: company.name || prev.payerName,
      contractorAddress: company.address || prev.contractorAddress,
      contractorCity: company.city || prev.contractorCity,
    }));
  }, []);

  const handleUseExistingContractor = useCallback((contractor: Contractor) => {
    setSelectedContractor(contractor);
    setCreateContractor(false);
    setShowContractorForm(false);
    setFormData((prev) => ({
      ...prev,
      payerName: contractor.name,
      payerContractorId: contractor.id,
      createContractor: false,
    }));
    loadContractorObjects(contractor.id);
  }, []);

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

  const handleSelectObject = (obj: ObjectRecord) => {
    setSelectedObject(obj);
    setCreateObject(false);
    setFormData((prev) => ({
      ...prev,
      objectId: obj.id,
      objectName: obj.name,
      objectAddress: obj.address || prev.objectAddress,
      objectCity: obj.city || prev.objectCity,
      createObject: false,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    // Validation
    if (!formData.payerNip || !validateNIP(formData.payerNip)) {
      setError("Podaj prawidłowy NIP");
      return;
    }
    
    if (!formData.payerName) {
      setError("Podaj nazwę płatnika");
      return;
    }
    
    if (createContractor && !formData.payerContractorId) {
      // Creating new contractor - validate required fields
      if (!formData.payerName) {
        setError("Podaj nazwę kontrahenta");
        return;
      }
    } else if (!formData.payerContractorId) {
      setError("Wybierz lub utwórz kontrahenta");
      return;
    }
    
    if (createObject) {
      // Creating new object - validate required fields
      if (!formData.objectName) {
        setError("Podaj nazwę obiektu");
        return;
      }
      if (!formData.objectInstallationType) {
        setError("Wybierz typ instalacji");
        return;
      }
    } else if (!formData.objectId) {
      setError("Wybierz lub utwórz obiekt");
      return;
    }
    
    setLoading(true);
    try {
      await onSubmit({
        ...formData,
        payerNip: normalizeNIP(formData.payerNip),
        createContractor,
        createObject,
      });
      onClose();
    } catch (err: any) {
      console.error("Error submitting form:", err);
      setError(err.message || "Wystąpił błąd podczas zapisywania");
    } finally {
      setLoading(false);
    }
  };

  const getStatusLabel = (status: string) => {
    return orderStatuses.find((s) => s.value === status)?.label || status;
  };

  const isEditing = !!order;

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
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

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
              <div className="flex items-center gap-2 text-slate-700">
                <Building2 className="w-4 h-4" />
                <h3 className="font-semibold uppercase tracking-wide text-sm">
                  Dane płatnika
                </h3>
              </div>

              {/* NIP Field */}
              <NIPField
                value={contractorNIP}
                onChange={handleNIPChange}
                onUseExisting={handleUseExistingContractor}
                onCompanyFound={handleCompanyFound}
                disabled={isEditing}
              />

              {/* New Contractor Form */}
              {showContractorForm && createContractor && !isEditing && (
                <div className="p-4 bg-white border border-slate-200 rounded-lg space-y-4">
                  <h4 className="font-medium text-slate-700 flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-500" />
                    Tworzenie nowego kontrahenta
                  </h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="payerName">
                        Nazwa kontrahenta <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="payerName"
                        name="payerName"
                        value={formData.payerName}
                        onChange={handleChange}
                        placeholder="Nazwa firmy"
                        required
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contractorPhone">Telefon</Label>
                      <Input
                        id="contractorPhone"
                        name="contractorPhone"
                        value={formData.contractorPhone || ""}
                        onChange={handleChange}
                        placeholder="Opcjonalnie"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contractorEmail">Email</Label>
                      <Input
                        id="contractorEmail"
                        name="contractorEmail"
                        type="email"
                        value={formData.contractorEmail || ""}
                        onChange={handleChange}
                        placeholder="Opcjonalnie"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contractorContactPerson">Osoba kontaktowa</Label>
                      <Input
                        id="contractorContactPerson"
                        name="contractorContactPerson"
                        value={formData.contractorContactPerson || ""}
                        onChange={handleChange}
                        placeholder="Opcjonalnie"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contractorAddress">Adres</Label>
                      <Input
                        id="contractorAddress"
                        name="contractorAddress"
                        value={formData.contractorAddress || ""}
                        onChange={handleChange}
                        placeholder="Ulica i numer"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contractorCity">Miasto</Label>
                      <Input
                        id="contractorCity"
                        name="contractorCity"
                        value={formData.contractorCity || ""}
                        onChange={handleChange}
                        placeholder="Miasto"
                        className="bg-white"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Selected Contractor Info (when editing or using existing) */}
              {(selectedContractor || isEditing) && !createContractor && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2 text-green-800">
                    <Check className="w-5 h-5" />
                    <span className="font-medium">
                      Wybrany kontrahent: {formData.payerName}
                    </span>
                  </div>
                  <p className="text-sm text-green-700 mt-1">
                    NIP: {formData.payerNip}
                  </p>
                </div>
              )}
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
                {!isEditing && (
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="createObject"
                      checked={createObject}
                      onCheckedChange={(checked) => {
                        setCreateObject(checked as boolean);
                        setSelectedObject(null);
                        setFormData((prev) => ({
                          ...prev,
                          createObject: checked as boolean,
                          objectId: checked ? undefined : prev.objectId,
                        }));
                      }}
                    />
                    <Label htmlFor="createObject" className="text-sm font-medium cursor-pointer">
                      Utwórz nowy obiekt
                    </Label>
                  </div>
                )}
              </div>

              {/* Existing Objects List */}
              {!createObject && !isEditing && selectedContractor && (
                <div className="space-y-2">
                  <Label className="text-slate-700">Wybierz obiekt kontrahenta:</Label>
                  {contractorObjects.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      Ten kontrahent nie ma jeszcze obiektów. Zaznacz "Utwórz nowy obiekt".
                    </p>
                  ) : (
                    <div className="grid gap-2">
                      {contractorObjects.map((obj) => (
                        <button
                          key={obj.id}
                          type="button"
                          onClick={() => handleSelectObject(obj)}
                          className={`p-3 text-left border rounded-lg transition-colors ${
                            selectedObject?.id === obj.id
                              ? "border-indigo-500 bg-indigo-50"
                              : "border-slate-200 hover:bg-slate-50"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{obj.name}</span>
                            {selectedObject?.id === obj.id && (
                              <Check className="w-4 h-4 text-indigo-600" />
                            )}
                          </div>
                          <p className="text-sm text-slate-500">
                            {obj.city} {obj.address}
                          </p>
                          {obj.latestAction && (
                            <Badge variant="secondary" className="mt-1 text-xs">
                              {statusLabels[obj.status] || obj.status}
                            </Badge>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* New Object Form */}
              {(createObject || isEditing) && (
                <div className="p-4 bg-white border border-slate-200 rounded-lg space-y-4">
                  {createObject && !isEditing && (
                    <h4 className="font-medium text-slate-700 flex items-center gap-2">
                      <Home className="w-4 h-4 text-indigo-500" />
                      Nowy obiekt
                    </h4>
                  )}
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="objectName">
                        Nazwa obiektu <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="objectName"
                        name="objectName"
                        value={formData.objectName}
                        onChange={handleChange}
                        placeholder="Np. Siedziba firmy"
                        required
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="objectLocationUrl">Lokalizacja Google (URL)</Label>
                      <Input
                        id="objectLocationUrl"
                        name="objectLocationUrl"
                        type="url"
                        value={formData.objectLocationUrl}
                        onChange={handleChange}
                        placeholder="https://maps.google.com/..."
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="objectKind">Rodzaj obiektu</Label>
                      <Select
                        value={formData.objectKind || ""}
                        onValueChange={(value) =>
                          setFormData((prev) => ({ ...prev, objectKind: value }))
                        }
                      >
                        <SelectTrigger className="bg-white">
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
                  
                  {createObject && !isEditing && (
                    <div className="grid grid-cols-2 gap-4">
                      {/* Usługi zakładanego obiektu — cztery niezależne flagi
                          zamiast jednego „typu ochrony”. Kamery i wideorecepcja
                          są wstępnie zaznaczone z danych zlecenia, ale handlowiec
                          może je poprawić: zlecenie opisuje montaż, a kartoteka
                          to, co na obiekcie ostatecznie działa. */}
                      <div className="space-y-2">
                        <Label>Usługi na obiekcie</Label>
                        <div className="grid grid-cols-2 gap-1.5">
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-indigo-600"
                              checked={formData.objectHasCameras ?? false}
                              onChange={(e) =>
                                setFormData((prev) => ({
                                  ...prev,
                                  objectHasCameras: e.target.checked,
                                  objectCameraCount: e.target.checked
                                    ? prev.objectCameraCount ?? null
                                    : null,
                                }))
                              }
                            />
                            Kamery
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-indigo-600"
                              checked={formData.objectHasSswin ?? false}
                              onChange={(e) =>
                                setFormData((prev) => ({ ...prev, objectHasSswin: e.target.checked }))
                              }
                            />
                            SSWiN
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-indigo-600"
                              checked={formData.objectHasVideoreception ?? false}
                              onChange={(e) =>
                                setFormData((prev) => ({
                                  ...prev,
                                  objectHasVideoreception: e.target.checked,
                                }))
                              }
                            />
                            Wideorecepcja
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-indigo-600"
                              checked={formData.objectHasOfi ?? false}
                              onChange={(e) =>
                                setFormData((prev) => ({ ...prev, objectHasOfi: e.target.checked }))
                              }
                            />
                            OFI (ochrona fizyczna)
                          </label>
                        </div>
                        {/* Puste pole zostaje `null` — „kamery są, nikt ich nie
                            policzył”, co nie jest tym samym, co zero kamer. */}
                        <div className="flex items-center gap-2">
                          <Label
                            htmlFor="objectCameraCount"
                            className={!formData.objectHasCameras ? "text-slate-400" : undefined}
                          >
                            Liczba kamer
                          </Label>
                          <Input
                            id="objectCameraCount"
                            type="number"
                            min="0"
                            step="1"
                            disabled={!formData.objectHasCameras}
                            className="w-24 bg-white tabular-nums"
                            placeholder="nie policzono"
                            value={formData.objectCameraCount ?? ""}
                            onChange={(e) =>
                              setFormData((prev) => ({
                                ...prev,
                                objectCameraCount:
                                  e.target.value.trim() === ""
                                    ? null
                                    : Math.max(0, parseInt(e.target.value, 10) || 0),
                              }))
                            }
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>
                          Typ instalacji <span className="text-red-500">*</span>
                        </Label>
                        <Select
                          value={formData.objectInstallationType}
                          onValueChange={(value) =>
                            setFormData((prev) => ({ ...prev, objectInstallationType: value as OrderInput["objectInstallationType"] }))
                          }
                        >
                          <SelectTrigger className="bg-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(installationTypeLabels).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="objectAddress">Adres</Label>
                      <Input
                        id="objectAddress"
                        name="objectAddress"
                        value={formData.objectAddress}
                        onChange={handleChange}
                        placeholder="Ulica i numer"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="objectCity">Miasto</Label>
                      <Input
                        id="objectCity"
                        name="objectCity"
                        value={formData.objectCity}
                        onChange={handleChange}
                        placeholder="Miasto"
                        className="bg-white"
                      />
                    </div>
                  </div>
                </div>
              )}
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
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Zakres usługi
                </h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="flex items-center space-x-2 p-3 bg-white border border-slate-200 rounded-lg">
                    <Checkbox
                      id="internetIncluded"
                      checked={formData.internetIncluded}
                      onCheckedChange={(checked) =>
                        setFormData((prev) => ({
                          ...prev,
                          internetIncluded: checked as boolean,
                        }))
                      }
                    />
                    <Label
                      htmlFor="internetIncluded"
                      className="text-sm font-medium cursor-pointer"
                    >
                      Internet
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 p-3 bg-white border border-slate-200 rounded-lg">
                    <Checkbox
                      id="interventionGroup"
                      checked={formData.interventionGroup}
                      onCheckedChange={(checked) =>
                        setFormData((prev) => ({
                          ...prev,
                          interventionGroup: checked as boolean,
                        }))
                      }
                    />
                    <Label
                      htmlFor="interventionGroup"
                      className="text-sm font-medium cursor-pointer"
                    >
                      Grupa interwencyjna
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 p-3 bg-white border border-slate-200 rounded-lg">
                    <Checkbox
                      id="videoReception"
                      checked={formData.videoReception}
                      onCheckedChange={(checked) =>
                        setFormData((prev) => ({
                          ...prev,
                          videoReception: checked as boolean,
                        }))
                      }
                    />
                    <Label
                      htmlFor="videoReception"
                      className="text-sm font-medium cursor-pointer"
                    >
                      Wideo recepcja
                    </Label>
                  </div>
                </div>
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
                    Ustalona kwota abonamentu (zł netto)
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
                  <Label htmlFor="contractLengthMonths" className="text-slate-700">
                    Długość kontraktu (mies.)
                  </Label>
                  <Input
                    id="contractLengthMonths"
                    name="contractLengthMonths"
                    type="number"
                    min="0"
                    value={formData.contractLengthMonths ?? ""}
                    onChange={handleNumberChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rentalAmount" className="text-slate-700">
                    Kwota dzierżawy (zł netto)
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
                  <Label htmlFor="rentalLengthMonths" className="text-slate-700">
                    Długość dzierżawy (mies.)
                  </Label>
                  <Input
                    id="rentalLengthMonths"
                    name="rentalLengthMonths"
                    type="number"
                    min="0"
                    value={formData.rentalLengthMonths ?? ""}
                    onChange={handleNumberChange}
                    className="bg-white border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payerInvoiceEmail" className="text-slate-700">
                    Mail do faktur płatnika
                  </Label>
                  <Input
                    id="payerInvoiceEmail"
                    name="payerInvoiceEmail"
                    type="email"
                    value={formData.payerInvoiceEmail || ""}
                    onChange={handleChange}
                    placeholder="faktury@firma.pl"
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
                <div className="space-y-2">
                  <Label htmlFor="installationStartDate" className="text-slate-700">
                    Przewidywany termin rozpoczęcia montażu
                  </Label>
                  <Input
                    id="installationStartDate"
                    name="installationStartDate"
                    type="date"
                    value={formData.installationStartDate}
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
