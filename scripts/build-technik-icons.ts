/**
 * Generator IKON PWA panelu technika:
 *   npx tsx scripts/build-technik-icons.ts
 *
 * Wejście:  frontend/public/alfa-logo.png (221×221, z kanałem alfa)
 * Wyjście:  frontend/public/technik-icon-192.png
 *           frontend/public/technik-icon-512.png
 *           frontend/public/technik-icon-maskable-512.png
 *
 * Po co osobne pliki, skoro w `public/` leży już favicon?
 *   • Manifest wymaga 192 i 512; favicon ma tylko 192, a 32.
 *   • Ikona `maskable` to INNY KADR tego samego znaku, nie ten sam plik:
 *     Android dokłada własną maskę (koło, squircle, kropla) i przycina do
 *     wewnętrznych 80% — logo puszczone na krawędź traci w niej skrzydła.
 *     Dlatego wariant maskable ma znak na 66% szerokości i granatowy margines.
 *
 * Tło (`NAVY`) to kolor wzięty z `favicon-192.png` — ten sam, który idzie do
 * `theme_color`/`background_color` w `technik.webmanifest`. Ikona na ekranie
 * początkowym ma wyglądać jak dotychczasowy favicon w zakładce, a nie jak
 * drugie, obce logo.
 *
 * Skrypt jest jednorazowy (i idempotentny) — wynik commitujemy do repo, żeby
 * build frontendu nie zależał od `sharp`. Tak samo jak build-mail-logo.ts.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "frontend/public");
const SOURCE = path.join(PUBLIC_DIR, "alfa-logo.png");

/** Granat kafelka — piksel narożny `favicon-192.png`; 1:1 z `TECHNIK_THEME` w manifeście. */
const NAVY = { r: 0, g: 33, b: 88, alpha: 1 };

/**
 * @param size   bok gotowej ikony w pikselach
 * @param inset  jaką część boku zajmuje znak (1 = na krawędź)
 */
async function build(size: number, inset: number, fileName: string): Promise<void> {
  const inner = Math.round(size * inset);
  const logo = await sharp(SOURCE)
    .resize(inner, inner, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: "lanczos3",
    })
    // Źródło ma 221 px, a cel do 512 — delikatne wyostrzenie ratuje kontury
    // tarczy po powiększeniu.
    .sharpen({ sigma: 0.6 })
    .toBuffer();

  const offset = Math.round((size - inner) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([{ input: logo, top: offset, left: offset }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUBLIC_DIR, fileName));

  console.log(`${fileName}: ${size}×${size}, znak ${inner} px`);
}

// „any”: system pokazuje plik BEZ kadrowania, więc znak idzie prawie na krawędź.
await build(192, 0.94, "technik-icon-192.png");
await build(512, 0.94, "technik-icon-512.png");
// „maskable”: znak mieści się w bezpiecznym polu (wewnętrzne 80%), reszta to margines.
await build(512, 0.66, "technik-icon-maskable-512.png");
