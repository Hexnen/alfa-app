/**
 * Statyki frontu: cache, ETag/304 i fallback SPA (src/lib/static-assets.ts).
 *
 *   npx tsx scripts/test-static-headers.ts
 *
 * Bazy nie dotyka — `mountStatic` to czysta funkcja nad katalogiem plików, więc
 * test stawia własny katalog w TMPDIR i wpina go w pustą aplikację Hono.
 * (Dlatego logika statyków mieszka w osobnym module, a nie w `src/index.ts`:
 * tamten plik przy imporcie stawia serwer, migruje bazę i uruchamia IMAP.)
 *
 * Co jest tu pilnowane:
 *   • `/assets/*` → `immutable` na rok, `index.html`/SW/manifest → `no-cache`,
 *     obrazki i fonty spoza `/assets/` → doba,
 *   • ETag na statykach i 304 na `If-None-Match` (z tym samym `Cache-Control`),
 *   • ścieżka Z ROZSZERZENIEM bez pliku → 404, a nie `index.html` (SPA),
 *   • ścieżka BEZ rozszerzenia (trasa SPA) → 200 z `index.html`,
 *   • `..` w adresie nie wychodzi poza katalog frontu.
 */
import { Hono } from "hono";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mountStatic } from "../src/lib/static-assets.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const ROOT = join(process.env.TMPDIR ?? "/tmp", `alfa-static-${process.pid}`);
const OUTSIDE = `${ROOT}-poza.txt`;

try {
  mkdirSync(join(ROOT, "assets"), { recursive: true });
  writeFileSync(join(ROOT, "index.html"), "<!doctype html><title>Alfa</title>");
  writeFileSync(join(ROOT, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(ROOT, "technik-sw.js"), "/* sw */");
  writeFileSync(join(ROOT, "technik.webmanifest"), "{}");
  writeFileSync(join(ROOT, "logo.png"), "PNG");
  // Plik POZA katalogiem frontu — nie ma prawa wyjść żadną ścieżką.
  writeFileSync(OUTSIDE, "tego nie ma prawa wydać");

  const app = new Hono();
  app.get("/api/ping", (c) => c.json({ ok: true }));
  mountStatic(app, ROOT, () => readFileSync(join(ROOT, "index.html"), "utf-8"));

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers });

  // --- S4: Cache-Control per rodzaj pliku ---------------------------------
  const asset = await get("/assets/app-abc123.js");
  ok(
    "S4 statyki: /assets/* → immutable na rok",
    asset.status === 200 && asset.headers.get("cache-control") === "public, max-age=31536000, immutable",
    asset.headers.get("cache-control")
  );
  const sw = await get("/technik-sw.js");
  ok(
    "S4 statyki: service worker panelu → no-cache",
    sw.status === 200 && sw.headers.get("cache-control") === "no-cache",
    sw.headers.get("cache-control")
  );
  const manifest = await get("/technik.webmanifest");
  ok(
    "S4 statyki: manifest PWA → no-cache",
    manifest.status === 200 && manifest.headers.get("cache-control") === "no-cache",
    manifest.headers.get("cache-control")
  );
  const logo = await get("/logo.png");
  ok(
    "S4 statyki: obrazek spoza /assets (logo, ikony PWA) → doba",
    logo.status === 200 && logo.headers.get("cache-control") === "public, max-age=86400",
    logo.headers.get("cache-control")
  );

  // --- S4: ETag i warunkowe GET -------------------------------------------
  const etag = asset.headers.get("etag");
  ok("S4 ETag: statyk niesie słaby ETag z rozmiaru i mtime", /^W\/"\d+-\d+"$/.test(etag ?? ""), etag);
  const notModified = await get("/assets/app-abc123.js", { "If-None-Match": etag ?? "" });
  ok(
    "S4 ETag: If-None-Match z tym samym znacznikiem → 304 bez ciała",
    notModified.status === 304 && (await notModified.text()) === "",
    notModified.status
  );
  ok(
    "S4 ETag: 304 niesie ten sam Cache-Control co 200",
    notModified.headers.get("cache-control") === asset.headers.get("cache-control"),
    notModified.headers.get("cache-control")
  );
  const stale = await get("/assets/app-abc123.js", { "If-None-Match": 'W/"1-1"' });
  ok("S4 ETag: nieaktualny znacznik → 200 z treścią", stale.status === 200, stale.status);

  const swEtag = (await get("/technik-sw.js")).headers.get("etag");
  const swAgain = await get("/technik-sw.js", { "If-None-Match": swEtag ?? "" });
  ok(
    "S4 ETag: rewalidacja no-cache'owanego SW kończy się na 304",
    swAgain.status === 304,
    swAgain.status
  );
  // Zmiana treści = nowy ETag (rozmiar i mtime idą w górę).
  writeFileSync(join(ROOT, "technik-sw.js"), "/* sw v2 — dłuższa treść */");
  const swChanged = await get("/technik-sw.js", { "If-None-Match": swEtag ?? "" });
  ok("S4 ETag: po zmianie pliku ten sam znacznik już nie pasuje", swChanged.status === 200, swChanged.status);

  // --- N10: brakujący PLIK to 404, nie aplikacja w HTML-u ------------------
  const favicon = await get("/favicon.ico");
  ok("N10 SPA: /favicon.ico bez pliku → 404, nie 200 z HTML-em", favicon.status === 404, favicon.status);
  const missingMap = await get("/assets/app-abc123.js.map");
  ok("N10 SPA: brakująca mapa źródeł → 404", missingMap.status === 404, missingMap.status);
  const missingHtml = await get("/designer.html");
  ok("N10 SPA: brakujący plik .html → 404", missingHtml.status === 404, missingHtml.status);

  // --- SPA: trasy bez rozszerzenia dalej dostają index.html ---------------
  const deep = await get("/technik/zlecenie/12");
  ok(
    "SPA: głęboki link panelu → 200 z index.html i no-cache",
    deep.status === 200 &&
      (await deep.text()).includes("<title>Alfa</title>") &&
      deep.headers.get("cache-control") === "no-cache",
    { status: deep.status, cc: deep.headers.get("cache-control") }
  );
  const root = await get("/");
  ok("SPA: / → 200 i no-cache", root.status === 200 && root.headers.get("cache-control") === "no-cache", root.status);
  const apiMiss = await get("/api/nie-ma-takiej-trasy");
  ok("SPA: nieznane /api/* → 404 JSON, nigdy index.html", apiMiss.status === 404, apiMiss.status);
  ok("API: prawdziwa trasa API działa bez ETagu statyków", (await get("/api/ping")).status === 200);

  // --- Bezpieczeństwo ścieżki ---------------------------------------------
  const outsideName = OUTSIDE.split("/").pop() ?? "";
  for (const path of [`/../${outsideName}`, `/..%2f${outsideName}`, `/assets/../../${outsideName}`]) {
    const escape = await get(path);
    ok(
      `statyki: ${path} nie wychodzi poza katalog frontu`,
      escape.status !== 200 || !(await escape.text()).includes("tego nie ma prawa"),
      escape.status
    );
  }
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { force: true });
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
