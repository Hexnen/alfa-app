/**
 * Wersja aplikacji pokazywana w interfejsie (dolny pasek sidebara → „Co nowego”).
 * Podbijana przez skill `/commit` razem z wpisem changelogu i polem `version`
 * w głównym `package.json` — te trzy miejsca muszą się zgadzać.
 */
export const APP_VERSION = "1.10.0";

/**
 * Wersja PANELU TECHNIKA (`/technik`) — podbijana niezależnie od `APP_VERSION`
 * przez skill `/commit`, gdy zmiana dotyczy panelu. Technik widzi ją w zakładce
 * „Więcej” i na własnej stronie „Co nowego” (`/technik/co-nowego`): panel ma
 * własne tempo wydań i własny changelog, pisany językiem pracownika w terenie,
 * a nie biura.
 */
export const TECHNIK_VERSION = "1.4.0";
