/**
 * Sekcja „Umowy (drafty)” na karcie obiektu — obok Grupy interwencyjnej.
 *
 * Dane ciągniemy OSOBNYM zapytaniem zamiast rozszerzać payload `/objects/:id`:
 * zostają wtedy za własnym kluczem uprawnień (`contracts`), a kartoteka obiektu
 * nie wozi ich każdemu, kto ma dostęp do obiektów. Kartę renderuje
 * `pages/ObjectDetails.tsx` tylko dla użytkowników z tym kluczem.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, FileSignature, Paperclip, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartCard, EmptyState } from "@/components/analytics";
import { contractDraftsApi, type ContractDraft, type InterventionPickObject } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { DASH, errMsg } from "@/components/interventions/helpers";
import { ContractDraftDialog } from "./ContractDraftDialog";
import { ContractDraftAttachments } from "./ContractDraftAttachments";
import { STATUS_VARIANT } from "./draftsShared";

interface Props {
  object: InterventionPickObject;
  /** `canEdit("contracts")` — bez tego sama tabela, bez akcji. */
  editable: boolean;
}

const THEAD = "border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground";

export function ObjectContractDraftsSection({ object, editable }: Props) {
  const [rows, setRows] = useState<ContractDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; draft: ContractDraft | null } | null>(null);
  const [attachmentsFor, setAttachmentsFor] = useState<ContractDraft | null>(null);

  const objectId = object.id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await contractDraftsApi.listByObject(objectId);
      setRows(res.data?.items ?? []);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(errMsg(e, "Nie udało się wczytać umów tego obiektu."));
    } finally {
      setLoading(false);
    }
  }, [objectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3" data-testid="object-umowy-drafty">
      <ChartCard
        title="Umowy (drafty)"
        description="Umowy wygenerowane z szablonu dla tego obiektu. Plik DOCX zachowuje nagłówek i stopkę spółki."
        controls={
          editable ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog({ open: true, draft: null })}
              data-testid="object-umowy-drafty-nowa"
            >
              <Plus className="mr-1 h-4 w-4" /> Nowa umowa
            </Button>
          ) : undefined
        }
      >
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ładowanie…</p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title="Brak umów wygenerowanych dla tego obiektu"
            description={
              editable
                ? "Kliknij „Nowa umowa”, żeby wypełnić szablon danymi z kartoteki i pobrać gotowy dokument."
                : "Umowy dopisane w Umowy → Drafty umów pojawią się tutaj."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="object-umowy-drafty-tabela">
              <thead className={THEAD}>
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Numer</th>
                  <th className="px-2 py-2 text-left font-medium">Data</th>
                  <th className="px-2 py-2 text-left font-medium">Szablon</th>
                  <th className="px-2 py-2 text-left font-medium">Spółka</th>
                  <th className="px-2 py-2 text-left font-medium">Status</th>
                  <th className="px-2 py-2 text-left font-medium">Plik</th>
                  <th className="px-2 py-2 text-right font-medium">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="px-2 py-2 font-medium tabular-nums">{d.contractNumber}</td>
                    <td className="px-2 py-2 tabular-nums">{formatDate(d.contractDate)}</td>
                    <td className="px-2 py-2">{d.templateLabel}</td>
                    <td className="px-2 py-2">{d.companyName}</td>
                    <td className="px-2 py-2">
                      <Badge variant={STATUS_VARIANT[d.status]} className="h-5 px-1.5 text-[10px]">
                        {d.statusLabel}
                      </Badge>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {d.fileUrl ? (
                          <a
                            href={contractDraftsApi.fileUrl(d.id)}
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                            title={d.generatedFileName ?? "Pobierz DOCX"}
                            data-testid="object-umowy-drafty-pobierz"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden />
                            DOCX
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">{DASH}</span>
                        )}
                        {d.stale && (
                          <Badge
                            variant="warning"
                            className="h-5 gap-1 px-1.5 text-[10px]"
                            title="Pola zmieniły się po ostatniej generacji — wygeneruj dokument ponownie."
                          >
                            <AlertTriangle className="h-3 w-3" aria-hidden />
                            nieaktualny
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setAttachmentsFor(d)}
                          title="Załączniki"
                          data-testid="object-umowy-drafty-zalaczniki"
                        >
                          <Paperclip className="h-4 w-4" />
                        </Button>
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDialog({ open: true, draft: d })}
                            title="Edytuj"
                            data-testid="object-umowy-drafty-edytuj"
                          >
                            <Pencil className="h-4 w-4" />
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

      {dialog?.open && (
        <ContractDraftDialog
          key={dialog.draft?.id ?? "new"}
          open
          onClose={() => setDialog(null)}
          draft={dialog.draft}
          fixedObject={object}
          onSaved={() => void load()}
        />
      )}

      {attachmentsFor && (
        <ContractDraftAttachments
          key={`att-${attachmentsFor.id}`}
          open
          onClose={() => setAttachmentsFor(null)}
          draft={attachmentsFor}
          editable={editable}
          onChanged={(next) => setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)))}
        />
      )}
    </div>
  );
}
