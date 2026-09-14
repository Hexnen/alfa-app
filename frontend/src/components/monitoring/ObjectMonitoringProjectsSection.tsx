/**
 * Sekcja „Projekty CCTV” na karcie obiektu — obok Umów (draftów).
 *
 * Dane ciągniemy OSOBNYM zapytaniem zamiast rozszerzać payload `/objects/:id`:
 * zostają wtedy za własnym kluczem uprawnień (`technical/projekty`), a kartoteka
 * obiektu nie wozi ich każdemu, kto ma dostęp do obiektów. Kartę renderuje
 * `pages/ObjectDetails.tsx` tylko dla użytkowników z tym kluczem.
 *
 * Dwie drogi podpięcia, bo tak to wygląda w praktyce: projekt rysowany OD RAZU
 * dla obiektu z kartoteki („Nowy projekt” — nazwa i adres z kartoteki, teczka
 * powstaje od razu podpięta) i projekt, który powstał WCZEŚNIEJ, na zapytanie
 * ofertowe, zanim obiekt w ogóle istniał („Podepnij istniejący”).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Cctv, ExternalLink, Link2, Link2Off, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ChartCard, EmptyState } from "@/components/analytics";
import {
  createMonitoringProject,
  getMonitoringProjects,
  getMonitoringProjectsByObject,
  updateMonitoringProject,
  type InterventionPickObject,
  type MonitoringProject,
} from "@/lib/api";
import { DASH, errMsg } from "@/components/interventions/helpers";

interface Props {
  object: InterventionPickObject;
  /** `canEdit("technical/projekty")` — bez tego sama tabela, bez akcji. */
  editable: boolean;
}

const THEAD = "border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground";

// Designer to samodzielna strona (frontend/public/monitoring/designer.html) —
// mapa satelitarna z kamerami, otwierana w nowej karcie z ?id= projektu.
// Ta sama konwencja co w pages/Monitoring.tsx.
const designerUrl = (id: number) => `/monitoring/designer.html?id=${id}`;

/** Data z bazy w formie czytelnej w tabeli (jak na liście projektów). */
const shortDate = (raw: string | null | undefined) =>
  raw ? raw.slice(0, 16).replace("T", " ") : DASH;

export function ObjectMonitoringProjectsSection({ object, editable }: Props) {
  const [rows, setRows] = useState<MonitoringProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Okno „Podepnij istniejący” — otwarte trzyma listę projektów bez obiektu. */
  const [linkOpen, setLinkOpen] = useState(false);

  const objectId = object.id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMonitoringProjectsByObject(objectId);
      setRows(res.data?.items ?? []);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(errMsg(e, "Nie udało się wczytać projektów tego obiektu."));
    } finally {
      setLoading(false);
    }
  }, [objectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Nowy projekt powstaje od razu podpięty i z danymi z kartoteki — zaraz po
   * zapisie otwieramy designer w nowej karcie, bo po to się go zakłada
   * (tak samo robi przycisk „Utwórz i otwórz” na liście projektów).
   */
  const createHere = async () => {
    if (!editable || busy) return;
    setBusy(true);
    try {
      const res = await createMonitoringProject({
        name: object.name,
        address: [object.address, object.city].filter(Boolean).join(", "),
        objectId,
      });
      if (res.data) window.open(designerUrl(res.data.id), "_blank");
      await load();
    } catch (e) {
      window.alert(errMsg(e, "Nie udało się utworzyć projektu."));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (project: MonitoringProject) => {
    if (!editable || busy) return;
    if (!window.confirm(`Odpiąć projekt „${project.name}” od tego obiektu? Sam projekt zostaje.`)) {
      return;
    }
    setBusy(true);
    try {
      await updateMonitoringProject(project.id, { name: project.name, objectId: null });
      await load();
    } catch (e) {
      window.alert(errMsg(e, "Nie udało się odpiąć projektu."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="object-projekty-cctv">
      <ChartCard
        title="Projekty CCTV"
        description="Plany kamer z designera monitoringu podpięte pod ten obiekt — rozmieszczenie, zasięgi i trasy kabli."
        controls={
          <div className="flex items-center gap-2">
            <Link
              to="/technical/projekty"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              data-testid="object-projekty-cctv-lista"
            >
              Wszystkie projekty
            </Link>
            {editable && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setLinkOpen(true)}
                  data-testid="object-projekty-cctv-podepnij"
                >
                  <Link2 className="mr-1 h-4 w-4" /> Podepnij istniejący
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void createHere()}
                  data-testid="object-projekty-cctv-nowy"
                >
                  <Plus className="mr-1 h-4 w-4" /> Nowy projekt
                </Button>
              </>
            )}
          </div>
        }
      >
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ładowanie…</p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Cctv}
            title="Brak projektów CCTV dla tego obiektu"
            description={
              editable
                ? "Kliknij „Nowy projekt”, żeby założyć teczkę z nazwą i adresem z kartoteki, albo podepnij plan narysowany wcześniej na zapytanie ofertowe."
                : "Projekty podpięte w Techniczny → Projekty pojawią się tutaj."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="object-projekty-cctv-tabela">
              <thead className={THEAD}>
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Nazwa</th>
                  <th className="px-2 py-2 text-left font-medium">Adres</th>
                  <th className="px-2 py-2 text-right font-medium">Kamery</th>
                  <th className="px-2 py-2 text-left font-medium">Ostatnia zmiana</th>
                  <th className="px-2 py-2 text-right font-medium">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-2 py-2">
                      <a
                        href={designerUrl(p.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 font-medium text-primary hover:underline"
                        title="Otwórz projekt w designerze"
                        data-testid="object-projekty-cctv-designer"
                      >
                        <Cctv className="h-4 w-4" aria-hidden />
                        {p.name}
                      </a>
                    </td>
                    {/* Adres z pinezki w designerze ma pierwszeństwo nad wpisanym
                        ręcznie — tak samo jak na liście projektów. */}
                    <td className="px-2 py-2">{p.pinAddress || p.address || DASH}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{p.cameras}</td>
                    <td className="px-2 py-2 text-muted-foreground">{shortDate(p.updatedAt)}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => window.open(designerUrl(p.id), "_blank")}
                          title="Otwórz designer"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            onClick={() => void unlink(p)}
                            title="Odepnij projekt od obiektu"
                            data-testid="object-projekty-cctv-odepnij"
                          >
                            <Link2Off className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>

      {linkOpen && (
        <LinkExistingDialog
          objectId={objectId}
          onClose={() => setLinkOpen(false)}
          onLinked={() => {
            setLinkOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Wybór projektu bez obiektu. Nie ma tu pickera z podpowiedziami z backendu:
 * lista projektów jest krótka i backend i tak zwraca ją w całości (nie
 * stronicuje), więc filtrujemy po stronie klienta — tak samo jak zakładka
 * Projekty. Pokazujemy WYŁĄCZNIE niepodpięte: przepinanie cudzego projektu
 * jednym kliknięciem z karty obiektu to nie jest operacja, którą chce się
 * robić przypadkiem.
 */
function LinkExistingDialog({
  objectId,
  onClose,
  onLinked,
}: {
  objectId: number;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [all, setAll] = useState<MonitoringProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMonitoringProjects()
      .then((res) => {
        if (cancelled) return;
        setAll((res.data ?? []).filter((p) => p.objectId === null));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setAll([]);
        setError(errMsg(e, "Nie udało się wczytać listy projektów."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) =>
      [p.name, p.address, p.pinAddress, p.notes].some((v) => (v ?? "").toLowerCase().includes(q))
    );
  }, [all, query]);

  const link = async (project: MonitoringProject) => {
    if (saving) return;
    setSaving(true);
    try {
      // Nazwa idzie w PUT, bo backend bierze ją tylko wtedy, gdy niepusta —
      // wysyłamy istniejącą, żeby podpięcie nie ruszało pozostałych pól.
      await updateMonitoringProject(project.id, { name: project.name, objectId });
      onLinked();
    } catch (e) {
      window.alert(errMsg(e, "Nie udało się podpiąć projektu."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Podepnij istniejący projekt</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Szukaj projektu (nazwa, adres, notatka)…"
            data-testid="object-projekty-cctv-szukaj"
          />
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Ładowanie…</p>
          ) : error ? (
            <p className="py-6 text-center text-sm text-destructive">{error}</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {all.length === 0
                ? "Wszystkie projekty są już podpięte pod obiekty."
                : "Brak projektów dla tej frazy."}
            </p>
          ) : (
            <ul
              className="max-h-72 space-y-1 overflow-y-auto"
              data-testid="object-projekty-cctv-lista-wyboru"
            >
              {visible.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void link(p)}
                    className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    data-testid="object-projekty-cctv-opcja"
                  >
                    <Cctv className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[p.pinAddress || p.address, `${p.cameras} kamer na planie`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Anuluj
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
