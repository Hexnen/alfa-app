/**
 * Czy zapisana strona pochodzi z sesji zalogowanej?
 *
 * To nie jest ciekawostka, tylko warunek sensowności całego importu: w tych
 * sklepach ceny hurtowe (i często stany magazynowe) widzi wyłącznie zalogowany
 * klient. Strona zapisana bez logowania da ceny detaliczne albo żadne, a taka
 * cena wpisana do kartoteki jako cena zakupu psuje marże w całym systemie.
 *
 * Dlatego liczymy punkty z kilku niezależnych sygnałów, a nie jeden selektor:
 * każdy sklep pokazuje zalogowanie inaczej, a zapisany HTML bywa okrojony.
 */
import type { Doc } from "./dom-types.js";
import { collapse } from "./dom.js";

export interface LoginDetection {
  loggedIn: boolean;
  /** Opisy sygnałów dla panelu — człowiek ma zobaczyć DLACZEGO tak uznaliśmy. */
  signals: string[];
  /** Login/e-mail konta. Tylko do UI, nie zapisujemy go w bazie. */
  accountLabel: string | null;
  score: number;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

export function detectLogin(doc: Doc, opts: { hasPrice: boolean }): LoginDetection {
  const { $ } = doc;
  const bodyText = collapse($("body").text());
  const signals: string[] = [];
  let score = 0;

  const logoutSelector =
    $('a[href*="wyloguj"], a[href*="logout"], a[href*="/wyjdz"], button[class*="sign-out"], [class*="logout"], input[value*="Logout"]').length > 0;
  const logoutText = /wyloguj/i.test(bodyText);
  if (logoutSelector || logoutText) {
    score += 3;
    signals.push("jest wylogowanie („Wyloguj”)");
  }

  const account = findAccountLabel(doc);
  if (account) {
    score += 3;
    signals.push(`widoczne konto (${account})`);
  }

  if ($('a[href*="profil-klienta"], a[href*="moje-konto"], a[href*="twoje-konto"], a[href*="my-account"], a[href*="/panel"]').length > 0) {
    score += 2;
    signals.push("linki do panelu klienta");
  }

  if (/netto/i.test(bodyText) && /brutto/i.test(bodyText)) {
    score += 2;
    signals.push("ceny netto obok brutto");
  }

  if (/twój rabat|twoj rabat|cena dla ciebie|twoja cena|rabat:/i.test(bodyText)) {
    score += 2;
    signals.push("indywidualny rabat/cena");
  }

  // Zaproszenie do logowania to najmocniejszy sygnał „to strona dla gościa”.
  const loginInvite =
    /zaloguj/i.test(bodyText) ||
    $('a[href*="zaloguj"], a[href*="/login"], form[action*="login"]').length > 0;
  if (loginInvite) {
    score -= 3;
    signals.push("zaproszenie do logowania („Zaloguj”)");
  }
  if (/zarejestruj|rejestracja/i.test(bodyText)) {
    score -= 1;
    signals.push("zaproszenie do rejestracji");
  }
  if (!opts.hasPrice) {
    score -= 1;
    signals.push("brak ceny na stronie");
  }

  return { loggedIn: score >= 3, signals, accountLabel: account, score };
}

/** E-mail/login konta — szukamy tylko tam, gdzie sklepy go realnie pokazują. */
function findAccountLabel(doc: Doc): string | null {
  const { $ } = doc;
  const nodes = $(
    '[class*="current-user"], [class*="current-company"], [class*="user-name"], [class*="account-name"], [class*="header-user"]'
  );
  let found: string | null = null;
  nodes.each((_i, el) => {
    if (found) return;
    const $el = $(el);
    const title = $el.attr("title") ?? "";
    const t = collapse($el.text());
    const m = EMAIL_RE.exec(title) ?? EMAIL_RE.exec(t);
    if (m) {
      found = m[0];
      return;
    }
    // Bez spacji, żeby nie wziąć nagłówka w rodzaju „Twoje konto” za login.
    if (!found && /^[\w.@+-]{3,60}$/.test(t) && !/zaloguj|zarejestruj/i.test(t)) found = t;
  });
  return found;
}
