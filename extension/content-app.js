/**
 * Content script wstrzykiwany w samą aplikację Alfa.
 *
 * Jego jedyne zadanie: przenieść sygnał „otwórz import <id>” ze świata wtyczki
 * do świata Reacta. DLACZEGO przez `window.postMessage`, a nie bezpośrednio:
 * content script żyje w izolowanym świecie JS i nie widzi stanu aplikacji, więc
 * nie może wywołać `navigate()`. `postMessage` z jawnym `targetOrigin` odbiera
 * `PluginImportBridge` w aplikacji (sprawdza `origin`, `source === window`
 * i typ), co daje najmniejszą możliwą powierzchnię styku.
 *
 * DLACZEGO w ogóle sygnał, a nie po prostu nawigacja na `?import=`: karta jest
 * już otwarta i użytkownik ma w niej stan (filtry, otwarty formularz) —
 * przeładowanie byłoby stratą. Nawigacja została jako fallback w background.js.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;

  // Ping: background.js sprawdza, czy w tej karcie w ogóle jest content script
  // (po przeładowaniu wtyczki stare karty go nie mają).
  if (msg.type === "alfa-ping") {
    sendResponse({ ok: true });
    return undefined;
  }

  if (msg.type === "alfa-import-open") {
    try {
      window.postMessage({ type: "alfa-import-open", id: msg.id }, window.location.origin);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return undefined;
  }

  return undefined;
});
