import { useLayoutEffect, useRef, useState } from "react";
import { ClipboardList } from "lucide-react";
import type { TechnikJobDetails } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Panel, ReadRow } from "../ui/panel";
import { ChipGroup } from "../ui/chip";
import { jobTypeMeta } from "../lib/jobs";

/**
 * CO DO ZROBIENIA — jedyna karta, którą technik czyta, zanim wysiądzie z auta.
 *
 * Opis wydarzenia jest tu treścią główną (a nie jedną z sześciu sekcji), ale
 * ma twardy limit sześciu linii: elaborat z biura zepchnąłby resztę ekranu pod
 * scroll, a interesujące jest zwykle pierwsze zdanie. Reszta po „Pokaż więcej”.
 *
 * Panel technika nie ma edytora tekstu sformatowanego — opis idzie jako czysty
 * tekst z zachowanymi nowymi liniami (`whitespace-pre-wrap`), bo biuro wpisuje
 * tam listy „1. …, 2. …”.
 */
export function CoDoZrobienia({ job }: { job: TechnikJobDetails }) {
  const typeMeta = jobTypeMeta(job.type);
  // Tytuł wydarzenia trafia do karty tylko wtedy, gdy NIE jest nazwą obiektu —
  // tę technik ma już w nagłówku i drugi raz nic nie wnosi.
  const lead = job.title && job.title !== job.objectName ? job.title : null;

  return (
    <Panel icon={ClipboardList} title="Co do zrobienia" data-testid="zlecenie-opis">
      {lead && <p className="text-sm font-semibold leading-snug">{lead}</p>}
      <Opis text={job.description} />

      <dl className="space-y-1.5 border-t pt-2.5">
        <ReadRow label="Typ pracy" value={typeMeta?.label ?? job.typeLabel} />
        {job.coTechnicians.length > 0 && (
          <ReadRow
            label="Ze mną"
            value={
              <ChipGroup className="gap-1.5">
                {job.coTechnicians.map((name) => (
                  <Osoba key={name} name={name} />
                ))}
              </ChipGroup>
            }
          />
        )}
      </dl>
    </Panel>
  );
}

/** Opis z limitem sześciu linii i przyciskiem rozwinięcia, gdy faktycznie się nie mieści. */
function Opis({ text }: { text: string | null }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);

  // Przycisk pokazujemy dopiero, gdy tekst NAPRAWDĘ wystaje — „Pokaż więcej”
  // przy trzech linijkach to obietnica bez pokrycia.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    setClipped(el.scrollHeight - el.clientHeight > 2);
  }, [text, open]);

  if (!text?.trim()) {
    return <p className="text-sm text-muted-foreground">Bez opisu — szczegóły u biura.</p>;
  }

  return (
    <div>
      <p
        ref={ref}
        className={cn("whitespace-pre-wrap text-sm leading-relaxed", !open && "line-clamp-6")}
      >
        {text}
      </p>
      {(clipped || open) && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="-mx-2 mt-0.5 flex min-h-11 items-center px-2 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="zlecenie-opis-wiecej"
        >
          {open ? "Pokaż mniej" : "Pokaż więcej"}
        </button>
      )}
    </div>
  );
}

/**
 * Współtechnik jako chip z inicjałami — nazwiska ciągiem („Jan Kowalski, Piotr
 * Zieliński, …”) zlewały się w jedną linię tekstu, a inicjał w kółku czyta się
 * jednym spojrzeniem. To etykieta, nie akcja, więc `span`, a nie `Chip`.
 */
function Osoba({ name }: { name: string }) {
  return (
    <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pl-0.5 pr-2.5 text-xs font-medium">
      <span
        aria-hidden
        className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold uppercase text-primary"
      >
        {initials(name)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

/** „Jan Kowalski” → „JK”; jedno słowo → dwie pierwsze litery. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0]}${parts[parts.length - 1][0]}`;
}
