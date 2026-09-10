/**
 * Generator ikon wtyczki: `extension/icons/icon{16,48,128}.png`.
 *
 * DLACZEGO skrypt, a nie ręcznie zrobione pliki: ikona ma jedno źródło prawdy
 * (SVG poniżej), a PNG-i są tylko renderem w trzech rozmiarach wymaganych przez
 * MV3. DLACZEGO PNG-i są commitowane, mimo że mamy generator: paczkę ZIP składa
 * backend z plików w `extension/` po białej liście — na serwerze nie chcemy
 * uruchamiać `sharp` przy każdym pobraniu.
 *
 * Uruchomienie (Node 22 — jak reszta narzędzi w repo):
 *   export PATH="/config/.nvm/versions/node/v22.22.0/bin:$PATH"
 *   npx tsx scripts/build-plugin-icons.ts
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const OUT_DIR = path.resolve(import.meta.dirname, "..", "extension", "icons");
const SIZES = [16, 48, 128] as const;

/** Granatowy kwadrat (#1e3a8a — ten sam kolor co przyciski panelu), białe „A”
 * i mała tarcza w narożniku (motyw z UI Alfa). Kształty liczone w viewBox 128,
 * więc skalowanie do 16 px nie rozjeżdża proporcji.
 *
 * DLACZEGO „A” jest ścieżką, a nie `<text>`: w tym środowisku (i na czystym
 * serwerze) librsvg nie ma fontconfiga ani fontów, więc `<text>` renderuje się
 * jako pusty prostokąt „tofu”. Ścieżka nie zależy od niczego. */
function iconSvg(size: number): string {
  // Przy 16 px tarcza zamienia się w plamę — na najmniejszym rozmiarze
  // zostawiamy samo „A”, żeby ikona była czytelna na pasku.
  const withShield = size >= 48;
  // Z tarczą litera schodzi w lewo i lekko się zmniejsza, żeby tarcza nie
  // przykrywała jej prawej nogi.
  const letterTransform = withShield ? "translate(-8 6) scale(0.88)" : "translate(0 0)";
  const letter = `<g fill="#ffffff" transform="${letterTransform}">
    <path d="M64 22 L100 106 L84 106 L64 58 L44 106 L28 106 Z"/>
    <rect x="47" y="76" width="34" height="14"/>
  </g>`;
  const shield = withShield
    ? `<path d="M97 72 L116 78 L116 96 C116 107 106 114 97 118 C88 114 78 107 78 96 L78 78 Z"
         fill="#ffffff"/>
       <path d="M97 82 L108 86 L108 96 C108 102 102 106 97 108 C92 106 86 102 86 96 L86 86 Z"
         fill="#1e3a8a"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect x="0" y="0" width="128" height="128" rx="28" ry="28" fill="#1e3a8a"/>
  ${letter}
  ${shield}
</svg>`;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const file = path.join(OUT_DIR, `icon${size}.png`);
    await sharp(Buffer.from(iconSvg(size)), { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(file);
    console.log(`✓ ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
