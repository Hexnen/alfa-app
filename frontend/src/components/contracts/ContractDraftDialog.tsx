/**
 * Formularz draftu umowy — dwa kroki.
 *
 * Krok 1 (tylko przy nowej umowie): obiekt + szablon. Szablon jest przywiązany
 * do spółki (nagłówek i stopka w DOCX-ie są jej), więc dla obiektu innej spółki
 * backend oznacza go `available: false` i podaje powód — takiego nie da się wybrać.
 *
 * Krok 2: pola pogrupowane tak, jak czyta się umowę. Wartości przychodzą z
 * `/prefill` (kartoteka obiektu, kontrahenta, spółki i kontaktów) z podpisem
 * „źródło: …”, żeby było widać, co dopisała aplikacja, a co trzeba sprawdzić.
 * Pola `derivedFrom` (kwota → „słownie”) przeliczamy na kliencie DOPÓKI nikt ich
 * nie poprawi ręcznie — po ręcznej edycji zostają takie, jak wpisał człowiek.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowRight, Building2, ExternalLink, FileText, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AttachmentUploader, usePendingAttachments } from "@/components/AttachmentUploader";
import { ObjectPicker } from "@/components/interventions/ObjectPicker";
import { errMsg, todayIso } from "@/components/interventions/helpers";
import {
  CONTRACT_DRAFT_STATUS_LABELS,
  contractDraftsApi,
  type ContractDraft,
  type ContractDraftFieldDef,
  type ContractDraftStatus,
  type ContractTemplate,
  type InterventionPickObject,
} from "@/lib/api";
import { kwotaSlownie, parseKwota } from "@/lib/kwotaSlownie";
import { usePerms } from "@/auth/permissions";
import { cn } from "@/lib/utils";
import { draftObjectsFetcher } from "./draftsShared";

/**
 * Ostrzeżenie z `/prefill`, które da się naprawić jednym kliknięciem w Spółkach.
 * Dopasowujemy po treści zdania z backendu (src/lib/contract-templates/zdw.ts) —
 * kody błędów byłyby tu przerostem formy: to jedno zdanie i jedno przejście.
 */
const NUMBERING_CODE_WARNING = /kodu do numeracji umów/i;

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = nowa umowa. */
  draft: ContractDraft | null;
  /** Wejście z karty obiektu — obiekt jest z góry ustalony i zablokowany. */
  fixedObject?: InterventionPickObject | null;
  /** Podpowiedź z filtra listy — pole jest wypełnione, ale wolno je zmienić. */
  initialObject?: InterventionPickObject | null;
  /**
   * Wejście z panelu „Wzory umów” — wzór jest z góry zaznaczony, ale wolno go
   * zmienić. Zaznaczamy dopiero, gdy backend powie, że pasuje do spółki obiektu.
   */
  initialTemplateKey?: string | null;
  onSaved: (draft: ContractDraft) => void;
}

/** Sekcja na pola, których szablon nie przypisał do żadnej ze swoich grup. */
const OTHER_GROUP = "Pozostałe";

const STATUS_ORDER: ContractDraftStatus[] = ["draft", "sent", "signed", "rejected", "archived"];

export function ContractDraftDialog({
  open,
  onClose,
  draft,
  fixedObject,
  initialObject,
  initialTemplateKey,
  onSaved,
}: Props) {
  const isNew = !draft;

  const [object, setObject] = useState<InterventionPickObject | null>(
    draft
      ? {
          id: draft.objectId,
          name: draft.objectName,
          address: draft.objectAddress,
          city: draft.objectCity,
          contractorName: draft.contractorName,
          companyId: draft.companyId,
          companyName: draft.companyName,
        }
      : (fixedObject ?? initialObject ?? null)
  );
  const [step, setStep] = useState<"wybor" | "pola">(draft ? "pola" : "wybor");

  const [templates, setTemplates] = useState<ContractTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState<string | null>(draft?.templateKey ?? initialTemplateKey ?? null);
  const [template, setTemplate] = useState<ContractTemplate | null>(null);

  const [values, setValues] = useState<Record<string, string>>(draft ? { ...draft.fields } : {});
  const [sources, setSources] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [numberPreview, setNumberPreview] = useState<string>(draft?.contractNumber ?? "");
  const [contractDate, setContractDate] = useState<string>(draft?.contractDate ?? todayIso());
  const [status, setStatus] = useState<ContractDraftStatus>(draft?.status ?? "draft");
  const [notes, setNotes] = useState(draft?.notes ?? "");
  /** Pola poprawione ręcznie — takich nie nadpisujemy wyliczeniem. */
  const [touched, setTouched] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [loadingStep, setLoadingStep] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = usePendingAttachments({ scopeSuffix: "na umowę" });
  const objectId = object?.id ?? null;

  const navigate = useNavigate();
  const { canView } = usePerms();
  /**
   * Wyjście z formularza do miejsca, w którym uzupełnia się brakujące dane.
   * Dialog ZAMYKAMY: po powrocie i tak trzeba wczytać szablony na nowo, a
   * zostawiony pod spodem nie pozwoliłby dojść do formularza obiektu.
   */
  const goFix = useCallback(
    (to: string) => {
      onClose();
      navigate(to);
    },
    [navigate, onClose]
  );
  /** Obiekt bez spółki — żaden wzór nie pasuje, bo szablon jest przywiązany do spółki. */
  const objectWithoutCompany = isNew && object !== null && (object.companyId ?? null) === null;

  // Lista szablonów: przy nowej umowie z `objectId` (backend dopisuje
  // `available`/`warning` wg spółki obiektu), przy edycji bez — potrzebujemy
  // wyłącznie definicji pól zapisanego szablonu.
  useEffect(() => {
    if (!open) return;
    if (isNew && objectId === null) {
      setTemplates(null);
      return;
    }
    let cancelled = false;
    setTemplatesError(null);
    contractDraftsApi
      .templates(isNew && objectId !== null ? objectId : undefined)
      .then((res) => {
        if (cancelled) return;
        const items = res.data?.items ?? [];
        setTemplates(items);
        if (!isNew && draft) setTemplate(items.find((t) => t.key === draft.templateKey) ?? null);
        // Preselekcja z panelu „Wzory umów”. Robimy ją TU, a nie w stanie
        // początkowym, bo zmiana obiektu czyści wybór, a dopiero ta odpowiedź
        // mówi, czy wzór w ogóle pasuje do spółki obiektu.
        if (isNew && initialTemplateKey && items.find((t) => t.key === initialTemplateKey)?.available) {
          setTemplateKey(initialTemplateKey);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(errMsg(e, "Nie udało się wczytać listy szablonów."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, isNew, objectId, draft, initialTemplateKey]);

  /** Pola widoczne w formularzu, w kolejności grup z szablonu. */
  const groups = useMemo(() => {
    if (!template) return [] as { name: string; fields: ContractDraftFieldDef[] }[];
    const order = [...template.groups];
    const buckets = new Map<string, ContractDraftFieldDef[]>(order.map((g) => [g, []]));
    for (const f of template.fields) {
      const key = buckets.has(f.group) ? f.group : OTHER_GROUP;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(f);
    }
    return [...buckets.entries()]
      .filter(([, fields]) => fields.length > 0)
      .map(([name, fields]) => ({ name, fields }));
  }, [template]);

  /** Krok 1 → 2: prefill z CRM. */
  const goToFields = useCallback(async () => {
    if (!object || !templateKey) {
      setError("Wybierz obiekt i szablon umowy.");
      return;
    }
    setLoadingStep(true);
    setError(null);
    try {
      const res = await contractDraftsApi.prefill(object.id, templateKey);
      const data = res.data;
      if (!data) throw new Error("Backend nie zwrócił danych do formularza.");
      const next = { ...data.fields };
      // Data zawarcia mieszka w dwóch miejscach: jako pole umowy (idzie do DOCX-a)
      // i jako kolumna draftu (rok w numerze, sortowanie listy) — trzymamy je zgodne.
      if (data.template.fields.some((f) => f.key === "data_umowy") && !next.data_umowy) {
        next.data_umowy = data.contractDate;
      }
      // Numer nadaje dopiero POST; w formularzu pokazujemy podgląd z licznika.
      if (data.template.fields.some((f) => f.key === "numer")) next.numer = data.numberPreview;
      setTemplate(data.template);
      setValues(next);
      setSources(data.sources ?? {});
      setWarnings(data.warnings ?? []);
      setNumberPreview(data.numberPreview);
      setContractDate(data.contractDate);
      setTouched(new Set());
      setStep("pola");
    } catch (e) {
      setError(errMsg(e, "Nie udało się przygotować formularza umowy."));
    } finally {
      setLoadingStep(false);
    }
  }, [object, templateKey]);

  /** Zmiana pola: zapamiętujemy ręczną edycję i przeliczamy pola pochodne. */
  const setField = (field: ContractDraftFieldDef, raw: string) => {
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(field.key);
      return next;
    });
    setValues((prev) => {
      const next = { ...prev, [field.key]: raw };
      if (template) {
        for (const other of template.fields) {
          if (other.derivedFrom !== field.key) continue;
          // Ręcznie poprawione „słownie” zostaje — człowiek wie lepiej.
          if (touched.has(other.key)) continue;
          next[other.key] = field.type === "money" ? kwotaSlownie(parseKwota(raw)) : raw;
        }
      }
      return next;
    });
    if (field.key === "data_umowy" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) setContractDate(raw);
  };

  const validate = (): string | null => {
    if (!template) return "Wybierz szablon umowy.";
    if (!object) return "Wybierz obiekt.";
    for (const f of template.fields) {
      if (f.required && !f.readOnly && !(values[f.key] ?? "").trim()) {
        return `Uzupełnij pole „${f.label}”.`;
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(contractDate)) return "Podaj datę zawarcia umowy.";
    return null;
  };

  /** Załączniki wysyłamy PO zapisie — backend przyjmuje je pod istniejący draft. */
  const uploadPending = async (saved: ContractDraft): Promise<ContractDraft> => {
    if (!queue.pending.length) return saved;
    const up = await contractDraftsApi.addAttachments(
      saved.id,
      queue.pending.map((p) => p.file)
    );
    queue.clearPending();
    return up.data ?? saved;
  };

  const save = async (regenerate: boolean) => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let saved: ContractDraft;
      if (draft) {
        const res = await contractDraftsApi.update(draft.id, {
          fields: values,
          contractDate,
          status,
          notes: notes.trim() || null,
        });
        saved = res.data ?? draft;
        // PUT świadomie NIE generuje pliku (draft wraca „nieaktualny”) — DOCX
        // powstaje dopiero na wyraźne żądanie.
        if (regenerate) {
          const gen = await contractDraftsApi.generate(saved.id);
          saved = gen.data ?? saved;
        }
      } else {
        const res = await contractDraftsApi.create({
          objectId: object!.id,
          templateKey: template!.key,
          contractDate,
          fields: values,
          notes: notes.trim() || null,
          status,
        });
        if (!res.data) throw new Error("Backend nie zwrócił zapisanej umowy.");
        saved = res.data;
      }
      saved = await uploadPending(saved);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać umowy."));
    } finally {
      setBusy(false);
    }
  };

  const renderField = (f: ContractDraftFieldDef) => {
    const id = `umowy-drafty-pole-${f.key}`;
    const value = values[f.key] ?? "";
    const source = sources[f.key];
    const common = { id, value, disabled: busy || f.readOnly };
    return (
      <div key={f.key} className="space-y-1.5">
        <Label htmlFor={id} className="text-xs">
          {f.label}
          {f.required && <span className="text-destructive"> *</span>}
        </Label>
        {f.type === "select" ? (
          <Select
            value={value}
            disabled={busy || f.readOnly}
            onValueChange={(v) => setField(f, v)}
          >
            <SelectTrigger id={id} data-testid={id}>
              <SelectValue placeholder="Wybierz…" />
            </SelectTrigger>
            <SelectContent>
              {(f.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : f.type === "textarea" ? (
          <Textarea
            {...common}
            data-testid={id}
            rows={3}
            onChange={(e) => setField(f, e.target.value)}
            placeholder={f.emptyPlaceholder ?? undefined}
          />
        ) : (
          <Input
            {...common}
            data-testid={id}
            type={f.type === "date" ? "date" : f.type === "email" ? "email" : "text"}
            inputMode={f.type === "money" ? "decimal" : undefined}
            className={cn(
              (f.type === "money" || f.type === "date") && "tabular-nums",
              f.readOnly && "bg-muted/60"
            )}
            readOnly={f.readOnly}
            onChange={(e) => setField(f, e.target.value)}
            placeholder={f.emptyPlaceholder ?? undefined}
          />
        )}
        {(f.hint || source) && (
          <p className="text-[11px] leading-tight text-muted-foreground">
            {f.hint}
            {f.hint && source ? " · " : ""}
            {source && <span data-testid={`${id}-zrodlo`}>źródło: {source}</span>}
          </p>
        )}
      </div>
    );
  };

  const objectMetaLine = [object?.city, object?.contractorName, object?.companyName]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,52rem)] max-w-none flex-col gap-3 overflow-y-auto focus:outline-none"
        data-testid="umowy-drafty-dialog"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">
            {isNew ? "Nowa umowa" : `Umowa ${draft?.contractNumber ?? ""}`}
          </DialogTitle>
          <DialogDescription>
            {step === "wybor"
              ? "Wybierz obiekt i szablon — resztę aplikacja wypełni danymi z kartoteki."
              : "Sprawdź wypełnione pola. Zapis generuje dokument Worda z oryginalnego szablonu."}
          </DialogDescription>
        </DialogHeader>

        {step === "wybor" ? (
          <>
            <div className="space-y-1.5">
              <Label>Obiekt</Label>
              <ObjectPicker
                value={object}
                onChange={(next) => {
                  setObject(next);
                  setTemplateKey(null);
                }}
                disabled={!!fixedObject || busy}
                fetcher={draftObjectsFetcher}
                testid="umowy-drafty-obiekt"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Szablon umowy</Label>
              {objectId === null ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  Najpierw wybierz obiekt — lista szablonów zależy od jego spółki.
                </p>
              ) : templatesError ? (
                <p className="text-xs text-destructive">{templatesError}</p>
              ) : templates === null ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">Ładowanie szablonów…</p>
              ) : templates.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  Brak szablonów umów w rejestrze.
                </p>
              ) : (
                <ul className="space-y-2" data-testid="umowy-drafty-szablony">
                  {templates.map((t) => {
                    const selected = templateKey === t.key;
                    return (
                      <li key={t.key}>
                        <button
                          type="button"
                          disabled={!t.available || busy}
                          onClick={() => setTemplateKey(t.key)}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected ? "border-primary bg-primary/5" : "hover:bg-accent/50",
                            !t.available && "cursor-not-allowed opacity-60"
                          )}
                          data-testid="umowy-drafty-szablon"
                        >
                          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{t.label}</span>
                            <span className="block text-xs text-muted-foreground">
                              {t.description}
                              {t.companyName ? ` · spółka: ${t.companyName}` : ""}
                            </span>
                            {!t.available && t.warning && (
                              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
                                {t.warning}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/*
                Obiekt bez spółki blokuje KAŻDY wzór (nagłówek, stopka i licznik
                numerów są własnością spółki), a sama lista pokazywałaby tylko
                wyszarzone pozycje z ostrzeżeniem. Dajemy więc wprost przejście
                tam, gdzie da się to naprawić.
              */}
              {objectWithoutCompany && (
                <div
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                  data-testid="umowy-drafty-brak-spolki"
                >
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Obiekt „{object?.name}” nie ma przypisanej spółki
                  </p>
                  <p className="mt-1">
                    Każdy wzór umowy jest wystawiany przez konkretną spółkę — dopóki obiekt jej nie ma, nie da się
                    wybrać szablonu ani nadać numeru.
                  </p>
                  {canView("objects") ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => goFix(`/objects/${objectId}?edit=1`)}
                      data-testid="umowy-drafty-brak-spolki-przejdz"
                    >
                      <Building2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                      Przypisz spółkę w karcie obiektu
                    </Button>
                  ) : (
                    <p className="mt-1">
                      Nie masz dostępu do kartoteki obiektów — poproś o uzupełnienie spółki osobę, która ją prowadzi.
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Czego zabrakło w kartotece — pełne zdania od backendu. */}
            {warnings.length > 0 && (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                data-testid="umowy-drafty-ostrzezenia"
              >
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  Sprawdź przed wysłaniem umowy
                </p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {warnings.map((w) => (
                    <li key={w}>
                      {w}
                      {/* Brak kodu do numeracji zatrzyma zapis — dajemy skrót do miejsca naprawy. */}
                      {NUMBERING_CODE_WARNING.test(w) && canView("spolki") && (
                        <Button
                          type="button"
                          size="sm"
                          variant="link"
                          className="ml-1 h-auto p-0 text-xs text-amber-800 underline dark:text-amber-300"
                          onClick={() => goFix("/spolki")}
                          data-testid="umowy-drafty-brak-kodu-przejdz"
                        >
                          <ExternalLink className="mr-1 h-3 w-3" aria-hidden />
                          Przejdź do Spółek
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{object?.name ?? "—"}</span>
              {objectMetaLine && <span> · {objectMetaLine}</span>}
              {template && <span> · {template.label}</span>}
              {numberPreview && (
                <span className="block">
                  {isNew ? "Numer nadany przy zapisie: " : "Numer umowy: "}
                  <strong className="tabular-nums text-foreground">{numberPreview}</strong>
                </span>
              )}
            </div>

            {/* Przy edycji pola pojawiają się dopiero z definicją szablonu
                (osobne żądanie) — bez tego okno wyglądałoby na puste. */}
            {!template && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {templatesError ?? "Wczytywanie definicji szablonu…"}
              </p>
            )}

            {groups.map((g) => (
              <fieldset key={g.name} className="space-y-2 rounded-md border p-3">
                <legend className="px-1 text-xs font-medium text-muted-foreground">{g.name}</legend>
                <div className="grid gap-3 sm:grid-cols-2">{g.fields.map(renderField)}</div>
              </fieldset>
            ))}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="umowy-drafty-status" className="text-xs">
                  Status
                </Label>
                <Select
                  value={status}
                  disabled={busy}
                  onValueChange={(v) => setStatus(v as ContractDraftStatus)}
                >
                  <SelectTrigger id="umowy-drafty-status" data-testid="umowy-drafty-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_ORDER.map((s) => (
                      <SelectItem key={s} value={s}>
                        {CONTRACT_DRAFT_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="umowy-drafty-notatki" className="text-xs">
                  Notatki (nie trafiają do dokumentu)
                </Label>
                <Textarea
                  id="umowy-drafty-notatki"
                  rows={2}
                  value={notes}
                  disabled={busy}
                  onChange={(e) => setNotes(e.target.value)}
                  data-testid="umowy-drafty-notatki"
                />
              </div>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <AttachmentUploader
                queue={queue}
                existingCount={draft?.attachments.length ?? 0}
                disabled={busy}
                label="Załączniki (np. skan podpisanej umowy)"
                testid="umowy-drafty-dialog-att"
              />
            </div>
          </>
        )}

        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="umowy-drafty-error">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Anuluj
          </Button>
          {step === "wybor" ? (
            <Button
              type="button"
              onClick={() => void goToFields()}
              disabled={busy || loadingStep || !object || !templateKey}
              data-testid="umowy-drafty-dalej"
            >
              {loadingStep ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ArrowRight className="mr-1 h-4 w-4" aria-hidden />
              )}
              {loadingStep ? "Wczytywanie danych…" : "Dalej"}
            </Button>
          ) : (
            <>
              {isNew && !fixedObject && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep("wybor")}
                  disabled={busy}
                  data-testid="umowy-drafty-wstecz"
                >
                  <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Wstecz
                </Button>
              )}
              {!isNew && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void save(true)}
                  disabled={busy}
                  data-testid="umowy-drafty-zapisz-generuj"
                >
                  {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
                  Zapisz i generuj ponownie
                </Button>
              )}
              <Button
                type="button"
                onClick={() => void save(false)}
                disabled={busy}
                data-testid="umowy-drafty-zapisz"
              >
                {busy ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="mr-1 h-4 w-4" aria-hidden />
                )}
                {isNew ? "Zapisz i wygeneruj DOCX" : "Zapisz"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
