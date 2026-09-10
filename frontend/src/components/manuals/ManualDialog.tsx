import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  MANUAL_ATTACHMENT_MAX_FILES,
  manualsApi,
  type Manual,
  type ManualAttachment,
} from "@/lib/api";
import { fmtTimestamp } from "@/lib/calendar-labels";
import { ManualLinkPicker, type SelectedLink } from "./ManualLinkPicker";
import { ManualSectionsEditor } from "./ManualSectionsEditor";
import {
  allPending,
  clipboardImages,
  countFiles,
  emptySection,
  makePending,
  moveSection,
  patchSection,
  pendingUploads,
  removeSection,
  revokePending,
  sectionsFromManual,
  sectionsToInput,
  type EditorSection,
  type PendingFile,
} from "./manualSections";
import { partitionManualFiles } from "./manualsShared";

/** Dialog jest wyłącznie formularzem — czytanie manuala żyje w `ManualPreview`. */
export type ManualDialogMode = "create" | "edit";

interface ManualDialogProps {
  open: boolean;
  onClose: () => void;
  /** null = nowy manual. */
  manual: Manual | null;
  mode: ManualDialogMode;
  /** Zapisany manual (po create/update) — rodzic odświeża listę i zaznaczenie. */
  onSaved: (manual: Manual) => void;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Usuwa załącznik o danym id z całego drzewa punktów (po skasowaniu na serwerze). */
const stripAttachment = (list: EditorSection[], attId: number): EditorSection[] =>
  list.map((s) => ({
    ...s,
    attachments: s.attachments.filter((a) => a.id !== attId),
    children: s.children.map((c) => ({ ...c, attachments: c.attachments.filter((a) => a.id !== attId) })),
  }));

/**
 * Formularz manuala: tytuł, opis, struktura treści (punkty i podpunkty z plikami)
 * oraz powiązania ze sprzętem i usługami.
 *
 * Zapis idzie kilkoma strzałami, bo backend nie ma jednego „zapisz wszystko”:
 * POST/PUT pola → PUT powiązania → PUT struktura punktów (zwraca `keyMap` z id
 * nowych punktów) → POST plików per punkt. Rozbicie jest celowe: widać, co padło,
 * a struktura jest transakcyjna, więc nieudany PUT nic nie zmienia i wystarczy
 * powtórzyć. Dopiero błąd w połowie wysyłki plików wymaga przeładowania stanu
 * z GET /:id — pliki wgrane przed błędem już są na serwerze.
 */
export function ManualDialog({ open, onClose, manual, mode, onSaved }: ManualDialogProps) {
  const isNew = mode === "create";
  /** Manual, na którym pracujemy — po udanym POST przestaje być nullem, żeby retry nie zrobił duplikatu. */
  const [current, setCurrent] = useState<Manual | null>(manual);
  const [title, setTitle] = useState(manual?.title ?? "");
  const [description, setDescription] = useState(manual?.description ?? "");
  const [links, setLinks] = useState<SelectedLink[]>(
    (manual?.links ?? []).map((l) => ({ kind: l.kind, refId: l.refId, name: l.name, meta: l.meta }))
  );
  const [sections, setSections] = useState<EditorSection[]>(() => sectionsFromManual(manual));
  const [unassigned, setUnassigned] = useState<ManualAttachment[]>(manual?.unassignedAttachments ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Refy z bieżącym stanem: limit plików liczymy przed setState (bez stale closure),
  // a przy odmontowaniu trzeba zwolnić miniatury niewysłanych plików.
  const sectionsRef = useRef<EditorSection[]>(sections);
  sectionsRef.current = sections;
  const unassignedRef = useRef<ManualAttachment[]>(unassigned);
  unassignedRef.current = unassigned;

  useEffect(
    () => () => {
      revokePending(allPending(sectionsRef.current));
    },
    []
  );

  const totalFiles = countFiles(sections, unassigned);
  const canAddFiles = totalFiles < MANUAL_ATTACHMENT_MAX_FILES;

  /**
   * Dokłada pliki do punktu. `sectionKey === null` = „gdzieś w manualu”
   * (wklejenie/upuszczenie poza kartą): ostatni punkt, a gdy punktów nie ma —
   * nowy punkt, żeby plik miał gdzie wylądować.
   */
  const addFiles = useCallback(
    (sectionKey: string | null, incoming: File[]) => {
      if (busy || incoming.length === 0) return;
      const already = countFiles(sectionsRef.current, unassignedRef.current);
      const { accepted, messages } = partitionManualFiles(incoming, already);
      setError(messages.length ? messages.join(" ") : null);
      if (accepted.length === 0) return;
      const pend = accepted.map(makePending);
      setSections((prev) => {
        if (sectionKey) return patchSection(prev, sectionKey, (s) => ({ ...s, pending: [...s.pending, ...pend] }));
        if (prev.length === 0) return [{ ...emptySection(), pending: pend }];
        const last = prev[prev.length - 1];
        return [...prev.slice(0, -1), { ...last, pending: [...last.pending, ...pend] }];
      });
    },
    [busy]
  );

  const removePending = (sectionKey: string, fileKey: string) => {
    setSections((prev) =>
      patchSection(prev, sectionKey, (s) => {
        const item = s.pending.find((p) => p.key === fileKey);
        if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
        return { ...s, pending: s.pending.filter((p) => p.key !== fileKey) };
      })
    );
  };

  const addSection = () => setSections((prev) => [...prev, emptySection()]);

  const addSubsection = (parentKey: string) =>
    setSections((prev) => patchSection(prev, parentKey, (s) => ({ ...s, children: [...s.children, emptySection()] })));

  /** Kasowanie punktu pyta tylko wtedy, gdy jest co stracić (pusty znika bez pytania). */
  const deleteSection = (section: EditorSection) => {
    const hasContent =
      section.title.trim() !== "" ||
      section.body.trim() !== "" ||
      section.attachments.length > 0 ||
      section.pending.length > 0 ||
      section.children.length > 0;
    if (
      hasContent &&
      !window.confirm("Usunąć ten punkt? Jego tekst zniknie, a pliki wrócą do „Pozostałych plików”.")
    ) {
      return;
    }
    // Pliki istniejące wracają „luzem” — backend robi to samo (section_id → NULL).
    const freed = [...section.attachments, ...section.children.flatMap((c) => c.attachments)];
    revokePending([...section.pending, ...section.children.flatMap((c) => c.pending)]);
    if (freed.length) setUnassigned((prev) => [...prev, ...freed]);
    setSections((prev) => removeSection(prev, section.key));
  };

  /** Przenosi plik bez punktu do wskazanego punktu (zapisze się przy PUT /sections). */
  const assignAttachment = (attId: number, sectionKey: string) => {
    const att = unassignedRef.current.find((a) => a.id === attId);
    if (!att) return;
    setUnassigned((prev) => prev.filter((a) => a.id !== attId));
    setSections((prev) => patchSection(prev, sectionKey, (s) => ({ ...s, attachments: [...s.attachments, att] })));
  };

  const deleteAttachment = async (a: ManualAttachment) => {
    if (busy) return;
    if (!window.confirm(`Usunąć załącznik „${a.fileName}”? Pliku nie da się przywrócić.`)) return;
    try {
      await manualsApi.deleteAttachment(a.id);
      setSections((prev) => stripAttachment(prev, a.id));
      setUnassigned((prev) => prev.filter((x) => x.id !== a.id));
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć załącznika."));
    }
  };

  const addLink = (l: SelectedLink) =>
    setLinks((prev) => (prev.some((x) => x.kind === l.kind && x.refId === l.refId) ? prev : [...prev, l]));

  const removeLink = (kind: "item" | "service", refId: number) =>
    setLinks((prev) => prev.filter((x) => !(x.kind === kind && x.refId === refId)));

  const itemIds = links.filter((l) => l.kind === "item").map((l) => l.refId);
  const serviceIds = links.filter((l) => l.kind === "service").map((l) => l.refId);

  /** Czy zbiór powiązań różni się od tego, co przyszło z backendu. */
  const linksChanged = (base: Manual) => {
    const before = (base.links ?? []).map((l) => `${l.kind}:${l.refId}`).sort().join("|");
    const now = links.map((l) => `${l.kind}:${l.refId}`).sort().join("|");
    return before !== now;
  };

  /** Wklejenie/upuszczenie poza kartą punktu — plik trafia do ostatniego punktu. */
  const onDialogPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const images = clipboardImages(e.clipboardData);
    if (images.length === 0) return;
    e.preventDefault();
    addFiles(null, images);
  };

  const onDialogDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    addFiles(null, files);
  };

  /**
   * Po błędzie w trakcie wysyłki plików: świeży odczyt manuala + doklejenie tych
   * niewysłanych plików, których punkty nadal istnieją (reszta znika razem z miniaturą).
   */
  const reloadAfterPartialSave = async (manualId: number, notUploaded: Map<number, PendingFile[]>) => {
    const fresh = (await manualsApi.get(manualId)).data;
    if (!fresh) return;
    setCurrent(fresh);
    setTitle(fresh.title);
    setDescription(fresh.description ?? "");
    setLinks((fresh.links ?? []).map((l) => ({ kind: l.kind, refId: l.refId, name: l.name, meta: l.meta })));
    setUnassigned(fresh.unassignedAttachments ?? []);
    const used = new Set<number>();
    const attach = (list: EditorSection[]): EditorSection[] =>
      list.map((s) => {
        const keep = s.id !== null ? notUploaded.get(s.id) : undefined;
        if (keep) used.add(s.id as number);
        return { ...s, pending: keep ?? [], children: attach(s.children) };
      });
    const rebuilt = attach(sectionsFromManual(fresh));
    for (const [id, files] of notUploaded) if (!used.has(id)) revokePending(files);
    setSections(rebuilt);
  };

  const save = async () => {
    const t = title.trim();
    if (!t) {
      setError("Tytuł jest wymagany.");
      return;
    }
    const desc = description.trim();
    setBusy(true);
    setError(null);

    let latest = current;
    // Zdjęte przed wysyłką: setState w pętli i tak by nie zdążył przed kolejnym krokiem.
    const uploads = pendingUploads(sectionsRef.current);
    const structure = sectionsToInput(sectionsRef.current);

    try {
      if (!latest) {
        // Nowy manual: bez plików — te dołożymy dopiero, gdy punkty dostaną id.
        const res = await manualsApi.create({ title: t, description: desc, itemIds, serviceIds });
        if (!res.data) throw new Error("Backend nie zwrócił zapisanego manuala.");
        latest = res.data;
        setCurrent(latest);
      } else {
        if (t !== latest.title || desc !== (latest.description ?? "")) {
          const res = await manualsApi.update(latest.id, { title: t, description: desc });
          if (res.data) latest = res.data;
        }
        if (linksChanged(latest)) {
          const res = await manualsApi.setLinks(latest.id, { itemIds, serviceIds });
          if (res.data) latest = res.data;
        }
      }

      // PUT /sections jest transakcyjny, więc przy błędzie nic się nie zmienia —
      // wołamy go, gdy jest co zapisać albo co skasować.
      let keyMap: Record<string, number> = {};
      if (structure.length > 0 || (latest.sections?.length ?? 0) > 0) {
        const res = await manualsApi.setSections(latest.id, structure);
        if (res.data) {
          latest = res.data.manual;
          keyMap = res.data.keyMap;
        }
      }

      // Pliki punkt po punkcie — nieudany strzał zostawia poprzednie na serwerze,
      // dlatego zapamiętujemy, co jeszcze nie poszło (do przeładowania stanu).
      const pendingLeft = new Map<number, PendingFile[]>();
      const pendingByKey = new Map(
        sectionsRef.current
          .flatMap((s) => [s, ...s.children])
          .map((s) => [s.key, s.pending] as const)
      );
      for (let i = 0; i < uploads.length; i++) {
        const u = uploads[i];
        const sectionId = u.id ?? keyMap[u.key] ?? null;
        try {
          const res = await manualsApi.addAttachments(latest.id, u.files, sectionId);
          if (res.data) latest = res.data;
        } catch (uploadError) {
          for (const rest of uploads.slice(i)) {
            const id = rest.id ?? keyMap[rest.key];
            const files = pendingByKey.get(rest.key);
            if (id && files?.length) pendingLeft.set(id, files);
          }
          await reloadAfterPartialSave(latest.id, pendingLeft).catch(() => undefined);
          onSaved(latest);
          throw uploadError;
        }
      }

      revokePending(allPending(sectionsRef.current));
      onSaved(latest);
      onClose();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać manuala."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,52rem)] max-w-none flex-col gap-3 overflow-y-auto focus:outline-none"
        data-testid="manual-dialog"
        onPaste={onDialogPaste}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDialogDrop}
      >
        <DialogHeader>
          <DialogTitle className="pr-8">{isNew ? "Nowy manual" : "Edycja manuala"}</DialogTitle>
          <DialogDescription>
            Tytuł, wstęp, punkty instrukcji z plikami oraz powiązania ze sprzętem lub usługami.
          </DialogDescription>
        </DialogHeader>

        {dragOver && (
          <p className="rounded-md border border-dashed border-primary bg-primary/5 px-3 py-2 text-xs text-primary">
            Upuść pliki na kartę punktu — poza kartą trafią do ostatniego punktu.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="manual-title">Tytuł</Label>
          <Input
            id="manual-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="np. Instrukcja rejestratora Hikvision DS-7608"
            disabled={busy}
            data-testid="manual-title-input"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="manual-description">Opis (wstęp)</Label>
          <Textarea
            id="manual-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Czego dotyczy manual, na co uważać, do jakich modeli pasuje…"
            disabled={busy}
            data-testid="manual-description-input"
          />
        </div>

        {/* --- Punkty i podpunkty --- */}
        <ManualSectionsEditor
          sections={sections}
          unassigned={unassigned}
          disabled={busy}
          canAddFiles={canAddFiles}
          onPatch={(key, patch) => setSections((prev) => patchSection(prev, key, patch))}
          onMove={(key, delta) => setSections((prev) => moveSection(prev, key, delta))}
          onRemove={deleteSection}
          onAdd={addSection}
          onAddSub={addSubsection}
          onAddFiles={(key, files) => addFiles(key, files)}
          onRemovePending={removePending}
          onDeleteAttachment={(a) => void deleteAttachment(a)}
          onAssign={assignAttachment}
        />

        <p className="text-[11px] text-muted-foreground">
          Pliki: {totalFiles} z {MANUAL_ATTACHMENT_MAX_FILES}. Obrazek ze schowka wklejasz w punkt przez Ctrl+V.
        </p>

        {/* --- Powiązania --- */}
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">Powiązany sprzęt i usługi</p>
          <ManualLinkPicker
            kind="item"
            selected={links.filter((l) => l.kind === "item")}
            onAdd={addLink}
            onRemove={(refId) => removeLink("item", refId)}
          />
          <ManualLinkPicker
            kind="service"
            selected={links.filter((l) => l.kind === "service")}
            onAdd={addLink}
            onRemove={(refId) => removeLink("service", refId)}
          />
        </div>

        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="manual-dialog-error">
            {error}
          </p>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            {current?.createdAt
              ? `Dodano ${fmtTimestamp(current.createdAt)}${current.createdBy ? ` · ${current.createdBy}` : ""}`
              : ""}
          </span>
          <span className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Anuluj
            </Button>
            <Button type="button" onClick={() => void save()} disabled={busy} data-testid="manual-save">
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              {busy ? "Zapisywanie…" : "Zapisz"}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
