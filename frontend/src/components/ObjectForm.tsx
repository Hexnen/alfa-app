/**
 * FORMULARZ OBIEKTU — dialog w shellu kalendarza.
 *
 * Kształt okna jest przepisany 1:1 z dialogu wydarzenia
 * (`components/CalendarEventDialog.tsx:2811` — pasek akcentu `absolute inset-x-0
 * top-0 h-1`, kafelek ikony `h-9 w-9 rounded-md` z tonem `EVENT_TYPE_UI.soft`,
 * tytuł `text-base font-semibold` z pigułkami, opis `text-xs text-muted-foreground`;
 * body `min-h-0 flex-1 overflow-y-auto` z l.4205; stopka `shrink-0 border-t px-5
 * py-3` z l.4222), a treść dzieli się na sekcje `Section` (`components/ui/section.tsx`,
 * wcześniej `offers/offersUi.tsx`) — ten sam klocek, którego używa edytor ofert.
 *
 * Dwie zmiany merytoryczne względem poprzedniej wersji:
 *
 * 1. USŁUGI TO OKRESY, nie checkboxy — listę obsługuje `ObjectServicesEditor`,
 *    a w body leci `services` (PEŁNA PODMIANA po stronie backendu). Flag
 *    `hasCameras`/`hasSswin`/`hasVideoreception`/`hasOfi` i `cameraCount`
 *    formularz JUŻ NIE WYSYŁA — backend liczy je z okresów aktywnych, tak jak
 *    `monthlyValue` z rozbicia abonamentu. Podgląd „co z tego wyjdzie” robi
 *    `activeServiceFlagsOf` z @/lib/utils (lustro `flagsFromServices` z serwera).
 * 2. LINKI GOOGLE MAPS (Część 2 planu) — osobne pole na link, przycisk
 *    „Odczytaj współrzędne” (`resolveMapsLink`: parser + rozwijanie krótkich
 *    linków przez `/api/public/resolve-location`) i pole „Adres”, które
 *    rozpoznaje wklejony link albo „szer, dł” (`isDirectInput`) i przerzuca go
 *    tam, gdzie jego miejsce.
 *
 * Błędy (własne i 400 z backendu — `request()` w lib/api.ts wkłada polski
 * komunikat serwera w `Error.message`) lądują w bloku nad stopką, a nie
 * w `alert()`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Coins,
  Info,
  Link2,
  Loader2,
  MapPin,
  Search,
  ShieldCheck,
  StickyNote,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Section } from "./ui/section";
import { ObjectServicesEditor } from "./ObjectServicesEditor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { tip } from "./ui/tooltip";
import {
  adminCompanyApi,
  errStatus,
  getContractorCatalog,
  getSalespeople,
  salespersonName,
  getCompanies,
  type Company,
  type Salesperson,
  type ContractorCatalogEntry,
  type ObjectRecord,
  type ObjectInput,
  type ObjectServiceInput,
} from "@/lib/api";
import {
  isDirectInput,
  isGoogleMapsUrl,
  resolveMapsLink,
  reverseGeocode,
  type ReverseGeocodeHit,
} from "@/lib/maps-url";
import { EVENT_TYPE_UI, pillClass, type PillTone } from "@/lib/calendar-labels";
import {
  activeServiceFlagsOf,
  cn,
  installationTypeLabels,
  statusLabels,
  departmentLabels,
  formatCurrency,
} from "@/lib/utils";

/**
 * Ton paska i kafelka nagłówka. Bierzemy gotowy zestaw z kalendarza
 * (`EVENT_TYPE_UI` w lib/calendar-labels.ts) zamiast surowych `sky-*`, żeby
 * dialog obiektu i dialog wydarzenia świeciły tym samym kolorem także w trybie
 * ciemnym.
 */
const ACCENT = EVENT_TYPE_UI.serwis;

/** Tony pigułki statusu obiektu — te same, co w kartotece obiektu. */
const STATUS_TONE: Record<string, PillTone> = {
  pending: "amber",
  in_progress: "sky",
  active: "emerald",
  inactive: "neutral",
};

/**
 * Geokodowanie adresu obiektu. Najpierw backend (`/admin/company/geocode`) —
 * ma cache w `geo_cache` i własny User-Agent. Endpoint jest jednak zamknięty
 * dla adminów, więc pozostałym użytkownikom zostaje zapytanie prosto z
 * przeglądarki do Nominatim, tak jak robi to już `LocationPicker`.
 */
async function geocodeAddress(query: string): Promise<{ lat: number; lng: number; display?: string }> {
  try {
    return await adminCompanyApi.geocode({ query });
  } catch (e) {
    const status = errStatus(e);
    // 403 = nie admin, 404 = starszy backend bez geokodera. Inne błędy (np. „nie
    // znaleziono adresu”) są merytoryczne — nie ma po co pytać drugi raz.
    if (status !== 403 && status !== 404) throw e;
  }
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=pl&countrycodes=pl&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Geokoder nie odpowiedział");
  const hits = (await res.json()) as { lat: string; lon: string; display_name?: string }[];
  const hit = hits?.[0];
  if (!hit) throw new Error("Nie znaleziono tego adresu");
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), display: hit.display_name };
}

/** Współrzędna z inputa: pusty → null, żeby backend wiedział „wyczyść”. */
const parseCoord = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/**
 * Kwota kosztu z inputa. Pusty → `null`, czyli „nieuzupełniony” — i tylko `null`
 * potrafi wyczyścić koszt po stronie backendu (`undefined` wypada z JSON-a,
 * więc stara wartość by została). 0 zł to świadomy wpis, nie brak danych.
 *
 * (Liczba kamer ma dziś własny parser w `ObjectServicesEditor` — tam, gdzie
 * mieszka pole; semantyka bez zmian: puste = „nikt nie policzył”, a nie zero.)
 */
const parseCost = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Pusty string → null, żeby data i link umiały się WYCZYŚCIĆ w bazie. */
const orNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Stan formularza. Świadomie BEZ flag `hasX`/`cameraCount` — źródłem prawdy są
 * `services`, a wysłanie flag razem z okresami i tak nic by nie dało (backend je
 * ignoruje), za to kusiłoby do trzymania dwóch prawd naraz.
 */
type ObjectFormState = Omit<
  ObjectInput,
  "hasCameras" | "hasSswin" | "hasVideoreception" | "hasOfi" | "cameraCount" | "monthlyValue"
> & {
  services: ObjectServiceInput[];
};

/** Okresy z rekordu obiektu w kształcie body zapisu (`id` zostaje — to update). */
function servicesOfObject(object?: ObjectRecord | null): ObjectServiceInput[] {
  return (object?.services ?? []).map((s) => ({
    id: s.id,
    service: s.service,
    startDate: s.startDate,
    endDate: s.endDate,
    cameraCount: s.cameraCount,
    notes: s.notes,
  }));
}

function initialState(
  object: ObjectRecord | null | undefined,
  preselectedContractorId: number | undefined
): ObjectFormState {
  return {
    contractorId: object?.contractorId || preselectedContractorId || 0,
    name: object?.name || "",
    address: object?.address || "",
    city: object?.city || "",
    mapsUrl: object?.mapsUrl ?? "",
    services: servicesOfObject(object),
    expectedEndDate: object?.expectedEndDate ?? "",
    installationType: object?.installationType || "new",
    status: object?.status || "pending",
    department: object?.department || "sales",
    // `?? null`, nie `|| undefined`: pusty abonament musi POJECHAĆ do backendu
    // jako null (żeby go wyczyścić), a 0 zł to świadomy wpis, nie brak danych.
    //
    // Abonament jest ROZBITY na dwie linie (ZDW / OFI) — `monthlyValue` jest
    // polem wyliczanym po stronie backendu i formularz go nie wysyła.
    monthlyZdw: object?.monthlyZdw ?? null,
    monthlyOfi: object?.monthlyOfi ?? null,
    monthlyRental: object?.monthlyRental ?? null,
    monthlyCost: object?.monthlyCost ?? null,
    setupCost: object?.setupCost ?? null,
    salespersonId: object?.salespersonId ?? null,
    companyId: object?.companyId ?? null,
    notes: object?.notes || "",
    latitude: object?.latitude ?? null,
    longitude: object?.longitude ?? null,
  };
}

interface ObjectFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ObjectInput) => Promise<void>;
  object?: ObjectRecord | null;
  preselectedContractorId?: number;
}

export function ObjectForm({
  open,
  onClose,
  onSubmit,
  object,
  preselectedContractorId,
}: ObjectFormProps) {
  const [loading, setLoading] = useState(false);
  const [contractors, setContractors] = useState<ContractorCatalogEntry[]>([]);
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [formData, setFormData] = useState<ObjectFormState>(() =>
    initialState(object, preselectedContractorId)
  );
  /** Migawka stanu początkowego — z niej bierze się „niezapisane zmiany”. */
  const baseline = useRef(JSON.stringify(initialState(object, preselectedContractorId)));
  /** Błąd walidacji (własny) albo komunikat 400 z backendu — jeden blok nad stopką. */
  const [error, setError] = useState<string | null>(null);
  /** Edytor usług sam wie, czy daty się spinają; przy `false` blokujemy zapis. */
  const [servicesValid, setServicesValid] = useState(true);
  /** Filtr listy kontrahentów — kartoteka bywa na kilkaset pozycji. */
  const [contractorQuery, setContractorQuery] = useState("");
  /** Stan przycisku „Ustal z adresu” + komunikat pod polami współrzędnych. */
  const [geocoding, setGeocoding] = useState(false);
  const [mapsBusy, setMapsBusy] = useState(false);
  const [geoNote, setGeoNote] = useState<string | null>(null);
  /** Adres odczytany z pinezki — propozycja, dopóki użytkownik nie kliknie „Wstaw”. */
  const [addrSuggestion, setAddrSuggestion] = useState<ReverseGeocodeHit | null>(null);

  useEffect(() => {
    if (open) {
      // Lista wyboru MUSI mieć całą kartotekę — paginowane `GET /contractors`
      // ucinało ją na rozmiarze strony i nowego obiektu nie dało się przypiąć
      // do klienta z końca alfabetu.
      getContractorCatalog()
        .then((res) => setContractors(res.data ?? []))
        .catch(() => setContractors([]));
      // Archiwalnych nie proponujemy, ale zostawiamy tego, który już jest przypisany.
      getSalespeople()
        .then((res) => setSalespeople(res.data ?? []))
        .catch(() => setSalespeople([]));
      getCompanies()
        .then((res) => setCompanies(res.data ?? []))
        .catch(() => setCompanies([]));
    }
  }, [open]);

  // Otwarcie dialogu = czysty stan. `Objects.tsx:964` montuje formularz z `key`,
  // więc zwykle wystarczyłby inicjalizator `useState`, ale kartoteka obiektu
  // otwiera ten sam komponent bez remountu (przycisk „Edytuj”) — bez resetu
  // drugie wejście pokazywałoby poprzedni obiekt.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      const fresh = initialState(object, preselectedContractorId);
      setFormData(fresh);
      baseline.current = JSON.stringify(fresh);
      setError(null);
      setGeoNote(null);
      setAddrSuggestion(null);
      setContractorQuery("");
      setServicesValid(true);
    } else if (!open) {
      wasOpen.current = false;
    }
  }, [open, object, preselectedContractorId]);

  const dirty = JSON.stringify(formData) !== baseline.current;

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value, type } = e.target;
    setFormData((prev) => ({
      ...prev,
      // Puste pole liczbowe → `null` („wyczyść”), a nie `undefined`.
      // `undefined` wypada z JSON.stringify, więc PUT /objects/:id (`.set({ ...body })`)
      // po prostu nie dostawał tego klucza i stara kwota zostawała w bazie —
      // czyszczenie abonamentu nic nie robiło. Ta sama reguła co w `parseCost`.
      [name]: type === "number" ? parseCost(value) : value,
    }));
  };

  const addressLine = [formData.address, formData.city]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(", ");

  const mapsUrlValue = (formData.mapsUrl ?? "").trim();
  /** Link spoza domen Google backend odrzuci 400 — mówimy o tym PRZED wysyłką. */
  const mapsUrlSuspicious = mapsUrlValue !== "" && !isGoogleMapsUrl(mapsUrlValue);

  /**
   * Flagi usług „na dziś” policzone z okresów — ten sam rachunek, który zrobi
   * backend po zapisie (`flagsFromServices`). Formularz używa ich wyłącznie do
   * ostrzeżeń przy abonamentach.
   */
  const activeFlags = useMemo(
    () => activeServiceFlagsOf(formData.services.filter((s) => !!s.startDate)),
    [formData.services]
  );
  /** Czy zaznaczono cokolwiek, co obsługuje centrum monitorowania (linia ZDW). */
  const zdwSelected =
    activeFlags.hasCameras || activeFlags.hasSswin || activeFlags.hasVideoreception;

  const contractorName = useMemo(
    () => contractors.find((c) => c.id === formData.contractorId)?.name ?? null,
    [contractors, formData.contractorId]
  );

  const visibleContractors = useMemo(() => {
    const q = contractorQuery.trim().toLowerCase();
    if (!q) return contractors;
    return contractors.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.nip ?? "").toLowerCase().includes(q) ||
        c.id === formData.contractorId
    );
  }, [contractors, contractorQuery, formData.contractorId]);

  /**
   * Podpowiedź pod parą „wartość / koszt”. Pusty koszt to brak danych, a nie 0 zł
   * — wtedy marży nie da się policzyć i mówimy o tym wprost.
   */
  const marginHint = (() => {
    // Przychód miesięczny to OBA abonamenty PLUS dzierżawa sprzętu — klient
    // płaci wszystkie pozycje, więc marża liczona z jednej byłaby zaniżona.
    const filled = (v: number | null | undefined) => v !== null && v !== undefined;
    const hasAny =
      filled(formData.monthlyZdw) || filled(formData.monthlyOfi) || filled(formData.monthlyRental);
    const value =
      (formData.monthlyZdw ?? 0) + (formData.monthlyOfi ?? 0) + (formData.monthlyRental ?? 0);
    const cost = formData.monthlyCost;
    if (cost === null || cost === undefined) return "Marża: — (uzupełnij koszt)";
    if (!hasAny) return "Marża: — (uzupełnij wartość miesięczną)";
    const profit = value - cost;
    const pct = value > 0 ? Math.round((profit / value) * 100) : null;
    let text = `Marża: ${formatCurrency(profit)}${pct !== null ? ` (${pct}%)` : ""}`;
    const setup = formData.setupCost;
    if (setup !== null && setup !== undefined && profit > 0) {
      text += ` · zwrot instalacji: ${Math.ceil(setup / profit)} mies.`;
    }
    return text;
  })();

  // --- Lokalizacja: link → współrzędne → (opcjonalnie) adres z pinezki --------

  const addressRef = useRef({ address: "", city: "" });
  addressRef.current = { address: formData.address ?? "", city: formData.city ?? "" };

  /**
   * Współrzędne z tego, co człowiek wkleił. `resolveMapsLink` sam decyduje, czy
   * wystarczy parser, czy trzeba poprosić serwer o rozwinięcie krótkiego linku
   * (`maps.app.goo.gl` — przeglądarka nie pójdzie za przekierowaniem przez CORS).
   */
  const applyMapsLink = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) {
      setGeoNote("Wklej link Google Maps albo „szer, dł”.");
      return;
    }
    setMapsBusy(true);
    setGeoNote(null);
    setAddrSuggestion(null);
    try {
      const hit = await resolveMapsLink(value);
      setFormData((prev) => ({ ...prev, latitude: hit.lat, longitude: hit.lng }));
      let note =
        hit.source === "resolved"
          ? "Krótki link rozwinięty — współrzędne ustalone."
          : "Współrzędne odczytane z linku.";
      // Adresu NIE nadpisujemy: podpowiadamy go tylko wtedy, gdy pola są puste,
      // a i wtedy wstawia go dopiero kliknięcie „Wstaw”.
      const { address, city } = addressRef.current;
      if (!address.trim() || !city.trim()) {
        const rev = await reverseGeocode(hit.lat, hit.lng);
        if (rev && (rev.street || rev.city)) setAddrSuggestion(rev);
        else note += " Adresu z pinezki nie udało się odczytać.";
      }
      setGeoNote(note);
    } catch (e) {
      setGeoNote(e instanceof Error ? e.message : "Nie udało się odczytać pinezki z tego linku.");
    } finally {
      setMapsBusy(false);
    }
  }, []);

  /**
   * Link albo „szer, dł” wpisane w polu ADRESU. Adres to miejsce na tekst,
   * a nie na URL — przerzucamy wartość tam, gdzie jej miejsce (link do pola
   * linku, gołe współrzędne prosto do lat/lng) i od razu ją odczytujemy.
   */
  const handleDirectInput = useCallback(
    (raw: string) => {
      const value = raw.trim();
      const isLink = /^https?:\/\//i.test(value);
      setFormData((prev) => ({
        ...prev,
        address: "",
        ...(isLink ? { mapsUrl: value } : {}),
      }));
      void applyMapsLink(value);
    },
    [applyMapsLink]
  );

  const runGeocode = async () => {
    // W polu adresu siedzi link albo współrzędne → „Ustal z adresu” zachowuje się
    // jak „Odczytaj współrzędne”; geokoder i tak by tego nie zrozumiał.
    const raw = (formData.address ?? "").trim();
    if (isDirectInput(raw)) {
      handleDirectInput(raw);
      return;
    }
    if (!addressLine) return;
    setGeocoding(true);
    setGeoNote(null);
    setAddrSuggestion(null);
    try {
      const hit = await geocodeAddress(addressLine);
      setFormData((prev) => ({ ...prev, latitude: hit.lat, longitude: hit.lng }));
      setGeoNote(hit.display ? `Znaleziono: ${hit.display}` : "Współrzędne ustalone.");
    } catch (err) {
      setGeoNote(err instanceof Error ? err.message : "Nie udało się ustalić współrzędnych");
    } finally {
      setGeocoding(false);
    }
  };

  // --- Usługi ----------------------------------------------------------------

  const handleServicesChange = useCallback(
    (next: ObjectServiceInput[]) => setFormData((prev) => ({ ...prev, services: next })),
    []
  );
  const handleServicesValidity = useCallback((valid: boolean) => setServicesValid(valid), []);

  // --- Zapis -----------------------------------------------------------------

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!formData.contractorId) {
      setError("Wybierz kontrahenta — obiekt musi wisieć przy kliencie.");
      return;
    }
    if (!(formData.name ?? "").trim()) {
      setError("Podaj nazwę obiektu.");
      return;
    }
    if (!servicesValid) {
      setError("Popraw daty w okresach usług — czerwone wiersze w sekcji „Usługi”.");
      return;
    }
    if (mapsUrlSuspicious) {
      setError(
        "Link musi prowadzić do Google Maps (google.com, google.pl, maps.app.goo.gl, g.co). Inny adres backend odrzuci."
      );
      return;
    }
    setLoading(true);
    try {
      // Body: `services` zamiast flag (backend wylicza `hasX`/`cameraCount`
      // z okresów aktywnych), a puste data/link jako `null` — żeby dało się je
      // WYCZYŚCIĆ; `undefined` wypadłoby z JSON-a i stara wartość by została.
      const payload: ObjectInput = {
        ...formData,
        mapsUrl: orNull(formData.mapsUrl),
        expectedEndDate: orNull(formData.expectedEndDate),
        services: formData.services,
      };
      await onSubmit(payload);
      onClose();
    } catch (err) {
      // `request()` w lib/api.ts przenosi polski komunikat 400 do `Error.message`.
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Nie udało się zapisać obiektu."
      );
    } finally {
      setLoading(false);
    }
  };

  const statusKey = formData.status ?? "pending";
  const titleText = object ? object.name || "Obiekt" : "Nowy obiekt";
  const metaLine = [
    contractorName ?? (object ? "Kontrahent" : "Wybierz kontrahenta"),
    object ? `#${object.id}` : "nowy",
    dirty ? "niezapisane zmiany" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const hint = (text: string) => (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 overflow-hidden p-0",
          "sm:h-auto sm:max-h-[92vh] sm:max-w-3xl sm:rounded-lg",
          "motion-reduce:animate-none motion-reduce:transition-none"
        )}
      >
        {/* Nagłówek — wzorzec: CalendarEventDialog.tsx:2811 */}
        <div className="relative shrink-0 border-b px-5 pb-3 pr-12 pt-4">
          <div className={cn("absolute inset-x-0 top-0 h-1", ACCENT.bar)} aria-hidden />
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                ACCENT.soft
              )}
              aria-hidden
            >
              <Building2 className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold leading-tight">
                <span className="truncate">{titleText}</span>
                <span className={pillClass(STATUS_TONE[statusKey] ?? "muted")}>
                  {statusLabels[statusKey] ?? statusKey}
                </span>
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
                {metaLine}
              </DialogDescription>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          {/* Body — wzorzec: CalendarEventDialog.tsx:4205 */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="space-y-4 px-5 py-4">
              {/* --- PODSTAWOWE ------------------------------------------- */}
              <Section id="object-basic" icon={Building2} title="Podstawowe">
                <div className="space-y-1.5">
                  <Label htmlFor="contractorId">Kontrahent *</Label>
                  {/*
                    Zwykły `Select` z filtrem nad nim, a nie `ContractorPicker`:
                    picker jest polem TEKSTOWYM po `GET /contractors` (paginowane,
                    inne uprawnienia) i oddaje `Contractor`, a tutaj potrzebne jest
                    twarde `contractorId` z pełnej kartoteki (`/contractors/catalog`).
                    Filtr pojawia się dopiero przy dłuższej liście — przy kilku
                    pozycjach byłby tylko hałasem.
                  */}
                  {contractors.length > 12 && (
                    <div className="relative">
                      <Search
                        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                      />
                      <Input
                        data-testid="object-contractor-search"
                        className="h-8 pl-7"
                        placeholder="Filtruj po nazwie lub NIP…"
                        aria-label="Filtruj listę kontrahentów"
                        value={contractorQuery}
                        onChange={(e) => setContractorQuery(e.target.value)}
                      />
                    </div>
                  )}
                  <Select
                    value={formData.contractorId ? String(formData.contractorId) : ""}
                    onValueChange={(value) =>
                      setFormData((p) => ({ ...p, contractorId: parseInt(value, 10) }))
                    }
                  >
                    <SelectTrigger id="contractorId" data-testid="object-contractor">
                      <SelectValue placeholder="Wybierz kontrahenta" />
                    </SelectTrigger>
                    <SelectContent>
                      {visibleContractors.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name} ({c.nip})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {contractorQuery.trim() && visibleContractors.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Żaden kontrahent nie pasuje do filtra.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="name">Nazwa obiektu *</Label>
                  <Input
                    id="name"
                    name="name"
                    data-testid="object-name"
                    value={formData.name}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="object-company">Spółka</Label>
                    <Select
                      value={formData.companyId ? String(formData.companyId) : "none"}
                      onValueChange={(value) =>
                        setFormData((p) => ({
                          ...p,
                          companyId: value === "none" ? null : parseInt(value),
                        }))
                      }
                    >
                      <SelectTrigger id="object-company" data-testid="object-company">
                        <SelectValue placeholder="Bez spółki" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Bez spółki</SelectItem>
                        {companies
                          .filter((co) => co.active || co.id === formData.companyId)
                          .map((co) => (
                            <SelectItem key={co.id} value={String(co.id)}>
                              {co.name}
                              {!co.active ? " (archiwalna)" : ""}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {hint("Spółka grupy obsługująca obiekt — ten sam słownik, co w kadrach.")}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="object-salesperson">Handlowiec</Label>
                    <Select
                      value={formData.salespersonId ? String(formData.salespersonId) : "inherit"}
                      onValueChange={(value) =>
                        setFormData((p) => ({
                          ...p,
                          salespersonId: value === "inherit" ? null : parseInt(value),
                        }))
                      }
                    >
                      <SelectTrigger id="object-salesperson" data-testid="object-salesperson">
                        <SelectValue placeholder="Opiekun kontrahenta" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">Jak u kontrahenta</SelectItem>
                        {salespeople
                          .filter((sp) => sp.active || sp.id === formData.salespersonId)
                          .map((sp) => (
                            <SelectItem key={sp.id} value={String(sp.id)}>
                              {salespersonName(sp)}
                              {!sp.active ? " (archiwalny)" : ""}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {hint("Puste = obiekt dziedziczy opiekuna przypisanego kontrahentowi.")}
                  </div>
                </div>

                {/* Typ instalacji, status i dział w jednym rzędzie — po wyjęciu
                    „typu ochrony” zostałby sam z pustą połową wiersza. */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="installationType">Typ instalacji *</Label>
                    <Select
                      value={formData.installationType}
                      onValueChange={(value) =>
                        setFormData((p) => ({
                          ...p,
                          installationType: value as ObjectInput["installationType"],
                        }))
                      }
                    >
                      <SelectTrigger id="installationType" data-testid="object-installation-type">
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
                  <div className="space-y-1.5">
                    <Label htmlFor="status">Status</Label>
                    <Select
                      value={formData.status}
                      onValueChange={(value) =>
                        setFormData((p) => ({ ...p, status: value as ObjectInput["status"] }))
                      }
                    >
                      <SelectTrigger id="status" data-testid="object-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(statusLabels).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="department">Dział</Label>
                    <Select
                      value={formData.department}
                      onValueChange={(value) =>
                        setFormData((p) => ({
                          ...p,
                          department: value as ObjectInput["department"],
                        }))
                      }
                    >
                      <SelectTrigger id="department" data-testid="object-department">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(departmentLabels).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </Section>

              {/* --- LOKALIZACJA ------------------------------------------ */}
              <Section id="object-location" icon={MapPin} title="Lokalizacja">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="address">Adres</Label>
                    <Input
                      id="address"
                      name="address"
                      data-testid="object-address"
                      placeholder="ul. Prosta 51 — albo wklej link do Maps"
                      value={formData.address}
                      onChange={handleChange}
                      // Wklejony link/„szer, dł” ląduje w polu linku, a nie w adresie.
                      onPaste={(e) => {
                        const text = e.clipboardData.getData("text");
                        if (!isDirectInput(text)) return;
                        e.preventDefault();
                        handleDirectInput(text);
                      }}
                      // Druga furtka: wpisane ręcznie albo wklejone przez menu
                      // kontekstowe (wtedy `onPaste` nie leci przez React).
                      onBlur={(e) => {
                        const v = e.target.value;
                        if (isDirectInput(v)) handleDirectInput(v);
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="city">Miasto</Label>
                    <Input
                      id="city"
                      name="city"
                      data-testid="object-city"
                      value={formData.city}
                      onChange={handleChange}
                    />
                  </div>
                </div>

                {/* Link do pinezki — trzymany na obiekcie (`objects.maps_url`),
                    żeby kartoteka i zlecenie prowadziły w to samo miejsce.
                    Backend przyjmuje WYŁĄCZNIE domeny Google. */}
                <div className="space-y-1.5">
                  <Label htmlFor="object-maps-url">Link Google Maps</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                      <Link2
                        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                      />
                      <Input
                        id="object-maps-url"
                        name="mapsUrl"
                        data-testid="object-maps-url"
                        type="url"
                        className="pl-7"
                        placeholder="https://maps.app.goo.gl/… lub link z pinezką"
                        value={formData.mapsUrl ?? ""}
                        onChange={handleChange}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      data-testid="object-maps-resolve"
                      disabled={mapsBusy || mapsUrlValue === ""}
                      onClick={() => void applyMapsLink(mapsUrlValue)}
                      {...tip(
                        "Odczytaj współrzędne z linku — krótkie linki rozwija serwer."
                      )}
                    >
                      {mapsBusy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <MapPin className="mr-2 h-4 w-4" aria-hidden />
                      )}
                      Odczytaj współrzędne
                    </Button>
                  </div>
                  {mapsUrlSuspicious && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      To nie wygląda na link Google Maps — backend przyjmie tylko
                      google.com, google.pl, maps.app.goo.gl albo g.co.
                    </p>
                  )}
                </div>

                {/* Współrzędne — z nich liczy się dystans biuro → obiekt (kilometry
                    w realizacjach). Puste = automat ustali je sam przy kalkulacji. */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="latitude">Szerokość (lat)</Label>
                      <Input
                        id="latitude"
                        name="latitude"
                        data-testid="object-latitude"
                        type="number"
                        step="0.000001"
                        className="w-40 tabular-nums"
                        placeholder="np. 52.406374"
                        value={formData.latitude ?? ""}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, latitude: parseCoord(e.target.value) }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="longitude">Długość (lng)</Label>
                      <Input
                        id="longitude"
                        name="longitude"
                        data-testid="object-longitude"
                        type="number"
                        step="0.000001"
                        className="w-40 tabular-nums"
                        placeholder="np. 16.925168"
                        value={formData.longitude ?? ""}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, longitude: parseCoord(e.target.value) }))
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      data-testid="object-geocode"
                      disabled={geocoding || (!addressLine && !isDirectInput(formData.address ?? ""))}
                      onClick={() => void runGeocode()}
                      {...tip(
                        addressLine
                          ? `Zapytaj geokoder o współrzędne dla: ${addressLine}`
                          : "Najpierw wpisz adres albo miasto — pole przyjmie też „szer, dł” i link Google Maps"
                      )}
                    >
                      {geocoding ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <MapPin className="mr-2 h-4 w-4" aria-hidden />
                      )}
                      Ustal z adresu
                    </Button>
                  </div>
                  <div
                    className="space-y-1 text-xs text-muted-foreground"
                    data-testid="object-geo-note"
                  >
                    <p>
                      {geoNote ??
                        "Z tych współrzędnych automat liczy kilometry biuro → obiekt. Puste pola uzupełni sam przy pierwszej kalkulacji."}
                    </p>
                    {addrSuggestion && (
                      <p className="flex flex-wrap items-center gap-2">
                        <span>
                          Adres z pinezki: <span className="text-foreground">{addrSuggestion.display}</span>
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          data-testid="object-geo-apply"
                          onClick={() => {
                            setFormData((prev) => ({
                              ...prev,
                              address: addrSuggestion.street || prev.address,
                              city: addrSuggestion.city || prev.city,
                            }));
                            setAddrSuggestion(null);
                          }}
                        >
                          Wstaw
                        </Button>
                      </p>
                    )}
                  </div>
                </div>
              </Section>

              {/* --- USŁUGI ----------------------------------------------- */}
              <Section id="object-services" icon={ShieldCheck} title="Usługi">
                <ObjectServicesEditor
                  value={formData.services}
                  onChange={handleServicesChange}
                  onValidityChange={handleServicesValidity}
                  disabled={loading}
                />
                {hint(
                  "Od usług zależy sposób liczenia kosztu osobowego: OFI liczy się z godzin pracowników tego obiektu, a kamery, SSWiN i wideorecepcja — udziałem w koszcie centrum monitorowania. Okres zakończony przestaje się liczyć, ale zostaje w historii."
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="expectedEndDate">Przewidywane zakończenie obiektu</Label>
                  <Input
                    id="expectedEndDate"
                    name="expectedEndDate"
                    data-testid="object-expected-end"
                    type="date"
                    className="w-[11rem] tabular-nums"
                    value={formData.expectedEndDate ?? ""}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, expectedEndDate: e.target.value }))
                    }
                  />
                  {hint(
                    "Kiedy planowo kończy się obsługa całego obiektu. Puste = bezterminowo."
                  )}
                </div>
              </Section>

              {/* --- FINANSE ---------------------------------------------- */}
              <Section id="object-finance" icon={Coins} title="Finanse">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    {/* „zł netto" w etykiecie, a nie samo „PLN": abonament wchodzi
                        tu wprost ze zlecenia („Abonament (zł netto)"), więc pole
                        musi mówić tym samym językiem, co formularz, z którego
                        kwota przyszła.

                        Abonament jest ROZBITY na dwie linie, bo Analityka pyta
                        osobno o dozór i osobno o ochronę fizyczną — przy jednej
                        kwocie obiekt mieszany liczył się w obu przekrojach dwa
                        razy (src/lib/abonament-split.ts). */}
                    <Label htmlFor="monthlyZdw">Abonament ZDW (zł netto/mies.)</Label>
                    {/* `?? ""` zamiast `|| ""` — 0 zł to wpisana kwota („obiekt bez
                        abonamentu”), a `|| ""` zamieniałby ją w puste pole. */}
                    <Input
                      id="monthlyZdw"
                      name="monthlyZdw"
                      data-testid="object-monthly-zdw"
                      type="number"
                      step="0.01"
                      className="tabular-nums"
                      value={formData.monthlyZdw ?? ""}
                      onChange={handleChange}
                    />
                    {/* Pola NIE BLOKUJEMY, gdy usługi nie ma na liście: kolejność
                        wypełniania formularza bywa dowolna, a twarde wyłączenie
                        kasowałoby wpisaną kwotę. Zamiast tego mówimy wprost, że
                        coś się nie zgadza — liczone z OKRESÓW aktywnych. */}
                    {!zdwSelected && formData.monthlyZdw !== null && formData.monthlyZdw !== undefined ? (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        Obiekt nie ma dziś aktywnego okresu dozoru (kamery / SSWiN / wideorecepcja).
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    {/* Druga linia abonamentu — ochrona fizyczna. */}
                    <Label htmlFor="monthlyOfi">Abonament OFI (zł netto/mies.)</Label>
                    <Input
                      id="monthlyOfi"
                      name="monthlyOfi"
                      data-testid="object-monthly-ofi"
                      type="number"
                      step="0.01"
                      className="tabular-nums"
                      value={formData.monthlyOfi ?? ""}
                      onChange={handleChange}
                    />
                    {!activeFlags.hasOfi && formData.monthlyOfi !== null && formData.monthlyOfi !== undefined ? (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        Obiekt nie ma dziś aktywnego okresu ochrony fizycznej.
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    {/* Osobno od abonamentów, bo to inny tytuł płatności — najem
                        sprzętu, nie usługa. Przychód obiektu to suma wszystkich
                        trzech pozycji; w Analityce dzierżawa liczy się do ZDV. */}
                    <Label htmlFor="monthlyRental">Dzierżawa sprzętu (zł netto/mies.)</Label>
                    <Input
                      id="monthlyRental"
                      name="monthlyRental"
                      data-testid="object-monthly-rental"
                      type="number"
                      step="0.01"
                      min="0"
                      className="tabular-nums"
                      value={formData.monthlyRental ?? ""}
                      onChange={handleChange}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="monthlyCost">Koszt miesięczny — pozostały (zł netto)</Label>
                    {/* `?? ""` zamiast `|| ""` — 0 zł to świadomy wpis („obiekt nic
                        nie kosztuje”), a `|| ""` zamieniałby go w puste pole. */}
                    <Input
                      id="monthlyCost"
                      name="monthlyCost"
                      data-testid="object-monthly-cost"
                      type="number"
                      step="0.01"
                      min="0"
                      className="tabular-nums"
                      value={formData.monthlyCost ?? ""}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, monthlyCost: parseCost(e.target.value) }))
                      }
                    />
                    {/* To pole to koszt POZA wynagrodzeniami. Pensje załogi dolicza
                        Analityka z Kadr (godziny × wypłaty) i sumuje z tą kwotą —
                        wpisanie tu pensji policzyłoby ludzi drugi raz. */}
                    {hint(
                      "Monitoring, sprzęt, abonamenty — wszystko poza wynagrodzeniami. Koszt osobowy dolicza się sam z Kadr."
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="setupCost">Koszt instalacji / wdrożenia (zł netto, jednorazowo)</Label>
                    <Input
                      id="setupCost"
                      name="setupCost"
                      data-testid="object-setup-cost"
                      type="number"
                      step="0.01"
                      min="0"
                      className="tabular-nums"
                      value={formData.setupCost ?? ""}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, setupCost: parseCost(e.target.value) }))
                      }
                    />
                  </div>
                </div>
                <p
                  className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground"
                  data-testid="object-margin-hint"
                >
                  {marginHint}
                </p>
              </Section>

              {/* --- UWAGI ------------------------------------------------ */}
              <Section id="object-notes" icon={StickyNote} title="Uwagi">
                <Textarea
                  id="notes"
                  name="notes"
                  data-testid="object-notes"
                  value={formData.notes}
                  onChange={handleChange}
                  rows={3}
                  placeholder="Wszystko, czego nie mieści reszta formularza — kod do bramy, kontakt na obiekcie, ustalenia."
                />
              </Section>
            </div>
          </div>

          {/* Błąd zapisu — nad stopką, żeby nie uciekł ze wzroku po przewinięciu
              długiego formularza (kalendarz trzyma go w body, ale tam sekcje są
              krótsze). Kształt jak w CalendarEventDialog.tsx:4211. */}
          {error && (
            <div
              role="alert"
              data-testid="object-form-error"
              className="mx-5 mb-3 flex shrink-0 items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {/* Stopka — wzorzec: CalendarEventDialog.tsx:4222 */}
          <div className="shrink-0 border-t bg-background px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
                {dirty ? "Niezapisane zmiany" : object ? "Bez zmian" : "Nowy obiekt"}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onClose}
                  disabled={loading}
                  data-testid="object-cancel"
                >
                  Anuluj
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={loading || !servicesValid}
                  data-testid="object-submit"
                  {...tip(
                    servicesValid
                      ? object
                        ? "Zapisz zmiany w obiekcie"
                        : "Utwórz obiekt"
                      : "Popraw daty okresów usług"
                  )}
                >
                  {loading && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
                  {loading ? "Zapisywanie…" : "Zapisz"}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
