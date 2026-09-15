import { useSyncExternalStore } from "react";

/**
 * MOTYW PANELU TECHNIKA — jasny / ciemny / systemowy.
 *
 * Wariant ciemny był w `globals.css` (`.dark`) od zawsze, ale nic tej klasy nie
 * zakładało: technik nie miał jak go włączyć, a tablet w bramie o 22:00 świeci
 * bielą prosto w oczy.
 *
 * KLASA `dark` JEST GLOBALNA — Tailwind ma `darkMode: ["class"]` i siedzi na
 * `<html>`, więc przełącznik z panelu przemalowałby też CRM. Dlatego wybór
 * zakłada i zdejmuje `TechnikShell` (montowany tylko pod `/technik`), a przy
 * wyjściu do CRM-a klasa znika. To samo robi skrypt w `index.html` przed
 * pierwszym malowaniem — tam warunkiem jest ścieżka, bo Reacta jeszcze nie ma.
 */
export type TechnikTheme = "light" | "dark" | "system";

const KEY = "technik.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Tło panelu w obu motywach — do `<meta name="theme-color">` (pasek systemowy). */
const THEME_COLOR: Record<"light" | "dark", string> = {
  light: "#ffffff",
  dark: "#020817",
};

const isTheme = (v: unknown): v is TechnikTheme =>
  v === "light" || v === "dark" || v === "system";

export function readTechnikTheme(): TechnikTheme {
  try {
    const raw = localStorage.getItem(KEY);
    return isTheme(raw) ? raw : "system";
  } catch {
    // Prywatne okno bez localStorage — zostaje ustawienie systemu.
    return "system";
  }
}

/** Czy przy danym wyborze panel ma być ciemny. */
export function resolveDark(theme: TechnikTheme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

function setThemeColor(dark: boolean): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", THEME_COLOR[dark ? "dark" : "light"]);
}

/** Zakłada klasę `dark` zgodnie z wyborem. Wołane wyłącznie z `TechnikShell`. */
export function applyTechnikTheme(theme: TechnikTheme): void {
  const dark = resolveDark(theme);
  document.documentElement.classList.toggle("dark", dark);
  setThemeColor(dark);
}

/** Wyjście do CRM-a: motyw biura jest jasny i nie ma go czym przełączyć. */
export function clearTechnikTheme(): void {
  document.documentElement.classList.remove("dark");
  setThemeColor(false);
}

// --- minimalny store, żeby „Więcej” i powłoka widziały tę samą wartość ------
const listeners = new Set<() => void>();
let current: TechnikTheme | null = null;

const getSnapshot = (): TechnikTheme => (current ??= readTechnikTheme());

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setTechnikTheme(theme: TechnikTheme): void {
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Zapis nieobowiązkowy — wybór zadziała do końca sesji.
  }
  applyTechnikTheme(theme);
  for (const fn of listeners) fn();
}

/** Wybór motywu + jego zapis. Serwer renderuje „system”. */
export function useTechnikTheme(): [TechnikTheme, (t: TechnikTheme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => "system" as TechnikTheme);
  return [theme, setTechnikTheme];
}

/**
 * Trzyma klasę `dark` w zgodzie z wyborem, dopóki panel jest zamontowany —
 * razem z nasłuchem na zmianę motywu systemu (wariant „Systemowy”).
 * Zwraca funkcję sprzątającą: klasa znika, kolor paska wraca do jasnego.
 */
export function bindTechnikTheme(): () => void {
  applyTechnikTheme(getSnapshot());

  const onStore = () => applyTechnikTheme(getSnapshot());
  listeners.add(onStore);

  const mql = typeof matchMedia === "function" ? matchMedia(DARK_QUERY) : null;
  const onSystem = () => {
    if (getSnapshot() === "system") applyTechnikTheme("system");
  };
  mql?.addEventListener("change", onSystem);

  return () => {
    listeners.delete(onStore);
    mql?.removeEventListener("change", onSystem);
    clearTechnikTheme();
  };
}
