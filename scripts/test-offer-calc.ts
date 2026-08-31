/**
 * Test arytmetyki ofert — czyste funkcje, bez bazy i bez HTTP:
 *   npx tsx scripts/test-offer-calc.ts
 *
 * Pokrywa: rozwijanie pakietu parametrycznego (8 kamer → 8 kamer + 1 rejestrator
 * + 8 montaży) i sztywnego, zaokrąglanie „jeden na każde osiem", trzy strumienie
 * pieniędzy (jednorazowo / abonament / dzierżawa), regułę „sprzęt w dzierżawie
 * wypada z kwoty do zapłaty, ale zostaje jako wartość", robociznę w podstawie
 * raty i bez niej, rabat na dokument, pozycje opcjonalne, warianty A/B oraz
 * uczciwe `null` marży, gdy choć jedna pozycja nie ma znanego kosztu.
 *
 * Nic nie zapisuje, więc nie ma czego sprzątać.
 */
import {
  computeOffer,
  leaseMonthsOf,
  lineTotal,
  type ItemCalcInput,
  type OfferCalcInput,
  type SectionCalcInput,
} from "../src/lib/offer-calc.js";
import {
  expandPackage,
  normalizeParams,
  parsePackageParams,
  qtyFor,
  type PriceSource,
} from "../src/lib/offer-packages.js";
import type { OfferPackageItem } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Pakiety
// ---------------------------------------------------------------------------

const PARAMS_JSON = JSON.stringify([
  { key: "cameras", label: "Liczba kamer", default: 4, min: 1, max: 64 },
]);

/** Katalog udawany: 1 = kamera, 2 = rejestrator (magazyn), 10 = montaż (usługa). */
const priceSource: PriceSource = {
  cost: (source, id) => {
    if (source === "warehouse") return id === 1 ? 400 : id === 2 ? 800 : null;
    if (source === "service") return id === 10 ? 60 : null;
    return null;
  },
  price: (source, id) => {
    if (source === "warehouse") return id === 1 ? 500 : id === 2 ? 1000 : null;
    if (source === "service") return id === 10 ? 150 : null;
    return null;
  },
  label: (source, id) => {
    if (source === "warehouse")
      return id === 1
        ? { name: "Kamera IP 4MP", unit: "szt" }
        : { name: "Rejestrator 8ch", unit: "szt" };
    if (source === "service") return { name: "Montaż kamery", unit: "szt" };
    return null;
  },
};

let seq = 0;
function pkgItem(over: Partial<OfferPackageItem>): OfferPackageItem {
  seq += 1;
  return {
    id: seq,
    packageId: 1,
    position: seq,
    source: "warehouse",
    warehouseItemId: null,
    serviceId: null,
    name: "",
    unit: "szt",
    kind: "material",
    billing: "one_time",
    qtyBase: 0,
    qtyPerParam: 0,
    paramKey: null,
    qtyRound: "none",
    unitPriceOverride: null,
    ...over,
  } as OfferPackageItem;
}

const cctvItems: OfferPackageItem[] = [
  pkgItem({ source: "warehouse", warehouseItemId: 1, qtyPerParam: 1, paramKey: "cameras" }),
  pkgItem({
    source: "warehouse",
    warehouseItemId: 2,
    qtyPerParam: 0.125,
    paramKey: "cameras",
    qtyRound: "up",
  }),
  pkgItem({
    source: "service",
    serviceId: 10,
    kind: "labour",
    qtyPerParam: 1,
    paramKey: "cameras",
  }),
];

const defs = parsePackageParams(PARAMS_JSON);
ok("parametry pakietu wczytane", defs.length === 1 && defs[0].key === "cameras", defs);

ok(
  "brakujący parametr wpada na wartość domyślną",
  normalizeParams(defs, {}).cameras === 4,
  normalizeParams(defs, {})
);
ok(
  "parametr powyżej maksimum przycięty do 64",
  normalizeParams(defs, { cameras: 999 }).cameras === 64,
  normalizeParams(defs, { cameras: 999 })
);
ok(
  "parametr spoza definicji jest ignorowany",
  normalizeParams(defs, { kosmos: 5 }).kosmos === undefined,
  normalizeParams(defs, { kosmos: 5 })
);

// Zaokrąglenie „jeden na każde osiem" — newralgiczny przypadek 8 × 0.125.
const rec = { qtyBase: 0, qtyPerParam: 0.125, paramKey: "cameras", qtyRound: "up" as const };
ok("8 kamer → 1 rejestrator", qtyFor(rec, { cameras: 8 }) === 1, qtyFor(rec, { cameras: 8 }));
ok("9 kamer → 2 rejestratory", qtyFor(rec, { cameras: 9 }) === 2, qtyFor(rec, { cameras: 9 }));
ok("16 kamer → 2 rejestratory", qtyFor(rec, { cameras: 16 }) === 2, qtyFor(rec, { cameras: 16 }));
ok("1 kamera → 1 rejestrator", qtyFor(rec, { cameras: 1 }) === 1, qtyFor(rec, { cameras: 1 }));

const expandedRes = expandPackage(
  { mode: "parametric", params: PARAMS_JSON },
  cctvItems,
  { cameras: 8 },
  priceSource
);
const expanded = expandedRes.drafts;
ok("znane ceny nie trafiają na listę braków", expandedRes.missingPrices.length === 0, expandedRes.missingPrices);
ok("pakiet rozwija się na 3 pozycje", expanded.length === 3, expanded.length);
ok("8 kamer", expanded[0]?.qty === 8, expanded[0]);
ok("nazwa brana ze źródła, nie z pakietu", expanded[0]?.name === "Kamera IP 4MP", expanded[0]);
ok("cena kamery z katalogu (500)", expanded[0]?.unitPrice === 500, expanded[0]);
ok("koszt kamery z katalogu (400)", expanded[0]?.unitCost === 400, expanded[0]);
ok("1 rejestrator przy 8 kamerach", expanded[1]?.qty === 1, expanded[1]);
ok("8 montaży, rodzaj robocizna", expanded[2]?.qty === 8 && expanded[2]?.kind === "labour", expanded[2]);
ok(
  "pozycja usługowa niesie serviceId, nie warehouseItemId",
  expanded[2]?.serviceId === 10 && expanded[2]?.warehouseItemId === null,
  expanded[2]
);

const zeroCameras = expandPackage(
  { mode: "parametric", params: JSON.stringify([{ key: "cameras", label: "x", default: 0 }]) },
  cctvItems,
  { cameras: 0 },
  priceSource
).drafts;
ok("parametr 0 nie generuje pozycji", zeroCameras.length === 0, zeroCameras);

const fixed = expandPackage(
  { mode: "fixed", params: "[]" },
  [
    pkgItem({ source: "warehouse", warehouseItemId: 2, qtyBase: 1 }),
    pkgItem({ source: "warehouse", warehouseItemId: 1, qtyBase: 4, qtyPerParam: 99, paramKey: "cameras" }),
  ],
  { cameras: 8 },
  priceSource
).drafts;
ok("pakiet sztywny bierze same qtyBase", fixed.length === 2 && fixed[1]?.qty === 4, fixed);

const overridden = expandPackage(
  { mode: "fixed", params: "[]" },
  [pkgItem({ source: "warehouse", warehouseItemId: 1, qtyBase: 1, unitPriceOverride: 333 })],
  {},
  priceSource
).drafts;
ok("cena narzucona przez pakiet wygrywa z katalogową", overridden[0]?.unitPrice === 333, overridden[0]);

// ---------------------------------------------------------------------------
// Kalkulacja oferty
// ---------------------------------------------------------------------------

const noLease: OfferCalcInput = {
  discountPct: 0,
  leaseMode: "none",
  leaseMonths: null,
  leaseAnnualRate: null,
  leaseIncludeLabour: false,
};

function section(over: Partial<SectionCalcInput> & { id: number }): SectionCalcInput {
  return {
    isOptional: false,
    variantGroup: null,
    variantSelected: true,
    ...over,
  } as SectionCalcInput;
}

function item(over: Partial<ItemCalcInput> & { sectionId: number }): ItemCalcInput {
  return {
    qty: 1,
    kind: "material",
    billing: "one_time",
    unitCost: null,
    unitPrice: 0,
    discountPct: 0,
    isOptional: false,
    ...over,
  } as ItemCalcInput;
}

ok("wartość pozycji z rabatem 10%", lineTotal({ qty: 2, unitPrice: 100, discountPct: 10 }) === 180);

// Scenariusz bazowy: 8 kamer × 500 + 1 rejestrator × 1000 = 5000 sprzętu,
// 8 montaży × 150 = 1200 robocizny, abonament 200/mies.
const s1 = [section({ id: 1 })];
const base = [
  item({ sectionId: 1, qty: 8, unitPrice: 500, unitCost: 400 }),
  item({ sectionId: 1, qty: 1, unitPrice: 1000, unitCost: 800 }),
  item({ sectionId: 1, qty: 8, unitPrice: 150, unitCost: 60, kind: "labour" }),
  item({
    sectionId: 1,
    qty: 1,
    unitPrice: 200,
    unitCost: 50,
    kind: "subscription",
    billing: "monthly",
  }),
];

const plain = computeOffer(noLease, s1, base);
ok("jednorazowo = 5000 sprzętu + 1200 robocizny", plain.oneTimePrice === 6200, plain);
ok("koszt jednorazowy = 3200 + 480", plain.oneTimeCost === 4480, plain);
ok("abonament 200/mies.", plain.monthlyPrice === 200, plain);
ok("bez dzierżawy nic nie wypada z kwoty do zapłaty", plain.oneTimePayable === 6200, plain);
ok("bez dzierżawy rata = 0", plain.leaseMonthly === 0, plain);
ok("razem miesięcznie = sam abonament", plain.monthlyTotal === 200, plain);

// --- Dzierżawa: 24% rocznie od 5000 zł sprzętu = 100 zł/mies. ---
const lease: OfferCalcInput = {
  discountPct: 0,
  leaseMode: "y2",
  leaseMonths: 24,
  leaseAnnualRate: 24,
  leaseIncludeLabour: false,
};
const leased = computeOffer(lease, s1, base);
ok("podstawa dzierżawy = sam sprzęt (5000)", leased.leaseBase === 5000, leased);
ok("rata = 5000 × 24% / 12 = 100", leased.leaseMonthly === 100, leased);
ok("wartość sprzętu widoczna jako informacja", leased.equipmentValue === 5000, leased);
ok(
  "sprzęt wypada z kwoty jednorazowej — zostaje sama robocizna (1200)",
  leased.oneTimePayable === 1200,
  leased
);
ok("razem miesięcznie = rata + abonament (300)", leased.monthlyTotal === 300, leased);

const leaseWithLabour = computeOffer({ ...lease, leaseIncludeLabour: true }, s1, base);
ok(
  "z robocizną podstawa rośnie do 6200",
  leaseWithLabour.leaseBase === 6200,
  leaseWithLabour
);
ok("rata z robocizną = 124", leaseWithLabour.leaseMonthly === 124, leaseWithLabour);
ok("do zapłaty jednorazowo spada do 0", leaseWithLabour.oneTimePayable === 0, leaseWithLabour);

ok("tryb y1 to 12 miesięcy", leaseMonthsOf({ leaseMode: "y1", leaseMonths: null }) === 12);
ok("tryb y2 to 24 miesiące", leaseMonthsOf({ leaseMode: "y2", leaseMonths: 99 }) === 24);
ok("custom bierze wpisaną liczbę", leaseMonthsOf({ leaseMode: "custom", leaseMonths: 36 }) === 36);
ok("custom bez liczby = null", leaseMonthsOf({ leaseMode: "custom", leaseMonths: null }) === null);
ok(
  "dzierżawa bez procentu jest nieaktywna",
  computeOffer({ ...lease, leaseAnnualRate: 0 }, s1, base).leaseMonthly === 0
);

// --- Rabat na cały dokument ---
const discounted = computeOffer({ ...noLease, discountPct: 10 }, s1, base);
ok("rabat 10% na kwotę jednorazową (6200 → 5580)", discounted.oneTimePayable === 5580, discounted);
ok("rabat 10% na miesięczną (200 → 180)", discounted.monthlyTotal === 180, discounted);

// --- Pozycje i sekcje opcjonalne ---
const withOption = computeOffer(noLease, [section({ id: 1 }), section({ id: 2, isOptional: true })], [
  ...base,
  item({ sectionId: 2, qty: 1, unitPrice: 900, unitCost: 500 }),
]);
ok("sekcja opcjonalna nie wchodzi do kwoty", withOption.oneTimePrice === 6200, withOption);
ok("…ale liczy się osobno jako opcja (900)", withOption.optionsOneTime === 900, withOption);

const optionalItem = computeOffer(noLease, s1, [
  ...base,
  item({ sectionId: 1, qty: 1, unitPrice: 300, unitCost: 100, isOptional: true }),
]);
ok("pojedyncza pozycja opcjonalna też wypada z sumy", optionalItem.oneTimePrice === 6200, optionalItem);
ok("i ląduje w opcjach (300)", optionalItem.optionsOneTime === 300, optionalItem);

// --- Warianty A/B ---
const variants = computeOffer(
  noLease,
  [
    section({ id: 1 }),
    section({ id: 3, variantGroup: "rejestrator", variantSelected: true }),
    section({ id: 4, variantGroup: "rejestrator", variantSelected: false }),
  ],
  [
    ...base,
    item({ sectionId: 3, qty: 1, unitPrice: 1500, unitCost: 1000 }),
    item({ sectionId: 4, qty: 1, unitPrice: 2500, unitCost: 1800 }),
  ]
);
ok("wybrany wariant wchodzi do sumy (6200 + 1500)", variants.oneTimePrice === 7700, variants);
ok(
  "odrzucony wariant nie wchodzi ani do sumy, ani do opcji",
  variants.optionsOneTime === 0 && variants.optionsMonthly === 0,
  variants
);

// --- Marża i próg ostrzeżenia ---
// Przychód roku: 6200 + 200×12 = 8600; koszt: 4480 + 50×12 = 5080.
ok("marża oferty w ogóle się liczy", plain.margin !== null, plain.margin);
ok(
  "marża = (8600 − 5080) / 8600 ≈ 40,93%",
  plain.margin?.marginPct === 40.93,
  plain.margin
);
ok("bez progu nie ma ostrzeżenia", plain.belowMinMargin === false, plain);
ok(
  "próg 50% zapala ostrzeżenie",
  computeOffer(noLease, s1, base, 50).belowMinMargin === true
);
ok(
  "próg 30% nie zapala ostrzeżenia",
  computeOffer(noLease, s1, base, 30).belowMinMargin === false
);

// Jedna pozycja bez kosztu unieważnia marżę CAŁEJ oferty.
const unknownCost = computeOffer(noLease, s1, [
  ...base,
  item({ sectionId: 1, qty: 1, unitPrice: 1000, unitCost: null }),
]);
ok("koszt sumy = null, gdy choć jedna pozycja go nie ma", unknownCost.oneTimeCost === null, unknownCost);
ok("marża wtedy też null, a nie zawyżona", unknownCost.margin === null, unknownCost);
ok(
  "bez znanej marży nie ma ostrzeżenia o progu",
  computeOffer(noLease, s1, [...base, item({ sectionId: 1, unitPrice: 1000 })], 90)
    .belowMinMargin === false
);

// Pozycja w nieistniejącej sekcji nie może po cichu wejść do kwoty.
const orphan = computeOffer(noLease, s1, [...base, item({ sectionId: 999, unitPrice: 5000 })]);
ok("pozycja bez sekcji nie wchodzi do sumy", orphan.oneTimePrice === 6200, orphan);
ok(
  "…ani do opcji — nie wolno jej wydrukować klientowi jako propozycji",
  orphan.optionsOneTime === 0 && orphan.optionsMonthly === 0,
  orphan
);


// --- Koszt wdrożenia: co firma wykłada na starcie -------------------------
{
  // Sprzęt: 8×400 + 1×800 = 4000. Robocizna: 8×60 = 480. Razem 4480.
  const t = computeOffer(noLease, s1, base);
  ok("koszt wdrożenia = sprzęt + robocizna", t.oneTimeCost === 4480, t);
  ok("z tego sprzęt 4000", t.oneTimeCostMaterial === 4000, t);
  ok("z tego robocizna 480", t.oneTimeCostLabour === 480, t);
  ok(
    "rozbicie sumuje się do całości",
    (t.oneTimeCostMaterial ?? 0) + (t.oneTimeCostLabour ?? 0) === t.oneTimeCost,
    t
  );
  // Abonament jest miesięczny — nie wchodzi do kosztu wdrożenia.
  ok("abonament nie zawyża kosztu wdrożenia", t.monthlyCost === 50, t);

  // Jedna pozycja bez kosztu unieważnia tylko swój kubełek i całość.
  const unknown = computeOffer(noLease, s1, [
    ...base,
    item({ sectionId: 1, qty: 1, unitPrice: 100, unitCost: null, kind: "labour" }),
  ]);
  ok("nieznany koszt robocizny → null w tym kubełku", unknown.oneTimeCostLabour === null, unknown);
  ok("…sprzęt nadal policzony", unknown.oneTimeCostMaterial === 4000, unknown);
  ok("…a całość uczciwie null", unknown.oneTimeCost === null, unknown);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);

// ===========================================================================
// REGRESJE Z BUGHUNTU (2026-08-31)
// Każdy przypadek odtwarza jedno znalezisko w postaci, w jakiej wystąpiło.
// ===========================================================================

// --- Marża musi WIDZIEĆ dzierżawę -----------------------------------------
// Było: `totalPrice` brało pełną cenę sprzedaży sprzętu (klient jej nie płaci)
// i pomijało ratę, więc marża wychodziła identyczna z dzierżawą i bez niej —
// oferta ze stratą pokazywała 40,93% na zielono i nie zapalała progu.
{
  const withLease = computeOffer(
    { discountPct: 0, leaseMode: "y2", leaseMonths: 24, leaseAnnualRate: 24, leaseIncludeLabour: true },
    s1,
    base,
    30
  );
  const withoutLease = computeOffer(noLease, s1, base, 30);
  ok(
    "marża Z dzierżawą różni się od marży bez niej",
    withLease.margin?.marginPct !== withoutLease.margin?.marginPct,
    { lease: withLease.margin?.marginPct, none: withoutLease.margin?.marginPct }
  );
  ok(
    "horyzont marży = okres dzierżawy (24 mies.)",
    withLease.marginHorizonMonths === 24,
    withLease.marginHorizonMonths
  );
  ok("bez dzierżawy horyzont to rok", withoutLease.marginHorizonMonths === 12, withoutLease);
  // Przychód 24 mies. = 0 jednorazowo + 324 × 24 = 7776; koszt = 4480 + 50×24 = 5680.
  ok("przychód horyzontu liczony z rat, nie z cen katalogowych", withLease.horizonRevenue === 7776, withLease);
  ok("koszt horyzontu obejmuje sprzęt kupiony raz", withLease.horizonCost === 5680, withLease);
  ok("marża dzierżawy = 26,96%", withLease.margin?.marginPct === 26.96, withLease.margin);
  ok("…i zapala próg 30%", withLease.belowMinMargin === true, withLease);
}

// --- Rabat 100% nie może wyciszać ostrzeżenia ------------------------------
{
  const free = computeOffer({ ...noLease, discountPct: 100 }, s1, base, 30);
  ok("rabat 100%: przychód zero", free.horizonRevenue === 0, free);
  ok("…koszt nadal znany", free.horizonCost === 5080, free);
  ok("…i ostrzeżenie ZAPALA się, zamiast gasnąć", free.belowMinMargin === true, free);
}

// --- Rabat nie zaniża marży o kwotę, której nie udzielono ------------------
// Było: `factor` mnożył całe `oneTimePrice` razem ze sprzętem w dzierżawie,
// więc rabat wyglądał na większy, niż był, i wywoływał fałszywe alarmy.
{
  const disc = computeOffer(
    { discountPct: 10, leaseMode: "y2", leaseMonths: 24, leaseAnnualRate: 24, leaseIncludeLabour: false },
    s1,
    base,
    0
  );
  // Realnie udzielony rabat: 10% od (1200 do zapłaty + 300/mies × 24).
  const bezRabatu = computeOffer(
    { discountPct: 0, leaseMode: "y2", leaseMonths: 24, leaseAnnualRate: 24, leaseIncludeLabour: false },
    s1,
    base,
    0
  );
  const udzielony = Math.round((bezRabatu.horizonRevenue - disc.horizonRevenue) * 100) / 100;
  ok(
    "rabat zdejmuje dokładnie 10% tego, co klient płaci",
    udzielony === Math.round(bezRabatu.horizonRevenue * 0.1 * 100) / 100,
    { udzielony, bez: bezRabatu.horizonRevenue, z: disc.horizonRevenue }
  );
}

// --- Wiersze miesięczne muszą się sumować do „razem miesięcznie" -----------
// Było: rata i abonament szły na wydruk bez rabatu, a suma z rabatem —
// dokument u klienta pokazywał 100 + 200 = 270.
{
  const d = computeOffer(
    { discountPct: 10, leaseMode: "y2", leaseMonths: 24, leaseAnnualRate: 24, leaseIncludeLabour: false },
    s1,
    base
  );
  const suma = Math.round((d.leaseMonthlyNet + d.monthlyPriceNet) * 100) / 100;
  ok("dzierżawa netto + abonament netto = razem miesięcznie", suma === d.monthlyTotal, {
    rata: d.leaseMonthlyNet,
    abonament: d.monthlyPriceNet,
    razem: d.monthlyTotal,
  });
}

// --- „Wartość sprzętu" to sprzęt, nie sprzęt z montażem --------------------
{
  const withLabour = computeOffer(
    { discountPct: 0, leaseMode: "y2", leaseMonths: 24, leaseAnnualRate: 24, leaseIncludeLabour: true },
    s1,
    base
  );
  ok("podstawa raty z robocizną = 6200", withLabour.leaseBase === 6200, withLabour);
  ok("ale wartość SPRZĘTU to 5000", withLabour.equipmentValue === 5000, withLabour);
}

// --- Opcje rozdzielone na strumienie ---------------------------------------
{
  const mixed = computeOffer(
    noLease,
    [...s1, section({ id: 9, isOptional: true })],
    [
      ...base,
      item({ sectionId: 9, qty: 1, unitPrice: 900, unitCost: 500 }),
      item({ sectionId: 9, qty: 1, unitPrice: 300, unitCost: 100, billing: "monthly", kind: "subscription" }),
    ]
  );
  ok("opcje jednorazowe osobno (900)", mixed.optionsOneTime === 900, mixed);
  ok("opcje miesięczne osobno (300)", mixed.optionsMonthly === 300, mixed);
}

// --- Precyzja mnożnika pakietu ---------------------------------------------
{
  const frac = { qtyBase: 0, qtyPerParam: 0.0625, paramKey: "n", qtyRound: "none" as const };
  ok("0,0625 × 5 = 0,3125 (a nie 0,31)", qtyFor(frac, { n: 5 }) === 0.3125, qtyFor(frac, { n: 5 }));
  ok("0,0625 × 80 = 5", qtyFor(frac, { n: 80 }) === 5, qtyFor(frac, { n: 80 }));
}

// --- Brak ceny w katalogu jest zgłaszany, a nie zamieniany na 0 zł ---------
{
  const res = expandPackage(
    { mode: "fixed", params: "[]" },
    [pkgItem({ source: "warehouse", warehouseItemId: 99, qtyBase: 1, name: "Zniknięty towar" })],
    {},
    priceSource
  );
  ok("pozycja bez ceny trafia na listę braków", res.missingPrices.length === 1, res.missingPrices);
  ok("…pod swoją nazwą", res.missingPrices[0] === "Zniknięty towar", res.missingPrices);
  const zeroOverride = expandPackage(
    { mode: "fixed", params: "[]" },
    [pkgItem({ source: "warehouse", warehouseItemId: 1, qtyBase: 1, unitPriceOverride: 0 })],
    {},
    priceSource
  );
  ok(
    "cena 0 WPISANA w pakiecie jest znana i nie jest brakiem",
    zeroOverride.missingPrices.length === 0 && zeroOverride.drafts[0]?.unitPrice === 0,
    zeroOverride
  );
}
