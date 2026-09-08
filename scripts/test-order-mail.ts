/**
 * Test szablonu maila „potwierdzenie przyjęcia zlecenia”:
 *   npx tsx scripts/test-order-mail.ts
 *
 * Czysta funkcja (src/lib/order-mail.ts) — bez bazy i bez HTTP, więc nie ma czego
 * sprzątać. Pokrywa trzy rzeczy, na których taki szablon zwykle się wykłada:
 *   1. komplet danych — temat z numerem, wszystkie sekcje na miejscu,
 *   2. puste zlecenie — ŻADNEGO „null" / „undefined" / „Invalid Date" w treści,
 *   3. wstrzyknięcie HTML — nazwa obiektu z „<script>" ma wyjść zescapowana.
 *
 * Wariant WEWNĘTRZNY (buildOrderInternalMail) ma regułę odwrotną do klienckiego:
 *   4. komplet — wszystkie etykiety zawsze na miejscu, linki do kartotek w CRM,
 *   5. puste zlecenie — braki jako „—", nadal ZERO „null" / „undefined".
 */
import {
  buildOrderConfirmationMail,
  buildOrderInternalMail,
  type OrderMailInput,
} from "../src/lib/order-mail.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// 1. Pełne zlecenie
// ---------------------------------------------------------------------------

const full: OrderMailInput = {
  id: 1,
  orderNumber: "ZDW/2026/0042",
  requesterName: "Anna Kowalska",
  requesterPhone: "600 100 200",
  requesterEmail: "anna.kowalska@firma.invalid",
  payerName: "Firma Testowa Sp. z o.o.",
  payerNip: "1234567890",
  payerInvoiceEmail: "faktury@firma.invalid",
  objectName: "Osiedle Zielona Dolina",
  objectKind: "Osiedle mieszkaniowe",
  objectAddress: "ul. Kwiatowa 12",
  objectCity: "Warszawa",
  objectLocationUrl: "https://maps.example.invalid/?q=52.1,21.0",
  contactPerson: "Jan Nowak",
  contactPhone: "601 202 303",
  contactEmail: "jan.nowak@firma.invalid",
  isCameraInstallation: true,
  cameraCount: 12,
  megaphoneCount: 3,
  vtoolsOfferNumber: "VT/2026/321",
  internetIncluded: true,
  interventionGroup: false,
  videoReception: true,
  monthlyAmount: 1250.5,
  contractLengthMonths: 24,
  rentalAmount: 480,
  rentalLengthMonths: 36,
  invoiceIssuer: "Alfa Group Sp. z o.o.",
  serviceStartDate: "2026-04-01",
  installationStartDate: "2026-03-15",
  notes: "Wjazd na teren od strony ul. Polnej, kod do bramy u ochrony.",
};

const mail = buildOrderConfirmationMail(full, { baseUrl: "https://app.example.invalid/" });

ok("temat zawiera numer zlecenia", mail.subject.includes("ZDW/2026/0042"), mail.subject);
ok("html zawiera nazwę obiektu", mail.html.includes("Osiedle Zielona Dolina"));
ok("html zawiera numer zlecenia", mail.html.includes("ZDW/2026/0042"));
ok("html wita zlecającą po imieniu", mail.html.includes("Dzień dobry Anna Kowalska,"));
ok("html ma sekcję zakresu usługi", mail.html.includes("Zakres usługi") && mail.html.includes("Kamery: 12 szt."));
// „Zakres usługi” wymienia tylko to, co klient DOSTAJE — w fixture
// interventionGroup: false, więc tego punktu ma w ogóle nie być.
ok("zakres pomija odpowiedzi „Nie”", !mail.html.includes("Grupa interwencyjna"), mail.html.match(/Grupa interwencyjna[^<]*/)?.[0]);
ok("zakres wymienia usługi z „Tak” bez sufiksu", mail.html.includes("Montaż kamer") && !mail.html.includes("Montaż kamer: Tak"));
ok("zakres ma internet i wideo recepcję", mail.html.includes("Internet w ramach usługi") && mail.html.includes("Wideo recepcja"));
// Separator tysięcy zależy od wersji ICU (pl-PL grupuje dopiero od pięciu cyfr),
// więc dopuszczamy „1250,50" i „1 250,50" — pilnujemy groszy, waluty i okresu.
ok(
  "html ma abonament z okresem",
  /1 ?250,50 zł netto\/mies\. × 24 mies\./.test(mail.html),
  mail.html.match(/1 ?250[^<]*/)?.[0]
);
ok("html ma dzierżawę", mail.html.includes("480,00 zł netto/mies. × 36 mies."));
ok("html ma datę startu usługi po polsku", mail.html.includes("1 kwietnia 2026"));
ok("html ma datę startu montażu po polsku", mail.html.includes("15 marca 2026"));
ok("html ma osobę kontaktową", mail.html.includes("Jan Nowak") && mail.html.includes("601 202 303"));
ok("html ma uwagi", mail.html.includes("Wjazd na teren od strony"));
ok("logo ma absolutny URL bez podwójnego ukośnika", mail.html.includes('src="https://app.example.invalid/alfa-logo.png"'));
ok("html ma stopkę Alfa Group", mail.html.includes("ALFA GROUP Sp. z o.o.") && mail.html.includes("KRS 0000119104"));
ok("html informuje o automacie", mail.html.includes("wygenerowana automatycznie"));
ok("html nie używa flex/grid (email-safe)", !/display:\s*(flex|grid)/i.test(mail.html));
ok("html nie ładuje zewnętrznego CSS", !/<link\b/i.test(mail.html));

// Telefony w zdaniu: „tel./fax” i kropka rozdzielająca zostają w stopce, ale
// w wywołaniu do kontaktu mają być czytelne.
ok(
  "zamknięcie ma telefony w wersji do zdania",
  mail.html.includes("lub telefonicznie +48 22 678 22 22 lub +48 504 155 222."),
  mail.html.match(/lub telefonicznie[^<]*/)?.[0]
);
ok("zamknięcie nie ma „· tel.”", !/telefonicznie[^<]*·\stel\./.test(mail.html));
ok("text ma telefony w wersji do zdania", mail.text.includes("+48 22 678 22 22 lub +48 504 155 222."));
ok("text nie ma „· tel.” w zdaniu o kontakcie", !/kontakt:[^\n]*·\stel\./.test(mail.text), mail.text.match(/kontakt:[^\n]*/)?.[0]);
ok("stopka nadal ma pełne dane telefoniczne", mail.html.includes("tel./fax +48 22 678 22 22 · tel. +48 504 155 222"));

// Preheader — tekst obok tematu na liście wiadomości. Musi być PIERWSZYM
// tekstem w <body>, inaczej klient pocztowy weźmie „Dzień dobry…”.
ok(
  "klient: preheader z numerem i obiektem",
  mail.html.includes("Zlecenie ZDW/2026/0042 — Osiedle Zielona Dolina"),
  mail.html.match(/<body[\s\S]{0,320}/)?.[0]
);
ok(
  "klient: preheader jest ukryty i tuż po <body>",
  /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<div style="display:none;max-height:0;overflow:hidden;/.test(mail.html)
);

// Logo jest granatowe, pasek nagłówka też — bez białej podkładki znak znika.
// Podkładka ma być KOŁEM: komórka liczy się w content-box, więc 56px + 2×6px
// paddingu daje 68×68. Z width:68px wychodziła elipsa 80×70.
ok(
  "logo ma białe kółko pod spodem",
  /<td width="68" height="68" align="center" valign="middle" style="width:56px;height:56px;padding:6px;border-radius:50%;background:#ffffff;line-height:0;">/.test(mail.html),
  mail.html.match(/<td width="\d+"[^>]*>/)?.[0]
);
ok("logo jako blok 56×56", mail.html.includes('style="display:block;width:56px;height:56px;border:0;"'));

ok("text zawiera numer zlecenia", mail.text.includes("ZDW/2026/0042"));
ok("text zawiera nazwę obiektu", mail.text.includes("Osiedle Zielona Dolina"));
ok("text nie ma znaczników HTML", !/<[a-z/][^>]*>/i.test(mail.text), mail.text.match(/<[a-z/][^>]*>/i)?.[0]);

const NOISE = /\b(null|undefined|NaN|Invalid Date)\b/;
ok("html bez null/undefined", !NOISE.test(mail.html), mail.html.match(NOISE)?.[0]);
ok("text bez null/undefined", !NOISE.test(mail.text), mail.text.match(NOISE)?.[0]);

// ---------------------------------------------------------------------------
// 2. Zlecenie prawie puste — puste pola mają zniknąć, a nie pokazać „null"
// ---------------------------------------------------------------------------

const bare: OrderMailInput = {
  orderNumber: "ZDW/2026/0001",
  requesterName: null as unknown as string,
  objectName: "Sklep przy rynku",
  monthlyAmount: null,
  contractLengthMonths: null,
  rentalAmount: null,
  serviceStartDate: null,
  installationStartDate: "nie-data",
  contactPerson: null as unknown as string,
  notes: "   ",
};

const bareMail = buildOrderConfirmationMail(bare);

ok("puste zlecenie: html bez null/undefined", !NOISE.test(bareMail.html), bareMail.html.match(NOISE)?.[0]);
ok("puste zlecenie: text bez null/undefined", !NOISE.test(bareMail.text), bareMail.text.match(NOISE)?.[0]);
ok("puste zlecenie: neutralne powitanie", bareMail.html.includes("Dzień dobry,"));
ok("puste zlecenie: brak sekcji Terminy", !bareMail.html.includes("Terminy"));
ok("puste zlecenie: brak sekcji Uwagi", !bareMail.html.includes(">Uwagi<"));
ok("puste zlecenie: brak sekcji Osoba kontaktowa", !bareMail.html.includes("Osoba kontaktowa na obiekcie"));
ok("puste zlecenie: nazwa obiektu jest", bareMail.html.includes("Sklep przy rynku"));
ok("bez baseUrl logo zostaje względne", bareMail.html.includes('src="/alfa-logo.png"'));

// ---------------------------------------------------------------------------
// 3. Escapowanie
// ---------------------------------------------------------------------------

const nasty: OrderMailInput = {
  orderNumber: "ZDW/2026/<9>",
  requesterName: 'Ewa "Test" & Syn',
  objectName: "<script>alert(1)</script>",
  notes: "Uwaga <b>pogrubiona</b>\ndruga linia",
};

const nastyMail = buildOrderConfirmationMail(nasty);

ok("escapuje < w nazwie obiektu", nastyMail.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
ok("nie przepuszcza surowego <script>", !nastyMail.html.includes("<script>"));
ok("escapuje < w numerze zlecenia", nastyMail.html.includes("ZDW/2026/&lt;9&gt;"));
ok("escapuje & i cudzysłów w powitaniu", nastyMail.html.includes("Ewa &quot;Test&quot; &amp; Syn"));
ok("escapuje uwagi, ale zachowuje łamanie linii", nastyMail.html.includes("Uwaga &lt;b&gt;pogrubiona&lt;/b&gt;<br>druga linia"));

// ---------------------------------------------------------------------------
// 4. Wariant wewnętrzny — komplet danych
// ---------------------------------------------------------------------------

const internal = buildOrderInternalMail(
  {
    ...full,
    status: "in_progress",
    payerContractorId: 77,
    objectId: 88,
    createdAt: "2026-03-01 09:15:00",
    updatedAt: "2026-03-02 11:45:00",
  },
  { baseUrl: "https://app.example.invalid/" }
);

ok("wewn.: temat ma prefiks [ZDW]", internal.subject.startsWith("[ZDW] Nowe zlecenie "), internal.subject);
ok("wewn.: temat zawiera numer zlecenia", internal.subject.includes("ZDW/2026/0042"), internal.subject);
ok("wewn.: temat zawiera płatnika", internal.subject.includes("Firma Testowa Sp. z o.o."), internal.subject);
ok("wewn.: temat zawiera obiekt", internal.subject.includes("Osiedle Zielona Dolina"), internal.subject);

ok("wewn.: nagłówek to „Zlecenie {numer}”", internal.html.includes("Zlecenie ZDW/2026/0042"));
ok("wewn.: plakietka statusu po polsku", internal.html.includes("W realizacji"));
ok(
  "wewn.: preheader z płatnikiem, obiektem i statusem",
  internal.html.includes("Firma Testowa Sp. z o.o. / Osiedle Zielona Dolina · W realizacji"),
  internal.html.match(/<body[\s\S]{0,400}/)?.[0]
);
ok(
  "wewn.: preheader jest ukryty i tuż po <body>",
  /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<div style="display:none;max-height:0;overflow:hidden;/.test(internal.html)
);
ok(
  "wewn.: logo ma białe kółko pod spodem",
  /<td width="68" height="68" align="center" valign="middle" style="width:56px;height:56px;padding:6px;border-radius:50%;background:#ffffff;line-height:0;">/.test(internal.html)
);
// Reguła odwrotna do klienckiej: tu „Nie” jest informacją, nie brakiem oferty.
ok("wewn.: zachowuje odpowiedzi „Nie”", internal.html.includes("Grupa interwencyjna"));

// Wszystkie sekcje i etykiety, na które ktoś w zespole będzie patrzył.
const LABELS = [
  "Osoba zlecająca", "Imię i nazwisko", "Telefon", "E-mail",
  "Płatnik", "Nazwa", "NIP", "E-mail do faktur", "Wystawca faktury", "Kontrahent w CRM",
  "Obiekt", "Nazwa obiektu", "Rodzaj obiektu", "Adres", "Miejscowość", "Lokalizacja", "Obiekt w CRM",
  "Osoba kontaktowa na obiekcie", "Osoba kontaktowa",
  "Zakres i dane techniczne", "Montaż kamer", "Liczba kamer", "Liczba megafonów",
  "Numer oferty Vtools", "Internet w ramach usługi", "Grupa interwencyjna", "Wideo recepcja",
  "Finanse", "Abonament netto/mies.", "Długość umowy", "Dzierżawa netto/mies.",
  "Długość dzierżawy", "Wartość łączna",
  "Terminy", "Start usługi", "Start montażu",
  "Uwagi",
  "Metadane", "ID zlecenia", "Status", "Utworzono", "Zaktualizowano",
];
const missingFull = LABELS.filter((l) => !internal.html.includes(l));
ok("wewn.: html ma wszystkie etykiety", missingFull.length === 0, missingFull);

ok("wewn.: telefon jako link tel:", internal.html.includes('href="tel:600100200"'));
ok("wewn.: e-mail jako link mailto:", internal.html.includes('href="mailto:anna.kowalska@firma.invalid"'));
ok("wewn.: link do kontrahenta w CRM", internal.html.includes('href="https://app.example.invalid/contractors"'));
// Trasy /contractors/:id nie ma — wartość musi mówić, dokąd link naprawdę prowadzi.
ok("wewn.: kontrahent oznaczony jako lista", internal.html.includes("#77 (lista kontrahentów)"), internal.text.match(/Kontrahent w CRM:.*/)?.[0]);
ok("wewn.: link do obiektu w CRM", internal.html.includes('href="https://app.example.invalid/objects/88"'));
ok(
  "wewn.: przycisk „Otwórz zlecenie w CRM”",
  internal.html.includes("Otwórz zlecenie w CRM") &&
    internal.html.includes('href="https://app.example.invalid/orders/1"')
);

// 1250,50 × 24 + 480 × 36 = 30 012 + 17 280 = 47 292
ok("wewn.: wartość łączna policzona", /47 ?292,00 zł netto/.test(internal.html), internal.html.match(/4[0-9 ]*292[^<]*/)?.[0]);
ok(
  "wewn.: tak/nie zamiast true/false",
  internal.html.includes("Tak") && internal.html.includes("Nie") && !/\b(true|false)\b/.test(internal.html)
);
ok(
  "wewn.: metadane z godziną",
  /\d{1,2}\.\d{1,2}\.2026,\s\d{2}:\d{2}/.test(internal.html),
  internal.html.match(/\d{1,2}\.\d{1,2}\.2026,[^<]*/)?.[0]
);
ok("wewn.: uwagi z pełnym tekstem", internal.html.includes("Wjazd na teren od strony"));
ok("wewn.: html bez null/undefined", !NOISE.test(internal.html), internal.html.match(NOISE)?.[0]);
ok("wewn.: html email-safe (bez flex/grid)", !/display:\s*(flex|grid)/i.test(internal.html));
ok("wewn.: html nie ładuje zewnętrznego CSS", !/<link\b/i.test(internal.html));

ok("wewn.: text ma numer i płatnika", internal.text.includes("ZDW/2026/0042") && internal.text.includes("Firma Testowa"));
ok("wewn.: text ma link do CRM", internal.text.includes("https://app.example.invalid/orders/1"));
ok("wewn.: text bez znaczników HTML", !/<[a-z/][^>]*>/i.test(internal.text), internal.text.match(/<[a-z/][^>]*>/i)?.[0]);
ok("wewn.: text bez null/undefined", !NOISE.test(internal.text), internal.text.match(NOISE)?.[0]);

// ---------------------------------------------------------------------------
// 5. Wariant wewnętrzny, puste zlecenie — braki jako „—", sekcje zostają
// ---------------------------------------------------------------------------

const bareInternal = buildOrderInternalMail(bare);

const missingBare = LABELS.filter((l) => !bareInternal.html.includes(l));
ok("wewn. puste: wszystkie etykiety nadal są", missingBare.length === 0, missingBare);
ok(
  "wewn. puste: Numer oferty Vtools ma „—”",
  /Numer oferty Vtools<\/td>\s*<td[^>]*>\s*<span[^>]*>—<\/span>/.test(bareInternal.html),
  bareInternal.html.match(/Numer oferty Vtools[\s\S]{0,240}/)?.[0]
);
ok("wewn. puste: sekcja Uwagi zostaje", bareInternal.html.includes(">Uwagi<"));
ok("wewn. puste: html bez null/undefined", !NOISE.test(bareInternal.html), bareInternal.html.match(NOISE)?.[0]);
ok("wewn. puste: text bez null/undefined", !NOISE.test(bareInternal.text), bareInternal.text.match(NOISE)?.[0]);
ok("wewn. puste: bez Invalid Date przy złej dacie montażu", !bareInternal.html.includes("Invalid"));
ok("wewn. puste: bez baseUrl brak przycisku do CRM", !bareInternal.html.includes("Otwórz zlecenie w CRM"));
ok("wewn. puste: temat z myślnikiem zamiast pustego płatnika", bareInternal.subject.includes("—"), bareInternal.subject);

// ---------------------------------------------------------------------------
// 6. Escapowanie w wariancie wewnętrznym
// ---------------------------------------------------------------------------

const nastyInternal = buildOrderInternalMail(nasty);
ok(
  "wewn.: escapuje <script>",
  !nastyInternal.html.includes("<script>") && nastyInternal.html.includes("&lt;script&gt;")
);
ok(
  "wewn.: uwagi zachowują łamanie linii",
  nastyInternal.html.includes("Uwaga &lt;b&gt;pogrubiona&lt;/b&gt;<br>druga linia")
);

console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
