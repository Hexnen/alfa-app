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
 * zdekoduje (uszkodzony plik, brak canvasu), leci oryginałem — wtedy odpowiada
 * serwer i technik dostaje czytelny komunikat, zamiast pustej notatki.
 *
 * Wyjątkiem jest HEIC z galerii: jego serwer też nie przetworzy, więc
 * `prepareForUpload` odrzuca go jeszcze przed wysyłką i mówi, co z tym zrobić.
 */

/** Dłuższy bok po zmniejszeniu. 1600 px wystarcza na dowód „kabel wisiał tak”. */
const MAX_SIDE = 1600;
/** Jakość JPEG — 0,82 to granica, poniżej której widać artefakty na siatce. */
const QUALITY = 0.82;
/** Poniżej tego rozmiaru nie ma czego ratować — zdjęcie leci jak jest. */
const SKIP_BELOW_BYTES = 600 * 1024;

/** Rozszerzenia, które uznajemy za obrazek, gdy system nie poda typu MIME. */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif)$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;

/**
 * Czy plik w ogóle jest zdjęciem. Wybór z galerii potrafi oddać cokolwiek:
 * Android pokazuje w tym samym selektorze filmy, a udostępnianie z Plików
 * oddaje zdjęcie z PUSTYM typem MIME. Pusty typ rozstrzygamy po rozszerzeniu,
 * bo „brak typu” nie znaczy „nie obrazek”.
 */
export function isImageLike(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (type) return type.startsWith("image/");
  return IMAGE_EXT_RE.test(file.name);
}

/**
 * Czy plik to HEIC/HEIF — format, którego nie zdekoduje ani Chrome na
 * Androidzie, ani sharp na serwerze (prebuilt libvips czyta z rodziny HEIF
 * tylko AVIF-a). iOS przy `accept="image/*"` zwykle sam konwertuje przy
 * wyborze z biblioteki, ale plik udostępniony z „Plików” albo zgrany z innego
 * telefonu przychodzi jako HEIC i musi mieć własny komunikat.
 */
export function isHeicLike(file: File): boolean {
  const type = (file.type || "").toLowerCase().split(";")[0].trim();
  if (type === "image/heic" || type === "image/heif") return true;
  if (type === "image/heic-sequence" || type === "image/heif-sequence") return true;
  if (type && type !== "application/octet-stream") return false;
  return HEIC_EXT_RE.test(file.name);
}

/**
 * Czy w ogóle warto próbować (pliki inne niż obrazki zostawiamy w spokoju).
 *
 * PUSTY `type` to NIE „nie obrazek”: iPad przy udostępnianiu z Plików potrafi
 * oddać HEIC-a bez typu MIME, a Android robi to samo z niektórymi aparatami.
 * Taki plik przechodził wcześniej bez kompresji i odbijał się od bramy 5 MB
 * pod klientem. Teraz po prostu próbujemy go zdekodować — jak się nie uda,
 * `shrinkImage` i tak odda oryginał.
 *
 * HEIC idzie przez canvas ZAWSZE, także mały: dla niego przejście przez canvas
 * to nie oszczędność bajtów, tylko jedyna droga do formatu, który serwer
 * przyjmie — a jak się nie uda, to po tym właśnie poznajemy, że pliku nie da
 * się wysłać (`prepareForUpload`).
 */
function isShrinkable(file: File): boolean {
  if (file.type && !file.type.startsWith("image/")) return false;
  // Animacji nie da się przepuścić przez canvas bez utraty klatek.
  if (file.type === "image/gif") return false;
  if (isHeicLike(file)) return true;
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
    // BIAŁE TŁO PRZED RYSOWANIEM. Świeży canvas jest przezroczysty, a JPEG
    // przezroczystości nie zna — zrzut ekranu czy schemat w PNG z alfą
    // wychodził po kompresji jako CZARNA plama z białym tekstem. Tło zakrywa
    // tylko to, co i tak było przezroczyste.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(src, 0, 0, width, height);
    if (src instanceof ImageBitmap) src.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY)
    );
    // Zdjęcia już mocno skompresowane potrafią po przejściu przez canvas urosnąć.
    // Przy HEIC-u bierzemy JPEG-a NAWET większego: oryginału serwer i tak nie
    // przetworzy, więc „mniejszy plik” byłby oszczędnością na pustym miejscu.
    if (!blob) return file;
    if (blob.size >= file.size && !isHeicLike(file)) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    // HEIC, uszkodzony plik, brak pamięci — niech zdecyduje serwer.
    return file;
  }
}

/**
 * Komunikat dla zdjęcia, którego nie da się wysłać — jedno zdanie i od razu
 * z wyjściem („zapisz jako JPG”). Technik stoi pod bramą, nie będzie zgadywał,
 * co znaczy „nieobsługiwany typ pliku”.
 */
export function unsupportedPhotoMessage(name: string): string {
  return `„${name}” — tego formatu zdjęcia nie da się dodać. Zapisz je jako JPG albo zrób zdjęcie aparatem.`;
}

/**
 * Zdjęcie gotowe do wysyłki: zmniejszone, a przy okazji SPRAWDZONE.
 *
 * `shrinkImage` z założenia nigdy nie rzuca — czego nie zdekoduje, oddaje
 * w oryginale i niech martwi się serwer. Dla HEIC-a to była droga donikąd:
 * serwer odbijał go suchym „Nie udało się przetworzyć obrazka”, bo sharp
 * w tym buildzie czyta z rodziny HEIF tylko AVIF-a. Skoro po kompresji plik
 * NADAL jest HEIC-iem, to znaczy, że przeglądarka też go nie zdekodowała —
 * i wtedy lepiej powiedzieć to wprost, zamiast wysyłać coś, co na pewno
 * wróci błędem.
 */
export async function prepareForUpload(file: File): Promise<File> {
  if (!isImageLike(file)) throw new Error(unsupportedPhotoMessage(file.name));
  const out = await shrinkImage(file);
  if (isHeicLike(out)) throw new Error(unsupportedPhotoMessage(file.name));
  return out;
}
