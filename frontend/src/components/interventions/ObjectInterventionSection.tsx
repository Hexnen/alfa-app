/**
 * Sekcja „Grupa interwencyjna” na karcie obiektu: warunki (historia firm) i
 * rejestr podjazdów tego obiektu.
 *
 * Dane ciągniemy OSOBNYMI zapytaniami zamiast rozszerzać payload
 * `/objects/:id` — dzięki temu zostają za własnym kluczem uprawnień
 * (`cma/grupy-interwencyjne`), a kartoteka obiektu nie wozi ich każdemu, kto
 * ma dostęp do obiektów. Kartę renderuje `pages/ObjectDetails.tsx` tylko dla
 * użytkowników z tym kluczem.
 */
import { useCallback, useEffect, useState } from "react";
import { Mail, Pencil, Plus, ShieldAlert, Siren } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartCard, EmptyState } from "@/components/analytics";
import {
  interventionsApi,
  type Intervention,
  type InterventionPickObject,
  type InterventionTerm,
} from "@/lib/api";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { InterventionDialog } from "./InterventionDialog";
import { InterventionMailDialog } from "./InterventionMailDialog";
import { InterventionTermDialog } from "./InterventionTermDialog";
import { DASH, errMsg, fmtHappenedAt, fmtHours } from "./helpers";

interface Props {
  object: InterventionPickObject;
  /** `canEdit("cma/grupy-interwencyjne")` — bez tego same tabele, bez akcji. */
  editable: boolean;
}

const money = (v: number | null | undefined) => (v == null ? DASH : formatCurrency(v));

const THEAD = "border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground";

export function ObjectInterventionSection({ object, editable }: Props) {
  const [terms, setTerms] = useState<InterventionTerm[]>([]);
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [termDialog, setTermDialog] = useState<{ open: boolean; term: InterventionTerm | null } | null>(null);
  const [mailFor, setMailFor] = useState<InterventionTerm | null>(null);
  const [interventionDialog, setInterventionDialog] = useState<{
    open: boolean;
    intervention: Intervention | null;
  } | null>(null);

  const objectId = object.id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Cała historia obiektu (bez filtra miesiąca) — kartoteka odpowiada na
      // pytanie „co się tu działo", a nie „ile było w tym miesiącu".
      const [t, i] = await Promise.all([
        interventionsApi.listObjectTerms(objectId),
        interventionsApi.listObjectInterventions(objectId),
      ]);
      setTerms(t.data?.items ?? []);
      setInterventions(i.data?.items ?? []);
      setError(null);
    } catch (e) {
      setTerms([]);
      setInterventions([]);
      setError(errMsg(e, "Nie udało się wczytać danych grupy interwencyjnej."));
    } finally {
      setLoading(false);
    }
  }, [objectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3" data-testid="object-interwencje">
      <ChartCard
        title="Grupa interwencyjna — warunki"
        description="Historia firm i stawek na tym obiekcie. Zakończenie współpracy zapisujemy datą „Do”, wiersz zostaje w kartotece."
        controls={
          editable ? (
            <Button size="sm" variant="outline" onClick={() => setTermDialog({ open: true, term: null })}>
              <Plus className="mr-1 h-4 w-4" /> Dodaj warunki
            </Button>
          ) : undefined
        }
      >
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ładowanie…</p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : terms.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="Brak warunków grupy interwencyjnej"
            description={
              editable
                ? "Dodaj wiersz warunków, żeby dało się rejestrować podjazdy i rozliczać je automatycznie."
                : "Nikt nie zapisał jeszcze, która firma i na jakich zasadach obsługuje ten obiekt."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="object-interwencje-warunki">
              <thead className={THEAD}>
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Firma</th>
                  <th className="px-2 py-2 text-left font-medium">Od</th>
                  <th className="px-2 py-2 text-left font-medium">Do</th>
                  <th className="px-2 py-2 text-right font-medium">Podjazd</th>
                  <th className="px-2 py-2 text-right font-medium">Abonament</th>
                  <th className="px-2 py-2 text-right font-medium">Darmowe</th>
                  <th className="px-2 py-2 text-right font-medium">Postój/h</th>
                  <th className="px-2 py-2 text-left font-medium">Status</th>
                  <th className="px-2 py-2 text-right font-medium">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {terms.map((t) => (
                  <tr key={t.id} className={cn("border-b last:border-0", !t.isCurrent && "opacity-70")}>
                    <td className="px-2 py-2 font-medium">{t.companyName}</td>
                    <td className="px-2 py-2 tabular-nums">{formatDate(t.startDate)}</td>
                    <td className="px-2 py-2 tabular-nums">
                      {t.endDate ? formatDate(t.endDate) : <span className="text-muted-foreground">bezterminowo</span>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(t.calloutFee)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(t.subscriptionFee)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{t.freeCallouts ?? DASH}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(t.hourlyStandbyFee)}</td>
                    <td className="px-2 py-2">
                      <Badge variant={t.isCurrent ? "success" : "secondary"} className="h-5 px-1.5 text-[10px]">
                        {t.isCurrent ? "Aktualne" : "Zakończone"}
                      </Badge>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {/* Podgląd maila to POST /mail/preview — strażnik uprawnień liczy go
                            jako zapis, więc bez prawa edycji przycisk się nie pokazuje. */}
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setMailFor(t)}
                            title="Wypowiedzenie obiektu"
                            data-testid="object-interwencje-mail"
                          >
                            <Mail className="h-4 w-4" />
                          </Button>
                        )}
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setTermDialog({ open: true, term: t })}
                            title="Edytuj"
                            data-testid="object-interwencje-warunki-edytuj"
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

      <ChartCard
        title="Grupa interwencyjna — interwencje"
        description="Wszystkie podjazdy na tym obiekcie. Rozliczenie liczone z warunków obowiązujących w dniu zdarzenia."
        controls={
          editable ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setInterventionDialog({ open: true, intervention: null })}
            >
              <Plus className="mr-1 h-4 w-4" /> Dodaj interwencję
            </Button>
          ) : undefined
        }
      >
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ładowanie…</p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : interventions.length === 0 ? (
          <EmptyState
            icon={Siren}
            title="Brak zarejestrowanych podjazdów"
            description="Interwencje dopisane w CMA → Grupy interwencyjne pojawią się tutaj."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="object-interwencje-lista">
              <thead className={THEAD}>
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Data i godzina</th>
                  <th className="px-2 py-2 text-left font-medium">Firma</th>
                  <th className="px-2 py-2 text-left font-medium">Powód</th>
                  <th className="px-2 py-2 text-left font-medium">Zgłosił</th>
                  <th className="px-2 py-2 text-right font-medium">Postój (h)</th>
                  <th className="px-2 py-2 text-right font-medium">Nr w mies.</th>
                  <th className="px-2 py-2 text-right font-medium">Podjazd</th>
                  <th className="px-2 py-2 text-right font-medium">Postój</th>
                  <th className="px-2 py-2 text-right font-medium">Razem</th>
                  <th className="px-2 py-2 text-right font-medium">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {interventions.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">{fmtHappenedAt(r.happenedAt)}</td>
                    <td className="px-2 py-2">{r.companyName}</td>
                    <td className="max-w-[16rem] px-2 py-2">
                      <span className="block truncate" title={r.reason ?? undefined}>
                        {r.reason || DASH}
                      </span>
                    </td>
                    <td className="px-2 py-2">{r.reportedBy || DASH}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtHours(r.standbyHours)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.seqInMonth}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {r.isFree ? (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                          darmowy
                        </Badge>
                      ) : (
                        money(r.calloutCost)
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(r.standbyCost)}</td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums">{money(r.totalCost)}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setInterventionDialog({ open: true, intervention: r })}
                            title="Edytuj"
                            data-testid="object-interwencje-edytuj"
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

      {termDialog?.open && (
        <InterventionTermDialog
          key={termDialog.term?.id ?? "new"}
          open
          onClose={() => setTermDialog(null)}
          term={termDialog.term}
          fixedObject={object}
          onSaved={() => void load()}
        />
      )}

      {interventionDialog?.open && (
        <InterventionDialog
          key={interventionDialog.intervention?.id ?? "new"}
          open
          onClose={() => setInterventionDialog(null)}
          intervention={interventionDialog.intervention}
          fixedObject={object}
          onSaved={() => void load()}
        />
      )}

      {mailFor && (
        <InterventionMailDialog
          key={`term-${mailFor.id}`}
          open
          onClose={() => setMailFor(null)}
          kind="termination"
          companyId={mailFor.companyId}
          companyName={mailFor.companyName}
          objectId={mailFor.objectId}
          termId={mailFor.id}
          canSend={editable}
        />
      )}
    </div>
  );
}
