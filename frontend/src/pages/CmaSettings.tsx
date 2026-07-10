import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  History,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  PlugZap,
  RefreshCw,
  Save,
  Send,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cmaMailApi,
  type CmaMailLogEntry,
  type CmaMailSettings,
  type CmaMailSettingsInput,
  type CmaMailTestImapResult,
} from "@/lib/api";

const LOG_PAGE_SIZE = 20;

// Backend dates come as "YYYY-MM-DD HH:MM:SS" (or ISO with "T").
function formatMailDateTime(value: string | null): string {
  if (!value || value.length < 10) return "-";
  const [y, m, d] = value.slice(0, 10).split("-");
  const time = value.length >= 16 ? value.slice(11, 16) : "";
  return `${d}.${m}.${y}${time ? ` ${time}` : ""}`;
}

interface MailForm {
  email: string;
  password: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  importEnabled: boolean;
  folder: string;
  subjectFilter: string;
  fromFilter: string;
  pollMinutes: string;
  sendEnabled: boolean;
  recipients: string;
  sendMode: "after_import" | "scheduled";
  sendTimes: string;
}

function toForm(s: CmaMailSettings): MailForm {
  return {
    email: s.email ?? "",
    password: "",
    imapHost: s.imapHost,
    imapPort: String(s.imapPort),
    imapSecure: s.imapSecure,
    smtpHost: s.smtpHost,
    smtpPort: String(s.smtpPort),
    smtpSecure: s.smtpSecure,
    importEnabled: s.importEnabled,
    folder: s.folder,
    subjectFilter: s.subjectFilter ?? "",
    fromFilter: s.fromFilter ?? "",
    pollMinutes: String(s.pollMinutes),
    sendEnabled: s.sendEnabled,
    recipients: s.recipients ?? "",
    sendMode: s.sendMode,
    sendTimes: s.sendTimes ?? "",
  };
}

// "INBOX, INBOX.Safestar" -> ["INBOX", "INBOX.Safestar"]
function folderListFromValue(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePort(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function StatusBadge({ status }: { status: CmaMailLogEntry["status"] }) {
  if (status === "ok") {
    return (
      <Badge className="border-transparent bg-green-100 text-green-700 hover:bg-green-100">
        OK
      </Badge>
    );
  }
  if (status === "skipped") {
    return (
      <Badge className="border-transparent bg-slate-200 text-slate-600 hover:bg-slate-200">
        Pominięto
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-red-100 text-red-700 hover:bg-red-100">
      Błąd
    </Badge>
  );
}

function DirectionBadge({
  direction,
}: {
  direction: CmaMailLogEntry["direction"];
}) {
  if (direction === "import") {
    return (
      <Badge className="border-transparent bg-indigo-100 text-indigo-700 hover:bg-indigo-100">
        Import
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100">
      Wysyłka
    </Badge>
  );
}

export function CmaSettings() {
  const [settings, setSettings] = useState<CmaMailSettings | null>(null);
  const [form, setForm] = useState<MailForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // IMAP test
  const [imapTesting, setImapTesting] = useState(false);
  const [imapResult, setImapResult] = useState<CmaMailTestImapResult | null>(
    null
  );
  const [imapError, setImapError] = useState<string | null>(null);

  // Check now
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // SMTP test
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [smtpResult, setSmtpResult] = useState<string | null>(null);
  const [smtpError, setSmtpError] = useState<string | null>(null);

  // Send latest report
  const [sendingLatest, setSendingLatest] = useState(false);
  const [sendLatestResult, setSendLatestResult] = useState<string | null>(null);
  const [sendLatestError, setSendLatestError] = useState<string | null>(null);

  // Mail log
  const [logEntries, setLogEntries] = useState<CmaMailLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [logPage, setLogPage] = useState(1);
  const [logTotalPages, setLogTotalPages] = useState(0);

  const anyActionRunning =
    saving || imapTesting || checking || smtpTesting || sendingLatest;

  useEffect(() => {
    let cancelled = false;
    cmaMailApi
      .getSettings()
      .then((res) => {
        if (cancelled || !res.data) return;
        setSettings(res.data);
        setForm(toForm(res.data));
        setDirty(false);
      })
      .catch((error) => {
        console.error("Error fetching CMA mail settings:", error);
        if (!cancelled) {
          setLoadError(
            errorMessage(error, "Nie udało się pobrać ustawień poczty.")
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const response = await cmaMailApi.getLog({
        page: logPage,
        pageSize: LOG_PAGE_SIZE,
      });
      setLogEntries(response.data);
      setLogTotalPages(response.totalPages);
    } catch (error) {
      console.error("Error fetching CMA mail log:", error);
    } finally {
      setLogLoading(false);
    }
  }, [logPage]);

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  const update = (patch: Partial<MailForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
    setSaveSuccess(null);
  };

  // Refresh only the server-side snapshot (lastCheck*, hasPassword) without
  // discarding unsaved form edits.
  const refreshServerSnapshot = async () => {
    try {
      const res = await cmaMailApi.getSettings();
      if (res.data) setSettings(res.data);
    } catch (error) {
      console.error("Error refreshing CMA mail settings:", error);
    }
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    setSaveSuccess(null);
    setSaveError(null);
    try {
      const payload: CmaMailSettingsInput = {
        email: form.email,
        imapHost: form.imapHost,
        imapPort: parsePort(form.imapPort, 993),
        imapSecure: form.imapSecure,
        smtpHost: form.smtpHost,
        smtpPort: parsePort(form.smtpPort, 465),
        smtpSecure: form.smtpSecure,
        importEnabled: form.importEnabled,
        folder: form.folder || "INBOX",
        subjectFilter: form.subjectFilter,
        fromFilter: form.fromFilter,
        pollMinutes: Math.max(5, parsePort(form.pollMinutes, 15)),
        sendEnabled: form.sendEnabled,
        recipients: form.recipients,
        sendMode: form.sendMode,
        sendTimes: form.sendTimes,
      };
      if (form.password !== "") {
        payload.password = form.password;
      }
      const res = await cmaMailApi.saveSettings(payload);
      if (res.data) {
        setSettings(res.data);
        setForm(toForm(res.data));
      }
      setDirty(false);
      setSaveSuccess("Ustawienia zostały zapisane.");
    } catch (error) {
      setSaveError(errorMessage(error, "Nie udało się zapisać ustawień."));
    } finally {
      setSaving(false);
    }
  };

  // Chip click: add the folder to the list, or remove it when already present
  const toggleFolder = (folder: string) => {
    if (!form) return;
    const list = folderListFromValue(form.folder);
    const next = list.includes(folder)
      ? list.filter((entry) => entry !== folder)
      : [...list, folder];
    update({ folder: next.join(", ") });
  };

  const handleTestImap = async () => {
    setImapTesting(true);
    setImapResult(null);
    setImapError(null);
    try {
      const res = await cmaMailApi.testImap();
      setImapResult(res.data ?? null);
    } catch (error) {
      setImapError(
        errorMessage(error, "Nie udało się połączyć z serwerem IMAP.")
      );
    } finally {
      setImapTesting(false);
    }
  };

  const handleCheckNow = async () => {
    setChecking(true);
    setCheckResult(null);
    setCheckError(null);
    try {
      const res = await cmaMailApi.checkNow();
      if (res.data) {
        const d = res.data;
        setCheckResult(
          `Sprawdzono ${d.checked}, pasujących ${d.matched}, zaimportowano ${d.imported}, pominięto ${d.skipped}, błędów ${d.errors}`
        );
      }
      await refreshServerSnapshot();
      fetchLog();
    } catch (error) {
      setCheckError(errorMessage(error, "Nie udało się sprawdzić skrzynki."));
      await refreshServerSnapshot();
    } finally {
      setChecking(false);
    }
  };

  const handleTestSmtp = async () => {
    if (!form) return;
    setSmtpTesting(true);
    setSmtpResult(null);
    setSmtpError(null);
    try {
      const res = await cmaMailApi.testSmtp(form.recipients || undefined);
      setSmtpResult(res.message || "Testowy e-mail został wysłany.");
    } catch (error) {
      setSmtpError(
        errorMessage(error, "Nie udało się wysłać testowego e-maila.")
      );
    } finally {
      setSmtpTesting(false);
    }
  };

  const handleSendLatest = async () => {
    if (!form) return;
    const recipients =
      form.recipients.trim() || "(brak skonfigurowanych odbiorców)";
    if (
      !window.confirm(
        `Wysłać zestawienie braków obrazu z najnowszego raportu na adresy: ${recipients}?`
      )
    ) {
      return;
    }
    setSendingLatest(true);
    setSendLatestResult(null);
    setSendLatestError(null);
    try {
      const res = await cmaMailApi.sendLatest();
      setSendLatestResult(res.message || "Zestawienie zostało wysłane.");
      fetchLog();
    } catch (error) {
      setSendLatestError(
        errorMessage(error, "Nie udało się wysłać zestawienia braków obrazu.")
      );
      fetchLog();
    } finally {
      setSendingLatest(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">CMA</h1>
        <p className="text-slate-500 mt-1">
          Centrum monitorowania alarmów - ustawienia poczty
        </p>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-500">
          Ładowanie ustawień...
        </div>
      ) : loadError || !form ? (
        <div className="bg-white rounded-lg border border-red-200 py-12 text-center">
          <AlertCircle className="w-10 h-10 mx-auto text-red-400" />
          <p className="mt-3 text-sm text-red-600">
            {loadError ?? "Nie udało się pobrać ustawień poczty."}
          </p>
        </div>
      ) : (
        <>
          {/* Mailbox (Zenbox) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2">
                  <Inbox className="h-5 w-5 text-indigo-600" />
                  Skrzynka pocztowa (Zenbox)
                </CardTitle>
                <div className="flex items-center gap-3">
                  {dirty && !saving && (
                    <span className="text-xs text-amber-600">
                      Niezapisane zmiany
                    </span>
                  )}
                  <Button
                    onClick={handleSave}
                    disabled={anyActionRunning || !dirty}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Zapisywanie...
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        Zapisz ustawienia
                      </>
                    )}
                  </Button>
                </div>
              </div>
              {saveSuccess && (
                <p className="flex items-center gap-1.5 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {saveSuccess}
                </p>
              )}
              {saveError && (
                <p className="flex items-center gap-1.5 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  {saveError}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mail-email">Adres e-mail</Label>
                  <Input
                    id="mail-email"
                    type="email"
                    placeholder="np. raporty@twojafirma.pl"
                    value={form.email}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mail-password">Hasło</Label>
                  <Input
                    id="mail-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      settings?.hasPassword
                        ? "Zapisane — wpisz aby zmienić"
                        : "Hasło do skrzynki"
                    }
                    value={form.password}
                    onChange={(e) => update({ password: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Login to pełny adres e-mail. Domyślne serwery Zenbox:
                imap.zenbox.pl:993, smtp.zenbox.pl:465.
              </p>

              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0 text-slate-600 hover:bg-transparent hover:text-slate-900"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <ChevronDown
                    className={cn(
                      "mr-2 h-4 w-4 transition-transform",
                      showAdvanced && "rotate-180"
                    )}
                  />
                  <Server className="mr-2 h-4 w-4" />
                  Ustawienia zaawansowane serwerów
                </Button>
                {showAdvanced && (
                  <div className="mt-3 space-y-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="imap-host">Serwer IMAP</Label>
                        <Input
                          id="imap-host"
                          value={form.imapHost}
                          onChange={(e) =>
                            update({ imapHost: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="imap-port">Port IMAP</Label>
                        <Input
                          id="imap-port"
                          type="number"
                          min={1}
                          value={form.imapPort}
                          onChange={(e) =>
                            update({ imapPort: e.target.value })
                          }
                        />
                      </div>
                      <div className="flex items-center gap-2 pt-7">
                        <Checkbox
                          id="imap-secure"
                          checked={form.imapSecure}
                          onCheckedChange={(checked) =>
                            update({ imapSecure: checked === true })
                          }
                        />
                        <Label htmlFor="imap-secure" className="font-normal">
                          SSL
                        </Label>
                      </div>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="smtp-host">Serwer SMTP</Label>
                        <Input
                          id="smtp-host"
                          value={form.smtpHost}
                          onChange={(e) =>
                            update({ smtpHost: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="smtp-port">Port SMTP</Label>
                        <Input
                          id="smtp-port"
                          type="number"
                          min={1}
                          value={form.smtpPort}
                          onChange={(e) =>
                            update({ smtpPort: e.target.value })
                          }
                        />
                      </div>
                      <div className="flex items-center gap-2 pt-7">
                        <Checkbox
                          id="smtp-secure"
                          checked={form.smtpSecure}
                          onCheckedChange={(checked) =>
                            update({ smtpSecure: checked === true })
                          }
                        />
                        <Label htmlFor="smtp-secure" className="font-normal">
                          SSL
                        </Label>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Automatic import */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MailCheck className="h-5 w-5 text-indigo-600" />
                Automatyczny import raportów
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="import-enabled"
                  checked={form.importEnabled}
                  onCheckedChange={(checked) =>
                    update({ importEnabled: checked === true })
                  }
                />
                <Label htmlFor="import-enabled" className="font-normal">
                  Włącz automatyczny import raportów z poczty
                </Label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label htmlFor="mail-folder">Foldery (po przecinku)</Label>
                  <Input
                    id="mail-folder"
                    placeholder="INBOX, INBOX.Safestar"
                    value={form.folder}
                    onChange={(e) => update({ folder: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="subject-filter">
                    Temat zawiera (frazy po przecinku)…
                  </Label>
                  <Input
                    id="subject-filter"
                    placeholder='np. "Raport z przeglądu kamer, Raport z kamer"'
                    value={form.subjectFilter}
                    onChange={(e) =>
                      update({ subjectFilter: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="from-filter">Nadawca zawiera…</Label>
                  <Input
                    id="from-filter"
                    placeholder='np. "safestar"'
                    value={form.fromFilter}
                    onChange={(e) => update({ fromFilter: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="poll-minutes">
                    Sprawdzaj co (minuty)
                  </Label>
                  <Input
                    id="poll-minutes"
                    type="number"
                    min={5}
                    value={form.pollMinutes}
                    onChange={(e) => update({ pollMinutes: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  onClick={handleTestImap}
                  disabled={anyActionRunning}
                >
                  {imapTesting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Testowanie połączenia...
                    </>
                  ) : (
                    <>
                      <PlugZap className="w-4 h-4 mr-2" />
                      Testuj połączenie
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleCheckNow}
                  disabled={anyActionRunning}
                >
                  {checking ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Sprawdzanie skrzynki...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Sprawdź teraz
                    </>
                  )}
                </Button>
              </div>

              {imapError && (
                <p className="flex items-center gap-1.5 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {imapError}
                </p>
              )}
              {imapResult && (
                <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 p-3">
                  <p className="flex items-center gap-1.5 text-sm text-green-700">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Połączenie działa. Pasujących wiadomości łącznie:{" "}
                    <span className="font-semibold">
                      {imapResult.matchedInFolder}
                    </span>
                  </p>
                  {(imapResult.matchedPerFolder ?? []).length > 0 && (
                    <ul className="space-y-0.5 text-xs text-slate-600">
                      {imapResult.matchedPerFolder.map((entry) => (
                        <li key={entry.folder}>
                          <span className="font-medium">{entry.folder}</span>:{" "}
                          {entry.error ? (
                            <span className="text-red-600">{entry.error}</span>
                          ) : (
                            <>pasujących {entry.matched}</>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {imapResult.folders.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs text-slate-500">
                        Foldery na serwerze (kliknij, aby dodać do listy lub
                        usunąć z niej):
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {imapResult.folders.map((folder) => {
                          const active = folderListFromValue(
                            form.folder
                          ).includes(folder);
                          return (
                            <button
                              key={folder}
                              type="button"
                              onClick={() => toggleFolder(folder)}
                              className={cn(
                                "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                                active
                                  ? "border-indigo-600 bg-indigo-600 text-white"
                                  : "border-slate-300 bg-white text-slate-700 hover:border-indigo-400 hover:text-indigo-700"
                              )}
                            >
                              {folder}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {checkError && (
                <p className="flex items-center gap-1.5 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {checkError}
                </p>
              )}
              {checkResult && (
                <p className="flex items-center gap-1.5 text-sm text-green-700">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  {checkResult}
                </p>
              )}

              {settings?.lastCheckAt && (
                <p className="text-xs text-slate-500">
                  Ostatnie sprawdzenie:{" "}
                  {formatMailDateTime(settings.lastCheckAt)}
                  {settings.lastCheckStatus && (
                    <> — status: {settings.lastCheckStatus}</>
                  )}
                  {settings.lastCheckError && (
                    <span className="text-red-600">
                      {" "}
                      — {settings.lastCheckError}
                    </span>
                  )}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Sending camera issues */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5 text-indigo-600" />
                Wysyłka braków obrazu e-mailem
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="send-enabled"
                  checked={form.sendEnabled}
                  onCheckedChange={(checked) =>
                    update({ sendEnabled: checked === true })
                  }
                />
                <Label htmlFor="send-enabled" className="font-normal">
                  Włącz wysyłkę listy kamer bez obrazu e-mailem
                </Label>
              </div>

              <div className="space-y-2">
                <Label>Kiedy wysyłać</Label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-normal text-slate-700">
                    <input
                      type="radio"
                      name="send-mode"
                      className="h-4 w-4 accent-indigo-600"
                      checked={form.sendMode === "after_import"}
                      onChange={() => update({ sendMode: "after_import" })}
                    />
                    Od razu po zaimportowaniu raportu z poczty
                  </label>
                  <label className="flex items-center gap-2 text-sm font-normal text-slate-700">
                    <input
                      type="radio"
                      name="send-mode"
                      className="h-4 w-4 accent-indigo-600"
                      checked={form.sendMode === "scheduled"}
                      onChange={() => update({ sendMode: "scheduled" })}
                    />
                    O wyznaczonych godzinach
                  </label>
                </div>
                {form.sendMode === "scheduled" && (
                  <div className="space-y-1.5 pl-6">
                    <Input
                      id="send-times"
                      placeholder="np. 07:30, 15:00"
                      value={form.sendTimes}
                      onChange={(e) => update({ sendTimes: e.target.value })}
                      className="max-w-xs"
                    />
                    <p className="text-xs text-slate-500">
                      Godziny wysyłki (HH:MM, po przecinku). Wysyłany jest
                      najnowszy raport.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mail-recipients">Odbiorcy</Label>
                <Input
                  id="mail-recipients"
                  placeholder="adresy po przecinku, np. jan@firma.pl, serwis@firma.pl"
                  value={form.recipients}
                  onChange={(e) => update({ recipients: e.target.value })}
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  onClick={handleTestSmtp}
                  disabled={anyActionRunning}
                >
                  {smtpTesting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Wysyłanie testu...
                    </>
                  ) : (
                    <>
                      <Mail className="w-4 h-4 mr-2" />
                      Wyślij testowy e-mail
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleSendLatest}
                  disabled={anyActionRunning}
                >
                  {sendingLatest ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Wysyłanie raportu...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      Wyślij aktualny raport
                    </>
                  )}
                </Button>
                {sendLatestResult && (
                  <span className="flex items-center gap-1.5 text-sm text-green-700">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    {sendLatestResult}
                  </span>
                )}
                {sendLatestError && (
                  <span className="flex items-center gap-1.5 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {sendLatestError}
                  </span>
                )}
                {smtpResult && (
                  <span className="flex items-center gap-1.5 text-sm text-green-700">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    {smtpResult}
                  </span>
                )}
                {smtpError && (
                  <span className="flex items-center gap-1.5 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {smtpError}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Mail log */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <History className="h-5 w-5 text-indigo-600" />
                  Historia poczty
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchLog}
                  disabled={logLoading}
                >
                  <RefreshCw
                    className={cn(
                      "w-4 h-4 mr-2",
                      logLoading && "animate-spin"
                    )}
                  />
                  Odśwież
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="font-semibold">Data</TableHead>
                      <TableHead className="font-semibold">Kierunek</TableHead>
                      <TableHead className="font-semibold">
                        Temat / plik
                      </TableHead>
                      <TableHead className="font-semibold">Status</TableHead>
                      <TableHead className="font-semibold">Szczegóły</TableHead>
                      <TableHead className="font-semibold text-right">
                        Raport
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logLoading ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-8 text-center text-slate-500"
                        >
                          Ładowanie historii...
                        </TableCell>
                      </TableRow>
                    ) : logEntries.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-8 text-center text-slate-500"
                        >
                          Brak wpisów w historii poczty.
                        </TableCell>
                      </TableRow>
                    ) : (
                      logEntries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="whitespace-nowrap text-sm text-slate-700">
                            {formatMailDateTime(entry.createdAt)}
                          </TableCell>
                          <TableCell>
                            <DirectionBadge direction={entry.direction} />
                          </TableCell>
                          <TableCell>
                            <div
                              className="max-w-[280px] truncate text-sm text-slate-900"
                              title={entry.subject ?? undefined}
                            >
                              {entry.subject || "-"}
                            </div>
                            {entry.fileName && (
                              <div
                                className="max-w-[280px] truncate text-xs text-slate-500"
                                title={entry.fileName}
                              >
                                {entry.fileName}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={entry.status} />
                          </TableCell>
                          <TableCell>
                            <div
                              className="max-w-[320px] truncate text-sm text-slate-600"
                              title={entry.detail ?? undefined}
                            >
                              {entry.detail || "-"}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {entry.reportId !== null ? (
                              <Link
                                to={`/cma/raporty/${entry.reportId}`}
                                className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
                              >
                                Raport →
                              </Link>
                            ) : (
                              <span className="text-sm text-slate-400">-</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {logTotalPages > 1 && (
                <div className="flex items-center justify-between">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={logPage === 1 || logLoading}
                    onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                  >
                    Poprzednia
                  </Button>
                  <span className="text-sm text-slate-500">
                    Strona {logPage} z {logTotalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={logPage === logTotalPages || logLoading}
                    onClick={() =>
                      setLogPage((p) => Math.min(logTotalPages, p + 1))
                    }
                  >
                    Następna
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
