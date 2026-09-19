/**
 * Rezerwacja list Kadr do edycji — trasy HTTP (`/hr/locks/*`).
 *
 * Reguły i dostęp do tabeli siedzą w `src/lib/hr-locks.ts`; tutaj zostaje
 * warstwa HTTP: walidacja wejścia, kody odpowiedzi, sygnał SSE i dziennik.
 *
 * KODY, które front rozróżnia:
 *  - 200 — mamy co edytować; `excluded` mówi, które DZIAŁY są wyłączone
 *    (trzyma je ktoś inny) — ich wiersze front wyszarza i o nie prosi osobno,
 *  - 409 — nie da się edytować nic: całość trzyma ktoś inny albo trzyma ktoś
 *    inny dokładnie ten portal; ciało niesie właściciela i termin,
 *  - 429 — prośba o zwolnienie z ostatnich 2 minut już poszła.
 *
 * CZEGO NIE LOGUJEMY. Wzięcie i zwolnienie listy to ruch interfejsu, nie
 * zmiana danych — w dzienniku Kadr byłby to szum przykrywający wpisy o
 * kwotach. Zostają dwa zdarzenia, o które ludzie faktycznie pytają: prośba
 * o zwolnienie i przejęcie WYGASŁEJ rezerwacji po kimś innym.
 *
 * DLACZEGO `hr_month` W DZIENNIKU. Oba wpisy dotyczą OKRESU (wrzesień 2026),
 * a nie wiersza tabeli, który zniknie razem z rezerwacją — trafiają więc na tę
 * samą oś czasu, co zamknięcie i otwarcie miesiąca (`entityId` = rok*100 +
 * miesiąc). Nowy typ encji dałby tu osobny filtr w Historii dla dwóch zdań.
 */
import { Hono, type Context } from "hono";
import type { ApiResponse } from "../types/index.js";
import type { User } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
// Sekcje działowe („Godziny działu”) rezerwują wyłącznie swoje wiersze —
// reguły w src/lib/hr-scope.ts.
import {
  canEditPortal,
  canLockWholeList,
  hasAnyHrTab,
  isHrPortal,
  PORTAL_LABEL,
} from "../lib/hr-scope.js";
import { db } from "../db/index.js";
import { logActivity } from "../lib/activity-log.js";
import { periodLabel } from "../lib/hr-activity.js";
import { clientIdOf } from "../lib/calendar-live.js";
import { publishHrChange } from "../lib/hr-live.js";
import {
  acquireLock,
  heartbeatLock,
  hhmm,
  isHrLockScope,
  monthLocks,
  portalLabel,
  releaseLock,
  requestRelease,
  scopeLabelAcc,
  scopeLabelGen,
  type HrLockScope,
  type HrPortal,
} from "../lib/hr-locks.js";

const app = new Hono();

const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const BAD_INPUT = `Wymagane: lista (payroll|hours|office), rok ${YEAR_MIN}–${YEAR_MAX} i miesiąc 1–12`;

interface LockTarget {
  scope: HrLockScope;
  year: number;
  month: number;
  /** `null` = cała lista (pełne Kadry); tekst = portal działowy. */
  portal: HrPortal;
}

/** Wejście wspólne dla czterech tras zapisu — albo komplet, albo komunikat. */
function readTarget(raw: Record<string, unknown>): LockTarget | { error: string } {
  const year = Number(raw.year);
  const month = Number(raw.month);
  if (
    !isHrLockScope(raw.scope) ||
    !Number.isInteger(year) ||
    year < YEAR_MIN ||
    year > YEAR_MAX ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return { error: BAD_INPUT };
  }
  // Portal przychodzi z sekcji działowej Kadr; brak = pełne Kadry. Pusty napis
  // traktujemy jak brak, żeby `?portal=` z formularza nie znaczyło czegoś innego.
  const portalRaw = typeof raw.portal === "string" ? raw.portal.trim() : "";
  return { scope: raw.scope, year, month, portal: portalRaw || null };
}

/** Sygnał „stan rezerwacji się zmienił” — front odświeża pasek i przełącznik. */
function publishLocks(t: LockTarget, userId: number | null): void {
  publishHrChange({
    scope: "locks",
    year: t.year,
    month: t.month,
    entityType: "hr_lock",
    actorUserId: userId,
    // `actorClientId: null` = sygnał leci TAKŻE do karty, która go wywołała:
    // przy prośbie o zwolnienie to właśnie ona ma zobaczyć, że rezerwacja
    // zmieniła stan, a zbędne odświeżenie samego paska nic nie kosztuje.
    actorClientId: null,
  });
}

/** Ciało żądania jako obiekt (puste/uszkodzone traktujemy jak brak pól). */
async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.json<unknown>();
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Dopisek „(dział OFI)” do komunikatów o rezerwacji portalowej. */
const ofPortal = (portal: HrPortal): string =>
  portal == null ? "" : ` — dział ${portalLabel(portal)}`;

/**
 * Czy wołający ma prawo BRAĆ tę rezerwację — `null`, gdy tak, inaczej gotowy
 * komunikat 403. Rezerwacja jest obietnicą „te wiersze są moje”, więc musi
 * pokrywać się z prawem zapisu:
 *  - portal `null` (CAŁA lista) wolno wziąć tylko pełnym Kadrom danej listy,
 *  - portal sekcji — tylko temu, kto ma w niej edycję (albo pełne Kadry),
 *  - rezerwacje portalowe istnieją WYŁĄCZNIE dla godzin: wypłaty i biuro są
 *    jedną listą księgowości i sekcji nie dotyczą.
 */
function lockScopeDenial(user: User, t: LockTarget): string | null {
  if (t.portal == null) {
    return canLockWholeList(user, t.scope)
      ? null
      : `Brak uprawnień do rezerwacji ${scopeLabelGen[t.scope]} — sekcja działowa rezerwuje wyłącznie swoje wiersze`;
  }
  if (t.scope !== "hours") {
    return `Rezerwacja działowa dotyczy wyłącznie listy godzin (${scopeLabelGen[t.scope]} rozlicza się w całości)`;
  }
  if (!isHrPortal(t.portal)) return `Nieznana sekcja: ${t.portal}`;
  return canEditPortal(user, t.portal)
    ? null
    : `Brak uprawnień do edycji godzin działu ${PORTAL_LABEL[t.portal]}`;
}

// ---------------------------------------------------------------------------
// Odczyt stanu trzech list miesiąca
// ---------------------------------------------------------------------------

app.get("/", (c) => {
  const year = Number(c.req.query("year"));
  const month = Number(c.req.query("month"));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return c.json<ApiResponse<null>>({ success: false, error: BAD_INPUT }, 400);
  }
  const user = getUser(c);
  const locks = monthLocks(year, month, user?.id ?? null);
  // Konto sekcji („Godziny działu”) nie ma nic wspólnego z wypłatami ani
  // biurem — nie dostaje więc nawet informacji, kto je teraz edytuje.
  if (!hasAnyHrTab(user)) {
    locks.payroll = [];
    locks.office = [];
  }
  return c.json({
    success: true,
    // Wszystkie żywe rezerwacje każdej listy (z moją): front sam składa z tego
    // pasek („moja"), pigułkę („czyja") i wyszarzenie wierszy działu.
    data: { year, month, locks },
  });
});

// ---------------------------------------------------------------------------
// Wzięcie listy (przełącznik „Podgląd → Edycja”)
// ---------------------------------------------------------------------------

app.post("/acquire", async (c) => {
  const t = readTarget(await bodyOf(c));
  if ("error" in t) return c.json<ApiResponse<null>>({ success: false, error: t.error }, 400);
  const user = getUser(c);
  // KOGO WOLNO REZERWOWAĆ. Bramka prefiksu `/hr/locks` przepuszcza też konta
  // sekcji („Godziny działu”) — bez tego sprawdzenia kierownik CMA wziąłby
  // rezerwację CAŁEJ listy godzin i zablokował miesiąc reszcie firmy, albo
  // portal cudzego działu. Odmowa jest 403, a nie 409: to brak uprawnień, a nie
  // zajęta lista, i front nie ma proponować prośby o zwolnienie.
  const denial = lockScopeDenial(user, t);
  if (denial) return c.json<ApiResponse<null>>({ success: false, error: denial }, 403);
  const result = acquireLock({ ...t, user, clientId: clientIdOf(c) });

  if (!result.ok) {
    return c.json(
      {
        success: false,
        error: `${result.lock.userLabel} edytuje ${scopeLabelAcc[t.scope]}${ofPortal(result.lock.portal)} (rezerwacja do ${hhmm(result.lock.expiresAt)})`,
        data: {
          lock: result.lock,
          holder: { label: result.lock.userLabel, expiresAt: result.lock.expiresAt },
          // Czy prośba o zwolnienie już poszła — front nie proponuje jej drugi raz.
          pending: result.lock.request != null,
        },
      },
      409,
    );
  }

  if (result.takenOverFrom) {
    // Przejęcie po WYGASŁEJ rezerwacji. Bez tego wpisu „przecież ja to miałem
    // otwarte" nie ma jak się rozstrzygnąć — a właśnie po nim ludzie pytają.
    logActivity(db, {
      entityType: "hr_month",
      entityId: t.year * 100 + t.month,
      user,
      action: "status_changed",
      summary: `Przejęto ${scopeLabelAcc[t.scope]}${ofPortal(t.portal)} do edycji po wygasłej rezerwacji (${result.takenOverFrom}) — ${periodLabel(t)}`,
    });
  }
  publishLocks(t, user.id);
  return c.json({
    success: true,
    // `excluded` = działy, których ta rezerwacja NIE obejmuje, bo trzyma je
    // ktoś inny. Front wyszarza ich wiersze i pozwala poprosić o każdy osobno.
    data: { lock: result.lock, excluded: result.excluded },
  });
});

// ---------------------------------------------------------------------------
// Przedłużenie (klient woła co 60 s w trybie edycji)
// ---------------------------------------------------------------------------

app.post("/heartbeat", async (c) => {
  const t = readTarget(await bodyOf(c));
  if ("error" in t) return c.json<ApiResponse<null>>({ success: false, error: t.error }, 400);
  const lock = heartbeatLock({ ...t, user: getUser(c) });
  if (!lock) {
    // Rezerwacja wygasła albo przejął ją ktoś inny — front dowie się o tym
    // z tej odpowiedzi i sam spróbuje wziąć listę od nowa.
    return c.json<ApiResponse<null>>({ success: false, error: "Rezerwacja wygasła" }, 409);
  }
  // Bez sygnału SSE: przedłużenie nie zmienia niczego, co widzą inni (poza
  // godziną w pigułce), a leci co minutę z każdej karty w trybie edycji.
  return c.json({ success: true, data: { lock } });
});

// ---------------------------------------------------------------------------
// Zwolnienie (przełącznik na „Podgląd”, zmiana miesiąca, zamknięcie karty)
// ---------------------------------------------------------------------------

app.post("/release", async (c) => {
  const t = readTarget(await bodyOf(c));
  if ("error" in t) return c.json<ApiResponse<null>>({ success: false, error: t.error }, 400);
  const user = getUser(c);
  const { released } = releaseLock({ ...t, user });
  // `released: false` NIE jest błędem: to samo żądanie leci z `sendBeacon`
  // przy zamykaniu karty, gdzie odpowiedzi nikt nie przeczyta, a rezerwacja
  // mogła w tym czasie wygasnąć sama.
  if (released) publishLocks(t, user.id);
  return c.json({ success: true, data: { released } });
});

// ---------------------------------------------------------------------------
// Prośba o zwolnienie
// ---------------------------------------------------------------------------

app.post("/request-release", async (c) => {
  const raw = await bodyOf(c);
  const t = readTarget(raw);
  if ("error" in t) return c.json<ApiResponse<null>>({ success: false, error: t.error }, 400);
  const user = getUser(c);
  const message = typeof raw.message === "string" ? raw.message : null;
  const result = requestRelease({ ...t, user, message });

  if (result.status === "no-lock") {
    // Właściciel zdążył zwolnić listę — dla proszącego to najlepszy możliwy
    // wynik, więc 200 i front po prostu wchodzi w tryb edycji.
    return c.json({ success: true, data: { lock: null, released: true } });
  }
  if (result.status === "mine") {
    return c.json<ApiResponse<null>>({ success: false, error: "To Twoja rezerwacja" }, 409);
  }
  if (result.status === "cooldown") {
    return c.json(
      {
        success: false,
        error: `Prośba już poszła — poczekaj ${Math.ceil(result.retryAfterMs / 1000)} s przed kolejną`,
        data: { lock: result.lock, retryAfterMs: result.retryAfterMs },
      },
      429,
    );
  }

  logActivity(db, {
    entityType: "hr_month",
    entityId: t.year * 100 + t.month,
    user,
    action: "status_changed",
    summary: `${user.displayName || user.email} poprosił(a) ${result.ownerLabel} o zwolnienie ${scopeLabelGen[t.scope]}${ofPortal(t.portal)} (${periodLabel(t)})`,
  });
  publishLocks(t, user.id);
  return c.json({
    success: true,
    data: { lock: result.lock },
    message: `Prośba wysłana do: ${result.ownerLabel}`,
  });
});

export default app;
