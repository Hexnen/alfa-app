import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeftRight,
  Bell,
  ChevronRight,
  Download,
  HardHat,
  LogOut,
  Moon,
  Phone,
  RefreshCw,
  Share,
  Sparkles,
  Sun,
  SunMoon,
  User,
} from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { TECHNIK_VERSION } from "@/lib/version";
import { cn } from "@/lib/utils";
import { useTechnikAccess } from "../lib/access";
import { useTechnikMe } from "../lib/me";
import {
  unsubscribePushOnLogout,
  useInstallPrompt,
  usePushNotifications,
  useTechnikUpdateState,
} from "../lib/pwa";
import { SegmentedControl } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { useToast } from "../ui/toast";
import { useTechnikTheme, type TechnikTheme } from "../lib/theme";

/**
 * WIĘCEJ — szuflada, do której wchodzi się raz na tydzień.
 *
 * Lista w stylu iOS: wiersze 48 px, wartość po prawej, strzałka tylko tam,
 * gdzie naprawdę coś się otwiera. Wersja panelu (`TECHNIK_VERSION`, NIE wersja
 * CRM-a) jest tu, bo to jedyne miejsce, gdzie technik może ją odczytać przez
 * telefon, gdy coś nie działa.
 */
export function Wiecej() {
  const { user, logout } = useAuth();
  const { isTechnikRole } = useTechnikAccess();
  const { me } = useTechnikMe();
  const update = useTechnikUpdateState();

  /**
   * Wylogowanie ZABIERA ZE SOBĄ powiadomienia. Tablet brygady przechodzi
   * z rąk do rąk, a subskrypcja push żyje w przeglądarce, nie w sesji — bez
   * tego następny technik dostawałby na to urządzenie zlecenia poprzednika.
   * Sprzątanie idzie PRZED `logout()`, bo DELETE wymaga ważnej sesji; jego
   * niepowodzenie niczego nie blokuje.
   */
  const signOut = async () => {
    await unsubscribePushOnLogout();
    await logout();
  };

  const tech = me?.technician;
  const technicianName = tech ? `${tech.firstName} ${tech.lastName}`.trim() : null;
  // Podwykonawca ma widzieć wprost, na jakich zasadach jest w systemie —
  // od tego zależy, czego biuro od niego oczekuje przy protokole.
  const technicianKind = tech
    ? tech.type === "internal"
      ? "wewnętrzny"
      : // Przy podwykonawcy nazwa firmy mówi więcej niż samo słowo
        // „podwykonawca” — to ona figuruje na papierach.
        tech.company
        ? `podwykonawca (${tech.company})`
        : "podwykonawca"
    : null;

  return (
    <div className="space-y-5">
      <Group title="Konto">
        <Row icon={User} label="Użytkownik" value={user?.displayName || user?.email || "—"} />
        <Row
          icon={HardHat}
          label="Powiązany technik"
          value={
            technicianName ? (
              <span>
                {technicianName}
                <span className="text-muted-foreground"> · {technicianKind}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">brak powiązania</span>
            )
          }
        />
        {tech?.phone && <Row icon={Phone} label="Telefon" value={tech.phone} />}
      </Group>

      {!me?.linked && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          To konto nie jest połączone z kartoteką Technicy, więc lista zleceń zostanie pusta.
          Poproś administratora o powiązanie.
        </p>
      )}

      <TabletGroup />

      <WygladGroup />

      <Group title="Aplikacja">
        <LinkRow
          icon={Sparkles}
          label="Co nowego"
          value={`v${TECHNIK_VERSION}`}
          to="/technik/co-nowego"
        />
        {/* Toast z nową wersją da się odrzucić i sam nie wraca, a technik
            potrafi chodzić na starym buildzie tygodniami. Ten wiersz stoi,
            dopóki nowa wersja czeka na aktywację. */}
        {update.updateReady && (
          <button
            type="button"
            onClick={update.applyUpdate}
            data-testid="technik-nowa-wersja"
            className={cn(
              ROW,
              "w-full text-left active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          >
            <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 font-medium">Dostępna nowa wersja</span>
            <span className="ml-auto text-sm text-muted-foreground">Odśwież</span>
          </button>
        )}
        {/* Konto biurowe z dostępem do panelu musi mieć drogę powrotną; rola
            `technik` widzi wyłącznie `/technik`, więc jej tego nie pokazujemy. */}
        {!isTechnikRole && (
          <LinkRow icon={ArrowLeftRight} label="Wróć do CRM" to="/" />
        )}
      </Group>

      <button
        type="button"
        onClick={() => void signOut()}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-card px-4 text-base font-medium text-destructive active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LogOut className="h-5 w-5" aria-hidden />
        Wyloguj
      </button>
    </div>
  );
}

/**
 * NA TABLECIE — instalacja panelu i powiadomienia o zleceniach.
 *
 * Kolejność wierszy nie jest przypadkowa: na iPhonie i iPadzie Safari daje
 * `PushManager` WYŁĄCZNIE aplikacji dodanej do ekranu początkowego (iOS 16.4+),
 * więc instalacja musi stać NAD powiadomieniami — inaczej technik klika
 * przełącznik, dostaje „niedostępne” i nie wie dlaczego.
 *
 * Cała sekcja znika, gdy nie ma czego pokazać: panel jest już zainstalowany,
 * a serwer nie ma kluczy VAPID.
 */
function TabletGroup() {
  const install = useInstallPrompt();
  const push = usePushNotifications();
  const { toast, toastError } = useToast();
  const [iosHint, setIosHint] = useState(false);

  const showInstall = !install.standalone && (install.canPrompt || install.ios);
  // Wiersz powiadomień chowamy tylko wtedy, gdy serwer ich nie umie wysłać —
  // „niedostępne na tym urządzeniu” to informacja, nie powód do ukrywania.
  const showPush = push.blocker !== "server";
  if (!showInstall && !showPush) return null;

  const pushNote =
    push.blocker === "unsupported"
      ? install.ios && !install.standalone
        ? "Na iPadzie i iPhonie działa dopiero po dodaniu panelu do ekranu początkowego (iOS 16.4 lub nowszy)."
        : "Ta przeglądarka nie obsługuje powiadomień."
      : push.blocker === "denied"
        ? "Powiadomienia są zablokowane w ustawieniach przeglądarki dla tej strony."
        : null;

  return (
    <section>
      <h2 className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Na tablecie
      </h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {showInstall && (
          <button
            type="button"
            onClick={() => {
              // iOS nie ma API instalacji — zostaje pokazanie, gdzie kliknąć.
              if (!install.canPrompt) {
                setIosHint((v) => !v);
                return;
              }
              void install.promptInstall().then((accepted) => {
                if (accepted) toast({ message: "Panel dodany do ekranu głównego", kind: "success" });
              });
            }}
            className={cn(ROW, "w-full text-left active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
          >
            <Download className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 font-medium">Zainstaluj na ekranie głównym</span>
            <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        )}

        {showInstall && iosHint && (
          <p className="flex items-start gap-2 px-3 py-2.5 text-sm text-muted-foreground">
            <Share className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              W Safari dotknij <strong className="font-medium text-foreground">Udostępnij</strong>, a
              potem <strong className="font-medium text-foreground">Do ekranu początkowego</strong>.
            </span>
          </p>
        )}

        {showPush && (
          <>
            <div className={ROW}>
              <Bell className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="shrink-0 font-medium">Powiadomienia o zleceniach</span>
              <span className="ml-auto flex items-center gap-2">
                {push.blocker != null && (
                  <span className="text-xs text-muted-foreground">niedostępne</span>
                )}
                <Switch
                  label="Powiadomienia o zleceniach"
                  checked={push.enabled}
                  busy={push.busy}
                  disabled={push.loading || push.blocker != null}
                  onCheckedChange={(next) => {
                    void push.toggle(next).then((error) => {
                      if (error) toastError(error);
                      else if (next) toast({ message: "Powiadomienia włączone", kind: "success" });
                    });
                  }}
                />
              </span>
            </div>
            {pushNote && <p className="px-3 py-2.5 text-sm text-muted-foreground">{pushNote}</p>}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * WYGLĄD — jasny / ciemny / systemowy.
 *
 * Panel bywa otwierany o 6 rano pod bramą i o 22 w aucie; biały ekran w nocy
 * to jedyna rzecz, przez którą technik odkłada tablet. Wybór trzyma
 * `localStorage` (`technik.theme`), klasę `dark` zakłada i zdejmuje
 * `TechnikShell` — CRM po wyjściu z panelu zostaje jasny.
 */
const THEME_OPTIONS: { value: TechnikTheme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Jasny", icon: Sun },
  { value: "dark", label: "Ciemny", icon: Moon },
  { value: "system", label: "Systemowy", icon: SunMoon },
];

function WygladGroup() {
  const [theme, setTheme] = useTechnikTheme();

  return (
    <section>
      <h2 className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Wygląd
      </h2>
      <div className="overflow-hidden rounded-xl border bg-card p-3">
        <SegmentedControl<TechnikTheme>
          label="Motyw panelu"
          value={theme}
          onChange={setTheme}
          dense
          options={THEME_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            icon: o.icon,
            "data-testid": `technik-motyw-${o.value}`,
          }))}
        />
      </div>
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  );
}

const ROW = "flex min-h-12 items-center gap-3 px-3 text-sm";

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof User;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className={ROW}>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  );
}

function LinkRow({
  icon: Icon,
  label,
  value,
  to,
}: {
  icon: typeof User;
  label: string;
  value?: ReactNode;
  to: string;
}) {
  return (
    <Link
      to={to}
      className={cn(ROW, "active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-medium">{label}</span>
      {value && <span className="ml-auto tabular-nums text-muted-foreground">{value}</span>}
      <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground", !value && "ml-auto")} aria-hidden />
    </Link>
  );
}
