/**
 * Test raportów z podjazdów (/api/cma/podjazdy) na PRAWDZIWEJ próbce z korzenia repo,
 * na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-patrol-report.ts
 * (ścieżkę próbki można nadpisać: PATROL_SAMPLE=/ścieżka/plik.xlsx)
 *
 * Sprawdza: parser (grupowanie po „Identyfikator zdarzenia”, wykrywanie podjazdu,
 * klasyfikację kroków, anomalie), import przez trasę (upload multipart), dedup pliku
 * po hashu (409), upsert zdarzeń z nowego pliku (kroki zastąpione, ręczny obiekt
 * zachowany), dopasowanie obiektu, listę z filtrami i statystykami, szczegóły,
 * PATCH obiektu, „utwórz rozliczenie” (400 bez warunków, 201, 409), strażnika
 * uprawnień i rozpoznawanie załącznika w skanie IMAP.
 */
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { eq, inArray, like, notInArray } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import patrolEventsRoutes from "../src/routes/patrol-events.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import { parsePatrolReport, classifyStep, detectPatrolHint } from "../src/lib/patrol-report.js";
import { importPatrolReportBuffer } from "../src/utils/patrol-import.js";
import { resolveTermFor } from "../src/lib/intervention-terms.js";
import { isPatrolReportFileName } from "../src/services/cma-mail.js";
import type { User } from "../src/db/schema.js";
import type { PatrolEventDetail, PatrolEventRow } from "../src/types/index.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const SAMPLE = process.env.PATROL_SAMPLE ?? "raport_z_podjazdow_2026-10-08_07_30_276ac72a735a947.xlsx";
if (!existsSync(SAMPLE)) {
  console.error(`Brak próbki ${SAMPLE} — test wymaga prawdziwego raportu.`);
  process.exit(1);
}
const sample = readFileSync(SAMPLE);
const PREFIX = "__PATROL_TEST__";
const BASE = "/cma/podjazdy";
const REF_SOLID = "3401018790";
const REF_GROM = "3400824742";

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const plain = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin) throw new Error("Test wymaga admina w bazie");

function withPerms(user: User, permissions: Record<string, "view" | "edit"> | null): User {
  return { ...user, role: "user", permissions: permissions ? JSON.stringify(permissions) : null };
}

function makeApp(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.use("*", tabPermissionGuard);
  app.route(BASE, patrolEventsRoutes);
  return app;
}

async function call(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  // Lista to `/api/cma/podjazdy` BEZ ukośnika (Hono strict) — "/" i "/?…" mapujemy na prefiks.
  const res = await app.request(`${BASE}${path.replace(/^\/(?=\?|$)/, "")}`, init);
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

function upload(buf: Buffer, name: string): FormData {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(buf)], name));
  return fd;
}

/** Ta sama próbka z podmienioną treścią komórki (nowy hash, te same zdarzenia). */
function mutatedSample(mutate: (rows: unknown[][]) => void): Buffer {
  const wb = XLSX.read(sample, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
  mutate(rows);
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), "Worksheet");
  return XLSX.write(out, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const sampleRefs = parsePatrolReport(sample).events.map((e) => e.eventRef);

// Baza ma już prawdziwe raporty (04–15.10) — test zakłada czyste tabele podjazdów,
// więc chodzi WYŁĄCZNIE na kopii (scripts/test-on-copy.ts ustawia ALFA_DB_PATH).
if (!process.env.ALFA_DB_PATH || /(^|\/)data\/alfa\.db$/.test(process.env.ALFA_DB_PATH)) {
  console.error("Ten test czyści tabele podjazdów — uruchamiaj przez: npx tsx scripts/test-on-copy.ts scripts/test-patrol-report.ts");
  process.exit(1);
}

function cleanup() {
  // Na kopii: zdarzenia z innych raportów też usuwamy (asercje liczą całą tabelę).
  db.update(schema.patrolEvents).set({ interventionId: null }).where(notInArray(schema.patrolEvents.eventRef, sampleRefs)).run();
  db.delete(schema.patrolEvents).where(notInArray(schema.patrolEvents.eventRef, sampleRefs)).run();
  const evIds = db
    .select({ id: schema.patrolEvents.id, interventionId: schema.patrolEvents.interventionId })
    .from(schema.patrolEvents)
    .where(inArray(schema.patrolEvents.eventRef, sampleRefs))
    .all();
  const intIds = evIds.map((e) => e.interventionId).filter((x): x is number => !!x);
  if (evIds.length) db.delete(schema.patrolEvents).where(inArray(schema.patrolEvents.id, evIds.map((e) => e.id))).run();
  if (intIds.length) {
    db.delete(schema.activityLog).where(inArray(schema.activityLog.entityId, intIds)).run();
    db.delete(schema.interventions).where(inArray(schema.interventions.id, intIds)).run();
  }
  db.delete(schema.patrolReports).run();
  const companies = db
    .select({ id: schema.interventionCompanies.id })
    .from(schema.interventionCompanies)
    .where(like(schema.interventionCompanies.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (companies.length) {
    db.delete(schema.interventions).where(inArray(schema.interventions.companyId, companies)).run();
    db.delete(schema.interventionTerms).where(inArray(schema.interventionTerms.companyId, companies)).run();
    db.delete(schema.interventionCompanies).where(inArray(schema.interventionCompanies.id, companies)).run();
  }
}

async function main() {
  // --- Parser (czysta funkcja) ---
  const parsed = parsePatrolReport(sample);
  ok("parser: 6 zdarzeń z 25 wierszy", parsed.events.length === 6 && parsed.rowCount === 25, [parsed.events.length, parsed.rowCount]);
  const patrols = parsed.events.filter((e) => e.hasPatrol);
  ok("parser: 2 podjazdy", patrols.length === 2, patrols.map((e) => e.eventRef));
  const solid = parsed.events.find((e) => e.eventRef === REF_SOLID)!;
  const grom = parsed.events.find((e) => e.eventRef === REF_GROM)!;
  ok("SOLID: obiekt GLOK Plac Biały, załoga SOLID", !!solid && solid.crew === "SOLID" && solid.objectName.startsWith("GLOK WIEŻA SK Plac Biały"), solid);
  ok("GROM: obiekt ZDUNEK BMW Gdynia, załoga GROM GDAŃSK", !!grom && grom.crew === "GROM GDAŃSK" && grom.objectName === "ZDUNEK BMW Druskiennicka GDYNIA", grom?.crew);
  ok(
    "SOLID: czasy wyjazdu/odjazdu zakotwiczone przy dacie zdarzenia",
    solid.startedAt === "2026-10-08T01:00:00" && solid.departedAt === "2026-10-08T01:12:13" && solid.leftAt === "2026-10-08T01:29:29" && solid.arrivedAt === null,
    [solid.startedAt, solid.departedAt, solid.arrivedAt, solid.leftAt]
  );
  ok("SOLID: anomalia braku przyjazdu", solid.anomalies.some((a) => a.includes("Brak godziny przyjazdu")), solid.anomalies);
  ok("SOLID: 8 kroków, pierwszy start, ostatni end", solid.steps.length === 8 && solid.steps[0].kind === "start" && solid.steps[7].kind === "end", solid.steps.map((s) => s.kind));
  ok("SOLID: wielolinijkowe podsumowanie to notatka (nie dispatch)", solid.steps[4].kind === "note" && solid.steps[4].text.includes("\n"), solid.steps[4]);
  ok("SOLID: kontakt i SMS jako contact", solid.steps.filter((s) => s.kind === "contact").length === 3, solid.steps.map((s) => s.kind));
  ok("SOLID: odwołanie PI z nowym patrolem = dispatch", solid.steps[3].kind === "dispatch", solid.steps[3]);
  ok("SOLID: limit 7 min, pora noc", solid.maxTravelMin === 7 && solid.dayPart === "noc", [solid.maxTravelMin, solid.dayPart]);
  ok(
    "GROM: przyjazd przed wyjazdem oznaczony",
    grom.anomalies.some((a) => a.includes("przyjazdu (19:30:44) jest wcześniejsza niż godzina wyjazdu (19:35:40)")),
    grom.anomalies
  );
  ok("GROM: krok sprzed rozpoczęcia oznaczony", grom.anomalies.some((a) => a.includes("sprzed rozpoczęcia zdarzenia")), grom.anomalies);
  ok("GROM: ujemny czas dojazdu z raportu", grom.travelMin === -3 && grom.anomalies.some((a) => a.includes("Ujemny czas dojazdu")), [grom.travelMin, grom.anomalies]);
  ok("GROM: nie spóźniony (brak danych o spóźnieniu)", grom.late === false && grom.delayMin === null, [grom.late, grom.delayMin]);
  ok(
    "GROM: kolejność i rodzaje kroków",
    JSON.stringify(grom.steps.map((s) => s.kind)) === JSON.stringify(["dispatch", "arrived", "start", "note", "left", "end"]),
    grom.steps.map((s) => s.kind)
  );
  const aiEvent = parsed.events.find((e) => e.eventRef === "3400824005")!;
  ok("bez wyjazdu: krok Safestar AI = ai, has_patrol=0", !aiEvent.hasPatrol && aiEvent.steps[0].kind === "ai", aiEvent.steps.map((s) => s.kind));
  ok("classifyStep: Wysłano PI", classifyStep("Wysłano PI o nazwie X", "OP") === "dispatch");
  ok("isPatrolReportFileName", isPatrolReportFileName("raport_z_podjazdow_2026.xlsx") && !isPatrolReportFileName("Raport_kamer.xlsx"));
  // --- v2: rodzaj zdarzenia + podpowiedzi z notatek ---
  ok("v2: SOLID = patrol, przyjazd wg notatki 01:24", solid.eventKind === "patrol" && solid.hintArrivedAt === "2026-10-08T01:24:00" && /01:24 patrol na miejscu/.test(solid.hintText ?? ""), [solid.eventKind, solid.hintArrivedAt, solid.hintText]);
  ok("v2: GROM = patrol bez podpowiedzi (ma przyjazd)", grom.eventKind === "patrol" && grom.hintArrivedAt === null, [grom.eventKind, grom.hintArrivedAt]);
  ok("v2: zdarzenia bez wyjazdu w próbce = alarm", parsed.events.filter((e) => !e.hasPatrol).every((e) => e.eventKind === "alarm"), parsed.events.map((e) => [e.eventRef, e.eventKind]));
  {
    // Podmieniamy treść kroków dwóch zdarzeń bez wyjazdu: wideopatrol AI i notatka o patrolu GROM.
    const REF_VIDEO = "3400809526";
    const REF_HINT = "3400824745";
    const hdr = (rows: unknown[][]) => {
      const h = rows[0].map((x) => String(x));
      return { ref: h.indexOf("Identyfikator zdarzenia"), text: h.indexOf("Obsługa"), user: h.indexOf("Użytkownik") };
    };
    const kinds = parsePatrolReport(
      mutatedSample((rows) => {
        const c = hdr(rows);
        for (const r of rows.slice(1)) {
          if (String(r[c.ref]) === REF_VIDEO) {
            r[c.text] = "Safestar AI: Rozpoczęcie automatycznego wideopatrolu.";
            r[c.user] = "(system)";
          }
        }
        const idx = rows.findIndex((r) => String(r[c.ref]) === REF_HINT);
        const note = [...rows[idx]];
        note[c.user] = "OPERATOR 102"; // kopia wiersza AI miałaby operatora (system)
        note[c.text] = "BMW Gdynia\n19:20 alarm strefa 2 - wysłano patrol GROM.\n19:41 Załoga pod obiektem, bez uwag. 19:50 Odwołanie patrolu.";
        rows.splice(idx + 1, 0, note);
      })
    ).events;
    const video = kinds.find((e) => e.eventRef === REF_VIDEO)!;
    const hinted = kinds.find((e) => e.eventRef === REF_HINT)!;
    ok("v2: wideopatrol AI → video_patrol (bez podpowiedzi)", video.eventKind === "video_patrol" && !video.hasPatrol && video.hintText === null, [video.eventKind, video.hintText]);
    ok(
      "v2: notatka „wysłano patrol GROM” → patrol_hint, załoga GROM, przyjazd 19:41",
      hinted.eventKind === "patrol_hint" && !hinted.hasPatrol && hinted.hintCrew === "GROM" && hinted.hintArrivedAt?.endsWith("T19:41:00") === true && /wysłano patrol GROM/.test(hinted.hintText ?? ""),
      [hinted.eventKind, hinted.hintCrew, hinted.hintArrivedAt, hinted.hintText]
    );
  }
  const noHint = (text: string, kind: "note" | "contact" | "ai" = "note") => !detectPatrolHint([{ kind, text, at: null }], null).mentioned;
  ok("v2: „automatyczny wideopatrol” w notatce to nie podjazd", noHint("Rozpoczęto automatyczny wideopatrol, nie stwierdzono nieprawidłowości"));
  ok("v2: krok AI „Patrol interwencyjny … - na miejscu” pomijany", noHint("Patrol interwencyjny PATROL KONSALNET - na miejscu", "ai"));
  ok("v2: „Zakończenie … w trybie: 07 - WYSŁANIE -PATROL” pomijane", !detectPatrolHint([{ kind: "end", text: "Zakończenie obsługi zdarzenia w trybie: 07 - WYSŁANIE -PATROL", at: null }], null).mentioned);
  ok("v2: zwykły kontakt bez patrolu", noHint('Podjęto próbę skontaktowania z osobą "Solid (nr obiektu 10456655)"', "contact"));
  ok(
    "v2: SMS z treścią „wysłano patrol SOLID (aplikacja)” → załoga SOLID",
    detectPatrolHint([{ kind: "contact", text: 'Wysłano SMS "15:23 intruz - wysłano patrol SOLID (aplikacja) | 16:04 patrol na miejscu" na numer "570707709"', at: "2026-10-04T16:14:02" }], "2026-10-04T15:35:58").crew === "SOLID"
  );

  try {
    parsePatrolReport(mutatedSample((rows) => (rows[0] = rows[0].map(() => "X"))));
    ok("parser: plik bez nagłówków odrzucony", false);
  } catch (e) {
    ok("parser: plik bez nagłówków odrzucony", e instanceof Error && e.name === "PatrolParseError", String(e));
  }

  // --- Uprawnienia ---
  if (plain) {
    const none = await call(makeApp(withPerms(plain, {})), "GET", "/");
    ok("bez klucza cma/podjazdy → 403", none.status === 403, none.status);
    const viewer = await call(makeApp(withPerms(plain, { "cma/podjazdy": "view" })), "POST", "/import", upload(sample, "raport_z_podjazdow_x.xlsx"));
    ok("view nie może wgrać raportu → 403", viewer.status === 403, viewer.status);
    const ro = await call(makeApp(withPerms(plain, { "cma/podjazdy": "view" })), "GET", "/");
    ok("view czyta listę", ro.status === 200, ro.status);
  }

  const app = makeApp(admin);

  // --- Import ---
  const imp = await call(app, "POST", "/import", upload(sample, SAMPLE.split("/").pop()!));
  ok(
    "import: 201, 6 zdarzeń nowych, 2 podjazdy",
    imp.status === 201 && imp.json?.data?.eventsTotal === 6 && imp.json.data.eventsNew === 6 && imp.json.data.patrols === 2,
    imp.json
  );
  const dup = await call(app, "POST", "/import", upload(sample, "raport_z_podjazdow_kopia.xlsx"));
  ok("ten sam plik drugi raz → 409", dup.status === 409 && dup.json?.data?.reportId === imp.json?.data?.reportId, dup.json);
  const forced = importPatrolReportBuffer(sample, "raport_z_podjazdow_force.xlsx", { source: "upload", force: true });
  ok(
    "v2: force — ten sam plik przeliczony, ten sam raport, 6 zaktualizowanych",
    forced.reportId === imp.json?.data?.reportId && forced.eventsNew === 0 && forced.eventsUpdated === 6,
    forced
  );
  const bad = await call(app, "POST", "/import", upload(Buffer.from("x"), "notatki.txt"));
  ok("zły format → 400", bad.status === 400, bad.json);

  // --- Lista ---
  const list = await call(app, "GET", "/?from=2026-10-07&to=2026-10-08");
  const items = (list.json?.data?.items ?? []) as PatrolEventRow[];
  ok("lista domyślnie: tylko 2 podjazdy", list.status === 200 && list.json.data.total === 2 && items.length === 2, list.json?.data?.total);
  ok("lista: sort started_at desc (SOLID pierwszy)", items[0]?.eventRef === REF_SOLID, items.map((i) => i.eventRef));
  ok("lista: anomalies jako tablica", Array.isArray(items[0]?.anomalies) && items[0].anomalies.length > 0);
  ok(
    "lista: statystyki załóg",
    list.json?.data?.stats?.crews?.length === 2 && list.json.data.stats.count === 2,
    list.json?.data?.stats
  );
  const all = await call(app, "GET", "/?from=2026-10-07&to=2026-10-08&withoutPatrol=1");
  ok("withoutPatrol=1 → 6 zdarzeń", all.json?.data?.total === 6, all.json?.data?.total);
  const byCrew = await call(app, "GET", `/?crew=${encodeURIComponent("GROM GDAŃSK")}`);
  ok("filtr załogi", byCrew.json?.data?.total === 1 && byCrew.json.data.items[0].eventRef === REF_GROM, byCrew.json?.data?.total);
  const q = await call(app, "GET", "/?q=zdunek&withoutPatrol=1");
  ok("szukajka po nazwie obiektu", q.json?.data?.total === 5, q.json?.data?.total);
  const bySort = await call(app, "GET", "/?sort=objectName&dir=asc");
  ok("sort po nazwie obiektu asc", bySort.json?.data?.items?.[0]?.eventRef === REF_SOLID, bySort.json?.data?.items?.map((i: PatrolEventRow) => i.eventRef));
  ok(
    "v2: stats.byKind (bez filtra kind) i domyślnie patrol+patrol_hint",
    JSON.stringify(list.json?.data?.stats?.byKind) === JSON.stringify({ patrol: 2, patrol_hint: 0, video_patrol: 0, alarm: 4 }),
    list.json?.data?.stats?.byKind
  );
  ok("v2: wiersz ma eventKind i hintArrivedAt", items.find((i) => i.eventRef === REF_SOLID)?.eventKind === "patrol" && items.find((i) => i.eventRef === REF_SOLID)?.hintArrivedAt === "2026-10-08T01:24:00", items[0]);
  const alarms = await call(app, "GET", "/?from=2026-10-07&to=2026-10-08&kind=alarm");
  ok("v2: kind=alarm → 4", alarms.json?.data?.total === 4 && alarms.json.data.items.every((i: PatrolEventRow) => i.eventKind === "alarm"), alarms.json?.data?.total);
  const kindAll = await call(app, "GET", "/?from=2026-10-07&to=2026-10-08&kind=patrol,alarm");
  ok("v2: kind=patrol,alarm → 6", kindAll.json?.data?.total === 6, kindAll.json?.data?.total);
  ok("v2: zły kind → 400", (await call(app, "GET", "/?kind=bogus")).status === 400);
  const badSort = await call(app, "GET", "/?sort=drop");
  ok("zły sort → 400", badSort.status === 400);
  const page2 = await call(app, "GET", "/?withoutPatrol=1&from=2026-10-07&to=2026-10-08&pageSize=2&page=3");
  ok("paginacja: strona 3 z 2 → 2 wiersze, total 6", page2.json?.data?.items?.length === 2 && page2.json.data.total === 6, page2.json?.data);

  // --- Dopasowanie obiektu ---
  const solidRow = items.find((i) => i.eventRef === REF_SOLID)!;
  const gromRow = items.find((i) => i.eventRef === REF_GROM)!;
  const expectedSolid = db
    .select({ objectId: schema.monitoredObjects.objectId })
    .from(schema.monitoredObjects)
    .where(eq(schema.monitoredObjects.name, solid.objectName))
    .get()?.objectId;
  if (expectedSolid) {
    ok("dopasowanie SOLID przez rejestr monitoringu", solidRow.objectId === expectedSolid, [solidRow.objectId, expectedSolid]);
  } else {
    console.log("--   (kopia bazy bez rejestru monitoringu dla GLOK Plac Biały — pomijam asercję dopasowania)");
  }
  ok("dopasowanie GROM (ZDUNEK BMW Gdynia)", gromRow.objectId !== null && /ZDUNEK BMW/i.test(gromRow.linkedObjectName ?? ""), [gromRow.objectId, gromRow.linkedObjectName]);
  const unmatched = await call(app, "GET", "/?matched=no");
  ok("matched=no: brak niedopasowanych podjazdów", unmatched.json?.data?.total === 0, unmatched.json?.data?.total);

  // --- Szczegóły ---
  const det = await call(app, "GET", `/${gromRow.id}`);
  const d = det.json?.data as PatrolEventDetail;
  ok("szczegóły: 6 kroków po seq, raport z nazwą pliku", det.status === 200 && d.steps.length === 6 && d.steps[0].seq === 0 && !!d.report?.fileName, d?.steps?.length);
  ok("szczegóły: object {id,name}", d.object?.id === gromRow.objectId && !!d.object?.name, d.object);
  ok("szczegóły 404", (await call(app, "GET", "/999999999")).status === 404);
  {
    // related: te same obiekt, ±90 min, bez siebie, najbliższe pierwsze
    const startMs = (iso: string) => Date.parse(`${iso}Z`);
    const expected = parsed.events
      .filter((e) => e.eventRef !== REF_GROM && e.objectName === grom.objectName && e.startedAt && Math.abs(startMs(e.startedAt) - startMs(grom.startedAt!)) <= 90 * 60000)
      .map((e) => e.eventRef)
      .sort();
    const rel = d.related ?? [];
    const offs = rel.map((r) => Math.abs(r.offsetMin ?? 999));
    ok(
      `v2: related GROM = ${expected.length} zdarzeń tego obiektu ±90 min, posortowane po odległości`,
      expected.length > 0 && JSON.stringify(rel.map((r) => r.eventRef).sort()) === JSON.stringify(expected) && offs.every((o, i) => i === 0 || o >= offs[i - 1]) && rel.every((r) => r.id !== d.id && typeof r.stepsCount === "number" && r.stepsCount > 0),
      [expected, rel]
    );
    const solidDet = (await call(app, "GET", `/${solidRow.id}`)).json?.data as PatrolEventDetail;
    ok("v2: related SOLID = brak (jedyne zdarzenie obiektu)", Array.isArray(solidDet.related) && solidDet.related.length === 0, solidDet.related);
  }

  // --- Ręczne przypisanie obiektu i upsert z kolejnego raportu ---
  const otherObject = db.select({ id: schema.objects.id }).from(schema.objects).where(eq(schema.objects.id, solidRow.objectId ?? -1)).get()
    ?? db.select({ id: schema.objects.id }).from(schema.objects).limit(1).get()!;
  const patch = await call(app, "PATCH", `/${gromRow.id}`, { objectId: otherObject.id });
  ok("PATCH objectId", patch.status === 200 && patch.json?.data?.objectId === otherObject.id, patch.json);
  ok("PATCH zły obiekt → 400", (await call(app, "PATCH", `/${gromRow.id}`, { objectId: 999999999 })).status === 400);

  const v2 = mutatedSample((rows) => {
    // dopisany krok do zdarzenia GROM (kopia ostatniego wiersza z inną treścią)
    const idx = rows.findIndex((r) => String(r[33]) === REF_GROM && String(r[19]).startsWith("Brak osób trzecich"));
    const copy = [...rows[idx]];
    copy[18] = "19:41:30";
    copy[19] = "Poinformowano klienta telefonicznie";
    rows.splice(idx + 1, 0, copy);
  });
  const imp2 = await call(app, "POST", "/import", upload(v2, "raport_z_podjazdow_2026-10-08_08_00_v2.xlsx"));
  ok("drugi raport (te same zdarzenia): 0 nowych, 6 zaktualizowanych", imp2.status === 201 && imp2.json?.data?.eventsNew === 0 && imp2.json.data.eventsUpdated === 6, imp2.json);
  const det2 = (await call(app, "GET", `/${gromRow.id}`)).json?.data as PatrolEventDetail;
  ok("upsert: kroki zastąpione (7, bez duplikatów)", det2.steps.length === 7, det2.steps.length);
  ok("upsert: ręcznie przypisany obiekt zachowany", det2.objectId === otherObject.id, det2.objectId);
  ok("upsert: report_id wskazuje nowy raport", det2.reportId === imp2.json?.data?.reportId, [det2.reportId, imp2.json?.data?.reportId]);
  const stepCount = db.select().from(schema.patrolEventSteps).where(eq(schema.patrolEventSteps.eventId, gromRow.id)).all().length;
  ok("upsert: w bazie 7 kroków", stepCount === 7, stepCount);
  // przywróć dopasowanie
  await call(app, "PATCH", `/${gromRow.id}`, { objectId: gromRow.objectId });

  // --- Raporty / status poczty ---
  const reps = await call(app, "GET", "/reports");
  ok("GET /reports: 2 importy", reps.json?.data?.items?.filter((r: any) => r.fileName.startsWith("raport_z_podjazdow")).length === 2, reps.json?.data?.items?.length);
  const ms = await call(app, "GET", "/mail-status");
  ok("GET /mail-status", ms.status === 200 && "lastCheckAt" in ms.json.data && Array.isArray(ms.json.data.recent), ms.json);

  // --- Rozliczenie ---
  const noObj = await call(app, "PATCH", `/${solidRow.id}`, { objectId: null });
  ok("PATCH objectId=null", noObj.status === 200 && noObj.json.data.objectId === null);
  const needObj = await call(app, "POST", `/${solidRow.id}/intervention`);
  ok("rozliczenie bez obiektu → 400", needObj.status === 400, needObj.json);
  await call(app, "PATCH", `/${solidRow.id}`, { objectId: solidRow.objectId });
  const bez = (await call(app, "GET", "/?withoutPatrol=1&q=3400824005")).json.data.items[0] as PatrolEventRow;
  ok("rozliczenie zdarzenia bez wyjazdu → 400", (await call(app, "POST", `/${bez.id}/intervention`)).status === 400);

  const objectId = gromRow.objectId!;
  const day = "2026-10-07";
  if (!resolveTermFor(objectId, day)) {
    const noTerms = await call(app, "POST", `/${gromRow.id}/intervention`);
    ok("rozliczenie bez warunków → 400 z komunikatem", noTerms.status === 400 && /warunków/.test(noTerms.json?.error ?? ""), noTerms.json);
    const company = db.insert(schema.interventionCompanies).values({ name: `${PREFIX} Grom` }).returning().get();
    db.insert(schema.interventionTerms)
      .values({ objectId, companyId: company.id, startDate: "2026-10-01", endDate: "2026-10-31", calloutFee: 150 })
      .run();
  }
  const created = await call(app, "POST", `/${gromRow.id}/intervention`);
  ok("rozliczenie → 201 + interventionId", created.status === 201 && !!created.json?.data?.interventionId, created.json);
  const intv = db.select().from(schema.interventions).where(eq(schema.interventions.id, created.json?.data?.interventionId ?? -1)).get();
  ok(
    "interwencja: happenedAt = przyjazd, reason = alarm",
    intv?.happenedAt === "2026-10-07T19:30" && (intv?.reason ?? "").startsWith("Alarm włamaniowy") && intv?.objectId === objectId,
    intv
  );
  ok("drugie rozliczenie → 409", (await call(app, "POST", `/${gromRow.id}/intervention`)).status === 409);
  const lockObj = await call(app, "PATCH", `/${gromRow.id}`, { objectId: otherObject.id === objectId ? null : otherObject.id });
  ok("zmiana obiektu po rozliczeniu → 409", lockObj.status === 409, lockObj.json);
}

cleanup();
try {
  await main();
} catch (e) {
  failures++;
  console.error("WYJĄTEK:", e);
} finally {
  cleanup();
}
console.log(failures === 0 ? "\nWszystkie asercje OK." : `\n${failures} asercji nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
