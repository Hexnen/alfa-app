/**
 * Administracja → Poczta.
 *
 * Jedno miejsce, z którego aplikacja bierze konto SMTP, nadawcę i adresatów
 * maili wychodzących ze zleceń. Wzorzec strony — szkic + sticky pasek zapisu +
 * sekcje — jak w Administracja → Firma.
 *
 * Dwie rzeczy działają tu inaczej niż w pozostałych panelach ustawień:
 *
 *   • HASŁO SMTP nigdy nie wraca z backendu (jest tylko flaga `hasPassword`).
 *     Puste pole hasła znaczy „zostaw jak było”, a nie „skasuj” — wysyłamy
 *     `smtpPassword` wyłącznie wtedy, gdy człowiek faktycznie coś wpisał.
 *   • WYSYŁKA jest domyślnie wyłączona i ma własny przełącznik. Dopóki jest
 *     wyłączona, okno podglądu maila zlecenia trzyma „Wyślij” nieaktywne —
 *     dlatego przy wyłączonym przełączniku pokazujemy ostrzeżenie, a nie
 *     samą pozycję „off”.
 *
 * Defensywnie: gdy backend nie ma jeszcze `/admin/mail/*`, strona pokazuje
 * czytelny komunikat i blokuje zapis (zamiast wykładać panel).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, Mail, RefreshCw, Save, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ErrorBox, Field, SectionCard, Switch } from "@/components/admin-assistant/shared";
import { deepEq, errMsg, useFlash } from "@/components/admin-assistant/helpers";
import { MailLogTable } from "@/components/MailLogTable";
import { tip } from "@/components/ui/tooltip";
import {
  adminMailApi,
  isMissingEndpoint,
  MAIL_FALLBACK_VALUES,
  type AdminMailSettings,
  type AdminMailSettingsUpdate,
  type MailLogEntry,
  type MailSettingsField,
  type MailSettingsValues,
} from "@/lib/api";

/** Ile wpisów dziennika na stronę — tabela ma się mieścić bez przewijania okna. */
const LOG_PAGE_SIZE = 20;

/** Pola, które trafiają do szkicu (hasło idzie osobno — nie jest wartością). */
type EditableField = Exclude<MailSettingsField, "hasPassword">;
type Draft = { [K in EditableField]?: MailSettingsValues[K] };

/** Prosta walidacja adresu — ma łapać literówki, nie implementować RFC 5322. */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Lista adresów po przecinku/średniku → te, które nie wyglądają na adres. */
function invalidAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !EMAIL_RE.test(s));
}

export function AdminMail() {
  const [settings, setSettings] = useState<AdminMailSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  /** Nowe hasło SMTP; pusty string = bez zmian. */
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, flash] = useFlash();

  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [log, setLog] = useState<MailLogEntry[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logOffset, setLogOffset] = useState(0);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  const load = useCallback(async () => {
    const s = await adminMailApi.settings();
    setSettings(s);
    setDraft({});
    setPassword("");
  }, []);

  useEffect(() => {
    load().catch((e) => {
      if (isMissingEndpoint(e)) {
        setUnavailable(true);
        // Panel działa „na sucho": pokazujemy wartości domyślne, zapis zablokowany.
        setSettings({ values: { ...MAIL_FALLBACK_VALUES } });
      } else {
        setLoadError(errMsg(e, "Nie udało się wczytać ustawień poczty"));
      }
    });
  }, [load]);

  const loadLog = useCallback((offset: number) => {
    setLogLoading(true);
    adminMailApi
      .log({ limit: LOG_PAGE_SIZE, offset })
      .then((res) => {
        setLog(res.items);
        setLogTotal(res.total);
        setLogError(null);
      })
      .catch((e) => {
        setLog([]);
        setLogTotal(0);
        setLogError(
          isMissingEndpoint(e)
            ? "Dziennik wysyłek pojawi się, gdy backend udostępni /api/admin/mail/log."
            : errMsg(e, "Nie udało się wczytać historii wysyłek")
        );
      })
      .finally(() => setLogLoading(false));
  }, []);

  useEffect(() => {
    loadLog(logOffset);
  }, [loadLog, logOffset]);

  const values: MailSettingsValues = useMemo(
    () => ({ ...MAIL_FALLBACK_VALUES, ...(settings?.values ?? {}) }),
    [settings]
  );

  const val = <K extends EditableField>(k: K): MailSettingsValues[K] =>
    (k in draft ? draft[k] : values[k]) as MailSettingsValues[K];
  const setField = <K extends EditableField>(k: K, v: MailSettingsValues[K]) =>
    setDraft((d) => {
      const next = { ...d };
      if (deepEq(values[k], v)) delete next[k];
      else (next as Record<K, MailSettingsValues[K]>)[k] = v;
      return next;
    });
  const isDirty = (k: EditableField) => k in draft;
  const source = (k: MailSettingsField) => settings?.sources?.[k];
  /** Podpowiedź z backendu ma pierwszeństwo przed tą wpisaną w kodzie. */
  const help = (k: MailSettingsField, fallback?: string) => settings?.meta?.[k]?.help ?? fallback;

  const dirtyCount = Object.keys(draft).length + (password ? 1 : 0);

  // Ostrzeżenie przeglądarki przy wyjściu z niezapisanymi zmianami.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  const fromError = val("fromAddress").trim() && !EMAIL_RE.test(val("fromAddress").trim())
    ? "To nie wygląda na adres e-mail."
    : undefined;
  const replyError = val("replyTo").trim() && !EMAIL_RE.test(val("replyTo").trim())
    ? "To nie wygląda na adres e-mail."
    : undefined;
  const internalBad = invalidAddresses(val("orderInternalTo"));
  const bccBad = invalidAddresses(val("orderClientBcc"));
  const hasFieldErrors =
    !!fromError || !!replyError || internalBad.length > 0 || bccBad.length > 0;

  const save = async () => {
    if (dirtyCount === 0 || unavailable || hasFieldErrors) return;
    setSaving(true);
    setError(null);
    try {
      const body: AdminMailSettingsUpdate = { ...draft };
      // Hasło leci TYLKO, gdy wpisane — puste pole nie kasuje zapisanego.
      if (password) body.smtpPassword = password;
      const s = await adminMailApi.updateSettings(body);
      setSettings(s);
      setDraft({});
      setPassword("");
      flash("Ustawienia poczty zapisane.");
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać ustawień poczty"));
    } finally {
      setSaving(false);
    }
  };

  const runImportCma = async () => {
    setImporting(true);
    setError(null);
    try {
      const s = await adminMailApi.importCma();
      setSettings(s);
      setDraft({});
      setPassword("");
      flash("Skopiowano konfigurację SMTP z ustawień CMA.");
    } catch (e) {
      setError(
        isMissingEndpoint(e)
          ? "Import z CMA niedostępny w tej wersji backendu."
          : errMsg(e, "Nie udało się pobrać ustawień z CMA")
      );
    } finally {
      setImporting(false);
      setImportOpen(false);
    }
  };

  const runTest = async () => {
    const to = testTo.trim();
    if (to && !EMAIL_RE.test(to)) {
      setTestError("Podaj poprawny adres albo zostaw pole puste (mail pójdzie na adres nadawcy).");
      setTestResult(null);
      return;
    }
    setTestBusy(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await adminMailApi.testSmtp(to || undefined);
      setTestResult(
        `Wiadomość wysłana${to ? ` na ${to}` : ""}${res.messageId ? ` (ID: ${res.messageId})` : ""}.`
      );
    } catch (e) {
      setTestError(
        isMissingEndpoint(e)
          ? "Test SMTP niedostępny w tej wersji backendu."
          : errMsg(e, "Nie udało się wysłać wiadomości testowej")
      );
    } finally {
      // Nieudana próba też zostawia wpis w dzienniku — historia ma go pokazać.
      if (logOffset === 0) loadLog(0);
      else setLogOffset(0);
      setTestBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-3">
        <ErrorBox>{loadError}</ErrorBox>
        <Button
          variant="outline"
          onClick={() =>
            load()
              .then(() => setLoadError(null))
              .catch((e) => setLoadError(errMsg(e, "Błąd")))
          }
        >
          <RefreshCw className="mr-1 h-4 w-4" /> Spróbuj ponownie
        </Button>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytywanie ustawień…
      </div>
    );
  }

  const sendEnabled = val("sendEnabled");
  const logPage = Math.floor(logOffset / LOG_PAGE_SIZE) + 1;
  const logPages = Math.max(1, Math.ceil(logTotal / LOG_PAGE_SIZE));

  return (
    <div className="space-y-3 pb-24">
      {unavailable && (
        <div
          className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          role="status"
          data-testid="mail-unavailable"
        >
          Backend nie udostępnia jeszcze <code className="rounded bg-muted px-1">/api/admin/mail/settings</code> —
          poniżej wartości domyślne, zapis jest zablokowany.
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {notice && (
        <div
          className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400"
          role="status"
          data-testid="mail-notice"
        >
          {notice}
        </div>
      )}

      <SectionCard
        id="smtp"
        title="Serwer SMTP"
        description="Konto, przez które aplikacja wysyła wiadomości. To samo, którym CMA pobiera raporty — możesz je stąd skopiować."
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field
            id="mail-smtp-host"
            label="Host"
            source={source("smtpHost")}
            dirty={isDirty("smtpHost")}
            description={help("smtpHost", "Adres serwera poczty wychodzącej, np. smtp.firma.pl.")}
          >
            <Input
              id="mail-smtp-host"
              data-testid="mail-smtp-host"
              value={val("smtpHost")}
              placeholder="np. smtp.firma.pl"
              onChange={(e) => setField("smtpHost", e.target.value)}
            />
          </Field>
          <Field
            id="mail-smtp-port"
            label="Port"
            source={source("smtpPort")}
            dirty={isDirty("smtpPort")}
            description={help("smtpPort", "465 przy SSL/TLS, 587 przy STARTTLS.")}
          >
            <Input
              id="mail-smtp-port"
              data-testid="mail-smtp-port"
              type="number"
              className="tabular-nums"
              value={val("smtpPort")}
              onChange={(e) =>
                setField("smtpPort", e.target.value === "" ? 0 : parseInt(e.target.value, 10) || 0)
              }
            />
          </Field>
        </div>

        <Field
          id="mail-smtp-secure"
          label="Szyfrowanie SSL/TLS"
          source={source("smtpSecure")}
          dirty={isDirty("smtpSecure")}
          inline
          description={help(
            "smtpSecure",
            "Włączone: połączenie szyfrowane od pierwszego bajtu (zwykle port 465). Wyłączone: STARTTLS (port 587)."
          )}
        >
          <Switch
            id="mail-smtp-secure"
            checked={val("smtpSecure")}
            onChange={(v) => setField("smtpSecure", v)}
            label="Szyfrowanie SSL/TLS"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="mail-smtp-user"
            label="Użytkownik"
            source={source("smtpUser")}
            dirty={isDirty("smtpUser")}
            description={help("smtpUser", "Zwykle pełny adres skrzynki.")}
          >
            <Input
              id="mail-smtp-user"
              data-testid="mail-smtp-user"
              autoComplete="off"
              value={val("smtpUser")}
              placeholder="np. biuro@firma.pl"
              onChange={(e) => setField("smtpUser", e.target.value)}
            />
          </Field>
          <Field
            id="mail-smtp-password"
            label="Hasło"
            dirty={!!password}
            description={
              password
                ? "Zostanie zapisane po kliknięciu „Zapisz”."
                : values.hasPassword
                  ? "Hasło jest zapisane w bazie — zostaw puste, żeby go nie zmieniać."
                  : "Hasło nie jest jeszcze zapisane."
            }
          >
            <Input
              id="mail-smtp-password"
              data-testid="mail-smtp-password"
              type="password"
              autoComplete="new-password"
              value={password}
              placeholder={values.hasPassword ? "•••••••• (bez zmian)" : "wpisz hasło"}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>

        <div>
          <Button
            type="button"
            variant="outline"
            data-testid="mail-import-cma"
            disabled={importing || unavailable}
            onClick={() => setImportOpen(true)}
            {...tip("Przepisze host, port, szyfrowanie i użytkownika z ustawień CMA")}
          >
            {importing ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-1 h-4 w-4" aria-hidden />
            )}
            Pobierz z ustawień CMA
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        id="nadawca"
        title="Nadawca"
        description="Co klient zobaczy w polu „Od” i dokąd trafi jego odpowiedź."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="mail-from-name"
            label="Nazwa nadawcy"
            source={source("fromName")}
            dirty={isDirty("fromName")}
            description={help("fromName", "Np. „ALFA GROUP — Zlecenia”.")}
          >
            <Input
              id="mail-from-name"
              data-testid="mail-from-name"
              value={val("fromName")}
              placeholder="np. ALFA GROUP"
              onChange={(e) => setField("fromName", e.target.value)}
            />
          </Field>
          <Field
            id="mail-from-address"
            label="Adres nadawcy"
            source={source("fromAddress")}
            dirty={isDirty("fromAddress")}
            error={fromError}
            description={help("fromAddress", "Musi należeć do skrzynki SMTP — inaczej serwer odrzuci wysyłkę.")}
          >
            <Input
              id="mail-from-address"
              data-testid="mail-from-address"
              value={val("fromAddress")}
              placeholder="np. zlecenia@firma.pl"
              aria-invalid={!!fromError}
              className={fromError ? "border-destructive" : undefined}
              onChange={(e) => setField("fromAddress", e.target.value)}
            />
          </Field>
        </div>

        <Field
          id="mail-reply-to"
          label="Adres do odpowiedzi (reply-to)"
          source={source("replyTo")}
          dirty={isDirty("replyTo")}
          error={replyError}
          description={help("replyTo", "Puste = odpowiedzi wracają na adres nadawcy.")}
        >
          <Input
            id="mail-reply-to"
            data-testid="mail-reply-to"
            className={replyError ? "max-w-md border-destructive" : "max-w-md"}
            value={val("replyTo")}
            placeholder="np. biuro@firma.pl"
            aria-invalid={!!replyError}
            onChange={(e) => setField("replyTo", e.target.value)}
          />
        </Field>
      </SectionCard>

      <SectionCard
        id="zlecenia"
        title="Maile ze zleceń"
        description="Adresaci obu wariantów wiadomości z okna „Podgląd maila” w Zleceniach."
      >
        <Field
          id="mail-order-internal-to"
          label="Odbiorcy wariantu wewnętrznego"
          source={source("orderInternalTo")}
          dirty={isDirty("orderInternalTo")}
          error={internalBad.length ? `Niepoprawne adresy: ${internalBad.join(", ")}` : undefined}
          description={help(
            "orderInternalTo",
            "Kilka adresów po przecinku. Bez nich wariant „Wewnętrzny” nie ma dokąd pójść."
          )}
        >
          <Input
            id="mail-order-internal-to"
            data-testid="mail-order-internal-to"
            value={val("orderInternalTo")}
            placeholder="np. technicy@firma.pl, kierownik@firma.pl"
            aria-invalid={internalBad.length > 0}
            onChange={(e) => setField("orderInternalTo", e.target.value)}
          />
        </Field>

        <Field
          id="mail-order-client-bcc"
          label="Ukryta kopia maila do klienta (UDW)"
          source={source("orderClientBcc")}
          dirty={isDirty("orderClientBcc")}
          error={bccBad.length ? `Niepoprawne adresy: ${bccBad.join(", ")}` : undefined}
          description={help("orderClientBcc", "Kilka adresów po przecinku. Np. archiwum sekretariatu.")}
        >
          <Input
            id="mail-order-client-bcc"
            data-testid="mail-order-client-bcc"
            value={val("orderClientBcc")}
            placeholder="np. archiwum@firma.pl"
            aria-invalid={bccBad.length > 0}
            onChange={(e) => setField("orderClientBcc", e.target.value)}
          />
        </Field>

        <Field
          id="mail-send-enabled"
          label="Wysyłka włączona"
          source={source("sendEnabled")}
          dirty={isDirty("sendEnabled")}
          inline
          description={help(
            "sendEnabled",
            "Główny bezpiecznik. Wyłączona: podgląd i kopiowanie do Outlooka działają, przycisk „Wyślij” jest nieaktywny."
          )}
        >
          <Switch
            id="mail-send-enabled"
            checked={sendEnabled}
            onChange={(v) => setField("sendEnabled", v)}
            label="Wysyłka włączona"
          />
        </Field>

        {!sendEnabled && (
          <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="mail-send-disabled-warning">
            Wysyłka jest wyłączona — w oknie podglądu maila zlecenia przycisk „Wyślij” pozostanie nieaktywny.
          </p>
        )}
      </SectionCard>

      <SectionCard
        id="test"
        title="Test"
        description="Sprawdź połączenie z serwerem, zanim ktoś kliknie „Wyślij” przy prawdziwym zleceniu."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="mail-test-to" className="text-sm font-medium">
              Adres odbiorcy
            </Label>
            <Input
              id="mail-test-to"
              data-testid="mail-test-to"
              className="w-72"
              value={testTo}
              placeholder="puste = adres nadawcy"
              onChange={(e) => setTestTo(e.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            data-testid="mail-test-run"
            disabled={testBusy || unavailable}
            onClick={() => void runTest()}
          >
            {testBusy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="mr-1 h-4 w-4" aria-hidden />
            )}
            Wyślij wiadomość testową
          </Button>
        </div>

        {dirtyCount > 0 && (
          <p className="text-xs text-muted-foreground">
            Test używa ustawień zapisanych w bazie — zapisz zmiany, żeby sprawdzić nowe.
          </p>
        )}
        {testError && <ErrorBox>{testError}</ErrorBox>}
        {testResult && (
          <div
            className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400"
            role="status"
            data-testid="mail-test-result"
          >
            {testResult}
          </div>
        )}
      </SectionCard>

      <SectionCard
        id="historia"
        title="Historia wysyłek"
        description="Każda próba — udana i nieudana. Kliknij czerwony badge, żeby zobaczyć powód błędu."
      >
        {logError ? (
          <p className="text-sm text-muted-foreground" data-testid="mail-log-error">
            {logError}
          </p>
        ) : logLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytywanie…
          </div>
        ) : (
          <>
            <MailLogTable
              items={log}
              testid="mail-log"
              emptyText="Nic jeszcze nie wysłano z tej aplikacji."
            />
            {logTotal > LOG_PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2 pt-1 text-sm text-muted-foreground">
                <span className="tabular-nums">
                  Strona {logPage} z {logPages} · {logTotal} wpisów
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="mail-log-prev"
                    disabled={logOffset === 0}
                    onClick={() => setLogOffset((o) => Math.max(0, o - LOG_PAGE_SIZE))}
                  >
                    Poprzednia
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="mail-log-next"
                    disabled={logOffset + LOG_PAGE_SIZE >= logTotal}
                    onClick={() => setLogOffset((o) => o + LOG_PAGE_SIZE)}
                  >
                    Następna
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </SectionCard>

      {dirtyCount > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur lg:left-64"
          role="region"
          aria-label="Niezapisane zmiany"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="text-sm">
              <span className="font-medium">Niezapisane zmiany</span>{" "}
              <span className="text-muted-foreground">
                ({dirtyCount} {dirtyCount === 1 ? "pole" : dirtyCount < 5 ? "pola" : "pól"})
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft({});
                  setPassword("");
                }}
                disabled={saving}
              >
                Odrzuć
              </Button>
              <Button
                type="button"
                data-testid="mail-settings-save"
                onClick={() => void save()}
                disabled={saving || unavailable || hasFieldErrors}
                {...(unavailable
                  ? tip("Backend nie obsługuje jeszcze zapisu ustawień poczty")
                  : hasFieldErrors
                    ? tip("Popraw niepoprawne adresy e-mail")
                    : {})}
              >
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} Zapisz
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={importOpen} onOpenChange={setImportOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-indigo-600" aria-hidden />
              Pobrać ustawienia SMTP z CMA?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Host, port, szyfrowanie i użytkownik zostaną nadpisane wartościami z „CMA → Ustawienia”.
              Zmiana zapisuje się od razu — niezapisany szkic powyżej przepadnie.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              data-testid="mail-import-cma-confirm"
              disabled={importing}
              onClick={(e) => {
                e.preventDefault();
                void runImportCma();
              }}
            >
              {importing && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
              Pobierz
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
