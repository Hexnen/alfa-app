import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { CameraModelForm } from "@/components/CameraModelForm";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { Plus, Search, Pencil, Trash2 } from "lucide-react";
import {
  getCameraModels,
  createCameraModel,
  updateCameraModel,
  deleteCameraModel,
  type CameraModel,
  type CameraModelInput,
  type CameraModelType,
} from "@/lib/api";

const typeLabels: Record<CameraModelType, string> = {
  bullet: "Tubowa",
  dome: "Kopułkowa",
  ptz: "PTZ",
  pano: "360°",
};

export function Templates() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/szablony");
  const [models, setModels] = useState<CameraModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CameraModel | null>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getCameraModels();
      setModels(res.data ?? []);
    } catch (error) {
      console.error("Error loading camera models:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const handleCreate = async (data: CameraModelInput) => {
    if (!editable) return;
    await createCameraModel(data);
    loadModels();
  };

  const handleUpdate = async (data: CameraModelInput) => {
    if (!editable) return;
    if (editing) {
      await updateCameraModel(editing.id, data);
      loadModels();
    }
  };

  const handleDelete = async (item: CameraModel) => {
    if (!editable) return;
    if (window.confirm(`Usunąć szablon "${item.name}"?`)) {
      try {
        await deleteCameraModel(item.id);
        loadModels();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć szablonu"
        );
      }
    }
  };

  const openEdit = (item: CameraModel) => {
    setEditing(item);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const q = search.trim().toLowerCase();
  const filtered = q
    ? models.filter((m) =>
        [m.name, m.manufacturer, typeLabels[m.type] ?? m.type, m.resolution]
          .filter(Boolean)
          .some((v) => v.toLowerCase().includes(q))
      )
    : models;

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj modelu…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy model
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">
              Ładowanie…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {models.length === 0
                ? "Brak szablonów kamer."
                : "Brak wyników."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Producent</th>
                    <th className="px-3 py-2 font-medium">Typ</th>
                    <th className="px-3 py-2 font-medium">Rozdz.</th>
                    <th className="px-3 py-2 text-right font-medium">FOV (°)</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Zasięg (m)
                    </th>
                    <th className="px-3 py-2 font-medium">IR</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr
                      key={item.id}
                      className={`cursor-pointer border-b last:border-0 hover:bg-accent/50 ${!item.active ? "opacity-50" : ""}`}
                      onClick={() => openEdit(item)}
                    >
                      <td className="px-3 py-2 font-medium">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="inline-block h-3 w-3 rounded-full border"
                            style={{ backgroundColor: item.color }}
                          />
                          {item.name}
                        </span>
                        {!item.active && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (nieaktywny)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{item.manufacturer || "—"}</td>
                      <td className="px-3 py-2">
                        {typeLabels[item.type] ?? item.type}
                      </td>
                      <td className="px-3 py-2">{item.resolution || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.fov}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.range}
                      </td>
                      <td className="px-3 py-2">{item.irRange || "—"}</td>
                      <td className="px-3 py-2">
                        {editable && (
                          <div
                            className="flex justify-end gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEdit(item)}
                              title="Edytuj"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleDelete(item)}
                              title="Usuń"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <CameraModelForm
        open={formOpen}
        onClose={closeForm}
        onSubmit={editing ? handleUpdate : handleCreate}
        item={editing}
      />
    </div>
  );
}
