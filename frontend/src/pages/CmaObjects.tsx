import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Building2, Link2Off, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  monitoredObjectsApi,
  type MonitoredObject,
  type ObjectCatalogEntry,
} from "@/lib/api";
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

/**
 * Etykieta obiektu z kartoteki w liście wyboru. Sama nazwa nie wystarcza —
 * kartoteka ma obiekty o bliźniaczych nazwach u różnych klientów, więc miasto
 * i kontrahent są tu częścią identyfikacji, a nie ozdobą.
 */
const catalogLabel = (o: ObjectCatalogEntry) =>
  [o.name, o.city, o.contractorName].filter(Boolean).join(" · ");

/** Select w komórce tabeli — te same wymiary co w mapowaniu kadrowym. */
const TABLE_SELECT_CLS =
  "h-8 w-full min-w-56 rounded-md border border-input bg-background px-2 py-1 text-xs";

type SortKey = "devices" | "name" | "city";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "devices", label: "wg liczby urządzeń" },
  { key: "name", label: "wg nazwy" },
  { key: "city", label: "wg miasta" },
];

export function CmaObjects() {
  const { canEdit } = usePerms();
  const editable = canEdit("cma/obiekty");

  const [rows, setRows] = useState<MonitoredObject[]>([]);
  const [catalog, setCatalog] = useState<ObjectCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  const [search, setSearch] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("devices");
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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (onlyUnmapped && r.objectId != null) return false;
      if (!q) return true;
      // Szukamy po tym, czym człowiek rozpoznaje obiekt w drugim rejestrze:
      // nazwa bywa inna, ale adres albo numer w systemie zwykle się zgadza.
      return [r.name, r.city, r.street, r.address, String(r.externalId)]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });
    const byName = (a: MonitoredObject, b: MonitoredObject) =>
      a.name.localeCompare(b.name, "pl");
    return [...filtered].sort((a, b) => {
      if (sortKey === "name") return byName(a, b);
      if (sortKey === "city")
        return (a.city ?? "").localeCompare(b.city ?? "", "pl") || byName(a, b);
      // Domyślnie od najbogatszych w sprzęt: im więcej urządzeń, tym większy
      // obiekt i tym więcej traci się na braku powiązania z kartoteką.
      const da = devicesById.get(a.id);
      const dbv = devicesById.get(b.id);
      const sa = (da?.cameras ?? 0) + (da?.alarms ?? 0);
      const sb = (dbv?.cameras ?? 0) + (dbv?.alarms ?? 0);
      return sb - sa || byName(a, b);
    });
  }, [rows, search, onlyUnmapped, sortKey, devicesById]);

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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={onlyUnmapped}
            onChange={(e) => setOnlyUnmapped(e.target.checked)}
          />
          <Link2Off className="h-4 w-4 text-muted-foreground" />
          Tylko niezmapowane
        </label>
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={sortKey}
          aria-label="Sortowanie listy"
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">
          {visible.length} z {rows.length}
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">
                    Obiekt w monitoringu
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Miasto</th>
                  <th className="px-3 py-2 text-left font-medium">Ulica</th>
                  <th
                    className="px-3 py-2 text-left font-medium"
                    title="Liczba urządzeń wg producenta z kolumny devices: kamery (Dahua, Hikvision, ONVIF), alarmy (Satel, EBS), pozostałe to nadajniki i kanały powiadomień"
                  >
                    Urządzenia
                  </th>
                  <th
                    className="px-3 py-2 text-left font-medium"
                    title="Rodzaj usługi z rejestru — wypełniony tylko w części pozycji"
                  >
                    Usługi
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    Obiekt w kartotece
                  </th>
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
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">
                          nr {r.externalId}
                        </div>
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
                      colSpan={6}
                      className="px-3 py-10 text-center text-sm text-muted-foreground"
                    >
                      <Building2 className="mx-auto mb-2 h-6 w-6 opacity-50" />
                      Brak pozycji spełniających filtry
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td
                      colSpan={6}
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
