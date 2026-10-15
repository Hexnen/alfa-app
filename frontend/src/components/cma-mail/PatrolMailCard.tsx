/**
 * Karta „Raporty z podjazdów” w CMA → Ustawienia (docs/PODJAZDY-RAPORTY.md,
 * „Ustawienia podjazdów — stan”). Pola są częścią wspólnego formularza poczty
 * (zapis przyciskiem „Zapisz ustawienia” na górze), karta dokłada własne akcje:
 * pobranie listy folderów, „Sprawdź skrzynkę” (read-only, na niezapisanych
 * filtrach) i „Pobierz teraz” (import wsteczny na zapisanych).
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  Info,
  Loader2,
  Paperclip,
  ScanSearch,
  Siren,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cmaMailApi,
  type CmaMailPatrolFetchResult,
  type CmaMailPatrolPreview,
  type CmaMailPatrolPreviewMessage,
  type CmaMailPatrolStatus,
  type CmaMailSettings,
} from "@/lib/api";
import { patrolLookbackValue, type PatrolMailForm } from "./patrolMailForm";

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  // ISO z backendu IMAP albo „YYYY-MM-DD HH:MM:SS” z SQLite (UTC)
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function PreviewStatus({ status }: { status: CmaMailPatrolPreviewMessage["status"] }) {
  if (status === "imported") {
    return (
      <Badge className="border-transparent bg-green-100 text-green-700 hover:bg-green-100">
        Już zaimportowany
      </Badge>
    );
  }
  if (status === "poller") {
    return (
      <Badge className="border-transparent bg-indigo-100 text-indigo-700 hover:bg-indigo-100">
        Zaimportuje się sam
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100">
      Przeczytany — „Pobierz teraz”
    </Badge>
  );
}

interface Props {
  form: PatrolMailForm;
  onChange: (patch: Partial<PatrolMailForm>) => void;
  /** Foldery raportów kamer — pokazywane, gdy pole folderów podjazdów jest puste. */
  cameraFolder: string;
  settings: CmaMailSettings | null;
  editable: boolean;
  /** Formularz ma niezapisane zmiany (blokuje „Pobierz teraz”). */
  dirty: boolean;
  /** Inna akcja na stronie trwa (zapis, test, sprawdzanie). */
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Po imporcie: odśwież stan ustawień i dziennik poczty. */
  onImported: () => void;
}

export function PatrolMailCard({
  form,
  onChange,
  cameraFolder,
  settings,
  editable,
  dirty,
  busy,
  onBusyChange,
  onImported,
}: Props) {
  const [serverFolders, setServerFolders] = useState<string[] | null>(null);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<CmaMailPatrolPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<CmaMailPatrolFetchResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [status, setStatus] = useState<CmaMailPatrolStatus | null>(null);

  const running = foldersLoading || previewing || fetching;
  useEffect(() => {
    onBusyChange(running);
  }, [running, onBusyChange]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await cmaMailApi.patrolStatus();
      setStatus(res.data ?? null);
    } catch (error) {
      console.error("Error fetching patrol mail status:", error);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const folders = splitList(form.patrolFolder);
  const effectiveFolders = folders.length > 0 ? folders : splitList(cameraFolder || "INBOX");
  const disabledInputs = !editable || !form.patrolEnabled;
  const days = patrolLookbackValue(form.patrolLookbackDays);

  const setFolders = (list: string[]) => onChange({ patrolFolder: list.join(", ") });
  const addFolder = (folder: string) => {
    if (!folders.includes(folder)) setFolders([...folders, folder]);
  };
  const removeFolder = (folder: string) => setFolders(folders.filter((f) => f !== folder));

  const handleLoadFolders = async () => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const res = await cmaMailApi.testImap();
      setServerFolders(res.data?.folders ?? []);
    } catch (error) {
      setFoldersError(errorMessage(error, "Nie udało się pobrać listy folderów."));
    } finally {
      setFoldersLoading(false);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setPreview(null);
    setPreviewError(null);
    try {
      const res = await cmaMailApi.patrolPreview({
        patrolFolder: form.patrolFolder,
        patrolSubjectFilter: form.patrolSubjectFilter,
        patrolFromFilter: form.patrolFromFilter,
        days,
      });
      setPreview(res.data ?? null);
    } catch (error) {
      setPreviewError(errorMessage(error, "Nie udało się sprawdzić skrzynki."));
    } finally {
      setPreviewing(false);
    }
  };

  const handleFetch = async () => {
    if (
      !window.confirm(
        `Zaimportować raporty z podjazdów z maili z ostatnich ${days} dni? Już zaimportowane zostaną pominięte.`
      )
    ) {
      return;
    }
    setFetching(true);
    setFetchResult(null);
    setFetchError(null);
    try {
      const res = await cmaMailApi.patrolFetch(days);
      setFetchResult(res.data ?? null);
    } catch (error) {
      setFetchError(errorMessage(error, "Nie udało się pobrać raportów z podjazdów."));
    } finally {
      setFetching(false);
      onImported();
      void loadStatus();
    }
  };

  const availableFolders = (serverFolders ?? []).filter((f) => !folders.includes(f));
  const fetchBlockedReason = !settings?.hasPassword
    ? "Najpierw zapisz adres i hasło skrzynki."
    : dirty
      ? "Zapisz ustawienia, żeby pobrać z nowymi filtrami."
      : !form.patrolEnabled
        ? "Import podjazdów jest wyłączony."
        : null;

  return (
    <Card data-testid="cma-podjazdy-mail-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Siren className="h-5 w-5 text-indigo-600" />
          Raporty z podjazdów
        </CardTitle>
        <p className="text-sm text-slate-500">
          Maile z załącznikiem z systemu monitoringu trafiają do zakładki{" "}
          <Link to="/cma/podjazdy" className="text-indigo-600 hover:underline">
            Podjazdy
          </Link>
          . Folder, temat i nadawca ustawiasz tu niezależnie od raportów kamer.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="patrol-enabled"
            data-testid="cma-podjazdy-mail-enabled"
            checked={form.patrolEnabled}
            onCheckedChange={(checked) => onChange({ patrolEnabled: checked === true })}
            disabled={!editable}
          />
          <Label htmlFor="patrol-enabled" className="font-normal">
            Importuj raporty z podjazdów z poczty
          </Label>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span>
            Importowany jest tylko załącznik o nazwie{" "}
            <code className="rounded bg-white px-1 py-0.5 text-[11px] text-slate-800">
              raport_z_podjazdow_*.xlsx
            </code>{" "}
            — ten warunek obowiązuje zawsze, filtry poniżej tylko go zawężają. Skrzynkę
            sprawdza ten sam harmonogram co raporty kamer (co {settings?.pollMinutes ?? 15} min).
          </span>
        </div>

        {/* Foldery */}
        <div className="space-y-1.5">
          <Label htmlFor="patrol-folder">Foldery skrzynki</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="patrol-folder"
              data-testid="cma-podjazdy-mail-folder"
              placeholder={`puste = jak raporty kamer (${cameraFolder || "INBOX"})`}
              value={form.patrolFolder}
              onChange={(e) => onChange({ patrolFolder: e.target.value })}
              disabled={disabledInputs}
              className="sm:flex-1"
            />
            {editable && (
              <Button
                type="button"
                variant="outline"
                onClick={handleLoadFolders}
                disabled={busy || running || !settings?.hasPassword}
                data-testid="cma-podjazdy-mail-load-folders"
                className="shrink-0"
              >
                {foldersLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FolderOpen className="mr-2 h-4 w-4" />
                )}
                {serverFolders ? "Odśwież foldery" : "Pobierz foldery"}
              </Button>
            )}
          </div>
          {serverFolders && editable && form.patrolEnabled && (
            <Select value="" onValueChange={(v) => addFolder(v)} disabled={availableFolders.length === 0}>
              <SelectTrigger className="sm:w-80" data-testid="cma-podjazdy-mail-folder-select">
                <SelectValue
                  placeholder={
                    availableFolders.length === 0
                      ? "Wszystkie foldery już wybrane"
                      : `Dodaj folder z listy (${availableFolders.length})…`
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableFolders.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex flex-wrap items-center gap-1.5" data-testid="cma-podjazdy-mail-folder-chips">
            {folders.length === 0 ? (
              <span className="text-xs text-slate-500">
                Przeszukiwane:{" "}
                {effectiveFolders.map((f) => (
                  <span key={f} className="mr-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
                    {f}
                  </span>
                ))}
                (te same co raporty kamer)
              </span>
            ) : (
              folders.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center gap-1 rounded-full border border-indigo-600 bg-indigo-600 py-0.5 pl-2.5 pr-1 text-xs text-white"
                >
                  {f}
                  {!disabledInputs && (
                    <button
                      type="button"
                      onClick={() => removeFolder(f)}
                      aria-label={`Usuń folder ${f}`}
                      className="rounded-full p-0.5 hover:bg-indigo-500"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))
            )}
          </div>
          {foldersError && (
            <p className="flex items-center gap-1.5 text-sm text-red-600">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {foldersError}
            </p>
          )}
          <p className="text-xs text-slate-500">
            Kilka folderów rozdziel przecinkiem albo wybierz z listy. Zostaw puste, jeśli raporty
            przychodzą tam, gdzie raporty kamer.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="patrol-subject">Temat zawiera</Label>
            <Input
              id="patrol-subject"
              data-testid="cma-podjazdy-mail-subject"
              placeholder="np. Raport z podjazdów"
              value={form.patrolSubjectFilter}
              onChange={(e) => onChange({ patrolSubjectFilter: e.target.value })}
              disabled={disabledInputs}
            />
            <p className="text-xs text-slate-500">
              Kilka fraz po przecinku = wystarczy jedna. Puste = dowolny temat.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="patrol-from">Nadawca zawiera</Label>
            <Input
              id="patrol-from"
              data-testid="cma-podjazdy-mail-from"
              placeholder="np. konsalnet"
              value={form.patrolFromFilter}
              onChange={(e) => onChange({ patrolFromFilter: e.target.value })}
              disabled={disabledInputs}
            />
            <p className="text-xs text-slate-500">
              Fragment adresu albo nazwy nadawcy. Puste = dowolny nadawca.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="patrol-days">Sprawdzaj wstecz (dni)</Label>
            <Input
              id="patrol-days"
              data-testid="cma-podjazdy-mail-days"
              type="number"
              min={1}
              max={365}
              value={form.patrolLookbackDays}
              onChange={(e) => onChange({ patrolLookbackDays: e.target.value })}
              disabled={!editable}
            />
            <p className="text-xs text-slate-500">
              Zakres dla „Sprawdź skrzynkę” i „Pobierz teraz”. Automat bierze nieprzeczytane maile.
            </p>
          </div>
        </div>

        {editable && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={handlePreview}
              disabled={busy || running || !settings?.hasPassword}
              data-testid="cma-podjazdy-mail-preview"
            >
              {previewing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ScanSearch className="mr-2 h-4 w-4" />
              )}
              {previewing ? "Sprawdzanie..." : "Sprawdź skrzynkę"}
            </Button>
            <Button
              variant="outline"
              onClick={handleFetch}
              disabled={busy || running || fetchBlockedReason !== null}
              data-testid="cma-podjazdy-mail-fetch"
              title={fetchBlockedReason ?? undefined}
            >
              {fetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {fetching ? "Pobieranie..." : `Pobierz teraz (${days} dni)`}
            </Button>
            {fetchBlockedReason && (
              <span className="text-xs text-amber-600">{fetchBlockedReason}</span>
            )}
          </div>
        )}
        {editable && (
          <p className="flex items-start gap-1.5 text-xs text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            „Sprawdź skrzynkę” tylko czyta (na wpisanych, także niezapisanych filtrach) i niczego
            nie oznacza jako przeczytane.
          </p>
        )}

        {previewError && (
          <p className="flex items-center gap-1.5 text-sm text-red-600" data-testid="cma-podjazdy-mail-preview-error">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {previewError}
          </p>
        )}
        {preview && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3" data-testid="cma-podjazdy-mail-preview-result">
            <p className="text-sm text-slate-700">
              Ostatnie {preview.days} dni: pasujących maili z raportem{" "}
              <span className="font-semibold" data-testid="cma-podjazdy-mail-preview-count">
                {preview.matched}
              </span>
              {preview.matched > 0 && <> (już zaimportowanych {preview.alreadyImported})</>}.
              {preview.withoutAttachment > 0 && (
                <span className="text-slate-500">
                  {" "}
                  Pasuje do filtrów bez załącznika raportu: {preview.withoutAttachment}.
                </span>
              )}
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600">
              {preview.folders.map((f) => (
                <li key={f.folder}>
                  <span className="font-medium">{f.folder}</span>:{" "}
                  {f.error ? (
                    <span className="text-red-600">{f.error}</span>
                  ) : (
                    <>
                      {f.matched} z {f.scanned} maili
                    </>
                  )}
                </li>
              ))}
            </ul>
            {preview.messages.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Data</th>
                      <th className="px-3 py-2 font-medium">Temat / nadawca</th>
                      <th className="px-3 py-2 font-medium">Załącznik</th>
                      <th className="px-3 py-2 font-medium">Import</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.messages.map((m) => (
                      <tr
                        key={`${m.folder}:${m.uid}`}
                        className="border-t border-slate-100 align-top"
                        data-testid="cma-podjazdy-mail-preview-row"
                        data-status={m.status}
                      >
                        <td className="whitespace-nowrap px-3 py-2 text-slate-600">{fmtDate(m.date)}</td>
                        <td className="min-w-[14rem] px-3 py-2">
                          <div className={cn("text-slate-900", !m.seen && "font-semibold")}>
                            {m.subject || "(bez tematu)"}
                          </div>
                          <div className="text-xs text-slate-500">
                            {m.from}
                            {preview.folders.length > 1 && <> · {m.folder}</>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {m.attachments.map((a) => (
                            <div key={a} className="break-all">
                              {a}
                            </div>
                          ))}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <PreviewStatus status={m.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Brak maili z raportem z podjazdów w tym zakresie. Sprawdź folder i filtry albo
                wydłuż zakres dni.
              </p>
            )}
          </div>
        )}

        {fetchError && (
          <p className="flex items-center gap-1.5 text-sm text-red-600" data-testid="cma-podjazdy-mail-fetch-error">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {fetchError}
          </p>
        )}
        {fetchResult && (
          <p className="flex items-start gap-1.5 text-sm text-green-700" data-testid="cma-podjazdy-mail-fetch-result">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Ostatnie {fetchResult.days} dni: zaimportowano {fetchResult.imported}, pominięto{" "}
              {fetchResult.skipped + fetchResult.alreadyImported} (już w bazie), błędów{" "}
              {fetchResult.errors}.
              {fetchResult.folders
                .filter((f) => f.error)
                .map((f) => (
                  <span key={f.folder} className="block text-red-600">
                    {f.folder}: {f.error}
                  </span>
                ))}
            </span>
          </p>
        )}

        <div className="space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500" data-testid="cma-podjazdy-mail-status">
          <p>
            Ostatnie sprawdzenie podjazdów: {fmtDate(settings?.patrolLastCheckAt)}
            {settings?.patrolLastCheckStatus && (
              <>
                {" "}
                —{" "}
                <span className={settings.patrolLastCheckStatus === "ok" ? "text-green-700" : "text-red-600"}>
                  {settings.patrolLastCheckStatus === "ok" ? "OK" : "błąd"}
                </span>
              </>
            )}
            {settings?.patrolLastCheckError && (
              <span className="text-red-600"> — {settings.patrolLastCheckError}</span>
            )}
          </p>
          <p>
            Ostatni raport z poczty:{" "}
            {status?.lastReport ? (
              <>
                <span className="text-slate-700">{status.lastReport.fileName}</span> (
                {fmtDate(status.lastReport.createdAt)}, {status.lastReport.eventsTotal} zdarzeń)
              </>
            ) : (
              "jeszcze żadnego"
            )}
          </p>
          {status && status.recent.length > 0 && (
            <ul className="space-y-0.5 pt-1">
              {status.recent.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="whitespace-nowrap">{fmtDate(e.createdAt)}</span>
                  <span
                    className={cn(
                      "whitespace-nowrap font-medium",
                      e.status === "ok" ? "text-green-700" : e.status === "error" ? "text-red-600" : "text-slate-500"
                    )}
                  >
                    {e.status === "ok" ? "OK" : e.status === "error" ? "Błąd" : "Pominięto"}
                  </span>
                  <span className="min-w-0 truncate" title={e.detail ?? undefined}>
                    {e.detail ?? e.fileName}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
