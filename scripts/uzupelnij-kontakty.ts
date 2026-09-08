/**
 * Uzupełnienie kontaktów kontrahentów danymi z rejestru CMA (monitored_objects):
 *   npx tsx scripts/uzupelnij-kontakty.ts            # suchy przebieg — tylko raport
 *   npx tsx scratchpad... ALFA_DB_PATH=<kopia> npx tsx scripts/uzupelnij-kontakty.ts --apply
 *
 * Honoruje ALFA_DB_PATH (patrz src/db/index.ts) — pierwsze przebiegi rób na kopii bazy.
 *
 * SKĄD DANE. Rejestr CMA trzyma dla każdego obiektu listę osób upoważnionych
 * (`authorized_persons`, numerowana „1. Imię Nazwisko (rola)”) i równolegle numerowaną
 * listę telefonów (`authorized_phones`). Kartoteka kontrahentów ma te pola puste —
 * skrypt przenosi tam osobę kontaktową klienta i jej telefon.
 *
 * CZEGO SKRYPT NIE ZROBI:
 *  - nie dotyka HASEŁ. Pola `authorized_passwords` i `duress_passwords` nie są nawet czytane;
 *  - nie nadpisuje niepustych pól — uzupełnia wyłącznie `contact_person` i `phone`, gdy są puste
 *    (e-maili CMA nie ma, więc `email` zostaje nietknięty);
 *  - nie wpisuje jako kontaktu klienta ludzi Alfy — Grupa Kontrolna, Dział Techniczny, CMA, OFI
 *    i wszyscy z `hr_employees` / `technicians` są odfiltrowani (patrz `isAlfaPerson`);
 *  - nie bierze wpisów, które nie są osobą: „---”, same role („Dyżurka ochrony”),
 *    firmy i grupy interwencyjne, wpisy bez nazwiska.
 *
 * IDEMPOTENCJA. Kontrahent z niepustym `contact_person` jest pomijany w całości, a sekcja
 * „Osoby upoważnione (CMA)” trafia do `objects.notes` tylko wtedy, gdy jeszcze jej tam nie ma.
 * Drugi przebieg z `--apply` = zero zmian.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";

const apply = process.argv.includes("--apply");

const NOTES_SECTION = "Osoby upoważnione (CMA):";

/* ————————————————————————— normalizacja tekstu ————————————————————————— */

/** Zdejmuje ogonki i sprowadza do lower-case — do porównywania nazwisk, nie do wyświetlania. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}

/** Zdrobnienia, którymi CMA zapisuje pracowników Alfy („Wojtek Brodzicki” = „Brodzicki Wojciech”). */
const NICKNAMES: Record<string, string> = {
  wojtek: "wojciech",
  darek: "dariusz",
  mietek: "mieczyslaw",
  krzysiek: "krzysztof",
  tomek: "tomasz",
  piotrek: "piotr",
  grzesiek: "grzegorz",
  staszek: "stanislaw",
  marek: "marek",
  bartek: "bartlomiej",
  rafal: "rafal",
  michal: "michal",
  sebastian: "sebastian",
  mikolaj: "mikolaj",
  janek: "jan",
  kuba: "jakub",
  zbyszek: "zbigniew",
  jurek: "jerzy",
  romek: "roman",
  slawek: "slawomir",
  wlodek: "wlodzimierz",
  andrzej: "andrzej",
};

/**
 * Klucz tożsamości osoby: posortowane tokeny nazwiska i imienia po rozwinięciu zdrobnień.
 * Sortowanie jest tu istotne — kadry trzymają „Nazwisko Imię”, a CMA „Imię Nazwisko”.
 */
function personKey(name: string): string {
  return fold(name)
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1)
    .map((t) => NICKNAMES[t] ?? t)
    .sort()
    .join(" ");
}

/* ————————————————————————— rozpoznawanie wpisów ————————————————————————— */

/** Słowa, po których wpis jest instytucją / rolą, a nie osobą kontaktową klienta. */
const NOT_A_PERSON = [
  "agencja", "ochrony", "ochrona", "ochronie", "grupa", "grupy", "interwencyjna", "interwencyjny",
  "dyzurka", "dyzurny", "dyzur", "portiernia", "recepcja", "sekretariat", "biuro", "centrala",
  "serwis", "monitoring", "monitorowania", "kamery", "kamer", "megafon", "megafony", "megafonow",
  "aplikacja", "operator", "patrol", "sklep", "magazyn", "brama", "alarm", "alarmowy", "spolka",
  "firma", "zaklad", "przedsiebiorstwo", "administracja", "konserwator", "telefon", "komorka",
  "info", "sp", "zoo", "pogotowie", "straz", "policja", "kierowcy", "pracownicy", "pracownik",
  "obsluga", "wszystkie", "wszyscy", "brak", "nieznany", "test", "konto", "numer", "numery",
  "centrum", "alarmowe", "alarmowa", "system", "systemy", "podjazd", "podjazdy", "obiekt",
  "obiektu", "nadajnik", "nadajniki", "kontakt", "calodobowo", "calodobowy", "zgloszenia",
  "pof", "ekotrade", "brama", "bramie", "tylko", "osoba", "osoby", "pierwsza", "pierwszy",
  "awaria", "awarie", "bhp", "serwisant", "solid", "wentylacja", "komisariat", "policji",
  "najblizszy", "najblizsza",
];

/**
 * Znaczniki działów Alfy — w nazwisku albo w roli.
 *
 * Świadomie NIE ma tu „GK” ani „DT”: w rejestrze CMA te skróty przy nazwisku klienta
 * („Michał Pawlak (GK) (Właściciel)”, „Kierownik budowy @GK”) znaczą „jest w grupie
 * kontaktowej Grupy Kontrolnej”, a nie „pracuje w Alfie” — filtr po nich wycinał
 * właścicieli i kierowników budów, czyli dokładnie te osoby, których szukamy.
 * Wpisy „INFO KAMERY (GK + DT)” i tak odpadają jako nieosobowe.
 */
const ALFA_MARKERS = [
  /\balfa\b/,
  /\bgrup[ay]\s+kontroln/,
  /\bgr\.?\s*kontroln/,
  /\bkontroln[ayej]+\b/,
  /\bcma\b/,
  /\bofi\b/,
  /\binfo\s+kamery\b/,
  /\bdzial(u)?\s+techniczn/,
  /\bdz\.?\s*techniczn/,
];

/** Ręczna lista ludzi Alfy — rejestr CMA nie zawsze dopisuje im dział. */
const ALFA_MANUAL = [
  "Mikołaj Sajdak",
  "Sebastian Cybulski",
  "Wojciech Brodzicki",
  "Wojtek Brodzicki",
  "Dariusz Gocaliński",
  "Darek Gocaliński",
  "Piotr Wawrzyniak",
  "Dominik Jaworski",
  "Daniel Styczewski",
  "Michał Gozdek",
  "Kamil Potaś",
  "Darek Kazimierak",
  "Marek Witwera",
];

/** Rejestr CMA bywa wprost: „Karol Gawin (Vice Prezes — NIE DZWONIĆ !!!)”. Takich nie proponujemy. */
const DO_NOT_CALL = /nie\s*dzwon/;

/** Dopiski, które są instrukcją dla dyżurnego, a nie stanowiskiem — do `contact_person` nie trafiają. */
const NOT_A_ROLE = /dzwoni|zadzwo|wysyla|sms|e-?mail|w przypadku|tylko w|uprawnion|upowazni|czytaj|urlop|godzin/;

/** Role, które wskazują, że osoba realnie decyduje po stronie klienta. */
const DECISIVE = /kierownik|kierowni|prezes|wlascicie|zarzadca|administrator|dyrektor|manager|menad|mened|zarzad|pelnomocnik|szef|wojt|burmistrz/;

type Parsed = { name: string; role: string | null };

/** Zdejmuje znaczniki grup kontaktowych CMA („GK”, „@GK”, „DT”) — to nie część nazwiska ani stanowiska. */
function stripGroupTags(text: string): string {
  return text
    .replace(/@?\b(gk|dt)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:+\-]+|[\s,;:+\-]+$/g, "")
    .trim();
}

/**
 * Ucina dopiski doklejone do nazwiska bez nawiasu — rejestr CMA zna i „Antoni Stanisławek
 * PIERWSZA OSOBA KONTAKTOWA”, i „Arkadiusz Skowronek - informujemy e-mail o…”. Po przecinku,
 * myślniku i przy pierwszym członie pisanym KAPITALIKAMI kończy się nazwisko, zaczyna instrukcja.
 */
function trimNameAnnotations(raw: string): string {
  let text = raw.split(/\s[-–—]\s|[,;:]/)[0].trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens[0] !== tokens[0].toUpperCase()) {
    const cut = tokens.findIndex((t, i) => i > 0 && t.length > 1 && t === t.toLocaleUpperCase("pl") && t !== t.toLocaleLowerCase("pl"));
    if (cut > 0) text = tokens.slice(0, cut).join(" ");
  }
  return text.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
}

/** „1. Jan Kowalski (kierownik)” → { name: „Jan Kowalski”, role: „kierownik” }. */
function parsePerson(line: string): Parsed | null {
  const raw = line.replace(/^\s*\d+\s*[.)]\s*/, "").trim();
  if (!raw) return null;
  const open = raw.indexOf("(");
  const name = stripGroupTags(trimNameAnnotations((open >= 0 ? raw.slice(0, open) : raw).trim()));
  const close = raw.lastIndexOf(")");
  const role = open >= 0 && close > open ? stripGroupTags(raw.slice(open + 1, close)) : "";
  if (!name) return null;
  return { name, role: role || null };
}

/** Czy wpis w ogóle jest osobą: dwa człony, same litery, żadnego słowa z listy instytucji. */
function isPersonName(name: string): boolean {
  if (/\d/.test(name)) return false;
  const tokens = fold(name).split(/[\s-]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  if (tokens.some((t) => !/^[a-z.']+$/.test(t))) return false;
  const meaningful = tokens.filter((t) => t.replace(/\./g, "").length > 1);
  if (meaningful.length < 2) return false;
  if (meaningful.some((t) => NOT_A_PERSON.includes(t.replace(/\./g, "")))) return false;
  return true;
}

/** Znormalizowany telefon „+48 XXX XXX XXX” albo null, gdy z pola nie da się wyłuskać numeru. */
function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/^\s*\d+\s*[.)]\s*/, "");
  const compact = stripped.replace(/[\s\-().]/g, "");
  const match = compact.match(/(?:\+?48)?(\d{9})(?!\d)/);
  if (!match) return null;
  const digits = match[1];
  return `+48 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

/** ALL CAPS z rejestru CMA na „Jan Kowalski” — wielkie litery zostawione dla nazwisk mieszanych. */
function tidyCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text
    .toLocaleLowerCase("pl")
    .replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase("pl"));
}

/* ————————————————————————— dane wejściowe ————————————————————————— */

const hrNames = db.select({ name: schema.hrEmployees.fullName }).from(schema.hrEmployees).all();
const techNames = db
  .select({ first: schema.technicians.firstName, last: schema.technicians.lastName })
  .from(schema.technicians)
  .all();

const excluded = new Set<string>();
for (const r of hrNames) excluded.add(personKey(r.name));
for (const r of techNames) excluded.add(personKey(`${r.first} ${r.last}`));
for (const n of ALFA_MANUAL) excluded.add(personKey(n));
excluded.delete("");

/** Ludzie Alfy rozpoznani po dziale w opisie — tych nie ma jak pomylić z klientem. */
function isAlfaByMarker(p: Parsed): boolean {
  return ALFA_MARKERS.some((re) => re.test(fold(`${p.name} ${p.role ?? ""}`)));
}

type Candidate = { name: string; role: string | null; phone: string | null; order: number; alfaByName: boolean };

/**
 * Nazwisko z kadr bywa zbiegiem okoliczności: „Jaworski Sławomir” siedzi w `hr_employees`,
 * a jednocześnie jest właścicielem kontrahenta „JaworSerwis Sławomir Jaworski”. Dlatego
 * dopasowanie po samym nazwisku ustępuje, gdy osoba występuje w NAZWIE kontrahenta.
 */
function isClientDespiteName(c: Candidate, contractorName: string): boolean {
  const haystack = ` ${fold(contractorName).replace(/[^a-z]+/g, " ")} `;
  return fold(c.name)
    .split(/[\s-]+/)
    .filter((t) => t.length > 2)
    .every((t) => haystack.includes(` ${t} `));
}

/** Osoby klienta z jednego obiektu CMA, w kolejności z rejestru. */
function clientPeople(persons: string | null, phones: string | null): Candidate[] {
  if (!persons) return [];
  const phoneByIndex = new Map<number, string>();
  for (const line of (phones ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[.)]\s*(.*)$/);
    if (m) phoneByIndex.set(Number(m[1]), m[2]);
  }
  const out: Candidate[] = [];
  const lines = persons.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const numbered = line.match(/^\s*(\d+)\s*[.)]/);
    const index = numbered ? Number(numbered[1]) : i + 1;
    if (DO_NOT_CALL.test(fold(line))) continue;
    const parsed = parsePerson(line);
    if (!parsed) continue;
    if (!isPersonName(parsed.name)) continue;
    if (isAlfaByMarker(parsed)) continue;
    out.push({
      name: tidyCase(parsed.name).replace(/\s+/g, " "),
      role: parsed.role,
      phone: normalizePhone(phoneByIndex.get(index)),
      order: out.length,
      alfaByName: excluded.has(personKey(parsed.name)),
    });
  }
  return out;
}

/** Podpis osoby do dedupu w obrębie kontrahenta. */
const sig = (c: Candidate) => personKey(c.name);

/** „Jan Kowalski (kierownik)” — rola tylko wtedy, gdy jest krótka i coś wnosi. */
function contactLabel(c: Candidate): string {
  const role = c.role
    ?.replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}]+/u, "")
    .trim();
  if (!role || role.length > 40 || /^[^\p{L}]+$/u.test(role)) return c.name;
  if (role.includes("@") || /\d{3}/.test(role)) return c.name;
  if (NOT_A_ROLE.test(fold(role))) return c.name;
  return `${c.name} (${tidyCase(role)})`;
}

/* ————————————————————————— zbieranie kandydatów ————————————————————————— */

const contractors = db
  .select({ id: schema.contractors.id, name: schema.contractors.name, contactPerson: schema.contractors.contactPerson, phone: schema.contractors.phone })
  .from(schema.contractors)
  .where(eq(schema.contractors.active, true))
  .all();

const objects = db
  .select({ id: schema.objects.id, contractorId: schema.objects.contractorId, name: schema.objects.name, status: schema.objects.status, notes: schema.objects.notes })
  .from(schema.objects)
  .all();

const monitored = db
  .select({
    objectId: schema.monitoredObjects.objectId,
    persons: schema.monitoredObjects.authorizedPersons,
    phones: schema.monitoredObjects.authorizedPhones,
    active: schema.monitoredObjects.active,
  })
  .from(schema.monitoredObjects)
  .where(isNotNull(schema.monitoredObjects.objectId))
  .all();

const peopleByObject = new Map<number, Candidate[]>();
for (const mo of monitored) {
  if (mo.objectId == null) continue;
  const people = clientPeople(mo.persons, mo.phones);
  if (people.length === 0) continue;
  const prev = peopleByObject.get(mo.objectId) ?? [];
  for (const p of people) {
    // Ta sama osoba potrafi wystąpić na liście dwa razy — raz zbiorczo („Katarzyna Kurpias,
    // Piotr Boguszewski…”), raz z własnym stanowiskiem. Scalamy, żeby nie zgubić roli.
    const dup = prev.find((q) => sig(q) === sig(p));
    if (!dup) prev.push(p);
    else {
      if (!dup.role && p.role) dup.role = p.role;
      if (!dup.phone && p.phone) dup.phone = p.phone;
    }
  }
  peopleByObject.set(mo.objectId, prev);
}

const objectsByContractor = new Map<number, typeof objects>();
for (const o of objects) {
  const list = objectsByContractor.get(o.contractorId) ?? [];
  list.push(o);
  objectsByContractor.set(o.contractorId, list);
}

const OBJECT_ACTIVE = new Set(["active", "aktywny"]);

type ContractorUpdate = { id: number; name: string; contact: string; phone: string | null; phoneSet: boolean };
type NoteUpdate = { id: number; name: string; line: string; notes: string };

const contractorUpdates: ContractorUpdate[] = [];
const noteUpdates: NoteUpdate[] = [];
const skipped: { name: string; reason: string }[] = [];

for (const contractor of contractors) {
  if (contractor.contactPerson && contractor.contactPerson.trim() !== "") continue;
  const own = objectsByContractor.get(contractor.id) ?? [];
  if (own.length === 0) {
    skipped.push({ name: contractor.name, reason: "brak obiektów w kartotece" });
    continue;
  }

  // Ranking: liczy się częstotliwość, ale obiekty aktywne ważą więcej niż archiwalne,
  // a przy remisie wygrywa rola decyzyjna, potem pozycja w rejestrze.
  type Agg = { cand: Candidate; active: number; total: number; order: number };
  const agg = new Map<string, Agg>();
  const linkedToCma = own.some((obj) => monitored.some((m) => m.objectId === obj.id && m.persons));

  const clientOf = (obj: { id: number }) =>
    (peopleByObject.get(obj.id) ?? []).filter((p) => !p.alfaByName || isClientDespiteName(p, contractor.name));

  for (const obj of own) {
    const people = clientOf(obj);
    const isActive = OBJECT_ACTIVE.has(obj.status);
    for (const p of people) {
      const key = sig(p);
      const cur = agg.get(key);
      if (cur) {
        cur.active += isActive ? 1 : 0;
        cur.total += 1;
        if (!cur.cand.phone && p.phone) cur.cand.phone = p.phone;
        if (!cur.cand.role && p.role) cur.cand.role = p.role;
      } else {
        agg.set(key, { cand: { ...p }, active: isActive ? 1 : 0, total: 1, order: agg.size });
      }
    }
  }

  if (agg.size === 0) {
    skipped.push({
      name: contractor.name,
      reason: linkedToCma ? "w CMA tylko osoby Alfy / wpisy nieosobowe" : "obiekty bez powiązania z rejestrem CMA",
    });
    continue;
  }

  const ranked = [...agg.values()].sort((a, b) => {
    if (b.active !== a.active) return b.active - a.active;
    if (b.total !== a.total) return b.total - a.total;
    const da = DECISIVE.test(fold(a.cand.role ?? "")) ? 1 : 0;
    const dbb = DECISIVE.test(fold(b.cand.role ?? "")) ? 1 : 0;
    if (da !== dbb) return dbb - da;
    return a.order - b.order;
  });
  const chosen = ranked[0].cand;

  const phoneSet = (!contractor.phone || contractor.phone.trim() === "") && chosen.phone != null;
  contractorUpdates.push({
    id: contractor.id,
    name: contractor.name,
    contact: contactLabel(chosen),
    phone: phoneSet ? chosen.phone : null,
    phoneSet,
  });

  // Pozostałe osoby (z telefonem) idą do notatek TEGO obiektu, na którym występują.
  for (const obj of own) {
    const people = clientOf(obj).filter((p) => sig(p) !== sig(chosen) && p.phone);
    if (people.length === 0) continue;
    const notes = obj.notes ?? "";
    if (notes.includes(NOTES_SECTION)) continue;
    const line = `${NOTES_SECTION} ${people.map((p) => `${contactLabel(p)} — ${p.phone}`).join("; ")}`;
    noteUpdates.push({ id: obj.id, name: obj.name, line, notes: notes.trim() ? `${notes.trimEnd()}\n${line}` : line });
  }
}

/* ————————————————————————— raport ————————————————————————— */

const withPhone = contractorUpdates.filter((u) => u.phoneSet).length;

console.log(`Tryb: ${apply ? "ZAPIS (--apply)" : "SUCHY PRZEBIEG"}`);
console.log(`Baza: ${process.env.ALFA_DB_PATH ?? "./data/alfa.db"}`);
console.log("");
console.log(`Aktywni kontrahenci bez osoby kontaktowej: ${contractors.filter((c) => !c.contactPerson || c.contactPerson.trim() === "").length}`);
console.log(`  → dostanie osobę kontaktową: ${contractorUpdates.length}`);
console.log(`  → dostanie telefon:          ${withPhone}`);
console.log(`Obiekty, które dostaną sekcję „${NOTES_SECTION}”: ${noteUpdates.length}`);
console.log(`Pominięci kontrahenci (CMA nie dało osoby klienta): ${skipped.length}`);
console.log("");

console.log("Przykładowe wpisy (20):");
for (const u of contractorUpdates.slice(0, 20)) {
  console.log(`  [${u.id}] ${u.name}`);
  console.log(`        osoba: ${u.contact}${u.phoneSet ? `   tel: ${u.phone}` : "   (telefon: bez zmian)"}`);
}
console.log("");
console.log("Przykładowe notatki obiektów (5):");
for (const n of noteUpdates.slice(0, 5)) console.log(`  [${n.id}] ${n.name}: ${n.line}`);
console.log("");
console.log("Pominięci:");
for (const s of skipped) console.log(`  - ${s.name} — ${s.reason}`);

/* ————————————————————————— zapis ————————————————————————— */

if (!apply) {
  console.log("\nSuchy przebieg — nic nie zapisano. Dodaj --apply, żeby zapisać.");
  process.exit(0);
}

db.transaction((tx) => {
  for (const u of contractorUpdates) {
    const patch: Record<string, unknown> = { contactPerson: u.contact, updatedAt: new Date().toISOString().slice(0, 19).replace("T", " ") };
    if (u.phoneSet && u.phone) patch.phone = u.phone;
    tx.update(schema.contractors)
      .set(patch)
      .where(and(eq(schema.contractors.id, u.id), eq(schema.contractors.active, true)))
      .run();
  }
  for (const n of noteUpdates) {
    tx.update(schema.objects).set({ notes: n.notes }).where(eq(schema.objects.id, n.id)).run();
  }
});

console.log(`\nZapisano: ${contractorUpdates.length} kontrahentów (w tym ${withPhone} z telefonem), ${noteUpdates.length} notatek obiektów.`);
