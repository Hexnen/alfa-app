/**
 * Test ustawień poczty dla raportów z podjazdów (docs/PODJAZDY-RAPORTY.md,
 * „Ustawienia podjazdów — stan”), na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-patrol-mail-settings.ts
 *
 * Bez połączenia ze skrzynką: na kopii czyścimy adres i hasło, więc poller się
 * nie uruchamia, a „Sprawdź skrzynkę”/„Pobierz teraz” kończą się błędem
 * konfiguracji. Logika dopasowania (foldery, temat, nadawca, załącznik) jest
 * sprawdzana na atrapach wiadomości.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import cmaMailRoutes from "../src/routes/cma-mail.js";
import {
  attachmentNamesFromStructure,
  buildScanConfig,
  classifyScanMessage,
  clampLookbackDays,
  isPatrolAttachmentName,
  isPatrolMessageImported,
  patrolFolderList,
  scanFolders,
} from "../src/services/cma-mail.js";
import type { CmaMailSettings } from "../src/db/schema.js";

if (!process.env.ALFA_DB_PATH) {
  console.error("Uruchamiaj przez scripts/test-on-copy.ts (test zmienia ustawienia poczty).");
  process.exit(1);
}

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// Kopia ma prawdziwe dane logowania — usuwamy je, zanim cokolwiek zapisze ustawienia
// (saveSettings restartuje poller; bez adresu/hasła poller się nie włącza).
db.update(schema.cmaMailSettings)
  .set({ email: null, password: null })
  .where(eq(schema.cmaMailSettings.id, 1))
  .run();

// --- 1. Migracja 0116: kolumny i wartości domyślne -------------------------
const row = db.select().from(schema.cmaMailSettings).where(eq(schema.cmaMailSettings.id, 1)).get() as
  | CmaMailSettings
  | undefined;
ok("wiersz ustawień istnieje", Boolean(row));
ok("patrolEnabled domyślnie true", row?.patrolEnabled === true, row?.patrolEnabled);
ok("patrolFolder domyślnie ''", row?.patrolFolder === "", row?.patrolFolder);
ok("patrolLookbackDays domyślnie 30", row?.patrolLookbackDays === 30, row?.patrolLookbackDays);

// --- 2. Czyste funkcje ----------------------------------------------------
ok(
  "patrolFolderList: puste = foldery kamer",
  JSON.stringify(patrolFolderList({ folder: "INBOX, INBOX.Safestar", patrolFolder: "" })) ===
    JSON.stringify(["INBOX", "INBOX.Safestar"])
);
ok(
  "patrolFolderList: własna lista, bez duplikatów",
  JSON.stringify(patrolFolderList({ folder: "INBOX", patrolFolder: " INBOX.Podjazdy ,INBOX.Podjazdy, Archiwum" })) ===
    JSON.stringify(["INBOX.Podjazdy", "Archiwum"])
);
ok("załącznik raport_z_podjazdow_*.xlsx", isPatrolAttachmentName("raport_z_podjazdow_2026-10-08_07_30_276ac.xlsx"));
ok("załącznik RAPORT_Z_PODJAZDOW.XLS", isPatrolAttachmentName("RAPORT_Z_PODJAZDOW.XLS"));
ok("nie: raport kamer xlsx", !isPatrolAttachmentName("Raport_z_kamer.xlsx"));
ok("nie: raport_z_podjazdow.pdf", !isPatrolAttachmentName("raport_z_podjazdow_2026.pdf"));

const structure = {
  type: "multipart/mixed",
  childNodes: [
    { type: "text/plain", parameters: { charset: "utf-8" } },
    {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      disposition: "attachment",
      dispositionParameters: { filename: "raport_z_podjazdow_2026-10-15_07_30_x.xlsx" },
    },
    { type: "multipart/alternative", childNodes: [{ type: "image/png", parameters: { name: "logo.png" } }] },
  ],
};
ok(
  "attachmentNamesFromStructure: zagnieżdżone części i name z Content-Type",
  JSON.stringify(attachmentNamesFromStructure(structure)) ===
    JSON.stringify(["raport_z_podjazdow_2026-10-15_07_30_x.xlsx", "logo.png"]),
  attachmentNamesFromStructure(structure)
);
ok("attachmentNamesFromStructure: brak struktury", attachmentNamesFromStructure(undefined).length === 0);
ok("clampLookbackDays", clampLookbackDays("7") === 7 && clampLookbackDays(0) === 30 && clampLookbackDays(999) === 365 && clampLookbackDays("x", 14) === 14);

// Konfiguracja jak na produkcji: kamery z filtrem Safestar, podjazdy z własnym.
const base = {
  importEnabled: true,
  folder: "INBOX",
  subjectFilter: "Raport z przeglądu kamer, Raport z kamer (codzienny-app)",
  fromFilter: "safestar",
  patrolEnabled: true,
  patrolFolder: "",
  patrolSubjectFilter: null as string | null,
  patrolFromFilter: null as string | null,
};
const PATROL_FILE = ["raport_z_podjazdow_2026-10-15_07_30_266ad064f205772.xlsx"];
const patrolMail = {
  folder: "INBOX",
  subject: "Raport z podjazdów 15.10.2026",
  from: [{ name: "System monitoringu", address: "raporty@konsalnet.pl" }],
  attachmentNames: PATROL_FILE,
};
const cameraMail = {
  folder: "INBOX",
  subject: "Raport z przeglądu kamer 15.10",
  from: [{ name: "Safestar", address: "noreply@safestar.pl" }],
  attachmentNames: ["raport.xlsx"],
};

let cfg = buildScanConfig(base);
let r = classifyScanMessage(patrolMail, cfg);
ok("podjazdy: inny temat i nadawca niż kamery → potok podjazdów", r.patrol && !r.camera, r);
r = classifyScanMessage(cameraMail, cfg);
ok("kamery: bez zmian, nie podjazdy", r.camera && !r.patrol, r);
r = classifyScanMessage({ ...patrolMail, attachmentNames: ["inny.xlsx"] }, cfg);
ok("bez załącznika raport_z_podjazd* → nic (puste filtry podjazdów nie łapią każdego maila)", !r.patrol && !r.camera, r);
r = classifyScanMessage({ ...cameraMail, attachmentNames: PATROL_FILE }, buildScanConfig({ ...base, patrolSubjectFilter: "podjazd" }));
ok("mail kamer z raportem podjazdów, ale temat nie pasuje do podjazdów → tylko kamery", r.camera && !r.patrol, r);

cfg = buildScanConfig({ ...base, patrolSubjectFilter: "podjazd, wyjazdy", patrolFromFilter: "KONSALNET" });
ok("filtr tematu (OR, bez wielkości liter) + nadawcy", classifyScanMessage(patrolMail, cfg).patrol);
ok(
  "filtr tematu nie pasuje",
  !classifyScanMessage({ ...patrolMail, subject: "Zestawienie dzienne" }, cfg).patrol
);
ok(
  "filtr nadawcy nie pasuje",
  !classifyScanMessage({ ...patrolMail, from: [{ address: "ktos@gmail.com" }] }, cfg).patrol
);
ok("filtr nadawcy po nazwie wyświetlanej", classifyScanMessage({ ...patrolMail, from: [{ name: "Konsalnet raporty", address: "x@y.pl" }] }, cfg).patrol);

cfg = buildScanConfig({ ...base, patrolFolder: "INBOX.Podjazdy" });
ok("własny folder: mail w INBOX nie jest podjazdem", !classifyScanMessage(patrolMail, cfg).patrol);
ok("własny folder: mail w INBOX.Podjazdy jest", classifyScanMessage({ ...patrolMail, folder: "INBOX.Podjazdy" }, cfg).patrol);
ok("scanFolders = suma bez duplikatów", JSON.stringify(scanFolders(cfg)) === JSON.stringify(["INBOX", "INBOX.Podjazdy"]), scanFolders(cfg));

cfg = buildScanConfig({ ...base, patrolEnabled: false });
ok("podjazdy wyłączone", !classifyScanMessage(patrolMail, cfg).patrol);
cfg = buildScanConfig({ ...base, importEnabled: false, patrolFolder: "Podjazdy" });
ok("kamery wyłączone: skan tylko folderów podjazdów", JSON.stringify(scanFolders(cfg)) === JSON.stringify(["Podjazdy"]), scanFolders(cfg));
ok("kamery wyłączone: mail kamer nie pasuje", !classifyScanMessage(cameraMail, cfg).camera);

const keys = { messageIds: new Set(["<abc@mail>"]), fileNames: new Set([PATROL_FILE[0].toLowerCase()]) };
ok("już zaimportowany po Message-ID", isPatrolMessageImported("<abc@mail>", ["x.xlsx"], keys));
ok("już zaimportowany po nazwie pliku", isPatrolMessageImported(null, PATROL_FILE, keys));
ok("nowy", !isPatrolMessageImported("<new@mail>", ["raport_z_podjazdow_2026-10-16.xlsx"], keys));

// --- 3. Trasy: zapis ustawień, walidacja, brak hasła w odpowiedzi ---------
const app = new Hono();
app.route("/cma/mail", cmaMailRoutes);
const put = (body: unknown) =>
  app.request("/cma/mail/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let res = await put({
  patrolEnabled: false,
  patrolFolder: " INBOX.Podjazdy , ,INBOX.Podjazdy,Archiwum ",
  patrolSubjectFilter: "Raport z podjazdów,  , podjazdy ",
  patrolFromFilter: "  konsalnet ",
  patrolLookbackDays: 14,
  password: "sekret-testowy",
});
let json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
ok("PUT /settings 200", res.status === 200, json);
ok("patrolEnabled zapisane", json.data?.patrolEnabled === false, json.data);
ok("patrolFolder znormalizowany", json.data?.patrolFolder === "INBOX.Podjazdy, Archiwum", json.data?.patrolFolder);
ok("patrolSubjectFilter znormalizowany", json.data?.patrolSubjectFilter === "Raport z podjazdów, podjazdy", json.data?.patrolSubjectFilter);
ok("patrolFromFilter przycięty", json.data?.patrolFromFilter === "konsalnet", json.data?.patrolFromFilter);
ok("patrolLookbackDays zapisane", json.data?.patrolLookbackDays === 14);
ok("hasło nie wraca w odpowiedzi", !("password" in (json.data ?? {})) && !JSON.stringify(json).includes("sekret-testowy"));
ok("hasPassword = true", json.data?.hasPassword === true);
ok("filtry kamer nietknięte", json.data?.subjectFilter === row?.subjectFilter && json.data?.folder === row?.folder);

res = await put({ patrolFolder: "", patrolSubjectFilter: "", patrolFromFilter: "" });
json = (await res.json()) as typeof json;
ok("puste pola podjazdów → '' / null", json.data?.patrolFolder === "" && json.data?.patrolSubjectFilter === null && json.data?.patrolFromFilter === null, json.data);

res = await put({ patrolLookbackDays: 0 });
ok("patrolLookbackDays 0 → 400", res.status === 400);
res = await put({ patrolLookbackDays: 400 });
ok("patrolLookbackDays 400 → 400", res.status === 400);

const getRes = await app.request("/cma/mail/settings");
const getJson = (await getRes.json()) as { data: Record<string, unknown> };
ok("GET /settings bez hasła, z polami podjazdów", !("password" in getJson.data) && "patrolLookbackDays" in getJson.data && "patrolLastCheckAt" in getJson.data);

// Bez danych logowania: podgląd i pobieranie odmawiają bez łączenia się ze skrzynką.
db.update(schema.cmaMailSettings).set({ password: null }).where(eq(schema.cmaMailSettings.id, 1)).run();
res = await app.request("/cma/mail/patrol-preview", { method: "POST", body: JSON.stringify({ days: 7 }), headers: { "content-type": "application/json" } });
json = (await res.json()) as typeof json;
ok("patrol-preview bez konfiguracji → 400 z komunikatem", res.status === 400 && /Brak konfiguracji/.test(String((json as unknown as { error: string }).error)), json);
res = await app.request("/cma/mail/patrol-fetch", { method: "POST" });
ok("patrol-fetch bez konfiguracji → 400", res.status === 400);

res = await app.request("/cma/mail/patrol-status");
const st = (await res.json()) as { success: boolean; data: { lastReport: unknown; recent: unknown[] } };
ok("GET /patrol-status", res.status === 200 && st.success && Array.isArray(st.data.recent), st);

console.log(failures === 0 ? "\nWszystkie asercje OK" : `\n${failures} asercji nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
