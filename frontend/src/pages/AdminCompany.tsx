/**
 * Administracja → Firma (kontrakt AUTOFILL §1).
 *
 * Jedno miejsce, z którego automat realizacji bierze twarde dane: adres biura
 * (punkt startowy kilometrów), stawki i zakres samego automatu. Wzorzec strony
 * — szkic + sticky pasek zapisu + sekcje — jak w Administracja → Kalendarz.
 *
 * Defensywnie: gdy backend nie ma jeszcze `/admin/company/*`, strona pokazuje
 * czytelny komunikat, a akcje zostają nieaktywne (zamiast wykładać panel).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calculator,
  Loader2,
  Map as MapIcon,
  RefreshCw,
  Save,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LocationPicker } from "@/components/LocationPicker";
import { ErrorBox, Field, SectionCard, Switch, Tile } from "@/components/admin-assistant/shared";
import { deepEq, errMsg, selectClass, useFlash } from "@/components/admin-assistant/helpers";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  adminCompanyApi,
  AUTOFILL_FIELD_LABEL,
  AUTOFILL_FIELDS,
  COMPANY_FALLBACK_VALUES,
  getObjects,
  isMissingEndpoint,
  KM_SOURCE_LABEL,
  type AdminCompanySettings,
  type AdminCompanySettingsUpdate,
  type CompanyDistanceTest,
  type CompanyKmSource,
  type CompanySettingsField,
  type CompanySettingsValues,
  type ObjectWithContractor,
} from "@/lib/api";

const pln = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const dec = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 });

/**
 * Podgląd narzutu na okrągłej kwocie — sam mnożnik („1,65”) niewiele mówi,
 * a „1 000 zł netto → 1 650 zł kosztu” od razu pokazuje, co się liczy.
 */
const markupExample = (m: number) =>
  `1 000 zł netto → ${pln.format(1000 * (Number.isFinite(m) ? m : 0))} kosztu`;

type Draft = Partial<CompanySettingsValues>;

/** „lat, lng" → URL Google Maps, którym karmimy `LocationPicker`. */
const toMapsUrl = (lat: number | null, lng: number | null) =>
  lat == null || lng == null ? "" : `https://www.google.com/maps?q=${lat},${lng}`;

/** Odczyt współrzędnych z URL-a zwróconego przez `LocationPicker`. */
function parseMapsUrl(url: string): { lat: number; lng: number } | null {
  const m = url.match(/[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function AdminCompany() {
  const [settings, setSettings] = useState<AdminCompanySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, flash] = useFlash();

  const [geocoding, setGeocoding] = useState(false);
  const [geoNote, setGeoNote] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);

  const [objects, setObjects] = useState<ObjectWithContractor[]>([]);
  const [testObjectId, setTestObjectId] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<CompanyDistanceTest | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await adminCompanyApi.settings();
    setSettings(s);
    setDraft({});
  }, []);

  useEffect(() => {
    load().catch((e) => {
      if (isMissingEndpoint(e)) {
        setUnavailable(true);
        // Panel działa „na sucho": pokazujemy wartości domyślne, zapis zablokowany.
        setSettings({ values: { ...COMPANY_FALLBACK_VALUES } });
      } else {
        setLoadError(errMsg(e, "Nie udało się wczytać ustawień firmy"));
      }
    });
  }, [load]);

  // Obiekty do testu kalkulacji (lista bywa długa — bierzemy jednorazowo).
  useEffect(() => {
    getObjects({ pageSize: 500 })
      .then((res) => setObjects(res.data || []))
      .catch(() => setObjects([]));
  }, []);

  const values: CompanySettingsValues = useMemo(
    () => ({ ...COMPANY_FALLBACK_VALUES, ...(settings?.values ?? {}) }),
    [settings]
  );
  const val = <K extends CompanySettingsField>(k: K): CompanySettingsValues[K] =>
    (k in draft ? draft[k] : values[k]) as CompanySettingsValues[K];
  const setField = <K extends CompanySettingsField>(k: K, v: CompanySettingsValues[K]) =>
    setDraft((d) => {
      const next = { ...d };
      if (deepEq(values[k], v)) delete next[k];
      else (next as Record<K, CompanySettingsValues[K]>)[k] = v;
      return next;
    });
  const isDirty = (k: CompanySettingsField) => k in draft;
  const dirtyCount = Object.keys(draft).length;
  const source = (k: CompanySettingsField) => settings?.sources?.[k];

  // Ostrzeżenie przeglądarki przy wyjściu z niezapisanymi zmianami.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  const save = async () => {
    if (dirtyCount === 0 || unavailable) return;
    setSaving(true);
    setError(null);
    try {
      const s = await adminCompanyApi.updateSettings(draft as AdminCompanySettingsUpdate);
      setSettings(s);
      setDraft({});
      flash("Ustawienia firmy zapisane.");
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać ustawień"));
    } finally {
      setSaving(false);
    }
  };

  const runGeocode = async () => {
    setGeocoding(true);
    setGeoNote(null);
    try {
      const res = await adminCompanyApi.geocode({
        address: val("officeAddress"),
        city: val("officeCity"),
        postcode: val("officePostcode"),
      });
      setField("officeLat", res.lat);
      setField("officeLng", res.lng);
      setGeoNote(
        res.display
          ? `Znaleziono: ${res.display}`
          : `Znaleziono: ${dec.format(res.lat)}, ${dec.format(res.lng)}`
      );
    } catch (e) {
      setGeoNote(
        isMissingEndpoint(e)
          ? "Geokoder niedostępny w tej wersji backendu — wpisz współrzędne ręcznie."
          : errMsg(e, "Nie udało się ustalić współrzędnych")
      );
    } finally {
      setGeocoding(false);
    }
  };

  const runTest = async () => {
    const id = parseInt(testObjectId, 10);
    if (!Number.isFinite(id)) return;
    setTestBusy(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await adminCompanyApi.testDistance(id);
      // Brak adresu / brak sieci wraca jako `{ error }` w danych (HTTP 200).
      if (res.error || !res.distance) {
        setTestError(res.error || "Brak danych do policzenia dystansu dla tego obiektu.");
      } else {
        setTestResult(res);
      }
    } catch (e) {
      setTestError(
        isMissingEndpoint(e)
          ? "Kalkulacja dystansu niedostępna w tej wersji backendu."
          : errMsg(e, "Nie udało się policzyć dystansu")
      );
    } finally {
      setTestBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-3">
        <ErrorBox>{loadError}</ErrorBox>
        <Button
          variant="outline"
          onClick={() =>
            load()
              .then(() => setLoadError(null))
              .catch((e) => setLoadError(errMsg(e, "Błąd")))
          }
        >
          <RefreshCw className="mr-1 h-4 w-4" /> Spróbuj ponownie
        </Button>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytywanie ustawień…
        </div>
      </div>
    );
  }

  const lat = val("officeLat");
  const lng = val("officeLng");
  const hasCoords = lat != null && lng != null;
  const autofillFields = val("autofillFields");
  const kmRoundTrip = val("kmRoundTrip");
  const rateKm = val("rateKm");
  /** Przykład na 12,4 km — pokazuje, co dokładnie robią stawki i round trip. */
  const kmExample = `12,4 km${kmRoundTrip ? " × 2" : ""} × ${dec.format(rateKm)} zł = ${pln.format(
    12.4 * (kmRoundTrip ? 2 : 1) * rateKm
  )}`;

  return (
    <div className="space-y-3 pb-24">
      {unavailable && (
        <div
          className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          role="status"
          data-testid="company-unavailable"
        >
          Backend nie udostępnia jeszcze <code className="rounded bg-muted px-1">/api/admin/company/settings</code> —
          poniżej wartości domyślne, zapis jest zablokowany.
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {notice && (
        <div
          className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400"
          role="status"
        >
          {notice}
        </div>
      )}

      <SectionCard
        id="adres"
        title="Adres biura"
        description="Punkt startowy kilometrów. Z adresu wyliczamy współrzędne, a z nich dystans biuro → obiekt przy uzupełnianiu realizacji."
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)]">
          <Field
            id="company-address"
            label="Ulica i numer"
            source={source("officeAddress")}
            dirty={isDirty("officeAddress")}
          >
            <Input
              id="company-address"
              data-testid="company-address"
              value={val("officeAddress")}
              placeholder="np. Przemysłowa 12"
              onChange={(e) => setField("officeAddress", e.target.value)}
            />
          </Field>
          <Field
            id="company-postcode"
            label="Kod pocztowy"
            source={source("officePostcode")}
            dirty={isDirty("officePostcode")}
          >
            <Input
              id="company-postcode"
              data-testid="company-postcode"
              value={val("officePostcode")}
              placeholder="00-000"
              onChange={(e) => setField("officePostcode", e.target.value)}
            />
          </Field>
          <Field
            id="company-city"
            label="Miejscowość"
            source={source("officeCity")}
            dirty={isDirty("officeCity")}
          >
            <Input
              id="company-city"
              data-testid="company-city"
              value={val("officeCity")}
              placeholder="np. Poznań"
              onChange={(e) => setField("officeCity", e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field id="company-lat" label="Szerokość (lat)" source={source("officeLat")} dirty={isDirty("officeLat")}>
            <Input
              id="company-lat"
              data-testid="company-lat"
              type="number"
              step="0.000001"
              className="w-40 tabular-nums"
              value={lat ?? ""}
              onChange={(e) => setField("officeLat", e.target.value === "" ? null : parseFloat(e.target.value))}
            />
          </Field>
          <Field id="company-lng" label="Długość (lng)" source={source("officeLng")} dirty={isDirty("officeLng")}>
            <Input
              id="company-lng"
              data-testid="company-lng"
              type="number"
              step="0.000001"
              className="w-40 tabular-nums"
              value={lng ?? ""}
              onChange={(e) => setField("officeLng", e.target.value === "" ? null : parseFloat(e.target.value))}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            data-testid="company-geocode"
            disabled={geocoding || (!val("officeAddress").trim() && !val("officeCity").trim())}
            onClick={() => void runGeocode()}
            {...tip("Zapytaj geokoder (Nominatim) o współrzędne wpisanego adresu")}
          >
            {geocoding ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Search className="mr-1 h-4 w-4" aria-hidden />
            )}
            Wyszukaj współrzędne
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-testid="company-map-toggle"
            onClick={() => setMapOpen((o) => !o)}
            {...tip("Mapa ładuje kafelki z sieci — otwórz, gdy chcesz poprawić pinezkę ręcznie")}
          >
            <MapIcon className="mr-1 h-4 w-4" aria-hidden />
            {mapOpen ? "Ukryj mapę" : "Wskaż na mapie"}
          </Button>
        </div>

        {geoNote && (
          <p className="text-xs text-muted-foreground" data-testid="company-geo-note">
            {geoNote}
          </p>
        )}
        {!hasCoords && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Bez współrzędnych biura automat nie policzy kilometrów — użyj „Wyszukaj współrzędne" albo wpisz je ręcznie.
          </p>
        )}

        {mapOpen && (
          <div data-testid="company-map">
            <LocationPicker
              value={toMapsUrl(lat, lng)}
              onChange={(url) => {
                const c = parseMapsUrl(url);
                if (!c) return;
                setField("officeLat", c.lat);
                setField("officeLng", c.lng);
              }}
              initialAddress={[val("officeAddress"), val("officeCity")].filter(Boolean).join(", ")}
            />
          </div>
        )}
      </SectionCard>

      <SectionCard
        id="stawki"
        title="Stawki domyślne"
        description="Używane, gdy technik nie ma własnej pozycji w cenniku. Kwoty netto. Norma dnia dotyczy wydarzeń całodniowych."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="company-work-day-hours"
            label="Norma dnia roboczego"
            source={source("workDayHours")}
            dirty={isDirty("workDayHours")}
            description="Ile godzin proponować dla wydarzenia całodniowego (dni × norma). Wyłącznie sugestia w „Uzupełnij z danych” protokołu — sama się nie wpisuje."
          >
            <Input
              id="company-work-day-hours"
              data-testid="company-work-day-hours"
              type="number"
              step="0.25"
              min="0"
              max="24"
              className="tabular-nums"
              value={val("workDayHours")}
              onChange={(e) => setField("workDayHours", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-rate-hour"
            label="Stawka za roboczogodzinę"
            source={source("rateHour")}
            dirty={isDirty("rateHour")}
            description="Trafia do „Kwota za godziny” (godziny × stawka). Pozycja RBH w cenniku technika ma pierwszeństwo."
          >
            <Input
              id="company-rate-hour"
              data-testid="company-rate-hour"
              type="number"
              step="0.01"
              min="0"
              className="tabular-nums"
              value={val("rateHour")}
              onChange={(e) => setField("rateHour", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-hourly-cost"
            label="Koszt godzinowy (wewnętrzny)"
            source={source("hourlyCost")}
            dirty={isDirty("hourlyCost")}
            description="Ile kosztuje nas godzina pracy — z tego liczy się strata na serwisach bezpłatnych."
          >
            <Input
              id="company-hourly-cost"
              data-testid="company-hourly-cost"
              type="number"
              step="0.01"
              min="0"
              className="tabular-nums"
              value={val("hourlyCost")}
              onChange={(e) => setField("hourlyCost", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-rate-km"
            label="Stawka za kilometr"
            source={source("rateKm")}
            dirty={isDirty("rateKm")}
            description={kmExample}
          >
            <Input
              id="company-rate-km"
              data-testid="company-rate-km"
              type="number"
              step="0.01"
              min="0"
              className="tabular-nums"
              value={rateKm}
              onChange={(e) => setField("rateKm", parseFloat(e.target.value) || 0)}
            />
          </Field>
        </div>

        <Field
          id="company-km-round-trip"
          label="Licz kilometry w obie strony"
          source={source("kmRoundTrip")}
          dirty={isDirty("kmRoundTrip")}
          description="Dystans biuro → obiekt razy dwa (dojazd i powrót)."
          inline
        >
          <Switch
            id="company-km-round-trip"
            checked={kmRoundTrip}
            onChange={(v) => setField("kmRoundTrip", v)}
            label="Licz kilometry w obie strony"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="company-km-source"
            label="Skąd dystans"
            source={source("kmSource")}
            dirty={isDirty("kmSource")}
            description="Trasa drogowa jest dokładniejsza; linia prosta to zapasowe przybliżenie, gdy router nie odpowiada."
          >
            <select
              id="company-km-source"
              data-testid="company-km-source"
              className={selectClass}
              value={val("kmSource")}
              onChange={(e) => setField("kmSource", e.target.value as CompanyKmSource)}
            >
              {(Object.keys(KM_SOURCE_LABEL) as CompanyKmSource[]).map((k) => (
                <option key={k} value={k}>
                  {KM_SOURCE_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id="company-material-markup"
            label="Narzut na materiały (%)"
            source={source("materialMarkup")}
            dirty={isDirty("materialMarkup")}
            description="Doliczany do sumy materiałów z protokołu wycenionych po cenniku. 0 = sprzedaż po cenniku."
          >
            <Input
              id="company-material-markup"
              data-testid="company-material-markup"
              type="number"
              step="1"
              min="0"
              className="tabular-nums"
              value={val("materialMarkup")}
              onChange={(e) => setField("materialMarkup", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-warehouse-markup"
            label="Narzut na towary z magazynu (%)"
            source={source("warehouseMarkup")}
            dirty={isDirty("warehouseMarkup")}
            description="Z niego liczy się cena sprzedaży towaru, który nie ma własnej. Towar z ręcznie wpisaną ceną ignoruje ten narzut."
          >
            <Input
              id="company-warehouse-markup"
              data-testid="company-warehouse-markup"
              type="number"
              step="1"
              min="0"
              className="tabular-nums"
              value={val("warehouseMarkup")}
              onChange={(e) => setField("warehouseMarkup", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-min-margin"
            label="Minimalna marża (%)"
            source={source("minMarginPct")}
            dirty={isDirty("minMarginPct")}
            description="Pozycje i oferty poniżej tego progu są oznaczane na czerwono. 0 = bez ostrzeżeń."
          >
            <Input
              id="company-min-margin"
              data-testid="company-min-margin"
              type="number"
              step="1"
              min="0"
              max="100"
              className="tabular-nums"
              value={val("minMarginPct")}
              onChange={(e) => setField("minMarginPct", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-lease-rate"
            label="Dzierżawa — procent roczny (%)"
            source={source("leaseAnnualRate")}
            dirty={isDirty("leaseAnnualRate")}
            description="Podpowiadany przy włączaniu dzierżawy na ofercie. Rata = wartość sprzętu × ten procent ÷ 12; na pojedynczej ofercie można go nadpisać."
          >
            <Input
              id="company-lease-rate"
              data-testid="company-lease-rate"
              type="number"
              step="1"
              min="0"
              className="tabular-nums"
              value={val("leaseAnnualRate")}
              onChange={(e) => setField("leaseAnnualRate", parseFloat(e.target.value) || 0)}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        id="skladki"
        title="Składki pracodawcy"
        description="Mnożniki, którymi z wypłaty netto szacujemy pełny koszt zatrudnienia. Kadry trzymają kwoty „na rękę”, więc bez nich koszt osobowy obiektu jest zaniżony."
      >
        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <p>
            W bazie mamy tylko kwoty <strong>netto na rękę</strong> — brutto i realnych składek aplikacja nie zna.
            Dlatego koszt liczymy jako <em>wypłata × mnożnik</em>, osobno dla każdej formy zatrudnienia.
          </p>
          <p>
            Składki pracodawcy to ok. 20% liczone <strong>od brutto</strong>, a my przeliczamy z netto — mnożnik jest
            więc <strong>przybliżeniem</strong>, a nie kwotą z listy płac.
          </p>
          <p>
            Wartości domyślne (1,65 / 1,59 / 1,22) są orientacyjne — <strong>warto potwierdzić je z księgową</strong> i
            podstawić tu liczby wyliczone z realnych list płac. Spółka może mieć własne narzuty (Kadry → Spółki),
            wtedy one mają pierwszeństwo.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="company-markup-uop"
            label="Umowa o pracę (ZUA)"
            source={source("employerMarkupUop")}
            dirty={isDirty("employerMarkupUop")}
            description={`Pełne składki pracodawcy (emerytalna, rentowa, wypadkowa, FP, FGŚP). ${markupExample(
              val("employerMarkupUop")
            )}`}
          >
            <Input
              id="company-markup-uop"
              data-testid="company-markup-uop"
              type="number"
              step="0.01"
              min="1"
              max="3"
              className="tabular-nums"
              value={val("employerMarkupUop")}
              onChange={(e) => setField("employerMarkupUop", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-markup-zlecenie-zua"
            label="Zlecenie ZUA"
            source={source("employerMarkupZlecenieZua")}
            dirty={isDirty("employerMarkupZlecenieZua")}
            description={`Zlecenie zgłoszone do pełnych ubezpieczeń — te same składki pracodawcy, zleceniobiorca bez chorobowego. ${markupExample(
              val("employerMarkupZlecenieZua")
            )}`}
          >
            <Input
              id="company-markup-zlecenie-zua"
              data-testid="company-markup-zlecenie-zua"
              type="number"
              step="0.01"
              min="1"
              max="3"
              className="tabular-nums"
              value={val("employerMarkupZlecenieZua")}
              onChange={(e) => setField("employerMarkupZlecenieZua", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-markup-zlecenie-zza"
            label="Zlecenie ZZA"
            source={source("employerMarkupZlecenieZza")}
            dirty={isDirty("employerMarkupZlecenieZza")}
            description={`Zlecenie zgłoszone tylko do zdrowotnej (np. student, drugi etat) — pracodawca nie dopłaca składek, więc narzut jest niski. ${markupExample(
              val("employerMarkupZlecenieZza")
            )}`}
          >
            <Input
              id="company-markup-zlecenie-zza"
              data-testid="company-markup-zlecenie-zza"
              type="number"
              step="0.01"
              min="1"
              max="3"
              className="tabular-nums"
              value={val("employerMarkupZlecenieZza")}
              onChange={(e) => setField("employerMarkupZlecenieZza", parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field
            id="company-markup-office"
            label="Rozliczenia biura bez umowy"
            source={source("employerMarkupOfficeDefault")}
            dirty={isDirty("employerMarkupOfficeDefault")}
            description={`Większość wierszy wynagrodzeń biura nie ma dopasowanej umowy, więc formy zatrudnienia nie da się odczytać — używamy wtedy tego narzutu. ${markupExample(
              val("employerMarkupOfficeDefault")
            )}`}
          >
            <Input
              id="company-markup-office"
              data-testid="company-markup-office"
              type="number"
              step="0.01"
              min="1"
              max="3"
              className="tabular-nums"
              value={val("employerMarkupOfficeDefault")}
              onChange={(e) => setField("employerMarkupOfficeDefault", parseFloat(e.target.value) || 0)}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        id="automat"
        title="Automat uzupełniania realizacji"
        description="Steruje przyciskiem „Uzupełnij automatycznie” oraz tym, co dzieje się po oznaczeniu wydarzenia jako wykonane i po podpisaniu protokołu."
      >
        <Field
          id="company-autofill-enabled"
          label="Automat włączony"
          source={source("autofillEnabled")}
          dirty={isDirty("autofillEnabled")}
          description="Wyłączony = realizacje wypełnia się wyłącznie ręcznie; podpisanie protokołu niczego nie policzy."
          inline
        >
          <Switch
            id="company-autofill-enabled"
            checked={val("autofillEnabled")}
            onChange={(v) => setField("autofillEnabled", v)}
            label="Automat włączony"
          />
        </Field>

        <Field
          id="company-autofill-on-event-done"
          label="Podliczaj realizację po oznaczeniu wydarzenia jako wykonane"
          source={source("autofillOnEventDone")}
          dirty={isDirty("autofillOnEventDone")}
          description="Włączone: gdy wydarzenie kalendarza dostaje status „wykonane”, realizacja od razu dostaje wstępne wyliczenie — godziny z wydarzenia, kilometry i stawki z cennika. Wypełniane są wyłącznie puste pola, a materiały (znane dopiero z protokołu) dolicza się przy podpisie. Wyłączone: realizacja czeka na podpis protokołu albo na ręczne „Uzupełnij automatycznie”."
          inline
        >
          <Switch
            id="company-autofill-on-event-done"
            checked={val("autofillOnEventDone")}
            disabled={!val("autofillEnabled")}
            onChange={(v) => setField("autofillOnEventDone", v)}
            label="Podliczaj po oznaczeniu jako wykonane"
          />
        </Field>

        <Field
          id="company-autofill-fields"
          label="Pola objęte automatem"
          source={source("autofillFields")}
          dirty={isDirty("autofillFields")}
          description="Odznaczone pola automat pomija — nie pojawią się nawet jako propozycja."
        >
          <div className={cn("flex flex-wrap gap-x-5 gap-y-2", !val("autofillEnabled") && "opacity-50")}>
            {AUTOFILL_FIELDS.map((f) => {
              const checked = autofillFields.includes(f);
              return (
                <label key={f} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    disabled={!val("autofillEnabled")}
                    data-testid={`company-autofill-${f}`}
                    onCheckedChange={() =>
                      setField(
                        "autofillFields",
                        checked ? autofillFields.filter((x) => x !== f) : [...autofillFields, f]
                      )
                    }
                    aria-label={AUTOFILL_FIELD_LABEL[f]}
                  />
                  {AUTOFILL_FIELD_LABEL[f]}
                </label>
              );
            })}
          </div>
        </Field>
      </SectionCard>

      <SectionCard
        id="test"
        title="Testuj kalkulację"
        description="Sprawdź na konkretnym obiekcie, ile kilometrów i złotówek wyjdzie z powyższych ustawień."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="company-test-object" className="text-sm font-medium">
              Obiekt
            </Label>
            <select
              id="company-test-object"
              data-testid="company-test-object"
              className={cn(selectClass, "w-72")}
              value={testObjectId}
              onChange={(e) => setTestObjectId(e.target.value)}
            >
              <option value="">— wybierz —</option>
              {objects.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.city ? ` · ${o.city}` : ""}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="outline"
            data-testid="company-test-run"
            disabled={testBusy || !testObjectId}
            onClick={() => void runTest()}
          >
            {testBusy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Calculator className="mr-1 h-4 w-4" aria-hidden />
            )}
            Policz
          </Button>
        </div>

        {testError && <ErrorBox>{testError}</ErrorBox>}
        {testResult?.distance && (
          <div className="space-y-2" data-testid="company-test-result">
            <div className="grid gap-3 sm:grid-cols-3">
              <Tile
                label="Dystans w jedną stronę"
                value={`${dec.format(testResult.distance.km)} km`}
                sub={
                  testResult.distance.method === "straight"
                    ? "linia prosta × 1,3"
                    : testResult.distance.method === "route"
                      ? "trasa drogowa"
                      : undefined
                }
              />
              <Tile
                label={testResult.distance.roundTrip ? "Kilometry (tam i z powrotem)" : "Kilometry"}
                value={`${dec.format(testResult.distance.totalKm)} km`}
                sub={testResult.distance.cached ? "z cache" : "policzone teraz"}
              />
              <Tile
                label="Kwota za KM"
                value={
                  testResult.amounts?.amountKm != null
                    ? pln.format(testResult.amounts.amountKm)
                    : "brak stawki"
                }
                sub={
                  testResult.amounts?.rate != null
                    ? `${dec.format(testResult.amounts.rate)} zł/km · ${
                        testResult.amounts.rateSource ?? "stawka firmowa"
                      }`
                    : "uzupełnij stawkę za kilometr"
                }
              />
            </div>
            {testResult.summary && (
              <p className="text-xs text-muted-foreground" data-testid="company-test-summary">
                {testResult.summary}
                {testResult.distance.from?.label && testResult.distance.to?.label
                  ? ` · ${testResult.distance.from.label} → ${testResult.distance.to.label}`
                  : ""}
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {dirtyCount > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur lg:left-64"
          role="region"
          aria-label="Niezapisane zmiany"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="text-sm">
              <span className="font-medium">Niezapisane zmiany</span>{" "}
              <span className="text-muted-foreground">
                ({dirtyCount} {dirtyCount === 1 ? "pole" : dirtyCount < 5 ? "pola" : "pól"})
              </span>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft({})} disabled={saving}>
                Odrzuć
              </Button>
              <Button
                type="button"
                data-testid="company-settings-save"
                onClick={() => void save()}
                disabled={saving || unavailable}
                {...(unavailable ? tip("Backend nie obsługuje jeszcze zapisu ustawień firmy") : {})}
              >
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} Zapisz
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

