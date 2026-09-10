/**
 * Umowy → „Drafty umów”: rejestr wygenerowanych umów z podglądem dokumentu.
 *
 * UKŁAD. Lewa połowa to lista, prawa — podgląd DOCX-a zaznaczonego draftu
 * (SplitLayout + DocxPreview). Zaznaczenie startuje na pierwszej umowie, która
 * MA plik: pusty podgląd przy pełnej liście wyglądałby na awarię.
 *
 * Skoro tabela dostała połowę szerokości, wyleciały z niej kolumny „Spółka”
 * i „Szablon” — jedno i drugie zostało filtrem nad listą i drobnym podpisem
 * pod nazwą obiektu. Sortowanie po nich nic nie dawało (w praktyce jedna
 * spółka i jeden wzór), sortowanie po kontrahencie owszem — dlatego siedzi
 * w nagłówku kolumny „Obiekt”, obok sortowania po nazwie obiektu.
 *
 * Filtry idą do backendu (rejestr rośnie razem z liczbą obiektów), a sortowanie
 * liczymy po stronie klienta — jak w Grupach interwencyjnych: NULLS LAST w obu
 * kierunkach, `localeCompare(…, "pl")`, selecty z sentinelem `"all"` (Radix nie
 * przyjmuje pustych wartości).
 *
 * DOCX pobieramy zwykłym `<a href>`, a nie `fetch`-em: sesja siedzi w
 * ciasteczku, więc przeglądarka poradzi sobie sama i nie trzymamy blobów w pamięci.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRightToLine,
  ArrowUp,
  ChevronsUpDown,
  Download,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ObjectPicker } from "@/components/interventions/ObjectPicker";
import { DASH, errMsg } from "@/components/interventions/helpers";
import {
  CONTRACT_DRAFT_STATUS_LABELS,
  contractDraftsApi,
  type ContractDraft,
  type ContractDraftStatus,
  type ContractTemplate,
  type InterventionPickObject,
} from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { ContractDraftDialog } from "./ContractDraftDialog";
import { ContractDraftAttachments } from "./ContractDraftAttachments";
import { DocxPreview } from "./DocxPreview";
import { SplitLayout } from "./SplitLayout";
import { STATUS_VARIANT, draftObjectsFetcher } from "./draftsShared";

const THEAD = "border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground";

const STATUS_ORDER: ContractDraftStatus[] = ["draft", "sent", "signed", "rejected", "archived"];

type DraftSort = "number" | "date" | "object" | "contractor" | "status";

/** Teksty czytamy alfabetycznie, daty i numery od najnowszych. */
const DEFAULT_DIR: Record<DraftSort, "asc" | "desc"> = {
  number: "desc",
  date: "desc",
  object: "asc",
  contractor: "asc",
  status: "asc",
};

/** Puste teksty lądują na końcu w OBU kierunkach (NULLS LAST). */
const cmpText = (a: string | null | undefined, b: string | null | undefined, mul: number) => {
  const as = (a ?? "").trim();
  const bs = (b ?? "").trim();
  if (!as || !bs) {
    if (!as && !bs) return 0;
    return as ? -1 : 1;
  }
  return as.localeCompare(bs, "pl") * mul;
};

/** Stan sortowania: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
function useSortState(initial: DraftSort) {
  const [sort, setSort] = useState<DraftSort>(initial);
  const [dir, setDir] = useState<"asc" | "desc">(DEFAULT_DIR[initial]);
  const toggle = (key: DraftSort) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };
  return { sort, dir, toggle, mul: dir === "asc" ? 1 : -1 };
}

type SortState = { sort: DraftSort; dir: "asc" | "desc"; toggle: (k: DraftSort) => void };

/** Sam przycisk sortowania — używany i jako cały nagłówek, i jako dopisek w nagłówku. */
function SortButton({
  label,
  sortKey,
  state,
  className,
  title,
}: {
  label: string;
  sortKey: DraftSort;
  state: SortState;
  className?: string;
  title?: string;
}) {
  const activeCol = state.sort === sortKey;
  const Icon = !activeCol ? ChevronsUpDown : state.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      data-testid={`umowy-drafty-sort-${sortKey}`}
      onClick={() => state.toggle(sortKey)}
      aria-label={`Sortuj po: ${label}`}
      title={title}
      className={cn(
        "-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
        activeCol ? "text-foreground" : "text-muted-foreground",
        className
      )}
    >
      {label}
      <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
    </button>
  );
}

/** Klikalny nagłówek kolumny — strzałka pokazuje kolumnę i kierunek. */
function SortTh({
  label,
  sortKey,
  state,
  align = "left",
  title,
  children,
}: {
  label: string;
  sortKey: DraftSort;
  state: SortState;
  align?: "left" | "right";
  title?: string;
  /** Dodatkowe sortowanie w tej samej komórce (np. „kontrahent” pod „obiektem”). */
  children?: React.ReactNode;
}) {
  return (
    <th className={cn("px-2 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
      <SortButton label={label} sortKey={sortKey} state={state} title={title} />
      {children}
    </th>
  );
}

interface Props {
  /** `canEdit("contracts")` — bez tego sama lista i pobieranie plików. */
  editable: boolean;
  /**
   * Filtr szablonu z adresu (`?panel=drafty&templateKey=…`) — tak wchodzi
   * „Pokaż drafty” z panelu „Wzory umów”. Tylko wartość POCZĄTKOWA: dalej
   * filtrem rządzi select, więc wyczyszczenie go nie odbija się od URL-a.
   */
  initialTemplateKey?: string | null;
  /**
   * Szukajka z adresu (`?panel=drafty&q=…`) — tak wchodzi link „pokaż draft”
   * z rejestru umów (szukamy po numerze). Też tylko wartość POCZĄTKOWA.
   */
  initialSearch?: string | null;
}

export function ContractDraftsPanel({ editable, initialTemplateKey, initialSearch }: Props) {
  const [rows, setRows] = useState<ContractDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  const [object, setObject] = useState<InterventionPickObject | null>(null);
  const [companyId, setCompanyId] = useState("all");
  const [status, setStatus] = useState<"all" | ContractDraftStatus>("all");
  const [templateKey, setTemplateKey] = useState(initialTemplateKey || "all");
  const [search, setSearch] = useState(initialSearch || "");
  const sortState = useSortState("date");

  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  /**
   * Spółki do filtra bierzemy z tego, co wróciło z rejestru (kartoteka spółek
   * siedzi za innym kluczem uprawnień). Raz zobaczoną spółkę zapamiętujemy —
   * inaczej wybranie filtra skasowałoby wszystkie pozostałe opcje.
   */
  const [companyOptions, setCompanyOptions] = useState<{ id: number; name: string }[]>([]);

  const [dialog, setDialog] = useState<{ open: boolean; draft: ContractDraft | null } | null>(null);
  const [attachmentsFor, setAttachmentsFor] = useState<ContractDraft | null>(null);
  const [toDelete, setToDelete] = useState<ContractDraft | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** Zaznaczony wiersz — to jego dokument widać po prawej. */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** Komunikat po udanym „Przenieś do rejestru” (znika przy zmianie zaznaczenia). */
  const [promoted, setPromoted] = useState<{ id: number; message: string } | null>(null);

  const objectId = object?.id ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await contractDraftsApi.list({
        objectId: objectId ?? undefined,
        companyId: companyId === "all" ? undefined : Number(companyId),
        status: status === "all" ? undefined : status,
        templateKey: templateKey === "all" ? undefined : templateKey,
        q: search.trim() || undefined,
      });
      const items = res.data?.items ?? [];
      setRows(items);
      setCompanyOptions((prev) => {
        const map = new Map(prev.map((c) => [c.id, c]));
        for (const d of items) map.set(d.companyId, { id: d.companyId, name: d.companyName });
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "pl"));
      });
      setError(null);
    } catch (e) {
      setRows([]);
      setError(errMsg(e, "Nie udało się wczytać draftów umów."));
    } finally {
      setLoading(false);
    }
  }, [objectId, companyId, status, templateKey, search]);

  // Szukajkę przepuszczamy przez debounce — inaczej każda litera to osobne żądanie.
  useEffect(() => {
    const t = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  // Rejestr szablonów — do filtra (i tylko do niego; formularz pobiera własny
  // z `objectId`, bo dopiero wtedy backend wie, który szablon pasuje do spółki).
  useEffect(() => {
    let cancelled = false;
    contractDraftsApi
      .templates()
      .then((res) => {
        if (!cancelled) setTemplates(res.data?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    const { sort, mul } = sortState;
    return [...rows].sort((a, b) => {
      const primary =
        sort === "number"
          ? // Po (rok, seq), nie po napisie — inaczej „10/ZDW/2026” trafiłoby
            // przed „2/ZDW/2026”. Backend sortuje tak samo.
            (a.year - b.year || a.seq - b.seq) * mul
          : sort === "date"
            ? cmpText(a.contractDate, b.contractDate, mul)
            : sort === "object"
              ? cmpText(a.objectName, b.objectName, mul)
              : sort === "contractor"
                ? cmpText(a.contractorName, b.contractorName, mul)
                : cmpText(a.statusLabel, b.statusLabel, mul);
      return primary || b.contractDate.localeCompare(a.contractDate) || b.id - a.id;
    });
  }, [rows, sortState]);

  /**
   * Zaznaczenie pilnuje się samo: trzyma się wybranego wiersza, dopóki ten jest
   * na liście, a gdy zniknie (filtr, kasowanie) skacze na pierwszy Z PLIKIEM —
   * podgląd ma od razu coś pokazywać.
   */
  useEffect(() => {
    setSelectedId((prev) => {
      if (prev !== null && visible.some((d) => d.id === prev)) return prev;
      return (visible.find((d) => d.fileUrl) ?? visible[0])?.id ?? null;
    });
  }, [visible]);

  const selected = visible.find((d) => d.id === selectedId) ?? null;

  /** Podmienia jeden wiersz w miejscu — bez pełnego przeładowania listy. */
  const replaceRow = (next: ContractDraft) =>
    setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)));

  const changeStatus = async (draft: ContractDraft, next: ContractDraftStatus) => {
    setBusyId(draft.id);
    try {
      const res = await contractDraftsApi.update(draft.id, { status: next });
      if (res.data) replaceRow(res.data);
    } catch (e) {
      setAlertMsg(errMsg(e, "Nie udało się zmienić statusu umowy."));
    } finally {
      setBusyId(null);
    }
  };

  const regenerate = async (draft: ContractDraft) => {
    setBusyId(draft.id);
    try {
      const res = await contractDraftsApi.generate(draft.id);
      if (res.data) replaceRow(res.data);
    } catch (e) {
      setAlertMsg(errMsg(e, "Nie udało się wygenerować dokumentu."));
    } finally {
      setBusyId(null);
    }
  };

  /** „Przenieś do rejestru” — z dokumentu robi wiersz w rejestrze umów. */
  const promote = async (draft: ContractDraft) => {
    setBusyId(draft.id);
    try {
      const res = await contractDraftsApi.promote(draft.id);
      if (res.data?.draft) replaceRow(res.data.draft);
      setPromoted({
        id: draft.id,
        message: `Umowa ${draft.contractNumber} jest już w rejestrze umów.`,
      });
    } catch (e) {
      setAlertMsg(errMsg(e, "Nie udało się przenieść umowy do rejestru."));
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async () => {
    if (!toDelete) return;
    setBusyId(toDelete.id);
    try {
      await contractDraftsApi.remove(toDelete.id);
      setToDelete(null);
      await load();
    } catch (e) {
      setToDelete(null);
      setAlertMsg(errMsg(e, "Nie udało się usunąć umowy."));
    } finally {
      setBusyId(null);
    }
  };

  const filtersActive =
    objectId !== null || companyId !== "all" || status !== "all" || templateKey !== "all" || search !== "";

  const clearFilters = () => {
    setObject(null);
    setCompanyId("all");
    setStatus("all");
    setTemplateKey("all");
    setSearch("");
  };

  const header = (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[240px] max-w-sm flex-1">
        <ObjectPicker
          value={object}
          onChange={setObject}
          placeholder="Filtruj po obiekcie…"
          fetcher={draftObjectsFetcher}
          testid="umowy-drafty-filtr-obiekt"
        />
      </div>
      <Select value={companyId} onValueChange={setCompanyId}>
        <SelectTrigger className="w-[180px]" data-testid="umowy-drafty-filtr-spolka">
          <SelectValue placeholder="Spółka" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Wszystkie spółki</SelectItem>
          {companyOptions.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
        <SelectTrigger className="w-[190px]" data-testid="umowy-drafty-filtr-status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Wszystkie statusy</SelectItem>
          {STATUS_ORDER.map((s) => (
            <SelectItem key={s} value={s}>
              {CONTRACT_DRAFT_STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={templateKey} onValueChange={setTemplateKey}>
        <SelectTrigger className="w-[200px]" data-testid="umowy-drafty-filtr-szablon">
          <SelectValue placeholder="Szablon" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Wszystkie szablony</SelectItem>
          {templates.map((t) => (
            <SelectItem key={t.key} value={t.key}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative min-w-[180px] max-w-xs flex-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Szukaj numeru, obiektu, kontrahenta…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
          data-testid="umowy-drafty-szukaj"
        />
      </div>
      {filtersActive && (
        <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="umowy-drafty-wyczysc">
          <X className="mr-1 h-4 w-4" /> Wyczyść filtry
        </Button>
      )}
      {editable && (
        <Button
          className="ml-auto"
          onClick={() => setDialog({ open: true, draft: null })}
          data-testid="umowy-drafty-nowa"
        >
          <Plus className="mr-2 h-4 w-4" /> Nowa umowa
        </Button>
      )}
    </div>
  );

  const list = (
    <Card>
      <CardContent className="p-2">
        {loading ? (
          <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>
        ) : error ? (
          <div className="py-10 text-center text-destructive" data-testid="umowy-drafty-error">
            {error}
          </div>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">
            {filtersActive
              ? "Brak umów dla wybranych filtrów"
              : "Brak draftów umów. Kliknij „Nowa umowa”, żeby wygenerować pierwszą."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm" data-testid="umowy-drafty-tabela">
              {/* Stałe szerokości — patrz komentarz przy tabeli rejestru:
                  przy połowie ekranu tylko kolumna obiektu ma być „gumowa”. */}
              <colgroup>
                <col className="w-[118px]" />
                <col />
                <col className="w-[126px]" />
                <col className="w-[104px]" />
              </colgroup>
              <thead className={THEAD}>
                <tr>
                  {/* Numer i data w jednej kolumnie, obiekt i kontrahent w drugiej —
                      sortowania są nadal osobne, bo tego się od listy oczekuje. */}
                  <SortTh label="Numer" sortKey="number" state={sortState}>
                    <span className="px-1 text-muted-foreground">·</span>
                    <SortButton label="data" sortKey="date" state={sortState} className="text-[10px] normal-case" />
                  </SortTh>
                  <SortTh label="Obiekt" sortKey="object" state={sortState}>
                    <span className="px-1 text-muted-foreground">·</span>
                    <SortButton
                      label="kontrahent"
                      sortKey="contractor"
                      state={sortState}
                      className="text-[10px] normal-case"
                    />
                  </SortTh>
                  <SortTh label="Status" sortKey="status" state={sortState} />
                  <th className="px-2 py-2 text-right font-medium">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => setSelectedId(d.id)}
                    aria-selected={d.id === selectedId}
                    className={cn(
                      "cursor-pointer border-b last:border-0 hover:bg-muted/50",
                      d.id === selectedId && "bg-primary/10 hover:bg-primary/10"
                    )}
                    data-testid="umowy-drafty-wiersz"
                  >
                    <td className="px-2 py-2 align-top font-medium tabular-nums">
                      {/* Kolumna ma stałą szerokość — długi numer musi się przyciąć,
                          inaczej wyszedłby na komórkę obiektu. */}
                      <span className="block truncate" title={d.contractNumber}>
                        {d.contractNumber}
                      </span>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {formatDate(d.contractDate)}
                      </span>
                    </td>
                    {/* `w-full` + `max-w-0` to sztuczka na przycinanie w tabeli:
                        komórka bierze całą wolną szerokość, a treść nie rozpycha
                        wiersza — długie nazwy kontrahentów kończą się wielokropkiem. */}
                    <td className="px-2 py-2 align-top">
                      <Link
                        to={`/objects/${d.objectId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="block truncate text-primary hover:underline"
                        title={d.objectName}
                      >
                        {d.objectName}
                      </Link>
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={[d.objectCity, d.contractorName].filter(Boolean).join(" · ")}
                      >
                        {[d.objectCity, d.contractorName].filter(Boolean).join(" · ") || DASH}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground/80">
                        {d.companyName} · {d.templateLabel}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1">
                        {d.fileUrl ? (
                          <a
                            href={contractDraftsApi.fileUrl(d.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            title={d.generatedFileName ?? "Pobierz DOCX"}
                            data-testid="umowy-drafty-pobierz"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden />
                            DOCX
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">brak pliku</span>
                        )}
                        {d.stale && (
                          <Badge
                            variant="warning"
                            className="h-5 gap-1 px-1.5 text-[10px]"
                            title="Pola zmieniły się po ostatniej generacji — wygeneruj dokument ponownie."
                            data-testid="umowy-drafty-nieaktualny"
                          >
                            <AlertTriangle className="h-3 w-3" aria-hidden />
                            nieaktualny
                          </Badge>
                        )}
                        {d.registryContractId !== null && (
                          <Badge
                            variant="secondary"
                            className="h-5 px-1.5 text-[10px]"
                            title="Ta umowa jest już w rejestrze umów"
                            data-testid="umowy-drafty-w-rejestrze"
                          >
                            w rejestrze
                          </Badge>
                        )}
                        {d.attachments.length > 0 && (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                            title={`Załączniki: ${d.attachments.length}`}
                          >
                            <Paperclip className="h-3.5 w-3.5" aria-hidden />
                            {d.attachments.length}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-2 align-top" onClick={(e) => e.stopPropagation()}>
                      {editable ? (
                        <Select
                          value={d.status}
                          disabled={busyId === d.id}
                          onValueChange={(v) => void changeStatus(d, v as ContractDraftStatus)}
                        >
                          <SelectTrigger
                            className="h-7 w-[118px] px-2 text-xs"
                            data-testid="umowy-drafty-status"
                          >
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
                      ) : (
                        <Badge variant={STATUS_VARIANT[d.status]} className="h-5 px-1.5 text-[10px]">
                          {d.statusLabel}
                        </Badge>
                      )}
                    </td>
                    <td className="px-2 py-2 align-top" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setAttachmentsFor(d)}
                          title="Załączniki"
                          data-testid="umowy-drafty-zalaczniki"
                        >
                          <Paperclip className="h-4 w-4" />
                        </Button>
                        {editable && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setDialog({ open: true, draft: d })}
                              title="Edytuj"
                              data-testid="umowy-drafty-edytuj"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              disabled={busyId === d.id}
                              onClick={() => void regenerate(d)}
                              title="Generuj dokument ponownie"
                              data-testid="umowy-drafty-generuj"
                            >
                              {busyId === d.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setToDelete(d)}
                              title="Usuń"
                              data-testid="umowy-drafty-usun"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const preview = (
    <DocxPreview
      url={selected?.fileUrl ? contractDraftsApi.fileUrl(selected.id, true) : null}
      previewSrc={
        selected?.fileUrl ? contractDraftsApi.previewUrl(contractDraftsApi.fileUrl(selected.id, true)) : null
      }
      fieldLegend
      // Po „Generuj ponownie” pod tym samym adresem leży nowy plik — bez tego
      // podgląd pokazywałby poprzednią treść. `updatedAt` dokładamy, bo wariant
      // z kolorami serwer składa z BIEŻĄCYCH pól: po edycji formularza (jeszcze
      // przed regeneracją) podgląd ma pokazać nowe wartości.
      version={`${selected?.generatedAt ?? ""}|${selected?.updatedAt ?? ""}`}
      downloadUrl={selected?.fileUrl ? contractDraftsApi.fileUrl(selected.id) : null}
      title={selected ? `${selected.contractNumber} — ${selected.objectName}` : null}
      emptyText={
        selected
          ? "Ta umowa nie ma jeszcze wygenerowanego dokumentu."
          : "Wybierz umowę z listy, aby zobaczyć podgląd"
      }
      emptyAction={
        selected && !selected.fileUrl && editable ? (
          <Button
            size="sm"
            disabled={busyId === selected.id}
            onClick={() => void regenerate(selected)}
            data-testid="umowy-drafty-podglad-generuj"
          >
            {busyId === selected.id ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
            )}
            Generuj
          </Button>
        ) : null
      }
      actions={
        selected && editable ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busyId === selected.id || selected.registryContractId !== null}
            onClick={() => void promote(selected)}
            title={
              selected.registryContractId !== null
                ? "Ta umowa jest już w rejestrze umów"
                : "Załóż wpis w rejestrze umów na podstawie tego dokumentu"
            }
            data-testid="umowy-drafty-do-rejestru"
          >
            <ArrowRightToLine className="mr-1 h-4 w-4" aria-hidden />
            {selected.registryContractId !== null ? "W rejestrze" : "Przenieś do rejestru"}
          </Button>
        ) : null
      }
      notice={
        <>
          {selected?.stale && (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
              data-testid="umowy-drafty-podglad-nieaktualny"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Podgląd pokazuje ostatnio wygenerowany plik — pola zmieniono, wygeneruj ponownie.
              </span>
            </div>
          )}
          {promoted && selected?.id === promoted.id && (
            <div
              className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100"
              data-testid="umowy-drafty-promote-ok"
            >
              <ArrowRightToLine className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {promoted.message}{" "}
                <Link to="/contracts?panel=rejestr" className="underline">
                  Otwórz rejestr
                </Link>
              </span>
            </div>
          )}
        </>
      }
    />
  );

  return (
    <>
      <SplitLayout testid="umowy-drafty-panel" header={header} list={list} preview={preview} />

      {dialog?.open && (
        <ContractDraftDialog
          key={dialog.draft?.id ?? "new"}
          open
          onClose={() => setDialog(null)}
          draft={dialog.draft}
          initialObject={dialog.draft ? null : object}
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
          onChanged={replaceRow}
        />
      )}

      <AlertDialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent data-testid="umowy-drafty-usun-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć umowę?</AlertDialogTitle>
            <AlertDialogDescription>
              {`Draft ${toDelete?.contractNumber ?? ""} (${toDelete?.objectName ?? ""}) zniknie razem z wygenerowanym plikiem i załącznikami. Numery pozostałych umów zostają bez zmian — skasowany numer wróci do puli tylko wtedy, gdy jest ostatni w tym roku.`}
              {/* Umowa w rejestrze przeżywa skasowanie draftu (ON DELETE SET NULL),
                  ale traci dokument — o tym trzeba uprzedzić PRZED kliknięciem. */}
              {toDelete !== null && toDelete.registryContractId !== null && (
                <span
                  className="mt-2 block font-medium text-foreground"
                  data-testid="umowy-drafty-usun-ostrzezenie"
                >
                  Uwaga: ta umowa jest w rejestrze umów. Wpis w rejestrze zostanie, ale straci
                  powiązany dokument — w podglądzie nie będzie już czego pokazać.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId === toDelete?.id}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyId === toDelete?.id}
              data-testid="umowy-drafty-usun-dialog-confirm"
              onClick={(e) => {
                e.preventDefault();
                void doDelete();
              }}
            >
              {busyId === toDelete?.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Usuń
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={alertMsg !== null} onOpenChange={(o) => !o && setAlertMsg(null)}>
        <AlertDialogContent data-testid="umowy-drafty-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>Nie da się tego zrobić</AlertDialogTitle>
            <AlertDialogDescription>{alertMsg}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setAlertMsg(null)}>Rozumiem</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
