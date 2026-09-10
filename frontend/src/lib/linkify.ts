/**
 * Wykrywanie adresów, e-maili i telefonów w WOLNYM TEKŚCIE (notatki wydarzeń,
 * notatki obiektu, opisy). Czyste funkcje, bez Reacta i bez zależności — dzięki
 * temu testuje je `scripts/test-link-preview.ts` przez `npx tsx`, bez budowania
 * frontu.
 *
 * ZASADA: nic tu nie produkuje HTML-a. Zwracamy tokeny, a `RichText.tsx` robi
 * z nich elementy Reacta — żadnego `dangerouslySetInnerHTML`, więc tekst
 * wklejony z maila nie ma jak nic wstrzyknąć.
 */

export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "url"; href: string; display: string }
  | { kind: "email"; href: string; display: string }
  | { kind: "phone"; href: string; display: string };

/**
 * Jeden przebieg po tekście: adres (ze schematem albo `www.`), e-mail, telefon.
 * Kolejność alternatyw ma znaczenie — adres idzie pierwszy, żeby `www.x.pl`
 * nie rozpadło się na fragmenty, a domena z maila nie została linkiem.
 *
 * Telefon: dziewięć cyfr w polskim zapisie, opcjonalnie z `+48` i z kierunkowym
 * w nawiasie. Sufiks `(?![\d-])` i prefiks `(?<![\d\w/.-])` chronią przed
 * łapaniem numerów NIP, kwot i dat.
 */
const MASTER =
  /(https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)|((?<![\w/.,-])(?:\+48[\s-]?)?(?:\(\d{2}\)[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\d{3}[\s-]?\d{3}[\s-]?\d{3})(?![\d\w-]))/g;

const TRAILING_PUNCT = ".,;:!?”“„’‘»«\"'*_";

const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function occurrences(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Odcina od adresu to, co należy już do zdania: kropkę, przecinek, cudzysłów,
 * a także nawias zamykający — ale TYLKO gdy w adresie nie ma odpowiadającego mu
 * otwierającego (żeby `https://pl.wikipedia.org/wiki/Kot_(zwierzę)` przeżyło).
 */
export function trimTrailingPunctuation(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (!last) break;
    if (TRAILING_PUNCT.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const open = PAIRS[last];
    if (open && occurrences(url, last) > occurrences(url, open)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

/** Telefon do `tel:` — same cyfry i ewentualny `+` na początku. */
export function telHref(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  return `tel:${digits.startsWith("+") ? digits : digits.replace(/^\+/, "")}`;
}

/**
 * Zapis Outlooka w treści tekstowej: link z HTML-a ląduje jako `TEKST <adres>`
 * (np. `www.ipm.mazowsze.pl <http://www.ipm.mazowsze.pl/>`), a `mailto:` jako
 * `jan@x.pl <mailto:jan@x.pl>`. Bez tego wzorca jeden link z maila rozpadał się
 * na DWA klikalne fragmenty i dwie karty podglądu.
 */
const ANGLE_URL = /<((?:https?:\/\/|www\.|mailto:)[^\s<>]+)>/g;

/**
 * Czy fragment stojący tuż przed `<adresem>` sam jest adresem (URL, gołą domeną
 * albo e-mailem)? Tylko taki tekst wciągamy do linku — zwykłe słowo („Kliknij")
 * zostaje zwykłym tekstem, żeby nie robić linku z przypadkowego wyrazu.
 */
const ADDRESS_LIKE =
  /^(?:https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s<>"'`]*)?)$/i;

/**
 * Dzieli tekst na fragmenty zwykłe i klikalne. Zwraca tablicę tokenów w tej
 * samej kolejności, w jakiej występują w tekście; suma `value`/`display`
 * (plus odcięta interpunkcja, która wraca do tekstu) daje oryginał.
 *
 * Dwa przebiegi: najpierw wyłapujemy wzorzec Outlooka `TEKST <adres>` (jeden
 * link), a kawałki pomiędzy nim skanujemy zwykłym `MASTER`.
 */
export function linkifyText(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  if (!text) return out;

  const pushText = (value: string) => {
    if (!value) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === "text") prev.value += value;
    else out.push({ kind: "text", value });
  };

  /** Zwykły skan: adres ze schematem albo `www.`, e-mail, telefon. */
  const scanPlain = (chunk: string) => {
    if (!chunk) return;
    let last = 0;
    MASTER.lastIndex = 0;
    for (let m = MASTER.exec(chunk); m; m = MASTER.exec(chunk)) {
      const [whole, url, email, phone] = m;
      pushText(chunk.slice(last, m.index));
      last = m.index + whole.length;

      if (url) {
        const display = trimTrailingPunctuation(url);
        if (!display || !/[a-z0-9]/i.test(display)) {
          pushText(whole);
          continue;
        }
        const href = /^www\./i.test(display) ? `https://${display}` : display;
        out.push({ kind: "url", href, display });
        pushText(url.slice(display.length));
        continue;
      }

      if (email) {
        const display = trimTrailingPunctuation(email);
        out.push({ kind: "email", href: `mailto:${display}`, display });
        pushText(email.slice(display.length));
        continue;
      }

      if (phone) {
        out.push({ kind: "phone", href: telHref(phone), display: phone });
        continue;
      }

      pushText(whole);
    }
    pushText(chunk.slice(last));
  };

  let last = 0;
  ANGLE_URL.lastIndex = 0;
  for (let m = ANGLE_URL.exec(text); m; m = ANGLE_URL.exec(text)) {
    const inner = m[1];
    let plain = text.slice(last, m.index);
    last = m.index + m[0].length;

    // Etykieta Outlooka tuż przed nawiasami — wciągamy ją tylko, gdy sama jest
    // adresem; wtedy to ona zostaje napisem linku.
    let display = "";
    const tail = /(\S+)[ \t]*$/.exec(plain);
    if (tail && ADDRESS_LIKE.test(tail[1])) {
      display = tail[1];
      plain = plain.slice(0, tail.index);
    }

    scanPlain(plain);

    if (/^mailto:/i.test(inner)) {
      const address = trimTrailingPunctuation(inner.slice("mailto:".length));
      if (!address) {
        pushText(m[0]);
        continue;
      }
      out.push({ kind: "email", href: `mailto:${address}`, display: display || address });
      continue;
    }

    const target = trimTrailingPunctuation(inner);
    if (!target || !/[a-z0-9]/i.test(target)) {
      pushText(m[0]);
      continue;
    }
    const href = /^www\./i.test(target) ? `https://${target}` : target;
    out.push({ kind: "url", href, display: display || target });
  }
  scanPlain(text.slice(last));
  return out;
}

/**
 * TOŻSAMOŚĆ adresu na potrzeby kart podglądu — celowo zgrubna: bez schematu,
 * bez wiodącego `www.`, bez fragmentu `#…` i bez końcowego ukośnika, host
 * małymi literami. `http://www.ipm.mazowsze.pl/` i `https://ipm.mazowsze.pl`
 * dają ten sam klucz `ipm.mazowsze.pl`, czyli JEDNĄ kartę.
 *
 * Tak jest, bo mail z Outlooka podaje ten sam adres na dwa sposoby naraz
 * (`www.x.pl <http://www.x.pl/>`), a użytkownik widzi jedną stronę i oczekuje
 * jednej karty. Ścieżki nie ruszamy — bywa wrażliwa na wielkość liter.
 *
 * To NIE jest adres do pobrania — do tego służy `canonicalPreviewUrl`.
 */
export function previewKey(href: string): string {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return href.trim().toLowerCase();
  }
}

/**
 * Adres, pod który front pyta o podgląd: schemat zachowany, host małymi
 * literami, bez fragmentu i bez zbędnego ukośnika na końcu.
 */
export function canonicalPreviewUrl(href: string): string {
  try {
    const u = new URL(href);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const out = u.toString();
    return u.pathname !== "/" && out.endsWith("/") ? out.slice(0, -1) : out;
  } catch {
    return href.trim();
  }
}

/**
 * Unikalne adresy z tekstu, w kolejności wystąpienia — front pobiera karty
 * podglądu tylko dla pierwszych kilku. Limit liczy się PO deduplikacji, więc
 * notatka z jednym linkiem powtórzonym pięć razy zużywa jedno miejsce.
 * W samym tekście klikalne pozostaje każde wystąpienie.
 *
 * Gdy ten sam adres pojawia się i po `http`, i po `https` (typowe dla maila),
 * do pobrania idzie wariant bezpieczny — kolejność wystąpień zostaje bez zmian.
 */
export function uniqueUrls(text: string, limit = 3): string[] {
  const at = new Map<string, number>();
  const out: string[] = [];
  for (const token of linkifyText(text)) {
    if (token.kind !== "url") continue;
    const key = previewKey(token.href);
    const url = canonicalPreviewUrl(token.href);
    const idx = at.get(key);
    if (idx !== undefined) {
      // Ten sam adres jeszcze raz: podmieniamy tylko http → https.
      if (out[idx].startsWith("http://") && url.startsWith("https://")) out[idx] = url;
      continue;
    }
    if (out.length >= limit) continue;
    at.set(key, out.length);
    out.push(url);
  }
  return out;
}
