// Model stanu edytora struktury manuala: punkty („1.”) i podpunkty („1.1”),
// maksymalnie dwa poziomy — plus czyste przekształcenia tego stanu i drobiazgi
// schowka. Render mieszka obok, w `ManualSectionsEditor.tsx`; tutaj nie ma
// Reacta, żeby dało się to wołać i z komponentu, i z testu.
//
// Model jest lokalny (klucz `key`), a nie bazowy: nowy punkt nie ma jeszcze id,
// a pliki i tak trzeba do niego przypiąć po zapisie — backend oddaje `keyMap`
// (`key` → nadane id), więc klucz musi przeżyć całą sesję formularza.
import type { Manual, ManualAttachment, ManualSection, ManualSectionInput } from "@/lib/api";
import { isImageFile } from "./manualsShared";

/** Maksymalna długość tytułu punktu — tyle samo, ile przyjmuje backend. */
export const SECTION_TITLE_MAX = 200;

/** Plik wybrany w formularzu, jeszcze nie wysłany na serwer. */
export interface PendingFile {
  key: string;
  file: File;
  /** Object URL miniatury (tylko obrazki) — zwalniany przy usunięciu / zapisie / zamknięciu. */
  previewUrl: string | null;
}

/**
 * Punkt w formularzu. `id === null` = punkt jeszcze nie istnieje w bazie;
 * `children` wypełniamy tylko na pierwszym poziomie (głębiej backend odpowiada 400).
 */
export interface EditorSection {
  key: string;
  id: number | null;
  title: string;
  body: string;
  /** Załączniki już zapisane na serwerze, przypisane do tego punktu. */
  attachments: ManualAttachment[];
  /** Pliki do wysłania po zapisaniu struktury (POST /attachments?sectionId=…). */
  pending: PendingFile[];
  children: EditorSection[];
}

let seq = 0;

/** Klucz lokalny — unikalny w obrębie sesji formularza (leci jako `key` do API). */
export const nextKey = (prefix = "s") => `${prefix}${Date.now().toString(36)}-${++seq}`;

export const emptySection = (): EditorSection => ({
  key: nextKey(),
  id: null,
  title: "",
  body: "",
  attachments: [],
  pending: [],
  children: [],
});

export const makePending = (file: File): PendingFile => ({
  key: nextKey("f"),
  file,
  previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
});

export const revokePending = (list: PendingFile[]) => {
  for (const p of list) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
};

/** Wszystkie niewysłane pliki w drzewie (do zwalniania miniatur i liczenia limitu). */
export const allPending = (sections: EditorSection[]): PendingFile[] =>
  sections.flatMap((s) => [...s.pending, ...s.children.flatMap((c) => c.pending)]);

/** Ile plików manual będzie miał po zapisie (istniejące + niewysłane) — limit liczymy przed strzałem. */
export const countFiles = (sections: EditorSection[], unassigned: ManualAttachment[]): number =>
  unassigned.length +
  sections.reduce(
    (n, s) =>
      n +
      s.attachments.length +
      s.pending.length +
      s.children.reduce((m, c) => m + c.attachments.length + c.pending.length, 0),
    0
  );

const fromApi = (s: ManualSection): EditorSection => ({
  key: nextKey(),
  id: s.id,
  title: s.title ?? "",
  body: s.body ?? "",
  attachments: [...s.attachments],
  pending: [],
  children: (s.children ?? []).map(fromApi),
});

/** Stan formularza z manuala z backendu (świeży odczyt = świeże klucze lokalne). */
export const sectionsFromManual = (manual: Manual | null): EditorSection[] =>
  (manual?.sections ?? []).map(fromApi);

/** Punkt bez tytułu, tekstu i plików — przy zapisie wypada po cichu (kontrakt). */
const isBlank = (s: EditorSection): boolean =>
  !s.title.trim() && !s.body.trim() && s.attachments.length === 0 && s.pending.length === 0;

/**
 * Drzewo formularza → wejście `PUT /manuals/:id/sections`. Puste punkty wycinamy
 * (bez błędu), ale punkt-nagłówek z niepustymi podpunktami zostaje, żeby ich nie
 * osierocić. Nowe punkty jadą z `key`, istniejące z `id`.
 */
export function sectionsToInput(sections: EditorSection[]): ManualSectionInput[] {
  const node = (s: EditorSection, children: ManualSectionInput[]): ManualSectionInput => ({
    ...(s.id !== null ? { id: s.id } : { key: s.key }),
    title: s.title.trim() || null,
    body: s.body.trim() || null,
    attachmentIds: s.attachments.map((a) => a.id),
    ...(children.length ? { children } : {}),
  });

  const out: ManualSectionInput[] = [];
  for (const s of sections) {
    const children = s.children.filter((c) => !isBlank(c)).map((c) => node(c, []));
    if (isBlank(s) && children.length === 0) continue;
    out.push(node(s, children));
  }
  return out;
}

/** Pary (klucz punktu → pliki do wysłania) w kolejności wyświetlania. */
export function pendingUploads(sections: EditorSection[]): { key: string; id: number | null; files: File[] }[] {
  const out: { key: string; id: number | null; files: File[] }[] = [];
  const visit = (s: EditorSection) => {
    if (s.pending.length) out.push({ key: s.key, id: s.id, files: s.pending.map((p) => p.file) });
    for (const c of s.children) visit(c);
  };
  for (const s of sections) visit(s);
  return out;
}

// ---------------------------------------------------------------------------
// Przekształcenia drzewa (czyste — używa ich i edytor, i dialog)
// ---------------------------------------------------------------------------

/** Podmienia punkt o danym kluczu na obu poziomach. */
export function patchSection(
  list: EditorSection[],
  key: string,
  patch: (s: EditorSection) => EditorSection
): EditorSection[] {
  return list.map((s) => {
    if (s.key === key) return patch(s);
    if (s.children.some((c) => c.key === key)) {
      return { ...s, children: s.children.map((c) => (c.key === key ? patch(c) : c)) };
    }
    return s;
  });
}

/** Usuwa punkt (razem z podpunktami, jeśli to poziom 1). */
export function removeSection(list: EditorSection[], key: string): EditorSection[] {
  return list
    .filter((s) => s.key !== key)
    .map((s) => (s.children.some((c) => c.key === key) ? { ...s, children: s.children.filter((c) => c.key !== key) } : s));
}

/** Przesuwa punkt o jedno miejsce wśród rodzeństwa (delta -1 / +1). */
export function moveSection(list: EditorSection[], key: string, delta: -1 | 1): EditorSection[] {
  const swap = (arr: EditorSection[]): EditorSection[] | null => {
    const i = arr.findIndex((s) => s.key === key);
    if (i < 0) return null;
    const j = i + delta;
    if (j < 0 || j >= arr.length) return arr;
    const next = [...arr];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };
  const top = swap(list);
  if (top) return top;
  return list.map((s) => ({ ...s, children: swap(s.children) ?? s.children }));
}

/** Płaska lista punktów z numeracją — do selecta „Przenieś do punktu…”. */
export function sectionOptions(sections: EditorSection[]): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  sections.forEach((s, i) => {
    const n = String(i + 1);
    out.push({ key: s.key, label: `${n}. ${s.title.trim() || "(bez tytułu)"}` });
    s.children.forEach((c, j) => {
      out.push({ key: c.key, label: `${n}.${j + 1} ${c.title.trim() || "(bez tytułu)"}` });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Schowek
// ---------------------------------------------------------------------------

const two = (n: number) => String(n).padStart(2, "0");

/** `wklejony-2026-09-09-154233.png` — nazwa czytelna na liście plików. */
function pastedName(mime: string, index: number): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(
    d.getMinutes()
  )}${two(d.getSeconds())}`;
  const ext = /jpe?g/.test(mime) ? "jpg" : /webp/.test(mime) ? "webp" : /gif/.test(mime) ? "gif" : "png";
  return `wklejony-${stamp}${index > 0 ? `-${index + 1}` : ""}.${ext}`;
}

/**
 * Obrazki ze schowka (Ctrl+V) przemianowane na `wklejony-…`. Zrzut ekranu trafia
 * do schowka bez nazwy pliku („image.png”), więc nazwę nadajemy sami — inaczej
 * kilka wklejeń dawałoby kilka plików o tej samej nazwie.
 */
export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const raw: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) raw.push(f);
  }
  // Firefox bywa szczodrzejszy w `files` niż w `items` — bierzemy to, co jest.
  if (raw.length === 0) {
    for (const f of Array.from(data.files ?? [])) if (f.type.startsWith("image/")) raw.push(f);
  }
  return raw.map((f, i) => new File([f], pastedName(f.type, i), { type: f.type || "image/png" }));
}

