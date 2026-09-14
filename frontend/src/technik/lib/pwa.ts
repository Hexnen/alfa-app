import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { technikApi, type TechnikPushConfig } from "@/lib/api";
import { APP_VERSION, TECHNIK_VERSION } from "@/lib/version";

/**
 * PWA PANELU TECHNIKA — manifest, service worker, instalacja, push.
 *
 * DLACZEGO DYNAMICZNIE, A NIE W `index.html`. Jeden build Vite serwuje dwie
 * aplikacje: biurowy CRM i panel technika. Manifest wpięty na stałe w `<head>`
 * zrobiłby instalowalny CAŁY CRM — łącznie z kalendarzem, magazynem i panelem
 * admina, których nikt nie chce mieć jako ikonę na telefonie. Dlatego `<link
 * rel="manifest">` i meta tagi wchodzą przy montowaniu `TechnikApp`, a wychodzą
 * przy odmontowaniu (konto biurowe klika „Wróć do CRM" i nagłówek ma zniknąć).
 */

/** Granat z `technik.webmanifest` — musi być 1:1 z `theme_color`. */
const THEME_COLOR = "#002158";

/**
 * Scope workera i manifestu. BEZ końcowego ukośnika, bo dopasowanie scope to
 * prefiks ścieżki, a `/technik` (czyli `start_url`) nie zaczyna się od
 * `/technik/` — panel otwarty pod gołym `/technik` zostałby bez kontrolera.
 */
const SCOPE = "/technik";

/**
 * Adres workera z wersją panelu I wersją CRM-a: nowa wersja = nowy plik = nowe
 * cache. Sam `TECHNIK_VERSION` nie wystarczał — wydanie samego CRM-a zmienia
 * hashe w `/assets/*`, a worker z tą samą nazwą cache'u zostawał na starych
 * plikach (w SW nie ma `import.meta.env`, więc hash builda wjeżdża tu z URL-a).
 * `APP_VERSION` rośnie przy KAŻDYM wydaniu, więc działa jak znacznik builda.
 */
const SW_VERSION = `${TECHNIK_VERSION}-${APP_VERSION}`;
const SW_URL = `/technik-sw.js?v=${encodeURIComponent(SW_VERSION)}`;

// ---------------------------------------------------------------------------
// <head>: manifest i meta tagi
// ---------------------------------------------------------------------------

/** Tagi wstrzykiwane na czas życia panelu; klucz `data-technik-pwa` je oznacza. */
const HEAD_TAGS: { tag: "link" | "meta"; attrs: Record<string, string> }[] = [
  { tag: "link", attrs: { rel: "manifest", href: "/technik.webmanifest" } },
  { tag: "meta", attrs: { name: "theme-color", content: THEME_COLOR } },
  // iOS nadal nie czyta manifestu przy „Do ekranu początkowego" — tryb
  // pełnoekranowy, tytuł pod ikoną i sama ikona idą z tych trzech tagów.
  { tag: "meta", attrs: { name: "apple-mobile-web-app-capable", content: "yes" } },
  { tag: "meta", attrs: { name: "apple-mobile-web-app-title", content: "Technik" } },
  // `default`, nie `black-translucent`: przy translucent treść wchodzi POD pasek
  // stanu iPada i pierwsza pozycja listy ląduje za zegarem. Tu pasek zostaje
  // nieprzezroczysty, a `env(safe-area-inset-top)` w layoucie i tak pilnuje notcha.
  { tag: "meta", attrs: { name: "apple-mobile-web-app-status-bar-style", content: "default" } },
  { tag: "link", attrs: { rel: "apple-touch-icon", href: "/technik-icon-192.png" } },
  { tag: "link", attrs: { rel: "apple-touch-icon", sizes: "192x192", href: "/technik-icon-192.png" } },
];

/** Wpina manifest i meta tagi panelu na czas życia komponentu. */
export function useTechnikPwaHead(): void {
  useEffect(() => {
    const created: Element[] = [];
    for (const { tag, attrs } of HEAD_TAGS) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      el.setAttribute("data-technik-pwa", "");
      document.head.appendChild(el);
      created.push(el);
    }
    return () => {
      for (const el of created) el.remove();
    };
  }, []);
}

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

export interface TechnikSwState {
  /** Nowa wersja panelu pobrana i czeka na aktywację. */
  updateReady: boolean;
  /** Aktywuje czekającego workera i przeładowuje stronę. */
  applyUpdate: () => void;
}

/**
 * Rejestruje workera pod `/technik` i pilnuje wersji.
 *
 * Nowy worker CELOWO czeka (`install` nie woła `skipWaiting`): podmiana pod
 * palcami technika wypełniającego protokół przeładowałaby mu ekran w połowie
 * zdania. Zamiast tego panel podnosi pasek „Dostępna nowa wersja — Odśwież”.
 */
export function useTechnikServiceWorker(): TechnikSwState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const reloading = useRef(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;

    /**
     * Czy panelem JUŻ COŚ sterowało, zanim zarejestrowaliśmy workera.
     *
     * Przy PIERWSZYM wejściu kontrolera nie ma, a nowy worker robi
     * `clients.claim()` w `activate` — `controllerchange` przychodzi wtedy
     * sekundę po wejściu i przeładowywał technikowi ekran bez powodu (i gubił
     * to, co zdążył stuknąć). Reload ma sens WYŁĄCZNIE przy podmianie starego
     * workera na nowy, czyli gdy kontroler już był.
     */
    const hadController = navigator.serviceWorker.controller != null;

    // Przeładowanie dopiero PO przejęciu kontroli przez nowego workera —
    // inaczej strona wstałaby jeszcze na starych zasobach.
    const onControllerChange = () => {
      if (!hadController || reloading.current) return;
      reloading.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    void navigator.serviceWorker
      .register(SW_URL, { scope: SCOPE })
      .then((reg) => {
        if (cancelled) return;
        if (reg.waiting) setWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const next = reg.installing;
          if (!next) return;
          next.addEventListener("statechange", () => {
            // `controller` istnieje tylko wtedy, gdy coś już panelem sterowało —
            // przy PIERWSZEJ instalacji nie ma o czym informować.
            if (next.state === "installed" && navigator.serviceWorker.controller) setWaiting(next);
          });
        });
      })
      .catch(() => {
        // Brak HTTPS, wyłączone SW w ustawieniach, prywatne okno — panel działa
        // dalej, tyle że bez trybu offline. To nie jest błąd do pokazania.
      });

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (!waiting) {
      window.location.reload();
      return;
    }
    waiting.postMessage({ type: "SKIP_WAITING" });
  }, [waiting]);

  // Ten sam stan czyta wiersz „Dostępna nowa wersja” w „Więcej”. Drugie
  // wywołanie hooka rejestrowałoby workera po raz drugi, więc zamiast tego
  // zapisujemy stan do wspólnego pudełka pod modułem.
  useEffect(() => {
    setUpdateState({ updateReady: waiting != null, applyUpdate });
  }, [waiting, applyUpdate]);

  return { updateReady: waiting != null, applyUpdate };
}

/* --------------------------------------------------------------------- *
 * Stan wydania do odczytu spoza `TechnikUpdateWatcher`
 * --------------------------------------------------------------------- */

const NO_UPDATE: TechnikSwState = {
  updateReady: false,
  applyUpdate: () => window.location.reload(),
};

let updateState: TechnikSwState = NO_UPDATE;
const updateListeners = new Set<() => void>();

function setUpdateState(next: TechnikSwState): void {
  if (next.updateReady === updateState.updateReady && next.applyUpdate === updateState.applyUpdate) {
    return;
  }
  updateState = next;
  for (const l of updateListeners) l();
}

function subscribeUpdate(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

/**
 * Stan wydania BEZ rejestrowania workera — do wiersza w „Więcej”. Toast po
 * odrzuceniu znika, a technik, który go przegapił, musi mieć gdzie sprawdzić,
 * że nowa wersja czeka.
 */
export function useTechnikUpdateState(): TechnikSwState {
  return useSyncExternalStore(
    subscribeUpdate,
    () => updateState,
    () => NO_UPDATE,
  );
}

// ---------------------------------------------------------------------------
// Instalacja na ekranie głównym
// ---------------------------------------------------------------------------

/** Zdarzenie Chromium; w lib.dom go nie ma, bo nie jest w żadnym standardzie. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Czy panel chodzi już jako zainstalowana aplikacja (bez paska adresu). */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // Starsze Safari na iOS — własna, niestandardowa flaga.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS/iPadOS (także iPad udający macOS — stąd druga część warunku). */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export interface InstallState {
  /** Panel już jest zainstalowany — wiersz „Zainstaluj" nie ma się pokazywać. */
  standalone: boolean;
  /** Android/Chromium przysłał `beforeinstallprompt` — da się zainstalować jednym kliknięciem. */
  canPrompt: boolean;
  /** iOS: instalacji nie da się wywołać z kodu, zostaje instrukcja. */
  ios: boolean;
  /** Wywołuje systemowy prompt; zwraca `true`, gdy użytkownik się zgodził. */
  promptInstall: () => Promise<boolean>;
}

export function useInstallPrompt(): InstallState {
  const deferred = useRef<BeforeInstallPromptEvent | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);
  const [standalone, setStandalone] = useState(() => isStandalone());

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      // Bez `preventDefault()` Chrome pokazuje własny pasek u dołu ekranu —
      // a my chcemy ten sam wybór mieć w liście „Więcej".
      e.preventDefault();
      deferred.current = e as BeforeInstallPromptEvent;
      setCanPrompt(true);
    };
    const onInstalled = () => {
      deferred.current = null;
      setCanPrompt(false);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // Instalacja z menu przeglądarki nie odpala `appinstalled` w każdej wersji —
    // media query pilnuje stanu także wtedy.
    const mq = window.matchMedia?.("(display-mode: standalone)");
    const onDisplayMode = () => setStandalone(isStandalone());
    mq?.addEventListener?.("change", onDisplayMode);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      mq?.removeEventListener?.("change", onDisplayMode);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    const evt = deferred.current;
    if (!evt) return false;
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    // Zdarzenia da się użyć RAZ — drugi prompt wymaga nowego `beforeinstallprompt`.
    deferred.current = null;
    setCanPrompt(false);
    return outcome === "accepted";
  }, []);

  return { standalone, canPrompt, ios: isIos(), promptInstall };
}

// ---------------------------------------------------------------------------
// Powiadomienia push
// ---------------------------------------------------------------------------

/**
 * Base64URL (klucz VAPID) → bajty, czyli to, czego chce `applicationServerKey`.
 * Jawny `ArrayBuffer` zamiast `Uint8Array`: typ `Uint8Array<ArrayBufferLike>`
 * z nowszego lib.dom nie wchodzi w `BufferSource` (mógłby siedzieć na
 * `SharedArrayBuffer`), a bufor pod spodem i tak jest zwykły.
 */
function urlBase64ToBytes(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/** Bajty klucza (`applicationServerKey` z subskrypcji) → Base64URL do porównania. */
function bytesToUrlBase64(buf: ArrayBuffer | null | undefined): string | null {
  if (!buf) return null;
  const view = new Uint8Array(buf);
  let raw = "";
  for (let i = 0; i < view.length; i++) raw += String.fromCharCode(view[i]);
  return normalizeKey(btoa(raw));
}

/** Base64 i Base64URL mają opisywać ten sam klucz — porównujemy po jednej postaci. */
function normalizeKey(key: string): string {
  return key.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Czy subskrypcja z przeglądarki jest podpisana TYM kluczem VAPID, który
 * serwer ma teraz. Po rotacji pary kluczy stara subskrypcja dalej wygląda na
 * ważną, ale push wysłany nowym kluczem dostaje 403 — technik siedzi
 * z przełącznikiem „włączone” i nie dostaje niczego. Brak `options` (starsze
 * Safari) = nie mamy czego porównać, więc zostawiamy subskrypcję w spokoju.
 */
function matchesServerKey(sub: PushSubscription, publicKey: string): boolean {
  const current = bytesToUrlBase64(sub.options?.applicationServerKey ?? null);
  return current == null || current === normalizeKey(publicKey);
}

/**
 * Sprząta subskrypcję przy WYLOGOWANIU: najpierw z przeglądarki, potem z bazy.
 *
 * Bez tego tablet oddany drugiemu technikowi dalej wisi pod kontem pierwszego —
 * endpoint zostaje w `push_subscriptions`, a powiadomienia o CUDZYCH zleceniach
 * lecą na to samo urządzenie. Błędy są tu bez znaczenia (wylogowanie musi
 * pójść), stąd wszystko w `catch`.
 */
export async function unsubscribePushOnLogout(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const reg = await navigator.serviceWorker.getRegistration(SCOPE);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const { endpoint } = sub;
    await sub.unsubscribe().catch(() => false);
    // DELETE MUSI pójść jeszcze na ważnej sesji — stąd przed `logout()`.
    await technikApi.pushUnsubscribe(endpoint).catch(() => {});
  } catch {
    /* brak SW, prywatne okno — wylogowanie i tak ma się udać */
  }
}

/** Dlaczego przełącznik powiadomień jest nieczynny (albo `null` — jest czynny). */
export type PushBlocker =
  /** Przeglądarka nie zna Web Push (iOS < 16.4, panel otwarty w karcie Safari). */
  | "unsupported"
  /** Serwer nie ma kluczy VAPID. */
  | "server"
  /** Użytkownik zablokował powiadomienia w ustawieniach przeglądarki. */
  | "denied";

export interface PushState {
  /** Subskrypcja istnieje i serwer o niej wie. */
  enabled: boolean;
  /** Trwa zapytanie o zgodę / zapis subskrypcji. */
  busy: boolean;
  /** Stan początkowy jeszcze się wczytuje. */
  loading: boolean;
  blocker: PushBlocker | null;
  /** Włącza albo wyłącza powiadomienia; zwraca komunikat błędu lub `null`. */
  toggle: (next: boolean) => Promise<string | null>;
}

/**
 * Przełącznik „Powiadomienia o zleceniach”.
 *
 * OGRANICZENIE iOS, o które zawsze ktoś pyta: Safari na iPhonie i iPadzie
 * wystawia `PushManager` WYŁĄCZNIE aplikacji dodanej do ekranu początkowego
 * (iOS/iPadOS 16.4+). W zwykłej karcie `"PushManager" in window` jest fałszem,
 * więc wiersz pokazuje się jako niedostępny z wyjaśnieniem — i dlatego
 * instalacja panelu stoi w liście NAD powiadomieniami.
 */
export function usePushNotifications(): PushState {
  const [config, setConfig] = useState<TechnikPushConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(() => typeof Notification !== "undefined" && Notification.permission === "denied");

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await technikApi.pushConfig();
        if (cancelled) return;
        setConfig(cfg);
        if (!supported || !cfg.enabled) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (!sub || Notification.permission !== "granted") {
          setEnabled(false);
          return;
        }
        // Subskrypcja w przeglądarce to ZA MAŁO: na tablecie brygady zostaje po
        // poprzednim techniku, a wiersz w bazie ma jego `user_id` — przełącznik
        // pokazywałby „włączone”, a powiadomienia leciałyby pod cudze konto.
        // Źródłem prawdy jest serwer: `subscribed` tylko dla WŁASNEGO wiersza.
        // Przy `false` włączenie zrobi POST, który przepisze właściciela.
        const mine = await technikApi.pushStatus(sub.endpoint).catch(() => false);
        if (!cancelled) setEnabled(mine);
      } catch {
        if (!cancelled) setConfig({ enabled: false, publicKey: null });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const toggle = useCallback(
    async (next: boolean): Promise<string | null> => {
      if (!supported || !config?.enabled || !config.publicKey) return "Powiadomienia są niedostępne";
      setBusy(true);
      try {
        const reg = await navigator.serviceWorker.ready;
        if (!next) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            // Najpierw serwer, potem przeglądarka: gdyby kolejność była odwrotna
            // i DELETE padł, w bazie zostałby endpoint, którego już nie ma komu
            // odwołać — i technik dalej dostawałby powiadomienia.
            await technikApi.pushUnsubscribe(sub.endpoint);
            await sub.unsubscribe();
          }
          setEnabled(false);
          return null;
        }

        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setDenied(permission === "denied");
          return permission === "denied"
            ? "Powiadomienia są zablokowane w ustawieniach przeglądarki"
            : "Zgoda na powiadomienia nie została udzielona";
        }

        let sub = await reg.pushManager.getSubscription();
        // Po rotacji kluczy VAPID stara subskrypcja jest bezużyteczna (push
        // dostaje 403), a wygląda na dobrą — dlatego zanim jej użyjemy,
        // sprawdzamy, czy niesie klucz, który serwer ma TERAZ.
        if (sub && !matchesServerKey(sub, config.publicKey)) {
          await sub.unsubscribe().catch(() => false);
          sub = null;
        }
        sub ??= await reg.pushManager.subscribe({
          // Wymagane przez Chrome: subskrypcja BEZ widocznego powiadomienia
          // jest odrzucana. Panel i tak pokazuje każde zdarzenie.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBytes(config.publicKey),
        });
        await technikApi.pushSubscribe(sub.toJSON() as PushSubscriptionJSON);
        setEnabled(true);
        return null;
      } catch (err) {
        // Komunikat przeglądarki jest po angielsku i techniczny („Registration
        // failed - permission denied”) — technik ma dostać jedno polskie zdanie,
        // a szczegół zostaje w konsoli.
        console.warn("[push] toggle:", err);
        return "Nie udało się włączyć powiadomień. Sprawdź, czy przeglądarka nie blokuje ich dla tej strony.";
      } finally {
        setBusy(false);
      }
    },
    [config, supported]
  );

  const blocker: PushBlocker | null = !supported
    ? "unsupported"
    : config != null && !config.enabled
      ? "server"
      : denied
        ? "denied"
        : null;

  return { enabled, busy, loading, blocker, toggle };
}
