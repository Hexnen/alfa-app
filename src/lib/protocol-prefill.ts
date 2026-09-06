/**
 * Wstępne wypełnianie protokołu powykonawczego — „żeby technik i biuro wpisywali jak najmniej”.
 *
 * Łańcuch danych jest zawsze ten sam:
 *   calendar_events (termin, technicy, tytuł/opis)
 *     → objects przez KLUCZ OBCY (realizations.object_id → calendar_events.object_id;
 *       rozstrzyga src/lib/object-identity.ts, nigdy nazwa z `site`)
 *         → contractors (nazwa, NIP, miasto, telefon/e-mail/osoba kontaktowa)
 *   + price_list (materiały z cennika technika albo domyślnego)
 *   + realizations (to, czego kalendarz nie wie: km z kalkulacji, opiekun, kwoty)
 *
 * Funkcja `buildProtocolPrefill` jest CZYSTA względem zapisu — tylko odczyt — i służy
 * dwóm ścieżkom:
 *   1. tworzeniu protokołu razem z realizacją (`createProtocolForRealizationSync`),
 *   2. uzupełnianiu istniejącego protokołu (GET/POST /protocols/:id/prefill).
 *
 * Konwencja sugestii (`ProtocolSuggestion`) jest ta sama, co w automacie realizacji
 * (src/lib/realization-autofill.ts): `field/label/current/suggested/source/detail/confident`,
 * gdzie `confident: true` znaczy „pole jest puste, można podstawić bez pytania”, a `false`
 * — „pole ma inną wartość, człowiek musi świadomie ją nadpisać”.
 *
 * Uwaga na cykle importów: ten moduł jest importowany przez src/routes/protocols.ts, który
 * z kolei jest importowany przez src/lib/calendar-realizations.ts. Dlatego liczymy godziny
 * z `diffMinutes` (calendar-recurrence.ts), zamiast sięgać po `eventHours`, i nie importujemy
 * niczego z realization-autofill.ts.
 */
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type {
  CalendarEvent,
  CalendarEventType,
  Protocol,
  Realization,
} from "../db/schema.js";
import { logActivity, type ActivityUser, type DbOrTx } from "./activity-log.js";
import { diffMinutes } from "./calendar-recurrence.js";
import { getCompanyConfig } from "./company-config.js";
import { resolveRealizationObject } from "./object-identity.js";

// ---------------------------------------------------------------------------
// Typy publiczne
// ---------------------------------------------------------------------------

export interface ProtocolItem {
  name: string;
  serial: string;
  unit: string;
  qty: string;
}

/** Domyślne pozycje materiałowe z papierowego wzoru protokołu (gdy cennik nie ma materiałów). */
export const DEFAULT_ITEMS: ProtocolItem[] = [
  { name: "KABEL UTP KAT 5E.", serial: "", unit: "mb", qty: "" },
  { name: "KABEL ZASILAJĄCY", serial: "", unit: "mb", qty: "" },
  { name: "PESZEL - RURA KARBOWANA", serial: "", unit: "mb", qty: "" },
];

/** Ile pozycji materiałowych z cennika wchodzi do szkicu protokołu. */
export const PREFILL_ITEMS_LIMIT = 8;

export type ProtocolWorkType = "serwis" | "montaz" | "wizja" | "inne";

export const PROTOCOL_PREFILL_FIELDS = [
  "workDate",
  "workType",
  "actualHours",
  "actualKm",
  "contractor",
  "salesperson",
  "clientName",
  "clientNip",
  "clientCity",
  "installationAddress",
  "contact",
  "activities",
  "items",
] as const;
export type ProtocolPrefillField = (typeof PROTOCOL_PREFILL_FIELDS)[number];

export function isProtocolPrefillField(v: string): v is ProtocolPrefillField {
  return (PROTOCOL_PREFILL_FIELDS as readonly string[]).includes(v);
}

/** Etykiety PL — front nie musi trzymać własnego słownika. */
export const PROTOCOL_PREFILL_LABELS: Record<ProtocolPrefillField, string> = {
  workDate: "Data wykonania",
  workType: "Typ prac",
  actualHours: "Faktyczne godziny",
  actualKm: "Przejechane km",
  contractor: "Wykonawca",
  salesperson: "Handlowiec",
  clientName: "Zleceniodawca",
  clientNip: "NIP",
  clientCity: "Miejscowość",
  installationAddress: "Adres montażu",
  contact: "Kontakt",
  activities: "Wykonane czynności",
  items: "Urządzenia / materiały",
};

/** Skąd wzięła się wartość (ta sama rola, co `SuggestionSource` w automacie realizacji). */
export type ProtocolPrefillSource =
  | "kalendarz"
  | "obiekt"
  | "kontrahent"
  | "cennik"
  | "realizacja";

export interface ProtocolPrefillValues {
  workDate: string;
  workType: ProtocolWorkType;
  actualHours: number;
  actualKm: number;
  contractor: string;
  salesperson: string;
  clientName: string;
  clientNip: string;
  clientCity: string;
  installationAddress: string;
  contact: string;
  activities: string;
  items: ProtocolItem[];
}

export interface ProtocolPrefillOrigin {
  source: ProtocolPrefillSource;
  /** Czytelne „skąd to wyszło” — pokazywane pod polem i w dialogu. */
  detail: string;
  /**
   * true = wartość SZACOWANA (norma dnia dla wydarzenia całodniowego), a nie zmierzona.
   * Takie pole nigdy nie zapisuje się samo: nie trafia do szkicu przy tworzeniu protokołu
   * (`prefillInsertValues`) i zawsze dostaje `confident: false`, czyli wymaga kliknięcia
   * człowieka w „Uzupełnij z danych”.
   */
  assumed?: boolean;
}

export interface ProtocolPrefillContext {
  realizationId: number;
  event: { id: number; type: CalendarEventType; title: string; startAt: string } | null;
  object: { id: number; name: string } | null;
  contractor: { id: number; name: string } | null;
  priceList: { id: number; name: string; via: "technik" | "domyślny"; technician: string | null } | null;
  /** Liczba pozycji materiałowych znalezionych w cenniku (0 → wzór DEFAULT_ITEMS). */
  materialCount: number;
}

export interface ProtocolPrefill {
  values: ProtocolPrefillValues;
  origins: Partial<Record<ProtocolPrefillField, ProtocolPrefillOrigin>>;
  context: ProtocolPrefillContext;
}

/** Jedna propozycja dla istniejącego protokołu (kształt jak `Suggestion` w automacie realizacji). */
export interface ProtocolSuggestion {
  field: ProtocolPrefillField;
  label: string;
  current: string | number | null;
  suggested: string | number;
  source: ProtocolPrefillSource;
  detail: string;
  /** true = pole puste (podstawiamy bez pytania); false = ma inną wartość albo jest to szacunek. */
  confident: boolean;
  /** true = wartość szacowana (norma dnia dla wydarzenia całodniowego), nie zmierzona. */
  assumed?: boolean;
}

// ---------------------------------------------------------------------------
// Helpery
// ---------------------------------------------------------------------------

const clean = (v: string | null | undefined): string => (v ?? "").replace(/\s+/g, " ").trim();

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Długość wydarzenia w godzinach zaokrąglona do 0,25 (all-day → 0) — jak w kalendarzu. */
function hoursOfEvent(ev: Pick<CalendarEvent, "startAt" | "endAt" | "allDay">): number {
  if (ev.allDay) return 0;
  const minutes = diffMinutes(ev.startAt, ev.endAt);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round((minutes / 60) * 4) / 4;
}

/** Liczba dni wydarzenia całodniowego (koniec jest wyłączny, jak w FullCalendar). */
export function allDayDays(ev: Pick<CalendarEvent, "startAt" | "endAt">): number {
  const start = Date.parse(`${ev.startAt.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${ev.endAt.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  const days = Math.round((end - start) / 86_400_000);
  return days > 0 ? days : 1;
}

/**
 * Godziny SZACOWANE dla wydarzenia całodniowego: liczba dni × norma dnia roboczego
 * (`company.work_day_hours`). Kalendarz nie wie, ile faktycznie trwała robota, więc ta
 * wartość jest wyłącznie propozycją — patrz `ProtocolPrefillOrigin.assumed`.
 */
function assumedHoursOfEvent(
  ev: Pick<CalendarEvent, "startAt" | "endAt" | "allDay">,
  workDayHours: number
): { hours: number; days: number } | null {
  if (!ev.allDay || !(workDayHours > 0)) return null;
  const days = allDayDays(ev);
  return { hours: Math.round(days * workDayHours * 4) / 4, days };
}

/** Typ prac protokołu z typu wydarzenia; `null` = typ, którego protokół nie rozróżnia. */
export function workTypeFromEventType(type: CalendarEventType): ProtocolWorkType | null {
  switch (type) {
    case "serwis":
    case "konserwacja":
      return "serwis";
    case "montaz":
      return "montaz";
    case "wizja":
      return "wizja";
    case "demontaz":
      return "inne";
    default:
      return null;
  }
}

/** Najstarsze (zapasowe) mapowanie ze zgodnościowego pola `realizations.kind`. */
export function workTypeFromKind(kind: Realization["kind"]): ProtocolWorkType {
  return kind === "installation" ? "montaz" : "serwis";
}

/**
 * Typ prac protokołu z realizacji: najpierw `realizations.work_type` (rodzaj prac
 * tym samym słownikiem, co kalendarz), a gdy go nie ma — stare `kind`.
 * Pole czytamy defensywnie, żeby moduł działał także na starszym schemacie.
 */
export function workTypeFromRealization(r: Realization): ProtocolWorkType {
  const workType = (r as { workType?: string }).workType;
  switch (workType) {
    case "serwis":
    case "konserwacja":
      return "serwis";
    case "montaz":
      return "montaz";
    case "wizja":
      return "wizja";
    case "demontaz":
    case "inne":
      return "inne";
    default:
      return workTypeFromKind(r.kind);
  }
}

/** Wydarzenie realizacji (bez usuniętych i anulowanych) — źródło prawdy o terminie i technikach. */
function loadEventFor(dbx: DbOrTx, realizationId: number): CalendarEvent | null {
  return (
    dbx
      .select()
      .from(schema.calendarEvents)
      .where(
        and(
          eq(schema.calendarEvents.realizationId, realizationId),
          isNull(schema.calendarEvents.deletedAt),
          ne(schema.calendarEvents.status, "cancelled")
        )
      )
      .orderBy(asc(schema.calendarEvents.startAt))
      .get() ?? null
  );
}

/** Technicy wydarzenia w kolejności przypisania („Imię Nazwisko”). */
function eventTechnicians(dbx: DbOrTx, eventId: number) {
  return dbx
    .select({
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
      priceListId: schema.technicians.priceListId,
    })
    .from(schema.calendarEventAssignees)
    .innerJoin(
      schema.technicians,
      eq(schema.technicians.id, schema.calendarEventAssignees.technicianId)
    )
    .where(eq(schema.calendarEventAssignees.eventId, eventId))
    .orderBy(asc(sql`calendar_event_assignees.rowid`))
    .all();
}

/** Cennik: technika z wydarzenia → technika z „Wykonawca 1” → cennik domyślny. */
function resolvePriceList(
  dbx: DbOrTx,
  contractor1: string,
  techs: { firstName: string; lastName: string; priceListId: number | null }[]
): ProtocolPrefillContext["priceList"] {
  const pick = (id: number, via: "technik" | "domyślny", technician: string | null) => {
    const row = dbx
      .select({ id: schema.priceLists.id, name: schema.priceLists.name })
      .from(schema.priceLists)
      .where(eq(schema.priceLists.id, id))
      .get();
    return row ? { id: row.id, name: row.name, via, technician } : null;
  };

  const withList = techs.find((t) => t.priceListId != null);
  if (withList?.priceListId != null) {
    const found = pick(withList.priceListId, "technik", `${withList.firstName} ${withList.lastName}`.trim());
    if (found) return found;
  }

  const name = contractor1.trim();
  if (name) {
    const rows = dbx
      .select({
        priceListId: schema.technicians.priceListId,
        firstName: schema.technicians.firstName,
        lastName: schema.technicians.lastName,
      })
      .from(schema.technicians)
      .where(
        sql`lower(trim(${schema.technicians.firstName} || ' ' || ${schema.technicians.lastName})) = lower(${name})`
      )
      .all();
    if (rows.length === 1 && rows[0].priceListId != null) {
      const found = pick(rows[0].priceListId, "technik", `${rows[0].firstName} ${rows[0].lastName}`.trim());
      if (found) return found;
    }
  }

  const def = dbx
    .select({ id: schema.priceLists.id, name: schema.priceLists.name })
    .from(schema.priceLists)
    .where(eq(schema.priceLists.isDefault, true))
    .get();
  if (def) return { id: def.id, name: def.name, via: "domyślny", technician: null };

  const any = dbx
    .select({ id: schema.priceLists.id, name: schema.priceLists.name })
    .from(schema.priceLists)
    .orderBy(asc(schema.priceLists.position), asc(schema.priceLists.id))
    .get();
  return any ? { id: any.id, name: any.name, via: "domyślny", technician: null } : null;
}

/** Aktywne materiały cennika po `position` — jednostka z cennika, ilość zostaje pusta. */
function materialItems(dbx: DbOrTx, priceListId: number): ProtocolItem[] {
  return dbx
    .select({ name: schema.priceList.name, unit: schema.priceList.unit })
    .from(schema.priceList)
    .where(
      and(
        eq(schema.priceList.priceListId, priceListId),
        eq(schema.priceList.kind, "material"),
        eq(schema.priceList.active, true)
      )
    )
    .orderBy(asc(schema.priceList.position), asc(schema.priceList.id))
    .limit(PREFILL_ITEMS_LIMIT)
    .all()
    .map((i) => ({ name: i.name, serial: "", unit: i.unit, qty: "" }));
}

// ---------------------------------------------------------------------------
// buildProtocolPrefill
// ---------------------------------------------------------------------------

export interface BuildPrefillOptions {
  /**
   * Wydarzenie, z którego powstaje realizacja. Potrzebne przy TWORZENIU protokołu:
   * `calendar_events.realization_id` jest wtedy jeszcze puste (podpięcie następuje po
   * insercie protokołu), więc wydarzenia nie da się odszukać po realizacji.
   */
  event?: CalendarEvent | null;
  /**
   * Norma dnia roboczego dla wydarzeń całodniowych; domyślnie `company.work_day_hours`.
   * Wynik ląduje w `values.actualHours` z `origins.actualHours.assumed = true`.
   */
  workDayHours?: number;
}

/**
 * Komplet pól protokołu wyliczony z tego, co system już wie. Nic nie zapisuje.
 * Każde pole dostaje wpis w `origins` (źródło + opis), o ile udało się coś ustalić.
 */
export function buildProtocolPrefill(
  dbx: DbOrTx,
  r: Realization,
  opts: BuildPrefillOptions = {}
): ProtocolPrefill {
  const origins: Partial<Record<ProtocolPrefillField, ProtocolPrefillOrigin>> = {};
  const from = (
    field: ProtocolPrefillField,
    source: ProtocolPrefillSource,
    detail: string,
    assumed = false
  ) => {
    origins[field] = assumed ? { source, detail, assumed } : { source, detail };
  };

  const ev = opts.event ?? loadEventFor(dbx, r.id);
  const techs = ev ? eventTechnicians(dbx, ev.id) : [];
  // Obiekt WYŁĄCZNIE z klucza obcego (realizacja → wydarzenie). Wydarzenie mamy już
  // wczytane, więc podajemy je jawnie: `[]` znaczy „sprawdzone, nie ma żadnego", i nie
  // każe modułowi tożsamości pytać bazy drugi raz. Gdy FK nie ma — `null`, a protokół
  // zostaje bez kontrahenta i adresu obiektu (patrz src/lib/object-identity.ts).
  const object = resolveRealizationObject(dbx, r, { events: ev ? [ev] : [] });
  const contractorRow =
    object != null
      ? dbx
          .select({
            id: schema.contractors.id,
            name: schema.contractors.name,
            nip: schema.contractors.nip,
            city: schema.contractors.city,
            phone: schema.contractors.phone,
            email: schema.contractors.email,
            contactPerson: schema.contractors.contactPerson,
          })
          .from(schema.contractors)
          .where(eq(schema.contractors.id, object.contractorId))
          .get() ?? null
      : null;

  // --- termin i typ prac ----------------------------------------------------
  let workDate = r.date;
  if (ev) {
    workDate = ev.startAt.slice(0, 10);
    from("workDate", "kalendarz", `termin wydarzenia #${ev.id}: ${workDate}`);
  }

  let workType = workTypeFromRealization(r);
  const fromEventType = ev ? workTypeFromEventType(ev.type) : null;
  if (fromEventType) {
    workType = fromEventType;
    from("workType", "kalendarz", `typ wydarzenia: ${ev!.type}`);
  }

  // --- godziny i kilometry --------------------------------------------------
  let actualHours = r.actualHours;
  if (ev) {
    const h = hoursOfEvent(ev);
    if (h > 0) {
      actualHours = h;
      from("actualHours", "kalendarz", `długość wydarzenia #${ev.id}: ${h} godz.`);
    } else {
      // Wydarzenie całodniowe nie niesie godzin — proponujemy normę dnia, ale wyłącznie
      // jako szacunek do potwierdzenia (assumed), żeby nic samo się nie wpisało.
      const workDayHours = opts.workDayHours ?? getCompanyConfig().values.workDayHours;
      const est = assumedHoursOfEvent(ev, workDayHours);
      if (est && est.hours > 0) {
        actualHours = est.hours;
        from(
          "actualHours",
          "kalendarz",
          `wydarzenie całodniowe #${ev.id}: ${est.days} ${est.days === 1 ? "dzień" : "dni"} × norma ${workDayHours} godz. (szacunek)`,
          true
        );
      }
    }
  }
  const actualKm = r.actualKm;
  if (actualKm > 0) from("actualKm", "realizacja", `km z realizacji #${r.id}: ${actualKm}`);

  // --- wykonawcy ------------------------------------------------------------
  const names = techs.map((t) => `${t.firstName} ${t.lastName}`.trim()).filter(Boolean);
  let contractor = [r.contractor1, r.contractor2].filter(Boolean).join(", ");
  if (names.length > 0) {
    contractor = names.join(", ");
    from("contractor", "kalendarz", `technicy wydarzenia: ${contractor}`);
  }

  const salesperson = clean(r.caretaker);
  if (salesperson) from("salesperson", "realizacja", `opiekun realizacji: ${salesperson}`);

  // --- zleceniodawca --------------------------------------------------------
  const clientName = clean(contractorRow?.name);
  const clientNip = clean(contractorRow?.nip);
  const clientCity = clean(contractorRow?.city) || clean(object?.city);
  if (contractorRow) {
    const label = `kontrahent obiektu ${object?.name ?? ""}`.trim();
    if (clientName) from("clientName", "kontrahent", label);
    if (clientNip) from("clientNip", "kontrahent", `NIP kontrahenta ${clientName || "—"}`);
  }
  if (clientCity) {
    from(
      "clientCity",
      contractorRow?.city ? "kontrahent" : "obiekt",
      contractorRow?.city ? `miejscowość kontrahenta ${clientName || "—"}` : `miejscowość obiektu ${object?.name ?? ""}`
    );
  }

  // --- adres montażu --------------------------------------------------------
  const objAddress = [clean(object?.address), clean(object?.city)].filter(Boolean).join(", ");
  const installationAddress = objAddress || r.site;
  if (objAddress) from("installationAddress", "obiekt", `adres obiektu ${object?.name ?? ""}`);

  // --- kontakt --------------------------------------------------------------
  const contactParts = [
    clean(contractorRow?.contactPerson),
    clean(contractorRow?.phone),
    clean(contractorRow?.email),
  ].filter(Boolean);
  const contact = contactParts.join(", ");
  if (contact) from("contact", "kontrahent", `dane kontaktowe kontrahenta ${clientName || "—"}`);

  // --- wykonane czynności ---------------------------------------------------
  let activities = clean(r.note);
  if (ev) {
    const desc = clean(ev.description);
    activities = clip([clean(ev.title), desc].filter(Boolean).join(" — "), 400);
    from("activities", "kalendarz", `tytuł i opis wydarzenia #${ev.id}`);
  }

  // --- pozycje materiałowe --------------------------------------------------
  const priceList = resolvePriceList(dbx, r.contractor1 ?? "", techs);
  const materials = priceList ? materialItems(dbx, priceList.id) : [];
  const items = materials.length > 0 ? materials : DEFAULT_ITEMS.map((i) => ({ ...i }));
  if (materials.length > 0 && priceList) {
    from(
      "items",
      "cennik",
      `materiały z cennika „${priceList.name}”${
        priceList.via === "technik" && priceList.technician ? ` (technik: ${priceList.technician})` : " (domyślny)"
      }: ${materials.length} poz.`
    );
  }

  return {
    values: {
      workDate,
      workType,
      actualHours,
      actualKm,
      contractor,
      salesperson,
      clientName,
      clientNip,
      clientCity,
      installationAddress,
      contact,
      activities,
      items,
    },
    origins,
    context: {
      realizationId: r.id,
      event: ev ? { id: ev.id, type: ev.type, title: ev.title, startAt: ev.startAt } : null,
      object: object ? { id: object.id, name: object.name } : null,
      contractor: contractorRow ? { id: contractorRow.id, name: contractorRow.name } : null,
      priceList,
      materialCount: materials.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Sugestie dla istniejącego protokołu
// ---------------------------------------------------------------------------

/** Krótki opis listy pozycji („3 poz.: KABEL UTP…, PESZEL…”). */
export function describeItems(items: ProtocolItem[]): string {
  const named = items.filter((i) => clean(i.name));
  if (named.length === 0) return "brak pozycji";
  return `${named.length} poz.: ${clip(named.map((i) => i.name).join(", "), 120)}`;
}

export function parseProtocolItems(raw: string): ProtocolItem[] {
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .map((i) => ({
        name: typeof i.name === "string" ? i.name : "",
        serial: typeof i.serial === "string" ? i.serial : "",
        unit: typeof i.unit === "string" ? i.unit : "",
        qty: typeof i.qty === "string" ? i.qty : "",
      }));
  } catch {
    return [];
  }
}

/**
 * Pozycje „nietknięte przez człowieka”: brak pozycji albo żadna nie ma wpisanej ilości
 * ani numeru seryjnego. Taką listę wolno wymienić bez pytania (to wciąż sam wzór).
 */
/**
 * Klucz porównawczy listy pozycji — bez znaczenia wielkości liter, interpunkcji
 * i wielkości jednostki. Dzięki temu „PESZEL - RURA KARBOWANA / mb” z papierowego
 * wzoru i „PESZEL: RURA KARBOWANA / MB” z cennika nie generują pustej sugestii.
 */
function itemsKey(items: ProtocolItem[]): string {
  const norm = (s: string) =>
    s
      .replace(/ł/g, "l")
      .replace(/Ł/g, "L")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return items
    .map((i) => [norm(i.name), norm(i.unit), clean(i.qty), clean(i.serial)].join("|"))
    .join("¦");
}

function itemsArePristine(items: ProtocolItem[]): boolean {
  return items.every((i) => !clean(i.qty) && !clean(i.serial));
}

const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.005 : a === b;

/**
 * Różnice między protokołem a tym, co wychodzi z danych systemu. Pola puste dostają
 * `confident: true` (można podstawić bez pytania), pola z inną wartością — `false`.
 * Sugestie z pustą wartością (nie ma czego podstawić) w ogóle nie powstają.
 */
export function protocolPrefillSuggestions(
  protocol: Protocol,
  prefill: ProtocolPrefill,
  opts: {
    /**
     * Realizacja protokołu — gdy typ prac w protokole jest dokładnie tym, co wychodzi
     * z realizacji, znaczy to, że nikt go świadomie nie wybrał, więc typ z wydarzenia
     * wolno podstawić bez pytania.
     */
    realization?: Realization;
  } = {}
): ProtocolSuggestion[] {
  const out: ProtocolSuggestion[] = [];
  const push = (
    field: ProtocolPrefillField,
    current: string | number | null,
    suggested: string | number,
    empty: boolean
  ) => {
    const origin = prefill.origins[field];
    if (!origin) return; // nie wiemy, skąd wartość — nie proponujemy
    if (suggested === "" || suggested === 0) return;
    if (sameValue(current ?? "", suggested)) return;
    out.push({
      field,
      label: PROTOCOL_PREFILL_LABELS[field],
      current,
      suggested,
      source: origin.source,
      detail: origin.detail,
      // Szacunek (norma dnia) nigdy nie jest „pewny” — nawet do pustego pola musi go
      // wpuścić człowiek, bo system nie wie, ile robota faktycznie trwała.
      confident: empty && !origin.assumed,
      ...(origin.assumed ? { assumed: true } : {}),
    });
  };

  const v = prefill.values;
  const txt = (s: string | null) => (s ?? "").trim();

  push("workDate", protocol.workDate, v.workDate, !protocol.workDate);
  push(
    "workType",
    protocol.workType,
    v.workType,
    opts.realization != null && protocol.workType === workTypeFromRealization(opts.realization)
  );
  push("actualHours", protocol.actualHours, v.actualHours, protocol.actualHours === 0);
  push("actualKm", protocol.actualKm, v.actualKm, protocol.actualKm === 0);
  push("contractor", txt(protocol.contractor), v.contractor, !txt(protocol.contractor));
  push("salesperson", txt(protocol.salesperson), v.salesperson, !txt(protocol.salesperson));
  push("clientName", txt(protocol.clientName), v.clientName, !txt(protocol.clientName));
  push("clientNip", txt(protocol.clientNip), v.clientNip, !txt(protocol.clientNip));
  push("clientCity", txt(protocol.clientCity), v.clientCity, !txt(protocol.clientCity));
  push(
    "installationAddress",
    txt(protocol.installationAddress),
    v.installationAddress,
    !txt(protocol.installationAddress)
  );
  push("contact", txt(protocol.contact), v.contact, !txt(protocol.contact));
  push("activities", txt(protocol.activities), v.activities, !txt(protocol.activities));

  const currentItems = parseProtocolItems(protocol.items);
  if (itemsKey(currentItems) !== itemsKey(v.items)) {
    push("items", describeItems(currentItems), describeItems(v.items), itemsArePristine(currentItems));
  }

  return out;
}

/** Wartości wskazanych pól w kształcie gotowym do `UPDATE protocols` (items → JSON). */
export function prefillPatch(
  fields: ProtocolPrefillField[],
  prefill: ProtocolPrefill
): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const f of fields) {
    if (f === "items") patch.items = JSON.stringify(prefill.values.items);
    else patch[f] = prefill.values[f];
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Zapis: szkic protokołu i dosypywanie tego, co doliczyła realizacja
// ---------------------------------------------------------------------------

/**
 * Wartości do INSERT-a szkicu protokołu: to samo, co `prefill.values`, ale bez pól
 * oznaczonych jako szacunek (`origins[field].assumed`). Szacunku nikt nie zatwierdził,
 * więc do dokumentu nie wchodzi — zostaje wyłącznie sugestią w „Uzupełnij z danych”.
 */
export function prefillInsertValues(prefill: ProtocolPrefill): ProtocolPrefillValues {
  const values = { ...prefill.values };
  for (const field of PROTOCOL_PREFILL_FIELDS) {
    if (!prefill.origins[field]?.assumed) continue;
    if (field === "actualHours" || field === "actualKm") values[field] = 0;
  }
  return values;
}

/** Pola liczbowe, które realizacja potrafi doliczyć PO utworzeniu protokołu. */
const REALIZATION_NUMERIC_FIELDS = [
  { field: "actualHours" as const, label: "godziny" },
  { field: "actualKm" as const, label: "km" },
];

export interface ProtocolFillFromRealizationCtx {
  user: ActivityUser;
  /** Skąd wzięła się wartość — trafia do summary w activity_log. */
  reason: string;
  /** Dopisek „czym” wykonano zmianę; domyślnie „(przez automat)”. */
  summarySuffix?: string | null;
}

export interface ProtocolFillOutcome {
  protocolId: number;
  number: string;
  applied: ("actualHours" | "actualKm")[];
}

/**
 * Dosypuje do NIEPODPISANEGO protokołu godziny i km, które realizacja policzyła już po
 * utworzeniu szkicu (kalkulacja dystansu, automat po „wykonane”, ręczne uzupełnienie).
 *
 * Protokół jest dokumentem końcowym, więc obowiązuje ta sama żelazna zasada, co w automacie
 * realizacji: uzupełniamy WYŁĄCZNIE pola zerowe. Cokolwiek człowiek wpisał, zostaje —
 * rozbieżność zobaczy w „Uzupełnij z danych” jako sugestię do potwierdzenia.
 *
 * Zwraca `null`, gdy nie ma czego (albo do czego) zapisać: brak protokołu, protokół
 * podpisany/zatwierdzony, komplet pól już wypełniony.
 */
export function fillProtocolFromRealizationSync(
  dbx: DbOrTx,
  r: Realization,
  ctx: ProtocolFillFromRealizationCtx
): ProtocolFillOutcome | null {
  const protocol = dbx
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, r.id))
    .get();
  if (!protocol) return null;
  if (protocol.signedAt || protocol.signaturePng || protocol.contentHash) return null;
  if (protocol.status === "final") return null;

  const patch: Record<string, number> = {};
  const applied: ("actualHours" | "actualKm")[] = [];
  const bits: string[] = [];
  for (const { field, label } of REALIZATION_NUMERIC_FIELDS) {
    const value = r[field];
    if (!(value > 0) || protocol[field] !== 0) continue;
    patch[field] = value;
    applied.push(field);
    bits.push(`${label} ${value}`);
  }
  if (applied.length === 0) return null;

  const updated = dbx
    .update(schema.protocols)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.protocols.id, protocol.id),
        isNull(schema.protocols.signedAt),
        ne(schema.protocols.status, "final")
      )
    )
    .returning()
    .all();
  if (updated.length === 0) return null;

  logActivity(dbx, {
    entityType: "protocol",
    entityId: protocol.id,
    user: ctx.user,
    action: "updated",
    field: "prefill",
    oldValue: null,
    newValue: JSON.stringify(applied),
    summary: `Uzupełniono protokół ${protocol.number} z realizacji #${r.id} (${ctx.reason}): ${bits.join(", ")}`,
    summarySuffix: ctx.summarySuffix === undefined ? "(przez automat)" : ctx.summarySuffix,
  });

  return { protocolId: protocol.id, number: protocol.number, applied };
}
