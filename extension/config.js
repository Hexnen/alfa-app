/**
 * Konfiguracja wtyczki — PLIK PRZYKŁADOWY (deweloperski).
 *
 * DLACZEGO taki plik zamiast wpisywania adresu w opcjach: paczkę ZIP generuje
 * backend (`GET /api/warehouse/plugin/download`) i przy pobraniu PODMIENIA ten
 * plik na wersję z prawdziwym adresem aplikacji, tokenem użytkownika i wersją
 * aplikacji. Dzięki temu użytkownik nic nie konfiguruje ręcznie — rozpakowuje
 * i ładuje. Ta wersja z repo służy tylko do pracy nad wtyczką lokalnie i do
 * tego, żeby `background.js` (importScripts) i content scripty miały co wczytać.
 *
 * `token` jest pusty celowo: bez tokenu wtyczka odpowie 401 i pokaże komunikat
 * „pobierz nową paczkę z Magazynu” — to lepsze niż udawanie, że działa.
 */
self.ALFA_CONFIG = {
  baseUrl: "http://localhost:4000",
  apiBase: "http://localhost:4000/api",
  token: "",
  version: "0.0.0",
  /** 8-znakowy skrót plików paczki — po nim panel poznaje, że wtyczka jest stara. */
  build: "",
  user: "",
};
