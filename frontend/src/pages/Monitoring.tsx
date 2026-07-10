import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, ExternalLink, Cctv, FileText } from "lucide-react";
import { MonitoringOfferDialog } from "@/components/MonitoringOfferDialog";
import {
  getMonitoringProjects,
  createMonitoringProject,
  updateMonitoringProject,
  deleteMonitoringProject,
  type MonitoringProject,
} from "@/lib/api";

// Designer to samodzielna strona (frontend/public/monitoring/designer.html) —
// mapa satelitarna z kamerami, otwierana w nowej karcie z ?id= projektu.
const designerUrl = (id: number) => `/monitoring/designer.html?id=${id}`;

export function Monitoring() {
  const [projects, setProjects] = useState<MonitoringProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MonitoringProject | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [offerProject, setOfferProject] = useState<MonitoringProject | null>(
    null
  );

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

  const openForm = (project: MonitoringProject | null) => {
    setEditing(project);
    setName(project?.name ?? "");
    setAddress(project?.address ?? "");
    setNotes(project?.notes ?? "");
    setFormOpen(true);
  };

  const handleSubmit = async () => {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Projekty — CCTV</h1>
        <Button onClick={() => openForm(null)}>
          <Plus className="h-4 w-4 mr-2" />
          Nowy projekt
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="text-center py-8">Ładowanie...</div>
          ) : projects.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Brak projektów. Utwórz pierwszy projekt monitoringu.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-right py-3 px-2 font-medium">
                      Nr oferty
                    </th>
                    <th className="text-left py-3 px-2 font-medium">Nazwa</th>
                    <th className="text-left py-3 px-2 font-medium">Adres</th>
                    <th className="text-right py-3 px-2 font-medium">Kamery</th>
                    <th className="text-left py-3 px-2 font-medium">
                      Data utworzenia
                    </th>
                    <th className="text-left py-3 px-2 font-medium">
                      Ostatnia zmiana
                    </th>
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
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
                      <td className="py-3 px-2">
                        {p.pinAddress || p.address || "-"}
                      </td>
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
                            title="Oferta (zdjęcia + generowanie HTML)"
                          >
                            <FileText className="h-4 w-4" />
                          </Button>
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
                placeholder="kontakt, stan obecny, ustalenia z wizji lokalnej..."
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
