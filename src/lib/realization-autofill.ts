/**
 * Automatyczne wyliczanie realizacji — „żeby w realizacjach jak najmniej trzeba było wypełniać”.
 *
 * Źródła:
 *  - godziny        ← wydarzenia kalendarza powiązane z realizacją (protokół z własnymi godzinami wygrywa),
 *  - materiały      ← pozycje protokołu wycenione po cenniku technika (tylko pozycje rodzaju „materiał”),
 *  - kilometry      ← kalkulacja dystansu biuro → obiekt (src/lib/geo.ts, zawsze przez cache),
 *  - stawki i koszt ← cennik technika, a gdy brak pozycji — ustawienia firmy (src/lib/company-config.ts).
 *
 * Dwie żelazne zasady:
 *  1. NIGDY nie nadpisujemy po cichu. Sugestia jest `confident` tylko wtedy, gdy pole jest puste/zerowe;
 *     gdy ma inną wartość — `confident: false` i UI musi poprosić o potwierdzenie. Automatyczne ścieżki
 *     (hak po oznaczeniu wydarzenia jako „wykonane” i hak po podpisaniu protokołu) zapisują
 *     WYŁĄCZNIE sugestie `confident`.
 *  2. Realizacja zafakturowana (`invoiced`) jest nietykalna — tylko podgląd, zapis odrzucony.
 *
 * `computeAutofill` jest asynchroniczne (kalkulacja dystansu potrafi wyjść do sieci), więc liczy się
 * POZA transakcją; zapis (`applySuggestions`) to osobna, krótka transakcja synchroniczna. Brak sieci
 * nigdy nie wywala kalkulacji — km po prostu wypada z sugestii i ląduje w `warnings`.
 */
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { PriceItem, Realization } from "../db/schema.js";
import { logActivity, type ActivityUser, type DbOrTx } from "./activity-log.js";
import { eventHours } from "./calendar-realizations.js";
import {
  AUTOFILL_FIELD_LABELS,
  getCompanyConfig,
  isAutofillField,
  type AutofillField,
  type CompanySettingsValues,
} from "./company-config.js";
import { distanceForObject, isGeoError, type DistanceMethod, type GeoPoint } from "./geo.js";
import { matchPriceItem, resolveHourRate, resolveKmRate } from "./price-match.js";
import { fillProtocolFromRealizationSync } from "./protocol-prefill.js";

// ---------------------------------------------------------------------------
// Typy publiczne (kontrakt z frontem)
// ---------------------------------------------------------------------------

export type SuggestionSource = "kalendarz" | "protokół" | "kalkulacja" | "cennik" | "ustawienia";

export interface Suggestion {
  field: AutofillField;
  /** Etykieta PL pola (żeby front nie musiał trzymać własnego słownika). */
  label: string;
  /** Wartość aktualnie w realizacji. */
  current: number | string | null;
  suggested: number | string;
  source: SuggestionSource;
  /** Czytelne „skąd to wyszło” — pokazywane pod polem i w dialogu. */
  detail: string;
  /** true = pole puste/zerowe, można zastosować bez pytania; false = sprzeczność, wymaga potwierdzenia. */
  confident: boolean;
}

export interface AutofillEventBrief {
  id: number;
  title: string;
  startAt: string;
  endAt: string;
  hours: number;
}

export interface AutofillDistance {
  /** Dystans w jedną stronę (km). */
  km: number;
  /** Dystans po uwzględnieniu „obie strony” — to trafia do actualKm. */
  totalKm: number;
  roundTrip: boolean;
  method: DistanceMethod;
  cached: boolean;
  from: GeoPoint;
  to: GeoPoint;
}

export interface AutofillContext {
  realizationId: number;
  date: string;
  site: string;
  invoiced: boolean;
  /** company.autofill_enabled — automat globalnie włączony. */
  enabled: boolean;
  /** Pola objęte automatem wg ustawień. */
  fields: AutofillField[];
  events: AutofillEventBrief[];
  protocol: {
    id: number;
    number: string;
    status: "draft" | "final";
    signedAt: string | null;
    actualHours: number;
    itemCount: number;
  } | null;
  object: { id: number; name: string } | null;
  priceList: { id: number; name: string; via: "technik" | "domyślny"; technician: string | null } | null;
  distance: AutofillDistance | null;
  distanceError: string | null;
}

export interface AutofillResult {
  suggestions: Suggestion[];
  warnings: string[];
  context: AutofillContext;
}

/** Krótkie etykiety do summary w activity_log („Uzupełniono automatycznie: godziny, materiały, km”). */
export const AUTOFILL_SHORT_LABELS: Record<AutofillField, string> = {
  actualHours: "godziny",
  amountHours: "kwota za godziny",
  amountMaterial: "materiały",
  actualKm: "km",
  amountKm: "kwota za km",
  hourlyCost: "koszt godzinowy",
  caretaker: "opiekun",
};

/** Ślad w `realizations.autofill` — na jego podstawie front rysuje badge „auto”. */
export interface AutofillMarkEntry {
  source: SuggestionSource;
  detail: string;
  /** ISO czasu zapisu. */
  at: string;
  /** Wartość, którą zapisał automat — po ręcznej zmianie wpis znika. */
  value: number | string;
}
export type AutofillMarks = Partial<Record<AutofillField, AutofillMarkEntry>>;

// ---------------------------------------------------------------------------
// Formatowanie PL (bez zależności od ICU — te same napisy w każdym środowisku)
// ---------------------------------------------------------------------------

const NBSP = " ";

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Liczba z przecinkiem, bez zbędnych zer („12,4”, „3”, „1 200,55”). */
export function plNum(n: number, maxDecimals = 2): string {
  const sign = n < 0 ? "-" : "";
  const raw = Math.abs(n).toFixed(maxDecimals);
  // Obcinanie zer TYLKO w części dziesiętnej — inaczej „1200” straciłoby końcowe zera.
  const s = raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "") : raw;
  const [i, f] = s.split(".");
  return sign + group(i) + (f ? `,${f}` : "");
}

/** Kwota z dwoma miejscami i złotówkami („1 200,00 zł”). */
export function plMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const [i, f] = Math.abs(n).toFixed(2).split(".");
  return `${sign}${group(i)},${f}${NBSP}zł`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Dopasowanie nazw i stawki — mieszkają w src/lib/price-match.ts (żeby wycena z protokołu
// mogła ich użyć bez importowania tego modułu), tutaj tylko re-eksport dla zgodności.
// ---------------------------------------------------------------------------

export {
  matchPriceItem,
  normalizeName,
  resolveHourRate,
  resolveKmRate,
  type HourRate,
} from "./price-match.js";

// ---------------------------------------------------------------------------
// Wczytanie kontekstu realizacji
// ---------------------------------------------------------------------------

interface ProtocolItemRaw {
  name?: unknown;
  serial?: unknown;
  unit?: unknown;
  qty?: unknown;
}

function parseProtocolItems(raw: string): { name: string; unit: string; qty: number }[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: { name: string; unit: string; qty: number }[] = [];
  for (const it of arr as ProtocolItemRaw[]) {
    if (typeof it !== "object" || it === null) continue;
    const name = typeof it.name === "string" ? it.name.trim() : "";
    if (!name) continue;
    const rawQty = typeof it.qty === "string" ? it.qty.replace(",", ".").trim() : it.qty;
    const qty = typeof rawQty === "number" ? rawQty : parseFloat(String(rawQty ?? ""));
    if (!Number.isFinite(qty) || qty <= 0) continue; // pusta ilość = pozycja z wzoru, nie materiał
    out.push({ name, unit: typeof it.unit === "string" ? it.unit.trim() : "", qty });
  }
  return out;
}

/** Wydarzenia kalendarza tej realizacji (bez usuniętych i anulowanych). */
function loadEventsFor(dbx: DbOrTx, realizationId: number) {
  return dbx
    .select({
      id: schema.calendarEvents.id,
      title: schema.calendarEvents.title,
      startAt: schema.calendarEvents.startAt,
      endAt: schema.calendarEvents.endAt,
      allDay: schema.calendarEvents.allDay,
      objectId: schema.calendarEvents.objectId,
    })
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.realizationId, realizationId),
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled")
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt))
    .all();
}

/** Obiekt: z wydarzenia (object_id), a gdy brak — po nazwie z `realizations.site`. */
function resolveObject(
  dbx: DbOrTx,
  site: string,
  events: { objectId: number | null }[]
): { id: number; name: string } | null {
  const fromEvent = events.find((e) => e.objectId != null)?.objectId ?? null;
  if (fromEvent != null) {
    const row = dbx
      .select({ id: schema.objects.id, name: schema.objects.name })
      .from(schema.objects)
      .where(eq(schema.objects.id, fromEvent))
      .get();
    if (row) return row;
  }

  const needle = site.trim();
  if (!needle) return null;
  const exact = dbx
    .select({ id: schema.objects.id, name: schema.objects.name })
    .from(schema.objects)
    .where(sql`lower(${schema.objects.name}) = lower(${needle})`)
    .all();
  if (exact.length === 1) return exact[0];

  const partial = dbx
    .select({ id: schema.objects.id, name: schema.objects.name })
    .from(schema.objects)
    .where(sql`lower(${schema.objects.name}) LIKE lower(${`%${needle}%`})`)
    .all();
  return partial.length === 1 ? partial[0] : null;
}

/** Cennik: technika z wydarzenia → technika z pola „Wykonawca 1” → cennik główny. */
function resolvePriceList(
  dbx: DbOrTx,
  contractor1: string,
  eventIds: number[]
): { id: number; name: string; via: "technik" | "domyślny"; technician: string | null } | null {
  const pick = (id: number, via: "technik" | "domyślny", technician: string | null) => {
    const row = dbx
      .select({ id: schema.priceLists.id, name: schema.priceLists.name })
      .from(schema.priceLists)
      .where(eq(schema.priceLists.id, id))
      .get();
    return row ? { id: row.id, name: row.name, via, technician } : null;
  };

  if (eventIds.length > 0) {
    const assigned = dbx
      .select({
        priceListId: schema.technicians.priceListId,
        firstName: schema.technicians.firstName,
        lastName: schema.technicians.lastName,
      })
      .from(schema.calendarEventAssignees)
      .innerJoin(schema.technicians, eq(schema.technicians.id, schema.calendarEventAssignees.technicianId))
      .where(
        sql`${schema.calendarEventAssignees.eventId} IN (${sql.join(
          eventIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
      .all();
    const withList = assigned.find((t) => t.priceListId != null);
    if (withList?.priceListId != null) {
      const found = pick(withList.priceListId, "technik", `${withList.firstName} ${withList.lastName}`.trim());
      if (found) return found;
    }
  }

  const name = contractor1.trim();
  if (name) {
    const tech = dbx
      .select({
        priceListId: schema.technicians.priceListId,
        firstName: schema.technicians.firstName,
        lastName: schema.technicians.lastName,
      })
      .from(schema.technicians)
      .where(sql`lower(trim(${schema.technicians.firstName} || ' ' || ${schema.technicians.lastName})) = lower(${name})`)
      .all();
    if (tech.length === 1 && tech[0].priceListId != null) {
      const found = pick(tech[0].priceListId, "technik", `${tech[0].firstName} ${tech[0].lastName}`.trim());
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

// ---------------------------------------------------------------------------
// computeAutofill
// ---------------------------------------------------------------------------

export interface ComputeOptions {
  dbx?: DbOrTx;
  /** true = kalkulacja dystansu wyłącznie z cache'u (bez wychodzenia do sieci). */
  cacheOnly?: boolean;
  /** Pomija kalkulację dystansu (np. gdy interesuje nas tylko protokół). */
  skipDistance?: boolean;
}

/**
 * Liczy sugestie dla realizacji. Zwraca `null`, gdy realizacji nie ma.
 * Nie zapisuje niczego poza leniwym uzupełnieniem współrzędnych obiektu (src/lib/geo.ts).
 */
export async function computeAutofill(
  realizationId: number,
  opts: ComputeOptions = {}
): Promise<AutofillResult | null> {
  const dbx = opts.dbx ?? db;
  const r = dbx.select().from(schema.realizations).where(eq(schema.realizations.id, realizationId)).get();
  if (!r) return null;

  const { values } = getCompanyConfig();
  const warnings: string[] = [];
  const suggestions: Suggestion[] = [];

  // --- dane wejściowe ---
  const eventRows = loadEventsFor(dbx, realizationId);
  const events: AutofillEventBrief[] = eventRows.map((e) => ({
    id: e.id,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    hours: eventHours(e),
  }));

  const protoRow = dbx
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, realizationId))
    .get();
  const protoItems = protoRow ? parseProtocolItems(protoRow.items) : [];
  const protocol = protoRow
    ? {
        id: protoRow.id,
        number: protoRow.number,
        status: protoRow.status,
        signedAt: protoRow.signedAt ?? null,
        actualHours: protoRow.actualHours,
        itemCount: protoItems.length,
      }
    : null;

  const object = resolveObject(dbx, r.site, eventRows);
  const priceList = resolvePriceList(dbx, r.contractor1 ?? "", eventRows.map((e) => e.id));
  const priceItems: PriceItem[] = priceList
    ? dbx
        .select()
        .from(schema.priceList)
        .where(and(eq(schema.priceList.priceListId, priceList.id), eq(schema.priceList.active, true)))
        .orderBy(asc(schema.priceList.position), asc(schema.priceList.id))
        .all()
    : [];
  const materials = priceItems.filter((i) => i.kind === "material");

  const wants = (f: AutofillField) => isAutofillField(f, values);
  const push = (s: Omit<Suggestion, "label" | "confident"> & { confident?: boolean }) => {
    const current = s.current;
    const empty = current === null || current === "" || current === 0;
    const same =
      typeof current === "number" && typeof s.suggested === "number"
        ? Math.abs(current - s.suggested) < 0.005
        : current === s.suggested;
    if (same) return; // nie ma czego proponować
    suggestions.push({
      ...s,
      label: AUTOFILL_FIELD_LABELS[s.field],
      confident: s.confident ?? empty,
    });
  };

  // --- godziny --------------------------------------------------------------
  const calendarHours = round2(events.reduce((sum, e) => sum + e.hours, 0));
  let hours: number | null = null;
  if (protocol && protocol.actualHours > 0) {
    hours = round2(protocol.actualHours);
    if (wants("actualHours")) {
      push({
        field: "actualHours",
        current: r.actualHours,
        suggested: hours,
        source: "protokół",
        detail: `z protokołu ${protocol.number}: ${plNum(hours)} godz.${
          events.length > 0 && Math.abs(calendarHours - hours) >= 0.01
            ? ` (kalendarz: ${plNum(calendarHours)} godz.)`
            : ""
        }`,
      });
    }
  } else if (events.length > 0 && calendarHours > 0) {
    hours = calendarHours;
    if (wants("actualHours")) {
      push({
        field: "actualHours",
        current: r.actualHours,
        suggested: hours,
        source: "kalendarz",
        detail: `${events.length === 1 ? "wydarzenie" : `${events.length} wydarzenia`} w kalendarzu: ${plNum(hours)} godz.`,
      });
    }
  } else if (wants("actualHours") && r.actualHours === 0) {
    warnings.push("Brak wydarzenia kalendarza i godzin w protokole — nie ma z czego wyliczyć godzin.");
  }

  const effectiveHours = hours ?? r.actualHours;

  // --- kwota za godziny -----------------------------------------------------
  if (wants("amountHours")) {
    const rate = resolveHourRate(priceItems, values);
    if (!rate) {
      warnings.push(
        "Brak stawki RBH: cennik nie ma pozycji usługowej z jednostką RBH, a `Stawka za roboczogodzinę` w ustawieniach firmy jest zerowa."
      );
    } else if (effectiveHours > 0) {
      const listName = priceList ? `cennik „${priceList.name}”` : "cennik";
      if (rate.mode === "tiered") {
        const rest = round2(Math.max(0, effectiveHours - 1));
        const amount = round2(rate.first + rate.next * rest);
        push({
          field: "amountHours",
          current: r.amountHours,
          suggested: amount,
          source: "cennik",
          detail:
            `${plNum(effectiveHours)} godz.: 1 × ${plMoney(rate.first)}` +
            (rest > 0 ? ` + ${plNum(rest)} × ${plMoney(rate.next)}` : "") +
            ` (${listName})`,
        });
      } else if (rate.mode === "flat") {
        push({
          field: "amountHours",
          current: r.amountHours,
          suggested: round2(effectiveHours * rate.rate),
          source: "cennik",
          detail: `${plNum(effectiveHours)} godz. × ${plMoney(rate.rate)} (${listName}: ${rate.itemName})`,
        });
      } else {
        push({
          field: "amountHours",
          current: r.amountHours,
          suggested: round2(effectiveHours * rate.rate),
          source: "ustawienia",
          detail: `${plNum(effectiveHours)} godz. × ${plMoney(rate.rate)} (stawka firmowa)`,
        });
      }
    }
  }

  // --- materiały ------------------------------------------------------------
  if (wants("amountMaterial")) {
    if (!protocol) {
      warnings.push("Realizacja nie ma protokołu — brak pozycji materiałowych do wyceny.");
    } else if (protoItems.length === 0) {
      warnings.push(`Protokół ${protocol.number} nie ma pozycji z podaną ilością — materiały pominięte.`);
    } else {
      const parts: string[] = [];
      const unmatched: string[] = [];
      let sum = 0;
      for (const it of protoItems) {
        const match = matchPriceItem(it.name, materials);
        if (!match) {
          unmatched.push(it.name);
          continue;
        }
        const line = round2(it.qty * match.price);
        sum += line;
        parts.push(`${plNum(it.qty)} × ${match.name} = ${plMoney(line)}`);
      }
      for (const name of unmatched) {
        warnings.push(
          `Materiał „${name}” — brak pozycji rodzaju „materiał”${priceList ? ` w cenniku „${priceList.name}”` : ""}.`
        );
      }
      if (parts.length > 0) {
        const net = round2(sum);
        const total = round2(net * (1 + values.materialMarkup / 100));
        const detail =
          parts.join("; ") +
          (values.materialMarkup !== 0 ? `; narzut ${plNum(values.materialMarkup)}% → ${plMoney(total)}` : "") +
          (unmatched.length > 0
            ? `; ${unmatched.length} ${unmatched.length === 1 ? "pozycja bez ceny" : "pozycje bez ceny"} w cenniku`
            : "");
        push({
          field: "amountMaterial",
          current: r.amountMaterial,
          suggested: total,
          source: "protokół",
          detail,
        });
      }
    }
  }

  // --- kilometry ------------------------------------------------------------
  let distance: AutofillDistance | null = null;
  let distanceError: string | null = null;
  const wantsKm = wants("actualKm") || wants("amountKm");
  if (wantsKm && !opts.skipDistance) {
    if (!object) {
      distanceError = "Nie ustalono obiektu realizacji (brak wydarzenia z obiektem i brak dopasowania po nazwie).";
    } else {
      const d = await distanceForObject(object.id, { dbx, cacheOnly: opts.cacheOnly });
      if (isGeoError(d)) {
        distanceError = d.error;
      } else {
        const totalKm = values.kmRoundTrip ? round1(d.km * 2) : d.km;
        distance = { ...d, totalKm, roundTrip: values.kmRoundTrip };
      }
    }
    if (distanceError) warnings.push(`Kalkulacja km: ${distanceError}`);
  }

  const methodLabel = (m: DistanceMethod) => (m === "route" ? "trasa OSRM" : "linia prosta ×1,3");
  if (distance && wants("actualKm")) {
    push({
      field: "actualKm",
      current: r.actualKm,
      suggested: distance.totalKm,
      source: "kalkulacja",
      detail:
        `${plNum(distance.km)} km${distance.roundTrip ? " × 2 (w obie strony)" : ""}` +
        ` — ${methodLabel(distance.method)}, ${distance.from.label} → ${distance.to.label}` +
        (distance.cached ? " (z cache)" : ""),
    });
  }

  if (wants("amountKm")) {
    const km = distance ? distance.totalKm : r.actualKm;
    const kmRate = resolveKmRate(priceItems, values);
    if (km > 0 && kmRate) {
      push({
        field: "amountKm",
        current: r.amountKm,
        suggested: round2(km * kmRate.rate),
        source: kmRate.itemName ? "cennik" : "ustawienia",
        detail: `${plNum(km)} km × ${plMoney(kmRate.rate)} (${
          kmRate.itemName ? `${priceList ? `cennik „${priceList.name}”: ` : "cennik: "}${kmRate.itemName}` : "stawka firmowa"
        })`,
      });
    } else if (km > 0 && !kmRate) {
      warnings.push("Brak stawki za km: cennik nie ma pozycji usługowej KM, a `Stawka za kilometr` jest zerowa.");
    }
  }

  // --- koszt godzinowy ------------------------------------------------------
  if (wants("hourlyCost") && values.hourlyCost > 0) {
    push({
      field: "hourlyCost",
      current: r.hourlyCost,
      suggested: values.hourlyCost,
      source: "ustawienia",
      detail: `koszt roboczogodziny z ustawień firmy: ${plMoney(values.hourlyCost)}/h`,
    });
  }

  // `caretaker` — brak źródła w modelu (patrz AUTOFILL_UNAVAILABLE_FIELDS w company-config.ts).

  return {
    suggestions,
    warnings,
    context: {
      realizationId,
      date: r.date,
      site: r.site,
      invoiced: r.invoiced,
      enabled: values.autofillEnabled,
      fields: values.autofillFields.filter((f) => isAutofillField(f, values)),
      events,
      protocol,
      object,
      priceList,
      distance,
      distanceError,
    },
  };
}

// ---------------------------------------------------------------------------
// Ślad automatu (badge „auto”)
// ---------------------------------------------------------------------------

export function parseAutofillMarks(raw: string | null | undefined): AutofillMarks {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {};
    const out: AutofillMarks = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!(k in AUTOFILL_SHORT_LABELS)) continue;
      if (typeof v !== "object" || v === null) continue;
      const e = v as Record<string, unknown>;
      out[k as AutofillField] = {
        source: String(e.source ?? "kalkulacja") as SuggestionSource,
        detail: String(e.detail ?? ""),
        at: String(e.at ?? ""),
        value: (typeof e.value === "number" || typeof e.value === "string" ? e.value : 0) as number | string,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeAutofillMarks(marks: AutofillMarks): string | null {
  const keys = Object.keys(marks);
  return keys.length > 0 ? JSON.stringify(marks) : null;
}

/**
 * Usuwa ślad automatu dla pól, których wartość zmieniła się poza automatem (ręczna edycja
 * realizacji). Dzięki temu badge „auto” nigdy nie wisi nad wartością wpisaną przez człowieka.
 */
export function pruneAutofillMarks(raw: string | null | undefined, after: Record<string, unknown>): string | null {
  const marks = parseAutofillMarks(raw);
  let changed = false;
  for (const [field, entry] of Object.entries(marks) as [AutofillField, AutofillMarkEntry][]) {
    const now = after[field];
    const same =
      typeof entry.value === "number" && typeof now === "number"
        ? Math.abs(entry.value - now) < 0.005
        : entry.value === now;
    if (!same) {
      delete marks[field];
      changed = true;
    }
  }
  if (!changed) return raw ?? null;
  return serializeAutofillMarks(marks);
}

// ---------------------------------------------------------------------------
// Zapis sugestii
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  /** Pola do zapisania. Sugestie spoza listy są ignorowane. */
  fields: AutofillField[];
  user: ActivityUser;
  /** Dopisek do summary w activity_log; domyślnie „(przez automat)”. */
  summarySuffix?: string | null;
  /**
   * Nadpisanie treści summary w activity_log (domyślnie „Uzupełniono automatycznie: …”).
   * Dostaje listę zapisanych pól, żeby haki mogły dopisać własny kontekst.
   */
  summary?: (applied: AutofillField[]) => string;
  /** Optimistic-concurrency: gdy podane, zapis przechodzi tylko przy zgodnym updatedAt. */
  expectedUpdatedAt?: string | null;
  /** true = zapisz wyłącznie sugestie `confident` (hak po podpisaniu protokołu). */
  confidentOnly?: boolean;
}

export type ApplyOutcome =
  | { status: "ok"; realization: Realization; applied: AutofillField[]; skipped: { field: string; reason: string }[] }
  | { status: "not_found" }
  | { status: "invoiced" }
  | { status: "conflict" };

const NUMERIC_FIELDS: AutofillField[] = [
  "actualHours",
  "amountHours",
  "amountMaterial",
  "actualKm",
  "amountKm",
  "hourlyCost",
];

/**
 * Zapisuje wskazane sugestie w jednej transakcji + wpis do activity_log.
 * Realizacja zafakturowana → `{ status: "invoiced" }` (wołający zwraca 400).
 */
export function applySuggestions(
  realizationId: number,
  suggestions: Suggestion[],
  opts: ApplyOptions
): ApplyOutcome {
  const wanted = new Set(opts.fields);
  const now = new Date().toISOString();

  return db.transaction((tx): ApplyOutcome => {
    const r = tx.select().from(schema.realizations).where(eq(schema.realizations.id, realizationId)).get();
    if (!r) return { status: "not_found" };
    if (r.invoiced) return { status: "invoiced" };
    if (opts.expectedUpdatedAt != null && r.updatedAt !== opts.expectedUpdatedAt) return { status: "conflict" };

    const patch: Record<string, number | string> = {};
    const applied: AutofillField[] = [];
    const skipped: { field: string; reason: string }[] = [];
    const marks = parseAutofillMarks(r.autofill);

    for (const field of wanted) {
      const s = suggestions.find((x) => x.field === field);
      if (!s) {
        skipped.push({ field, reason: "brak sugestii dla tego pola" });
        continue;
      }
      if (opts.confidentOnly && !s.confident) {
        skipped.push({ field, reason: "wartość już wpisana ręcznie — wymaga potwierdzenia" });
        continue;
      }
      if (NUMERIC_FIELDS.includes(field)) {
        if (typeof s.suggested !== "number" || !Number.isFinite(s.suggested)) {
          skipped.push({ field, reason: "sugestia nie jest liczbą" });
          continue;
        }
        patch[field] = s.suggested;
      } else {
        patch[field] = String(s.suggested);
      }
      marks[field] = { source: s.source, detail: s.detail, at: now, value: s.suggested };
      applied.push(field);
    }

    if (applied.length === 0) {
      return { status: "ok", realization: r, applied, skipped };
    }

    const updated = tx
      .update(schema.realizations)
      .set({ ...patch, autofill: serializeAutofillMarks(marks), updatedAt: now })
      .where(
        opts.expectedUpdatedAt != null
          ? and(eq(schema.realizations.id, realizationId), eq(schema.realizations.updatedAt, opts.expectedUpdatedAt))
          : eq(schema.realizations.id, realizationId)
      )
      .returning()
      .all();
    if (updated.length === 0) return { status: "conflict" };

    // Protokół jest dokumentem końcowym, więc godziny i km, które właśnie policzyliśmy,
    // muszą dojść także do niego — ale wyłącznie do pól pustych i tylko dopóki jest szkicem.
    // Wpis do dziennika robi sama funkcja — przy encji `protocol`, bo to protokół się zmienia;
    // dziennik realizacji zostaje jednym wpisem „Uzupełniono automatycznie: …”.
    fillProtocolFromRealizationSync(tx, updated[0], {
      user: opts.user,
      reason: "automat realizacji",
      summarySuffix: opts.summarySuffix === undefined ? "(przez automat)" : opts.summarySuffix,
    });
    logActivity(tx, {
      entityType: "realization",
      entityId: realizationId,
      user: opts.user,
      action: "updated",
      field: "autofill",
      oldValue: null,
      newValue: JSON.stringify(applied),
      summary: opts.summary
        ? opts.summary(applied)
        : `Uzupełniono automatycznie: ${applied.map((f) => AUTOFILL_SHORT_LABELS[f]).join(", ")}`,
      summarySuffix: opts.summarySuffix === undefined ? "(przez automat)" : opts.summarySuffix,
    });

    return { status: "ok", realization: updated[0], applied, skipped };
  });
}

/**
 * Hak po podpisaniu protokołu: policz i zapisz WYŁĄCZNIE pewne sugestie (pola puste/zerowe).
 * Wszystko w try/catch — nieudana kalkulacja (brak sieci, brak adresu) nie może wywrócić podpisu.
 */
export async function autofillAfterProtocolSigned(
  realizationId: number,
  user: ActivityUser
): Promise<{ applied: AutofillField[]; warnings: string[] } | null> {
  try {
    const { values } = getCompanyConfig();
    if (!values.autofillEnabled) return null;

    const result = await computeAutofill(realizationId);
    if (!result || result.context.invoiced) return null;

    const confident = result.suggestions.filter((s) => s.confident).map((s) => s.field);
    if (confident.length === 0) return { applied: [], warnings: result.warnings };

    const outcome = applySuggestions(realizationId, result.suggestions, {
      fields: confident,
      user,
      confidentOnly: true,
      summarySuffix: "(przez automat po podpisaniu protokołu)",
    });
    if (outcome.status !== "ok") return { applied: [], warnings: result.warnings };
    return { applied: outcome.applied, warnings: result.warnings };
  } catch (err) {
    console.error("Autofill po podpisaniu protokołu nie powiódł się:", err);
    return null;
  }
}

/**
 * Hak po oznaczeniu wydarzenia kalendarza jako „wykonane” — realizacja podlicza się WSTĘPNIE,
 * bez czekania na podpis protokołu.
 *
 * Kolejność źródeł jest ta sama, co przy podpisie (patrz `computeAutofill`):
 *  - godziny  ← wydarzenie kalendarza (protokół wygrywa dopiero wtedy, gdy ma własne godziny),
 *  - materiały ← pozycje protokołu; przy „wykonane” protokół jest zwykle jeszcze pusty, więc
 *    `amountMaterial` w ogóle nie trafia do sugestii (zero nie jest „pewną” wartością) —
 *    ląduje tylko ostrzeżenie „protokół nie ma pozycji z podaną ilością”. Materiały dolicza
 *    dopiero `autofillAfterProtocolSigned`, i to bez nadpisywania tego, co już zapisał ten hak,
 *  - km       ← kalkulacja dystansu (wyłącznie przez `geo_cache`; brak wpisu = ostrzeżenie),
 *  - stawki   ← cennik technika, a gdy brak pozycji — ustawienia firmy.
 *
 * Zapisuje WYŁĄCZNIE sugestie `confident` (pole puste/zerowe) i wyłącznie pola z `autofill_fields`.
 * Realizacja zafakturowana jest pomijana. Wszystko w try/catch — nieudana kalkulacja nie ma prawa
 * wywrócić zapisu wydarzenia (dlatego hak jest wołany PO commicie transakcji kalendarza; szczegóły
 * w src/lib/calendar-realizations.ts).
 */
export interface EventDoneAutofillCtx {
  user: ActivityUser;
  /** Wydarzenie, które wywołało podliczenie (trafia do summary w activity_log). */
  eventId?: number | null;
  /** Dopisek „czym” wykonano zmianę, np. „(przez asystenta)”; domyślnie „(przez automat)”. */
  summarySuffix?: string | null;
}

export async function autofillAfterEventDone(
  realizationId: number,
  ctx: EventDoneAutofillCtx
): Promise<{ applied: AutofillField[]; warnings: string[] } | null> {
  try {
    const { values } = getCompanyConfig();
    if (!values.autofillEnabled || !values.autofillOnEventDone) return null;

    const result = await computeAutofill(realizationId);
    if (!result || result.context.invoiced) return null;

    const confident = result.suggestions.filter((s) => s.confident).map((s) => s.field);
    if (confident.length === 0) return { applied: [], warnings: result.warnings };

    const outcome = applySuggestions(realizationId, result.suggestions, {
      fields: confident,
      user: ctx.user,
      confidentOnly: true,
      summarySuffix: ctx.summarySuffix === undefined ? "(przez automat)" : ctx.summarySuffix,
      summary: (applied) =>
        `Wstępnie podliczono realizację po oznaczeniu wydarzenia${
          ctx.eventId != null ? ` #${ctx.eventId}` : ""
        } jako wykonane: ${applied.map((f) => AUTOFILL_SHORT_LABELS[f]).join(", ")}`,
    });
    if (outcome.status !== "ok") return { applied: [], warnings: result.warnings };
    return { applied: outcome.applied, warnings: result.warnings };
  } catch (err) {
    console.error("Wstępne podliczenie realizacji po oznaczeniu wydarzenia jako wykonane nie powiodło się:", err);
    return null;
  }
}
