/**
 * Powiązania między kartotekami — bez nich koszt osobowy nie ma czym płynąć.
 *
 * Aplikacja trzyma trzy niezależne kartoteki, które dopiero teraz dało się spiąć:
 *   hr_objects.object_id   — pozycja kadrowa (na niej wiszą godziny) → obiekt z kartoteki
 *   salespeople.employee_id — handlowiec → pracownik na liście płac
 *   technicians.employee_id — technik → pracownik na liście płac
 *
 * Ten moduł ustawia je na danych deweloperskich, żeby dało się zobaczyć i
 * przetestować wyliczanie kosztu osobowego (src/lib/object-personnel-cost.ts).
 *
 * DLACZEGO OSOBNY REJESTR ZMIAN. Pozostałe moduły seeda kasują po znaczniku
 * w polu tekstowym, ale tutaj nie wstawiamy wierszy — tylko modyfikujemy kolumnę
 * w rekordach, które są PRAWDZIWE (44 pozycje kadrowe i 8 techników pochodzą
 * z importu, nie z seeda). Gdyby reset czyścił je hurtem, skasowałby też
 * mapowania zrobione ręcznie przez użytkownika w Kadry → Obiekty. Dlatego seed
 * zapisuje listę identyfikatorów, które sam ustawił, w `app_settings`, i cofa
 * wyłącznie je — i tylko wtedy, gdy wartość nadal jest tą, którą wpisał.
 */
import { db, schema } from "../../src/db/index.js";
import { computeObjectPersonnelCost } from "../../src/lib/object-personnel-cost.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  MARKER,
  type Tx,
  assertNotSeeded,
  dropRegistry,
  pickMany,
  readRegistry,
  runInTx,
  writeRegistry,
} from "./shared.js";

/** Klucz rejestru zmian w app_settings. */
const REGISTRY_KEY = "dev.seed.links";

interface Registry {
  /** hrObjectId → objectId ustawione przez seed. */
  hrObjects: Array<[number, number]>;
  /** salespersonId → employeeId. */
  salespeople: Array<[number, number]>;
  /** technicianId → employeeId. */
  technicians: Array<[number, number]>;
}

const EMPTY: Registry = { hrObjects: [], salespeople: [], technicians: [] };

export interface LinksCounts {
  hrObjectsMapped: number;
  salespeopleLinked: number;
  techniciansLinked: number;
}

/**
 * Pozycje kadrowe, których NIE wolno mapować: to koszt ogólny firmy, nie koszt
 * konkretnego obiektu. „CMA" to centrum monitorowania (31 tys. godzin), „#…" to
 * znaczniki techniczne. Godziny na nich zostają poza kosztem obiektów i to jest
 * poprawne — inaczej rozsmarowalibyśmy koszt centrali po klientach.
 */
function isOverhead(name: string): boolean {
  return name.startsWith("#") || name.trim().toUpperCase() === "CMA";
}

export function seedLinks(outerTx?: Tx): LinksCounts {
  const reg = readRegistry(REGISTRY_KEY, EMPTY);

  // Drugi przebieg bez resetu zmapowałby KOLEJNE pozycje kadrowe (filtr bierze
  // te z `object_id is null`, a poprzednio zmapowane już go nie mają) — koszt
  // osobowy obiektów urósłby po cichu ponad cel 30% przychodu. Rejestr z treścią
  // znaczy „ten moduł już tu był".
  assertNotSeeded(
    "links",
    reg.hrObjects.length > 0 || reg.salespeople.length > 0 || reg.technicians.length > 0,
  );

  // --- 1. Pozycje kadrowe → obiekty -------------------------------------
  // Mapujemy tylko pozycje z godzinami (inaczej mapowanie nic nie wnosi) i nie
  // będące kosztem ogólnym.
  //
  // ILE ICH ZMAPOWAĆ — rzecz, którą łatwo zrobić źle. Lista płac jest PRAWDZIWA
  // (ok. 536 tys. zł miesięcznie na 150 osób), a obiekty są wygenerowane, z
  // abonamentami rzędu 165 tys. zł łącznie. Zmapowanie wszystkiego wrzuca całą
  // pensję realnej firmy na garść syntetycznych obiektów i daje marżę −194%,
  // czyli ekran, który wygląda na zepsuty, choć arytmetyka jest poprawna.
  // Dlatego dobieramy podzbiór tak, żeby koszt osobowy wyszedł w wiarygodnej
  // proporcji do przychodu (cel: ~30%), zaczynając od pozycji najlżejszych.
  const hrObjects = db
    .select({
      id: schema.hrObjects.id,
      name: schema.hrObjects.name,
      objectId: schema.hrObjects.objectId,
      hours: sql<number>`(
        select coalesce(sum(worked_hours), 0) from hr_hours where hr_hours.object_id = hr_objects.id
      )`,
    })
    .from(schema.hrObjects)
    .all()
    .filter((h) => !isOverhead(h.name) && h.hours > 0 && h.objectId === null)
    .sort((a, b) => b.hours - a.hours);

  // Obiekty-kandydaci: NAJPIERW te z ochroną fizyczną, bo tylko tam warta jest
  // realnie pełniona przez ludzi i tylko tam alokacja wprost ma sens. Dozór
  // wizyjny i SSWiN dostają koszt inną drogą — udziałem w puli centrum
  // monitorowania — więc mapowanie na nie godzin ochroniarzy byłoby fikcją.
  // (Wcześniej celowaliśmy w `type`, który jest wycofywany.)
  const physical = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(eq(schema.objects.hasOfi, true))
    .all()
    .map((o) => o.id);
  const fallback = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(eq(schema.objects.status, "active"))
    .all()
    .map((o) => o.id);

  const targets = [...physical, ...pickMany(fallback, 30)];

  // Przychód miesięczny obiektów — punkt odniesienia dla celu kosztowego.
  const revenue =
    db
      .select({
        v: sql<number>`coalesce(sum(coalesce(monthly_value, 0) + coalesce(monthly_rental, 0)), 0)`,
      })
      .from(schema.objects)
      .all()[0]?.v ?? 0;
  const target = revenue * 0.3;

  // Od najlżejszych: dokładamy pozycje, dopóki koszt osobowy nie sięgnie celu.
  // Pomiar robi PRAWDZIWA funkcja licząca (a nie własne przybliżenie), więc to,
  // co zmierzymy tutaj, jest dokładnie tym, co pokaże Analityka.
  const ascending = [...hrObjects].reverse();
  const mapped: Array<[number, number]> = [];
  for (let i = 0; i < ascending.length; i++) {
    const h = ascending[i];
    const objectId = targets[i % targets.length];
    db.update(schema.hrObjects)
      .set({ objectId })
      .where(and(eq(schema.hrObjects.id, h.id), isNull(schema.hrObjects.objectId)))
      .run();
    mapped.push([h.id, objectId]);
    const cost = [...computeObjectPersonnelCost(3).byObjectId.values()].reduce((a, b) => a + b, 0);
    if (cost >= target) break;
  }

  // --- 2. Handlowcy → pracownicy ----------------------------------------
  // Tylko handlowcy z seeda (niosą znacznik). Prawdziwych nie ruszamy: to, czy
  // ktoś jest na liście płac, jest faktem kadrowym, a nie czymś do wymyślenia.
  const seededSales = db
    .select({ id: schema.salespeople.id })
    .from(schema.salespeople)
    .where(sql`${schema.salespeople.notes} like ${`%${MARKER}%`} and ${schema.salespeople.employeeId} is null`)
    .all();
  const officeEmployees = db
    .select({ id: schema.hrEmployees.id })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.kind, "biuro"))
    .all()
    .map((e) => e.id);

  const salesLinks: Array<[number, number]> = [];
  if (officeEmployees.length) {
    // Część handlowców zostaje bez powiązania — koszt ręczny musi być dalej
    // widoczny w UI, więc obie gałęzie mają być reprezentowane w danych.
    const linkCount = Math.min(Math.ceil(seededSales.length / 2), officeEmployees.length);
    const chosen = pickMany(seededSales, linkCount);
    runInTx(outerTx, (tx) => {
      chosen.forEach((s, i) => {
        const employeeId = officeEmployees[i % officeEmployees.length];
        tx.update(schema.salespeople)
          .set({ employeeId })
          .where(eq(schema.salespeople.id, s.id))
          .run();
        salesLinks.push([s.id, employeeId]);
      });
    });
  }

  // --- 3. Technicy → pracownicy -----------------------------------------
  // Tu dopasowujemy po nazwisku, bo część osób FAKTYCZNIE figuruje w obu
  // kartotekach (Jaworski, Sajdak) — to nie jest zmyślone powiązanie, tylko
  // naprawa braku, który do tej pory istniał w danych.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z ]/g, "")
      .trim()
      .split(/\s+/)
      .sort()
      .join(" ");
  const employeesByName = new Map(
    db.select({ id: schema.hrEmployees.id, fullName: schema.hrEmployees.fullName }).from(schema.hrEmployees).all()
      .map((e) => [norm(e.fullName), e.id])
  );
  const techLinks: Array<[number, number]> = [];
  runInTx(outerTx, (tx) => {
    for (const t of db
      .select({ id: schema.technicians.id, firstName: schema.technicians.firstName, lastName: schema.technicians.lastName, employeeId: schema.technicians.employeeId })
      .from(schema.technicians)
      .all()) {
      if (t.employeeId !== null) continue;
      const employeeId = employeesByName.get(norm(`${t.firstName} ${t.lastName}`));
      if (!employeeId) continue;
      tx.update(schema.technicians).set({ employeeId }).where(eq(schema.technicians.id, t.id)).run();
      techLinks.push([t.id, employeeId]);
    }
  });

  writeRegistry(REGISTRY_KEY, {
    hrObjects: [...reg.hrObjects, ...mapped],
    salespeople: [...reg.salespeople, ...salesLinks],
    technicians: [...reg.technicians, ...techLinks],
  });

  return {
    hrObjectsMapped: mapped.length,
    salespeopleLinked: salesLinks.length,
    techniciansLinked: techLinks.length,
  };
}

/**
 * Cofa WYŁĄCZNIE powiązania z rejestru i tylko wtedy, gdy wartość nadal jest ta,
 * którą wpisał seed. Gdy ktoś zmienił mapowanie ręcznie, zostaje jego — reset
 * danych deweloperskich nie ma prawa kasować decyzji użytkownika.
 */
export function resetLinks(outerTx?: Tx): LinksCounts {
  const reg = readRegistry(REGISTRY_KEY, EMPTY);
  let hrObjectsMapped = 0;
  let salespeopleLinked = 0;
  let techniciansLinked = 0;

  runInTx(outerTx, (tx) => {
    for (const [hrObjectId, objectId] of reg.hrObjects) {
      const r = tx
        .update(schema.hrObjects)
        .set({ objectId: null })
        .where(and(eq(schema.hrObjects.id, hrObjectId), eq(schema.hrObjects.objectId, objectId)))
        .run();
      hrObjectsMapped += r.changes;
    }
    for (const [salespersonId, employeeId] of reg.salespeople) {
      const r = tx
        .update(schema.salespeople)
        .set({ employeeId: null })
        .where(and(eq(schema.salespeople.id, salespersonId), eq(schema.salespeople.employeeId, employeeId)))
        .run();
      salespeopleLinked += r.changes;
    }
    for (const [technicianId, employeeId] of reg.technicians) {
      const r = tx
        .update(schema.technicians)
        .set({ employeeId: null })
        .where(and(eq(schema.technicians.id, technicianId), eq(schema.technicians.employeeId, employeeId)))
        .run();
      techniciansLinked += r.changes;
    }
    dropRegistry(REGISTRY_KEY);
  });

  return { hrObjectsMapped, salespeopleLinked, techniciansLinked };
}

export const LINKS_MODULE = `powiązania kartotek (rejestr w ${REGISTRY_KEY})`;
