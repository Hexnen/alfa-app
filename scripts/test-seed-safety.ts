/**
 * Testy BEZPIECZEŃSTWA generatora danych deweloperskich (scripts/seed-dev-year.ts).
 *
 * Każdy przypadek odtwarza jedno znalezisko z bughuntu w tej samej postaci, w jakiej
 * traciło dane: do bazy trafia wiersz UŻYTKOWNIKA (bez znacznika `[dane deweloperskie]`),
 * potem leci reset albo drugi seed, a na końcu pytamy, czy ten wiersz przeżył.
 * Test, który tylko sprawdza „czy reset coś skasował", niczego by nie pilnował —
 * pilnowany jest wyłącznie ten jeden wiersz, którego seedowi nie wolno tknąć.
 *
 * URUCHOMIENIE (Node 22 — better-sqlite3 jest zbudowany pod niego):
 *   export PATH="/config/.nvm/versions/node/v22.22.0/bin:$PATH"
 *   npx tsx scripts/test-seed-safety.ts            # wszystkie przypadki
 *   npx tsx scripts/test-seed-safety.ts --case=d1  # jeden
 *
 * NIGDY NIE DOTYKA `data/alfa.db`. Proces nadrzędny robi KOPIĘ bazy (backup API
 * better-sqlite3, więc razem z WAL-em), odpala każdy przypadek w OSOBNYM procesie
 * potomnym z `ALFA_DB_PATH` wskazującym na tę kopię i kasuje ją w `finally`.
 * Osobny proces jest tu warunkiem sensu: `src/db/index.ts` otwiera bazę raz, przy
 * imporcie modułu, więc jeden proces = jedna baza; a każdy przypadek potrzebuje
 * bazy nietkniętej przez poprzedni. Potomek dodatkowo sam odmawia startu, gdyby
 * `ALFA_DB_PATH` prowadziło do bazy produkcyjnej.
 *
 * Testy celowo NIE zakładają nowych sygnatur modułów (uchwyt transakcji jest
 * opcjonalny, a `await` na wartości niebędącej obietnicą działa) — dzięki temu ten
 * sam plik uruchamia się na kodzie SPRZED poprawek i pokazuje, że wtedy pada.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const SELF = fileURLToPath(import.meta.url);
const PROD_DB = resolve(process.cwd(), "data/alfa.db");

/** Znacznik danych seeda — powtórzony tu świadomie, żeby test nie zależał od stałej. */
const MARKER = "[dane deweloperskie]";

/* ------------------------------------------------------------------ */
/* Drobne narzędzia                                                    */
/* ------------------------------------------------------------------ */

class AssertionError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

const ok = (msg: string) => console.log(`    ✓ ${msg}`);

/* ------------------------------------------------------------------ */
/* PROCES NADRZĘDNY — kopia bazy + uruchomienie przypadków             */
/* ------------------------------------------------------------------ */

const CASES = [
  { name: "d1", label: "kaskada kontrahenta nie zabiera obiektów użytkownika" },
  { name: "d2", label: "koszt i prowizja prawdziwego handlowca przeżywają seed i reset" },
  { name: "d4", label: "reset magazynu nie kasuje cudzych stanów ani numeratorów" },
  { name: "d5", label: "ręcznie wpisana norma miesiąca przeżywa reset kadr" },
  { name: "d6", label: "moduły odmawiają drugiego zasiania bez resetu" },
  { name: "atom", label: "błąd w przebiegu wycofuje cały przebieg" },
] as const;

async function runParent(only?: string): Promise<void> {
  assert(existsSync(PROD_DB), `Brak bazy ${PROD_DB} — uruchom z katalogu projektu.`);
  const workdir = join(tmpdir(), `seed-safety-${process.pid}`);
  mkdirSync(workdir, { recursive: true });

  const selected = CASES.filter((c) => !only || c.name === only);
  assert(selected.length > 0, `Nieznany przypadek. Dostępne: ${CASES.map((c) => c.name).join(", ")}`);

  const failed: string[] = [];
  try {
    for (const c of selected) {
      const copy = join(workdir, `${c.name}.db`);
      // Backup API, a nie `cp`: baza chodzi w WAL i sam plik `.db` bywa starszy
      // od tego, co widać w aplikacji.
      const src = new Database(PROD_DB, { readonly: true });
      await src.backup(copy);
      src.close();

      console.log(`\n[${c.name}] ${c.label}`);
      const t0 = Date.now();
      // Uruchamiamy przez `node_modules/.bin/tsx`, a nie przez `process.execPath`:
      // loader TypeScriptu nie zawsze siedzi w `execArgv` procesu nadrzędnego.
      const res = spawnSync(resolve(process.cwd(), "node_modules/.bin/tsx"), [SELF, `--case=${c.name}`], {
        stdio: "inherit",
        env: { ...process.env, ALFA_DB_PATH: copy },
      });
      if (res.status !== 0) failed.push(c.name);
      console.log(`    ${Date.now() - t0} ms — ${res.status === 0 ? "OK" : "BŁĄD"}`);

      rmSync(copy, { force: true });
      rmSync(`${copy}-wal`, { force: true });
      rmSync(`${copy}-shm`, { force: true });
    }
  } finally {
    // Sprzątamy ZAWSZE — także po Ctrl+C w środku i po wyjątku wyżej.
    rmSync(workdir, { recursive: true, force: true });
  }

  if (failed.length > 0) {
    console.error(`\nNIEZALICZONE: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("\nWszystkie przypadki zaliczone.");
}

/* ------------------------------------------------------------------ */
/* PROCES POTOMNY — jeden przypadek na kopii bazy                      */
/* ------------------------------------------------------------------ */

async function runCase(name: string): Promise<void> {
  const dbPath = process.env.ALFA_DB_PATH;
  assert(dbPath, "ALFA_DB_PATH nie jest ustawione — test nie ma prawa ruszyć bazy produkcyjnej.");
  assert(
    resolve(dbPath) !== PROD_DB,
    `ALFA_DB_PATH wskazuje na bazę produkcyjną (${dbPath}) — przerwane.`,
  );

  // Import DOPIERO teraz: `src/db/index.ts` czyta ALFA_DB_PATH przy pierwszym
  // imporcie, więc statyczny `import` na górze pliku otworzyłby złą bazę.
  const { db } = await import("../src/db/index.js");
  const commercial = await import("./seed-dev/commercial.js");
  const operations = await import("./seed-dev/operations.js");
  const warehouse = await import("./seed-dev/warehouse.js");
  const hr = await import("./seed-dev/hr.js");
  const services = await import("./seed-dev/services.js");
  const links = await import("./seed-dev/links.js");

  const raw = new Database(dbPath);
  const one = <T>(sqlText: string, ...params: unknown[]): T =>
    raw.prepare(sqlText).pluck().get(...(params as never[])) as T;

  /** Czy wywołanie rzuciło wyjątkiem (i jakim) — do testów guardów. */
  const throws = async (fn: () => unknown): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  switch (name) {
    /* ---------------------------------------------------------------- */
    case "d1": {
      // Użytkownik dopisuje WŁASNY obiekt do kontrahenta, który przyszedł z seeda.
      // `objects.contractor_id` ma ON DELETE CASCADE, więc skasowanie kontrahenta
      // zabiera ten obiekt razem z umowami i historią — po cichu.
      const contractorId = one<number>(
        `select c.id from contractors c
          where c.notes like ? and exists (select 1 from objects o where o.contractor_id = c.id)
          limit 1`,
        `%${MARKER}%`,
      );
      assert(contractorId, "Kopia bazy nie ma kontrahenta z seeda z obiektami — nie ma czego testować.");

      raw
        .prepare(
          `insert into objects (contractor_id, name, type, installation_type, status, notes, monthly_value)
           values (?, 'Obiekt użytkownika (test bezpieczeństwa)', 'monitoring', 'wlasna', 'active', 'wpisane ręcznie', 900)`,
        )
        .run(contractorId);
      const userObjectId = one<number>("select last_insert_rowid()");

      const objectsBefore = one<number>("select count(*) from objects");
      const userObjectsBefore = one<number>(
        "select count(*) from objects where notes is null or notes not like ?",
        `%${MARKER}%`,
      );

      const counts = await commercial.resetCommercial();

      const objectsAfter = one<number>("select count(*) from objects");
      const userObjectsAfter = one<number>(
        "select count(*) from objects where notes is null or notes not like ?",
        `%${MARKER}%`,
      );
      const survived = one<number>("select count(*) from objects where id = ?", userObjectId);

      assert(survived === 1, `Obiekt użytkownika (id ${userObjectId}) zniknął przy resecie.`);
      ok("obiekt użytkownika przeżył reset");

      assert(
        userObjectsAfter === userObjectsBefore,
        `Zniknęły obiekty bez znacznika: było ${userObjectsBefore}, zostało ${userObjectsAfter}.`,
      );
      ok(`wszystkie obiekty bez znacznika na miejscu (${userObjectsAfter})`);

      assert(
        one<number>("select count(*) from contractors where id = ?", contractorId) === 1,
        "Kontrahent z cudzym obiektem został skasowany — kaskada znów zabiera obiekt.",
      );
      ok("kontrahent z cudzym obiektem zostaje w bazie");

      assert(
        counts.objects === objectsBefore - objectsAfter,
        `Raport kłamie: "objects: ${counts.objects}", a ubyło ${objectsBefore - objectsAfter}.`,
      );
      ok(`raport zgadza się z bazą (objects: ${counts.objects})`);
      break;
    }

    /* ---------------------------------------------------------------- */
    case "d2": {
      // Handlowiec sprzed seeda z ręcznie wpisanym kosztem i prowizją. Seed ma
      // takie pole wyłącznie UZUPEŁNIAĆ, a reset cofać tylko to, co sam wpisał.
      const legacy = raw
        .prepare(
          `select id from salespeople where notes is null or notes not like ? order by id limit 2`,
        )
        .pluck()
        .all(`%${MARKER}%`) as number[];
      assert(legacy.length === 2, "Potrzebni dwaj handlowcy sprzed seeda.");
      const [manualId, emptyId] = legacy;

      raw.prepare("update salespeople set monthly_cost = 7777, commission_rate = 9.9 where id = ?").run(manualId);
      raw.prepare("update salespeople set monthly_cost = null, commission_rate = null where id = ?").run(emptyId);

      const manual = () =>
        raw.prepare("select monthly_cost as c, commission_rate as r from salespeople where id = ?").get(manualId) as {
          c: number | null;
          r: number | null;
        };
      const empty = () =>
        raw.prepare("select monthly_cost as c, commission_rate as r from salespeople where id = ?").get(emptyId) as {
          c: number | null;
          r: number | null;
        };

      await commercial.resetCommercial();
      assert(
        manual().c === 7777 && manual().r === 9.9,
        `Reset wyzerował ręcznie wpisane wartości: ${JSON.stringify(manual())}.`,
      );
      ok("reset nie tknął ręcznie wpisanego kosztu i prowizji");

      await commercial.seedCommercial();
      assert(
        manual().c === 7777 && manual().r === 9.9,
        `Seed nadpisał ręcznie wpisane wartości: ${JSON.stringify(manual())}.`,
      );
      ok("seed nie nadpisał ręcznie wpisanego kosztu i prowizji");

      const filled = empty();
      assert(filled.c !== null, "Seed nie uzupełnił pustego kosztu — funkcja przestała działać.");
      ok(`seed uzupełnił puste pole (koszt ${filled.c})`);

      await commercial.resetCommercial();
      assert(
        manual().c === 7777 && manual().r === 9.9,
        `Drugi reset wyzerował ręczne wartości: ${JSON.stringify(manual())}.`,
      );
      assert(empty().c === null, "Reset nie cofnął wartości, którą sam wpisał.");
      ok("reset cofnął WYŁĄCZNIE to, co wpisał seed");
      break;
    }

    /* ---------------------------------------------------------------- */
    case "d4": {
      // Bilans otwarcia wpisany ręcznie: stan bez ani jednego ruchu w księdze.
      // Reset przeliczający CAŁĄ tabelę uznawał go za sierotę i kasował.
      const pair = raw
        .prepare(
          `select i.id as item_id, w.id as warehouse_id
             from warehouse_items i, warehouses w
            where not exists (select 1 from warehouse_stock s where s.item_id = i.id and s.warehouse_id = w.id)
              and not exists (select 1 from warehouse_movements m where m.item_id = i.id and m.warehouse_id = w.id)
            limit 1`,
        )
        .get() as { item_id: number; warehouse_id: number } | undefined;
      assert(pair, "Brak wolnej pary towar/magazyn w kopii bazy.");

      raw
        .prepare("insert into warehouse_stock (item_id, warehouse_id, quantity) values (?, ?, 42)")
        .run(pair.item_id, pair.warehouse_id);

      // Numerator typu i roku, z którego seed nigdy nie brał numerów.
      raw.prepare("insert into warehouse_doc_sequences (doc_type, year, last_number) values ('PZ', 2019, 5)").run();

      const seqBefore = raw
        .prepare("select doc_type, year, last_number from warehouse_doc_sequences order by doc_type, year")
        .all() as Array<{ doc_type: string; year: number; last_number: number }>;

      await warehouse.resetWarehouse();

      const left = one<number | undefined>(
        "select quantity from warehouse_stock where item_id = ? and warehouse_id = ?",
        pair.item_id,
        pair.warehouse_id,
      );
      assert(left === 42, `Ręcznie wpisany stan 42 zniknął (zostało: ${String(left)}).`);
      ok("ręcznie wpisany stan magazynowy przeżył reset");

      const seqAfter = raw
        .prepare("select doc_type, year, last_number from warehouse_doc_sequences order by doc_type, year")
        .all() as Array<{ doc_type: string; year: number; last_number: number }>;
      assert(
        seqAfter.length === seqBefore.length,
        `Reset skasował numeratory: było ${seqBefore.length}, zostało ${seqAfter.length}.`,
      );
      ok(`żaden numerator nie został skasowany (${seqAfter.length})`);

      const foreign = seqAfter.find((s) => s.doc_type === "PZ" && s.year === 2019);
      assert(foreign?.last_number === 5, `Numerator spoza seeda został zmieniony: ${JSON.stringify(foreign)}.`);
      ok("numerator spoza seeda nietknięty (PZ/2019 = 5)");

      // Numer wydany drugi raz = UNIQUE na doc_number przy zatwierdzaniu z UI.
      for (const s of seqAfter) {
        const maxUsed = one<number>(
          `select coalesce(max(cast(substr(doc_number, length(?) + 1) as integer)), 0)
             from warehouse_documents
            where doc_type = ? and doc_number like ?`,
          `${s.doc_type}/${s.year}/`,
          s.doc_type,
          `${s.doc_type}/${s.year}/%`,
        );
        assert(
          s.last_number >= maxUsed,
          `Numerator ${s.doc_type}/${s.year} cofnięty poniżej wydanych numerów (${s.last_number} < ${maxUsed}).`,
        );
      }
      ok("każdy numerator stoi nie niżej niż najwyższy numer w dokumentach");
      break;
    }

    /* ---------------------------------------------------------------- */
    case "d5": {
      // `hr_month_norms` nie ma kolumny na notatkę, więc do niedawna reset kasował
      // WSZYSTKIE normy z okna 2025-09…12 — także wpisaną ręcznie przez kadrową.
      raw.prepare("update hr_month_norms set work_norm = 111 where year = 2025 and month = 9").run();
      const manualNorm = one<number>("select count(*) from hr_month_norms where year = 2025 and month = 9");
      assert(manualNorm === 1, "Kopia bazy nie ma normy 2025-09 — nie ma czego testować.");

      await hr.resetHr();
      assert(
        one<number>("select count(*) from hr_month_norms where year = 2025 and month = 9 and work_norm = 111") === 1,
        "Reset skasował normę wpisaną ręcznie dla 2025-09.",
      );
      ok("ręcznie wpisana norma 2025-09 przeżyła reset");

      // Druga połowa: normę, którą seed FAKTYCZNIE założy, reset ma sprzątnąć.
      raw.prepare("delete from hr_month_norms where year = 2025 and month = 10").run();
      await hr.seedHr();
      assert(
        one<number>("select count(*) from hr_month_norms where year = 2025 and month = 10") === 1,
        "Seed nie odtworzył brakującej normy 2025-10.",
      );
      const registry = one<string | undefined>("select value from app_settings where key = 'dev.seed.hr'");
      assert(registry && registry.includes("2025"), "Seed nie zapisał rejestru norm — reset nie będzie miał czego cofać.");
      ok("seed zapisał w rejestrze normę, którą sam założył");

      await hr.resetHr();
      assert(
        one<number>("select count(*) from hr_month_norms where year = 2025 and month = 10") === 0,
        "Reset nie sprzątnął normy założonej przez seed.",
      );
      assert(
        one<number>("select count(*) from hr_month_norms where year = 2025 and month = 9 and work_norm = 111") === 1,
        "Drugi reset skasował ręcznie wpisaną normę 2025-09.",
      );
      ok("reset sprzątnął normę seeda i zostawił ręczną");
      break;
    }

    /* ---------------------------------------------------------------- */
    case "d6": {
      // Kopia bazy jest już zasiana, więc KAŻDY moduł ma odmówić od razu.
      const modules: Array<[string, () => unknown]> = [
        ["commercial", () => commercial.seedCommercial()],
        ["operations", () => operations.seedOperations()],
        ["warehouse", () => warehouse.seedWarehouse()],
        ["hr", () => hr.seedHr()],
        ["services", () => services.seedServices()],
        ["links", () => links.seedLinks()],
      ];
      for (const [label, fn] of modules) {
        const msg = await throws(fn);
        assert(msg, `Moduł "${label}" pozwolił na drugie zasianie bez resetu.`);
        assert(
          msg.includes("--reset") || msg.includes("reset"),
          `Moduł "${label}" odmówił, ale komunikat nie mówi, co zrobić: ${msg}`,
        );
      }
      ok("wszystkie sześć modułów odmawia zasiania na zasianej bazie");

      // Scenariusz z bughuntu: `--only=operations` dwa razy z rzędu.
      await operations.resetOperations();
      await operations.seedOperations();
      const events = one<number>("select count(*) from calendar_events");
      const realizations = one<number>("select count(*) from realizations");

      const msg = await throws(() => operations.seedOperations());
      assert(msg, "Drugie `--only=operations` przeszło bez ostrzeżenia — dane się dublują.");
      assert(
        one<number>("select count(*) from calendar_events") === events &&
          one<number>("select count(*) from realizations") === realizations,
        "Odrzucony przebieg zdążył coś dopisać.",
      );
      ok(`drugi przebieg odrzucony, liczby bez zmian (${events} wydarzeń, ${realizations} realizacji)`);
      break;
    }

    /* ---------------------------------------------------------------- */
    case "atom": {
      // Awaria w środku przebiegu ma cofnąć WSZYSTKO, co zrobiły moduły przed nią.
      // Testujemy to na PRAWDZIWYM przebiegu (`--reset --seed`), a nie na wywołaniu
      // pojedynczych funkcji — bo transakcję całego przebiegu prowadzi orkiestrator.
      //
      // Awarię wymuszamy tak, jak zdarza się naprawdę: użytkownik ma w kartotece
      // własny towar o SKU, które seed też wstawia (`warehouse_items.sku` jest
      // UNIQUE). Trzeci moduł się wywraca, a pierwsze dwa mają zniknąć razem z nim.
      const collision = raw
        .prepare("update warehouse_items set description = 'wpisane ręcznie' where sku = 'CAM-001'")
        .run();
      assert(collision.changes === 1, "Kopia bazy nie ma towaru CAM-001 — nie ma czym wywołać kolizji.");

      // Odcisk palca liczony z identyfikatorów: same liczności potrafią wrócić
      // do tej samej wartości po cyklu reset→seed, ale `id` z AUTOINCREMENT nigdy
      // się nie powtarzają, więc suma kluczy zmienia się przy każdym przesianiu.
      const fingerprint = () =>
        [
          "contractors",
          "objects",
          "calendar_events",
          "realizations",
          "hr_hours",
          "warehouse_documents",
        ]
          .map((t) => `${t}:${one<number>(`select coalesce(count(*), 0) from ${t}`)}/${one<number>(`select coalesce(sum(id), 0) from ${t}`)}`)
          .join(" ");

      const before = fingerprint();

      const run = spawnSync(
        resolve(process.cwd(), "node_modules/.bin/tsx"),
        [resolve(process.cwd(), "scripts/seed-dev-year.ts"), "--reset", "--seed"],
        { env: { ...process.env, ALFA_DB_PATH: dbPath }, encoding: "utf8" },
      );
      assert(
        run.status !== 0,
        "Przebieg zakończył się sukcesem mimo kolizji SKU — test nic nie sprawdził.",
      );
      ok("przebieg przerwany na trzecim module (kolizja SKU), tak jak zaplanowano");

      const after = fingerprint();
      assert(
        after === before,
        `Baza została w połowie przesiana:\n      przed: ${before}\n      po:    ${after}`,
      );
      ok("baza jest bit w bit sprzed uruchomienia — cały przebieg wycofany");
      break;
    }

    default:
      throw new AssertionError(`Nieznany przypadek: ${name}`);
  }

  raw.close();
}

/* ------------------------------------------------------------------ */

const caseArg = process.argv.slice(2).find((a) => a.startsWith("--case="))?.slice(7);
const isChild = Boolean(process.env.ALFA_DB_PATH) && Boolean(caseArg);

(isChild ? runCase(caseArg!) : runParent(caseArg)).catch((err) => {
  console.error(`    ✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
