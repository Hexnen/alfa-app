/**
 * Wąskie listy dokumentów do pickerów „podepnij protokół / wycenę / realizację”
 * w dialogu wydarzenia kalendarza technicznego (`GET /calendar/pick/*`).
 *
 * Kalendarz nie ma kluczy `technical/protokoly|wyceny|realizacje`, a pełne trasy
 * tych modułów niosą więcej, niż picker potrzebuje: pozycje i ceny wycen,
 * `hourlyCost`, rzeczywiste godziny/km i koszty realizacji, podpisy i pozycje
 * protokołów (docs/AUDYT-UPRAWNIEN-A.md #9). Tu zwracamy dokładnie skrót, który
 * kalendarz i tak pokazuje przy podpiętym dokumencie (`CalendarEvent{Protocol,
 * Quote,Realization}` z src/lib/calendar-queries.ts) plus pola identyfikacji
 * (klient / obiekt / adres) do wyboru z listy.
 */
import { and, desc, eq, like } from "drizzle-orm";
import { db, schema } from "../db/index.js";

const PICK_LIMIT_MAX = 50;

function clampLimit(raw: string | undefined): number {
  const n = parseInt(raw || "", 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, PICK_LIMIT_MAX) : PICK_LIMIT_MAX;
}

function matches(q: string, values: unknown[]): boolean {
  return values.some((v) => v != null && String(v).toLowerCase().includes(q));
}

export interface ProtocolPickItem {
  id: number;
  number: string;
  status: "draft" | "final";
  signedAt: string | null;
  workDate: string;
  clientName: string | null;
  clientCity: string | null;
  site: string | null;
}

export function pickProtocols(qRaw: string | undefined, limitRaw: string | undefined): ProtocolPickItem[] {
  const q = (qRaw || "").trim().toLowerCase();
  const p = schema.protocols;
  const rows = db
    .select({
      id: p.id,
      number: p.number,
      status: p.status,
      signedAt: p.signedAt,
      workDate: p.workDate,
      clientName: p.clientName,
      clientCity: p.clientCity,
      installationAddress: p.installationAddress,
      site: schema.realizations.site,
    })
    .from(p)
    .leftJoin(schema.realizations, eq(p.realizationId, schema.realizations.id))
    .orderBy(desc(p.workDate), desc(p.id))
    .all();
  const filtered = q
    ? rows.filter((r) => matches(q, [r.number, r.clientName, r.site, r.clientCity, r.workDate, r.installationAddress]))
    : rows;
  return filtered.slice(0, clampLimit(limitRaw)).map(({ installationAddress: _addr, ...r }) => ({
    ...r,
    status: r.status as ProtocolPickItem["status"],
    signedAt: r.signedAt ?? null,
  }));
}

export interface QuotePickItem {
  id: number;
  number: string;
  date: string;
  site: string | null;
  address: string | null;
  total: number;
  filledItems: number;
}

/** Ta sama arytmetyka co `quoteTotals` w calendar-queries.ts (suma netto + wypełnione pozycje). */
function quoteTotals(raw: string | null): { total: number; filledItems: number } {
  let items: { qty?: unknown; price?: unknown }[] = [];
  try {
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    return { total: 0, filledItems: 0 };
  }
  const num = (v: unknown) => {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  let total = 0;
  let filledItems = 0;
  for (const i of items) {
    const qty = num(i.qty);
    if (qty > 0) filledItems++;
    total += qty * num(i.price);
  }
  return { total: Math.round(total * 100) / 100, filledItems };
}

export function pickQuotes(qRaw: string | undefined, limitRaw: string | undefined): QuotePickItem[] {
  const q = (qRaw || "").trim().toLowerCase();
  const t = schema.quotes;
  const rows = db
    .select({ id: t.id, number: t.number, date: t.date, site: t.site, address: t.address, items: t.items })
    .from(t)
    .orderBy(desc(t.date), desc(t.id))
    .all();
  const filtered = q ? rows.filter((r) => matches(q, [r.number, r.site, r.address, r.date])) : rows;
  return filtered.slice(0, clampLimit(limitRaw)).map(({ items, ...r }) => ({ ...r, ...quoteTotals(items) }));
}

export interface RealizationPickItem {
  id: number;
  date: string;
  site: string;
  kind: string;
  invoiced: boolean;
  total: number;
  note: string | null;
}

/** Realizacje jednego miesiąca (picker przegląda miesiącami, jak lista realizacji). */
export function pickRealizations(year: number, month: number): RealizationPickItem[] {
  const r = schema.realizations;
  const prefix = `${year}-${String(month).padStart(2, "0")}-%`;
  return db
    .select({
      id: r.id,
      date: r.date,
      site: r.site,
      kind: r.kind,
      invoiced: r.invoiced,
      note: r.note,
      amountHours: r.amountHours,
      amountMaterial: r.amountMaterial,
      amountKm: r.amountKm,
      discount: r.discount,
    })
    .from(r)
    .where(and(like(r.date, prefix)))
    .orderBy(desc(r.date), desc(r.id))
    .all()
    .map(({ amountHours, amountMaterial, amountKm, discount, ...row }) => ({
      ...row,
      note: row.note ?? null,
      total: Math.round((amountHours + amountMaterial + amountKm - discount) * 100) / 100,
    }));
}
