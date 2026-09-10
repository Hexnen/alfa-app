/**
 * Paczka wtyczki przeglądarki — gdzie leży i jaki ma „build”.
 *
 * Wspólne dla obu routerów (sesyjnego `warehouse-plugin.ts`, który pakuje ZIP,
 * i tokenowego `plugin.ts`, który odpowiada wtyczce), żeby oba mówiły o tym
 * samym zestawie plików. `plugin.ts` nie może importować z `warehouse-plugin.ts`
 * (tamten importuje z niego), stąd osobny moduł.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Katalog z plikami wtyczki. Nadpisywalny (`ALFA_EXTENSION_DIR`), bo testy
 * składają własną paczkę w katalogu tymczasowym, a w obrazie Dockera katalog
 * `extension/` leży obok `scripts/` w `/app`.
 */
export function extensionDir(): string {
  const configured = (process.env.ALFA_EXTENSION_DIR || "").trim();
  return configured || join(process.cwd(), "extension");
}

/**
 * JAWNA biała lista plików paczki — nie `readdir`.
 *
 * Katalog `extension/` jest w repozytorium, ale w obrazie stoi obok kodu
 * serwera: gdyby ZIP powstawał z listingu katalogu, przypadkowy plik
 * (`.env.local`, notatka, backup edytora) wyjechałby do użytkownika razem
 * z wtyczką. Lista jest krótka i zmienia się razem z paczką — to dobre
 * miejsce, żeby ta zmiana była widoczna w diffie.
 */
export const PACKAGE_FILES = [
  "manifest.json",
  "background.js",
  "content-shop.js",
  "content-app.js",
  "shops.js",
  "options.html",
  "options.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
] as const;

/**
 * „Build” paczki = skrót treści plików z białej listy (8 hex).
 *
 * Wersja z package.json zmienia się przy wydaniach aplikacji, a paczka
 * wtyczki — przy każdej poprawce w `extension/`; porównywanie samej wersji
 * nie wykryłoby, że ktoś ma wtyczkę sprzed poprawki content scriptu. Skrót
 * liczymy z plików źródłowych (bez generowanego `config.js`, bo ten zawiera
 * token i adres — różny dla każdego użytkownika), więc każdy pobrany ZIP
 * z tego samego serwera ma ten sam build. Cache per proces: pliki nie
 * zmieniają się w trakcie życia serwera. Brak plików → "unknown" zamiast
 * wyjątku — o niekompletnej paczce informuje trasa pobierania, nie `lookup`.
 */
let cachedBuild: string | null = null;
export function pluginBuild(): string {
  if (cachedBuild) return cachedBuild;
  const dir = extensionDir();
  const hash = createHash("sha1");
  let complete = true;
  for (const file of PACKAGE_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      complete = false;
      break;
    }
    hash.update(file);
    hash.update(readFileSync(path));
  }
  cachedBuild = complete ? hash.digest("hex").slice(0, 8) : "unknown";
  return cachedBuild;
}

/** Reset cache — tylko dla testów, które podmieniają katalog paczki. */
export function resetPluginBuildCache(): void {
  cachedBuild = null;
}
