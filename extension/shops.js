/**
 * Lustro rejestru parserów sklepowych z backendu.
 *
 * PARZYSTOŚĆ: ta lista musi zgadzać się z `src/lib/shop-import/parsers/registry.ts`
 * (klucz = domena bez `www.`, `label` = ta sama etykieta pokazywana człowiekowi)
 * oraz z listą hostów w `manifest.json`. Test `scripts/test-plugin-api.ts`
 * sprawdza tę parzystość, więc dodanie sklepu = trzy miejsca naraz:
 * registry.ts + shops.js + manifest.json (content_scripts i host_permissions).
 *
 * DLACZEGO kopia w wtyczce, skoro backend i tak zwraca `shopLabel` w `lookup`:
 * panel musi coś napisać JESZCZE PRZED odpowiedzią service workera (i wtedy,
 * gdy backend jest nieosiągalny) — inaczej użytkownik widzi pusty prostokąt.
 *
 * `calibrated: false` = parser jest zaślepką (`version: "0-stub"`) i pod spodem
 * pracuje parser ogólny; panel dopisuje wtedy „Parser: ogólny (do kalibracji)”.
 */
/**
 * Markery zalogowania w sklepie.
 *
 * DLACZEGO to w ogóle sprawdzamy: w tych hurtowniach ceny hurtowe (i często
 * stany) widzi wyłącznie zalogowany klient. Strona bez logowania da cenę
 * detaliczną albo żadną, a taka cena wpisana do kartoteki jako cena zakupu psuje
 * marże w całym systemie. Backend liczy to samo na wysłanym HTML-u
 * (`src/lib/shop-import/login.ts`) — tu robimy to ZAWCZASU, żeby ostrzec
 * człowieka PRZED wysłaniem strony.
 *
 * WAGI (te same co w backendzie, bo inaczej panel i Alfa mówiłyby różne rzeczy):
 *  - `selectors`/`texts` w `loginMarkers` = sygnał mocny (+3): wylogowanie,
 *    widoczne konto — nie pojawiają się u gościa,
 *  - `weakSelectors`/`weakTexts` = sygnał słaby (+2): linki do panelu klienta,
 *    ceny netto, indywidualny rabat — bywają też w stopce dla gościa,
 *  - `anonMarkers.selectors`/`texts` = zaproszenie do logowania (−3),
 *  - `anonMarkers.missing` = selektory, których BRAK świadczy o gościu (−1;
 *    u SAMAL-a cena netto). Słabe, bo na liście kategorii ceny netto nie ma
 *    nawet dla zalogowanego.
 */
const GENERIC_LOGIN = {
  selectors: ['a[href*="wyloguj"]', 'a[href*="logout"]', '[class*="logout"]', '[class*="current-user"]'],
  texts: [/wyloguj/i, /logout/i],
  weakSelectors: ['a[href*="moje-konto"]', 'a[href*="my-account"]', 'a[href*="twoje-konto"]', 'a[href*="/panel"]'],
  weakTexts: [/moje konto/i],
};

const GENERIC_ANON = {
  selectors: ['a[href*="zaloguj"]', 'a[href*="/login"]', 'a[href*="logowanie"]', 'form[action*="login"]'],
  texts: [/zaloguj/i, /logowanie/i],
  missing: [],
};

self.ALFA_SHOPS = [
  {
    shop: "samal.pl",
    label: "SAMAL",
    parser: "samal",
    calibrated: true,
    // `.netto-price-ui` to element, z którego parser SAMAL-a bierze cenę netto —
    // jego obecność jest dowodem sesji hurtowej, a brak sygnałem gościa.
    loginMarkers: {
      selectors: [".sign-out-lq", ".current-user-ui"],
      texts: [/wyloguj/i],
      weakSelectors: [".netto-price-ui", 'a[href*="profil-klienta"]'],
      weakTexts: [],
    },
    anonMarkers: {
      selectors: ['a[href*="zaloguj"]', 'a[href*="logowanie"]'],
      texts: [/zaloguj/i],
      missing: [".netto-price-ui"],
    },
  },
  {
    shop: "janexint.com.pl",
    label: "Janex International",
    parser: "janex",
    calibrated: true,
    loginMarkers: {
      selectors: ['a[href*="wyloguj"]', 'a[href*="logout"]'],
      texts: [/wyloguj/i],
      weakSelectors: [],
      weakTexts: [/tw(ó|o)j rabat/i, /cena netto/i],
    },
    anonMarkers: {
      selectors: ['a[href*="/pl/logowanie"]', 'a[href*="logowanie"]', 'a[href*="zaloguj"]'],
      texts: [/zaloguj/i],
      missing: [],
    },
  },
  {
    shop: "eltrox.pl",
    label: "Eltrox",
    parser: "eltrox",
    calibrated: false,
    loginMarkers: GENERIC_LOGIN,
    anonMarkers: GENERIC_ANON,
  },
  {
    shop: "grodno.pl",
    label: "Grodno",
    parser: "grodno",
    calibrated: false,
    loginMarkers: GENERIC_LOGIN,
    anonMarkers: GENERIC_ANON,
  },
];

/** Markery dla sklepu bez własnego wpisu (i awaryjnie, gdy wpis ich nie ma). */
self.ALFA_LOGIN_MARKERS_GENERIC = { login: GENERIC_LOGIN, anon: GENERIC_ANON };

/** Dopasowanie po domenie z uwzględnieniem subdomen (sklep./b2b.grodno.pl). */
self.ALFA_SHOP_FOR = function alfaShopFor(hostname) {
  const key = String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
  for (const entry of self.ALFA_SHOPS) {
    if (key === entry.shop || key.endsWith("." + entry.shop)) return entry;
  }
  return null;
};
