import type { MouseEvent, ReactNode } from "react";
import { BookOpen, List, Paperclip, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtRelative, fmtTimestamp } from "@/lib/calendar-labels";
import type { Manual, ManualSection } from "@/lib/api";
import { ManualAttachmentsGallery } from "./ManualAttachmentsGallery";
import { ManualLinkChip } from "./ManualLinkChip";

/** Kotwica punktu — używa jej spis treści na górze panelu. */
const anchorOf = (section: ManualSection) => `manual-sec-${section.id}`;

/** Ile punktów pierwszego poziomu, żeby spis treści miał sens. */
const TOC_MIN_SECTIONS = 3;

/**
 * Punkt („1. Tytuł”, h3) albo podpunkt („1.1 Tytuł”, h4 z wcięciem). Tytuł jest
 * opcjonalny — wtedy zostaje sam numer. Załączniki punktu idą inline pod tekstem,
 * tak samo jak reszta treści: instrukcję czyta się bez klikania.
 */
function SectionView({ section, number, level }: { section: ManualSection; number: string; level: 1 | 2 }) {
  const title = section.title?.trim() ?? "";
  const children = section.children ?? [];
  // `overflow-wrap:anywhere` jak w tytule manuala — nagłówek punktu bywa numerem
  // katalogowym albo linkiem i bez tego rozpychał kartę w bok.
  const heading = (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {/* Kropka tylko po numerze punktu („1.”); podpunkt to „1.1” — jak w kontrakcie. */}
      <span className="tabular-nums text-muted-foreground">{level === 1 ? `${number}.` : number}</span>
      {title ? ` ${title}` : ""}
    </span>
  );

  return (
    <div
      id={anchorOf(section)}
      className={level === 1 ? "space-y-2 scroll-mt-4" : "space-y-2 scroll-mt-4 border-l pl-3"}
      data-testid={`manual-view-section-${number}`}
    >
      {level === 1 ? (
        <h3 className="flex text-sm font-semibold leading-snug">{heading}</h3>
      ) : (
        <h4 className="flex text-sm font-medium leading-snug">{heading}</h4>
      )}

      {section.body?.trim() && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{section.body}</p>
      )}

      <ManualAttachmentsGallery attachments={section.attachments ?? []} variant="inline" />

      {children.length > 0 && (
        <div className="space-y-3 pt-1">
          {children.map((child, j) => (
            <SectionView key={child.id} section={child} number={`${number}.${j + 1}`} level={2} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Spis treści — kotwice do punktów; pokazujemy go dopiero, gdy jest co spisywać. */
function TableOfContents({ sections }: { sections: ManualSection[] }) {
  const jump = (e: MouseEvent<HTMLAnchorElement>, section: ManualSection) => {
    // Bez `preventDefault` hash lądowałby w URL (obok `?id=` listy) i zapychał historię.
    e.preventDefault();
    document.getElementById(anchorOf(section))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav className="rounded-md border bg-muted/20 p-3" aria-label="Spis treści" data-testid="manual-toc">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <List className="h-3.5 w-3.5" aria-hidden />
        Spis treści
      </p>
      <ol className="space-y-0.5 text-sm">
        {sections.map((s, i) => (
          <li key={s.id}>
            <a
              href={`#${anchorOf(s)}`}
              onClick={(e) => jump(e, s)}
              className="[overflow-wrap:anywhere] hover:underline"
            >
              <span className="tabular-nums text-muted-foreground">{i + 1}.</span>{" "}
              {s.title?.trim() || "(bez tytułu)"}
            </a>
            {(s.children ?? []).length > 0 && (
              <ol className="space-y-0.5 pl-4 text-xs">
                {(s.children ?? []).map((c, j) => (
                  <li key={c.id}>
                    <a
                      href={`#${anchorOf(c)}`}
                      onClick={(e) => jump(e, c)}
                      className="[overflow-wrap:anywhere] text-muted-foreground hover:underline"
                    >
                      <span className="tabular-nums">
                        {i + 1}.{j + 1}
                      </span>{" "}
                      {c.title?.trim() || "(bez tytułu)"}
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface ManualPreviewProps {
  /** Wybrany manual albo null (pusty stan). */
  manual: Manual | null;
  /** Uprawnienie `edit` do zakładki — steruje przyciskami „Edytuj” i „Usuń”. */
  canEdit: boolean;
  onEdit: (manual: Manual) => void;
  onDelete: (manual: Manual) => void;
}

/**
 * Wspólna otoczka. Karta NIE jest już przyklejona do ekranu: załączniki
 * pokazujemy inline (obrazki na pełną szerokość, PDF-y w ramce 70vh), więc panel
 * bywa wyższy od okna — sticky z własnym `overflow-y` zamykałby całą instrukcję
 * w oknie wysokości ekranu i dawał scroll w scrollu. Przewija się cała strona.
 */
function PreviewCard({ children }: { children: ReactNode }) {
  return (
    <Card data-testid="manuals-preview">
      <CardContent className="p-4">{children}</CardContent>
    </Card>
  );
}

/**
 * Prawa kolumna widoku master-detail: pełny podgląd manuala wybranego z listy —
 * opis, załączniki rozwinięte inline (obrazki, PDF-y, pliki do pobrania) oraz powiązania
 * ze sprzętem i usługami. Edycja i usuwanie startują stąd; formularz mieszka
 * dalej w `ManualDialog`.
 */
export function ManualPreview({ manual, canEdit, onEdit, onDelete }: ManualPreviewProps) {
  if (!manual) {
    return (
      <PreviewCard>
        <div
          className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground"
          data-testid="manuals-preview-empty"
        >
          <BookOpen className="h-10 w-10 opacity-40" aria-hidden />
          <p className="text-sm">Wybierz manual z listy</p>
        </div>
      </PreviewCard>
    );
  }

  const count = manual.attachmentsCount ?? manual.attachments.length;
  const sections = manual.sections ?? [];
  // Manuale sprzed podziału na punkty nie mają struktury — wtedy pokazujemy
  // wszystkie pliki pod starym nagłówkiem „Załączniki”, a nie „Pozostałe pliki”.
  const loose = sections.length > 0 ? manual.unassignedAttachments ?? [] : manual.attachments;

  return (
    <PreviewCard>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="flex items-start gap-2 text-base font-semibold leading-snug" data-testid="manuals-preview-title">
              <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              {/* `overflow-wrap:anywhere`, nie `break-words`: tytuł jest elementem
                  flexa, a `break-word` nie zmienia jego rozmiaru min-content — jeden
                  długi wyraz (numer katalogowy, link) rozpychał wtedy kartę w bok. */}
              <span className="min-w-0 [overflow-wrap:anywhere]">{manual.title}</span>
            </h2>
            <p className="text-xs text-muted-foreground" title={manual.updatedAt ? fmtTimestamp(manual.updatedAt) : undefined}>
              {manual.updatedAt
                ? `Zaktualizowano ${fmtRelative(manual.updatedAt)}${manual.updatedBy ? ` · ${manual.updatedBy}` : ""}`
                : "Szczegóły manuala"}
            </p>
          </div>

          {canEdit && (
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" size="sm" variant="outline" onClick={() => onEdit(manual)} data-testid="manual-edit">
                <Pencil className="mr-1 h-4 w-4" />
                Edytuj
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => onDelete(manual)}
                title="Usuń manual"
                aria-label="Usuń manual"
                data-testid="manual-delete"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-1" data-testid="manual-view-description">
          <p className="text-xs font-medium text-muted-foreground">Opis</p>
          {/* `whitespace-pre-wrap` zachowuje łamania z formularza, ale sam nie
              dzieli długich wyrazów — bez `overflow-wrap:anywhere` wklejona
              ścieżka albo numer seryjny wychodziły poza kartę. */}
          {manual.description?.trim() ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
              {manual.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Brak opisu</p>
          )}
        </div>

        {sections.length >= TOC_MIN_SECTIONS && <TableOfContents sections={sections} />}

        {sections.length > 0 && (
          <div className="space-y-4" data-testid="manual-view-sections">
            {sections.map((s, i) => (
              <SectionView key={s.id} section={s} number={String(i + 1)} level={1} />
            ))}
          </div>
        )}

        {/* Przy manualu z punktami pusta lista „pozostałych” to normalny stan
            (wszystkie pliki siedzą w punktach) — wtedy nie ma czego pokazywać. */}
        {(sections.length === 0 || loose.length > 0) && (
          <div className="space-y-2" data-testid="manual-view-loose-files">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Paperclip className="h-3.5 w-3.5" aria-hidden />
              {sections.length > 0 ? `Pozostałe pliki (${loose.length})` : `Załączniki (${count})`}
            </p>
            <ManualAttachmentsGallery
              attachments={loose}
              emptyText={sections.length > 0 ? undefined : "Brak załączników."}
              variant="inline"
            />
          </div>
        )}

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Powiązany sprzęt i usługi</p>
          {manual.links.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="manual-view-links-empty">
              Brak powiązań.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" data-testid="manual-view-links">
              {manual.links.map((l) => (
                <li key={`${l.kind}-${l.refId}`}>
                  <ManualLinkChip kind={l.kind} name={l.name} meta={l.meta} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {manual.createdAt && (
          <p className="text-[11px] text-muted-foreground">
            Dodano {fmtTimestamp(manual.createdAt)}
            {manual.createdBy ? ` · ${manual.createdBy}` : ""}
          </p>
        )}
      </div>
    </PreviewCard>
  );
}
