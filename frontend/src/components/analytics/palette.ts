/**
 * Paleta wykresów modułu analityki finansowej.
 *
 * Tusze i szarości są przepisane 1:1 z `CmaTrends.tsx` — jedyny działający
 * silnik wykresów w repo. Trzymamy je tutaj kopią, a nie importem, bo
 * `CmaTrends.tsx` to duża strona z własnym stanem; wyciąganie z niej wspólnego
 * modułu oznaczałoby refaktor działającego kodu bez zysku.
 */

export const INK_PRIMARY = "#0f172a";
export const INK_SECONDARY = "#64748b";
export const INK_MUTED = "#94a3b8";
export const GRIDLINE = "#e2e8f0";
export const BASELINE = "#cbd5e1";
export const GAP_FILL = "#f8fafc";
export const HOVER_WASH = "#f1f5f9";

// Semantyczne barwy finansowe — walidowane walidatorem palety ze skilla
// `dataviz` jako jeden pięciokolorowy system (pasmo jasności, próg chromy,
// separacja CVD, kontrast >= 3:1 na bieli). Wynik: ALL CHECKS PASS zarówno
// w trybie sąsiedztwa, jak i `--pairs all`.
//
// Trzy pierwsze pochodzą ze zwalidowanego zestawu z `CmaTrends.tsx:29-41`.
export const COLOR_REVENUE = "#2a78d6"; // niebieski — przychód
export const COLOR_LOSS = "#e34948"; // czerwony — strata / ujemna marża
export const COLOR_SETUP = "#4a3aa7"; // fiolet — koszt wdrożenia / prowizja

// Dwie nowe barwy dobrane pod te trzy i zwalidowane razem z nimi.
// Bursztyn celowo jest ciemny (L 0.55), a nie „ładny" #b45309: jaśniejsze
// warianty spadają poniżej progu 15 ΔE względem czerwieni straty i nawet
// widzący pełną paletę mylą koszt ze stratą w tym samym słupku.
// Zieleń ciągnie w stronę szmaragdu, bo czysta zieleń przy protanopii/
// deuteranopii zlewa się z czerwienią (para zysk/strata to najważniejsze
// rozróżnienie w tym module).
export const COLOR_COST = "#96520a"; // bursztyn — koszt (obiektu, handlowca)
export const COLOR_PROFIT = "#05a48c"; // zieleń — zysk / dodatnia marża

/**
 * Szarość stanu „brak danych" — koszt bywa `null` („nieuzupełniony"), co NIE
 * jest tym samym co 0 zł. Wypełnienie tą szarością (zwykle plus szrafura)
 * mówi „nie wiemy", zamiast udawać wynik.
 */
export const NO_DATA = "#94a3b8";
export const NEUTRAL = NO_DATA;

/** Kolejność sąsiedztwa użyta przy walidacji palety — kolejność ma znaczenie. */
export const FINANCE_PALETTE = [
  COLOR_REVENUE,
  COLOR_COST,
  COLOR_PROFIT,
  COLOR_LOSS,
  COLOR_SETUP,
] as const;
