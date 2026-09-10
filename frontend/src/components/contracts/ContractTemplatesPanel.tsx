/**
 * Umowy → „Wzory umów”: katalog zarejestrowanych szablonów z podglądem pliku.
 *
 * DLACZEGO OSOBNY PANEL. „Drafty umów” to konkretne dokumenty wystawione dla
 * obiektów; wzór ZDW jest tylko pierwszym z wielu (RODO, karta zgłoszenia,
 * warianty spółek grupy). Handlowiec musi widzieć, CZYM aplikacja dysponuje,
 * z czego to zrobiono i ile umów już z tego poszło — zanim wejdzie w formularz.
 *
 * Wzorów NIE dodaje się z aplikacji: nowy wzór to otagowany plik Worda plus
 * definicja pól w kodzie (templates/umowy/README.md). Panel jest więc czytelnią,
 * a nie edytorem — stąd notka nad listą i brak przycisku „Dodaj wzór”.
 *
 * PODGLĄD (prawa kolumna) startuje w trybie `tagged`, czyli z widocznymi
 * `{tagami}`: to jedyne miejsce, w którym widać, KTÓRE miejsce dokumentu
 * zostanie podmienione którym polem formularza. Przełącznik „pusty” pokazuje
 * ten sam wzór po renderze z pustymi wartościami — dokładnie to, co dostanie
 * klient, gdy nikt nic nie wpisze.
 *
 * Pliki pobieramy zwykłym `<a href>`, a nie `fetch`-em: sesja siedzi w
 * ciasteczku, więc przeglądarka poradzi sobie sama.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, FileText, Info, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { errMsg } from "@/components/interventions/helpers";
import { contractDraftsApi, type ContractDraftFieldDef, type ContractTemplate } from "@/lib/api";
import { fmtFileSize } from "@/lib/attachments";
import { cn } from "@/lib/utils";
import { ContractDraftDialog } from "./ContractDraftDialog";
import { DocxPreview } from "./DocxPreview";
import { SplitLayout } from "./SplitLayout";

/** Sekcja na pola, których wzór nie przypisał do żadnej ze swoich grup. */
const OTHER_GROUP = "Pozostałe";

/** Typ pola po ludzku — w liście pól wzoru, obok etykiety. */
const TYPE_LABELS: Record<ContractDraftFieldDef["type"], string> = {
  text: "tekst",
  textarea: "tekst wielolinijkowy",
  email: "e-mail",
  money: "kwota",
  date: "data",
  select: "wybór z listy",
};

/** „1 draft / 2 drafty / 5 draftów” — polska odmiana po liczbie. */
function draftsLabel(n: number): string {
  if (n === 1) return "1 draft";
  const last = n % 10;
  const teens = n % 100;
  const few = last >= 2 && last <= 4 && (teens < 12 || teens > 14);
  return `${n} ${few ? "drafty" : "draftów"}`;
}

/** Pola wzoru w kolejności grup — ta sama logika, co w formularzu umowy. */
function groupFields(template: ContractTemplate): { name: string; fields: ContractDraftFieldDef[] }[] {
  const buckets = new Map<string, ContractDraftFieldDef[]>(template.groups.map((g) => [g, []]));
  for (const f of template.fields) {
    const key = buckets.has(f.group) ? f.group : OTHER_GROUP;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(f);
  }
  return [...buckets.entries()]
    .filter(([, fields]) => fields.length > 0)
    .map(([name, fields]) => ({ name, fields }));
}

/** Rozwijana lista pól jednego wzoru. */
function TemplateFields({ template }: { template: ContractTemplate }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupFields(template), [template]);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="mt-3 border-t pt-2">
      <button
        type="button"
        onClick={(e) => {
          // Karta jako całość zaznacza wzór — rozwinięcie pól nie może przy
          // okazji przełączać podglądu.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        data-testid="umowy-wzory-pola-toggle"
      >
        <Chevron className="h-3.5 w-3.5" aria-hidden />
        Pola wzoru ({template.fieldCount})
      </button>

      {open && (
        <div className="mt-2 space-y-3" data-testid="umowy-wzory-pola">
          {groups.map((g) => (
            <div key={g.name}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.name}</p>
              <ul className="mt-1 space-y-1">
                {g.fields.map((f) => (
                  <li key={f.key} className="text-xs">
                    <span className="font-medium">{f.label}</span>{" "}
                    <span className="text-muted-foreground">
                      · {TYPE_LABELS[f.type]}
                      {f.required ? " · wymagane" : ""}
                      {f.readOnly ? " · nadaje serwer" : ""}
                      {f.derivedFrom ? " · wyliczane" : ""}
                    </span>
                    {f.hint && <span className="block text-muted-foreground">{f.hint}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  /** `canEdit("contracts")` — bez tego sam podgląd wzorów i pobieranie plików. */
  editable: boolean;
}

export function ContractTemplatesPanel({ editable }: Props) {
  const [params, setParams] = useSearchParams();
  const [templates, setTemplates] = useState<ContractTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Klucz wzoru, z którego zakładamy nową umowę (null = formularz zamknięty). */
  const [newFrom, setNewFrom] = useState<string | null>(null);
  /** Bump po zapisie umowy — licznik draftów w kartach jest z bazy. */
  const [reloadTick, setReloadTick] = useState(0);
  /** Zaznaczony wzór (klucz) — domyślnie pierwszy z listy. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Tryb podglądu: `tagged` pokazuje `{tagi}`, `blank` gotowy pusty dokument. */
  const [mode, setMode] = useState<"tagged" | "blank">("tagged");

  useEffect(() => {
    let cancelled = false;
    contractDraftsApi
      .templates()
      .then((res) => {
        if (cancelled) return;
        const items = res.data?.items ?? [];
        setTemplates(items);
        // Zaznaczenie trzymamy przy przeładowaniu (licznik draftów), a przy
        // pierwszym wejściu bierzemy pierwszy wzór — pusty podgląd nic nie mówi.
        setSelectedKey((prev) => (prev && items.some((t) => t.key === prev) ? prev : (items[0]?.key ?? null)));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setTemplates([]);
        setError(errMsg(e, "Nie udało się wczytać listy wzorów umów."));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  /** „Pokaż drafty” — panel draftów czyta `templateKey` z adresu jako filtr. */
  const showDrafts = (key: string) => {
    const sp = new URLSearchParams(params);
    sp.set("panel", "drafty");
    sp.set("templateKey", key);
    setParams(sp);
  };

  const selected = templates?.find((t) => t.key === selectedKey) ?? null;

  const list = (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          Nowe wzory dodaje się z pliku Word przez skrypt tagujący (
          <code className="rounded bg-muted px-1 py-0.5">templates/umowy/README.md</code>) — tu widać
          wszystkie zarejestrowane.
        </p>
      </div>

      {templates === null ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">Ładowanie…</CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="py-10 text-center text-destructive" data-testid="umowy-wzory-error">
            {error}
          </CardContent>
        </Card>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Brak zarejestrowanych wzorów umów.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {templates.map((t) => {
            const active = t.key === selectedKey;
            return (
              <Card
                key={t.key}
                onClick={() => setSelectedKey(t.key)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "cursor-pointer transition-colors",
                  active ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40"
                )}
                data-testid="umowy-wzory-karta"
              >
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{t.label}</h3>
                        <Badge variant="secondary">{t.companyName}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>

                      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs">
                        <div className="flex gap-1">
                          <dt className="text-muted-foreground">Źródło:</dt>
                          <dd>{t.sourceNote}</dd>
                        </div>
                        <div className="flex gap-1">
                          <dt className="text-muted-foreground">Nagłówek i stopka:</dt>
                          <dd>{t.companyName}</dd>
                        </div>
                        <div className="flex gap-1">
                          <dt className="text-muted-foreground">Plik:</dt>
                          <dd className="truncate">
                            {t.fileName}
                            {t.fileSize > 0 ? ` · ${fmtFileSize(t.fileSize)}` : " · brak na serwerze"}
                          </dd>
                        </div>
                        <div className="flex gap-1">
                          <dt className="text-muted-foreground">Pola do wypełnienia:</dt>
                          <dd>{t.fieldCount}</dd>
                        </div>
                        <div className="flex gap-1">
                          <dt className="text-muted-foreground">Umowy z tego wzoru:</dt>
                          <dd data-testid="umowy-wzory-licznik">{draftsLabel(t.draftCount)}</dd>
                        </div>
                      </dl>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        showDrafts(t.key);
                      }}
                      disabled={t.draftCount === 0}
                      className={cn(t.draftCount === 0 && "cursor-not-allowed")}
                      title={
                        t.draftCount === 0
                          ? "Z tego wzoru nie powstała jeszcze żadna umowa"
                          : "Pokaż drafty wystawione z tego wzoru"
                      }
                      data-testid="umowy-wzory-drafty"
                    >
                      Pokaż drafty ({t.draftCount})
                    </Button>
                    {editable && (
                      <Button
                        size="sm"
                        className="ml-auto"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNewFrom(t.key);
                        }}
                        data-testid="umowy-wzory-nowa"
                      >
                        <Plus className="mr-1 h-4 w-4" aria-hidden /> Nowa umowa z tego wzoru
                      </Button>
                    )}
                  </div>

                  <TemplateFields template={t} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );

  const preview = (
    <DocxPreview
      url={selected ? contractDraftsApi.templateFileUrl(selected.key, mode) : null}
      // We wzorze nic nie jest wypełnione, więc wszystkie pola są żółte —
      // widać z góry, o co formularz zapyta.
      previewSrc={selected ? contractDraftsApi.previewUrl(contractDraftsApi.templateFileUrl(selected.key, mode)) : null}
      fieldLegend
      version={mode}
      title={selected ? `${selected.label} — ${mode === "tagged" ? "wzór z tagami" : "pusty wzór"}` : null}
      emptyText="Wybierz wzór z listy, aby zobaczyć podgląd"
      actions={
        selected ? (
          <div className="inline-flex overflow-hidden rounded-md border" data-testid="umowy-wzory-tryb">
            {(
              [
                ["tagged", "Z tagami"],
                ["blank", "Pusty"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                title={
                  value === "tagged"
                    ? "Surowy plik z {tagami} — widać, które miejsce podmienia które pole"
                    : "Dokument po renderze z pustymi wartościami — to zobaczy klient"
                }
                className={cn(
                  "px-2.5 py-1 text-xs transition-colors",
                  mode === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null
      }
    />
  );

  return (
    <>
      <SplitLayout testid="umowy-wzory-panel" list={list} preview={preview} />

      {newFrom !== null && (
        <ContractDraftDialog
          key={newFrom}
          open
          onClose={() => setNewFrom(null)}
          draft={null}
          initialTemplateKey={newFrom}
          onSaved={() => setReloadTick((t) => t + 1)}
        />
      )}
    </>
  );
}
