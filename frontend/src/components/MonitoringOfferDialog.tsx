import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ImagePlus, Trash2, ExternalLink, Download } from "lucide-react";
import {
  getMonitoringProject,
  saveMonitoringOffer,
  getMonitoringPhotos,
  addMonitoringPhoto,
  updateMonitoringPhoto,
  deleteMonitoringPhoto,
  type MonitoringOfferFields,
  type MonitoringPhoto,
} from "@/lib/api";

const EMPTY_OFFER: MonitoringOfferFields = {
  kicker: "Wizja — materiał do wyceny (dział techniczny)",
  subtitle: "",
  visitDate: "",
  purpose: "wycena kosztów przez dział techniczny",
  contact: "",
  summary: "",
  calloutTitle: "",
  callout: "",
  existing: "",
};

// Zmniejszenie zdjęcia w przeglądarce przed wysyłką — jak w oryginalnym
// generatorze (max 1500 px dłuższy bok, JPEG ~80%).
async function resizeToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Brak wsparcia canvas");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.8);
}

const captionFromFilename = (name: string) => {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
};

interface Props {
  projectId: number;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MonitoringOfferDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: Props) {
  const [offer, setOffer] = useState<MonitoringOfferFields>(EMPTY_OFFER);
  const [photos, setPhotos] = useState<MonitoringPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [projRes, photosRes] = await Promise.all([
        getMonitoringProject(projectId),
        getMonitoringPhotos(projectId),
      ]);
      let parsed: Partial<MonitoringOfferFields> = {};
      try {
        parsed = JSON.parse(projRes.data?.offer || "{}");
      } catch {
        parsed = {};
      }
      setOffer({ ...EMPTY_OFFER, ...parsed });
      setPhotos(photosRes.data ?? []);
    } catch (error) {
      console.error("Error loading offer:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const set = (field: keyof MonitoringOfferFields, value: string) =>
    setOffer((o) => ({ ...o, [field]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await saveMonitoringOffer(projectId, offer);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu");
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const generate = async (download: boolean) => {
    try {
      await save();
    } catch {
      return;
    }
    window.open(
      `/api/monitoring/${projectId}/offer${download ? "?download=1" : ""}`,
      "_blank"
    );
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const data = await resizeToDataUrl(file);
        const res = await addMonitoringPhoto(projectId, {
          caption: captionFromFilename(file.name),
          data,
        });
        if (res.data) setPhotos((p) => [...p, res.data!]);
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd wysyłania zdjęcia");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const patchPhoto = async (
    photo: MonitoringPhoto,
    updates: { caption?: string; attention?: boolean }
  ) => {
    setPhotos((list) =>
      list.map((p) => (p.id === photo.id ? { ...p, ...updates } : p))
    );
    try {
      await updateMonitoringPhoto(photo.id, updates);
    } catch (error) {
      console.error("Error updating photo:", error);
    }
  };

  const removePhoto = async (photo: MonitoringPhoto) => {
    if (!window.confirm(`Usunąć zdjęcie "${photo.caption}"?`)) return;
    try {
      await deleteMonitoringPhoto(photo.id);
      setPhotos((list) => list.filter((p) => p.id !== photo.id));
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie można usunąć");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Oferta — {projectName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center">Ładowanie...</div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                <Label>Nagłówek (nad tytułem)</Label>
                <Input
                  value={offer.kicker}
                  onChange={(e) => set("kicker", e.target.value)}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Podtytuł</Label>
                <Input
                  value={offer.subtitle}
                  onChange={(e) => set("subtitle", e.target.value)}
                  placeholder="domyślnie adres projektu"
                />
              </div>
              <div className="space-y-2">
                <Label>Wizja (data)</Label>
                <Input
                  value={offer.visitDate}
                  onChange={(e) => set("visitDate", e.target.value)}
                  placeholder="np. 23.06.2026"
                />
              </div>
              <div className="space-y-2">
                <Label>Kontakt na obiekcie</Label>
                <Input
                  value={offer.contact}
                  onChange={(e) => set("contact", e.target.value)}
                  placeholder="imię i nazwisko, telefon"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Cel opracowania</Label>
                <Input
                  value={offer.purpose}
                  onChange={(e) => set("purpose", e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>„W skrócie" — jedna pozycja na linię (**pogrubienie**)</Label>
              <Textarea
                rows={5}
                value={offer.summary}
                onChange={(e) => set("summary", e.target.value)}
                placeholder={
                  "**Oczekiwanie wspólnoty:** zdalny monitoring wizyjny...\nObecny monitoring: **duża liczba obszarów niepokryta**..."
                }
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Wyróżniona uwaga — tytuł</Label>
                <Input
                  value={offer.calloutTitle}
                  onChange={(e) => set("calloutTitle", e.target.value)}
                  placeholder="np. Altanka bez monitoringu"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Wyróżniona uwaga — treść</Label>
                <Textarea
                  rows={2}
                  value={offer.callout}
                  onChange={(e) => set("callout", e.target.value)}
                  placeholder="pomarańczowa ramka; pusta = sekcja pominięta"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Stan istniejący i uwarunkowania — jedna pozycja na linię</Label>
              <Textarea
                rows={3}
                value={offer.existing}
                onChange={(e) => set("existing", e.target.value)}
                placeholder="**Istniejące rejestratory:** 3 szt. ..."
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Dokumentacja fotograficzna ({photos.length})</Label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4 mr-2" />
                  {uploading ? "Wysyłanie..." : "Dodaj zdjęcia"}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
              </div>
              {photos.length === 0 ? (
                <div className="text-sm text-muted-foreground border rounded-md p-4 text-center">
                  Brak zdjęć — galeria zostanie pominięta w ofercie.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {photos.map((p) => (
                    <div key={p.id} className="border rounded-md overflow-hidden">
                      <img
                        src={p.data}
                        alt={p.caption}
                        className="w-full h-28 object-cover"
                      />
                      <div className="p-2 space-y-2">
                        <Input
                          className="h-8 text-sm"
                          value={p.caption}
                          onChange={(e) =>
                            setPhotos((list) =>
                              list.map((x) =>
                                x.id === p.id
                                  ? { ...x, caption: e.target.value }
                                  : x
                              )
                            )
                          }
                          onBlur={(e) =>
                            patchPhoto(p, { caption: e.target.value })
                          }
                        />
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                            <Checkbox
                              checked={p.attention}
                              onCheckedChange={(v) =>
                                patchPhoto(p, { attention: v === true })
                              }
                            />
                            wyróżnij
                          </label>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => removePhoto(p)}
                            title="Usuń zdjęcie"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={save}
            disabled={saving || loading}
          >
            Zapisz
          </Button>
          <Button
            variant="outline"
            onClick={() => generate(true)}
            disabled={saving || loading}
          >
            <Download className="h-4 w-4 mr-2" />
            Pobierz HTML
          </Button>
          <Button onClick={() => generate(false)} disabled={saving || loading}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Generuj ofertę
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
