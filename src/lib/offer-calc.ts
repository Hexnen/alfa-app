/**
 * Kalkulacja oferty — jedno miejsce, z którego biorą się WSZYSTKIE kwoty na
 * dokumencie. Czysta funkcja: żadnej bazy, żadnego HTTP, więc arytmetykę da się
 * przetestować wprost (scripts/test-offer-calc.ts).
 *
 * TRZY STRUMIENIE PIENIĘDZY
 *   jednorazowo — sprzęt i robocizna przy wdrożeniu,
 *   miesięcznie — abonament (analityka, internet, grupa interwencyjna),
 *   dzierżawa   — najem sprzętu: rata = wartość sprzętu × procent roczny / 12.
 *
 * DZIERŻAWA A KWOTA JEDNORAZOWA. Sprzęt oddany w dzierżawę zostaje na ofercie
 * jako WARTOŚĆ INFORMACYJNA (klient widzi, co dostaje), ale wypada z kwoty
 * „do zapłaty” — bo za ten sprzęt płaci ratą, a nie przy odbiorze. Dublowanie
 * go w obu miejscach zawyżałoby ofertę o pełną wartość instalacji.
 *
 * CO NIE WCHODZI DO SUM
 *   - pozycje i sekcje `isOptional` (propozycje dodatkowe),
 *   - sekcje wariantowe, których klient nie wybrał (`variantSelected = false`).
 * Obie grupy są na dokumencie widoczne, tylko liczone osobno.
 *
 * Wszystkie kwoty NETTO.
 */
import type { OfferItem, OfferSection } from "../db/schema.js";
import { marginOf, round2, type Margin } from "./margin.js";

/** Fragment oferty, którego potrzebuje kalkulacja (ułatwia testy). */
export interface OfferCalcInput {
  discountPct: number;
  leaseMode: "none" | "y1" | "y2" | "custom";
  leaseMonths: number | null;
  leaseAnnualRate: number | null;
  leaseIncludeLabour: boolean;
  /** Przewidywany czas kontraktu (mies.); null = okres jak dotąd. */
  contractMonths?: number | null;
}

/** Fragment sekcji potrzebny do rozstrzygnięcia, czy jej pozycje się liczą. */
export type SectionCalcInput = Pick<
  OfferSection,
  "id" | "isOptional" | "variantGroup" | "variantSelected"
>;

export type ItemCalcInput = Pick<
  OfferItem,
  | "sectionId"
  | "qty"
  | "kind"
  | "billing"
  | "unitCost"
  | "unitPrice"
  | "discountPct"
  | "isOptional"
>;

export interface OfferTotals {
  /** Suma pozycji jednorazowych wliczanych do oferty (przed rabatem dokumentu). */
  oneTimePrice: number;
  /**
   * KOSZT WDROŻENIA — co firma wykłada na starcie: sprzęt, robocizna
   * i uruchomienie. Przy dzierżawie to pieniądz wydany w miesiącu zerowym,
   * który wraca dopiero ratami, więc jest to najważniejsza liczba obok raty.
   * null, gdy choć jedna pozycja nie ma znanego kosztu.
   */
  oneTimeCost: number | null;
  /** Rozbicie kosztu wdrożenia: sam sprzęt… */
  oneTimeCostMaterial: number | null;
  /** …oraz robocizna i uruchomienie (wszystko, co nie jest sprzętem). */
  oneTimeCostLabour: number | null;
  monthlyPrice: number;
  monthlyCost: number | null;

  /** Podstawa dzierżawy: sprzęt (+ robocizna, gdy włączona). */
  leaseBase: number;
  /** Rata miesięczna dzierżawy (przed rabatem dokumentu). */
  leaseMonthly: number;
  /**
   * Wartość SAMEGO SPRZĘTU oddanego w dzierżawę — wiersz informacyjny na
   * dokumencie. Świadomie NIE równa się `leaseBase`: przy dzierżawie
   * z robocizną podstawa raty obejmuje też montaż, a podpis „wartość sprzętu"
   * musi mówić prawdę o sprzęcie.
   */
  equipmentValue: number;

  /** Do zapłaty jednorazowo, po wyjęciu dzierżawionego sprzętu i po rabacie. */
  oneTimePayable: number;
  /**
   * Rata i abonament PO rabacie dokumentu. To te liczby idą na wydruk — wersje
   * bez rabatu (`leaseMonthly`, `monthlyPrice`) nie sumowały się do
   * `monthlyTotal` i dokument u klienta pokazywał „100 + 200 = 270".
   */
  leaseMonthlyNet: number;
  monthlyPriceNet: number;
  /** Razem miesięcznie: rata dzierżawy + abonament (po rabacie). */
  monthlyTotal: number;
  /**
   * Pozycje opcjonalne — poza „do zapłaty". ROZDZIELONE na dwa strumienie,
   * bo jedna liczba mieszałaby złotówki jednorazowe z miesięcznymi i klient
   * nie wiedziałby, za co właściwie płaci.
   */
  optionsOneTime: number;
  optionsMonthly: number;

  /**
   * Okres (w miesiącach), na którym liczona jest marża: przewidywany czas
   * kontraktu, a gdy go nie podano — długość dzierżawy, a bez niej 12 miesięcy.
   * Front i wydruk podpisują nim marżę, żeby nie było wątpliwości, czego
   * dotyczy procent.
   */
  marginHorizonMonths: number;
  /** Skąd wziął się ten okres — ekran ma powiedzieć wprost, czym jest liczba. */
  horizonSource: "contract" | "lease" | "default";
  /** Przychód i koszt w tym okresie — z nich liczy się `margin`. */
  horizonRevenue: number;
  horizonCost: number | null;

  /** Marża całej oferty w okresie `marginHorizonMonths`; null przy nieznanym koszcie. */
  margin: Margin | null;

  /*
   * PODZIAŁ ZYSKU. Marża mówi, ile zostaje na ofercie RAZEM; nie mówi, ile
   * z tego zostaje firmie, bo handlowiec ma prowizję od przychodu. Rozdzielamy
   * to na dwie liczby, żeby na dole oferty dało się przeczytać wprost: tyle
   * kosztuje wdrożenie, tyle zarabia firma, tyle zarabia handlowiec.
   */
  /** Stawka prowizji handlowca przypisanego do oferty (%); null = brak handlowca albo stawki. */
  salesCommissionPct: number | null;
  /** Prowizja w kwocie: procent od ZYSKU oferty w okresie `marginHorizonMonths`. */
  salesCommission: number | null;
  /** Zysk firmy po odjęciu prowizji; null przy nieznanym koszcie. */
  companyProfit: number | null;
  /** Ten zysk jako procent przychodu w okresie — „marża po prowizji". */
  companyProfitPct: number | null;
  /** Czy marża spadła poniżej progu `company.min_margin_pct`. */
  belowMinMargin: boolean;
}

/** Wartość pozycji po rabacie pozycji (bez rabatu na cały dokument). */
export function lineTotal(item: Pick<ItemCalcInput, "qty" | "unitPrice" | "discountPct">): number {
  return round2(item.qty * item.unitPrice * (1 - (item.discountPct || 0) / 100));
}

/** Koszt pozycji; null = koszt nieznany, co unieważnia marżę całej sumy. */
export function lineCost(item: Pick<ItemCalcInput, "qty" | "unitCost">): number | null {
  if (item.unitCost === null || item.unitCost === undefined) return null;
  return round2(item.qty * item.unitCost);
}

/**
 * Sumuje koszty pozycji. Wystarczy JEDNA pozycja bez znanego kosztu, żeby suma
 * była `null` — inaczej marża oferty liczyłaby się z niepełnych danych i
 * wychodziła zawyżona, czyli dokładnie odwrotnie niż powinna ostrzegać.
 */
function sumCosts(items: ItemCalcInput[]): number | null {
  let total = 0;
  for (const it of items) {
    const c = lineCost(it);
    if (c === null) return null;
    total += c;
  }
  return round2(total);
}

/** Liczba miesięcy dzierżawy wynikająca z trybu. */
export function leaseMonthsOf(offer: Pick<OfferCalcInput, "leaseMode" | "leaseMonths">): number | null {
  switch (offer.leaseMode) {
    case "y1":
      return 12;
    case "y2":
      return 24;
    case "custom":
      return offer.leaseMonths && offer.leaseMonths > 0 ? offer.leaseMonths : null;
    default:
      return null;
  }
}

/**
 * Czy pozycje sekcji wchodzą do sum.
 *
 * Sekcja wariantowa liczy się tylko wtedy, gdy jest wybrana; sekcja opcjonalna
 * nigdy nie wchodzi do „do zapłaty" (jej pozycje trafiają do `optionsTotal`).
 */
function sectionCounts(section: SectionCalcInput | undefined): boolean {
  if (!section) return false;
  if (section.isOptional) return false;
  if (section.variantGroup && !section.variantSelected) return false;
  return true;
}

export function computeOffer(
  offer: OfferCalcInput,
  sections: SectionCalcInput[],
  items: ItemCalcInput[],
  minMarginPct = 0,
  /** Stawka prowizji handlowca z oferty (%); null = brak handlowca albo stawki. */
  salesCommissionPct: number | null = null
): OfferTotals {
  const byId = new Map(sections.map((s) => [s.id, s]));

  const counted: ItemCalcInput[] = [];
  const optional: ItemCalcInput[] = [];
  for (const it of items) {
    const section = byId.get(it.sectionId);
    // Pozycja bez sekcji to uszkodzone dane, a nie propozycja dla klienta.
    // Wrzucenie jej do `optional` wydrukowałoby ją jako „opcję dodatkową",
    // więc znika z dokumentu w całości.
    if (!section) continue;
    // Pozycja z wariantu, którego klient nie wybrał, nie jest nawet „opcją" —
    // to alternatywa dla czegoś innego w ofercie i nigdzie się nie sumuje.
    if (section.variantGroup && !section.variantSelected) continue;
    if (it.isOptional || !sectionCounts(section)) {
      optional.push(it);
      continue;
    }
    counted.push(it);
  }

  const oneTime = counted.filter((i) => i.billing === "one_time");
  const monthly = counted.filter((i) => i.billing === "monthly");

  const oneTimePrice = round2(oneTime.reduce((a, i) => a + lineTotal(i), 0));
  const oneTimeCost = sumCosts(oneTime);
  // Rozbicie kosztu wdrożenia. „Robocizna" zbiera wszystko, co nie jest
  // sprzętem — montaż, uruchomienie i pozycje `other` — bo z punktu widzenia
  // wydatku to jedna kieszeń: praca ludzi zamiast towaru z magazynu.
  const oneTimeCostMaterial = sumCosts(oneTime.filter((i) => i.kind === "material"));
  const oneTimeCostLabour = sumCosts(oneTime.filter((i) => i.kind !== "material"));
  const monthlyPrice = round2(monthly.reduce((a, i) => a + lineTotal(i), 0));
  const monthlyCost = sumCosts(monthly);
  const optionsOneTime = round2(
    optional.filter((i) => i.billing === "one_time").reduce((a, i) => a + lineTotal(i), 0)
  );
  const optionsMonthly = round2(
    optional.filter((i) => i.billing === "monthly").reduce((a, i) => a + lineTotal(i), 0)
  );

  // --- Dzierżawa ---
  const leaseActive =
    offer.leaseMode !== "none" && (offer.leaseAnnualRate ?? 0) > 0;
  const leaseItems = oneTime.filter(
    (i) => i.kind === "material" || (offer.leaseIncludeLabour && i.kind === "labour")
  );
  const leaseBase = leaseActive
    ? round2(leaseItems.reduce((a, i) => a + lineTotal(i), 0))
    : 0;
  const leaseMonthly = leaseActive
    ? round2((leaseBase * (offer.leaseAnnualRate ?? 0)) / 100 / 12)
    : 0;
  // Podpis „wartość sprzętu" ma dotyczyć sprzętu, nawet gdy podstawa raty
  // obejmuje też robociznę.
  const equipmentValue = leaseActive
    ? round2(
        oneTime.filter((i) => i.kind === "material").reduce((a, i) => a + lineTotal(i), 0)
      )
    : 0;

  // --- Rabat na cały dokument ---
  const factor = 1 - (offer.discountPct || 0) / 100;

  // Sprzęt w dzierżawie wypada z kwoty jednorazowej, ale zostaje jako wartość.
  const payableBeforeDiscount = round2(oneTimePrice - leaseBase);
  const oneTimePayable = round2(payableBeforeDiscount * factor);
  // Składniki rabatujemy OSOBNO i z nich składamy sumę, żeby wiersze na
  // dokumencie zgadzały się z podsumowaniem co do grosza.
  const leaseMonthlyNet = round2(leaseMonthly * factor);
  const monthlyPriceNet = round2(monthlyPrice * factor);
  const monthlyTotal = round2(leaseMonthlyNet + monthlyPriceNet);

  /*
   * --- Marża ---
   *
   * Liczymy z tego, co klient FAKTYCZNIE ZAPŁACI, a nie z cen katalogowych.
   * Poprzednia wersja brała `oneTimePrice + monthlyPrice × 12`, czyli pełną
   * cenę sprzedaży sprzętu oddanego w dzierżawę (klient jej nigdy nie płaci)
   * i pomijała ratę (jedyny realny przychód z tego sprzętu). Skutek: marża
   * wychodziła identyczna z dzierżawą i bez niej, a oferta ze stratą pokazywała
   * 40% na zielono.
   *
   * OKRES. Przy dzierżawie sprzęt kupujemy raz, a przychód spływa ratami przez
   * całą umowę — dlatego horyzont to długość dzierżawy, a nie sztywne 12
   * miesięcy. Bez dzierżawy zostaje rok, czyli tyle samo, co dotąd.
   */
  /*
   * OKRES. Przewidywany czas kontraktu wygrywa, bo to świadoma deklaracja „jak
   * długo klient zostanie". Bez niego zostaje stara reguła: przy dzierżawie
   * sprzęt kupujemy raz, a przychód spływa ratami przez całą umowę, więc
   * horyzont to długość dzierżawy; bez dzierżawy rok.
   */
  const leaseHorizon = leaseActive ? leaseMonthsOf(offer) : null;
  const contractMonths =
    offer.contractMonths && offer.contractMonths > 0 ? Math.round(offer.contractMonths) : null;
  const horizon = contractMonths ?? leaseHorizon ?? 12;
  const horizonSource: OfferTotals["horizonSource"] =
    contractMonths !== null ? "contract" : leaseHorizon !== null ? "lease" : "default";

  /*
   * RATA DZIERŻAWY KOŃCZY SIĘ Z UMOWĄ, abonament leci dalej. Przy kontrakcie
   * dłuższym niż dzierżawa (24 mies. dzierżawy w 36-miesięcznym kontrakcie)
   * mnożenie całej kwoty miesięcznej przez horyzont dopisywałoby raty, których
   * klient nigdy nie zapłaci.
   */
  const leaseMonthsPaid = Math.min(horizon, leaseHorizon ?? horizon);
  const horizonRevenue = round2(
    oneTimePayable + leaseMonthlyNet * leaseMonthsPaid + monthlyPriceNet * horizon
  );
  const horizonCost =
    oneTimeCost === null || monthlyCost === null
      ? null
      : round2(oneTimeCost + monthlyCost * horizon);
  const margin = marginOf(horizonCost, horizonRevenue);

  /*
   * PROWIZJA LICZY SIĘ Z ZYSKU, nie z przychodu: handlowiec dostaje procent od
   * tego, co oferta faktycznie zarobiła w okresie `horizon`, a nie od kwoty,
   * którą klient zapłacił. Rabat i drogi sprzęt uderzają więc w prowizję tak
   * samo, jak uderzają w firmę — sprzedaż poniżej kosztów przestaje się opłacać
   * obu stronom.
   *
   * BEZ ZNANEGO KOSZTU NIE MA PROWIZJI (null, nie zero): skoro nie wiemy, ile
   * oferta zarabia, nie wiemy też, ile z tego należy się handlowcowi. Zero
   * wyglądałoby na policzone.
   *
   * UWAGA: Analityka liczy prowizję portfela od PRZYCHODU (revenue × rate) —
   * to inna definicja tej samej stawki i te dwie liczby nie są porównywalne.
   */
  const salesCommission =
    salesCommissionPct === null || salesCommissionPct <= 0 || margin === null
      ? null
      : round2((margin.amount * salesCommissionPct) / 100);
  const companyProfit =
    margin === null ? null : round2(margin.amount - (salesCommission ?? 0));
  const companyProfitPct =
    companyProfit === null || horizonRevenue <= 0
      ? null
      : round2((companyProfit / horizonRevenue) * 100);

  return {
    oneTimePrice,
    oneTimeCost,
    oneTimeCostMaterial,
    oneTimeCostLabour,
    monthlyPrice,
    monthlyCost,
    leaseBase,
    leaseMonthly,
    equipmentValue,
    oneTimePayable,
    leaseMonthlyNet,
    monthlyPriceNet,
    monthlyTotal,
    optionsOneTime,
    optionsMonthly,
    marginHorizonMonths: horizon,
    horizonSource,
    horizonRevenue,
    horizonCost,
    margin,
    salesCommissionPct,
    salesCommission,
    companyProfit,
    companyProfitPct,
    belowMinMargin:
      minMarginPct > 0 &&
      // Rabat 100% daje przychód 0, `marginOf` zwraca wtedy null („nie da się
      // policzyć procentu") — ale koszt jest znany i oddajemy towar za darmo.
      // To najgorszy możliwy przypadek i musi zapalić ostrzeżenie, a nie zgasić je.
      (horizonRevenue <= 0
        ? (horizonCost ?? 0) > 0
        : margin !== null && margin.marginPct < minMarginPct),
  };
}
