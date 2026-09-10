// Edytor struktury manuala: karty punktów („1.”) i podpunktów („1.1”), pliki
// per punkt oraz „Pozostałe pliki” (załączniki bez punktu — tak wyglądają
// manuale sprzed podziału na punkty).
//
// Stan trzyma `ManualDialog` (potrzebuje go przy zapisie), jego model i czyste
// przekształcenia żyją w `manualSections.ts` — tutaj jest wyłącznie render
// i wołanie callbacków.
import { useRef, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ListPlus, Plus, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MANUAL_ATTACHMENT_ACCEPT, type ManualAttachment } from "@/lib/api";
import { attachmentIcon, downloadUrlOf, fmtFileSize, opensInline } from "./manualsShared";
import { SECTION_TITLE_MAX, clipboardImages, sectionOptions, type EditorSection } from "./manualSections";


interface SectionCardProps {
  section: EditorSection;
  /** Numer punktu do wyświetlenia i testidów: „1” albo „1.2”. */
  idx: string;
  level: 1 | 2;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canAddFiles: boolean;
  onPatch: (key: string, patch: (s: EditorSection) => EditorSection) => void;
  onMove: (key: string, delta: -1 | 1) => void;
  onRemove: (section: EditorSection) => void;
  onAddSub?: (key: string) => void;
  onAddFiles: (key: string, files: File[]) => void;
  onRemovePending: (key: string, fileKey: string) => void;
  onDeleteAttachment: (attachment: ManualAttachment) => void;
}

function SectionCard({
  section,
  idx,
  level,
  disabled,
  canMoveUp,
  canMoveDown,
  canAddFiles,
  onPatch,
  onMove,
  onRemove,
  onAddSub,
  onAddFiles,
  onRemovePending,
  onDeleteAttachment,
}: SectionCardProps) {
  const fileInput = useRef<HTMLInputElement>(null);

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const images = clipboardImages(e.clipboardData);
    if (images.length === 0) return; // zwykłe wklejenie tekstu zostawiamy polu
    e.preventDefault();
    // Bez tego ten sam obrazek złapałby jeszcze dialog (dokłada do ostatniego punktu).
    e.stopPropagation();
    onAddFiles(section.key, images);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    onAddFiles(section.key, files);
  };

  const rows = Math.min(12, Math.max(3, section.body.split("\n").length + 1));

  return (
    <div
      className={level === 1 ? "space-y-2 rounded-md border bg-card p-2.5" : "space-y-2 rounded-md border bg-muted/20 p-2"}
      data-testid={`manual-section-${idx}`}
      onPaste={onPaste}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-2 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground"
          title="Numer punktu"
        >
          {level === 1 ? `${idx}.` : idx}
        </span>
        <Input
          value={section.title}
          onChange={(e) => onPatch(section.key, (s) => ({ ...s, title: e.target.value }))}
          placeholder={level === 1 ? "Tytuł punktu (opcjonalnie)" : "Tytuł podpunktu (opcjonalnie)"}
          maxLength={SECTION_TITLE_MAX}
          disabled={disabled}
          className="h-8"
          data-testid={`manual-section-title-${idx}`}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={disabled || !canMoveUp}
            onClick={() => onMove(section.key, -1)}
            title="Przesuń wyżej"
            aria-label={`Przesuń punkt ${idx} wyżej`}
            data-testid={`manual-section-up-${idx}`}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={disabled || !canMoveDown}
            onClick={() => onMove(section.key, 1)}
            title="Przesuń niżej"
            aria-label={`Przesuń punkt ${idx} niżej`}
            data-testid={`manual-section-down-${idx}`}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          {onAddSub && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              disabled={disabled}
              onClick={() => onAddSub(section.key)}
              title="Dodaj podpunkt"
              data-testid={`manual-subsection-add-${idx}`}
            >
              <ListPlus className="mr-1 h-3.5 w-3.5" />
              Podpunkt
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={disabled}
            onClick={() => onRemove(section)}
            title="Usuń punkt"
            aria-label={`Usuń punkt ${idx}`}
            data-testid={`manual-section-delete-${idx}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      <Textarea
        value={section.body}
        onChange={(e) => onPatch(section.key, (s) => ({ ...s, body: e.target.value }))}
        rows={rows}
        placeholder="Treść punktu — kroki, uwagi, parametry… Obrazek można wkleić ze schowka (Ctrl+V)."
        disabled={disabled}
        data-testid={`manual-section-body-${idx}`}
      />

      <div className="flex flex-wrap items-center gap-1.5" data-testid={`manual-section-files-${idx}`}>
        {section.attachments.map((a) => {
          const Icon = attachmentIcon(a.mime, a.fileName);
          const inline = opensInline(a);
          return (
            <span
              key={a.id}
              className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-xs"
              data-testid="manual-section-attachment"
            >
              <a
                href={inline ? a.url : downloadUrlOf(a)}
                target={inline ? "_blank" : undefined}
                rel={inline ? "noopener noreferrer" : undefined}
                download={inline ? undefined : a.fileName}
                className="flex min-w-0 items-center gap-1.5 py-1 hover:underline"
                title={inline ? "Otwórz w nowej karcie" : "Pobierz"}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="max-w-[12rem] truncate">{a.fileName}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(a.size)}</span>
              </a>
              <button
                type="button"
                onClick={() => onDeleteAttachment(a)}
                disabled={disabled}
                className="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                aria-label={`Usuń załącznik ${a.fileName}`}
                title="Usuń załącznik"
                data-testid="manual-attachment-delete"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        {section.pending.map((p) => {
          const Icon = attachmentIcon(p.file.type, p.file.name);
          return (
            <span
              key={p.key}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-dashed bg-muted/40 py-1 pl-1.5 pr-1 text-xs"
              data-testid="manual-pending-file"
            >
              {p.previewUrl ? (
                <img src={p.previewUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
              ) : (
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="max-w-[12rem] truncate" title={p.file.name}>
                {p.file.name}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(p.file.size)}</span>
              <button
                type="button"
                onClick={() => onRemovePending(section.key, p.key)}
                disabled={disabled}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                aria-label={`Usuń ${p.file.name} z listy`}
                title="Usuń z listy"
                data-testid="manual-pending-remove"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={disabled || !canAddFiles}
          onClick={() => fileInput.current?.click()}
          title="Dodaj pliki do tego punktu (można je też upuścić na kartę albo wkleić ze schowka)"
          data-testid={`manual-section-attach-${idx}`}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Dodaj pliki
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={MANUAL_ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const list = e.target.files ? Array.from(e.target.files) : [];
            // Reset, żeby ten sam plik dało się wybrać ponownie po usunięciu z listy.
            e.target.value = "";
            onAddFiles(section.key, list);
          }}
          data-testid={`manual-section-file-input-${idx}`}
        />
      </div>
    </div>
  );
}

interface ManualSectionsEditorProps {
  sections: EditorSection[];
  /** Załączniki bez punktu (stare manuale) — do przeniesienia albo usunięcia. */
  unassigned: ManualAttachment[];
  disabled: boolean;
  /** false = limit plików wyczerpany (przyciski „Dodaj pliki” gasną). */
  canAddFiles: boolean;
  onPatch: (key: string, patch: (s: EditorSection) => EditorSection) => void;
  onMove: (key: string, delta: -1 | 1) => void;
  onRemove: (section: EditorSection) => void;
  onAdd: () => void;
  onAddSub: (parentKey: string) => void;
  onAddFiles: (key: string, files: File[]) => void;
  onRemovePending: (key: string, fileKey: string) => void;
  onDeleteAttachment: (attachment: ManualAttachment) => void;
  /** Przenosi plik „luzem” do wskazanego punktu (zapisze się przy PUT /sections). */
  onAssign: (attachmentId: number, sectionKey: string) => void;
}

/**
 * Lista kart punktów + sekcja „Pozostałe pliki” (załączniki bez punktu — tak
 * wyglądają manuale sprzed podziału na punkty). Cały stan przychodzi z góry,
 * komponent tylko renderuje i woła callbacki.
 */
export function ManualSectionsEditor({
  sections,
  unassigned,
  disabled,
  canAddFiles,
  onPatch,
  onMove,
  onRemove,
  onAdd,
  onAddSub,
  onAddFiles,
  onRemovePending,
  onDeleteAttachment,
  onAssign,
}: ManualSectionsEditorProps) {
  const options = sectionOptions(sections);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Punkty instrukcji</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={disabled}
          onClick={onAdd}
          data-testid="manual-section-add"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Dodaj punkt
        </Button>
      </div>

      {sections.length === 0 ? (
        <p
          className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground"
          data-testid="manual-sections-empty"
        >
          Brak punktów. Kliknij „Dodaj punkt”, żeby rozpisać instrukcję na kroki.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="manual-sections">
          {sections.map((s, i) => {
            const idx = String(i + 1);
            return (
              <li key={s.key} className="space-y-2">
                <SectionCard
                  section={s}
                  idx={idx}
                  level={1}
                  disabled={disabled}
                  canMoveUp={i > 0}
                  canMoveDown={i < sections.length - 1}
                  canAddFiles={canAddFiles}
                  onPatch={onPatch}
                  onMove={onMove}
                  onRemove={onRemove}
                  onAddSub={onAddSub}
                  onAddFiles={onAddFiles}
                  onRemovePending={onRemovePending}
                  onDeleteAttachment={onDeleteAttachment}
                />
                {s.children.length > 0 && (
                  <ul className="space-y-2 pl-5">
                    {s.children.map((c, j) => (
                      <li key={c.key}>
                        <SectionCard
                          section={c}
                          idx={`${idx}.${j + 1}`}
                          level={2}
                          disabled={disabled}
                          canMoveUp={j > 0}
                          canMoveDown={j < s.children.length - 1}
                          canAddFiles={canAddFiles}
                          onPatch={onPatch}
                          onMove={onMove}
                          onRemove={onRemove}
                          onAddFiles={onAddFiles}
                          onRemovePending={onRemovePending}
                          onDeleteAttachment={onDeleteAttachment}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {unassigned.length > 0 && (
        <div className="space-y-2 rounded-md border border-dashed p-2.5" data-testid="manual-unassigned">
          <p className="text-xs font-medium text-muted-foreground">Pozostałe pliki (bez punktu)</p>
          <ul className="flex flex-wrap gap-1.5">
            {unassigned.map((a) => {
              const Icon = attachmentIcon(a.mime, a.fileName);
              const inline = opensInline(a);
              return (
                <li
                  key={a.id}
                  className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-xs"
                  data-testid="manual-unassigned-file"
                >
                  <a
                    href={inline ? a.url : downloadUrlOf(a)}
                    target={inline ? "_blank" : undefined}
                    rel={inline ? "noopener noreferrer" : undefined}
                    download={inline ? undefined : a.fileName}
                    className="flex min-w-0 items-center gap-1.5 py-1 hover:underline"
                    title={inline ? "Otwórz w nowej karcie" : "Pobierz"}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="max-w-[12rem] truncate">{a.fileName}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(a.size)}</span>
                  </a>
                  {options.length > 0 && (
                    <Select
                      disabled={disabled}
                      onValueChange={(v) => onAssign(a.id, v)}
                    >
                      <SelectTrigger
                        className="h-6 w-[9rem] px-2 text-[11px]"
                        aria-label={`Przenieś ${a.fileName} do punktu`}
                        data-testid="manual-unassigned-move"
                      >
                        <SelectValue placeholder="Przenieś do punktu…" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((o) => (
                          <SelectItem key={o.key} value={o.key} className="text-xs">
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <button
                    type="button"
                    onClick={() => onDeleteAttachment(a)}
                    disabled={disabled}
                    className="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={`Usuń załącznik ${a.fileName}`}
                    title="Usuń załącznik"
                    data-testid="manual-attachment-delete"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
