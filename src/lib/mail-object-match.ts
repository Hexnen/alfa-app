/**
 * Podpowiadanie OBIEKTU po adresach z maila.
 *
 * Mail upuszczony na kalendarz (src/lib/outlook-msg.ts) prawie zawsze dotyczy
 * konkretnego obiektu — a planujący i tak musiałby go potem wyklikać. Adresy
 * nadawcy i odbiorców zwykle wystarczą, żeby go wskazać:
 *
 *  1. kontakt (`contacts`) przypięty do OBIEKTU → ten jeden obiekt (`object_contact`),
 *  2. kontakt przypięty tylko do kontrahenta ALBO adres z `contractors.email`
 *     → wszystkie obiekty tego kontrahenta (`contractor`).
 *
 * To PODPOWIEDŹ, nie rozstrzygnięcie: front ustawia obiekt sam tylko wtedy, gdy
 * trafienie jest jedno i pochodzi z kontaktu obiektu; w pozostałych przypadkach
 * pokazuje chipy do kliknięcia. Porównanie adresów bez rozróżniania wielkości
 * liter i po obcięciu spacji.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";

/** Skąd wzięła się podpowiedź — front sortuje i ufa po tym polu. */
export type SuggestionVia = "object_contact" | "contractor";

export interface ObjectSuggestion {
  objectId: number;
  objectName: string;
  contractorName: string | null;
  /** Adresy z maila, które doprowadziły do tego obiektu (posortowane). */
  matchedEmails: string[];
  via: SuggestionVia;
}

/** Ile podpowiedzi maksymalnie wraca na front (dłuższa lista to już nie podpowiedź). */
export const OBJECT_SUGGESTIONS_MAX = 10;

/** Normalizacja adresu do porównania: trim + małe litery. */
const norm = (e: string) => e.trim().toLowerCase();

/**
 * Dopasowuje obiekty do adresów z maila. `emails` to gołe adresy (bez nazw
 * wyświetlanych) — wyciąga je `emailsOf` z src/lib/outlook-msg.ts.
 */
export function suggestObjectsForEmails(
  dbx: DbOrTx,
  emails: string[],
  limit = OBJECT_SUGGESTIONS_MAX
): ObjectSuggestion[] {
  const wanted = [...new Set(emails.map(norm).filter((e) => e.includes("@")))];
  if (wanted.length === 0) return [];

  /** objectId → { via, adresy }. `object_contact` nigdy nie ustępuje `contractor`. */
  const hits = new Map<number, { via: SuggestionVia; emails: Set<string> }>();
  const add = (objectId: number, via: SuggestionVia, email: string) => {
    const cur = hits.get(objectId);
    if (!cur) {
      hits.set(objectId, { via, emails: new Set([email]) });
      return;
    }
    cur.emails.add(email);
    if (via === "object_contact") cur.via = "object_contact";
  };

  // --- 1. Kontakty po adresie (tylko aktywne) ---
  const contactRows = dbx
    .select({
      email: schema.contacts.email,
      objectId: schema.contacts.objectId,
      contractorId: schema.contacts.contractorId,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.active, true),
        inArray(sql`lower(trim(${schema.contacts.email}))`, wanted)
      )
    )
    .all();

  /** contractorId → adresy, które go wskazały (obiekty dobierzemy hurtem niżej). */
  const byContractor = new Map<number, Set<string>>();
  const noteContractor = (contractorId: number, email: string) => {
    const set = byContractor.get(contractorId) ?? new Set<string>();
    set.add(email);
    byContractor.set(contractorId, set);
  };

  for (const r of contactRows) {
    const email = norm(r.email ?? "");
    if (!email) continue;
    if (r.objectId != null) add(r.objectId, "object_contact", email);
    else if (r.contractorId != null) noteContractor(r.contractorId, email);
  }

  // --- 2. Adres wprost w kartotece kontrahenta ---
  const contractorRows = dbx
    .select({ id: schema.contractors.id, email: schema.contractors.email })
    .from(schema.contractors)
    .where(inArray(sql`lower(trim(${schema.contractors.email}))`, wanted))
    .all();
  for (const r of contractorRows) {
    const email = norm(r.email ?? "");
    if (email) noteContractor(r.id, email);
  }

  // --- 3. Kontrahenci → ich obiekty (jedno zapytanie) ---
  if (byContractor.size > 0) {
    const rows = dbx
      .select({ id: schema.objects.id, contractorId: schema.objects.contractorId })
      .from(schema.objects)
      .where(inArray(schema.objects.contractorId, [...byContractor.keys()]))
      .all();
    for (const r of rows) {
      for (const email of byContractor.get(r.contractorId) ?? []) add(r.id, "contractor", email);
    }
  }

  if (hits.size === 0) return [];

  // --- 4. Nazwy obiektów i kontrahentów ---
  const names = dbx
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      contractorName: schema.contractors.name,
    })
    .from(schema.objects)
    .leftJoin(schema.contractors, eq(schema.objects.contractorId, schema.contractors.id))
    .where(inArray(schema.objects.id, [...hits.keys()]))
    .all();

  const out: ObjectSuggestion[] = names.map((o) => {
    const hit = hits.get(o.id)!;
    return {
      objectId: o.id,
      objectName: o.name,
      contractorName: o.contractorName ?? null,
      matchedEmails: [...hit.emails].sort(),
      via: hit.via,
    };
  });

  // Kontakt obiektu przed kontrahentem, potem więcej trafień, na końcu alfabetycznie —
  // kolejność jest kontraktem z frontem (bierze pierwszą pozycję jako „tę jedną").
  out.sort((a, b) => {
    if (a.via !== b.via) return a.via === "object_contact" ? -1 : 1;
    if (a.matchedEmails.length !== b.matchedEmails.length) return b.matchedEmails.length - a.matchedEmails.length;
    return a.objectName.localeCompare(b.objectName, "pl");
  });
  return out.slice(0, Math.max(0, limit));
}
