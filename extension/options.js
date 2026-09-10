/**
 * Strona opcji — wyłącznie do podglądu i diagnostyki.
 *
 * DLACZEGO nic tu nie da się zmienić: adres aplikacji i token wpisuje backend
 * do `config.js` przy generowaniu paczki. Ręczna edycja rozjechałaby wtyczkę
 * z uprawnieniami hosta w manifeście (te też podstawia backend), więc lepiej
 * pokazać stan i odesłać po nową paczkę.
 *
 * Token pokazujemy zamaskowany (4 pierwsze…4 ostatnie) — pełny leży w
 * `config.js` w paczce, ale wyświetlanie go na ekranie tylko zaprasza do
 * wklejania go w cudze miejsca.
 */
(function () {
  "use strict";

  const cfg = self.ALFA_CONFIG || {};

  function maskToken(token) {
    const t = String(token || "");
    if (!t) return "brak — pobierz nową paczkę z Magazynu";
    if (t.length <= 12) return "•".repeat(t.length);
    return t.slice(0, 4) + "…" + t.slice(-4);
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  setText("baseUrl", cfg.baseUrl || "—");
  setText("user", cfg.user || "—");
  setText("token", maskToken(cfg.token));
  setText("version", cfg.version || "—");
  setText("build", cfg.build || "brak (paczka sprzed wprowadzenia buildów)");

  const btn = document.getElementById("check");
  const result = document.getElementById("result");

  function show(text, kind) {
    result.className = "result" + (kind ? " " + kind : "");
    result.textContent = text;
  }

  btn.addEventListener("click", () => {
    btn.disabled = true;
    show("Sprawdzam…", "");
    // Fetch robi service worker (jedyne miejsce z tokenem i bez CORS-u).
    chrome.runtime.sendMessage({ type: "alfa-me" }, (res) => {
      btn.disabled = false;
      const failed = chrome.runtime.lastError;
      if (failed || !res) {
        show("Wtyczka nieaktywna — wyłącz i włącz ją w chrome://extensions", "err");
        return;
      }
      if (!res.ok) {
        show(res.error || "Nie udało się połączyć z Alfa", "err");
        return;
      }
      const me = res.data || {};
      const email = (me.user && (me.user.email || me.user.displayName)) || "nieznany użytkownik";
      const perms = me.canEdit ? "edycja" : "podgląd";
      const queued = typeof me.queued === "number" ? me.queued : 0;
      // Build (skrót plików paczki) jest pierwszym kryterium: pliki wtyczki
      // poprawiamy częściej niż numer wersji aplikacji, więc sama zgodna wersja
      // nie znaczy, że paczka jest aktualna.
      if (me.pluginBuild && me.pluginBuild !== cfg.build) {
        show(
          "Wtyczka nieaktualna — pobierz nową paczkę z Magazynu (build serwera " +
            me.pluginBuild +
            ", paczka " +
            (cfg.build || "brak") +
            ")",
          "warn",
        );
        return;
      }
      // Wersja paczki może mieć sufiks build (`x.y.z+coś`) — porównujemy sam x.y.z.
      const pkgVersion = String(cfg.version || "").split("+")[0];
      if (me.appVersion && pkgVersion && me.appVersion !== pkgVersion) {
        show(
          "Wtyczka nieaktualna — pobierz nową paczkę z Magazynu (aplikacja " +
            me.appVersion +
            ", paczka " +
            pkgVersion +
            ")",
          "warn",
        );
        return;
      }
      show("OK: " + email + " (uprawnienia: " + perms + "), kolejka: " + queued, "ok");
    });
  });
})();
