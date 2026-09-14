/**
 * KOMPRESJA ZDJĘĆ PRZED WYSŁANIEM — panel technika, aparat tabletu.
 *
 * Po co: iPad robi zdjęcia po 4–8 MB, a serwer przyjmuje 5 MB na plik
 * (src/lib/calendar-attachments.ts). Zamiast odbijać technika komunikatem
 * „plik przekracza 5 MB” pod bramą u klienta, skalujemy zdjęcie w przeglądarce
 * do 1600 px dłuższego boku i pakujemy w JPEG. Serwer i tak zrobi z tego WebP
 * (max 2560 px), więc nic tu nie tracimy poza wagą — a wysyłka z LTE przestaje
 * trwać minutę.
 *
 * Zasada awaryjna: kompresja NIE MOŻE zjeść zdjęcia. Czego przeglądarka nie
 * zdekoduje (HEIC na Androidzie, uszkodzony plik, brak canvasu), leci
 * oryginałem — wtedy odpowiada serwer i technik dostaje czytelny komunikat,
 * zamiast pustej notatki.
 */

/** Dłuższy bok po zmniejszeniu. 1600 px wystarcza na dowód „kabel wisiał tak”. */
const MAX_SIDE = 1600;
/** Jakość JPEG — 0,82 to granica, poniżej której widać artefakty na siatce. */
const QUALITY = 0.82;
/** Poniżej tego rozmiaru nie ma czego ratować — zdjęcie leci jak jest. */
const SKIP_BELOW_BYTES = 600 * 1024;

/** Czy w ogóle warto próbować (pliki inne niż obrazki zostawiamy w spokoju). */
function isShrinkable(file: File): boolean {
  if (!file.type.startsWith("image/")) return false;
  // Animacji nie da się przepuścić przez canvas bez utraty klatek.
  if (file.type === "image/gif") return false;
  return file.size > SKIP_BELOW_BYTES;
}

/** Bitmapa z pliku — `createImageBitmap` prostuje obrót z EXIF-u sam. */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Safari bywa wybredne — próbujemy jeszcze zwykłym <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode"));
      img.src = url;
    });
  } finally {
    // Zwalniamy dopiero po załadowaniu — wcześniej obrazek nie miałby skąd wziąć danych.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function sizeOf(src: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  return src instanceof HTMLImageElement
    ? { w: src.naturalWidth, h: src.naturalHeight }
    : { w: src.width, h: src.height };
}

/** Nazwa pliku po konwersji: ta sama, ale z rozszerzeniem .jpg. */
function jpegName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "zdjecie";
  return `${base}.jpg`;
}

/**
 * Zmniejsza zdjęcie do 1600 px dłuższego boku (JPEG ~0,82). Zwraca NOWY plik
 * albo — gdy się nie da lub nic by to nie dało — ten sam, który dostała.
 * Nigdy nie rzuca: wołający ma wysłać cokolwiek, a nie obsługiwać wyjątek.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!isShrinkable(file)) return file;
  try {
    const src = await decode(file);
    const { w, h } = sizeOf(src);
    if (!w || !h) return file;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(src, 0, 0, width, height);
    if (src instanceof ImageBitmap) src.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY)
    );
    // Zdjęcia już mocno skompresowane potrafią po przejściu przez canvas urosnąć.
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    // HEIC, uszkodzony plik, brak pamięci — niech zdecyduje serwer.
    return file;
  }
}
