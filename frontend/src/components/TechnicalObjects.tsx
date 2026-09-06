import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  Search,
  Upload,
} from "lucide-react";
import {
  monitoredObjectsApi,
  type MonitoredObject,
  type MonitoredObjectChange,
  type ObjectImport,
} from "@/lib/api";
import { pillClass, type PillTone } from "@/lib/calendar-labels";

// Etykiety pól obiektu (klucz z API -> nagłówek raportu)
const FIELD_LABELS: Record<string, string> = {
  account: "Konto",
  category: "Kategoria obiektu",
  name: "Nazwa obiektu",
  identifier1: "Identyfikator 1",
  identifier2: "Identyfikator 2",
  identifier3: "Identyfikator 3",
  extraData1: "Dane dodatkowe 1",
  extraData2: "Dane dodatkowe 2",
  extraData3: "Dane dodatkowe 3",
  extraData4: "Dane dodatkowe 4",
  extraData5: "Dane dodatkowe 5",
  address: "Adres",
  street: "Ulica",
  houseNumber: "Numer domu",
  postalCode: "Kod pocztowy",
  city: "Miasto",
  latitude: "Szerokość geograficzna",
  longitude: "Długość geograficzna",
  locationDescription: "Opis lokalizacji",
  objectDescription: "Opis obiektu",
  phones: "Telefony obiektu",
  devices: "Urządzenia",
  defaultCrew: "Domyślna załoga",
  allCrews: "Wszystkie załogi",
  groups: "Grupy",
  monitoringStart: "Rozpoczęcie monitorowania",
  monitoringEnd: "Zakończenie monitorowania",
  objectStatus: "Status obiektu",
  addedAt: "Data dodania",
  authorizedPersons: "Dane osób upoważnionych",
  authorizedPhones: "Nr kontaktowe osób upoważnionych",
  authorizedPasswords: "Hasło osób upoważnionych",
  duressPasswords: "Hasła pod przymusem osób upoważnionych",
  dayArrivalTime: "Czas dojazdu w dzień",
  nightArrivalTime: "Czas dojazdu w nocy",
  relatedObjects: "Obiekty powiązane",
  serviceTypes: "Typ usługi",
  serviceMonitoringFrom: "Początek monitorowania usługi",
  serviceMonitoringTo: "Koniec monitorowania usługi",
};

const CHANGE_META: Record<
  MonitoredObjectChange["changeType"],
  { label: string; tone: PillTone }
> = {
  created: { label: "Dodany", tone: "emerald" },
  updated: { label: "Zmiana", tone: "sky" },
  removed: { label: "Usunięty z raportu", tone: "red" },
  restored: { label: "Przywrócony", tone: "amber" },
};

// Pola pokazywane w szczegółach obiektu (kolejność wyświetlania)
const DETAIL_FIELDS: (keyof MonitoredObject)[] = [
  "account",
  "category",
  "address",
  "city",
  "groups",
  "serviceTypes",
  "devices",
  "phones",
  "authorizedPersons",
  "authorizedPhones",
  "monitoringStart",
  "monitoringEnd",
  "addedAt",
  "dayArrivalTime",
  "nightArrivalTime",
  "relatedObjects",
  "locationDescription",
  "objectDescription",
];

const PAGE_SIZE = 25;

// "2024-11-14 10:41:24" -> "2024-11-14"
const fmtDate = (value: string | null) => (value ? value.slice(0, 10) : null);

// Zakres monitorowania "od – do" (uruchomienie/zakończenie)
function monitoringRange(obj: MonitoredObject) {
  const start = fmtDate(obj.monitoringStart);
  const end = fmtDate(obj.monitoringEnd);
  if (start && end) return `${start} – ${end}`;
  if (start) return `od ${start}`;
  if (end) return `do ${end}`;
  return "—";
}

export function TechnicalObjects() {
  const [objects, setObjects] = useState<MonitoredObject[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [activeFilter, setActiveFilter] = useState<"1" | "0" | "">("1");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [lastImport, setLastImport] = useState<ObjectImport | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importsOpen, setImportsOpen] = useState(false);
  const [imports, setImports] = useState<ObjectImport[]>([]);
  const [importsLoading, setImportsLoading] = useState(false);

  const [detailsId, setDetailsId] = useState<number | null>(null);
  const [details, setDetails] = useState<{
    object: MonitoredObject;
    changes: MonitoredObjectChange[];
  } | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const loadObjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await monitoredObjectsApi.getObjects({
        search: search || undefined,
        active: activeFilter || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setObjects(res.data);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, activeFilter, page]);

  const loadLastImport = useCallback(async () => {
    try {
      const res = await monitoredObjectsApi.getImports({ page: 1, pageSize: 1 });
      setLastImport(res.data[0] ?? null);
    } catch {
      /* podsumowanie jest opcjonalne */
    }
  }, []);

  useEffect(() => {
    loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    loadLastImport();
  }, [loadLastImport]);

  const handleFileSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await monitoredObjectsApi.importReport(file);
      setMessage(res.message ?? "Zaimportowano raport obiektów.");
      setPage(1);
      await Promise.all([loadObjects(), loadLastImport()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const openImports = async () => {
    setImportsOpen(true);
    setImportsLoading(true);
    try {
      const res = await monitoredObjectsApi.getImports({ pageSize: 50 });
      setImports(res.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImportsLoading(false);
    }
  };

  const openDetails = async (id: number) => {
    setDetailsId(id);
    setDetails(null);
    setDetailsLoading(true);
    try {
      const res = await monitoredObjectsApi.getObject(id);
      setDetails(res.data ?? null);
    } catch (e) {
      setError((e as Error).message);
      setDetailsId(null);
    } finally {
      setDetailsLoading(false);
    }
  };

  const applySearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const changeSummary = (change: MonitoredObjectChange) => {
    if (change.changeType === "updated") {
      return (
        <span>
          <span className="font-medium">
            {FIELD_LABELS[change.field ?? ""] ?? change.field}
          </span>
          : <span className="text-red-600 line-through whitespace-pre-wrap">{change.oldValue ?? "—"}</span>{" "}
          → <span className="text-emerald-700 whitespace-pre-wrap">{change.newValue ?? "—"}</span>
        </span>
      );
    }
    if (change.changeType === "created") {
      return <span>Obiekt pojawił się w raporcie</span>;
    }
    if (change.changeType === "removed") {
      return <span>Obiekt zniknął z raportu</span>;
    }
    return <span>Obiekt ponownie obecny w raporcie</span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Rejestr obiektów z dziennego raportu (identyfikacja po ID obiektu).
            {lastImport && (
              <>
                {" "}
                Ostatni import: {lastImport.importedAt} — {lastImport.totalCount}{" "}
                obiektów ({lastImport.newCount} nowych, {lastImport.changedCount}{" "}
                zmienionych, {lastImport.removedCount} usuniętych).
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={openImports}>
            <History className="mr-2 h-4 w-4" />
            Historia importów
          </Button>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Importuj raport
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xls,.xlsx"
            className="hidden"
            onChange={handleFileSelected}
          />
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj: nazwa, ID, miasto, grupa..."
            className="pl-8"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
          />
        </div>
        <Button variant="secondary" onClick={applySearch}>
          Szukaj
        </Button>
        <div className="ml-2 flex items-center gap-1">
          {(
            [
              ["1", "Aktywne"],
              ["0", "Usunięte"],
              ["", "Wszystkie"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={label}
              size="sm"
              variant={activeFilter === value ? "default" : "outline"}
              onClick={() => {
                setActiveFilter(value);
                setPage(1);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <span className="ml-auto text-sm text-muted-foreground">
          {total} obiektów
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Ładowanie...
            </div>
          ) : objects.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <Building2 className="h-10 w-10" />
              <p>
                {total === 0 && !search
                  ? "Brak obiektów — zaimportuj dzienny raport obiektów (CSV)."
                  : "Brak obiektów spełniających kryteria."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">ID</TableHead>
                  <TableHead>Nazwa</TableHead>
                  <TableHead>Miasto</TableHead>
                  <TableHead>Grupy</TableHead>
                  <TableHead>Typ usługi</TableHead>
                  <TableHead className="w-28">Utworzenie</TableHead>
                  <TableHead className="w-44">Monitorowanie od–do</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {objects.map((obj) => (
                  <TableRow
                    key={obj.id}
                    className="cursor-pointer"
                    onClick={() => openDetails(obj.id)}
                  >
                    <TableCell className="font-mono text-sm">
                      {obj.externalId}
                    </TableCell>
                    <TableCell className="font-medium">{obj.name}</TableCell>
                    <TableCell>{obj.city ?? "—"}</TableCell>
                    <TableCell className="max-w-56 truncate">
                      {obj.groups ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-48 truncate">
                      {obj.serviceTypes ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {fmtDate(obj.addedAt) ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {monitoringRange(obj)}
                    </TableCell>
                    <TableCell>
                      {obj.active ? (
                        <span className={pillClass("emerald")}>Aktywny</span>
                      ) : (
                        <span className={pillClass("red")}>Usunięty</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" /> Poprzednia
          </Button>
          <span className="text-sm text-muted-foreground">
            Strona {page} z {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Następna <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Historia importów */}
      <Dialog open={importsOpen} onOpenChange={setImportsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Historia importów raportu obiektów</DialogTitle>
          </DialogHeader>
          {importsLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Ładowanie...
            </div>
          ) : imports.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              Brak importów.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Plik</TableHead>
                    <TableHead className="text-right">Obiekty</TableHead>
                    <TableHead className="text-right">Nowe</TableHead>
                    <TableHead className="text-right">Zmienione</TableHead>
                    <TableHead className="text-right">Usunięte</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {imports.map((imp) => (
                    <TableRow key={imp.id}>
                      <TableCell className="whitespace-nowrap">
                        {imp.importedAt}
                      </TableCell>
                      <TableCell className="max-w-56 truncate" title={imp.fileName}>
                        {imp.fileName}
                      </TableCell>
                      <TableCell className="text-right">{imp.totalCount}</TableCell>
                      <TableCell className="text-right">{imp.newCount}</TableCell>
                      <TableCell className="text-right">
                        {imp.changedCount}
                      </TableCell>
                      <TableCell className="text-right">
                        {imp.removedCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Szczegóły obiektu + log zmian */}
      <Dialog
        open={detailsId !== null}
        onOpenChange={(open) => !open && setDetailsId(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {details
                ? `${details.object.name} (ID ${details.object.externalId})`
                : "Szczegóły obiektu"}
            </DialogTitle>
          </DialogHeader>
          {detailsLoading || !details ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Ładowanie...
            </div>
          ) : (
            <div className="max-h-[70vh] space-y-6 overflow-y-auto pr-2">
              <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {DETAIL_FIELDS.map((field) => {
                  const value = details.object[field];
                  if (value === null || value === undefined || value === "")
                    return null;
                  return (
                    <div key={field}>
                      <p className="text-xs text-muted-foreground">
                        {FIELD_LABELS[field] ?? field}
                      </p>
                      <p className="whitespace-pre-wrap text-sm">{String(value)}</p>
                    </div>
                  );
                })}
              </div>

              <div>
                <h4 className="mb-2 font-semibold">
                  Log zmian ({details.changes.length})
                </h4>
                {details.changes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Brak zmian.</p>
                ) : (
                  <div className="space-y-2">
                    {details.changes.map((change) => (
                      <div
                        key={change.id}
                        className="flex items-start gap-3 rounded-md border p-2 text-sm"
                      >
                        <span
                          className={pillClass(CHANGE_META[change.changeType].tone, {
                            className: "shrink-0",
                          })}
                        >
                          {CHANGE_META[change.changeType].label}
                        </span>
                        <div className="min-w-0 flex-1">{changeSummary(change)}</div>
                        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                          {change.createdAt}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
