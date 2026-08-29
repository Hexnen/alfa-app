/**
 * Usługi na obiektach: liczba kamer i wideorecepcja.
 *
 * Po rozbiciu `objects.type` na rozdzielne usługi (migracje 0054/0055) obiekty
 * mają flagi, ale `camera_count` jest wszędzie NULL — bo liczby kamer nie ma
 * dziś nigdzie w kartotece. Bez niej podział kosztu centrum monitorowania opiera
 * się wyłącznie na SSWiN i wideorecepcji, czyli funkcji praktycznie nie widać.
 *
 * DLACZEGO NIE Z REJESTRU CMA. `monitored_objects` (416 pozycji) NIESIE realne
 * dane o urządzeniach — kolumna `devices` z sufiksami producentów pozwala policzyć
 * kamery (`@dahua` 229 sztuk, `@hikvision` 100, `@onvif` 3) i alarmy (`@satel`,
 * `@ebs`). Problem w tym, że rejestru nie da się połączyć z kartoteką: 0 dopasowań
 * po nazwie i 0 po mieście+ulicy. To ta sama rozłączność, co przy `hr_objects`.
 * Dlatego liczby generujemy, ale ROZKŁAD bierzemy z rejestru — żeby dane
 * deweloperskie miały realistyczny kształt, a nie równomierny szum.
 *
 * Rozkład kamer zmierzony na `monitored_objects` (141 obiektów z urządzeniami
 * Dahua): 1 kamera — 106 obiektów, 2 — 14, 3 — 4, 4 — 14, 5 — 1, 6 — 1, 16 — 1.
 * Czyli: przytłaczająca większość to pojedyncze punkty, a ogon jest długi i rzadki.
 */
import { db, schema } from "../../src/db/index.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { MARKER, type Tx, assertNotSeeded, int, pickMany, runInTx, weighted } from "./shared.js";

export interface ServicesCounts {
  cameraCounts: number;
  videoreception: number;
}

/**
 * Liczba kamer wg rozkładu z rejestru CMA — z lekko podbitym ogonem, żeby wykresy
 * miały co pokazać. Sam rejestr ma jeden obiekt z 16 kamerami na 141; przy 90
 * obiektach deweloperskich taki ogon wypadłby zerowy.
 */
function cameraCount(): number {
  return weighted([
    [1, 45],
    [2, 15],
    [3, 9],
    [4, 12],
    [int(5, 8), 12],
    [int(9, 16), 7],
  ] as const);
}

export function seedServices(outerTx?: Tx): ServicesCounts {
  // Tylko obiekty ze znacznikiem — 9 pierwotnych zostawiamy w spokoju, bo to nie
  // są dane seeda i ich reset i tak by nie posprzątał.
  const seeded = db
    .select({ id: schema.objects.id, hasCameras: schema.objects.hasCameras })
    .from(schema.objects)
    .where(sql`${schema.objects.notes} like ${`%${MARKER}%`}`)
    .all();

  // Drugi przebieg bez resetu nie zdubluje wierszy (moduł tylko uzupełnia pola
  // przez `isNull`), ale przesunąłby wideorecepcję na kolejną porcję obiektów
  // i cicho rozjechał dane z tym, co pokazuje raport. Odmawiamy tak samo jak
  // reszta modułów — jeden przebieg, jeden stan.
  assertNotSeeded(
    "services",
    db
      .select({ id: schema.objects.id })
      .from(schema.objects)
      .where(
        and(
          sql`${schema.objects.notes} like ${`%${MARKER}%`}`,
          sql`${schema.objects.cameraCount} is not null`,
        ),
      )
      .limit(1)
      .get() !== undefined,
  );

  let cameraCounts = 0;
  let videoreception = 0;

  // Wideorecepcję wybieramy LICZBĄ, nie rzutem monetą per obiekt. Rzut monetą
  // przy p = 0,12 na 82 obiektach dał przy tym ziarnie 2 trafienia zamiast ~10
  // (generator jest w porządku — sprawdzone na 100 tys. losowań; to po prostu
  // wynik tego ziarna). Dane deweloperskie mają GWARANTOWAĆ pokrycie każdego
  // przypadku, bo inaczej funkcji nie da się obejrzeć.
  const withCameras = seeded.filter((o) => o.hasCameras);
  const videoIds = new Set(
    pickMany(withCameras, Math.max(3, Math.round(withCameras.length * 0.12))).map((o) => o.id)
  );

  runInTx(outerTx, (tx) => {
    for (const o of seeded) {
      if (o.hasCameras) {
        // `isNull` w warunku: nie nadpisujemy liczby, którą ktoś już wpisał ręcznie.
        const r = tx
          .update(schema.objects)
          .set({ cameraCount: cameraCount() })
          .where(and(eq(schema.objects.id, o.id), isNull(schema.objects.cameraCount)))
          .run();
        cameraCounts += r.changes;
      }
      // Wideorecepcja jest usługą niszową — ok. co ósmy obiekt z dozorem wizyjnym.
      if (videoIds.has(o.id)) {
        const r = tx
          .update(schema.objects)
          .set({ hasVideoreception: true })
          .where(and(eq(schema.objects.id, o.id), eq(schema.objects.hasVideoreception, false)))
          .run();
        videoreception += r.changes;
      }
    }
  });

  return { cameraCounts, videoreception };
}

/**
 * Cofa wyłącznie to, co ten moduł ustawił na obiektach ze znacznikiem. Obiekty
 * seeda i tak znikają przy `--reset` modułu `commercial`, ale gdy ktoś uruchomi
 * sam `--only=services --reset`, ma wrócić stan sprzed: brak liczby kamer i brak
 * wideorecepcji. Obiektów spoza seeda nie ruszamy w żadną stronę.
 */
export function resetServices(outerTx?: Tx): ServicesCounts {
  let cameraCounts = 0;
  let videoreception = 0;
  runInTx(outerTx, (tx) => {
    const marked = sql`${schema.objects.notes} like ${`%${MARKER}%`}`;
    cameraCounts = tx
      .update(schema.objects)
      .set({ cameraCount: null })
      .where(and(marked, sql`${schema.objects.cameraCount} is not null`))
      .run().changes;
    videoreception = tx
      .update(schema.objects)
      .set({ hasVideoreception: false })
      .where(and(marked, eq(schema.objects.hasVideoreception, true)))
      .run().changes;
  });
  return { cameraCounts, videoreception };
}

export const SERVICES_MODULE = "usługi obiektów (kamery, wideorecepcja)";
