import { Link } from "react-router-dom";
import { FileCheck2, FileText, Plus } from "lucide-react";
import type { TechnikJobProtocol, TechnikProtocol } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Panel } from "../ui/panel";
import { clockOf, parseStamp } from "../lib/dates";
import { STEP_LABELS, gapsOf, toForm } from "../lib/protocol";

/**
 * PROTOKÓŁ — jedna karta, trzy stany, zawsze jedno wyjście.
 *
 * Wcześniej ekran mówił tylko „Do wypełnienia”, a technik i tak musiał wejść
 * do środka, żeby zobaczyć, czego brakuje. Teraz karta od razu mówi, które
 * kroki są puste (szkic) albo kto i kiedy podpisał (dokument zamknięty).
 *
 * `detail` jest opcjonalny: ekran działa także wtedy, gdy dociągnięcie treści
 * protokołu się nie uda — zostaje numer, stan i przycisk.
 */
export function ProtokolKarta({
  jobId,
  protocol,
  detail,
  canEdit,
  busy,
  onCreate,
}: {
  jobId: number;
  protocol: TechnikJobProtocol | null;
  detail: TechnikProtocol | null;
  canEdit: boolean;
  busy: boolean;
  onCreate: () => void;
}) {
  const href = `/technik/zlecenie/${jobId}/protokol`;

  // --- Brak protokołu ------------------------------------------------
  if (!protocol) {
    return (
      <Panel icon={FileText} title="Protokół" data-testid="zlecenie-protokol">
        <p className="text-sm text-muted-foreground">
          {canEdit
            ? "Jeszcze go nie ma. Zakładasz go raz — dane klienta wypełnią się same."
            : "Protokołu jeszcze nie ma."}
        </p>
        {canEdit && (
          <Button
            variant="outline"
            className="h-11 w-full"
            disabled={busy}
            onClick={onCreate}
            data-testid="zlecenie-protokol-akcja"
          >
            <Plus className="mr-2 h-4 w-4" />
            Załóż protokół
          </Button>
        )}
      </Panel>
    );
  }

  const signed = protocol.signed || detail?.status === "final";
  // Kroki bez kompletu danych — ta sama lista braków, którą widać na pasku
  // kroków w samym protokole (jedno źródło prawdy, `lib/protocol.ts`).
  const emptySteps = detail && !signed ? stepsWithGaps(detail) : [];

  return (
    <Panel icon={FileText} title="Protokół" data-testid="zlecenie-protokol">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium tabular-nums">{protocol.number}</span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                signed
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {signed ? (
                <FileCheck2 className="h-3 w-3" aria-hidden />
              ) : (
                <FileText className="h-3 w-3" aria-hidden />
              )}
              {signed ? "Podpisany" : "Szkic"}
            </span>
          </p>
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
            {signed
              ? signedLine(detail)
              : // Bez treści protokołu (jeszcze się wczytuje albo nie doszła) nie
                // wolno napisać „wypełniony” — to obietnica, której nie sprawdziliśmy.
                !detail
                ? "Szkic do dokończenia."
                : emptySteps.length > 0
                  ? `Do uzupełnienia: ${emptySteps.join(", ")}`
                  : "Wypełniony — zostaje podpis klienta."}
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          className="h-11 shrink-0"
          data-testid="zlecenie-protokol-akcja"
        >
          <Link to={href}>{signed || !canEdit ? "Otwórz" : "Kontynuuj"}</Link>
        </Button>
      </div>
    </Panel>
  );
}

/**
 * „Podpisany 14.09 13:41, odebrał(a) Anna Lewandowska” — bez roku, bo protokół
 * podpisuje się tego samego dnia. Data idzie przez `parseStamp`, a nie przez
 * cięcie tekstu: `signedAt` to ISO w UTC i tuż po północy wycięty dzień byłby
 * wczorajszy. Forma „odebrał(a)” — imienia nie odmieniamy za klienta.
 */
function signedLine(detail: TechnikProtocol | null): string {
  const at = parseStamp(detail?.signedAt);
  if (!at) return "Podpisany przez klienta.";
  const p = (n: number) => String(n).padStart(2, "0");
  const who = detail?.signerName?.trim();
  return `Podpisany ${p(at.getDate())}.${p(at.getMonth() + 1)} ${clockOf(detail?.signedAt)}${
    who ? `, odebrał(a) ${who}` : ""
  }`;
}

/** Nazwy kroków, w których czegoś brakuje — bez powtórzeń, w kolejności kroków. */
function stepsWithGaps(detail: TechnikProtocol): string[] {
  const steps = new Set(gapsOf(toForm(detail)).map((g) => g.step));
  return [...steps].map((s) => STEP_LABELS[s]);
}
