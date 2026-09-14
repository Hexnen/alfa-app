/**
 * Protokół powykonawczy — logika edycji i podpisu, wspólna dla DWÓCH wejść:
 * biurowego (`src/routes/protocols.ts`, dialog na desktopie) i terenowego
 * (`src/routes/technik.ts`, tablet u klienta).
 *
 * Wydzielona z routera, żeby panel technika nie kopiował ani walidacji, ani —
 * co ważniejsze — kolejności rzeczy po podpisie. Podpis nie jest zwykłym
 * UPDATE: liczy `contentHash` z treści zapisanej w bazie (dowód integralności),
 * a PO commicie odpala automat uzupełniający realizację i przeliczenie wyceny.
 * Pominięcie któregokolwiek kroku w drugim wejściu dałoby protokoły podpisane
 * „inaczej” niż te z biura.
 *
 * Funkcje `*Sync` są synchroniczne (better-sqlite3) i pracują w PRZEKAZANEJ
 * transakcji; efekty po commicie są w `afterProtocolSigned` (async).
 */
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Protocol } from "../db/schema.js";
import { AUTOFILL_SHORT_LABELS, autofillAfterProtocolSigned } from "./realization-autofill.js";
import type { ActivityUser } from "./activity-log.js";
import { refreshQuoteFromProtocolSync } from "../routes/quotes.js";
import type { ProtocolItem } from "./protocol-prefill.js";

/** Typ transakcji drizzle/better-sqlite3 — pozwala współdzielić helpery między db i tx. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Pozycje protokołu trzymamy jako JSON w kolumnie tekstowej, więc każde wyjście
 * do API musi je rozpakować. Uszkodzony JSON (ręczna edycja bazy, import) daje
 * pustą listę, a nie 500 — dokument z brakującymi pozycjami wciąż da się otworzyć
 * i poprawić.
 */
export function withParsedItems<T extends Protocol & { site?: string | null }>(
  p: T
): Omit<T, "items"> & { items: ProtocolItem[] } {
  let items: ProtocolItem[] = [];
  try {
    items = JSON.parse(p.items);
  } catch {
    items = [];
  }
  return { ...p, items };
}

// ---------------------------------------------------------------------------
// Edycja (PUT /protocols/:id, PUT /technik/protocols/:id)
// ---------------------------------------------------------------------------

export type ProtocolUpdateOutcome =
  | { status: 200; data: Protocol }
  | { status: 404 }
  | { status: 409; signed?: boolean }
  | { status: 400; error: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Pozycje materiałowe z ciała żądania — same stringi, bez kwot (kwoty są w wycenie). */
export function parseProtocolItemsInput(raw: unknown): ProtocolItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    .map((i) => ({
      name: str(i.name),
      serial: str(i.serial),
      unit: str(i.unit),
      qty: str(i.qty),
    }));
}

/**
 * Zapis treści protokołu. Odczyt i UPDATE w JEDNEJ transakcji (przekazanej przez
 * wołającego), więc między sprawdzeniem „czy podpisany” a zapisem nic się nie
 * wciśnie. `expectedUpdatedAt` = optimistic concurrency: niezgodność → 409,
 * zamiast po cichu nadpisać cudzą edycję.
 *
 * Podpisanego protokołu nie wolno zmieniać — treść rozjechałaby się z
 * `contentHash` i dowód integralności przestałby cokolwiek dowodzić.
 */
export function updateProtocolSync(
  tx: Tx,
  id: number,
  body: Record<string, unknown>
): ProtocolUpdateOutcome {
  const workDate = str(body.workDate);
  if (workDate && !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return { status: 400, error: "Nieprawidłowa data wykonania" };
  }
  const items = parseProtocolItemsInput(body.items);
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;

  const rows = tx.select().from(schema.protocols).where(eq(schema.protocols.id, id)).limit(1).all();
  if (rows.length === 0) return { status: 404 };
  const existing = rows[0];

  if (existing.signaturePng || existing.contentHash) return { status: 409, signed: true };
  if (expectedUpdatedAt !== null && existing.updatedAt !== expectedUpdatedAt) return { status: 409 };

  const workType = ["serwis", "montaz", "wizja", "inne"].includes(body.workType as string)
    ? (body.workType as "serwis" | "montaz" | "wizja" | "inne")
    : existing.workType;

  const updated = tx
    .update(schema.protocols)
    .set({
      workDate: workDate || existing.workDate,
      workType,
      actualHours: num(body.actualHours),
      actualKm: num(body.actualKm),
      contractor: str(body.contractor),
      salesperson: str(body.salesperson),
      clientName: str(body.clientName),
      clientNip: str(body.clientNip),
      clientCity: str(body.clientCity),
      installationAddress: str(body.installationAddress),
      contact: str(body.contact),
      activities: str(body.activities),
      ...(items !== undefined ? { items: JSON.stringify(items) } : {}),
      status: body.status === "final" ? "final" : "draft",
      updatedAt: new Date().toISOString(),
    })
    .where(
      expectedUpdatedAt !== null
        ? and(eq(schema.protocols.id, id), eq(schema.protocols.updatedAt, expectedUpdatedAt))
        : eq(schema.protocols.id, id)
    )
    .returning()
    .all();
  if (updated.length === 0) return { status: 409 };
  return { status: 200, data: updated[0] };
}

/** Komunikat 409 przy edycji — jeden tekst dla obu wejść. */
export function protocolConflictMessage(signed?: boolean): string {
  return signed
    ? "Protokół jest podpisany — usuń podpis przed edycją."
    : "Protokół został w międzyczasie zmieniony. Odśwież i spróbuj ponownie.";
}

// ---------------------------------------------------------------------------
// Podpis (POST /protocols/:id/sign, POST /technik/protocols/:id/sign)
// ---------------------------------------------------------------------------

/** Maksymalny rozmiar dataURL podpisu — kilkanaście kresek palcem mieści się z zapasem. */
export const SIGNATURE_MAX_LENGTH = 500_000;
export const SIGNATURE_PREFIX = "data:image/png;base64,";

export type SignatureCheck = { ok: true } | { ok: false; error: string };

/** Walidacja podpisu z ciała żądania (ten sam komunikat w biurze i w terenie). */
export function checkSignaturePng(signaturePng: string): SignatureCheck {
  if (!signaturePng.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, error: "Brak poprawnego podpisu (PNG)" };
  }
  if (signaturePng.length > SIGNATURE_MAX_LENGTH) {
    return { ok: false, error: "Podpis jest zbyt duży" };
  }
  return { ok: true };
}

export type ProtocolSignOutcome =
  | { status: 200; data: Protocol }
  | { status: 404 }
  | { status: 409 };

/**
 * Podpisanie protokołu: PNG + imię i nazwisko + czas SERWERA + SHA-256 z treści.
 *
 * Hash liczy się z treści aktualnie zapisanej w bazie, w tej samej transakcji co
 * UPDATE — dzięki temu równoległa edycja nie może rozjechać podpisu z treścią
 * dokumentu, który klient miał przed oczami.
 */
export function signProtocolSync(
  tx: Tx,
  id: number,
  input: { signaturePng: string; signerName: string; expectedUpdatedAt?: string | null }
): ProtocolSignOutcome {
  const expectedUpdatedAt = input.expectedUpdatedAt ?? null;
  const rows = tx.select().from(schema.protocols).where(eq(schema.protocols.id, id)).limit(1).all();
  if (rows.length === 0) return { status: 404 };
  const p = rows[0];
  if (expectedUpdatedAt !== null && p.updatedAt !== expectedUpdatedAt) return { status: 409 };

  const signedAt = new Date().toISOString();
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        number: p.number,
        workDate: p.workDate,
        workType: p.workType,
        actualHours: p.actualHours,
        actualKm: p.actualKm,
        contractor: p.contractor,
        clientName: p.clientName,
        clientNip: p.clientNip,
        installationAddress: p.installationAddress,
        activities: p.activities,
        items: p.items,
        signerName: input.signerName,
        signedAt,
      })
    )
    .update(input.signaturePng)
    .digest("hex");

  const updated = tx
    .update(schema.protocols)
    .set({
      signaturePng: input.signaturePng,
      signerName: input.signerName,
      signedAt,
      contentHash,
      status: "final",
      updatedAt: signedAt,
    })
    .where(
      expectedUpdatedAt !== null
        ? and(eq(schema.protocols.id, id), eq(schema.protocols.updatedAt, expectedUpdatedAt))
        : eq(schema.protocols.id, id)
    )
    .returning()
    .all();
  if (updated.length === 0) return { status: 409 };
  return { status: 200, data: updated[0] };
}

export interface ProtocolSignedEffects {
  autofill: { applied: string[]; warnings: string[]; message: string } | null;
  quote: { number: string; items: number; warnings: string[]; message: string } | null;
  /** Gotowy dopisek do komunikatu („Protokół podpisany — …”). */
  message: string;
}

/**
 * Skutki uboczne podpisu — WOŁAĆ PO commicie transakcji podpisu.
 *
 * Po podpisie znane są realne godziny i materiały, więc automat dolicza puste
 * pola realizacji, a wycena (jeśli istnieje i nikt jej nie ruszał) przelicza się
 * z protokołu — podpisany protokół jest dla niej źródłem prawdy.
 *
 * KAŻDY błąd jest połykany: podpis jest już zapisany i nie wolno go wywrócić
 * dlatego, że geokoder nie odpowiedział albo wycena miała nietypową pozycję.
 */
export async function afterProtocolSigned(
  realizationId: number | null,
  user: ActivityUser
): Promise<ProtocolSignedEffects> {
  let autofill: ProtocolSignedEffects["autofill"] = null;
  let quote: ProtocolSignedEffects["quote"] = null;

  if (realizationId != null) {
    const res = await autofillAfterProtocolSigned(realizationId, user);
    if (res && res.applied.length > 0) {
      autofill = {
        applied: res.applied,
        warnings: res.warnings,
        message: `Uzupełniono automatycznie: ${res.applied
          .map((f) => AUTOFILL_SHORT_LABELS[f])
          .join(", ")}`,
      };
    }

    try {
      const res2 = db.transaction((tx) => refreshQuoteFromProtocolSync(tx, realizationId, user));
      if (res2.status === "updated" && res2.number && res2.items) {
        quote = {
          number: res2.number,
          items: res2.items.length,
          warnings: res2.warnings,
          message: `wyceniono ${res2.items.length} ${res2.items.length === 1 ? "pozycję" : "pozycji"} w wycenie ${res2.number}`,
        };
      }
    } catch (err) {
      console.error("Przeliczenie wyceny z protokołu nie powiodło się:", err);
    }
  }

  const parts = [autofill?.message, quote?.message].filter(Boolean);
  return {
    autofill,
    quote,
    message: parts.length > 0 ? `Protokół podpisany — ${parts.join("; ")}` : "Protokół podpisany",
  };
}
