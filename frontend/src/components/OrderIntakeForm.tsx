import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
  Handshake,
  ExternalLink,
} from "lucide-react";
import {
  createOrder,
  leadsApi,
  type LeadOrderPrefill,
  type ObjectServiceInput,
  type OrderInput,
} from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { LeadPicker, type LeadRef } from "./sales/LeadPicker";
import { normalizeNIP, validateNIP } from "@/lib/nip";
import {
  INVOICE_ISSUERS,
  OBJECT_KINDS,
  applyDefaultServiceStart,
  emptyIntakeState,
  servicesFromAnswers,
  useOrderIntakeDraft,
  useOrderIntakeWizard,
  type OrderIntakeFormState,
} from "@/lib/orderIntakeSteps";
import { activeServiceFlagsOf, todayIsoLocal } from "@/lib/utils";
import { LocationPicker } from "./LocationPicker";
import { NIPField } from "./NIPField";
import { ObjectServicesEditor } from "./ObjectServicesEditor";

interface OrderIntakeFormProps {
  /** Wywoływane po utworzeniu zlecenia — pozwala odświeżyć listę zleceń. */
  onCreated?: () => void;
}

const num = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);

/*
 * PREFILL Z SZANSY UZUPEŁNIA WYŁĄCZNIE PUSTE POLA. Formularz bywa zaczęty
 * (kreator trzyma szkic w localStorage), a szansa jest źródłem podpowiedzi,
 * nie prawdy — nadpisanie tego, co handlowiec zdążył wpisać, byłoby kradzieżą
 * jego pracy. Stąd dwie listy kluczy zamiast ślepego `{...form, ...prefill}`.
 */
type IntakeStrKey = {
  [K in keyof OrderIntakeFormState]: OrderIntakeFormState[K] extends string ? K : never;
}[keyof OrderIntakeFormState];

type IntakeBoolKey = {
  [K in keyof OrderIntakeFormState]: OrderIntakeFormState[K] extends boolean ? K : never;
}[keyof OrderIntakeFormState];

const PREFILL_TEXT_FIELDS: IntakeStrKey[] = [
  "requesterName",
  "requesterPhone",
  "requesterEmail",
  "payerName",
  "payerNip",
  "payerInvoiceEmail",
  "objectName",
  "objectKind",
  "objectAddress",
  "objectCity",
  "objectLocationUrl",
  "contactPerson",
  "contactPhone",
  "contactEmail",
  "monthlyAmount",
];

/**
 * Odpowiedzi „Tak/Nie" prefill może tylko WŁĄCZYĆ. „Nie" jest w tym formularzu
 * wartością domyślną, a nie decyzją — ale odznaczone świadomie „Nie" też tak
 * wygląda, więc gaszenie flagi na podstawie szansy skasowałoby czyjś wybór.
 */
const PREFILL_FLAG_FIELDS: IntakeBoolKey[] = [
  "isCameraInstallation",
  "videoReception",
  "interventionGroup",
];

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
  const [form, setForm, clearDraft] = useOrderIntakeDraft("orderIntakeDraft");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdNumber, setCreatedNumber] = useState<string | null>(null);
  /** Id zapisanego zlecenia — link „Otwórz zlecenie" na ekranie potwierdzenia. */
  const [createdId, setCreatedId] = useState<number | null>(null);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { canView } = usePerms();
  /*
   * SZANSA SPRZEDAŻY. Wchodzi dwiema drogami: z karty szansy („Utwórz zlecenie"
   * → `?leadId=`) albo z pickera w kroku 1. Obie kończą się tym samym: pobraniem
   * `GET /leads/:id/order-prefill` i uzupełnieniem PUSTYCH pól formularza.
   */
  const [lead, setLead] = useState<LeadRef | null>(null);
  /** Kontrahent i obiekt z kartoteki wskazane przez szansę (zamiast zakładania nowych). */
  const [leadContractorId, setLeadContractorId] = useState<number | null>(null);
  const [leadObjectId, setLeadObjectId] = useState<number | null>(null);
  const [leadSalespersonId, setLeadSalespersonId] = useState<number | null>(null);
  /** Ostrzeżenie o szansie, która ma już zlecenie (backend odrzuci drugie). */
  const [leadNotice, setLeadNotice] = useState<string | null>(null);

  const wizard = useOrderIntakeWizard(form);

  const set = <K extends keyof OrderIntakeFormState>(
    key: K,
    value: OrderIntakeFormState[K]
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleInput =
    (key: keyof OrderIntakeFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(key, e.target.value as OrderIntakeFormState[typeof key]);

  // --- Usługi zakładanego obiektu -------------------------------------------
  //
  // Okresy usług są własnym polem formularza, ale nie żyją w oderwaniu od
  // odpowiedzi: „Potrzebny montaż?” i „Wideo recepcja?” DOPISUJĄ brakujący okres,
  // a „Początek usługi” z sekcji Terminy jest jego domyślnym startem. W drugą
  // stronę nic się nie dzieje — odznaczenie pytania nie kasuje wiersza, bo
  // kartoteka obiektu ma pamiętać także usługi, których to zlecenie nie dotyczy.

  const [servicesValid, setServicesValid] = useState(true);

  const setServices = useCallback(
    (next: ObjectServiceInput[]) =>
      setForm((prev) => ({ ...prev, objectServices: next })),
    [setForm]
  );

  /** Start podpowiadany nowym okresom: „Początek usługi” albo dziś. */
  const defaultServiceStart = form.serviceStartDate.trim() || todayIsoLocal();
  const prevDefaultStart = useRef(defaultServiceStart);
  useEffect(() => {
    const prev = prevDefaultStart.current;
    if (prev === defaultServiceStart) return;
    prevDefaultStart.current = defaultServiceStart;
    setForm((f) => ({
      ...f,
      objectServices: applyDefaultServiceStart(
        f.objectServices,
        prev,
        defaultServiceStart
      ),
    }));
  }, [defaultServiceStart, setForm]);

  /** Odpowiedź „Tak” dopisuje odpowiadający jej okres, jeśli jeszcze go nie ma. */
  const setAnswer = (
    key: "isCameraInstallation" | "internetIncluded" | "interventionGroup" | "videoReception",
    value: boolean
  ) =>
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (!value) return next;
      const kind =
        key === "isCameraInstallation"
          ? "kamery"
          : key === "videoReception"
            ? "wideorecepcja"
            : null;
      if (!kind || next.objectServices.some((s) => s.service === kind)) return next;
      const [row] = servicesFromAnswers({
        isCameraInstallation: kind === "kamery",
        videoReception: kind === "wideorecepcja",
        cameraCount: next.cameraCount,
        serviceStartDate: next.serviceStartDate,
      });
      return row ? { ...next, objectServices: [...next.objectServices, row] } : next;
    });

  /**
   * Liczba kamer ze zlecenia przepisuje się do JEDYNEGO okresu kamer, dopóki
   * nikt nie zmienił jej w samym okresie (ta sama zasada, co przy dacie startu).
   * Zlecenie mówi, ile kamer się montuje; kartoteka — ile ich na obiekcie działa,
   * więc ręczna poprawka w wierszu wygrywa.
   */
  const numOrNull = (raw: string): number | null => {
    const t = raw.trim();
    if (t === "" || !Number.isFinite(Number(t))) return null;
    return Number(t);
  };
  const setCameraCount = (raw: string) =>
    setForm((prev) => {
      const cams = prev.objectServices.filter((s) => s.service === "kamery");
      if (cams.length !== 1) return { ...prev, cameraCount: raw };
      const only = cams[0];
      if ((only.cameraCount ?? null) !== numOrNull(prev.cameraCount)) {
        return { ...prev, cameraCount: raw };
      }
      return {
        ...prev,
        cameraCount: raw,
        objectServices: prev.objectServices.map((s) =>
          s === only ? { ...s, cameraCount: numOrNull(raw) } : s
        ),
      };
    });

  /** Prefill → stan formularza; nadpisujemy WYŁĄCZNIE puste pola (patrz wyżej). */
  const applyPrefill = useCallback(
    (p: LeadOrderPrefill) => {
      setLead({ id: p.leadId, title: p.leadTitle });
      setLeadContractorId(p.payerContractorId);
      setLeadObjectId(p.objectId);
      setLeadSalespersonId(p.salespersonId);
      setLeadNotice(
        p.leadOrderId
          ? "Ta szansa ma już zlecenie — zapis zostanie odrzucony. Otwórz istniejące zlecenie z karty szansy."
          : null
      );
      setForm((prev) => {
        const next = { ...prev };
        for (const key of PREFILL_TEXT_FIELDS) {
          const value = p[key];
          if (typeof value === "string" && value.trim() && !prev[key].trim()) {
            next[key] = value;
          }
        }
        for (const key of PREFILL_FLAG_FIELDS) {
          if (p[key] === true && prev[key] === false) next[key] = true;
        }
        if (p.objectServices?.length && prev.objectServices.length === 0) {
          next.objectServices = p.objectServices;
        }
        return next;
      });
    },
    [setForm]
  );

  const loadPrefill = useCallback(
    async (id: number) => {
      try {
        const res = await leadsApi.orderPrefill(id);
        if (res.data) applyPrefill(res.data);
      } catch (err) {
        setError(
          err instanceof Error
            ? `Nie udało się wczytać danych szansy: ${err.message}`
            : "Nie udało się wczytać danych szansy."
        );
      }
    },
    [applyPrefill]
  );

  /*
   * `?leadId=` z karty szansy — jednorazowo, przy wejściu. Ref pilnuje, żeby
   * ponowny render (albo powrót z kroku wstecz) nie doładował prefillu drugi raz
   * i nie wskrzesił pola, które handlowiec właśnie wyczyścił.
   */
  const prefilledFor = useRef<number | null>(null);
  useEffect(() => {
    const raw = Number(searchParams.get("leadId"));
    if (!Number.isInteger(raw) || raw <= 0) return;
    if (prefilledFor.current === raw) return;
    prefilledFor.current = raw;
    void loadPrefill(raw);
  }, [searchParams, loadPrefill]);

  const resetForm = () => {
    setForm(emptyIntakeState);
    setCreatedNumber(null);
    setCreatedId(null);
    setError(null);
    setServicesValid(true);
    setLead(null);
    setLeadContractorId(null);
    setLeadObjectId(null);
    setLeadSalespersonId(null);
    setLeadNotice(null);
    prefilledFor.current = null;
    wizard.reset();
  };

  /** Błąd edytora okresów (zła data, ujemna liczba kamer) blokuje krok „Zakres”. */
  const servicesError = servicesValid
    ? null
    : "Popraw okresy usług obiektu — sprawdź daty i liczbę kamer.";

  const handleNext = () => {
    const result = wizard.validateCurrent();
    if (!result.ok) {
      setError(result.message ?? "Uzupełnij wymagane pola.");
      return;
    }
    if (wizard.currentStep.id === "scope" && servicesError) {
      setError(servicesError);
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
    if (servicesError) {
      setError(servicesError);
      return;
    }
    setError(null);

    // Flagi `objectHas*` zostają w payloadzie dla zgodności (starszy backend nie
    // zna okresów), ale liczymy je z listy — nie odwrotnie. Źródłem prawdy są
    // okresy, flagi to ich stan „na dziś” (`activeServiceFlagsOf` = lustro
    // `flagsFromServices` z backendu).
    const flags = activeServiceFlagsOf(
      form.objectServices.filter((s) => !!s.startDate)
    );

    const payload: OrderInput = {
      requesterName: form.requesterName,
      requesterPhone: form.requesterPhone,
      requesterEmail: form.requesterEmail,
      payerName: form.payerName,
      payerNip: normalizeNIP(form.payerNip),
      payerInvoiceEmail: form.payerInvoiceEmail || undefined,
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
      contractLengthMonths: num(form.contractLengthMonths),
      rentalAmount: num(form.rentalAmount),
      rentalLengthMonths: num(form.rentalLengthMonths),
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
      /*
       * Szansa wskazująca kontrahenta albo obiekt z kartoteki PODPINA je, zamiast
       * zakładać kopię: `createContractor` na istniejącym NIP-ie kończy się 409,
       * a drugi obiekt pod tym samym adresem rozdwaja historię. Bez szansy
       * formularz działa jak dotąd — zakłada jedno i drugie.
       */
      leadId: lead?.id,
      salespersonId: leadSalespersonId ?? undefined,
      payerContractorId: leadContractorId ?? undefined,
      objectId: leadObjectId ?? undefined,
      createContractor: leadContractorId === null,
      createObject: leadObjectId === null,
      // Usługi obiektu jako OKRESY — handlowiec ułożył je w kroku „Zakres”
      // (podpowiedziane z odpowiedzi o montaż kamer i wideorecepcję).
      objectServices: form.objectServices,
      objectHasCameras: !!flags.hasCameras,
      objectCameraCount: flags.cameraCount,
      objectHasSswin: !!flags.hasSswin,
      objectHasVideoreception: !!flags.hasVideoreception,
      objectHasOfi: !!flags.hasOfi,
      objectInstallationType: "new",
    };

    setLoading(true);
    try {
      const res = await createOrder(payload);
      clearDraft();
      onCreated?.();
      /*
       * Zlecenie z szansy wraca NA KARTĘ ZLECENIA: handlowiec przyszedł tu
       * z lejka po konkretny dokument i chce zobaczyć jego numer, powiązania
       * i przyciski maila, a nie pusty kreator „dodaj kolejne".
       */
      if (lead && res.data?.id) {
        navigate(`/orders/${res.data.id}`);
        return;
      }
      setCreatedNumber(res.data?.orderNumber ?? "");
      setCreatedId(res.data?.id ?? null);
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
          <div className="flex flex-wrap items-center justify-center gap-2">
            {createdId !== null && (
              <Button variant="outline" onClick={() => navigate(`/orders/${createdId}`)}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Otwórz zlecenie
              </Button>
            )}
            <Button
              onClick={resetForm}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Plus className="mr-2 h-4 w-4" />
              Dodaj kolejne zlecenie
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { currentStep, stepIndex, totalSteps, isFirst, isLast } = wizard;
  const progress = ((stepIndex + 1) / totalSteps) * 100;

  return (
    <Card>
      <CardContent className="p-6">
        {/* Pochodzenie zlecenia — widoczne w KAŻDYM kroku, bo decyduje o tym,
            skąd wzięły się wypełnione pola i dokąd wróci zapis. */}
        {lead && (
          <div
            className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900"
            data-testid="zlecenie-lead-banner"
          >
            <Handshake className="h-4 w-4 shrink-0" />
            <span>
              Zlecenie z szansy:{" "}
              <Link
                to={`/handlowy/leady/${lead.id}`}
                className="font-semibold underline underline-offset-2"
                data-testid="zlecenie-lead-link"
              >
                {lead.title}
              </Link>
            </span>
            {leadNotice && (
              <span className="w-full text-xs font-medium text-amber-700">{leadNotice}</span>
            )}
          </div>
        )}

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
              {/* Powiązanie z lejkiem — tylko dla kogoś, kto szanse w ogóle
                  widzi; bez uprawnienia picker odpytywałby /leads na 403. */}
              {canView("handlowy/leady") && (
                <div className="space-y-2">
                  <Label htmlFor="order-lead" className="text-slate-700">
                    Powiązana szansa
                  </Label>
                  <LeadPicker
                    inputId="order-lead"
                    value={lead}
                    includeClosed
                    placeholder="Szukaj szansy sprzedaży…"
                    onPick={(picked) => void loadPrefill(picked.id)}
                    onClear={() => {
                      // Odpięcie szansy NIE czyści pól: to, co już wpisane,
                      // jest teraz treścią zlecenia, a nie kopią szansy.
                      setLead(null);
                      setLeadContractorId(null);
                      setLeadObjectId(null);
                      setLeadSalespersonId(null);
                      setLeadNotice(null);
                    }}
                  />
                  <p className="text-xs text-slate-500">
                    Uzupełni tylko puste pola formularza; po zapisie szansa dostanie
                    numer zlecenia.
                  </p>
                </div>
              )}
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
              {/* NIP z walidacją sumy kontrolnej + wyszukiwarką firm w wykazie MF —
                  „Wstaw dane” uzupełnia nazwę płatnika. */}
              <NIPField
                value={form.payerNip}
                onChange={(nip) => set("payerNip", nip)}
                onUseExisting={(contractor) => set("payerName", contractor.name)}
                onCompanyFound={(company) => {
                  if (company.name) set("payerName", company.name);
                }}
                label="NIP Płatnika"
                id="payerNip"
              />
              <div className="space-y-2 md:max-w-md">
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
              <div className="space-y-2 md:max-w-md">
                <Label htmlFor="payerInvoiceEmail" className="text-slate-700">
                  Mail do faktur płatnika <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="payerInvoiceEmail"
                  type="email"
                  value={form.payerInvoiceEmail}
                  onChange={handleInput("payerInvoiceEmail")}
                  placeholder="faktury@firma.pl"
                  className={inputCls}
                />
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
                  { key: "videoReception" as const, label: "Wideo recepcja?" },
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
                      onChange={(v) => setAnswer(q.key, v)}
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500">
                Odpowiedzi „Tak” przy montażu kamer i wideorecepcji dopisują usługę
                zakładanemu obiektowi — okresy poprawisz w kroku „Zakres”.
              </p>
            </section>
          )}

          {/* Step 4: Lokalizacja obiektu */}
          {currentStep.id === "location" && (
            <section className="space-y-4">
              <SectionHeader icon={MapPin}>Lokalizacja obiektu</SectionHeader>
              <LocationPicker
                variant="light"
                value={form.objectLocationUrl}
                initialAddress={form.objectAddress}
                onChange={(url) => set("objectLocationUrl", url)}
                onAddress={(address, city) => {
                  set("objectAddress", address);
                  set("objectCity", city);
                }}
              />
            </section>
          )}

          {/* Step 5: Dane obiektu */}
          {currentStep.id === "object" && (
            <section className="space-y-4">
              <SectionHeader icon={Building2}>Dane obiektu</SectionHeader>
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

          {/* Step 6: Montaż (only when isCameraInstallation) */}
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

          {/* Step 7: Zakres i warunki usługi */}
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
                    onChange={(e) => setCameraCount(e.target.value)}
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
                    Abonament (zł netto)
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
                    Dzierżawa (zł netto)
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
                  <Label htmlFor="contractLengthMonths" className="text-slate-700">
                    Długość kontraktu (mies.)
                  </Label>
                  <Input
                    id="contractLengthMonths"
                    type="number"
                    min="0"
                    value={form.contractLengthMonths}
                    onChange={handleInput("contractLengthMonths")}
                    className={inputCls}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rentalLengthMonths" className="text-slate-700">
                    Długość dzierżawy (mies.)
                  </Label>
                  <Input
                    id="rentalLengthMonths"
                    type="number"
                    min="0"
                    value={form.rentalLengthMonths}
                    onChange={handleInput("rentalLengthMonths")}
                    className={inputCls}
                  />
                </div>
              </div>

              {/* Usługi zakładanego obiektu — ten sam edytor, co w kartotece
                  (`ObjectServicesEditor`), tylko w trybie kompaktowym. Kamery
                  i wideorecepcja są już dopisane z odpowiedzi z kroku „Pytania”;
                  SSWiN i ochronę fizyczną handlowiec dokłada tu ręcznie. */}
              <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Label className="text-slate-700">Usługi na zakładanym obiekcie</Label>
                  <span className="text-xs text-slate-500">
                    Start podpowiadamy z „Początku usługi” (krok Terminy)
                  </span>
                </div>
                <ObjectServicesEditor
                  compact
                  value={form.objectServices}
                  onChange={setServices}
                  defaultStartDate={defaultServiceStart}
                  onValidityChange={setServicesValid}
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
                  <span>
                    Wideo recepcja:{" "}
                    <strong className="text-slate-900">
                      {form.videoReception ? "Tak" : "Nie"}
                    </strong>
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* Step 8: Terminy */}
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
                  {/* Gwiazdka pojawia się wtedy, kiedy pole naprawdę jest
                      wymagane — od tej daty liczą się okresy usług obiektu. */}
                  <Label htmlFor="serviceStartDate" className="text-slate-700">
                    Przewidywany termin rozpoczęcia usługi
                    {form.objectServices.length > 0 && (
                      <span className="text-red-500"> *</span>
                    )}
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
