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
   * Okres (w miesiącach), na którym liczona jest marża — długość dzierżawy,
   * a bez dzierżawy 12 miesięcy. Front i wydruk podpisują nim marżę, żeby nie
   * było wątpliwości, czego dotyczy procent.
   */
  marginHorizonMonths: number;
  /** Przychód i koszt w tym okresie — z nich liczy się `margin`. */
  horizonRevenue: number;
  horizonCost: number | null;

  /** Marża całej oferty w okresie `marginHorizonMonths`; null przy nieznanym koszcie. */
  margin: Margin | null;
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
  minMarginPct = 0
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
  const horizon = (leaseActive ? leaseMonthsOf(offer) : null) ?? 12;
  const horizonRevenue = round2(oneTimePayable + monthlyTotal * horizon);
  const horizonCost =
    oneTimeCost === null || monthlyCost === null
      ? null
      : round2(oneTimeCost + monthlyCost * horizon);
  const margin = marginOf(horizonCost, horizonRevenue);

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
    horizonRevenue,
    horizonCost,
    margin,
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
