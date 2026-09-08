/**
 * Generator logo DO MAILA:
 *   npx tsx scripts/build-mail-logo.ts
 *
 * Wejście:  frontend/public/alfa-logo.png  (221×221, z kanałem alfa)
 * Wyjście:  frontend/public/alfa-logo-mail.png (136×136, BEZ kanału alfa)
 *
 * Po co osobny plik, skoro logo już mamy?
 *   • Outlook desktop renderuje Wordem, a Word potrafi spłaszczyć przezroczysty
 *     PNG na CZARNE tło — logo z alfą wychodzi w brudnej, czarnej ramce.
 *   • Word ignoruje `border-radius`, więc białej okrągłej podkładki (znak jest
 *     granatowy, pasek nagłówka też) nie da się narysować w HTML.
 * Dlatego podkładkę wypalamy w pikselach: biały krążek na pełną szerokość,
 * a narożniki poza krążkiem w kolorze paska nagłówka (#14447a). Na granatowym
 * pasku wygląda to jak biały krążek z logo — niezależnie od klienta pocztowego.
 *
 * Skrypt jest jednorazowy (i idempotentny) — wynik commitujemy do repo, żeby
 * build frontendu nie zależał od `sharp`.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "frontend/public/alfa-logo.png");
const TARGET = path.join(ROOT, "frontend/public/alfa-logo-mail.png");

/** Granat paska nagłówka maila (musi być 1:1 z NAVY w src/lib/order-mail.ts). */
const NAVY = "#14447a";
/** 2× rozmiar wyświetlania (68 px w mailu) — czytelnie na ekranach HiDPI. */
const SIZE = 136;
/** Biała obwódka wokół znaku, w pikselach obrazu wyjściowego. */
const RING = 12;

const logo = await sharp(SOURCE)
  .resize(SIZE - 2 * RING, SIZE - 2 * RING, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
  .png()
  .toBuffer();

// Podkładka: granatowe tło (narożniki) + biały krążek na pełną szerokość.
const plate = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${NAVY}"/>` +
    `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}" fill="#ffffff"/>` +
    `</svg>`
);

const composed = await sharp(plate)
  .composite([{ input: logo, left: RING, top: RING }])
  .png()
  .toBuffer();

// Drugie przejście, bo sharp wykonuje `flatten` PRZED `composite` niezależnie od
// kolejności wywołań — w jednym potoku alfa wracałaby razem z nakładanym logo.
// `flatten` zdejmuje kanał alfa i to jest cały sens tego pliku.
await sharp(composed)
  .flatten({ background: NAVY })
  .png({ compressionLevel: 9 })
  .toFile(TARGET);

const meta = await sharp(TARGET).metadata();
console.log(`${path.relative(ROOT, TARGET)} — ${meta.width}×${meta.height}, kanały: ${meta.channels}, alfa: ${meta.hasAlpha}`);
if (meta.hasAlpha) {
  console.error("BŁĄD: plik nadal ma kanał alfa — Outlook spłaszczy go na czarno.");
  process.exit(1);
}
