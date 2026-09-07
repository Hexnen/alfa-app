import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDown,
  ArrowUp,
  Building2,
  ChevronsUpDown,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  monitoredObjectsApi,
  type MonitoredObject,
  type ObjectCatalogEntry,
} from "@/lib/api";
import { catalogLabel } from "@/lib/labels";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

/**
 * CMA → Obiekty: ręczne mapowanie rejestru z systemu monitoringu na kartotekę
 * obiektów. Bliźniak ekranu Kadry → Obiekty i celowo wygląda tak samo — to ta
 * sama czynność na trzecim rejestrze, użytkownik nie ma się uczyć dwóch
 * interfejsów.
 *
 * Automatu tu nie ma i nie będzie: rejestr CMA powstał niezależnie od
 * kartoteki i nie pokrywa się z nią ani po nazwie, ani po mieście z ulicą
 * (0 dopasowań na 416 pozycji). Dlatego ekran nie próbuje zgadywać, tylko
 * podaje człowiekowi wszystko, po czym da się rozpoznać obiekt: adres, rodzaj
 * usługi i skład urządzeń.
 */

/** Ile pozycji rejestru ściągamy naraz — całość mieści się w jednej stronie. */
const FETCH_PAGE_SIZE = 1000;

/**
 * Kolumna `devices` to lista `identyfikator@producent` po przecinku
 * (np. "dahua_A8A90000@dahua, lx1063271@ebs"). Sam sufiks producenta mówi,
 * czym obiekt jest chroniony, a to najmocniejsza podpowiedź przy dopasowaniu:
 * kartoteka wie, czy obiekt ma CCTV, czy sam alarm. Rozpoznajemy tylko
 * producentów sprzętu końcowego — reszta sufiksów (`sai`, `sip`, `vdev`,
 * `stationary`, `sms`, `psc`) to kanały transmisji i powiadomień, nie sprzęt.
 */
const CAMERA_VENDORS = new Set(["dahua", "hikvision", "onvif"]);
const ALARM_VENDORS = new Set(["satel", "ebs"]);

interface DeviceSummary {
  cameras: number;
  alarms: number;
  other: number;
  /** Rozbicie na konkretnych producentów — do dymka nad licznikami. */
  byVendor: [string, number][];
}

function summarizeDevices(devices: string | null): DeviceSummary {
  const counts = new Map<string, number>();
  for (const raw of (devices ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const at = entry.lastIndexOf("@");
    // Wpis bez "@" zdarza się w danych źródłowych — liczymy go jako "inne",
    // żeby nie zniknął po cichu z sumy urządzeń.
    const vendor = at < 0 ? "?" : entry.slice(at + 1).trim().toLowerCase();
    counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
  }
  let cameras = 0;
  let alarms = 0;
  let other = 0;
  for (const [vendor, n] of counts) {
    if (CAMERA_VENDORS.has(vendor)) cameras += n;
    else if (ALARM_VENDORS.has(vendor)) alarms += n;
    else other += n;
  }
  return {
    cameras,
    alarms,
    other,
    byVendor: [...counts].sort((a, b) => b[1] - a[1]),
  };
}

/** Select w komórce tabeli — te same wymiary co w mapowaniu kadrowym. */
const TABLE_SELECT_CLS =
  "h-8 w-full min-w-56 rounded-md border border-input bg-background px-2 py-1 text-xs";

/** Kolumny, po których da się sortować rejestr. */
type SortKey = "name" | "externalId" | "city" | "street" | "devices" | "mapping";

/**
 * Domyślny kierunek sortowania kolumny — liczniki ludzie czytają od największej
 * wartości, teksty alfabetycznie (jak w kartotece obiektów i w spółkach).
 * Numer w systemie to identyfikator, a nie licznik, więc idzie rosnąco.
 */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  externalId: "asc",
  city: "asc",
  street: "asc",
  devices: "desc",
  mapping: "asc",
};

/** Filtr mapowania — zastąpił checkbox „tylko niezmapowane”. */
type MappingFilter = "all" | "unmapped" | "mapped";

/** Filtr składu urządzeń: obiekt ma kamery / ma alarmy. */
type DeviceMode = "all" | "cameras" | "alarms";

/** Filtr aktywności pozycji rejestru (API zwraca też pozycje wycofane). */
type ActiveFilter = "all" | "active" | "inactive";

/** Liczba z pola tekstowego — śmieci traktujemy jak brak filtra. */
function parseCount(raw: string): number | undefined {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Sprzęt końcowy obiektu = kamery + alarmy. „Inne” to kanały transmisji
 * i powiadomień, więc nie wchodzą ani do sortowania, ani do widełek —
 * inaczej obiekt z pięcioma SMS-ami wyglądałby na większy od tego z kamerą.
 */
function deviceCount(d: DeviceSummary | undefined): number {
  return (d?.cameras ?? 0) + (d?.alarms ?? 0);
}

/** Wartości `serviceTypes` przychodzą jako lista po średniku. */
function serviceList(value: string | null): string[] {
  return (value ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function CmaObjects() {
  const { canEdit } = usePerms();
  const editable = canEdit("cma/obiekty");

  const [rows, setRows] = useState<MonitoredObject[]>([]);
  const [catalog, setCatalog] = useState<ObjectCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  // Filtry i sortowanie liczymy po stronie klienta — rejestr ściągamy w całości
  // (jedna strona na 1000 pozycji), więc nie ma żądania do odciążenia i widełki
  // idą bez debounce'u: lista przelicza się w tym samym renderze co wpisana cyfra.
  const [search, setSearch] = useState("");
  const [mappingFilter, setMappingFilter] = useState<MappingFilter>("all");
  const [serviceFilter, setServiceFilter] = useState("all");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [minDevices, setMinDevices] = useState("");
  const [maxDevices, setMaxDevices] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("devices");
  const [dir, setDir] = useState<"asc" | "desc">(DEFAULT_DIR.devices);
  /**
   * Wiersz, którego lista wyboru jest właśnie dotykana. Kartoteka ma 120
   * pozycji, a rejestr 416 wierszy — pełne opcje we wszystkich selectach to
   * ~50 tys. węzłów DOM i 6 sekund czekania na wejście w ekran (zmierzone).
   * Dlatego pełną listę dostaje tylko select, w który użytkownik wchodzi:
   * `mousedown` i `focus` to zdarzenia dyskretne, React przebudowuje DOM
   * synchronicznie, zanim przeglądarka rozwinie listę.
   */
  const [activeSelect, setActiveSelect] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, cat] = await Promise.all([
        monitoredObjectsApi.getObjects({ page: 1, pageSize: FETCH_PAGE_SIZE }),
        monitoredObjectsApi.getObjectCatalog(),
      ]);
      setRows(list.data);
      setCatalog(cat.data ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Skład urządzeń liczymy raz na wiersz — wchodzi i do kolumny, i do sortowania.
  const devicesById = useMemo(() => {
    const m = new Map<number, DeviceSummary>();
    for (const r of rows) m.set(r.id, summarizeDevices(r.devices));
    return m;
  }, [rows]);

  const progress = useMemo(() => {
    const mapped = rows.filter((r) => r.objectId != null).length;
    const percent = rows.length ? (mapped / rows.length) * 100 : 0;
    return {
      total: rows.length,
      mapped,
      percent,
      // Pierwsze pozycje dają ułamek procenta — „0%" obok „Zmapowano 3"
      // wyglądałoby jak zepsuty licznik, więc zaokrąglamy w górę do „<1%".
      percentLabel:
        mapped > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`,
    };
  }, [rows]);

  /**
   * Listy wyboru budujemy z danych, a nie ze słownika — rejestr CMA ma własne
   * nazewnictwo usług i kategorii, którego nie ma po czym odtworzyć na froncie.
   * Puste listy nie dostają selecta w ogóle (dziś `category` jest pusta we
   * wszystkich 416 pozycjach — martwy filtr tylko zaśmiecałby pasek).
   */
  const serviceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const s of serviceList(r.serviceTypes)) set.add(s);
    return [...set].sort((a, b) => a.localeCompare(b, "pl"));
  }, [rows]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const v = (r.category ?? "").trim();
      if (v) set.add(v);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "pl"));
  }, [rows]);

  /** Filtr aktywności ma sens tylko wtedy, gdy w rejestrze są pozycje wycofane. */
  const hasInactive = useMemo(() => rows.some((r) => !r.active), [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = parseCount(minDevices);
    const max = parseCount(maxDevices);

    const filtered = rows.filter((r) => {
      if (mappingFilter === "unmapped" && r.objectId != null) return false;
      if (mappingFilter === "mapped" && r.objectId == null) return false;
      // Usługi nie są rozłączne (jedna pozycja bywa i monitoringiem, i OFI),
      // więc filtr wybiera pozycje MAJĄCE daną usługę — jak w kartotece obiektów.
      if (serviceFilter !== "all" && !serviceList(r.serviceTypes).includes(serviceFilter)) {
        return false;
      }
      if (categoryFilter !== "all" && (r.category ?? "").trim() !== categoryFilter) {
        return false;
      }
      if (activeFilter === "active" && !r.active) return false;
      if (activeFilter === "inactive" && r.active) return false;
      const d = devicesById.get(r.id);
      if (deviceMode === "cameras" && !(d?.cameras ?? 0)) return false;
      if (deviceMode === "alarms" && !(d?.alarms ?? 0)) return false;
      const count = deviceCount(d);
      if (min !== undefined && count < min) return false;
      if (max !== undefined && count > max) return false;
      if (!q) return true;
      // Szukamy po tym, czym człowiek rozpoznaje obiekt w drugim rejestrze:
      // nazwa bywa inna, ale adres albo numer w systemie zwykle się zgadza.
      return [r.name, r.city, r.street, r.address, String(r.externalId)]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });

    const mul = dir === "asc" ? 1 : -1;
    const byName = (a: MonitoredObject, b: MonitoredObject) =>
      a.name.localeCompare(b.name, "pl");
    const text = (r: MonitoredObject) =>
      (sortKey === "name"
        ? r.name
        : sortKey === "city"
          ? r.city
          : sortKey === "street"
            ? r.street
            : r.object
              ? catalogLabel(r.object)
              : "") ?? "";

    // Puste miasta, ulice i pozycje bez mapowania lądują na końcu w OBU
    // kierunkach (NULLS LAST) — inaczej „sortuj po ulicy” zaczynałoby się od
    // wierszy bez adresu. Tak samo brak urządzeń: kolumna pokazuje tam kreskę,
    // więc zero to brak informacji, a nie najmniejsza wartość.
    const compare = (a: MonitoredObject, b: MonitoredObject): number => {
      if (sortKey === "externalId") return (a.externalId - b.externalId) * mul;
      if (sortKey === "devices") {
        const av = deviceCount(devicesById.get(a.id));
        const bv = deviceCount(devicesById.get(b.id));
        if (!av || !bv) {
          if (!av && !bv) return 0;
          return av ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    return [...filtered].sort((a, b) => compare(a, b) || byName(a, b));
  }, [
    rows,
    search,
    mappingFilter,
    serviceFilter,
    categoryFilter,
    activeFilter,
    deviceMode,
    minDevices,
    maxDevices,
    sortKey,
    dir,
    devicesById,
  ]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    mappingFilter !== "all" ||
    serviceFilter !== "all" ||
    categoryFilter !== "all" ||
    activeFilter !== "all" ||
    deviceMode !== "all" ||
    minDevices !== "" ||
    maxDevices !== "";

  const clearFilters = () => {
    setSearch("");
    setMappingFilter("all");
    setServiceFilter("all");
    setCategoryFilter("all");
    setActiveFilter("all");
    setDeviceMode("all");
    setMinDevices("");
    setMaxDevices("");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey: key,
    title,
    className,
  }: {
    label: string;
    sortKey: SortKey;
    title?: string;
    className?: string;
  }) => {
    const activeCol = sortKey === key;
    const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 text-left font-medium", className)} title={title}>
        <button
          type="button"
          data-testid={`cma-obiekty-sort-${key}`}
          onClick={() => toggleSort(key)}
          aria-label={`Sortuj po: ${label}`}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 uppercase transition-colors hover:text-foreground",
            activeCol && "text-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
        </button>
      </th>
    );
  };

  const handleMapping = async (row: MonitoredObject, objectId: number | null) => {
    if (!editable) return;
    setSaving(row.id);
    try {
      await monitoredObjectsApi.setMapping(row.id, objectId);
      // Podmieniamy wiersz w miejscu zamiast przeładowywać 416 pozycji —
      // mapowanie robi się seriami i lista nie może skakać po każdym wyborze.
      const target = objectId ? catalog.find((o) => o.id === objectId) : null;
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, objectId, object: target ?? null } : r,
        ),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Obiekty</h1>
          <p className="text-sm text-muted-foreground">
            Powiązanie rejestru z systemu monitoringu z kartoteką obiektów
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
          Odśwież
        </Button>
      </div>

      {!editable && <ReadOnlyBanner />}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Postęp mapowania — bez niego nie widać, ile z 416 pozycji zostało do
          przejścia, a robi się to seriami przez wiele posiedzeń. */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium">
              Zmapowano {progress.mapped} z {progress.total} pozycji
            </span>
            <span className="text-xs text-muted-foreground">
              {progress.percentLabel} rejestru monitoringu
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Rejestr monitoringu powstał niezależnie od kartoteki — nazwy ani
            adresy się nie pokrywają, więc powiązania nie da się wyliczyć
            automatycznie i ustawia się je ręcznie. Przy dopasowaniu pomaga
            skład urządzeń: kamery (Dahua, Hikvision) i alarmy (Satel, EBS)
            mówią, jakiego typu jest to obiekt.
          </p>
        </CardContent>
      </Card>

      {/* Pierwsza linia filtrów: szukajka i przynależność pozycji. Sortowanie
          siedzi w nagłówkach tabeli (jak w kartotece obiektów), więc nie ma tu
          już osobnej listy „wg czego sortować”. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Szukaj po nazwie, mieście, adresie lub numerze…"
          />
        </div>

        <Select
          value={mappingFilter}
          onValueChange={(v) => setMappingFilter(v as MappingFilter)}
        >
          <SelectTrigger className="w-[200px]" data-testid="cma-obiekty-filter-mapping">
            <SelectValue placeholder="Mapowanie" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Mapowanie: wszystkie</SelectItem>
            <SelectItem value="unmapped">Tylko niezmapowane</SelectItem>
            <SelectItem value="mapped">Tylko zmapowane</SelectItem>
          </SelectContent>
        </Select>

        {serviceOptions.length > 0 && (
          <Select value={serviceFilter} onValueChange={setServiceFilter}>
            <SelectTrigger className="w-[200px]" data-testid="cma-obiekty-filter-service">
              <SelectValue placeholder="Usługa" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Wszystkie usługi</SelectItem>
              {serviceOptions.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={deviceMode} onValueChange={(v) => setDeviceMode(v as DeviceMode)}>
          <SelectTrigger className="w-[200px]" data-testid="cma-obiekty-filter-devices">
            <SelectValue placeholder="Urządzenia" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Urządzenia: wszystkie</SelectItem>
            <SelectItem value="cameras">Tylko z kamerami</SelectItem>
            <SelectItem value="alarms">Tylko z alarmami</SelectItem>
          </SelectContent>
        </Select>

        {categoryOptions.length > 0 && (
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[190px]" data-testid="cma-obiekty-filter-category">
              <SelectValue placeholder="Kategoria" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Wszystkie kategorie</SelectItem>
              {categoryOptions.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {hasInactive && (
          <Select
            value={activeFilter}
            onValueChange={(v) => setActiveFilter(v as ActiveFilter)}
          >
            <SelectTrigger className="w-[190px]" data-testid="cma-obiekty-filter-active">
              <SelectValue placeholder="Status pozycji" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Wszystkie pozycje</SelectItem>
              <SelectItem value="active">Tylko aktualne</SelectItem>
              <SelectItem value="inactive">Tylko wycofane</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Druga linia: widełki liczby urządzeń (kamery + alarmy) i licznik po filtrach. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Urządzeń od</span>
          <Input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            className="w-24 tabular-nums"
            data-testid="cma-obiekty-filter-min"
            value={minDevices}
            onChange={(e) => setMinDevices(e.target.value)}
          />
          <span>do</span>
          <Input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            className="w-24 tabular-nums"
            data-testid="cma-obiekty-filter-max"
            value={maxDevices}
            onChange={(e) => setMaxDevices(e.target.value)}
          />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="cma-obiekty-filters-clear"
          >
            <X className="mr-1 h-4 w-4" />
            Wyczyść filtry
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          {visible.length} z {rows.length} pozycji rejestru
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  {/* Numer w systemie dostał własną kolumnę, bo jest osobnym
                      kryterium sortowania — pod nazwą nie dałoby się go kliknąć. */}
                  <SortHeader
                    label="Nr"
                    sortKey="externalId"
                    title="Numer pozycji w systemie monitoringu"
                  />
                  <SortHeader label="Obiekt w monitoringu" sortKey="name" />
                  <SortHeader label="Miasto" sortKey="city" />
                  <SortHeader label="Ulica" sortKey="street" />
                  <SortHeader
                    label="Urządzenia"
                    sortKey="devices"
                    title="Liczba urządzeń wg producenta z kolumny devices: kamery (Dahua, Hikvision, ONVIF), alarmy (Satel, EBS), pozostałe to nadajniki i kanały powiadomień. Sortowanie i widełki liczą sam sprzęt końcowy: kamery + alarmy"
                  />
                  {/* Usługi to zbiór wartości, a nie jedna — nie ma po czym
                      sortować, więc nagłówek zostaje zwykły. */}
                  <th
                    className="px-3 py-2 text-left font-medium"
                    title="Rodzaj usługi z rejestru — wypełniony tylko w części pozycji"
                  >
                    Usługi
                  </th>
                  <SortHeader
                    label="Obiekt w kartotece"
                    sortKey="mapping"
                    title="Sortowanie po nazwie obiektu z kartoteki; pozycje niezmapowane zawsze na końcu"
                  />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const d = devicesById.get(r.id);
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b align-top hover:bg-accent/50",
                        saving === r.id && "opacity-60",
                      )}
                    >
                      <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                        {r.externalId}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        {!r.active && (
                          <div className="text-xs text-muted-foreground">
                            pozycja wycofana z rejestru
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.city || "—"}</td>
                      <td className="px-3 py-2 text-xs">{r.street || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {d && (d.cameras || d.alarms || d.other) ? (
                          <span
                            // Bez zawijania — łamane liczniki rozciągały wiersz
                            // na trzy linie i tabela przestawała się skanować.
                            className="flex gap-1 whitespace-nowrap"
                            title={d.byVendor
                              .map(([v, n]) => `${v}: ${n}`)
                              .join(", ")}
                          >
                            {d.cameras > 0 && (
                              <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-700">
                                {d.cameras} kam.
                              </span>
                            )}
                            {d.alarms > 0 && (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                                {d.alarms} alarm.
                              </span>
                            )}
                            {d.other > 0 && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                                {d.other} inne
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.serviceTypes || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className={TABLE_SELECT_CLS}
                          value={r.objectId ?? ""}
                          disabled={!editable || saving === r.id}
                          aria-label={`Obiekt w kartotece dla pozycji ${r.name}`}
                          title={
                            r.object
                              ? catalogLabel(r.object)
                              : "Wskaż obiekt z kartoteki, któremu odpowiada ta pozycja rejestru"
                          }
                          onMouseDown={() => setActiveSelect(r.id)}
                          onFocus={() => setActiveSelect(r.id)}
                          onChange={(e) =>
                            handleMapping(
                              r,
                              e.target.value ? Number(e.target.value) : null,
                            )
                          }
                        >
                          <option value="">— nie mapuj —</option>
                          {/* Nieaktywny wiersz dostaje tylko swoją zapisaną
                              pozycję — tyle wystarczy, żeby select pokazał
                              właściwą nazwę bez budowania 120 opcji. */}
                          {(activeSelect === r.id
                            ? catalog
                            : r.object
                              ? [r.object]
                              : []
                          ).map((o) => (
                            <option key={o.id} value={o.id}>
                              {catalogLabel(o)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
                {!loading && visible.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-10 text-center text-sm text-muted-foreground"
                    >
                      <Building2 className="mx-auto mb-2 h-6 w-6 opacity-50" />
                      {filtersActive
                        ? "Brak obiektów dla wybranych filtrów"
                        : "Brak pozycji w rejestrze monitoringu"}
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-10 text-center text-sm text-muted-foreground"
                    >
                      Ładowanie…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
