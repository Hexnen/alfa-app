/**
 * Uzupełnienie kartoteki po imporcie bazy obiektowej (wrzesień 2026):
 *   npx tsx scripts/uzupelnij-kartoteke.ts                    # suchy przebieg — raport, nic nie zapisuje
 *   npx tsx scripts/uzupelnij-kartoteke.ts --apply            # zapis, wszystko w JEDNEJ transakcji
 *   npx tsx scripts/uzupelnij-kartoteke.ts --report=<plik.md> # gdzie zapisać raport
 *
 * Honoruje ALFA_DB_PATH (src/db/index.ts) — pierwsze przebiegi rób na kopii bazy.
 * Skrypt jest IDEMPOTENTNY: dotyka wyłącznie pól pustych (objects.monthly_zdw i monthly_ofi IS NULL,
 * objects.company_id IS NULL, hr_objects.object_id IS NULL, brakujące wiersze `companies`),
 * więc drugi przebieg nie ma już czego zmieniać.
 *
 * CO ROBI I SKĄD BIERZE DANE
 * 1. ABONAMENTY OFI Z WPŁYWÓW BANKOWYCH. Aktywne posterunki OFI bez ceny dostają abonament
 *    wyliczony z majowej wpłaty klienta (arkusz „Wszystkie transakcje” w
 *    obiekty/Finanse AlfaGroup/AlfaGroup_analiza_przeplywow_maj2026.xlsx; Kwota > 0,
 *    Kategoria ZEWNĘTRZNY). Kwoty na wyciągu są BRUTTO, więc netto = brutto / 1,23.
 *    Nazwa płatnika bywa ucięta w połowie słowa, więc dopasowanie idzie po prefiksie
 *    znormalizowanej nazwy. Zapisujemy tylko przy PEWNYM dopasowaniu (patrz `matchIncoming`) —
 *    reszta ląduje w raporcie, bo zła cena abonamentu jest gorsza niż brak ceny.
 * 2. ROZDZIELENIE FAKTUROWANIA ZBIORCZEGO. Pozycje z scripts/data/mapowanie-obiektow/faktury.json,
 *    które obejmują kilka obiektów naraz („AGENCJA OCHRONY GLOK”, „SAFETOWER NOW-BUD WIEŻE”),
 *    dzielimy między obiekty tej pozycji, które ceny jeszcze nie mają.
 * 3. SŁOWNIK SPÓŁEK. Spółki komandytowe z arkusza SK, których nie ma w `companies`, powiązanie
 *    obiekt → spółka po tej samej regule co import (sk.json/hr.json) i mapowania kadrowe.
 *
 * CZEGO NIE ROBI. Nie nadpisuje niczego, co już ma wartość (użytkownik mógł to poprawić
 * w aplikacji), nie zgaduje przy niejednoznacznym dopasowaniu i nie rusza kolumn
 * contractors.contact_person / phone / email (uzupełnia je osobny skrypt).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db, schema } from "../src/db/index.js";
import { isMfError, lookupCompanyByNip } from "../src/lib/mf-whitelist.js";
import { monthlyValueOf, splitAbonament } from "../src/lib/abonament-split.js";
import { normalizeNIP, validateNIP } from "../src/utils/nip.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = join(ROOT, "scripts", "data", "mapowanie-obiektow");
const CASHFLOW_XLSX = join(ROOT, "obiekty", "Finanse AlfaGroup", "AlfaGroup_analiza_przeplywow_maj2026.xlsx");

const apply = process.argv.includes("--apply");
const noMf = process.argv.includes("--no-mf");
const reportArg = process.argv.find((a) => a.startsWith("--report="));
const REPORT_PATH = reportArg ? reportArg.slice("--report=".length) : join(ROOT, "obiekty", "RAPORT-uzupelnienie.md");
const TODAY = new Date().toISOString().slice(0, 10);
const VAT = 1.23;

const out: string[] = [];
function say(line = "") {
  console.log(line);
  out.push(line);
}

// ---------------------------------------------------------------------------
// Normalizacja nazw
// ---------------------------------------------------------------------------
/** Wielkie litery bez ogonków, bez interpunkcji — do porównań „to ta sama firma”. */
function squash(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[łŁ]/g, "L")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Formy prawne i skróty wspólnot z wyciągu bankowego sprowadzone do jednej postaci.
 * Bank tnie nazwę po ~38 znakach i zapisuje ją byle jak („WSP.MIESZKANIOWA”,
 * „WSPÓLNOTA MIESZK.”, „SP.ZO.O”), a w kartotece stoi pełna nazwa z KRS — bez tego
 * kroku prefiks nigdy by się nie zgodził.
 */
function nameKey(s: string | null | undefined): string {
  let k = squash(s);
  k = k.replace(/SPOLKAZOGRANICZONAODPOWIEDZIALNOSCIA|SPOLKAZOGRANICZONAODPWIEDZ|SPZOO|SPZOOO|SPOLKAZOG|SPOLKAZO|SPOLKAZ/g, "");
  k = k.replace(/SPOLKAKOMANDYTOWA|SPKOMANDYTOWA|SPK/g, "");
  k = k.replace(/SPOLKAAKCYJNA|SA$/g, "");
  // Wspólnota mieszkaniowa w kilkunastu zapisach z wyciągu.
  k = k.replace(/^WSPOLNOTAMIESZKANIOWA|^WSPOLNOTAMIESZK|^WSPMIESZKANIOWA|^WSPMIESZK|^WM/, "");
  return k;
}

/** Dopasowanie „ucięta nazwa z przelewu” ↔ „pełna nazwa z kartoteki”. */
function prefixMatch(a: string, b: string, min = 8): boolean {
  if (a.length < min || b.length < min) return false;
  return a.startsWith(b) || b.startsWith(a);
}

// ---------------------------------------------------------------------------
// Wejście: wpływy bankowe
// ---------------------------------------------------------------------------
interface Incoming {
  date: string;
  amount: number;
  payer: string;
  invoice: string;
  account: string;
  key: string;
}

/** Wpłaty, które nie są zapłatą za usługę (dofinansowania, zwroty z US). */
const NOT_A_SALE = /^PANSTWOWYFUNDUSZREHABILITACJI|^TI|^VAT|^SFP|^OKR/;

function loadIncoming(): Incoming[] {
  if (!existsSync(CASHFLOW_XLSX)) {
    say(`! Brak pliku wpływów: ${CASHFLOW_XLSX} — punkt 1 pominięty.`);
    return [];
  }
  const wb = XLSX.read(readFileSync(CASHFLOW_XLSX));
  const sheet = wb.Sheets["Wszystkie transakcje"];
  if (!sheet) {
    say("! Arkusz „Wszystkie transakcje” nie istnieje — punkt 1 pominięty.");
    return [];
  }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  const list: Incoming[] = [];
  for (const r of rows) {
    const amount = Number(r["Kwota"]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (String(r["Kategoria"] ?? "").trim().toUpperCase() !== "ZEWNĘTRZNY") continue;
    const payer = String(r["Kontrahent"] ?? "").trim();
    if (!payer) continue;
    const key = nameKey(payer);
    if (!key || NOT_A_SALE.test(squash(payer))) continue;
    list.push({
      date: String(r["Data"] ?? "").trim(),
      amount,
      payer,
      invoice: String(r["Faktura"] ?? "").trim(),
      account: String(r["Konto/spółka"] ?? "").trim(),
      key,
    });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Wejście: mapowania
// ---------------------------------------------------------------------------
function readJson<T>(file: string): T | null {
  const path = join(MAP, file);
  if (!existsSync(path)) {
    say(`! Brak pliku mapowania ${file} — powiązana sekcja pominięta.`);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface InvoiceRow {
  sheet?: string | null;
  row?: number;
  flag?: string | null;
  client?: string | null;
  netto?: number | string | null;
  cmaExternalIds?: number[] | null;
}
interface SkDecision {
  company: string;
  objectName: string | null;
  decision: string;
  hrObject: string | null;
  cmaExternalId: number | null;
}
interface HrDecision {
  hrName: string;
  decision: string;
  cmaExternalId: number | null;
  skCompany: string | null;
}

const invoices = readJson<InvoiceRow[]>("faktury.json") ?? [];
const skRows = readJson<SkDecision[]>("sk.json") ?? [];
const hrRows = readJson<HrDecision[]>("hr.json") ?? [];

// ---------------------------------------------------------------------------
// Stan bazy
// ---------------------------------------------------------------------------
const objects = db.select().from(schema.objects).all();
const contractors = db.select().from(schema.contractors).all();
const companies = db.select().from(schema.companies).all();
const monitored = db.select().from(schema.monitoredObjects).all();
const hrObjects = db.select().from(schema.hrObjects).all();

/**
 * Wiersze z generatora danych deweloperskich (scripts/seed-dev) siedzą w tej samej tabeli
 * co kartoteka. Bez ich odsiania „ile aktywnych obiektów ma ten kontrahent” kłamie —
 * wspólnota mieszkaniowa dostawała doklejone „Centrum logistyczne Busko-Zdrój” i wpływ
 * bankowy przestawał być przypisywalny.
 */
const DEV_MARKER = "[dane deweloperskie]";
const isDev = (notes: string | null | undefined) => (notes ?? "").includes(DEV_MARKER);
const realObjects = objects.filter((o) => !isDev(o.notes));

const objectById = new Map(objects.map((o) => [o.id, o]));
const contractorById = new Map(contractors.map((c) => [c.id, c]));
const monitoredByExternal = new Map(monitored.map((m) => [m.externalId, m]));
const hrByName = new Map(hrObjects.map((h) => [squash(h.name), h]));
/** Ile AKTYWNYCH obiektów ma kontrahent — jeden wpływ da się przypisać tylko przy jednym. */
const activeObjectsByContractor = new Map<number, number>();
for (const o of realObjects) {
  if (o.status !== "active") continue;
  activeObjectsByContractor.set(o.contractorId, (activeObjectsByContractor.get(o.contractorId) ?? 0) + 1);
}

/** Planowane zmiany — zbierane najpierw, zapisywane jedną transakcją na końcu. */
const setMonthly: { id: number; value: number; note: string }[] = [];
const setCompany: { id: number; companyId: number; companyName: string; source: string }[] = [];
const linkHr: { hrId: number; hrName: string; objectId: number }[] = [];
const newCompanies: { name: string; fullName: string; nip: string | null; notes: string }[] = [];
const skipped: { section: string; what: string; reason: string }[] = [];
const abonamentRows: { object: string; contractor: string; value: number; source: string }[] = [];

// ===========================================================================
// 1. ABONAMENTY OFI Z WPŁYWÓW BANKOWYCH
// ===========================================================================
const incoming = loadIncoming();

/**
 * Wybór wpłaty, gdy płatnik przelał w maju kilka razy. Kolejność reguł jest celowa:
 * najpierw sytuacje, w których odpowiedź wynika z danych (te same kwoty = zaległość
 * spłacona ratami miesięcznymi; przelew na rachunek spółki obsługującej ten posterunek;
 * jedyna pozycja z numerem faktury), a dopiero na końcu przewaga kwotowa. Gdy żadna
 * nie rozstrzyga — nie zgadujemy, tylko raportujemy.
 */
function pickPayment(
  matches: Incoming[],
  companyId: number | null
): { picked: Incoming; why: string } | { picked: null; why: string } {
  if (matches.length === 1) return { picked: matches[0], why: "jedyny wpływ od tego płatnika w maju" };

  const amounts = new Set(matches.map((m) => m.amount));
  if (amounts.size === 1) {
    return {
      picked: matches[0],
      why: `${matches.length} wpłaty po tej samej kwocie (zaległość spłacana miesięcznymi ratami) — abonament = jedna rata`,
    };
  }

  if (companyId !== null) {
    const company = companies.find((c) => c.id === companyId);
    if (company) {
      const keys = [company.fullName, company.name].filter(Boolean).map((n) => nameKey(n));
      const byCompany = matches.filter((m) => keys.some((k) => k && prefixMatch(nameKey(m.account), k, 12)));
      if (byCompany.length === 1) {
        return {
          picked: byCompany[0],
          why: `wpłata na rachunek spółki obsługującej posterunek (${company.name}); pozostałe wpłaty poszły do innych spółek grupy`,
        };
      }
    }
  }

  const withInvoice = matches.filter((m) => m.invoice);
  if (withInvoice.length === 1) return { picked: withInvoice[0], why: `jedyna wpłata z numerem faktury (${withInvoice[0].invoice})` };

  const sorted = [...matches].sort((a, b) => b.amount - a.amount);
  if (sorted[0].amount >= 3 * sorted[1].amount) {
    return {
      picked: sorted[0],
      why: `wpłata dominująca (${sorted[0].amount} zł wobec ${sorted.slice(1).map((m) => m.amount).join(" + ")} zł) — pozostałe to dopłaty/usługi dodatkowe`,
    };
  }

  return {
    picked: null,
    why: `${matches.length} wpłaty bez rozstrzygnięcia (${matches.map((m) => `${m.date} ${m.amount} zł`).join("; ")})`,
  };
}

const ofiTargets = realObjects
  .filter((o) => o.hasOfi && o.status === "active" && o.monthlyZdw === null && o.monthlyOfi === null)
  .sort((a, b) => a.id - b.id);

for (const o of ofiTargets) {
  const contractor = contractorById.get(o.contractorId);
  if (!contractor) {
    skipped.push({ section: "1", what: `#${o.id} ${o.name}`, reason: "obiekt bez kontrahenta" });
    continue;
  }
  const activeCount = activeObjectsByContractor.get(o.contractorId) ?? 0;
  const keys = [contractor.name, o.name].map((n) => nameKey(n)).filter(Boolean);
  const matches = incoming.filter((inc) => keys.some((k) => prefixMatch(inc.key, k)));

  if (matches.length === 0) {
    // Podpowiedź: przelew z NIP-em kontrahenta w tytule (bez nazwy) — do ręcznego sprawdzenia.
    const nip = normalizeNIP(contractor.nip ?? "");
    const byNip = nip ? incoming.filter((inc) => `${inc.payer} ${inc.invoice}`.includes(nip)) : [];
    skipped.push({
      section: "1",
      what: `#${o.id} ${o.name} (${contractor.name})`,
      reason: byNip.length
        ? `brak wpływu po nazwie; w maju jest przelew z NIP-em kontrahenta w tytule (${byNip
            .map((m) => `${m.date} ${m.amount} zł brutto`)
            .join("; ")}) — kwota nie pasuje do skali posterunku OFI, do ręcznego potwierdzenia`
        : "brak majowego wpływu od tego płatnika",
    });
    continue;
  }

  if (activeCount > 1) {
    skipped.push({
      section: "1",
      what: `#${o.id} ${o.name} (${contractor.name})`,
      reason: `kontrahent ma ${activeCount} aktywnych obiektów, a wpływ jest zbiorczy (${matches
        .map((m) => `${m.amount} zł`)
        .join(" + ")}) — nie rozdzielam`,
    });
    continue;
  }

  const choice = pickPayment(matches, o.companyId);
  if (!choice.picked) {
    skipped.push({ section: "1", what: `#${o.id} ${o.name} (${contractor.name})`, reason: choice.why });
    continue;
  }

  const gross = choice.picked.amount;
  const net = Math.round((gross / VAT) * 100) / 100;
  const fv = choice.picked.invoice ? `FV ${choice.picked.invoice.replace(/^FV\s*/i, "")}` : "bez numeru FV na wyciągu";
  const note =
    `Abonament z wpływu bankowego maj 2026 (brutto ${gross} zł, ${fv}) — do potwierdzenia fakturą. ` +
    `Płatnik z wyciągu: „${choice.picked.payer}”, ${choice.picked.date}, rachunek ${choice.picked.account}. Wybór: ${choice.why}.`;
  setMonthly.push({ id: o.id, value: net, note });
  abonamentRows.push({
    object: `#${o.id} ${o.name}`,
    contractor: contractor.name,
    value: net,
    source: `wpływ ${choice.picked.date}, ${gross} zł brutto, ${fv}`,
  });
}

// ===========================================================================
// 2. ROZDZIELENIE FAKTUROWANIA ZBIORCZEGO
// ===========================================================================
/** Flagi arkusza fakturowania, które nie są abonamentem (jednorazowe albo dopłata). */
const NOT_SUBSCRIPTION = /PODJAZD|USLUGI DODATKOWE|MONTAZ|SERWIS/;
function flagIsSubscription(flag: string | null | undefined): boolean {
  return !NOT_SUBSCRIPTION.test(
    (flag ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[łŁ]/g, "L")
      .toUpperCase()
  );
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/\s|zł/gi, "").replace(",", ".");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Pozycje zbiorcze (>1 obiekt) po odsianiu flag, które nie są abonamentem. */
const bulk = invoices.filter((r) => (r.cmaExternalIds ?? []).length > 1);
for (const r of bulk) {
  if (!flagIsSubscription(r.flag)) {
    skipped.push({
      section: "2",
      what: `${r.sheet} r${r.row} „${r.client}” [${r.flag}]`,
      reason: "flaga nie oznacza abonamentu (podjazdy / usługi dodatkowe / montaż-serwis)",
    });
  }
}

/**
 * Jeden klient ma w arkuszu po kilka wierszy ZDV wskazujących TEN SAM zestaw obiektów
 * (recenzent nie miał jak przypisać wiersza do konkretnego obiektu). Dzielenie każdego
 * wiersza osobno dałoby wynik zależny od kolejności, więc pozycje stykające się choćby
 * jednym obiektem scalamy w jedną grupę i dzielimy ich łączne netto. Grupy wychodzą
 * ze spójnych składowych grafu „pozycja — obiekt”.
 */
interface Group {
  positions: InvoiceRow[];
  externalIds: Set<number>;
}
const groups: Group[] = [];
const groupByExternal = new Map<number, Group>();
for (const r of bulk) {
  if (!flagIsSubscription(r.flag)) continue;
  const ids = r.cmaExternalIds ?? [];
  const touched = [...new Set(ids.map((e) => groupByExternal.get(e)).filter(Boolean))] as Group[];
  let g: Group;
  if (touched.length === 0) {
    g = { positions: [], externalIds: new Set() };
    groups.push(g);
  } else {
    g = touched[0];
    for (const other of touched.slice(1)) {
      for (const p of other.positions) g.positions.push(p);
      for (const e of other.externalIds) {
        g.externalIds.add(e);
        groupByExternal.set(e, g);
      }
      groups.splice(groups.indexOf(other), 1);
    }
  }
  g.positions.push(r);
  for (const e of ids) {
    g.externalIds.add(e);
    groupByExternal.set(e, g);
  }
}

/** Ceny ustawione w punkcie 1 liczą się już jako „znane” przy dzieleniu reszty faktury. */
const monthlyOverride = new Map(setMonthly.map((s) => [s.id, s.value]));
function monthlyOf(objectId: number): number | null {
  if (monthlyOverride.has(objectId)) return monthlyOverride.get(objectId)!;
  const o = objectById.get(objectId);
  if (!o) return null;
  // „Znana cena" to suma obu linii abonamentu — po rozbiciu (migracja 0082)
  // pojedynczej kolumny `monthly_value` już się nie czyta.
  return monthlyValueOf(o.monthlyZdw, o.monthlyOfi);
}

for (const g of groups) {
  const label = g.positions
    .map((p) => `${p.sheet} r${p.row} „${p.client}” [${p.flag}] ${toNumber(p.netto) ?? 0} zł`)
    .join(" + ");
  // Suma po groszach — bez zaokrąglenia wychodzi „9823.130000000001” z arytmetyki zmiennoprzecinkowej.
  const netto = Math.round(g.positions.reduce((sum, p) => sum + (toNumber(p.netto) ?? 0), 0) * 100) / 100;

  const rows = [...g.externalIds]
    .map((e) => {
      const mo = monitoredByExternal.get(e);
      const obj = mo?.objectId ? objectById.get(mo.objectId) : undefined;
      return { external: e, obj };
    })
    .filter((x) => x.obj)
    .sort((a, b) => a.obj!.id - b.obj!.id);

  const active = rows.filter((x) => x.obj!.status === "active");
  const missing = active.filter((x) => monthlyOf(x.obj!.id) === null);
  if (missing.length === 0) continue;

  // „Znane” liczymy tylko po obiektach AKTYWNYCH: pozycja zakończona nie jest już fakturowana,
  // więc jej dawna cena nie pomniejsza dzisiejszego netto.
  const known = active.reduce((sum, x) => sum + (monthlyOf(x.obj!.id) ?? 0), 0);
  const rest = netto - known;
  if (rest <= 0) {
    skipped.push({
      section: "2",
      what: label,
      reason: `netto ${netto} zł nie pokrywa cen znanych obiektów aktywnych (${known} zł) — nie ma czego rozdzielić na ${missing.length} obiektów bez ceny`,
    });
    continue;
  }

  const total = Math.round(rest);
  const base = Math.floor(total / missing.length);
  missing.forEach((x, i) => {
    const value = i === missing.length - 1 ? total - base * (missing.length - 1) : base;
    const clientLabel = [...new Set(g.positions.map((p) => (p.client ?? "").trim()))].join(" / ");
    const flagLabel = [...new Set(g.positions.map((p) => (p.flag ?? "").trim()))].join(" + ");
    const note =
      `Abonament rozdzielony z faktury zbiorczej „${clientLabel} ${flagLabel}” ${netto} zł / ${active.length} obiektów ` +
      `(znane ceny ${known} zł, do podziału ${total} zł na ${missing.length} obiektów bez ceny). Pozycje: ${label}.`;
    setMonthly.push({ id: x.obj!.id, value, note });
    abonamentRows.push({
      object: `#${x.obj!.id} ${x.obj!.name}`,
      contractor: contractorById.get(x.obj!.contractorId)?.name ?? "—",
      value,
      source: `faktura zbiorcza ${clientLabel} ${flagLabel} (${netto} zł netto / ${active.length} obiektów)`,
    });
  });
}

// ===========================================================================
// 3. SŁOWNIK SPÓŁEK I MAPOWANIA
// ===========================================================================
// (a) Spółki komandytowe z arkusza SK, których nie ma jeszcze w słowniku.
const companyByName = new Map(companies.map((c) => [squash(c.name), c]));
/** „GUARD ” (ze spacją) w arkuszu SK = spółka GUARD SK — tak samo jak w imporcie. */
function companyFor(rawName: string | null | undefined) {
  const name = (rawName ?? "").trim();
  if (!name) return null;
  return companyByName.get(squash(name)) ?? (squash(name) === "GUARD" ? companyByName.get(squash("GUARD SK")) : null) ?? null;
}

const GUARD12_NIP = "5242874633";
// Tylko spółki, które w arkuszu SK naprawdę obsługują posterunek. Wiersze „empty” to puste
// spółki rezerwowe — do słownika trafiłyby jako martwe pozycje.
const skCompanyNames = [
  ...new Set(
    skRows
      .filter((s) => s.decision !== "empty")
      .map((s) => (s.company ?? "").trim())
      .filter(Boolean)
  ),
];
const missingCompanyNames = skCompanyNames.filter((n) => !companyFor(n));

for (const name of missingCompanyNames) {
  const prefix = /^TARK|^TRUST/.test(squash(name)) ? "ALFA GROUP S" : "ALFA GROUP";
  const fullName = `${prefix} SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ ${name} SPÓŁKA KOMANDYTOWA`;
  let nip: string | null = null;
  let notes = `Dodana ze skoroszytu SK ${TODAY} — NIP do uzupełnienia.`;
  if (squash(name) === "GUARD12") {
    nip = GUARD12_NIP;
    notes =
      `Dodana ze skoroszytu SK ${TODAY}. NIP ${GUARD12_NIP} z raportu finansowego AlfaGroup (maj 2026); ` +
      `suma kontrolna poprawna.`;
    if (!validateNIP(nip)) {
      nip = null;
      notes = `Dodana ze skoroszytu SK ${TODAY} — NIP z raportu finansowego nie przeszedł walidacji, do uzupełnienia.`;
    } else if (!noMf) {
      const res = await lookupCompanyByNip(nip);
      if (isMfError(res)) {
        notes += ` Wykaz VAT MF niedostępny przy dodawaniu (${res.error ?? "błąd"}) — zweryfikuj ręcznie.`;
      } else if (res.found && res.company) {
        notes += ` Wykaz VAT MF: ${res.company.name} (${res.company.statusVat}), sprawdzone ${TODAY}.`;
      } else {
        notes +=
          ` Wykaz VAT MF nie zna tego NIP-u — tak samo jak NIP-ów pozostałych spółek komandytowych grupy ` +
          `(sprawdzone ${TODAY}: GUARD 14, GUARD SK też „nieznalezione”), więc to nie jest sygnał błędu; potwierdź na fakturze.`;
      }
    }
  }
  newCompanies.push({ name, fullName, nip, notes });
}

// (b) objects.company_id dla obiektów, które w sk.json/hr.json mają spółkę, a dziś mają NULL.
//     Reguła jak w imporcie: cel = obiekt z rejestru CMA po cmaExternalId, a jak go nie ma,
//     to posterunek ze słownika kadr po nazwie.
const plannedCompanyByObject = new Map<number, { companyName: string; source: string }>();
function targetObjectId(cmaExternalId: number | null, hrName: string | null): number | null {
  if (cmaExternalId !== null) {
    const mo = monitoredByExternal.get(cmaExternalId);
    if (mo?.objectId) return mo.objectId;
  }
  if (hrName) {
    const hr = hrByName.get(squash(hrName));
    if (hr?.objectId) return hr.objectId;
  }
  return null;
}

for (const s of skRows) {
  if (s.decision === "empty") continue;
  const companyName = (s.company ?? "").trim();
  if (!companyName) continue;
  const objectId = targetObjectId(s.cmaExternalId, s.hrObject);
  if (objectId === null) {
    if ((s.objectName ?? "").trim()) {
      skipped.push({
        section: "3b",
        what: `SK ${companyName} → „${s.objectName}”`,
        reason: "posterunek nie ma odpowiednika w kartotece (obiekt nie powstał przy imporcie)",
      });
    }
    continue;
  }
  const obj = objectById.get(objectId);
  if (!obj || obj.companyId !== null) continue;
  const existing = plannedCompanyByObject.get(objectId);
  if (existing && squash(existing.companyName) !== squash(companyName)) {
    skipped.push({
      section: "3b",
      what: `#${objectId} ${obj.name}`,
      reason: `dwie spółki wskazują ten sam obiekt (${existing.companyName} i ${companyName}) — zostawiam puste`,
    });
    plannedCompanyByObject.delete(objectId);
    continue;
  }
  if (!existing) plannedCompanyByObject.set(objectId, { companyName, source: `arkusz SK (${companyName})` });
}

for (const h of hrRows) {
  const companyName = (h.skCompany ?? "").trim();
  if (!companyName) continue;
  const objectId = targetObjectId(h.cmaExternalId, h.hrName);
  if (objectId === null) continue;
  const obj = objectById.get(objectId);
  if (!obj || obj.companyId !== null) continue;
  if (!plannedCompanyByObject.has(objectId)) {
    plannedCompanyByObject.set(objectId, { companyName, source: `hr.json (posterunek ${h.hrName})` });
  }
}

// (c) hr_objects bez powiązania — próba dopasowania po nazwie i adresie kartoteki.
/** Wspólnoty bez NIP-u mają własną sekcję (3d) — tu tylko posterunki, dla których obiekt może istnieć. */
const HANDLED_IN_3D = ["WILANOWSKA 67", "BORA KOMOROWSKIEGO"].map((n) => squash(n));
const unlinkedHr = hrObjects.filter(
  (h) =>
    h.objectId === null &&
    !/^#|^BIURO$|^KIEROWNIK$|^KONTROLNY$/.test(h.name.trim()) &&
    !HANDLED_IN_3D.includes(squash(h.name))
);
for (const h of unlinkedHr) {
  const key = squash(h.name);
  const candidates = realObjects.filter((o) => {
    const parts = [squash(o.name), squash(o.address), squash(`${o.name} ${o.address ?? ""}`)];
    return parts.some((p) => p.length >= 6 && (p.includes(key) || (key.length >= 6 && key.includes(p))));
  });
  if (candidates.length === 1) {
    linkHr.push({ hrId: h.id, hrName: h.name, objectId: candidates[0].id });
  } else {
    skipped.push({
      section: "3c",
      what: `hr_objects „${h.name}”`,
      reason:
        candidates.length === 0
          ? "brak obiektu w kartotece o tej nazwie/adresie"
          : `${candidates.length} kandydatów (${candidates.map((c) => `#${c.id} ${c.name}`).join("; ")}) — wymaga decyzji człowieka`,
    });
  }
}

// (d) Wspólnoty bez NIP-u (WM Wilanowska 67, WM Bora-Komorowskiego) — sprawdzamy, czy
//     ktoś zdążył ustalić ich NIP; bez niego kontrahenta nie da się utworzyć.
const UNCERTAIN = join(ROOT, "scripts", "data", "kontrahenci-uzupelnienie-niepewne.json");
interface Uncertain {
  matchNames?: string[];
  matchCma?: number[];
  candidates?: { nip: string | null; name?: string }[];
  problem?: string;
}
if (existsSync(UNCERTAIN)) {
  const uncertain = JSON.parse(readFileSync(UNCERTAIN, "utf8")) as Uncertain[];
  for (const hrName of ["WILANOWSKA 67", "BORA KOMOROWSKIEGO"]) {
    const hr = hrByName.get(squash(hrName));
    if (!hr || hr.objectId !== null) continue;
    const entry = uncertain.find((u) => (u.matchNames ?? []).some((n) => squash(n).includes(squash(hrName.split(" ")[0]))));
    const withNip = (entry?.candidates ?? []).filter((c) => c.nip && validateNIP(c.nip));
    skipped.push({
      section: "3d",
      what: `hr_objects „${hr.name}”`,
      reason: withNip.length
        ? `kandydaci z NIP-em do weryfikacji w MF: ${withNip.map((c) => `${c.nip} ${c.name ?? ""}`.trim()).join("; ")}`
        : `brak NIP-u w kontrahenci-uzupelnienie-niepewne.json (${
            entry?.problem?.slice(0, 160) ?? "wspólnota nieodnaleziona w rejestrach"
          }) — bez NIP-u nie utworzę kontrahenta ani obiektu`,
    });
  }
}

// ===========================================================================
// Zapis
// ===========================================================================
const stats = { monthly: 0, companiesInserted: 0, companySet: 0, hrLinked: 0 };

if (apply) {
  db.transaction((tx) => {
    for (const s of setMonthly) {
      const current = tx.select().from(schema.objects).where(eq(schema.objects.id, s.id)).get();
      // Idempotencja: obiekt z JAKĄKOLWIEK uzupełnioną linią abonamentu zostaje.
      if (!current || current.monthlyZdw !== null || current.monthlyOfi !== null) continue;
      const notes = [current.notes?.trim(), s.note].filter(Boolean).join("\n");
      // Kwotę zapisujemy ROZBITĄ na linie — tą samą regułą, co migracja 0082
      // (src/lib/abonament-split.ts). Notatka `s.note` niesie pochodzenie ceny
      // („wpływ bankowy” / „faktura zbiorcza [ZDV]”), więc karmi tę samą regułę,
      // która rozstrzygała obiekty mieszane przy migracji.
      const split = splitAbonament({
        monthlyValue: s.value,
        hasOfi: current.hasOfi,
        hasCameras: current.hasCameras,
        hasSswin: current.hasSswin,
        hasVideoreception: current.hasVideoreception,
        notes: [s.note, current.notes ?? ""].join("\n"),
      });
      tx.update(schema.objects)
        .set({ monthlyZdw: split.monthlyZdw, monthlyOfi: split.monthlyOfi, notes })
        .where(eq(schema.objects.id, s.id))
        .run();
      stats.monthly++;
    }

    for (const c of newCompanies) {
      const exists = tx.select().from(schema.companies).where(eq(schema.companies.name, c.name)).get();
      if (exists) continue;
      tx.insert(schema.companies)
        .values({ name: c.name, fullName: c.fullName, nip: c.nip, notes: c.notes })
        .run();
      stats.companiesInserted++;
    }

    // Spółki wstawione przed chwilą muszą być widoczne przy ustawianiu company_id.
    const companiesNow = new Map(
      tx
        .select()
        .from(schema.companies)
        .all()
        .map((c) => [squash(c.name), c])
    );
    for (const [objectId, plan] of plannedCompanyByObject) {
      const company =
        companiesNow.get(squash(plan.companyName)) ?? (squash(plan.companyName) === "GUARD" ? companiesNow.get("GUARDSK") : undefined);
      if (!company) continue;
      const current = tx.select().from(schema.objects).where(eq(schema.objects.id, objectId)).get();
      if (!current || current.companyId !== null) continue; // idempotencja
      tx.update(schema.objects).set({ companyId: company.id }).where(eq(schema.objects.id, objectId)).run();
      setCompany.push({ id: objectId, companyId: company.id, companyName: company.name, source: plan.source });
      stats.companySet++;
    }

    for (const l of linkHr) {
      const current = tx.select().from(schema.hrObjects).where(eq(schema.hrObjects.id, l.hrId)).get();
      if (!current || current.objectId !== null) continue; // idempotencja
      tx.update(schema.hrObjects).set({ objectId: l.objectId }).where(eq(schema.hrObjects.id, l.hrId)).run();
      stats.hrLinked++;
    }
  });
} else {
  for (const [objectId, plan] of plannedCompanyByObject) {
    const company = companyFor(plan.companyName) ?? newCompanies.find((c) => squash(c.name) === squash(plan.companyName));
    setCompany.push({
      id: objectId,
      companyId: (company as { id?: number })?.id ?? -1,
      companyName: plan.companyName,
      source: plan.source,
    });
  }
}

// ===========================================================================
// Raport
// ===========================================================================
say(`# Uzupełnienie kartoteki — ${TODAY}`);
say();
say(`Tryb: ${apply ? "ZAPIS (--apply)" : "suchy przebieg"}. Baza: ${process.env.ALFA_DB_PATH ?? "./data/alfa.db"}.`);
say();
say("## Podsumowanie");
say();
say(`- Abonamenty z wpływów bankowych (punkt 1): ${abonamentRows.filter((r) => r.source.startsWith("wpływ")).length}`);
say(`- Abonamenty z rozdzielenia faktur zbiorczych (punkt 2): ${abonamentRows.filter((r) => !r.source.startsWith("wpływ")).length}`);
say(`- Razem obiektów z nowym abonamentem: ${setMonthly.length}${apply ? ` (zapisano ${stats.monthly})` : ""}`);
say(`- Nowe spółki w słowniku (punkt 3a): ${newCompanies.length}${apply ? ` (zapisano ${stats.companiesInserted})` : ""}`);
say(`- Obiekty z uzupełnioną spółką (punkt 3b): ${setCompany.length}${apply ? ` (zapisano ${stats.companySet})` : ""}`);
say(`- Nowe powiązania hr_objects → obiekt (punkt 3c): ${linkHr.length}${apply ? ` (zapisano ${stats.hrLinked})` : ""}`);
say(`- Pozycji pominiętych (do decyzji człowieka): ${skipped.length}`);
say();

say("## Obiekty z nowym abonamentem");
say();
if (abonamentRows.length === 0) {
  say("(brak)");
} else {
  say("| Obiekt | Kontrahent | Abonament netto/mies. | Źródło |");
  say("| --- | --- | ---: | --- |");
  for (const r of abonamentRows.sort((a, b) => a.object.localeCompare(b.object))) {
    say(`| ${r.object} | ${r.contractor} | ${r.value.toFixed(2)} zł | ${r.source} |`);
  }
}
say();

say("## Nowe spółki");
say();
if (newCompanies.length === 0) {
  say("(brak)");
} else {
  say("| Skrót | Pełna nazwa | NIP |");
  say("| --- | --- | --- |");
  for (const c of newCompanies) say(`| ${c.name} | ${c.fullName} | ${c.nip ?? "—"} |`);
}
say();

say("## Obiekty z uzupełnioną spółką");
say();
if (setCompany.length === 0) {
  say("(brak)");
} else {
  say("| Obiekt | Spółka | Źródło |");
  say("| --- | --- | --- |");
  for (const s of setCompany.sort((a, b) => a.id - b.id)) {
    say(`| #${s.id} ${objectById.get(s.id)?.name ?? ""} | ${s.companyName} | ${s.source} |`);
  }
}
say();

say("## Nowe powiązania kadr");
say();
if (linkHr.length === 0) {
  say("(brak)");
} else {
  for (const l of linkHr) say(`- hr_objects „${l.hrName}” → #${l.objectId} ${objectById.get(l.objectId)?.name ?? ""}`);
}
say();

say("## Pominięte — dlaczego");
say();
for (const section of ["1", "2", "3b", "3c", "3d"]) {
  const rows = skipped.filter((s) => s.section === section);
  if (rows.length === 0) continue;
  say(`### Punkt ${section} (${rows.length})`);
  say();
  for (const r of rows) say(`- **${r.what}** — ${r.reason}`);
  say();
}

mkdirSync(dirname(resolve(REPORT_PATH)), { recursive: true });
writeFileSync(resolve(REPORT_PATH), out.join("\n") + "\n", "utf8");
console.log(`\nRaport: ${resolve(REPORT_PATH)}`);
if (!apply) console.log("Suchy przebieg — nic nie zapisano. Dodaj --apply, żeby wgrać zmiany.");
