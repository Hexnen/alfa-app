/**
 * Pobranie zdjęcia produktu ze sklepu dostawcy (adres z `og:image` zapisanej strony).
 *
 * Dlaczego to osobny, tak nieufny moduł: adres, pod który wchodzimy, pochodzi
 * z PLIKU PRZYSŁANEGO PRZEZ UŻYTKOWNIKA. Serwer robi to żądanie ze swojej sieci,
 * czyli z wnętrza infrastruktury — bez filtra ktoś podstawiłby
 * `<meta og:image="http://127.0.0.1:4001/api/...">` albo adres metadanych chmury
 * i użyłby naszego backendu jako serwera proxy do zasobów, których sam nie widzi
 * (SSRF). Dlatego: tylko http(s), adres rozwiązany przez DNS i sprawdzony wobec
 * puli prywatnych, przekierowania obsługiwane RĘCZNIE z rewalidacją każdego
 * skoku (bo `fetch` z `redirect: "follow"` poszedłby na 127.0.0.1 bez pytania).
 *
 * Druga zasada: ta funkcja NIGDY nie rzuca i nigdy nie psuje importu. Zdjęcie
 * jest dodatkiem — gdy się nie uda, użytkownik ma dostać wypełniony formularz
 * i zdanie wyjaśniające, dlaczego bez obrazka, a nie 500 na całym parsowaniu.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import sharp from "sharp";

/** Sufit pobieranego pliku PRZED skalowaniem — dalej i tak zejdziemy do ~1 MB. */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
/** Jeden skok nie może wisieć dłużej niż 5 s — import jest interaktywny. */
const FETCH_TIMEOUT_MS = 5000;
/** Ile przekierowań wolno przejść (każde rewalidowane osobno). */
const MAX_REDIRECTS = 3;
/** Docelowa dłuższa krawędź i jakość pierwszego podejścia. */
const RESIZE_STEPS: { width: number; quality: number }[] = [
  { width: 800, quality: 80 },
  { width: 800, quality: 60 },
  { width: 600, quality: 50 },
];

export interface ProductImageResult {
  /** data-URL JPEG gotowy do `warehouse_items.photo_data`, albo null. */
  photoData: string | null;
  /** Zdanie dla użytkownika, gdy zdjęcia NIE ma (null, gdy jest). */
  warning: string | null;
}

/**
 * Czy adres IP należy do puli, do której backend nie ma prawa wchodzić na
 * życzenie pliku użytkownika. Świadomie lista ZAKAZÓW, nie zezwoleń: pomyłka
 * w stronę „odrzuć” kosztuje brak miniaturki, pomyłka w drugą stronę — dostęp
 * do wnętrza sieci.
 */
function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true; // nie potrafimy ocenić → nie wchodzimy
}

function isBlockedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 („ten host”; 0.0.0.0 to localhost w Linuksie)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (metadane chmury!)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const s = ip.toLowerCase().split("%")[0]; // bez identyfikatora strefy
  if (s === "::" || s === "::1") return true; // nieokreślony + loopback
  // Adresy IPv4 zamapowane („::ffff:10.0.0.1”) oceniamy jako IPv4 — inaczej
  // filtr v6 przepuściłby loopback zapisany w tej formie.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isBlockedIPv4(mapped[1]);
  const head = parseInt(s.split(":")[0] || "0", 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Walidacja jednego adresu przed żądaniem: schemat + wszystkie adresy IP,
 * na które rozwiązuje się host. Sprawdzamy KAŻDY wynik DNS, bo host może
 * podać obok publicznego także 127.0.0.1 i wtedy trafienie zależy od kolejności.
 */
async function assertFetchable(u: URL): Promise<string | null> {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "Adres zdjęcia nie jest adresem http(s)";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return isBlockedAddress(host) ? "Adres zdjęcia wskazuje na sieć lokalną" : null;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return "Nie udało się rozwiązać adresu zdjęcia";
  }
  if (addrs.length === 0) return "Nie udało się rozwiązać adresu zdjęcia";
  if (addrs.some((a) => isBlockedAddress(a.address))) {
    return "Adres zdjęcia wskazuje na sieć lokalną";
  }
  return null;
}

/** Jedno żądanie GET bez automatycznych przekierowań, z twardym timeoutem. */
async function getOnce(u: URL): Promise<Response> {
  return fetch(u, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // Część sklepów odsyła 403 na żądanie bez UA; nie udajemy przeglądarki
      // bardziej niż trzeba, żeby nie obchodzić celowych blokad.
      "User-Agent": "AlfaApp/1.0 (import kartoteki)",
      Accept: "image/*",
    },
  });
}

/**
 * Ściągnięcie ciała odpowiedzi z limitem 8 MB liczonym NA STRUMIENIU.
 * `Content-Length` bywa skłamany albo nieobecny, więc sufit musi działać też
 * wtedy, gdy serwer po prostu sypie bajtami bez końca.
 */
async function readCapped(res: Response): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;
  if (!res.body) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/**
 * Pobierz i przeskaluj zdjęcie produktu.
 *
 * @param url adres z `og:image` (albo inny wskazany przez parser)
 * @param maxDataBytes sufit ZDEKODOWANYCH bajtów wynikowego JPEG-a (limit kolumny
 *        `photo_data` w kartotece — ten sam, co waliduje `POST /warehouse/items`)
 */
export async function fetchProductImage(
  url: string,
  maxDataBytes: number
): Promise<ProductImageResult> {
  try {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { photoData: null, warning: "Adres zdjęcia jest nieprawidłowy" };
    }

    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const blocked = await assertFetchable(target);
      if (blocked) return { photoData: null, warning: blocked };
      const r = await getOnce(target);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        // Ciało przekierowania nie jest nam potrzebne — zwalniamy połączenie.
        r.body?.cancel().catch(() => {});
        if (!loc) return { photoData: null, warning: "Serwer zdjęcia nie podał adresu przekierowania" };
        if (hop === MAX_REDIRECTS) {
          return { photoData: null, warning: "Zbyt wiele przekierowań przy pobieraniu zdjęcia" };
        }
        try {
          target = new URL(loc, target); // Location bywa relatywny
        } catch {
          return { photoData: null, warning: "Nieprawidłowe przekierowanie przy pobieraniu zdjęcia" };
        }
        continue;
      }
      res = r;
      break;
    }
    if (!res) return { photoData: null, warning: "Nie udało się pobrać zdjęcia" };

    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { photoData: null, warning: `Sklep nie udostępnił zdjęcia (HTTP ${res.status})` };
    }
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ctype.startsWith("image/")) {
      res.body?.cancel().catch(() => {});
      return { photoData: null, warning: "Pod adresem zdjęcia nie ma obrazka" };
    }
    const raw = await readCapped(res);
    if (!raw || raw.length === 0) {
      return { photoData: null, warning: "Zdjęcie ze sklepu jest za duże (limit 8 MB)" };
    }

    // Trzy podejścia coraz mocniejszej kompresji. Rozmiar mierzymy PO sharpie,
    // bo o limicie kolumny decydują bajty wynikowego JPEG-a, a nie oryginału.
    for (const step of RESIZE_STEPS) {
      let out: Buffer;
      try {
        out = await sharp(raw, { failOn: "error" })
          .rotate()
          .resize({ width: step.width, height: step.width, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: step.quality })
          .toBuffer();
      } catch {
        return { photoData: null, warning: "Nie udało się przetworzyć zdjęcia ze sklepu" };
      }
      if (out.length <= maxDataBytes) {
        return { photoData: `data:image/jpeg;base64,${out.toString("base64")}`, warning: null };
      }
    }
    return {
      photoData: null,
      warning: "Zdjęcie ze sklepu jest zbyt duże, żeby zmieścić je w kartotece — dodaj je ręcznie",
    };
  } catch (err) {
    // Timeout, zerwane połączenie, DNS, cokolwiek. Import musi przejść dalej.
    const reason = err instanceof Error && err.name === "TimeoutError" ? " (przekroczono czas)" : "";
    return { photoData: null, warning: `Nie udało się pobrać zdjęcia ze sklepu${reason}` };
  }
}
