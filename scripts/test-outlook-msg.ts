/**
 * Test czytania maili `.msg` z Outlooka (src/lib/outlook-msg.ts):
 *   npx tsx scripts/test-outlook-msg.ts
 *
 * Bez bazy i bez HTTP — moduł jest czysty, więc nie ma czego sprzątać.
 *
 * Fikstura: na maszynie deweloperskiej nie ma prawdziwego maila z Outlooka
 * (`find / -iname "*.msg"` znajduje wyłącznie katalogi komunikatów Tcl/Tk),
 * więc plik .msg SKŁADAMY tutaj — prawdziwym formatem CFBF, tym samym
 * „wypalaczem”, którego msgreader używa do wyciągania zagnieżdżonych maili.
 * Dzięki temu `parseOutlookMsg` przechodzi pełną drogę: nagłówek CFBF →
 * strumienie `__substg1.0_*` → strumień właściwości → odbiorcy i załączniki.
 * Gdyby kiedyś pod ręką był prawdziwy .msg, wystarczy podać ścieżkę:
 *   npx tsx scripts/test-outlook-msg.ts /ścieżka/do/maila.msg
 *
 * Pokrywa: parsowanie (temat, nadawca, DO/DW, data, treść, nazwy załączników),
 * odrzucenie pliku, który nie jest .msg, czyszczenie tematu (RE:/FW:/ODP.:),
 * HTML → tekst, normalizację i przycinanie treści oraz kształt notatki.
 * Białą listę załączników (`.msg`/`.eml`) sprawdza scripts/test-note-attachments.ts.
 *
 * CZĘŚĆ BAZODANOWA (podpowiadanie obiektu po adresach + notatka `kind='email'`)
 * rusza TYLKO na kopii bazy, czyli gdy ustawione jest `ALFA_DB_PATH`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-outlook-msg.ts
 * Bez tego skrypt zostaje czysty (nie dotyka produkcyjnej bazy) i mówi o tym wprost.
 * Sprząta po sobie HARD (kontrahenci, obiekty, kontakty, wydarzenia, notatki), także przy błędzie.
 */
import { readFileSync } from "node:fs";
import { burn, type Entry } from "@kenjiuno/msgreader/lib/Burner.js";
import { TypeEnum } from "@kenjiuno/msgreader/lib/Reader.js";
import {
  attachmentsMetaOf,
  clampBody,
  formatAddress,
  formatMsgAsNote,
  htmlToText,
  normalizeText,
  mailHeaderOf,
  parseOutlookMsg,
  suggestedTitleFrom,
  type ParsedMsg,
} from "../src/lib/outlook-msg.js";

/**
 * Obrazek 1x1 (PNG) — najmniejszy plik, który sharp naprawdę zdekoduje, więc
 * wypakowany załącznik przechodzi tę samą drogę co zwykły upload (WebP + wymiary).
 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Budowa pliku .msg (CFBF) — minimalna, ale prawdziwa
// ---------------------------------------------------------------------------

/**
 * Strumień `__substg1.0_<tag><typ>` z tekstem w UTF-16LE (typ 001F = unicode).
 *
 * UWAGA: `burn` kopiuje dane przez `memcpy(arr.buffer, 0, …)`, czyli IGNORUJE
 * `byteOffset` — a `Buffer.from(string)` to widok na współdzieloną pulę Node.
 * Bez własnego `Uint8Array` do pliku trafiłyby losowe bajty z pamięci procesu.
 */
function unicodeStream(tag: string, text: string): Entry {
  const data = new Uint8Array(Buffer.from(text, "utf16le"));
  return {
    name: `__substg1.0_${tag}001F`,
    type: TypeEnum.DOCUMENT,
    binaryProvider: () => data,
    length: data.length,
  };
}

/**
 * Strumień binarny `__substg1.0_<tag>0102` — tak siedzi w pliku TREŚĆ załącznika
 * (tag 3701). Kopia bez offsetu, z tego samego powodu co w unicodeStream.
 */
function binaryStream(tag: string, data: Buffer): Entry {
  const bytes = new Uint8Array(data);
  return {
    name: `__substg1.0_${tag}0102`,
    type: TypeEnum.DOCUMENT,
    binaryProvider: () => bytes,
    length: bytes.length,
  };
}

/** Milisekundy epoki → FILETIME (100 ns od 1601 r.), tak jak zapisuje to MAPI. */
function fileTime(ms: number): bigint {
  return BigInt(ms) * 10000n + 116444736000000000n;
}

interface PropRecord {
  /** Identyfikator właściwości, np. 0x0039 (clientSubmitTime). */
  id: number;
  /** Typ właściwości: 0x0040 = czas, 0x0003 = liczba 32-bitowe. */
  type: number;
  /** 8 bajtów wartości (inline dla czasu i liczby). */
  value: bigint;
}

/**
 * Strumień `__properties_version1.0`: nagłówek (32 bajty w korzeniu, 8 w folderze
 * odbiorcy/załącznika) i po 16 bajtów na właściwość — tag, flagi, wartość.
 */
function propertiesStream(headerBytes: number, props: PropRecord[]): Entry {
  const buf = Buffer.alloc(headerBytes + props.length * 16);
  let off = headerBytes;
  for (const p of props) {
    buf.writeUInt32LE(((p.id << 16) >>> 0) + p.type, off);
    buf.writeUInt32LE(6, off + 4); // flagi: readable | writable
    buf.writeBigUInt64LE(p.value, off + 8);
    off += 16;
  }
  // Kopia bez offsetu — patrz komentarz przy unicodeStream.
  const data = new Uint8Array(buf);
  return {
    name: "__properties_version1.0",
    type: TypeEnum.DOCUMENT,
    binaryProvider: () => data,
    length: data.length,
  };
}

/**
 * Składa plik .msg z płaskiej listy wpisów CFBF: korzeń, jego strumienie oraz
 * po jednym folderze na odbiorcę i załącznik (msgreader czyta je po prefiksie
 * `__recip_version1.0_#` / `__attach_version1.0_#`).
 */
function buildMsg(opts: {
  subject: string;
  senderName: string;
  senderEmail: string;
  body?: string;
  bodyHtml?: string;
  sentAtMs: number;
  recipients: Array<{ name: string; email: string; type: 1 | 2 }>;
  /** Sama nazwa (załącznik bez treści) albo nazwa z bajtami — to drugie da się wypakować. */
  attachments: Array<string | { name: string; data: Buffer; mime?: string; contentId?: string }>;
}): Buffer {
  const entries: Entry[] = [{ name: "Root Entry", type: TypeEnum.ROOT, children: [], length: 0 }];
  const rootChildren = entries[0].children!;

  const push = (entry: Entry): number => {
    entries.push(entry);
    return entries.length - 1;
  };
  const addToRoot = (entry: Entry) => rootChildren.push(push(entry));

  addToRoot(unicodeStream("001A", "IPM.Note")); // messageClass
  addToRoot(unicodeStream("0037", opts.subject));
  addToRoot(unicodeStream("0C1A", opts.senderName));
  addToRoot(unicodeStream("5D01", opts.senderEmail)); // senderSmtpAddress
  if (opts.body !== undefined) addToRoot(unicodeStream("1000", opts.body));
  if (opts.bodyHtml !== undefined) addToRoot(unicodeStream("1013", opts.bodyHtml));
  addToRoot(propertiesStream(32, [{ id: 0x0039, type: 0x0040, value: fileTime(opts.sentAtMs) }]));

  opts.recipients.forEach((r, i) => {
    const folderIdx = push({
      name: `__recip_version1.0_#${i.toString(16).toUpperCase().padStart(8, "0")}`,
      type: TypeEnum.DIRECTORY,
      children: [],
      length: 0,
    });
    rootChildren.push(folderIdx);
    const kids = entries[folderIdx].children!;
    kids.push(push(unicodeStream("3001", r.name))); // name
    kids.push(push(unicodeStream("39FE", r.email))); // smtpAddress
    kids.push(push(propertiesStream(8, [{ id: 0x0C15, type: 0x0003, value: BigInt(r.type) }])));
  });

  opts.attachments.forEach((raw, i) => {
    const att = typeof raw === "string" ? { name: raw, data: undefined, mime: undefined, contentId: undefined } : raw;
    const folderIdx = push({
      name: `__attach_version1.0_#${i.toString(16).toUpperCase().padStart(8, "0")}`,
      type: TypeEnum.DIRECTORY,
      children: [],
      length: 0,
    });
    rootChildren.push(folderIdx);
    const kids = entries[folderIdx].children!;
    kids.push(push(unicodeStream("3707", att.name))); // fileName
    if (att.mime) kids.push(push(unicodeStream("370E", att.mime))); // attachMimeTag
    if (att.contentId) kids.push(push(unicodeStream("3712", att.contentId))); // pidContentId
    if (att.data) kids.push(push(binaryStream("3701", att.data))); // treść załącznika
    kids.push(push(propertiesStream(8, [])));
  });

  return Buffer.from(burn(entries));
}

// ---------------------------------------------------------------------------
// 1. Parsowanie pliku .msg
// ---------------------------------------------------------------------------

const SENT_MS = Date.UTC(2026, 8, 10, 12, 32, 0); // 10.09.2026 12:32 UTC = 14:32 w Warszawie
const realPath = process.argv[2];

let parsed: ParsedMsg;
if (realPath) {
  console.log(`Prawdziwy plik .msg: ${realPath}`);
  parsed = parseOutlookMsg(readFileSync(realPath));
  ok("prawdziwy .msg: jest temat albo treść", !!(parsed.subject || parsed.bodyText), parsed);
  ok("prawdziwy .msg: sentAt to ISO albo null", parsed.sentAt === null || !Number.isNaN(Date.parse(parsed.sentAt)), parsed.sentAt);
} else {
  const msg = buildMsg({
    subject: "ODP.: Awaria kamery na bramie",
    senderName: "Jan Kowalski",
    senderEmail: "jan.kowalski@example.invalid",
    body: "Dzień dobry,\r\n\r\n\r\n\r\nkamera przy bramie nie nagrywa od wtorku.   \r\nProszę o serwis.\r\n\r\nPozdrawiam\r\n",
    sentAtMs: SENT_MS,
    recipients: [
      { name: "Serwis Alfa", email: "serwis@alfa.invalid", type: 1 },
      { name: "Anna Nowak", email: "anna.nowak@example.invalid", type: 2 },
    ],
    attachments: ["zdjecie.jpg", "protokol.pdf"],
  });
  ok("fikstura .msg wygląda jak CFBF (sygnatura D0CF11E0)", msg.subarray(0, 4).toString("hex") === "d0cf11e0", msg.subarray(0, 8).toString("hex"));

  parsed = parseOutlookMsg(msg);
  ok("temat z pliku", parsed.subject === "ODP.: Awaria kamery na bramie", parsed.subject);
  ok("nadawca jako „Nazwa <adres>”", parsed.from === "Jan Kowalski <jan.kowalski@example.invalid>", parsed.from);
  ok("odbiorcy DO", parsed.to.join("|") === "Serwis Alfa <serwis@alfa.invalid>", parsed.to);
  ok("odbiorcy DW", parsed.cc.join("|") === "Anna Nowak <anna.nowak@example.invalid>", parsed.cc);
  ok("data wysłania jako ISO", parsed.sentAt === new Date(SENT_MS).toISOString(), parsed.sentAt);
  ok("nazwy załączników", parsed.attachments.join("|") === "zdjecie.jpg|protokol.pdf", parsed.attachments);
  ok(
    "treść: CRLF → LF, bez spacji na końcu linii, maks. 2 puste linie",
    parsed.bodyText === "Dzień dobry,\n\nkamera przy bramie nie nagrywa od wtorku.\nProszę o serwis.\n\nPozdrawiam",
    parsed.bodyText
  );

  ok("bez bajtów w pliku nie ma czego wypakować", parsed.attachmentFiles.length === 0, parsed.attachmentFiles);

  // --- Załączniki Z TREŚCIĄ (wypakowywanie) ---
  const withFiles = parseOutlookMsg(
    buildMsg({
      subject: "Zdjęcia z obiektu",
      senderName: "Jan Kowalski",
      senderEmail: "jan.kowalski@example.invalid",
      body: "W załączeniu.",
      sentAtMs: SENT_MS,
      recipients: [],
      attachments: [
        { name: "image001.png", data: PNG_1PX, mime: "image/png", contentId: "image001@01DC" },
        { name: "raport.bin", data: Buffer.alloc(16, 7), mime: "application/octet-stream" },
      ],
    })
  );
  ok("attachmentFiles: oba załączniki z treścią", withFiles.attachmentFiles.length === 2, withFiles.attachmentFiles.map((a) => a.name));
  const png = withFiles.attachmentFiles[0];
  ok(
    "attachmentFiles: PNG ma nazwę, MIME z maila i BAJTY (nagłówek PNG)",
    png?.name === "image001.png" &&
      png?.mime === "image/png" &&
      png?.data.length === PNG_1PX.length &&
      png?.data.subarray(0, 4).toString("hex") === "89504e47",
    { name: png?.name, mime: png?.mime, len: png?.data.length }
  );
  ok("attachmentFiles: Content-ID → inline", png?.inline === true && png?.contentId === "image001@01DC", png);
  ok(
    "attachmentFiles: załącznik bez Content-ID nie jest inline",
    withFiles.attachmentFiles[1]?.name === "raport.bin" && withFiles.attachmentFiles[1]?.inline === false,
    withFiles.attachmentFiles[1]
  );
  ok("nazwy załączników nadal w attachments (zgodność wstecz)", withFiles.attachments.join("|") === "image001.png|raport.bin", withFiles.attachments);
  ok(
    "attachmentsMetaOf: nazwa/typ/rozmiar/isImage bez bajtów",
    attachmentsMetaOf(withFiles.attachmentFiles).map((m) => `${m.name}:${m.size}:${m.isImage}`).join("|") ===
      `image001.png:${PNG_1PX.length}:true|raport.bin:16:false`,
    attachmentsMetaOf(withFiles.attachmentFiles)
  );
  ok(
    "mailHeaderOf: nagłówek niesie NAZWY załączników",
    mailHeaderOf(withFiles).attachments?.join("|") === "image001.png|raport.bin",
    mailHeaderOf(withFiles)
  );

  // --- HTML zamiast treści tekstowej ---
  const htmlOnly = parseOutlookMsg(
    buildMsg({
      subject: "Oferta",
      senderName: "biuro@example.invalid",
      senderEmail: "biuro@example.invalid",
      bodyHtml:
        "<html><head><style>p{color:red}</style></head><body><p>Dzie&#324; dobry,</p><p>w za&lt;3&gt;&nbsp;za&#322;&#261;czeniu oferta.</p><script>alert(1)</script></body></html>",
      sentAtMs: SENT_MS,
      recipients: [],
      attachments: [],
    })
  );
  ok(
    "brak body → bodyHtml bez tagów, z encjami i bez script/style",
    htmlOnly.bodyText === "Dzień dobry,\n\nw za<3> załączeniu oferta.",
    htmlOnly.bodyText
  );
  ok("nadawca bez osobnej nazwy → sam adres", htmlOnly.from === "biuro@example.invalid", htmlOnly.from);
  ok("brak odbiorców → puste listy", htmlOnly.to.length === 0 && htmlOnly.cc.length === 0, htmlOnly);

  // --- Plik, który nie jest mailem ---
  let threw = false;
  try {
    parseOutlookMsg(Buffer.from("to nie jest zaden mail"));
  } catch {
    threw = true;
  }
  ok("plik spoza formatu .msg → wyjątek (trasa robi z tego 400)", threw);
  let threwEmpty = false;
  try {
    parseOutlookMsg(Buffer.alloc(0));
  } catch {
    threwEmpty = true;
  }
  ok("pusty bufor → wyjątek", threwEmpty);
}

// ---------------------------------------------------------------------------
// 2. Notatka z maila
// ---------------------------------------------------------------------------

const note = formatMsgAsNote({
  subject: "Awaria kamery na bramie",
  from: "Jan Kowalski <jan.kowalski@example.invalid>",
  to: ["Serwis Alfa <serwis@alfa.invalid>"],
  cc: ["Anna Nowak <anna.nowak@example.invalid>"],
  sentAt: new Date(SENT_MS).toISOString(),
  bodyText: "Kamera przy bramie nie nagrywa.",
  attachments: ["zdjecie.jpg"],
});
const lines = note.split("\n");
ok("notatka: pierwsza linia to temat z kopertą", lines[0] === "📧 Temat: Awaria kamery na bramie", lines[0]);
ok("notatka: nadawca", lines[1] === "Od: Jan Kowalski <jan.kowalski@example.invalid>", lines[1]);
ok("notatka: odbiorcy DO i DW", lines[2].startsWith("Do: ") && lines[3].startsWith("DW: "), lines.slice(2, 4));
ok("notatka: data po polsku w strefie aplikacji", lines[4] === "Data: 10.09.2026 14:32", lines[4]);
ok("notatka: załączniki", lines[5] === "Załączniki: zdjecie.jpg", lines[5]);
ok("notatka: pusta linia przed treścią", lines[6] === "" && lines[7] === "Kamera przy bramie nie nagrywa.", lines.slice(6, 8));

const bare = formatMsgAsNote({
  subject: "",
  from: "",
  to: [],
  cc: [],
  sentAt: null,
  bodyText: "",
  attachments: [],
});
ok("notatka z pustego maila: sam temat zastępczy, ZERO „undefined”/„null”", bare === "📧 Temat: (bez tematu)", bare);

// ---------------------------------------------------------------------------
// 3. Temat → tytuł wydarzenia
// ---------------------------------------------------------------------------

const titles: Array<[string, string]> = [
  ["RE: Awaria", "Awaria"],
  ["re: awaria", "awaria"],
  ["FW: RE: ODP.: Oferta monitoringu", "Oferta monitoringu"],
  ["Fwd: Umowa", "Umowa"],
  ["ODP: Zgłoszenie", "Zgłoszenie"],
  ["PD: Zgłoszenie", "Zgłoszenie"],
  ["AW: WG: Termin", "Termin"],
  ["RE[2]: Termin", "Termin"],
  ["  Serwis   kamer  ", "Serwis kamer"],
  ["", "Mail z Outlooka"],
  ["RE:", "Mail z Outlooka"],
  ["Podsumowanie: rozmowa z klientem", "Podsumowanie: rozmowa z klientem"],
];
for (const [input, expected] of titles) {
  ok(`tytuł z tematu „${input}” → „${expected}”`, suggestedTitleFrom(input) === expected, suggestedTitleFrom(input));
}
const longTitle = suggestedTitleFrom("FW: " + "x".repeat(500));
ok("tytuł przycięty do 200 znaków", longTitle.length === 200, longTitle.length);

// ---------------------------------------------------------------------------
// 4. Funkcje pomocnicze (HTML, normalizacja, przycinanie, adresy)
// ---------------------------------------------------------------------------

ok(
  "htmlToText: <br> i </p> łamią linie, tabela zostaje czytelna",
  htmlToText("<p>Ala<br>ma kota</p><table><tr><td>A</td><td>B</td></tr></table>") === "Ala\nma kota\n\nA\tB",
  htmlToText("<p>Ala<br>ma kota</p><table><tr><td>A</td><td>B</td></tr></table>")
);
ok(
  "htmlToText: nieznana encja zostaje dosłownie (nie gubimy treści)",
  htmlToText("<p>a &nieznana; b</p>") === "a &nieznana; b",
  htmlToText("<p>a &nieznana; b</p>")
);
ok("htmlToText: komentarze HTML znikają", htmlToText("<p>A<!-- ukryte -->B</p>") === "AB", htmlToText("<p>A<!-- ukryte -->B</p>"));
ok("normalizeText: maks. 2 puste linie", normalizeText("a\n\n\n\n\nb") === "a\n\nb", normalizeText("a\n\n\n\n\nb"));
ok("clampBody: krótki tekst bez zmian", clampBody("abc", 10) === "abc");
const clamped = clampBody("x".repeat(100), 40);
ok("clampBody: wynik mieści się w limicie i ma dopisek", clamped.length <= 40 && clamped.endsWith("[…skrócono]"), clamped);
ok("formatAddress: sama nazwa", formatAddress("Jan", undefined) === "Jan");
ok("formatAddress: nazwa równa adresowi → jeden raz", formatAddress("a@b.pl", "a@b.pl") === "a@b.pl");
ok("formatAddress: nic → pusty string", formatAddress(undefined, undefined) === "");

// ---------------------------------------------------------------------------
// 5. Baza: podpowiadanie obiektu po adresach + notatka kind='email'
// ---------------------------------------------------------------------------

if (!process.env.ALFA_DB_PATH) {
  console.log(
    "\n(pominięto testy bazodanowe — uruchom je na KOPII bazy:\n" +
      "   npx tsx scripts/test-on-copy.ts scripts/test-outlook-msg.ts)"
  );
} else {
  const { db, schema } = await import("../src/db/index.js");
  const { suggestObjectsForEmails } = await import("../src/lib/mail-object-match.js");
  const { emailsOf } = await import("../src/lib/outlook-msg.js");
  const { eq, inArray, like, and } = await import("drizzle-orm");
  const { Hono } = await import("hono");
  const calendarRoutes = (await import("../src/routes/calendar.js")).default;
  type User = import("../src/db/schema.js").User;

  const PREFIX = "__MSG_TEST__";
  const DOM_A = "firma-a.invalid";
  const DOM_B = "firma-b.invalid";

  function cleanup() {
    const objectIds = db.select({ id: schema.objects.id }).from(schema.objects)
      .where(like(schema.objects.name, `${PREFIX}%`)).all().map((r) => r.id);
    const eventIds = db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents)
      .where(like(schema.calendarEvents.title, `${PREFIX}%`)).all().map((r) => r.id);
    if (eventIds.length) {
      db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, eventIds)).run();
      db.delete(schema.activityLog)
        .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
        .run();
      db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
    }
    if (objectIds.length) {
      db.delete(schema.objectNotes).where(inArray(schema.objectNotes.objectId, objectIds)).run();
      db.delete(schema.activityLog)
        .where(and(eq(schema.activityLog.entityType, "object"), inArray(schema.activityLog.entityId, objectIds)))
        .run();
      db.delete(schema.contacts).where(inArray(schema.contacts.objectId, objectIds)).run();
      db.delete(schema.objects).where(inArray(schema.objects.id, objectIds)).run();
    }
    const contractorIds = db.select({ id: schema.contractors.id }).from(schema.contractors)
      .where(like(schema.contractors.name, `${PREFIX}%`)).all().map((r) => r.id);
    if (contractorIds.length) {
      db.delete(schema.contacts).where(inArray(schema.contacts.contractorId, contractorIds)).run();
      db.delete(schema.contractors).where(inArray(schema.contractors.id, contractorIds)).run();
    }
  }
  cleanup();

  const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
  if (!admin) throw new Error("Test wymaga admina w bazie");

  try {
    // --- fikstury: dwaj kontrahenci, trzy obiekty, trzy kontakty ---
    const conA = db.insert(schema.contractors)
      .values({ name: `${PREFIX} Kontrahent A`, nip: `${Date.now()}`.slice(-10), email: `biuro@${DOM_A}` })
      .returning().get();
    const conB = db.insert(schema.contractors)
      .values({ name: `${PREFIX} Kontrahent B`, nip: `${Date.now() + 1}`.slice(-10) })
      .returning().get();
    const objA1 = db.insert(schema.objects)
      .values({ contractorId: conA.id, name: `${PREFIX} Obiekt A1`, type: "monitoring", installationType: "new", city: "Warszawa", address: "Testowa 1" })
      .returning().get();
    const objA2 = db.insert(schema.objects)
      .values({ contractorId: conA.id, name: `${PREFIX} Obiekt A2`, type: "monitoring", installationType: "new" })
      .returning().get();
    const objB1 = db.insert(schema.objects)
      .values({ contractorId: conB.id, name: `${PREFIX} Obiekt B1`, type: "alarm", installationType: "new" })
      .returning().get();
    // Kontakt przypięty do OBIEKTU — najmocniejsza przesłanka.
    db.insert(schema.contacts)
      .values({ contractorId: conA.id, objectId: objA1.id, firstName: "Jan", lastName: "Kierownik", email: `Kierownik@${DOM_A}` })
      .run();
    // Kontakt tylko kontrahenta → wszystkie jego obiekty.
    db.insert(schema.contacts)
      .values({ contractorId: conB.id, firstName: "Ewa", lastName: "Sekretariat", email: `sekretariat@${DOM_B}` })
      .run();
    // Kontakt WYŁĄCZONY — nie ma prawa niczego podpowiedzieć.
    db.insert(schema.contacts)
      .values({ contractorId: conB.id, objectId: objB1.id, firstName: "Były", lastName: "Pracownik", email: `bylypracownik@${DOM_B}`, active: false })
      .run();

    // --- dopasowanie ---
    const s1 = suggestObjectsForEmails(db, ["  KIEROWNIK@Firma-A.invalid "]);
    ok(
      "kontakt obiektu: jeden obiekt, via=object_contact, adres małymi literami",
      s1.length === 1 && s1[0].objectId === objA1.id && s1[0].via === "object_contact" && s1[0].matchedEmails[0] === `kierownik@${DOM_A}`,
      s1
    );
    ok("kontakt obiektu: nazwa obiektu i kontrahenta w wyniku", s1[0]?.objectName === objA1.name && s1[0]?.contractorName === conA.name, s1[0]);

    const s2 = suggestObjectsForEmails(db, [`sekretariat@${DOM_B}`]);
    ok(
      "kontakt kontrahenta → obiekty kontrahenta, via=contractor",
      s2.length === 1 && s2[0].objectId === objB1.id && s2[0].via === "contractor",
      s2
    );

    const s3 = suggestObjectsForEmails(db, [`biuro@${DOM_A}`]);
    ok(
      "adres z kartoteki kontrahenta → wszystkie jego obiekty (via=contractor)",
      s3.length === 2 && s3.every((x) => x.via === "contractor") && new Set(s3.map((x) => x.objectId)).size === 2,
      s3
    );

    const s4 = suggestObjectsForEmails(db, [`kierownik@${DOM_A}`, `biuro@${DOM_A}`, `sekretariat@${DOM_B}`]);
    ok("kolejność: kontakt obiektu PRZED kontrahentem", s4[0]?.objectId === objA1.id && s4[0]?.via === "object_contact", s4);
    ok(
      "obiekt trafiony dwoma drogami trzyma via=object_contact i oba adresy",
      s4[0]?.matchedEmails.length === 2 && s4[0]?.matchedEmails.join() === [`biuro@${DOM_A}`, `kierownik@${DOM_A}`].join(),
      s4[0]
    );
    ok("pozostałe obiekty też są (A2, B1)", s4.length === 3, s4.map((x) => x.objectName));

    ok("wyłączony kontakt nie podpowiada", suggestObjectsForEmails(db, [`bylypracownik@${DOM_B}`]).length === 0);
    ok("nieznany adres → brak podpowiedzi", suggestObjectsForEmails(db, ["nikt@nieznana.invalid"]).length === 0);
    ok("pusta lista adresów → brak podpowiedzi", suggestObjectsForEmails(db, []).length === 0);

    ok(
      "emailsOf: adresy z nagłówka (z nawiasów ostrych i gołe), bez powtórzeń",
      emailsOf({
        subject: "x",
        from: `Jan Kowalski <Kierownik@${DOM_A}>`,
        to: [`serwis@${DOM_B}`, `kierownik@${DOM_A}`],
        cc: ["Anna <anna@x.invalid>"],
        sentAt: null,
      }).sort().join() === [`anna@x.invalid`, `kierownik@${DOM_A}`, `serwis@${DOM_B}`].sort().join(),
      emailsOf({ subject: "x", from: `Jan <Kierownik@${DOM_A}>`, to: [`serwis@${DOM_B}`], cc: [], sentAt: null })
    );

    // --- notatka kind='email' przez trasę ---
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", admin);
      return next();
    });
    app.route("/calendar", calendarRoutes);

    const ev = db.insert(schema.calendarEvents)
      .values({
        type: "serwis", title: `${PREFIX} Serwis z maila`, startAt: "2026-09-10T09:00", endAt: "2026-09-10T11:00",
        allDay: false, status: "planned", department: "technical", objectId: objA1.id, createdBy: admin.id, updatedBy: admin.id,
      })
      .returning().get();

    const mailHeader = {
      subject: "Awaria kamery na bramie",
      from: `Jan Kowalski <kierownik@${DOM_A}>`,
      to: [`serwis@${DOM_B}`],
      cc: ["Anna Nowak <anna@x.invalid>"],
      sentAt: new Date(SENT_MS).toISOString(),
    };
    const fd = new FormData();
    fd.set("text", "Kamera przy bramie nie nagrywa od wtorku.");
    fd.set("mail", JSON.stringify(mailHeader));
    const resNote = await app.request(`/calendar/events/${ev.id}/notes`, { method: "POST", body: fd });
    const noteJson = (await resNote.json()) as {
      success: boolean;
      data?: { id: number; kind: string; text: string; mail: typeof mailHeader | null };
      error?: string;
    };
    ok("POST notes z polem mail → 201, kind=email", resNote.status === 201 && noteJson.data?.kind === "email", noteJson);
    ok("notatka mailowa: text to SAMA treść (bez nagłówka)", noteJson.data?.text === "Kamera przy bramie nie nagrywa od wtorku.", noteJson.data?.text);
    ok(
      "notatka mailowa: mail {subject, from, to[], cc[], sentAt}",
      noteJson.data?.mail?.subject === mailHeader.subject &&
        noteJson.data?.mail?.from === mailHeader.from &&
        noteJson.data?.mail?.to.join() === mailHeader.to.join() &&
        noteJson.data?.mail?.cc.join() === mailHeader.cc.join() &&
        noteJson.data?.mail?.sentAt === mailHeader.sentAt,
      noteJson.data?.mail
    );
    const rowKind = db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, noteJson.data!.id)).get();
    ok(
      "kolumny w bazie: kind/mail_subject/mail_to (JSON)",
      rowKind?.kind === "email" && rowKind?.mailSubject === mailHeader.subject && rowKind?.mailTo === JSON.stringify(mailHeader.to),
      rowKind
    );

    // Zwykła notatka nadal jest tekstowa.
    const plain = await app.request(`/calendar/events/${ev.id}/notes`, {
      method: "POST", body: JSON.stringify({ text: "Zwykły wpis" }), headers: { "Content-Type": "application/json" },
    });
    const plainJson = (await plain.json()) as { data?: { kind: string; mail: unknown } };
    ok("JSON bez maila → kind=text, mail=null", plain.status === 201 && plainJson.data?.kind === "text" && plainJson.data?.mail === null, plainJson);

    // Nagłówek maila liczy się jak treść — mail z samym tematem przechodzi.
    const emptyBody = new FormData();
    emptyBody.set("text", "");
    emptyBody.set("mail", JSON.stringify({ ...mailHeader, subject: "FYI" }));
    const emptyRes = await app.request(`/calendar/events/${ev.id}/notes`, { method: "POST", body: emptyBody });
    ok("mail bez treści → 201 (nagłówek wystarczy)", emptyRes.status === 201, await emptyRes.json());

    // Śmieci w polu mail → 400.
    const badMail = new FormData();
    badMail.set("text", "x");
    badMail.set("mail", "{to nie jest JSON");
    const badRes = await app.request(`/calendar/events/${ev.id}/notes`, { method: "POST", body: badMail });
    const badJson = (await badRes.json()) as { error?: string };
    ok("nieprawidłowy JSON w polu mail → 400", badRes.status === 400 && badJson.error === "Nieprawidłowe dane maila", badJson);

    // --- GET: kształt JSON-a ---
    const get = await app.request(`/calendar/events/${ev.id}/notes`);
    const getJson = (await get.json()) as { data: { id: number; kind: string; mail: { subject: string } | null }[] };
    const fromGet = getJson.data.find((n) => n.id === noteJson.data!.id);
    ok("GET /events/:id/notes → kind + mail przy notatce mailowej", fromGet?.kind === "email" && fromGet?.mail?.subject === mailHeader.subject, fromGet);
    ok("GET: zwykła notatka ma kind=text i mail=null", getJson.data.some((n) => n.kind === "text" && n.mail === null), getJson.data.map((n) => n.kind));

    // --- wypakowanie załączników z .msg przy zapisie notatki ---
    const msgWithAtts = buildMsg({
      subject: "Zdjęcia z obiektu",
      senderName: "Jan Kowalski",
      senderEmail: `kierownik@${DOM_A}`,
      body: "W załączeniu zdjęcie.",
      sentAtMs: SENT_MS,
      recipients: [{ name: "Serwis", email: `serwis@${DOM_B}`, type: 1 }],
      attachments: [
        { name: "image001.png", data: PNG_1PX, mime: "image/png", contentId: "image001@01DC" },
        // Typ spoza białej listy — ma być POMINIĘTY, a nie wywalić zapisu.
        { name: "raport.bin", data: Buffer.alloc(16, 7), mime: "application/octet-stream" },
      ],
    });
    const msgFile = () => new File([new Uint8Array(msgWithAtts)], "mail.msg", { type: "application/vnd.ms-outlook" });
    const mailWithAtts = { ...mailHeader, subject: "Zdjęcia z obiektu", attachments: ["image001.png", "raport.bin"] };

    const withExtract = new FormData();
    withExtract.set("text", "W załączeniu zdjęcie.");
    withExtract.set("mail", JSON.stringify(mailWithAtts));
    withExtract.set("extractMsgAttachments", "1");
    withExtract.append("files", msgFile());
    const extractRes = await app.request(`/calendar/events/${ev.id}/notes`, { method: "POST", body: withExtract });
    const extractJson = (await extractRes.json()) as {
      data?: { id: number; mail: { attachments?: string[] } | null; attachments: Array<{ fileName: string; kind: string; origin?: string; width: number | null; height: number | null }> };
      skippedAttachments?: string[];
    };
    const atts = extractJson.data?.attachments ?? [];
    ok("wypakowanie: 201 i dwa załączniki (.msg + obrazek)", extractRes.status === 201 && atts.length === 2, atts);
    const orig = atts.find((a) => a.fileName === "mail.msg");
    ok("wypakowanie: oryginalny .msg ma origin=upload", orig?.origin === "upload" && orig?.kind === "file", orig);
    const img = atts.find((a) => a.origin === "msg");
    ok(
      "wypakowanie: image001 → obrazek WebP z wymiarami, origin=msg",
      img?.fileName === "image001.webp" && img?.kind === "image" && img?.width === 1 && img?.height === 1,
      img
    );
    ok(
      "wypakowanie: .bin pominięty i zgłoszony w skippedAttachments",
      extractJson.skippedAttachments?.join("|") === "raport.bin" && !atts.some((a) => a.fileName === "raport.bin"),
      extractJson.skippedAttachments
    );
    ok(
      "wypakowanie: nazwy załączników z maila zapisane przy nagłówku",
      extractJson.data?.mail?.attachments?.join("|") === "image001.png|raport.bin",
      extractJson.data?.mail
    );
    const getAfter = await app.request(`/calendar/events/${ev.id}/notes`);
    const getAfterJson = (await getAfter.json()) as {
      data: Array<{ id: number; attachments: Array<{ fileName: string; origin?: string; url: string }> }>;
    };
    const savedNote = getAfterJson.data.find((n) => n.id === extractJson.data!.id);
    ok(
      "GET: załączniki notatki niosą origin (upload + msg)",
      savedNote?.attachments.map((a) => `${a.fileName}:${a.origin}`).sort().join("|") === "image001.webp:msg|mail.msg:upload",
      savedNote?.attachments
    );
    const imgId = savedNote?.attachments.find((a) => a.origin === "msg");
    const imgRes = await app.request(imgId!.url.replace("/api", ""));
    ok("GET załącznika z maila: 200 i image/webp", imgRes.status === 200 && imgRes.headers.get("content-type") === "image/webp", imgRes.status);

    // Bez flagi wypakowywania zostaje sam .msg.
    const noExtract = new FormData();
    noExtract.set("text", "Bez wypakowywania.");
    noExtract.set("mail", JSON.stringify(mailWithAtts));
    noExtract.append("files", msgFile());
    const noExtractRes = await app.request(`/calendar/events/${ev.id}/notes`, { method: "POST", body: noExtract });
    const noExtractJson = (await noExtractRes.json()) as {
      data?: { attachments: Array<{ fileName: string; origin?: string }> };
      skippedAttachments?: string[];
    };
    ok(
      "bez extractMsgAttachments → tylko oryginalny .msg, bez skippedAttachments",
      noExtractRes.status === 201 &&
        noExtractJson.data?.attachments.length === 1 &&
        noExtractJson.data.attachments[0].origin === "upload" &&
        noExtractJson.skippedAttachments === undefined,
      noExtractJson.data?.attachments
    );

    // --- wyszukiwarka: mail z prefiksem tematu ---
    const search = await app.request("/calendar/notes/search?q=" + encodeURIComponent("Awaria kamery na bramie"));
    const searchJson = (await search.json()) as { data: { id: number; kind?: string; text: string }[] };
    const hit = searchJson.data.find((n) => n.id === noteJson.data!.id);
    ok(
      "wyszukiwarka: mail znaleziony po TEMACIE, tekst z prefiksem koperty",
      !!hit && hit.kind === "email" && hit.text.startsWith("📧 Awaria kamery na bramie — "),
      hit
    );

    // --- kopia do obiektu: nagłówek nie ginie ---
    const copy = await app.request(`/calendar/notes/${noteJson.data!.id}/copy-to-object`, { method: "POST" });
    const copyJson = (await copy.json()) as { data?: { text: string } };
    ok(
      "kopia do obiektu: tekst z nagłówkiem (Temat/Od/Data) + treść",
      copy.status === 200 &&
        !!copyJson.data &&
        copyJson.data.text.startsWith("📧 Temat: Awaria kamery na bramie") &&
        copyJson.data.text.includes("Kamera przy bramie nie nagrywa od wtorku."),
      copyJson.data?.text
    );
  } finally {
    cleanup();
    console.log("(posprzątano fikstury bazodanowe)");
  }
}

console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} testów nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
