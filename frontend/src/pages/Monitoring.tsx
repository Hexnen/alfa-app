import { useEffect, useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ArrowDown,
  ArrowUp,
  Cctv,
  ChevronsUpDown,
  ExternalLink,
  FileText,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MonitoringOfferDialog } from "@/components/MonitoringOfferDialog";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  getMonitoringProjects,
  createMonitoringProject,
  updateMonitoringProject,
  deleteMonitoringProject,
  offersApi,
  type MonitoringProject,
  type OfferPackage,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// Designer to samodzielna strona (frontend/public/monitoring/designer.html) —
// mapa satelitarna z kamerami, otwierana w nowej karcie z ?id= projektu.
const designerUrl = (id: number) => `/monitoring/designer.html?id=${id}`;

/** Kolumny, po których da się sortować listę projektów monitoringu. */
type ProjectSortKey = "id" | "name" | "address" | "cameras" | "created" | "updated";

/**
 * Domyślny kierunek sortowania kolumny — liczniki i daty ludzie czytają od
 * największej wartości (najnowsze/najliczniejsze u góry), teksty alfabetycznie
 * (jak w kartotece obiektów).
 */
const DEFAULT_DIR: Record<ProjectSortKey, "asc" | "desc"> = {
  id: "desc",
  name: "asc",
  address: "asc",
  cameras: "desc",
  created: "desc",
  updated: "desc",
};

/** Filtr planu kamer: wszystkie / tylko z rozmieszczeniem / tylko puste. */
type CamerasMode = "all" | "with" | "without";

/** Filtr świeżości zmiany — wartość to liczba dni wstecz albo „all”. */
type FreshMode = "all" | "7" | "30" | "90";

/** Liczba z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Data z bazy na liczbę do porównań; brak lub śmieć = wartość pusta (NULLS LAST). */
function parseDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export function Monitoring() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/projekty");
  const [projects, setProjects] = useState<MonitoringProject[]>([]);
  const [loading, setLoading] = useState(true);
  // Filtry i sortowanie liczymy po stronie klienta — `getMonitoringProjects()`
  // i tak zwraca całą listę (backend nie stronicuje), więc nie ma po co
  // dokładać parametrów do API. Z tego samego powodu widełki liczby kamer idą
  // bez debounce'u: nie ma żądania do odciążenia, a lista przelicza się w tym
  // samym renderze co wpisana cyfra.
  const [search, setSearch] = useState("");
  const [camerasMode, setCamerasMode] = useState<CamerasMode>("all");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [freshMode, setFreshMode] = useState<FreshMode>("all");
  const [sort, setSort] = useState<ProjectSortKey>("updated");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MonitoringProject | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [offerProject, setOfferProject] = useState<MonitoringProject | null>(
    null
  );

  /*
   * Wycena projektu: liczba kamer z planu w designerze zasila pakiet
   * parametryczny, więc z gotowego projektu robi się wyceniona oferta bez
   * przepisywania czegokolwiek ręcznie.
   *
   * Przycisk pokazujemy tylko komuś, kto ma prawo edycji Ofert — inaczej
   * kliknięcie kończyłoby się 403 z backendu.
   */
  const navigate = useNavigate();
  const canQuote = canEdit("technical/oferty");
  const [cctvPackages, setCctvPackages] = useState<OfferPackage[]>([]);
  const [quoting, setQuoting] = useState<number | null>(null);

  useEffect(() => {
    if (!canQuote) return;
    offersApi
      .listPackages({ category: "cctv" })
      .then((r) => setCctvPackages(r.data || []))
      .catch(() => setCctvPackages([]));
  }, [canQuote]);

  const makeOffer = async (project: MonitoringProject) => {
    // Bez pakietu oferta powstałaby pusta — wtedy lepiej powiedzieć wprost,
    // czego brakuje, niż zakładać dokument bez ani jednej pozycji.
    if (cctvPackages.length === 0) {
      window.alert(
        "Brak pakietów CCTV w bibliotece ofert. Dodaj pakiet w zakładce Oferty → Pakiety, " +
          "wtedy projekt da się wycenić jednym kliknięciem."
      );
      return;
    }
    const chosen =
      cctvPackages.length === 1
        ? cctvPackages[0]
        : cctvPackages.find(
            (p) =>
              p.name ===
              window.prompt(
                `Pakiet do wyceny (${project.cameras} kamer):\n` +
                  cctvPackages.map((x) => `• ${x.name}`).join("\n"),
                cctvPackages[0].name
              )
          );
    if (!chosen) return;

    setQuoting(project.id);
    try {
      const res = await offersApi.fromMonitoring(project.id, { packageId: chosen.id });
      if (res.data) navigate("/technical/oferty");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Nie udało się utworzyć oferty");
    } finally {
      setQuoting(null);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMonitoringProjects();
      setProjects(res.data ?? []);
    } catch (error) {
      console.error("Error loading monitoring projects:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Adres pokazywany w tabeli: pinezka z designera ma pierwszeństwo nad wpisem ręcznym. */
  const addressOf = (p: MonitoringProject) => p.pinAddress || p.address || "";

  /** Jeden przebieg: filtry + sortowanie. */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = parseAmount(minInput);
    const max = parseAmount(maxInput);
    // Granica świeżości liczona raz na przebieg — „ostatnie 30 dni” od teraz.
    const freshAfter =
      freshMode === "all" ? null : Date.now() - parseInt(freshMode, 10) * 24 * 3600_000;

    const list = projects.filter((p) => {
      if (
        q &&
        ![p.name, p.address, p.pinAddress, p.notes].some((v) =>
          (v ?? "").toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      // Projekt bez ani jednej kamery = założona teczka, w której nikt jeszcze
      // nie rozstawił planu — filtr „puste” służy właśnie do ich wyłapania.
      const cams = p.cameras ?? 0;
      if (camerasMode === "with" && cams <= 0) return false;
      if (camerasMode === "without" && cams > 0) return false;
      if (min !== undefined && cams < min) return false;
      if (max !== undefined && cams > max) return false;
      if (freshAfter !== null) {
        const changed = parseDate(p.updatedAt) ?? parseDate(p.createdAt);
        if (changed === null || changed < freshAfter) return false;
      }
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;
    const text = (p: MonitoringProject) => (sort === "name" ? p.name : addressOf(p));
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (p: MonitoringProject): number | null => {
      switch (sort) {
        case "id":
          return p.id;
        case "cameras":
          return p.cameras ?? 0;
        case "created":
          return parseDate(p.createdAt);
        default:
          return parseDate(p.updatedAt);
      }
    };

    const numeric = sort === "id" || sort === "cameras" || sort === "created" || sort === "updated";

    // Puste adresy i brak daty lądują na końcu w OBU kierunkach (jak NULLS LAST
    // w sortowaniu obiektów) — inaczej „sortuj po adresie” zaczynałoby się od
    // projektów bez pinezki. Remis rozstrzyga nazwa, żeby kolejność była stabilna.
    const compare = (a: MonitoringProject, b: MonitoringProject): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
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

    return list.sort((a, b) => compare(a, b) || a.name.localeCompare(b.name, "pl"));
  }, [projects, search, camerasMode, minInput, maxInput, freshMode, sort, dir]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: ProjectSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    camerasMode !== "all" ||
    minInput !== "" ||
    maxInput !== "" ||
    freshMode !== "all";

  const clearFilters = () => {
    setSearch("");
    setCamerasMode("all");
    setMinInput("");
    setMaxInput("");
    setFreshMode("all");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey,
    align = "left",
    title,
  }: {
    label: string;
    sortKey: ProjectSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = sort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("py-3 px-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`projekty-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          title={title}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            activeCol ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
        </button>
      </th>
    );
  };

  const openForm = (project: MonitoringProject | null) => {
    setEditing(project);
    setName(project?.name ?? "");
    setAddress(project?.address ?? "");
    setNotes(project?.notes ?? "");
    setFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!editable) return;
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateMonitoringProject(editing.id, { name, address, notes });
      } else {
        const res = await createMonitoringProject({ name, address, notes });
        if (res.data) window.open(designerUrl(res.data.id), "_blank");
      }
      setFormOpen(false);
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (project: MonitoringProject) => {
    if (!editable) return;
    if (
      window.confirm(
        `Usunąć projekt "${project.name}" wraz z rozmieszczeniem kamer?`
      )
    ) {
      try {
        await deleteMonitoringProject(project.id);
        load();
      } catch (error) {
        alert(error instanceof Error ? error.message : "Nie można usunąć");
      }
    }
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj projektu, adresu, notatki..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Świeżość liczymy z ostatniej zmiany, a gdy projektu nikt nie ruszał —
            z daty utworzenia, bo to wtedy ta sama chwila. */}
        <Select value={freshMode} onValueChange={(v) => setFreshMode(v as FreshMode)}>
          <SelectTrigger className="w-[200px]" data-testid="projekty-filter-updated">
            <SelectValue placeholder="Ostatnia zmiana" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Zmiana: kiedykolwiek</SelectItem>
            <SelectItem value="7">Ostatnie 7 dni</SelectItem>
            <SelectItem value="30">Ostatnie 30 dni</SelectItem>
            <SelectItem value="90">Ostatnie 90 dni</SelectItem>
          </SelectContent>
        </Select>

        {editable && (
          <Button className="ml-auto" onClick={() => openForm(null)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy projekt
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: plan kamer — tryb i widełki liczby. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={camerasMode} onValueChange={(v) => setCamerasMode(v as CamerasMode)}>
          <SelectTrigger className="w-[220px]" data-testid="projekty-filter-cameras-mode">
            <SelectValue placeholder="Kamery" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Kamery: wszystkie</SelectItem>
            <SelectItem value="with">Tylko z rozmieszczeniem</SelectItem>
            <SelectItem value="without">Tylko bez kamer</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Kamer od</span>
          <Input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            className="w-24 tabular-nums"
            data-testid="projekty-filter-min"
            value={minInput}
            onChange={(e) => setMinInput(e.target.value)}
          />
          <span>do</span>
          <Input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            className="w-24 tabular-nums"
            data-testid="projekty-filter-max"
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
          />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="projekty-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-2">
          {loading ? (
            <div className="text-center py-8">Ładowanie...</div>
          ) : visible.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {filtersActive
                ? "Brak projektów dla wybranych filtrów"
                : "Brak projektów. Utwórz pierwszy projekt monitoringu."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <SortHeader label="Nr oferty" sortKey="id" align="right" />
                    <SortHeader label="Nazwa" sortKey="name" />
                    <SortHeader
                      label="Adres"
                      sortKey="address"
                      title="Adres z pinezki w designerze, a bez niej wpisany ręcznie; projekty bez adresu idą na koniec"
                    />
                    <SortHeader label="Kamery" sortKey="cameras" align="right" />
                    <SortHeader label="Data utworzenia" sortKey="created" />
                    <SortHeader label="Ostatnia zmiana" sortKey="updated" />
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <tr key={p.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 px-2 text-right tabular-nums font-medium">
                        #{p.id}
                      </td>
                      <td className="py-3 px-2">
                        <a
                          href={designerUrl(p.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-primary hover:underline inline-flex items-center gap-2"
                        >
                          <Cctv className="h-4 w-4" />
                          {p.name}
                        </a>
                      </td>
                      <td className="py-3 px-2">{addressOf(p) || "-"}</td>
                      <td className="py-3 px-2 text-right tabular-nums">
                        {p.cameras}
                      </td>
                      <td className="py-3 px-2 text-muted-foreground">
                        {p.createdAt?.slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="py-3 px-2 text-muted-foreground">
                        {p.updatedAt?.slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              window.open(designerUrl(p.id), "_blank")
                            }
                            title="Otwórz designer"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setOfferProject(p)}
                            title="Dokument z wizji (zdjęcia + generowanie HTML)"
                          >
                            <FileText className="h-4 w-4" />
                          </Button>
                          {canQuote && (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={quoting === p.id}
                              onClick={() => makeOffer(p)}
                              title={`Wyceń: utwórz ofertę na ${p.cameras} kamer z tego projektu`}
                            >
                              <Receipt className="h-4 w-4" />
                            </Button>
                          )}
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openForm(p)}
                                title="Edytuj dane projektu"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(p)}
                                title="Usuń projekt"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {offerProject && (
        <MonitoringOfferDialog
          projectId={offerProject.id}
          projectName={offerProject.name}
          open={!!offerProject}
          onOpenChange={(open) => {
            if (!open) setOfferProject(null);
          }}
        />
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edytuj projekt" : "Nowy projekt monitoringu"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mon-name">Nazwa *</Label>
              <Input
                id="mon-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="np. Aluzyjna 25, Warszawa"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mon-address">Adres</Label>
              <Input
                id="mon-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="ulica, miasto"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mon-notes">Kontekst obiektu / notatki</Label>
              <Textarea
                id="mon-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={5}
                placeholder="kontakt, stan obecny, ustalenia z wizji..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Anuluj
            </Button>
            <Button onClick={handleSubmit} disabled={saving || !name.trim()}>
              {editing ? "Zapisz" : "Utwórz i otwórz"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
