/**
 * Test podglądu linków (unfurl) — parsera adresów w tekście, parsera metadanych
 * HTML, walidacji SSRF i trasy `GET /api/links/preview`.
 *
 * Uruchamiaj NA KOPII bazy (sekcja D pisze do `link_previews`):
 *   npx tsx scripts/test-on-copy.ts scripts/test-link-preview.ts
 *
 * Bez `ALFA_DB_PATH` sekcja D jest pomijana — sam parser i walidacja SSRF
 * chodzą bez bazy i bez sieci. `fetch` jest w każdym teście PODMIENIONY, więc
 * skrypt nigdy nie wychodzi do internetu; testy SSRF sprawdzają dodatkowo, że
 * podmieniony `fetch` NIE ZOSTAŁ wywołany.
 */
import { lookup } from "node:dns/promises";
import { Hono } from "hono";
import {
  assertFetchableUrl,
  checkHostname,
  decodeBody,
  detectCharset,
  fetchPreview,
  isPrivateAddress,
  normalizeUrl,
  parseHtmlMeta,
  LinkPreviewError,
} from "../src/lib/link-preview.js";
import { linkifyText, uniqueUrls } from "../frontend/src/lib/linkify.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

/** Skrót tokenów do porównań: „tekst|URL(href)”. */
function sketch(text: string): string {
  return linkifyText(text)
    .map((t) => (t.kind === "text" ? t.value : `${t.kind.toUpperCase()}(${t.href})`))
    .join("|");
}

// ---------------------------------------------------------------------------
// A. linkifyText
// ---------------------------------------------------------------------------
console.log("\n=== A. Wykrywanie adresów w tekście ===");

{
  const t = linkifyText("Zobacz https://example.com/a. Reszta zdania.");
  ok(
    "URL w środku zdania — kropka zostaje w tekście",
    t.length === 3 &&
      t[1].kind === "url" &&
      t[1].href === "https://example.com/a" &&
      t[2].kind === "text" &&
      t[2].value === ". Reszta zdania.",
    sketch("Zobacz https://example.com/a. Reszta zdania.")
  );
}

{
  const t = linkifyText("Instrukcja (https://example.com/x) jest tutaj.");
  const url = t.find((x) => x.kind === "url");
  ok(
    "URL w nawiasie — nawias zamykający nie wchodzi do adresu",
    url?.kind === "url" && url.href === "https://example.com/x",
    sketch("Instrukcja (https://example.com/x) jest tutaj.")
  );
}

{
  const t = linkifyText("Hasło: https://pl.wikipedia.org/wiki/Kot_(zwierzę) — patrz tam");
  const url = t.find((x) => x.kind === "url");
  ok(
    "URL z własnym nawiasem — nawias zostaje w adresie",
    url?.kind === "url" && url.href === "https://pl.wikipedia.org/wiki/Kot_(zwierzę)",
    url
  );
}

{
  const t = linkifyText("wejdź na www.alfagroup.pl i sprawdź");
  const url = t.find((x) => x.kind === "url");
  ok(
    "www. bez schematu dostaje https://",
    url?.kind === "url" && url.href === "https://www.alfagroup.pl" && url.display === "www.alfagroup.pl",
    url
  );
}

{
  const urls = linkifyText("http://a.example/1 oraz http://b.example/2").filter((t) => t.kind === "url");
  ok("dwa adresy w jednym tekście", urls.length === 2, urls);
}

{
  const t = linkifyText("Notatka bez żadnych adresów, 3 kamery i 2 czujki.");
  ok("tekst bez adresów = jeden token tekstowy", t.length === 1 && t[0].kind === "text", t);
}

{
  const t = linkifyText("Mapa: https://maps.example/?q=Zielona%20G%C3%B3ra&zoom=12 koniec");
  const url = t.find((x) => x.kind === "url");
  ok(
    "URL z percent-encoding i parametrami",
    url?.kind === "url" && url.href === "https://maps.example/?q=Zielona%20G%C3%B3ra&zoom=12",
    url
  );
}

{
  const t = linkifyText("Strona https://example.pl/ścieżka/zażółć koniec");
  const url = t.find((x) => x.kind === "url");
  ok("URL z polskimi znakami", url?.kind === "url" && url.display === "https://example.pl/ścieżka/zażółć", url);
}

{
  const t = linkifyText("Kontakt: jan.kowalski@example.pl, tel. +48 601 234 567 albo 12-345-67-89.");
  const mail = t.find((x) => x.kind === "email");
  const phones = t.filter((x) => x.kind === "phone");
  ok("e-mail → mailto:", mail?.kind === "email" && mail.href === "mailto:jan.kowalski@example.pl", mail);
  ok("telefon +48 → tel:", phones.some((p) => p.kind === "phone" && p.href === "tel:+48601234567"), phones);
}

{
  const t = linkifyText("Numer 601234567 i drugi 601-234-567.");
  const phones = t.filter((x) => x.kind === "phone");
  ok(
    "telefon bez separatorów i z myślnikami",
    phones.length === 2 && phones[0].kind === "phone" && phones[0].href === "tel:601234567",
    phones
  );
}

{
  const t = linkifyText("NIP 9291854773 i kwota 1234,56 zł");
  ok("NIP (10 cyfr) nie jest telefonem", t.every((x) => x.kind === "text"), sketch("NIP 9291854773 i kwota 1234,56 zł"));
}

{
  const got = uniqueUrls("a https://x.pl b https://x.pl c https://y.pl d https://z.pl e https://w.pl");
  ok(
    "uniqueUrls — bez powtórek, maks. 3",
    JSON.stringify(got) === JSON.stringify(["https://x.pl/", "https://y.pl/", "https://z.pl/"]),
    got
  );
}

{
  const text = "Instrukcja https://example.pl/plik jest tu: https://example.pl/plik#krok2 oraz https://example.pl/plik/ — trzy razy ten sam adres.";
  const got = uniqueUrls(text);
  ok("ten sam link trzy razy → jedna karta", got.length === 1 && got[0] === "https://example.pl/plik", got);
  const inline = linkifyText(text).filter((t) => t.kind === "url");
  ok("…ale każde wystąpienie zostaje klikalne", inline.length === 3, inline.length);
}

{
  const got = uniqueUrls("http://x.pl i https://x.pl oraz https://www.x.pl");
  ok(
    "http/https i www. to TA SAMA karta (https wygrywa)",
    got.length === 1 && got[0] === "https://x.pl/",
    got
  );
}

{
  // Zapis Outlooka: link z HTML-a trafia do treści jako TEKST <adres>.
  const text = "Więcej na www.ipm.mazowsze.pl <http://www.ipm.mazowsze.pl/> — zapraszamy.";
  const t = linkifyText(text).filter((x) => x.kind === "url");
  ok("Outlook TEKST <adres> → JEDEN link", t.length === 1, sketch(text));
  ok(
    "…napisem zostaje TEKST, adresem to z nawiasów",
    t[0]?.kind === "url" && t[0].display === "www.ipm.mazowsze.pl" && t[0].href === "http://www.ipm.mazowsze.pl/",
    t[0]
  );
  ok("…nawiasy < > znikają z tekstu", !sketch(text).includes("<") && !sketch(text).includes(">"), sketch(text));
  ok("…i jedna karta podglądu", uniqueUrls(text).length === 1, uniqueUrls(text));
}

{
  const t = linkifyText("Szczegóły <https://example.pl/plik> w załączniku.").filter((x) => x.kind === "url");
  ok(
    "samo <adres> → jeden link bez nawiasów",
    t.length === 1 && t[0].kind === "url" && t[0].display === "https://example.pl/plik",
    t
  );
}

{
  const t = linkifyText("Kliknij <https://example.pl> teraz");
  const urls = t.filter((x) => x.kind === "url");
  ok(
    "zwykłe słowo przed <adresem> nie staje się linkiem",
    urls.length === 1 && t.some((x) => x.kind === "text" && x.value.includes("Kliknij")),
    t
  );
}

{
  const text = "jan.kowalski@example.pl <mailto:jan.kowalski@example.pl>";
  const t = linkifyText(text).filter((x) => x.kind === "email");
  ok(
    "Outlook adres <mailto:adres> → jeden e-mail",
    t.length === 1 && t[0].display === "jan.kowalski@example.pl" && t[0].href === "mailto:jan.kowalski@example.pl",
    sketch(text)
  );
}

{
  const got = uniqueUrls("www.ipm.mazowsze.pl <http://www.ipm.mazowsze.pl/> oraz https://ipm.mazowsze.pl/");
  ok("ten sam adres w dwóch zapisach → jedna karta, https", JSON.stringify(got) === JSON.stringify(["https://ipm.mazowsze.pl/"]), got);
}

{
  const got = uniqueUrls("https://X.PL/Sciezka i https://x.pl/Sciezka");
  ok("host bez względu na wielkość liter", got.length === 1, got);
}

// ---------------------------------------------------------------------------
// B. Parser metadanych HTML
// ---------------------------------------------------------------------------
console.log("\n=== B. Metadane strony ===");

{
  const html = `<html><head>
    <title>Tytuł z title</title>
    <meta property="og:title" content="Tytuł z Open Graph">
    <meta property="og:description" content="Opis strony">
    <meta property="og:image" content="/img/podglad.png">
    <meta property="og:site_name" content="Przykład">
    <link rel="icon" href="/favicon.ico">
  </head><body>…</body></html>`;
  const meta = parseHtmlMeta(html, "https://example.pl/artykul/1");
  ok("og:title ma pierwszeństwo przed <title>", meta.title === "Tytuł z Open Graph", meta.title);
  ok("og:description", meta.description === "Opis strony", meta.description);
  ok("og:image absolutyzowane", meta.image === "https://example.pl/img/podglad.png", meta.image);
  ok("og:site_name", meta.siteName === "Przykład", meta.siteName);
  ok("favicon względny → absolutny", meta.favicon === "https://example.pl/favicon.ico", meta.favicon);
}

{
  const html = `<head><title>Alfa &amp; Omega &#8212; oferta &quot;2026&quot;</title></head>`;
  const meta = parseHtmlMeta(html, "https://example.pl/");
  ok("fallback <title> + encje", meta.title === 'Alfa & Omega — oferta "2026"', meta.title);
  ok("brak <link rel=icon> → zastępczy favicon Google", meta.favicon?.includes("s2/favicons") === true, meta.favicon);
  ok("siteName z hosta, gdy brak og:site_name", meta.siteName === "example.pl", meta.siteName);
}

{
  const long = "x".repeat(400);
  const meta = parseHtmlMeta(`<head><meta name="description" content="${long}"></head>`, "https://example.pl/");
  ok("opis przycięty do 200 znaków", (meta.description ?? "").length === 200, meta.description?.length);
}

{
  const meta = parseHtmlMeta(
    `<head><link rel="apple-touch-icon" href="https://cdn.example.pl/i.png"><meta name="twitter:title" content="Z Twittera"></head>`,
    "https://example.pl/"
  );
  ok("apple-touch-icon jako favicon", meta.favicon === "https://cdn.example.pl/i.png", meta.favicon);
  ok("twitter:title jako fallback", meta.title === "Z Twittera", meta.title);
}

{
  ok("charset z nagłówka", detectCharset("text/html; charset=ISO-8859-2", "") === "iso-8859-2");
  ok("charset z <meta charset>", detectCharset(null, '<meta charset="windows-1250">') === "windows-1250");
  // 0x9C w windows-1250 to „ś" — w utf-8 wyszedłby znak zastępczy.
  const cp1250 = '<meta charset="windows-1250"><title>Za\u009Cwiadczenie</title>';
  const decoded = decodeBody(new Uint8Array(Buffer.from(cp1250, "latin1")), null);
  ok("dekodowanie windows-1250", decoded.includes("Zaświadczenie"), decoded);
  const metaPl = parseHtmlMeta(decoded, "https://example.pl/");
  ok("tytuł po dekodowaniu windows-1250", metaPl.title === "Zaświadczenie", metaPl.title);
}

// ---------------------------------------------------------------------------
// C. Walidacja SSRF
// ---------------------------------------------------------------------------
console.log("\n=== C. Adresy, do których serwerowi nie wolno wyjść ===");

ok("127.0.0.1 prywatny", isPrivateAddress("127.0.0.1"));
ok("169.254.169.254 (metadane chmury) prywatny", isPrivateAddress("169.254.169.254"));
ok("10.0.0.1 prywatny", isPrivateAddress("10.0.0.1"));
ok("172.16.0.1 prywatny", isPrivateAddress("172.16.0.1"));
ok("172.32.0.1 PUBLICZNY (poza 172.16/12)", !isPrivateAddress("172.32.0.1"));
ok("192.168.1.1 prywatny", isPrivateAddress("192.168.1.1"));
ok("100.64.0.1 (CGNAT) prywatny", isPrivateAddress("100.64.0.1"));
ok("::1 prywatny", isPrivateAddress("::1"));
ok("fd00::1 prywatny", isPrivateAddress("fd00::1"));
ok("fe80::1 prywatny", isPrivateAddress("fe80::1"));
ok("::ffff:127.0.0.1 prywatny", isPrivateAddress("::ffff:127.0.0.1"));
ok("8.8.8.8 publiczny", !isPrivateAddress("8.8.8.8"));

/** Podmienia `fetch` na funkcję zwracającą przygotowane odpowiedzi. */
function mockFetch(handler: (url: string) => Response) {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    return handler(url);
  }) as typeof fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

{
  const guard = mockFetch(() => {
    throw new Error("fetch NIE POWINIEN być wywołany");
  });

  const blocked = [
    "http://127.0.0.1",
    "http://127.0.0.1:4001/api/admin/users",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:4001/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://192.168.0.1/",
    "http://drukarka.local/",
    "http://intranet/",
  ];
  for (const url of blocked) {
    const problem = checkHostname(new URL(url).hostname);
    ok(`odrzucony bez sieci: ${url}`, problem !== null, problem);
  }

  for (const url of blocked) {
    let threw = false;
    try {
      await assertFetchableUrl(url);
    } catch (e) {
      threw = e instanceof LinkPreviewError;
    }
    if (!threw) ok(`assertFetchableUrl odrzuca ${url}`, false);
  }
  ok("żaden zablokowany adres nie wywołał fetch", guard.seen.length === 0, guard.seen);

  const ftpRejected = await assertFetchableUrl("ftp://example.pl/").then(
    () => false,
    () => true
  );
  ok("ftp:// odrzucone", ftpRejected);
  guard.restore();
}

ok("normalizeUrl: fragment odcięty", normalizeUrl("  https://example.pl/a#sekcja  ") === "https://example.pl/a");
ok("normalizeUrl: www. dostaje https", normalizeUrl("www.example.pl") === "https://www.example.pl/");
ok("normalizeUrl: javascript: odrzucone", normalizeUrl("javascript:alert(1)") === null);
ok("normalizeUrl: śmieci odrzucone", normalizeUrl("to nie jest adres") === null);

// ---------------------------------------------------------------------------
// C2. fetchPreview z podmienionym fetch (bez sieci)
// ---------------------------------------------------------------------------
console.log("\n=== C2. Pobranie z podmienionym fetch ===");

{
  // 8.8.8.8 to literalny adres publiczny — walidacja go przepuszcza i nie pyta DNS-u.
  const m = mockFetch(
    () =>
      new Response(
        `<html><head><meta property="og:title" content="Kamera IP"><meta property="og:image" content="/i.jpg"><link rel="shortcut icon" href="ico.png"></head></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      )
  );
  const p = await fetchPreview("https://8.8.8.8/produkt");
  m.restore();
  ok("podgląd HTML: status ok + tytuł", p.status === "ok" && p.title === "Kamera IP", p);
  ok("podgląd HTML: obrazek absolutyzowany", p.image === "https://8.8.8.8/i.jpg", p.image);
  ok("podgląd HTML: favicon względny do katalogu", p.favicon === "https://8.8.8.8/ico.png", p.favicon);
}

{
  const m = mockFetch(() => new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }));
  const p = await fetchPreview("https://8.8.8.8/umowa.pdf");
  m.restore();
  ok("nie-HTML: sama domena i typ", p.status === "ok" && p.title === null && p.description === "application/pdf", p);
}

{
  // Przekierowanie na adres prywatny musi zostać zatrzymane PRZY DRUGIM przeskoku.
  const m = mockFetch((url) =>
    url.startsWith("https://8.8.8.8")
      ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:4001/api/admin/users" } })
      : new Response("TAJNE", { status: 200, headers: { "content-type": "text/html" } })
  );
  const p = await fetchPreview("https://8.8.8.8/redirect");
  m.restore();
  ok("302 na adres prywatny → status error", p.status === "error", p);
  ok("…i tylko jedno wyjście w sieć (drugi hop niewykonany)", m.seen.length === 1, m.seen);
}

{
  const m = mockFetch(() => new Response("nie ma", { status: 404, headers: { "content-type": "text/html" } }));
  const p = await fetchPreview("https://8.8.8.8/404");
  m.restore();
  ok("404 → status error z fallbackowym faviconem", p.status === "error" && !!p.favicon && p.host === "8.8.8.8", p);
}

// ---------------------------------------------------------------------------
// C3. Mini-mapa dla linków Google Maps
// ---------------------------------------------------------------------------
console.log("\n=== C3. Mini-mapa (map) dla linków Google Maps ===");

// UWAGA: te dwa przypadki potrzebują DNS-u (walidacja SSRF rozwiązuje nazwę
// hosta `maps.app.goo.gl` / `www.google.com`) — samo POBRANIE jest zamockowane
// i nic nie wychodzi do internetu. Bez DNS-u przypadki są pomijane, żeby test
// nie fałszował porażki na maszynie bez sieci.
const dnsWorks = await lookup("www.google.com")
  .then(() => true)
  .catch(() => false);

if (!dnsWorks) {
  console.log("POMINIĘTE — brak DNS-u (walidacja SSRF nie rozwiąże nazw Google)");
} else {
  {
    // Krótki link niesie punkt DOPIERO po przekierowaniu — mapa musi wyjść z `finalUrl`.
    const m = mockFetch((url) =>
      url.startsWith("https://maps.app.goo.gl/")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://www.google.com/maps/place/Pa%C5%82ac+Kultury/@52.2317,21.0062,17z" },
          })
        : new Response(
            `<head><meta property="og:title" content="Pałac Kultury - Google Maps">` +
              `<meta property="og:image" content="https://maps.google.com/big.png"></head>`,
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          )
    );
    const p = await fetchPreview("https://maps.app.goo.gl/x");
    m.restore();
    ok("krótki link → punkt z adresu po przekierowaniu", p.map?.lat === 52.2317 && p.map?.lng === 21.0062, p.map);
    ok("…zoom z adresu", p.map?.zoom === 17, p.map);
    ok("…etykieta z /place/ (zdekodowana)", p.map?.label === "Pałac Kultury", p.map);
    ok("…og:image pominięty dla map", p.image === null, p.image);
    ok("…dwa przeskoki, zero dodatkowych wyjść", m.seen.length === 2, m.seen);
  }

  {
    // Adres bez współrzędnych i bez frazy do geokodowania — karta zwykła, `map: null`.
    const m = mockFetch(
      () =>
        new Response("<head><title>Google Maps</title></head>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );
    const p = await fetchPreview("https://www.google.com/maps");
    m.restore();
    ok("adres bez punktu i bez frazy → map: null", p.map === null, p.map);
  }
}

// ---------------------------------------------------------------------------
// D. Trasa + cache w bazie (tylko na kopii)
// ---------------------------------------------------------------------------
if (!process.env.ALFA_DB_PATH) {
  console.log("\n=== D. POMINIĘTA (uruchom przez scripts/test-on-copy.ts) ===");
} else {
  console.log("\n=== D. Trasa /links/preview i cache w bazie ===");
  const { db, schema } = await import("../src/db/index.js");
  const { eq } = await import("drizzle-orm");
  const linksRoutes = (await import("../src/routes/links.js")).default;
  type User = typeof schema.users.$inferSelect;

  const user = db.select().from(schema.users).limit(1).get() as User | undefined;
  if (!user) {
    console.error("Brak użytkowników w bazie — przerywam sekcję D.");
    failures++;
  } else {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", user);
      return next();
    });
    app.route("/links", linksRoutes);

    const call = async (url: string) => {
      const res = await app.request(`/links/preview?url=${encodeURIComponent(url)}`);
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; data?: Record<string, unknown>; error?: string }
        | null;
      return { status: res.status, ...(json ?? {}) };
    };

    const guard = mockFetch(() => {
      throw new Error("fetch NIE POWINIEN być wywołany");
    });

    const bad = await call("to nie jest adres");
    ok("niepoprawny URL → 400", bad.status === 400 && bad.success === false, bad);

    const priv = await call("http://10.0.0.1/panel");
    ok("host prywatny → 400", priv.status === 400, priv);

    const loop = await call("http://127.0.0.1:4001/api/stats");
    ok("pętla zwrotna → 400", loop.status === 400, loop);

    const local = await call("http://localhost/");
    ok("localhost → 400", local.status === 400, local);

    ok("żadne z powyższych nie wyszło w sieć", guard.seen.length === 0, guard.seen);

    // Cache: świeży wiersz w bazie ma wystarczyć — `fetch` nadal rzuca.
    const CACHED = "https://przyklad-cache.example/artykul";
    db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, CACHED)).run();
    db.insert(schema.linkPreviews)
      .values({
        url: CACHED,
        finalUrl: CACHED,
        host: "przyklad-cache.example",
        title: "Z cache'u",
        description: "Opis z bazy",
        image: null,
        favicon: "https://przyklad-cache.example/f.ico",
        siteName: "Przykład",
        status: "ok",
        error: null,
        fetchedAt: new Date().toISOString(),
      })
      .run();

    const cached = await call(CACHED);
    ok(
      "świeży wiersz w link_previews → odpowiedź bez sieci",
      cached.status === 200 && cached.success === true && cached.data?.title === "Z cache'u",
      cached
    );
    ok("cache nie wywołał fetch", guard.seen.length === 0, guard.seen);
    guard.restore();

    // Przeterminowany wpis (błąd sprzed 2 h, TTL błędu = 1 h) musi zostać odświeżony.
    const STALE = "https://8.8.4.4/stale";
    db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, STALE)).run();
    db.insert(schema.linkPreviews)
      .values({
        url: STALE,
        finalUrl: STALE,
        host: "8.8.4.4",
        title: "Stare",
        description: null,
        image: null,
        favicon: null,
        siteName: null,
        status: "error",
        error: "stare",
        fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      })
      .run();

    const refresh = mockFetch(
      () =>
        new Response("<head><title>Świeże</title></head>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );
    const stale = await call(STALE);
    refresh.restore();
    ok(
      "przeterminowany wpis odświeżany (nowy tytuł, jedno pobranie)",
      stale.status === 200 && stale.data?.title === "Świeże" && refresh.seen.length === 1,
      { stale, seen: refresh.seen }
    );

    const row = db.select().from(schema.linkPreviews).where(eq(schema.linkPreviews.url, STALE)).get();
    ok("odświeżony podgląd zapisany w cache'u", row?.title === "Świeże" && row?.status === "ok", row);

    // --- Mini-mapa: geokodowanie frazy, zapis `map_json`, odczyt z cache'u ----
    console.log("\n=== D2. Mini-mapa w trasie i w cache'u ===");
    const { setGeoFetch } = await import("../src/lib/geo.js");

    if (!dnsWorks) {
      console.log("POMINIĘTE — brak DNS-u (walidacja SSRF nie rozwiąże `www.google.com`)");
    } else {
      // Fraza celowo fikcyjna — inaczej wpis mógłby siedzieć w `geo_cache` skopiowanej
      // bazy i test mierzyłby cache, a nie zamockowany geokoder.
      const QUERY_URL = "https://www.google.com/maps?q=Testowa+Fikcyjna+Pinezka+Alfa+QA";
      db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, QUERY_URL)).run();

      // Geokoder zamockowany osobno (`setGeoFetch`) — `fetch` obsługuje samą stronę.
      setGeoFetch(
        (async () =>
          new Response(JSON.stringify([{ lat: "50.0616", lon: "19.9373", display_name: "Rynek Główny, Kraków" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch
      );
      const page = mockFetch(
        () =>
          new Response("<head><title>Testowa Fikcyjna Pinezka – Mapy Google</title></head>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
      );
      const geo = await call(QUERY_URL);
      page.restore();
      setGeoFetch(null);

      const map = geo.data?.map as { lat?: number; lng?: number; label?: string } | null | undefined;
      ok("?q=<tekst> → punkt z geokodera", map?.lat === 50.0616 && map?.lng === 19.9373, map);
      ok("…etykieta z tytułu strony bez sufiksu „Mapy Google”", map?.label === "Testowa Fikcyjna Pinezka", map);

      const mapRow = db.select().from(schema.linkPreviews).where(eq(schema.linkPreviews.url, QUERY_URL)).get();
      ok("…punkt zapisany w `map_json`", (mapRow?.mapJson ?? "").includes("50.0616"), mapRow?.mapJson);

      // Drugie pytanie o ten sam adres: ani strony, ani geokodera — wszystko z cache'u.
      const guard2 = mockFetch(() => {
        throw new Error("fetch NIE POWINIEN być wywołany");
      });
      setGeoFetch((async () => {
        throw new Error("geokoder NIE POWINIEN być wywołany");
      }) as typeof fetch);
      const again = await call(QUERY_URL);
      setGeoFetch(null);
      guard2.restore();
      const map2 = again.data?.map as { lat?: number; label?: string } | null | undefined;
      ok("…odczyt z cache'u bez sieci zwraca ten sam punkt", map2?.lat === 50.0616 && map2?.label === "Testowa Fikcyjna Pinezka", map2);
      ok("…i nic nie poszło w sieć", guard2.seen.length === 0, guard2.seen);

      // Geokoder padł → karta bez mapy, ale BEZ wyjątku i bez błędu podglądu.
      const FAIL_URL = "https://www.google.com/maps?q=Nieistniej%C4%85cy+adres+testowy";
      db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, FAIL_URL)).run();
      setGeoFetch((async () => {
        throw new Error("brak sieci");
      }) as typeof fetch);
      const failPage = mockFetch(
        () => new Response("<head><title>Google Maps</title></head>", { status: 200, headers: { "content-type": "text/html" } })
      );
      const failed = await call(FAIL_URL);
      failPage.restore();
      setGeoFetch(null);
      ok(
        "awaria geokodera → map: null, podgląd nadal ok",
        failed.status === 200 && failed.data?.status === "ok" && failed.data?.map === null,
        failed
      );

      db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, QUERY_URL)).run();
      db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, FAIL_URL)).run();
    }

    // Wiersz z czasów sprzed mini-mapy: `status: "ok"`, ale `map_json` NULL. Dla
    // linku do Map liczy się jak błąd (TTL 1 h), więc po godzinie jest odświeżany
    // — inaczej przez tydzień pokazywałby kartę bez mapy mimo działającego parsera.
    if (!dnsWorks) {
      console.log("POMINIĘTE (TTL wpisu bez mapy) — brak DNS-u");
    } else {
      // Współrzędne celowo „nietknięte” — realny punkt mógłby już siedzieć w `geo_cache`
      // skopiowanej bazy i test mierzyłby cache zamiast zamockowanego reverse.
      const OLD_MISS = "https://www.google.com/maps/search/51.111111,+22.222222";
      db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, OLD_MISS)).run();
      db.insert(schema.linkPreviews)
        .values({
          url: OLD_MISS,
          finalUrl: OLD_MISS,
          host: "www.google.com",
          title: "Google Maps",
          description: null,
          image: null,
          favicon: null,
          siteName: "Google Maps",
          mapJson: null,
          status: "ok",
          error: null,
          fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        })
        .run();

      const refetch = mockFetch(
        () =>
          new Response("<head><title>Google Maps</title></head>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
      );
      // Reverse zamockowany — etykietą samych współrzędnych jest adres spod pinezki.
      setGeoFetch(
        (async () =>
          new Response(
            JSON.stringify({ display_name: "5, Testowa, Zielonka", address: { road: "Testowa", house_number: "5", city: "Zielonka" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          )) as typeof fetch
      );
      const revived = await call(OLD_MISS);
      setGeoFetch(null);
      refetch.restore();
      const revivedMap = revived.data?.map as { lat?: number; lng?: number; label?: string } | null | undefined;
      ok(
        "stary wpis `ok` bez mapy → odświeżony po godzinie i punkt jest",
        revivedMap?.lat === 51.111111 && revivedMap?.lng === 22.222222,
        revived
      );
      ok("…etykieta z geokodera odwrotnego", revivedMap?.label === "Testowa 5, Zielonka", revivedMap);
      ok("…odświeżenie faktycznie pobrało stronę", refetch.seen.length === 1, refetch.seen);
      db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, OLD_MISS)).run();
    }

    // Punkt z `map_json` wraca z cache'u bez żadnego wyjścia w sieć i bez DNS-u.
    const MAP_CACHED = "https://www.google.pl/maps/place/Testowa+Pinezka/@52.1,21.2,16z";
    db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, MAP_CACHED)).run();
    db.insert(schema.linkPreviews)
      .values({
        url: MAP_CACHED,
        finalUrl: MAP_CACHED,
        host: "www.google.pl",
        title: "Testowa Pinezka",
        description: null,
        image: null,
        favicon: null,
        siteName: "Google Maps",
        mapJson: JSON.stringify({ lat: 52.1, lng: 21.2, zoom: 16, label: "Testowa Pinezka" }),
        status: "ok",
        error: null,
        fetchedAt: new Date().toISOString(),
      })
      .run();

    const mapGuard = mockFetch(() => {
      throw new Error("fetch NIE POWINIEN być wywołany");
    });
    const fromCache = await call(MAP_CACHED);
    mapGuard.restore();
    const cachedMap = fromCache.data?.map as { lat?: number; zoom?: number; label?: string } | null | undefined;
    ok(
      "`map_json` z cache'u → gotowy punkt bez sieci",
      cachedMap?.lat === 52.1 && cachedMap?.zoom === 16 && cachedMap?.label === "Testowa Pinezka",
      fromCache
    );
    ok("…i faktycznie zero wyjść w sieć", mapGuard.seen.length === 0, mapGuard.seen);
    db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, MAP_CACHED)).run();

    // Sprzątanie — wiersze testowe znikają z kopii (i z bazy, gdyby ktoś puścił wprost).
    db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, CACHED)).run();
    db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.url, STALE)).run();
  }
}

console.log(failures === 0 ? "\nWszystko przeszło." : `\n${failures} testów nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
