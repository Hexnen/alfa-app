/**
 * Panel admina — Firma (/api/admin/company/*): adres biura, stawki domyślne i automat
 * uzupełniania realizacji.
 *
 * Ustawienia żyją w app_settings (klucze `company.*`, opis pól: src/lib/company-config.ts),
 * precedencja DB → domyślne; czytane przy każdej kalkulacji — bez restartu backendu.
 * Kształt odpowiedzi 1:1 z /api/admin/calendar/settings: { values, sources, defaults, meta }.
 */
import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { and, eq } from "drizzle-orm";
import { requireAdmin, getUser } from "../middleware/auth.js";
import { logActivity } from "../lib/activity-log.js";
import { deleteSetting, getSetting, setSetting } from "../lib/settings.js";
import {
  COMPANY_DEFAULTS,
  COMPANY_FIELDS,
  COMPANY_FIELD_NAMES,
  companySettingsMeta,
  getCompanyConfig,
  officeAddressLine,
  KM_SOURCES,
  type CompanyFieldDef,
  type CompanySettingField,
  type CompanySettingsValues,
  type KmSource,
} from "../lib/company-config.js";
import { distanceForObject, geocode, isGeoError } from "../lib/geo.js";
import { plMoney, plNum, resolveKmRate } from "../lib/realization-autofill.js";

const app = new Hono();
app.use("*", requireAdmin);

// ---------------------------------------------------------------------------
// Ustawienia
// ---------------------------------------------------------------------------

function settingsPayload() {
  const cfg = getCompanyConfig();
  return {
    values: cfg.values,
    sources: cfg.sources,
    defaults: COMPANY_DEFAULTS,
    meta: companySettingsMeta(),
  };
}

app.get("/settings", (c) => c.json({ success: true, data: settingsPayload() }));

type Op = {
  dbKey: string;
  /** null = usunięcie wpisu (powrót do wartości domyślnej). */
  value: string | null;
  summary: string;
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
};

function toLogValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

app.put("/settings", async (c) => {
  const user = getUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ success: false, error: "Nieprawidłowe body" }, 400);
  }

  const errors: string[] = [];
  const ops: Op[] = [];
  const before = getCompanyConfig();

  for (const name of COMPANY_FIELD_NAMES) {
    if (!(name in body)) continue;
    const raw = body[name];
    const def = COMPANY_FIELDS[name] as CompanyFieldDef<CompanySettingsValues[CompanySettingField]>;
    const prev = before.values[name];

    // null = „przywróć domyślne” — z wyjątkiem pól, dla których null jest LEGALNĄ wartością
    // (współrzędne biura: null = „wylicz z adresu”). Tam null idzie normalną ścieżką walidacji.
    const nullIsValue = def.type === "latitude" || def.type === "longitude";
    if (raw === null && !nullIsValue) {
      if (getSetting(def.dbKey) !== null) {
        ops.push({
          dbKey: def.dbKey,
          value: null,
          summary: `Przywrócono domyślne ustawienie firmy „${def.label}” (było: ${def.format(prev)})`,
          oldValue: toLogValue(prev),
          newValue: null,
        });
      }
      continue;
    }

    let val: unknown = def.coerce ? def.coerce(raw) : raw;
    if (def.type === "stringArray" && Array.isArray(raw)) {
      val = raw.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim());
    }
    const err = def.validate(val);
    if (err) {
      errors.push(err);
      continue;
    }
    const next = val as CompanySettingsValues[CompanySettingField];
    const serialized = def.serialize(next);
    // Ta sama wartość efektywna = nic do zapisania (bez pustych wpisów w activity_log).
    if (def.serialize(prev) === serialized) continue;
    ops.push({
      dbKey: def.dbKey,
      value: serialized,
      summary: `Zmieniono ustawienie firmy „${def.label}”: ${def.format(prev)} → ${def.format(next)}`,
      oldValue: toLogValue(prev),
      newValue: toLogValue(next),
    });
  }

  if (errors.length) return c.json({ success: false, error: errors.join("; ") }, 400);

  db.transaction((tx) => {
    for (const op of ops) {
      if (op.value === null) deleteSetting(op.dbKey, tx);
      else setSetting(op.dbKey, op.value, user.id, tx);
      logActivity(tx, {
        entityType: "app_settings",
        entityId: 0,
        user,
        action: "updated",
        field: op.dbKey,
        oldValue: op.oldValue,
        newValue: op.newValue,
        summary: op.summary,
      });
    }
  });

  return c.json({ success: true, data: settingsPayload() });
});

// ---------------------------------------------------------------------------
// Geokoder — „Wyszukaj współrzędne” dla adresu biura
// ---------------------------------------------------------------------------

/**
 * POST /geocode { address?, city?, postcode?, query? } → { lat, lng, display, cached, query }.
 * Bez pól bierze aktualny adres biura z ustawień. Brak sieci / brak wyniku → 400 z czytelnym
 * komunikatem (to świadome kliknięcie użytkownika, więc błąd należy pokazać wprost).
 */
app.post("/geocode", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const cfg = getCompanyConfig().values;

  const explicit = str(body.query);
  const query =
    explicit ||
    officeAddressLine({
      officeAddress: str(body.address) || cfg.officeAddress,
      officeCity: str(body.city) || cfg.officeCity,
      officePostcode: str(body.postcode) || cfg.officePostcode,
    });

  if (!query) return c.json({ success: false, error: "Podaj adres do wyszukania" }, 400);

  const hit = await geocode(query);
  if (isGeoError(hit)) return c.json({ success: false, error: hit.error }, 400);
  return c.json({ success: true, data: { ...hit, query } });
});

// ---------------------------------------------------------------------------
// „Testuj kalkulację” — dystans biuro → obiekt + kwoty wynikające ze stawek
// ---------------------------------------------------------------------------

/**
 * POST /test-distance { objectId, source? } → podgląd kalkulacji dla wskazanego obiektu.
 * Nigdy nie zwraca 500 — brak adresu / brak sieci wraca jako `{ error }` w danych (200),
 * żeby panel mógł to pokazać obok pól zamiast wywalać dialog.
 */
app.post("/test-distance", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const objectId = Number(body.objectId);
  if (!Number.isInteger(objectId) || objectId <= 0) {
    return c.json({ success: false, error: "Wskaż obiekt (objectId)" }, 400);
  }
  const sourceRaw = typeof body.source === "string" ? body.source : "";
  if (sourceRaw && !(KM_SOURCES as readonly string[]).includes(sourceRaw)) {
    return c.json({ success: false, error: `Parametr source: dozwolone ${KM_SOURCES.join(", ")}` }, 400);
  }

  const object = db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      latitude: schema.objects.latitude,
      longitude: schema.objects.longitude,
    })
    .from(schema.objects)
    .where(eq(schema.objects.id, objectId))
    .get();
  if (!object) return c.json({ success: false, error: "Nie znaleziono obiektu" }, 404);

  const values = getCompanyConfig().values;
  // Stawka za km z cennika GŁÓWNEGO (panel firmy nie zna kontekstu technika).
  const defaultList = db
    .select({ id: schema.priceLists.id })
    .from(schema.priceLists)
    .where(eq(schema.priceLists.isDefault, true))
    .get();
  const items = defaultList
    ? db
        .select()
        .from(schema.priceList)
        .where(and(eq(schema.priceList.priceListId, defaultList.id), eq(schema.priceList.active, true)))
        .all()
    : [];
  const kmRate = resolveKmRate(items, values);

  const d = await distanceForObject(objectId, { source: (sourceRaw || undefined) as KmSource | undefined });
  if (isGeoError(d)) {
    return c.json({ success: true, data: { object, distance: null, error: d.error, amounts: null } });
  }

  const totalKm = values.kmRoundTrip ? Math.round(d.km * 2 * 10) / 10 : d.km;
  const amountKm = kmRate ? Math.round(totalKm * kmRate.rate * 100) / 100 : null;

  return c.json({
    success: true,
    data: {
      object,
      distance: {
        km: d.km,
        totalKm,
        roundTrip: values.kmRoundTrip,
        method: d.method,
        cached: d.cached,
        from: d.from,
        to: d.to,
      },
      error: null,
      amounts: {
        actualKm: totalKm,
        amountKm,
        rate: kmRate?.rate ?? null,
        rateSource: kmRate ? (kmRate.itemName ? `cennik: ${kmRate.itemName}` : "stawka firmowa") : null,
        hourlyCost: values.hourlyCost,
        rateHour: values.rateHour,
      },
      summary: amountKm !== null
        ? `${plNum(d.km)} km${values.kmRoundTrip ? " × 2" : ""} × ${plMoney(kmRate!.rate)} = ${plMoney(amountKm)}`
        : `${plNum(totalKm)} km (brak stawki za km)`,
    },
  });
});

export default app;
