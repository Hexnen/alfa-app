/**
 * CMA → GRUPY INTERWENCYJNE (`/cma/grupy-interwencyjne`)
 *
 * Trzy panele odpowiadają po kolei na trzy pytania: „z kim pracujemy?”
 * (Firmy), „na jakich zasadach na danym obiekcie?” (Obiekty = warunki, wiele
 * wierszy = historia zmian firm) i „co się wydarzyło i ile to kosztuje?”
 * (Interwencje z rozliczeniem podjazdów).
 *
 * Konwencje list wzięte z `pages/Spolki.tsx`: filtry i sortowanie liczone po
 * stronie klienta (zbiory są małe), NULLS LAST w obu kierunkach,
 * `localeCompare(…, "pl")`, selecty z sentinelem `"all"` (Radix nie przyjmuje
 * pustych stringów). Kwoty: `null` to „nikt nie uzupełnił”, a nie 0 zł — stąd
 * kreska zamiast zera.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Loader2,
  Mail,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { InterventionCompanyDialog } from "@/components/interventions/InterventionCompanyDialog";
import { InterventionTermDialog } from "@/components/interventions/InterventionTermDialog";
import { InterventionDialog } from "@/components/interventions/InterventionDialog";
import { InterventionMailDialog } from "@/components/interventions/InterventionMailDialog";
import { ObjectPicker } from "@/components/interventions/ObjectPicker";
import { DASH, currentMonth, errMsg, fmtHappenedAt, fmtHours, pluralCallouts } from "@/components/interventions/helpers";
import { usePerms } from "@/auth/permissions";
import {
  interventionsApi,
  type Intervention,
  type InterventionCompany,
  type InterventionMailKind,
  type InterventionMailPlaceholder,
  type InterventionMailTemplate,
  type InterventionPickObject,
  type InterventionSummary,
  type InterventionTerm,
} from "@/lib/api";
import { cn, formatCurrency, formatDate } from "@/lib/utils";

const TAB_KEY = "cma/grupy-interwencyjne";

/** Kwota: brak = kreska (a nie 0 zł). */
const money = (v: number | null | undefined) => (v == null ? DASH : formatCurrency(v));

/** Puste teksty i braki lądują na końcu w OBU kierunkach (NULLS LAST). */
const cmpText = (a: string | null | undefined, b: string | null | undefined, mul: number) => {
  const as = (a ?? "").trim();
  const bs = (b ?? "").trim();
  if (!as || !bs) {
    if (!as && !bs) return 0;
    return as ? -1 : 1;
  }
  return as.localeCompare(bs, "pl") * mul;
};

const cmpNum = (a: number | null | undefined, b: number | null | undefined, mul: number) => {
  if (a == null || b == null) {
    if (a == null && b == null) return 0;
    return a == null ? 1 : -1;
  }
  return (a - b) * mul;
};

/** Stan sortowania jednej tabeli: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
function useSortState<K extends string>(initial: K, defaults: Record<K, "asc" | "desc">) {
  const [sort, setSort] = useState<K>(initial);
  const [dir, setDir] = useState<"asc" | "desc">(defaults[initial]);
  const toggle = (key: K) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(defaults[key]);
  };
  return { sort, dir, toggle, mul: dir === "asc" ? 1 : -1 };
}

/** Klikalny nagłówek kolumny — strzałka pokazuje kolumnę i kierunek. */
function SortTh<K extends string>({
  label,
  sortKey,
  state,
  align = "left",
  testidPrefix,
  title,
}: {
  label: string;
  sortKey: K;
  state: { sort: K; dir: "asc" | "desc"; toggle: (k: K) => void };
  align?: "left" | "right";
  testidPrefix: string;
  title?: string;
}) {
  const activeCol = state.sort === sortKey;
  const Icon = !activeCol ? ChevronsUpDown : state.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn("px-2 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        data-testid={`${testidPrefix}-sort-${sortKey}`}
        onClick={() => state.toggle(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        title={title}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          activeCol ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
      </button>
    </th>
  );
}

const THEAD = "border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground";

// ---------------------------------------------------------------------------
// Strona
// ---------------------------------------------------------------------------

type PanelKey = "firmy" | "obiekty" | "interwencje";
const PANELS: PanelKey[] = ["firmy", "obiekty", "interwencje"];

export function CmaInterventionGroups() {
  const { canEdit } = usePerms();
  const editable = canEdit(TAB_KEY);
  const [params, setParams] = useSearchParams();
  const panelParam = params.get("panel");
  const panel: PanelKey = PANELS.includes(panelParam as PanelKey) ? (panelParam as PanelKey) : "firmy";

  const [companies, setCompanies] = useState<InterventionCompany[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  /** Komunikat z odrzuconej akcji (409 przy usuwaniu) — pokazujemy w AlertDialogu. */
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    try {
      const res = await interventionsApi.listCompanies({ status: "all" });
      setCompanies(res.data?.items ?? []);
      setCompaniesError(null);
    } catch (e) {
      setCompanies([]);
      setCompaniesError(errMsg(e, "Nie udało się wczytać listy firm."));
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  const setPanel = (next: string) => {
    const sp = new URLSearchParams(params);
    sp.set("panel", next);
    setParams(sp, { replace: true });
  };

  return (
    <div className="space-y-3" data-testid="interwencje-page">
      {!editable && <ReadOnlyBanner />}

      <Tabs value={panel} onValueChange={setPanel}>
        <TabsList>
          <TabsTrigger value="firmy" data-testid="interwencje-tab-firmy">
            Firmy ({companies.length})
          </TabsTrigger>
          <TabsTrigger value="obiekty" data-testid="interwencje-tab-obiekty">
            Obiekty
          </TabsTrigger>
          <TabsTrigger value="interwencje" data-testid="interwencje-tab-interwencje">
            Interwencje
          </TabsTrigger>
        </TabsList>

        <TabsContent value="firmy" className="mt-4 space-y-3">
          <CompaniesPanel
            companies={companies}
            loading={companiesLoading}
            error={companiesError}
            editable={editable}
            reload={loadCompanies}
            onAlert={setAlertMsg}
          />
          <MailTemplatesCard editable={editable} />
        </TabsContent>

        <TabsContent value="obiekty" className="mt-4">
          <TermsPanel companies={companies} editable={editable} onAlert={setAlertMsg} />
        </TabsContent>

        <TabsContent value="interwencje" className="mt-4">
          <InterventionsPanel companies={companies} editable={editable} onAlert={setAlertMsg} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={alertMsg !== null} onOpenChange={(o) => !o && setAlertMsg(null)}>
        <AlertDialogContent data-testid="interwencje-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>Nie da się tego zrobić</AlertDialogTitle>
            <AlertDialogDescription>{alertMsg}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setAlertMsg(null)}>Rozumiem</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Wspólny AlertDialog potwierdzenia usunięcia. */
function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  busy,
  onConfirm,
  testid,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  busy: boolean;
  onConfirm: () => void;
  testid: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testid}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Anuluj</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            data-testid={`${testid}-confirm`}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Usuń
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Panel 1 — Firmy
// ---------------------------------------------------------------------------

type CompanySort = "name" | "area" | "contact" | "phone" | "email" | "objects" | "files" | "status";

const COMPANY_DEFAULT_DIR: Record<CompanySort, "asc" | "desc"> = {
  name: "asc",
  area: "asc",
  contact: "asc",
  phone: "asc",
  email: "asc",
  objects: "desc",
  files: "desc",
  status: "asc",
};

function CompaniesPanel({
  companies,
  loading,
  error,
  editable,
  reload,
  onAlert,
}: {
  companies: InterventionCompany[];
  loading: boolean;
  error: string | null;
  editable: boolean;
  reload: () => Promise<void>;
  onAlert: (msg: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "archived">("active");
  const sortState = useSortState<CompanySort>("name", COMPANY_DEFAULT_DIR);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InterventionCompany | null>(null);
  const [mailFor, setMailFor] = useState<InterventionCompany | null>(null);
  const [toDelete, setToDelete] = useState<InterventionCompany | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = companies.filter((c) => {
      if (status === "active" && !c.active) return false;
      if (status === "archived" && c.active) return false;
      if (
        q &&
        ![c.name, c.area, c.contactPerson, c.phone, c.email, c.notes]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      ) {
        return false;
      }
      return true;
    });
    const { sort, mul } = sortState;
    return [...list].sort((a, b) => {
      const primary =
        sort === "objects"
          ? cmpNum(a.objectsCount, b.objectsCount, mul)
          : sort === "files"
            ? cmpNum(a.attachments.length, b.attachments.length, mul)
            : sort === "status"
              ? cmpNum(a.active ? 0 : 1, b.active ? 0 : 1, mul)
              : cmpText(
                  sort === "name"
                    ? a.name
                    : sort === "area"
                      ? a.area
                      : sort === "contact"
                        ? a.contactPerson
                        : sort === "phone"
                          ? a.phone
                          : a.email,
                  sort === "name"
                    ? b.name
                    : sort === "area"
                      ? b.area
                      : sort === "contact"
                        ? b.contactPerson
                        : sort === "phone"
                          ? b.phone
                          : b.email,
                  mul
                );
      return primary || a.name.localeCompare(b.name, "pl");
    });
  }, [companies, search, status, sortState]);

  const toggleArchive = async (c: InterventionCompany) => {
    setBusyId(c.id);
    try {
      await interventionsApi.updateCompany(c.id, { active: !c.active });
      await reload();
    } catch (e) {
      onAlert(errMsg(e, "Nie udało się zmienić statusu firmy."));
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async () => {
    if (!toDelete) return;
    setBusyId(toDelete.id);
    try {
      await interventionsApi.deleteCompany(toDelete.id);
      setToDelete(null);
      await reload();
    } catch (e) {
      setToDelete(null);
      onAlert(errMsg(e, "Nie udało się usunąć firmy."));
    } finally {
      setBusyId(null);
    }
  };

  const filtersActive = search !== "" || status !== "active";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Szukaj firmy, obszaru, osoby…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="interwencje-firmy-szukaj"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-[200px]" data-testid="interwencje-firmy-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Tylko aktywne</SelectItem>
            <SelectItem value="archived">Tylko archiwalne</SelectItem>
            <SelectItem value="all">Wszystkie firmy</SelectItem>
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatus("active");
            }}
            data-testid="interwencje-firmy-wyczysc"
          >
            <X className="mr-1 h-4 w-4" /> Wyczyść filtry
          </Button>
        )}
        {editable && (
          <Button
            className="ml-auto"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
            data-testid="interwencje-firmy-dodaj"
          >
            <Plus className="mr-2 h-4 w-4" /> Nowa firma
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-2">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>
          ) : error ? (
            <div className="py-10 text-center text-destructive" data-testid="interwencje-firmy-error">
              {error}
            </div>
          ) : visible.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {filtersActive
                ? "Brak firm dla wybranych filtrów"
                : "Brak firm. Kliknij „Nowa firma”, aby dodać pierwszą."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="interwencje-firmy-tabela">
                <thead className={THEAD}>
                  <tr>
                    <SortTh label="Nazwa" sortKey="name" state={sortState} testidPrefix="interwencje-firmy" />
                    <SortTh label="Obszar" sortKey="area" state={sortState} testidPrefix="interwencje-firmy" />
                    <SortTh label="Osoba" sortKey="contact" state={sortState} testidPrefix="interwencje-firmy" />
                    <SortTh label="Telefon" sortKey="phone" state={sortState} testidPrefix="interwencje-firmy" />
                    <SortTh label="E-mail" sortKey="email" state={sortState} testidPrefix="interwencje-firmy" />
                    <SortTh
                      label="Obiekty"
                      sortKey="objects"
                      state={sortState}
                      align="right"
                      testidPrefix="interwencje-firmy"
                      title="Obiekty z warunkami tej firmy (w nawiasie obowiązujące dziś)"
                    />
                    <SortTh
                      label="Umowy"
                      sortKey="files"
                      state={sortState}
                      align="right"
                      testidPrefix="interwencje-firmy"
                      title="Umowy ramowe w załącznikach firmy"
                    />
                    <SortTh label="Status" sortKey="status" state={sortState} testidPrefix="interwencje-firmy" />
                    <th className="px-2 py-2 text-right font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-muted/50" data-testid="interwencje-firmy-wiersz">
                      <td className="px-2 py-2 font-medium">
                        {c.name}
                        {c.notes && <span className="block text-xs text-muted-foreground">{c.notes}</span>}
                      </td>
                      <td className="px-2 py-2">{c.area || DASH}</td>
                      <td className="px-2 py-2">{c.contactPerson || DASH}</td>
                      <td className="px-2 py-2 tabular-nums">{c.phone || DASH}</td>
                      <td className="px-2 py-2">
                        {c.email ? (
                          <a href={`mailto:${c.email}`} className="text-primary hover:underline">
                            {c.email}
                          </a>
                        ) : (
                          DASH
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {c.objectsCount}
                        {c.activeTermsCount !== c.objectsCount && (
                          <span className="text-muted-foreground"> ({c.activeTermsCount})</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {c.attachments.length > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                            {c.attachments.length}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <Badge variant={c.active ? "success" : "secondary"} className="h-5 px-1.5 text-[10px]">
                          {c.active ? "aktywna" : "archiwalna"}
                        </Badge>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {/* Podgląd maila idzie POST-em (/mail/preview), więc strażnik
                              uprawnień traktuje go jak zapis — w trybie tylko do odczytu
                              przycisk musi zniknąć, zamiast kończyć się 403. */}
                          {editable && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setMailFor(c)}
                              title="Zapytanie o ofertę"
                              data-testid="interwencje-firmy-mail"
                            >
                              <Mail className="h-4 w-4" />
                            </Button>
                          )}
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  setEditing(c);
                                  setDialogOpen(true);
                                }}
                                title="Edytuj"
                                data-testid="interwencje-firmy-edytuj"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={busyId === c.id}
                                onClick={() => void toggleArchive(c)}
                                title={c.active ? "Przenieś do archiwum" : "Przywróć"}
                                data-testid="interwencje-firmy-archiwum"
                              >
                                {c.active ? <Archive className="h-4 w-4" /> : <ArchiveRestore className="h-4 w-4" />}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setToDelete(c)}
                                title="Usuń"
                                data-testid="interwencje-firmy-usun"
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

      {dialogOpen && (
        <InterventionCompanyDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          company={editing}
          onSaved={() => void reload()}
        />
      )}

      {mailFor && (
        <InterventionMailDialog
          key={`rfq-${mailFor.id}`}
          open
          onClose={() => setMailFor(null)}
          kind="rfq"
          companyId={mailFor.id}
          companyName={mailFor.name}
          canSend={editable}
        />
      )}

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Usunąć firmę?"
        description={`Firma „${toDelete?.name ?? ""}” zniknie razem z umowami ramowymi. Jeśli ma przypisane warunki na obiektach, backend odmówi — wtedy zarchiwizuj ją zamiast usuwać.`}
        busy={busyId === toDelete?.id}
        onConfirm={() => void doDelete()}
        testid="interwencje-firmy-usun-dialog"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Karta „Szablony wiadomości”
// ---------------------------------------------------------------------------

function MailTemplatesCard({ editable }: { editable: boolean }) {
  const [items, setItems] = useState<InterventionMailTemplate[]>([]);
  const [placeholders, setPlaceholders] = useState<InterventionMailPlaceholder[]>([]);
  const [kind, setKind] = useState<InterventionMailKind>("rfq");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const current = items.find((t) => t.kind === kind) ?? null;

  const applyTemplate = useCallback((t: InterventionMailTemplate | null) => {
    setSubject(t?.subject ?? "");
    setBody(t?.body ?? "");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await interventionsApi.mailTemplates();
      const list = res.data?.items ?? [];
      setItems(list);
      setPlaceholders(res.data?.placeholders ?? []);
      setError(null);
      return list;
    } catch (e) {
      setItems([]);
      setError(errMsg(e, "Nie udało się wczytać szablonów."));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((list) => {
      if (!cancelled) applyTemplate(list.find((t) => t.kind === "rfq") ?? list[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [load, applyTemplate]);

  const switchKind = (next: InterventionMailKind) => {
    setKind(next);
    setSaved(false);
    applyTemplate(items.find((t) => t.kind === next) ?? null);
  };

  /** Placeholder wstawiamy w miejsce kursora — dopisywanie na koniec byłoby bez sensu. */
  const insertToken = (token: string) => {
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => `${b}${token}`);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    if (!subject.trim()) {
      setError("Temat nie może być pusty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await interventionsApi.saveMailTemplate(kind, { subject: subject.trim(), body });
      const list = await load();
      applyTemplate(list.find((t) => t.kind === kind) ?? null);
      setSaved(true);
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać szablonu."));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await interventionsApi.resetMailTemplate(kind);
      const list = await load();
      applyTemplate(list.find((t) => t.kind === kind) ?? null);
      setSaved(false);
    } catch (e) {
      setError(errMsg(e, "Nie udało się przywrócić domyślnej treści."));
    } finally {
      setBusy(false);
      setResetOpen(false);
    }
  };

  const visiblePlaceholders = placeholders.filter((p) => p.kinds.includes(kind));

  return (
    <Card data-testid="interwencje-szablony">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Szablony wiadomości</h2>
            <p className="text-xs text-muted-foreground">
              Treść, z której składany jest mail do firmy. Placeholdery podstawia backend przy podglądzie.
            </p>
          </div>
          {current && (
            <Badge variant={current.isDefault ? "secondary" : "info"} className="h-5 px-1.5 text-[10px]">
              {current.isDefault ? "treść domyślna" : "treść własna"}
            </Badge>
          )}
        </div>

        <Tabs value={kind} onValueChange={(v) => switchKind(v as InterventionMailKind)}>
          <TabsList>
            <TabsTrigger value="rfq" data-testid="interwencje-szablony-rfq">
              Zapytanie o ofertę
            </TabsTrigger>
            <TabsTrigger value="termination" data-testid="interwencje-szablony-termination">
              Wypowiedzenie
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {loading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Ładowanie…</div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="interwencje-szablon-temat">Temat</Label>
              <Input
                id="interwencje-szablon-temat"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setSaved(false);
                }}
                disabled={!editable || busy}
                data-testid="interwencje-szablon-temat"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="interwencje-szablon-tresc">Treść</Label>
              <Textarea
                id="interwencje-szablon-tresc"
                ref={bodyRef}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setSaved(false);
                }}
                rows={12}
                disabled={!editable || busy}
                className="font-mono text-xs"
                data-testid="interwencje-szablon-tresc"
              />
            </div>

            {visiblePlaceholders.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Placeholdery:</span>
                {visiblePlaceholders.map((p) => (
                  <button
                    key={p.token}
                    type="button"
                    disabled={!editable || busy}
                    onClick={() => insertToken(p.token)}
                    title={`${p.label} — kliknij, żeby wstawić w treść`}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    data-testid="interwencje-szablon-placeholder"
                  >
                    <Badge variant="outline" className="cursor-pointer font-mono text-[10px] hover:bg-accent">
                      {p.token}
                    </Badge>
                  </button>
                ))}
              </div>
            )}

            {error && (
              <p className="text-xs text-destructive" role="alert" data-testid="interwencje-szablon-error">
                {error}
              </p>
            )}

            {editable && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {saved && <span className="text-xs text-green-600">Zapisano ✓</span>}
                <Button
                  variant="outline"
                  disabled={busy || current?.isDefault}
                  onClick={() => setResetOpen(true)}
                  data-testid="interwencje-szablon-przywroc"
                >
                  <RotateCcw className="mr-1 h-4 w-4" /> Przywróć domyślny
                </Button>
                <Button disabled={busy} onClick={() => void save()} data-testid="interwencje-szablon-zapisz">
                  {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                  Zapisz
                </Button>
              </div>
            )}
          </>
        )}

        <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
          <AlertDialogContent data-testid="interwencje-szablon-przywroc-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Przywrócić domyślną treść?</AlertDialogTitle>
              <AlertDialogDescription>
                Zapisana treść tego szablonu zostanie skasowana, a mail wróci do wersji wbudowanej w aplikację.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Anuluj</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                data-testid="interwencje-szablon-przywroc-confirm"
                onClick={(e) => {
                  e.preventDefault();
                  void restore();
                }}
              >
                Przywróć
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel 2 — Obiekty (warunki)
// ---------------------------------------------------------------------------

type TermSort = "object" | "company" | "start" | "end" | "callout" | "subscription" | "free" | "standby" | "status";

const TERM_DEFAULT_DIR: Record<TermSort, "asc" | "desc"> = {
  object: "asc",
  company: "asc",
  start: "desc",
  end: "desc",
  callout: "desc",
  subscription: "desc",
  free: "desc",
  standby: "desc",
  status: "asc",
};

function TermsPanel({
  companies,
  editable,
  onAlert,
}: {
  companies: InterventionCompany[];
  editable: boolean;
  onAlert: (msg: string) => void;
}) {
  const [rows, setRows] = useState<InterventionTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string>("all");
  const [status, setStatus] = useState<"all" | "current" | "ended">("all");
  const [search, setSearch] = useState("");
  const sortState = useSortState<TermSort>("object", TERM_DEFAULT_DIR);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InterventionTerm | null>(null);
  const [mailFor, setMailFor] = useState<InterventionTerm | null>(null);
  const [toDelete, setToDelete] = useState<InterventionTerm | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await interventionsApi.listTerms({
        companyId: companyId === "all" ? undefined : Number(companyId),
        status,
        q: search.trim() || undefined,
      });
      setRows(res.data?.items ?? []);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(errMsg(e, "Nie udało się wczytać warunków."));
    } finally {
      setLoading(false);
    }
  }, [companyId, status, search]);

  // Filtry idą do backendu (zbiór potrafi być duży), więc szukajkę przepuszczamy
  // przez debounce — inaczej każda litera to osobne żądanie.
  useEffect(() => {
    const t = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  const visible = useMemo(() => {
    const { sort, mul } = sortState;
    return [...rows].sort((a, b) => {
      const primary =
        sort === "object"
          ? cmpText(a.objectName, b.objectName, mul)
          : sort === "company"
            ? cmpText(a.companyName, b.companyName, mul)
            : sort === "start"
              ? cmpText(a.startDate, b.startDate, mul)
              : sort === "end"
                ? cmpText(a.endDate, b.endDate, mul)
                : sort === "callout"
                  ? cmpNum(a.calloutFee, b.calloutFee, mul)
                  : sort === "subscription"
                    ? cmpNum(a.subscriptionFee, b.subscriptionFee, mul)
                    : sort === "free"
                      ? cmpNum(a.freeCallouts, b.freeCallouts, mul)
                      : sort === "standby"
                        ? cmpNum(a.hourlyStandbyFee, b.hourlyStandbyFee, mul)
                        : cmpNum(a.isCurrent ? 0 : 1, b.isCurrent ? 0 : 1, mul);
      return (
        primary ||
        a.objectName.localeCompare(b.objectName, "pl") ||
        b.startDate.localeCompare(a.startDate)
      );
    });
  }, [rows, sortState]);

  const doDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await interventionsApi.deleteTerm(toDelete.id);
      setToDelete(null);
      await load();
    } catch (e) {
      setToDelete(null);
      onAlert(errMsg(e, "Nie udało się usunąć warunków."));
    } finally {
      setBusy(false);
    }
  };

  const filtersActive = companyId !== "all" || status !== "all" || search !== "";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Szukaj obiektu, kontrahenta, firmy…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="interwencje-warunki-szukaj"
          />
        </div>
        <Select value={companyId} onValueChange={setCompanyId}>
          <SelectTrigger className="w-[220px]" data-testid="interwencje-warunki-filtr-firma">
            <SelectValue placeholder="Firma" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie firmy</SelectItem>
            {companies.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-[180px]" data-testid="interwencje-warunki-filtr-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie okresy</SelectItem>
            <SelectItem value="current">Aktualne</SelectItem>
            <SelectItem value="ended">Zakończone</SelectItem>
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setCompanyId("all");
              setStatus("all");
            }}
            data-testid="interwencje-warunki-wyczysc"
          >
            <X className="mr-1 h-4 w-4" /> Wyczyść filtry
          </Button>
        )}
        {editable && (
          <Button
            className="ml-auto"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
            data-testid="interwencje-warunki-dodaj"
          >
            <Plus className="mr-2 h-4 w-4" /> Dodaj warunki
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-2">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>
          ) : error ? (
            <div className="py-10 text-center text-destructive" data-testid="interwencje-warunki-error">
              {error}
            </div>
          ) : visible.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {filtersActive
                ? "Brak warunków dla wybranych filtrów"
                : "Brak warunków. Kliknij „Dodaj warunki”, żeby opisać pierwszy obiekt."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="interwencje-warunki-tabela">
                <thead className={THEAD}>
                  <tr>
                    <SortTh label="Obiekt" sortKey="object" state={sortState} testidPrefix="interwencje-warunki" />
                    <SortTh label="Firma" sortKey="company" state={sortState} testidPrefix="interwencje-warunki" />
                    <SortTh label="Od" sortKey="start" state={sortState} testidPrefix="interwencje-warunki" />
                    <SortTh label="Do" sortKey="end" state={sortState} testidPrefix="interwencje-warunki" />
                    <SortTh label="Podjazd" sortKey="callout" state={sortState} align="right" testidPrefix="interwencje-warunki" />
                    <SortTh label="Abonament" sortKey="subscription" state={sortState} align="right" testidPrefix="interwencje-warunki" />
                    <SortTh label="Darmowe" sortKey="free" state={sortState} align="right" testidPrefix="interwencje-warunki" />
                    <SortTh label="Postój/h" sortKey="standby" state={sortState} align="right" testidPrefix="interwencje-warunki" />
                    <th className="px-2 py-2 text-right font-medium">Umowa</th>
                    <SortTh label="Status" sortKey="status" state={sortState} testidPrefix="interwencje-warunki" />
                    <th className="px-2 py-2 text-right font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t, i) => {
                    // Kolejne wiersze tego samego obiektu (historia firm) czyta
                    // się jak grupa — nazwę powtarzamy tylko w pierwszym.
                    const sameAsPrev = i > 0 && visible[i - 1].objectId === t.objectId;
                    return (
                      <tr
                        key={t.id}
                        className={cn("border-b last:border-0 hover:bg-muted/50", !t.isCurrent && "opacity-70")}
                        data-testid="interwencje-warunki-wiersz"
                      >
                        <td className="px-2 py-2">
                          {sameAsPrev ? (
                            <span className="text-muted-foreground">↳</span>
                          ) : (
                            <>
                              <Link to={`/objects/${t.objectId}`} className="font-medium text-primary hover:underline">
                                {t.objectName}
                              </Link>
                              <span className="block text-xs text-muted-foreground">
                                {[t.objectCity, t.contractorName].filter(Boolean).join(" · ") || DASH}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="px-2 py-2">{t.companyName}</td>
                        <td className="px-2 py-2 tabular-nums">{formatDate(t.startDate)}</td>
                        <td className="px-2 py-2 tabular-nums">
                          {t.endDate ? formatDate(t.endDate) : <span className="text-muted-foreground">bezterminowo</span>}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{money(t.calloutFee)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{money(t.subscriptionFee)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{t.freeCallouts ?? DASH}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{money(t.hourlyStandbyFee)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {t.attachments.length > 0 ? (
                            <span className="inline-flex items-center gap-1">
                              <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                              {t.attachments.length}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant={t.isCurrent ? "success" : "secondary"} className="h-5 px-1.5 text-[10px]">
                            {t.isCurrent ? "Aktualne" : "Zakończone"}
                          </Badge>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-end gap-1">
                            {/* Jak przy firmach: podgląd to POST, więc tylko dla edytujących. */}
                            {editable && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setMailFor(t)}
                                title="Wypowiedzenie obiektu"
                                data-testid="interwencje-warunki-mail"
                              >
                                <Mail className="h-4 w-4" />
                              </Button>
                            )}
                            {editable && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => {
                                    setEditing(t);
                                    setDialogOpen(true);
                                  }}
                                  title="Edytuj"
                                  data-testid="interwencje-warunki-edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setToDelete(t)}
                                  title="Usuń"
                                  data-testid="interwencje-warunki-usun"
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {dialogOpen && (
        <InterventionTermDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          term={editing}
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

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Usunąć warunki?"
        description={`Wiersz warunków obiektu „${toDelete?.objectName ?? ""}” zniknie razem z umową na obiekt. Jeśli ma zarejestrowane interwencje, backend odmówi — wtedy wpisz datę zakończenia zamiast kasować.`}
        busy={busy}
        onConfirm={() => void doDelete()}
        testid="interwencje-warunki-usun-dialog"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 3 — Interwencje
// ---------------------------------------------------------------------------

type InterventionSort = "when" | "object" | "company" | "reason" | "reportedBy" | "standby" | "seq" | "callout" | "standbyCost" | "total";

const INTERVENTION_DEFAULT_DIR: Record<InterventionSort, "asc" | "desc"> = {
  when: "desc",
  object: "asc",
  company: "asc",
  reason: "asc",
  reportedBy: "asc",
  standby: "desc",
  seq: "asc",
  callout: "desc",
  standbyCost: "desc",
  total: "desc",
};

const EMPTY_SUMMARY: InterventionSummary = {
  count: 0,
  freeCount: 0,
  calloutCost: 0,
  standbyCost: 0,
  totalCost: 0,
};

function InterventionsPanel({
  companies,
  editable,
  onAlert,
}: {
  companies: InterventionCompany[];
  editable: boolean;
  onAlert: (msg: string) => void;
}) {
  const [rows, setRows] = useState<Intervention[]>([]);
  const [summary, setSummary] = useState<InterventionSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [object, setObject] = useState<InterventionPickObject | null>(null);
  const [companyId, setCompanyId] = useState<string>("all");
  // Domyślnie bieżący miesiąc — inaczej pierwsze wejście ciągnęłoby całą historię.
  const [month, setMonth] = useState<string>(currentMonth());
  const [search, setSearch] = useState("");
  const sortState = useSortState<InterventionSort>("when", INTERVENTION_DEFAULT_DIR);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Intervention | null>(null);
  const [toDelete, setToDelete] = useState<Intervention | null>(null);
  const [busy, setBusy] = useState(false);

  const objectId = object?.id ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await interventionsApi.listInterventions({
        objectId: objectId ?? undefined,
        companyId: companyId === "all" ? undefined : Number(companyId),
        month: month || undefined,
        q: search.trim() || undefined,
      });
      setRows(res.data?.items ?? []);
      setSummary(res.data?.summary ?? EMPTY_SUMMARY);
      setError(null);
    } catch (e) {
      setRows([]);
      setSummary(EMPTY_SUMMARY);
      setError(errMsg(e, "Nie udało się wczytać interwencji."));
    } finally {
      setLoading(false);
    }
  }, [objectId, companyId, month, search]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  const visible = useMemo(() => {
    const { sort, mul } = sortState;
    return [...rows].sort((a, b) => {
      const primary =
        sort === "when"
          ? cmpText(a.happenedAt, b.happenedAt, mul)
          : sort === "object"
            ? cmpText(a.objectName, b.objectName, mul)
            : sort === "company"
              ? cmpText(a.companyName, b.companyName, mul)
              : sort === "reason"
                ? cmpText(a.reason, b.reason, mul)
                : sort === "reportedBy"
                  ? cmpText(a.reportedBy, b.reportedBy, mul)
                  : sort === "standby"
                    ? cmpNum(a.standbyHours, b.standbyHours, mul)
                    : sort === "seq"
                      ? cmpNum(a.seqInMonth, b.seqInMonth, mul)
                      : sort === "callout"
                        ? cmpNum(a.calloutCost, b.calloutCost, mul)
                        : sort === "standbyCost"
                          ? cmpNum(a.standbyCost, b.standbyCost, mul)
                          : cmpNum(a.totalCost, b.totalCost, mul);
      return primary || b.happenedAt.localeCompare(a.happenedAt) || a.id - b.id;
    });
  }, [rows, sortState]);

  const doDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await interventionsApi.deleteIntervention(toDelete.id);
      setToDelete(null);
      await load();
    } catch (e) {
      setToDelete(null);
      onAlert(errMsg(e, "Nie udało się usunąć interwencji."));
    } finally {
      setBusy(false);
    }
  };

  const filtersActive = objectId !== null || companyId !== "all" || search !== "" || month !== currentMonth();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[240px] max-w-sm flex-1">
          <ObjectPicker
            value={object}
            onChange={setObject}
            placeholder="Filtruj po obiekcie…"
            testid="interwencje-podjazdy-obiekt"
          />
        </div>
        <Select value={companyId} onValueChange={setCompanyId}>
          <SelectTrigger className="w-[220px]" data-testid="interwencje-podjazdy-filtr-firma">
            <SelectValue placeholder="Firma" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie firmy</SelectItem>
            {companies.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="w-[170px] tabular-nums"
          data-testid="interwencje-podjazdy-miesiac"
        />
        <div className="relative min-w-[180px] max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Szukaj powodu, zgłaszającego…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="interwencje-podjazdy-szukaj"
          />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setObject(null);
              setCompanyId("all");
              setMonth(currentMonth());
              setSearch("");
            }}
            data-testid="interwencje-podjazdy-wyczysc"
          >
            <X className="mr-1 h-4 w-4" /> Wyczyść filtry
          </Button>
        )}
        {editable && (
          <Button
            className="ml-auto"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
            data-testid="interwencje-podjazdy-dodaj"
          >
            <Plus className="mr-2 h-4 w-4" /> Dodaj interwencję
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-2">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>
          ) : error ? (
            <div className="py-10 text-center text-destructive" data-testid="interwencje-podjazdy-error">
              {error}
            </div>
          ) : visible.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              Brak interwencji w wybranym zakresie.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="interwencje-podjazdy-tabela">
                <thead className={THEAD}>
                  <tr>
                    <SortTh label="Data i godzina" sortKey="when" state={sortState} testidPrefix="interwencje-podjazdy" />
                    <SortTh label="Obiekt" sortKey="object" state={sortState} testidPrefix="interwencje-podjazdy" />
                    <SortTh label="Firma" sortKey="company" state={sortState} testidPrefix="interwencje-podjazdy" />
                    <SortTh label="Powód" sortKey="reason" state={sortState} testidPrefix="interwencje-podjazdy" />
                    <SortTh label="Zgłosił" sortKey="reportedBy" state={sortState} testidPrefix="interwencje-podjazdy" />
                    <SortTh label="Postój (h)" sortKey="standby" state={sortState} align="right" testidPrefix="interwencje-podjazdy" />
                    <SortTh
                      label="Nr w mies."
                      sortKey="seq"
                      state={sortState}
                      align="right"
                      testidPrefix="interwencje-podjazdy"
                      title="Numer podjazdu w miesiącu — decyduje o tym, czy mieści się w puli darmowych"
                    />
                    <SortTh label="Podjazd" sortKey="callout" state={sortState} align="right" testidPrefix="interwencje-podjazdy" />
                    <SortTh label="Postój" sortKey="standbyCost" state={sortState} align="right" testidPrefix="interwencje-podjazdy" />
                    <SortTh label="Razem" sortKey="total" state={sortState} align="right" testidPrefix="interwencje-podjazdy" />
                    <th className="px-2 py-2 text-right font-medium">Załączniki</th>
                    <th className="px-2 py-2 text-right font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/50" data-testid="interwencje-podjazdy-wiersz">
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{fmtHappenedAt(r.happenedAt)}</td>
                      <td className="px-2 py-2">
                        <Link to={`/objects/${r.objectId}`} className="text-primary hover:underline">
                          {r.objectName}
                        </Link>
                        {r.objectCity && <span className="block text-xs text-muted-foreground">{r.objectCity}</span>}
                      </td>
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
                      <td className="px-2 py-2 text-right tabular-nums">
                        {r.attachments.length > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                            {r.attachments.length}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  setEditing(r);
                                  setDialogOpen(true);
                                }}
                                title="Edytuj"
                                data-testid="interwencje-podjazdy-edytuj"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setToDelete(r)}
                                title="Usuń"
                                data-testid="interwencje-podjazdy-usun"
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
                <tfoot data-testid="interwencje-podjazdy-suma">
                  <tr className="border-t">
                    <td className="px-2 py-2 font-medium" colSpan={6}>
                      Razem {summary.count} {pluralCallouts(summary.count)}
                      {summary.freeCount > 0 && (
                        <span className="text-muted-foreground"> · darmowych {summary.freeCount}</span>
                      )}
                    </td>
                    <td />
                    <td className="px-2 py-2 text-right font-medium tabular-nums">
                      {formatCurrency(summary.calloutCost)}
                    </td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums">
                      {formatCurrency(summary.standbyCost)}
                    </td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums">
                      {formatCurrency(summary.totalCost)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {dialogOpen && (
        <InterventionDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          intervention={editing}
          initialObject={editing ? null : object}
          onSaved={() => void load()}
        />
      )}

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Usunąć interwencję?"
        description={`Wpis z ${toDelete ? fmtHappenedAt(toDelete.happenedAt) : ""} zniknie razem z załącznikami. Numeracja podjazdów w tym miesiącu przeliczy się od nowa.`}
        busy={busy}
        onConfirm={() => void doDelete()}
        testid="interwencje-podjazdy-usun-dialog"
      />
    </div>
  );
}
