/**
 * Instrukcja instalacji wtyczki „Dodaj do towarów Alfa” + zarządzanie tokenem.
 *
 * Dlaczego to jest dialog z instrukcją, a nie zwykły link do pliku: wtyczka
 * wchodzi przez „Załaduj rozpakowane” (Chrome/Edge, tryb dewelopera), więc
 * użytkownik MUSI wiedzieć trzy rzeczy, których nie zgadnie sam — że katalog
 * z rozpakowaną paczką musi zostać na dysku, że wtyczkę wczytuje się z
 * `chrome://extensions`, i że paczka niesie jego osobisty token.
 *
 * Pobranie paczki działa z uprawnieniem „podgląd” (to tylko instalacja u
 * siebie), ale rotacja i unieważnienie tokenu wymagają „edycji” — to zmiana
 * stanu konta, która potrafi odciąć wtyczkę innym urządzeniom tej osoby.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Download,
  Globe,
  KeyRound,
  Loader2,
  Puzzle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { warehouseApi, type PluginShopInfo, type PluginTokenInfo } from "@/lib/api";
import { tip } from "@/components/ui/tooltip";
import { fmtTimestamp, pillClass } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";

interface PluginDialogProps {
  open: boolean;
  onClose: () => void;
  /** Uprawnienie „edycja” w zakładce Magazyn — bramkuje rotację i unieważnienie. */
  editable: boolean;
}

const alertError = (err: unknown, fallback: string) =>
  window.alert(err instanceof Error ? err.message : fallback);

/**
 * „Link” do `chrome://extensions` / `edge://extensions`.
 *
 * Wygląda i zachowuje się jak link, ale nim NIE jest w sensie nawigacji:
 * przeglądarki blokują przejście do schematów `chrome://` i `edge://` ze
 * zwykłej strony — klik w `<a href="chrome://extensions">` jest po cichu
 * ignorowany (bez błędu, bez nowej karty), `window.open` również. Jedyne, co
 * naprawdę pomaga użytkownikowi, to wrzucić adres do schowka i powiedzieć
 * wprost, że trzeba go wkleić w pasku adresu — dlatego `preventDefault`
 * i kopiowanie. `href` zostaje, bo daje właściwy kursor, menu kontekstowe
 * („kopiuj adres linku”) i sens dla czytników ekranu.
 */
function BrowserUrl({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 3000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
    } catch {
      // Schowek bywa niedostępny (brak zgody, kontekst nie-HTTPS) — wtedy
      // przynajmniej pokazujemy adres do przepisania.
      window.alert(`Wpisz w pasku adresu przeglądarki:\n\n${addr}`);
    }
  };

  return (
    <>
      <a
        href={addr}
        className="rounded bg-muted px-1 font-mono text-primary underline underline-offset-2"
        {...tip(
          "Przeglądarka nie pozwala otwierać tego adresu ze strony — klik kopiuje go do schowka"
        )}
        onClick={(e) => {
          e.preventDefault();
          void copy();
        }}
      >
        {addr}
      </a>
      {copied && (
        <span className="ml-1 whitespace-nowrap text-xs text-emerald-700 dark:text-emerald-300">
          Skopiowano — wklej w pasku adresu (Ctrl+L, Ctrl+V)
        </span>
      )}
    </>
  );
}

/**
 * Kroki instalacji. Trzymane jako dane (nie JSX), żeby numeracja i kolejność
 * były w jednym miejscu — tekst tych kroków to jedyna dokumentacja wtyczki,
 * jaką zobaczy użytkownik. Funkcja, a nie stała, bo krok 1 musi nazwać adres,
 * DLA KTÓREGO jest paczka (dev vs produkcja).
 */
const buildSteps = (baseUrl: string | null): { title: string; body: ReactNode }[] => [
  {
    title: baseUrl ? `Pobierz paczkę dla ${baseUrl}` : "Pobierz paczkę",
    body: (
      <>
        Plik <code className="rounded bg-muted px-1">alfa-magazyn-wtyczka.zip</code> ma
        już wpisany adres tej aplikacji i Twój token — nic nie trzeba
        konfigurować.
      </>
    ),
  },
  {
    title: "Rozpakuj do stałego katalogu",
    body: (
      <>
        Na przykład{" "}
        <code className="rounded bg-muted px-1">Dokumenty\alfa-wtyczka</code>.
        Katalog <strong>musi zostać na dysku</strong> — Chrome wczytuje wtyczkę
        z tych plików przy każdym uruchomieniu, więc po usunięciu katalogu
        wtyczka przestanie działać.
      </>
    ),
  },
  {
    title: "Wczytaj wtyczkę w przeglądarce",
    body: (
      <>
        Wejdź na <BrowserUrl addr="chrome://extensions" /> (w Edge:{" "}
        <BrowserUrl addr="edge://extensions" />), włącz{" "}
        <strong>Tryb dewelopera</strong> (prawy górny róg) i kliknij{" "}
        <strong>Załaduj rozpakowane</strong>, wskazując katalog z kroku 2.
      </>
    ),
  },
  {
    title: "Wejdź na stronę produktu w sklepie",
    body: (
      <>
        W prawym górnym rogu pojawi się panel wtyczki z przyciskiem{" "}
        <strong>„Dodaj do towarów Alfa”</strong> (przełączy na tę kartę z
        wypełnionym formularzem) i mniejszym{" "}
        <strong>„Dodaj do kolejki”</strong> (zostawia Cię w sklepie, wpis czeka
        w sekcji „Do dodania z wtyczki”).
      </>
    ),
  },
];

export function PluginDialog({ open, onClose, editable }: PluginDialogProps) {
  const [token, setToken] = useState<PluginTokenInfo | null>(null);
  const [shops, setShops] = useState<PluginShopInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tokenRes, shopsRes] = await Promise.all([
        warehouseApi.getPluginToken(),
        warehouseApi.getPluginShops(),
      ]);
      setToken(tokenRes.data ?? null);
      setShops(shopsRes.data || []);
    } catch (err) {
      alertError(err, "Błąd wczytywania informacji o wtyczce");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  /*
   * Adres, dla którego powstaje paczka, przychodzi RAZEM ze stanem tokenu —
   * to ta sama wartość, którą serwer wpisuje do `config.js` (helper
   * `pluginBaseUrl` w src/routes/warehouse-plugin.ts). Świadomie nie
   * odtwarzamy go z `window.location`: za proxy albo przy skonfigurowanym
   * adresie firmy jedno z drugim może się nie zgadzać, a wtedy właśnie chodzi
   * o to, żeby pokazać RÓŻNICĘ, a nie ją zamaskować.
   */
  const baseUrl = token?.baseUrl ?? null;
  const steps = buildSteps(baseUrl);

  /**
   * Po pobraniu odświeżamy stan tokenu, bo serwer zakłada go LENIWIE — przy
   * pierwszym pobraniu paczki. Bez tego dialog pokazywałby „brak tokenu”
   * zaraz po tym, jak token właśnie powstał.
   */
  const handleDownload = async () => {
    setDownloading(true);
    try {
      await warehouseApi.downloadPlugin();
      const res = await warehouseApi.getPluginToken();
      setToken(res.data ?? null);
    } catch (err) {
      alertError(err, "Nie udało się pobrać paczki wtyczki");
    } finally {
      setDownloading(false);
    }
  };

  const handleRotate = async () => {
    if (!editable) return;
    if (
      !window.confirm(
        "Wygenerować nowy token wtyczki?\n\n" +
          "Wszystkie wcześniej pobrane paczki (na każdym komputerze) przestaną " +
          "działać — trzeba będzie pobrać wtyczkę na nowo i wczytać ją ponownie."
      )
    )
      return;
    setTokenBusy(true);
    try {
      const res = await warehouseApi.rotatePluginToken();
      setToken(res.data ?? null);
    } catch (err) {
      alertError(err, "Nie udało się wygenerować nowego tokenu");
    } finally {
      setTokenBusy(false);
    }
  };

  const handleRevoke = async () => {
    if (!editable) return;
    if (
      !window.confirm(
        "Unieważnić token wtyczki?\n\n" +
          "Wtyczka przestanie się łączyć z aplikacją. Nowy token powstanie przy " +
          "kolejnym pobraniu paczki."
      )
    )
      return;
    setTokenBusy(true);
    try {
      const res = await warehouseApi.revokePluginToken();
      setToken(res.data ?? null);
    } catch (err) {
      alertError(err, "Nie udało się unieważnić tokenu");
    } finally {
      setTokenBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="sm:max-w-2xl max-h-[92vh] overflow-y-auto"
        data-testid="magazyn-wtyczka-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Puzzle className="h-5 w-5 text-muted-foreground" />
            Wtyczka „Dodaj do towarów Alfa”
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Wtyczka do Chrome i Edge: na stronie produktu w obsługiwanym sklepie
          pokazuje przycisk, który wysyła stronę do Alfa i od razu wypełnia
          kartotekę towaru (razem ze zdjęciem i ceną).
        </p>

        {/* Ostrzeżenie stoi PRZED przyciskiem pobrania — po pobraniu byłoby już
            po fakcie. */}
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          Paczka ma wpisany adres aplikacji i Twój osobisty token — nie
          przekazuj jej innym. Każdy powinien pobrać własną.
        </div>

        {/* Dla JAKIEGO adresu jest paczka. Ta ramka stoi nad krokami, bo od
            niej zależy, czy w ogóle warto pobierać: ZIP-y dla devu i produkcji
            wyglądają identycznie, a wskazują inne środowisko. Adres bierzemy
            z backendu (to samo wyrażenie, które trafia do `config.js`), a nie
            z `window.location` — proxy potrafi je rozjechać. */}
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">Paczka dla:</span>
            <code
              className="rounded bg-muted px-1 font-mono font-medium"
              data-testid="magazyn-wtyczka-baseurl"
            >
              {loading ? "…" : baseUrl ?? "(nieznany)"}
            </code>
          </div>
          {baseUrl !== null && baseUrl !== window.location.origin && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              Uwaga: to inny adres niż strona, na której jesteś (
              {window.location.origin}). Wtyczka z tej paczki będzie się łączyć
              z <strong>{baseUrl}</strong> — sprawdź, czy to właśnie to
              środowisko.
            </div>
          )}
        </div>

        <ol className="space-y-3">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">{step.title}</div>
                <div className="text-sm text-muted-foreground">{step.body}</div>
                {i === 0 && (
                  <Button
                    className="mt-1"
                    onClick={handleDownload}
                    disabled={downloading}
                    data-testid="magazyn-wtyczka-download"
                  >
                    {downloading ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-1 h-4 w-4" />
                    )}
                    {downloading ? "Pobieranie…" : "Pobierz paczkę (ZIP)"}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>

        {/* --- Token --- */}
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Token wtyczki
          </div>
          {loading ? (
            <div className="text-sm text-muted-foreground">Ładowanie…</div>
          ) : token?.hasToken ? (
            <div
              className="text-sm text-muted-foreground"
              data-testid="magazyn-wtyczka-token"
            >
              Aktywny:{" "}
              <code className="rounded bg-muted px-1 font-mono">
                {token.masked}
              </code>
              {token.createdAt ? ` — wydany ${fmtTimestamp(token.createdAt)}` : ""}
            </div>
          ) : (
            <div
              className="text-sm text-muted-foreground"
              data-testid="magazyn-wtyczka-token"
            >
              Brak tokenu — powstanie automatycznie przy pierwszym pobraniu
              paczki.
            </div>
          )}
          {editable ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRotate}
                disabled={tokenBusy || loading}
                data-testid="magazyn-wtyczka-token-rotate"
              >
                <RefreshCw className="mr-1 h-4 w-4" /> Wygeneruj nowy
              </Button>
              {token?.hasToken && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={handleRevoke}
                  disabled={tokenBusy}
                  data-testid="magazyn-wtyczka-token-revoke"
                >
                  <Trash2 className="mr-1 h-4 w-4" /> Unieważnij
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                Nowy token unieważnia wszystkie pobrane wcześniej paczki.
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Zmiana tokenu wymaga uprawnienia do edycji magazynu.
            </p>
          )}
        </div>

        {/* --- Obsługiwane sklepy --- */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Obsługiwane sklepy</div>
          {loading ? (
            <div className="text-sm text-muted-foreground">Ładowanie…</div>
          ) : shops.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Brak sklepów w rejestrze parserów.
            </div>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="magazyn-wtyczka-sklepy">
              {shops.map((s) => (
                <li
                  key={s.shop}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{s.label}</span>
                  <span className="text-xs text-muted-foreground">{s.shop}</span>
                  <span
                    className={cn(
                      "ml-auto",
                      pillClass(s.calibrated ? "emerald" : "amber")
                    )}
                  >
                    {s.calibrated ? "parser dedykowany" : "do kalibracji"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            „Do kalibracji” = parser dostał sklep do obsługi, ale nie
            sprawdzono go jeszcze na prawdziwej stronie — wynik importu warto
            przejrzeć pole po polu. Na innych stronach wtyczka użyje parsera
            ogólnego.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
