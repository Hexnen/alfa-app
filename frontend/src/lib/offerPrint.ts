/**
 * Dokument oferty w brandzie Alfa Group — układ wzorowany na `quotePrint.ts`
 * (ten sam nagłówek, kolorystyka i mechanika `window.print()`; w projekcie nie
 * ma serwerowego generowania PDF, „zapisz PDF" to miejsce docelowe w oknie druku).
 *
 * Różnice wobec wyceny wynikają z tego, czym oferta jest: trzy strumienie
 * pieniędzy (jednorazowo / abonament / dzierżawa), sekcje zamiast płaskiej
 * listy, pozycje opcjonalne poza sumą i — w wersji wewnętrznej — koszty z marżą.
 *
 * DWA POKRĘTŁA, KTÓRE NIE ZNACZĄ TEGO SAMEGO:
 *
 *   `audience`  — DLA KOGO jest dokument. Steruje TREŚCIĄ: wersja kliencka gubi
 *                 uwagi wewnętrzne i niewybrane warianty, a zyskuje blok
 *                 Sprzedawca/Nabywca, pasek ważności i miejsce na podpisy.
 *   `withCosts` — czy pokazać koszty i marżę. Honorowane WYŁĄCZNIE przy
 *                 `audience: "internal"`; dla klienta jest twardo wyłączone,
 *                 żeby samo `withCosts: true` nigdy nie wypuściło kosztów na
 *                 zewnątrz. Wywołujący i tak zwykle podaje tu `showCosts`, bo
 *                 bez uprawnienia backend nie przysyła `unitCost` ani `margin`.
 *
 * SKOS „DOKUMENT WEWNĘTRZNY" IDZIE ZA `audience`, NIE ZA `withCosts`. Wcześniej
 * wydruk użytkownika bez dostępu do kosztów nie miał znaku wodnego i na pierwszy
 * rzut oka był nie do odróżnienia od wersji dla klienta — czyli dokładnie ta
 * pomyłka, przed którą skos ma chronić. Teraz każdy wydruk wewnętrzny jest
 * oznaczony, zmienia się tylko podtytuł.
 */
import type {
  OfferItemBilling,
  OfferKind,
  OfferSectionCategory,
} from "./api";
import { mdToHtml } from "./markdownLite";
import {
  companyAddressLine,
  companyFooterHtml,
  type PrintCompany,
} from "./printCompanyFooter";
import { fmtPct, fmtPln, fmtQty, OFFER_KIND_LABEL } from "@/components/offers/offersShared";

const esc = (s: string | null | undefined) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const NAVY = "#14447a";
const NAVY_DARK = "#0e3560";

/** 210 mm przy 96 dpi — szerokość kartki A4 w pikselach CSS. */
export const PAGE_WIDTH_PX = 794;

export type OfferAudience = "internal" | "client";

/**
 * MINIMALNY kształt danych, z którego da się złożyć dokument.
 *
 * Celowo nie jest to `OfferDetail`: strona publiczna dostaje z backendu wąską,
 * białą listę pól (bez kosztów, bez uwag, bez wariantów) i musi renderować
 * DOKŁADNIE ten sam dokument. Pola wewnętrzne są tu opcjonalne, więc strukturalnie
 * pasuje i pełne `OfferDetail` z aplikacji, i okrojone `PublicOfferDetail`.
 */
export interface OfferDocInput {
  offer: {
    number: string;
    version: number;
    date: string;
    validUntil: string | null;
    kind: OfferKind;
    clientName: string;
    clientNip: string;
    site: string;
    address: string;
    discountPct: number;
    leaseMode: string;
    leaseMonthsEffective?: number | null;
    /** Kto wykonał ofertę — pod numerem w nagłówku. */
    preparedBy?: string | null;
    /** Wewnętrzne — na wersji dla klienta pomijane. */
    notes?: string | null;
  };
  sections: {
    id: number;
    title: string;
    category?: OfferSectionCategory;
    position: number;
    isOptional: boolean;
    /** Wewnętrzne — u klienta warianty są rozstrzygnięte po stronie serwera. */
    variantGroup?: string | null;
    variantSelected?: boolean;
  }[];
  items: {
    sectionId: number;
    position: number;
    name: string;
    unit: string;
    qty: number;
    unitPrice: number;
    discountPct: number;
    isOptional: boolean;
    billing: OfferItemBilling;
    lineTotal: number;
    /** Widoczne tylko z uprawnieniem do kosztów. */
    unitCost?: number | null;
  }[];
  texts?: { title: string; body: string }[];
  totals: {
    oneTimePayable: number;
    equipmentValue: number;
    leaseMonthlyNet: number;
    monthlyPrice: number;
    monthlyPriceNet: number;
    monthlyTotal: number;
    leaseMonthly: number;
    optionsOneTime: number;
    optionsMonthly: number;
    // --- tylko wersja wewnętrzna ---
    oneTimeCost?: number | null;
    oneTimeCostMaterial?: number | null;
    oneTimeCostLabour?: number | null;
    horizonCost?: number | null;
    marginHorizonMonths?: number;
    margin?: { marginPct: number } | null;
  };
}

export interface OfferDocOptions {
  /** Odbiorca dokumentu. Domyślnie „internal" — zgodność z dotychczasowym wywołaniem. */
  audience?: OfferAudience;
  /** Kolumny kosztu i marży. Honorowane WYŁĄCZNIE przy `audience: "internal"`. */
  withCosts?: boolean;
  /** Spółka wystawiająca — dane do stopki i bloku „Sprzedawca". */
  company?: PrintCompany | null;
  /** Przycisk druku w treści. W podglądzie w iframe: `false`. Domyślnie `true`. */
  withPrintButton?: boolean;
  /**
   * Ramka A4 na EKRANIE (podgląd). Bez niej podgląd jest płynnej szerokości
   * i łamie wiersze inaczej niż papier. Reguła siedzi w `@media screen`,
   * więc nie dotyka wydruku.
   */
  pageFrame?: boolean;
}

type DocSection = OfferDocInput["sections"][number];
type DocItem = OfferDocInput["items"][number];

/** Zaokrąglenie do groszy — ta sama konwencja co `round2` w src/lib/margin.ts. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Czy sekcja liczy się do kwoty — to samo kryterium co w offer-calc.ts. */
const isCounted = (s: DocSection) =>
  !s.isOptional && (!s.variantGroup || s.variantSelected);

/**
 * Czy pozycja wchodzi do kwoty oferty — lustro pętli w `computeOffer`:
 * sekcja musi się liczyć I pozycja nie może być opcjonalna.
 */
const isCountedItem = (i: DocItem, s: DocSection) => isCounted(s) && !i.isOptional;

/**
 * Sekcja wraz z wierszami, które faktycznie idą do jej tabeli. Sekcje i wiersze
 * rozdzielamy W JEDNYM miejscu, żeby „Razem w sekcji" sumowało dokładnie to,
 * co stoi w tabeli nad nim — a nie to, co zdarzyło się mieć ten `sectionId`.
 */
interface DocGroup {
  section: DocSection;
  rows: DocItem[];
}

/**
 * Sekcje w kolejności, w jakiej mają iść na papier, już z wierszami.
 *
 * Wewnętrznie: wszystko jak w edytorze — każda sekcja ze wszystkimi pozycjami,
 * pozycje opcjonalne oznaczone plakietką w wierszu.
 *
 * Dla klienta: niewybrane warianty WYPADAJĄ (nie pokazujemy odrzuconej
 * alternatywy), a wszystko, co nie wchodzi do kwoty, ląduje w osobnej grupie
 * „Propozycje dodatkowe" — inaczej suma sekcji czyta się jak część ceny.
 * Dotyczy to TAKŻE pojedynczych pozycji `isOptional` z sekcji głównych:
 * wcześniej zostawały w tabeli sekcji i wchodziły do „Razem w sekcji", a
 * podsumowanie liczyło je osobno — dokument klienta nie sumował się. Teraz
 * wypadają z sekcji macierzystej i tworzą w bloku dodatkowym własną sekcję
 * „<tytuł> — pozycje dodatkowe", żeby klient nadal wiedział, do czego
 * dokładka się odnosi (rabat na kamerę do „Monitoringu", nie do „Abonamentu").
 * Puste sekcje (bez wierszy) wypadają tutaj, a nie przy numerowaniu.
 */
function groupsFor(
  audience: OfferAudience,
  sections: DocSection[],
  items: DocItem[]
): { main: DocGroup[]; optional: DocGroup[] } {
  const itemsOf = (s: DocSection) =>
    items.filter((i) => i.sectionId === s.id).sort((a, b) => a.position - b.position);

  if (audience === "internal") {
    return {
      main: sections
        .map((section) => ({ section, rows: itemsOf(section) }))
        .filter((g) => g.rows.length > 0),
      optional: [],
    };
  }

  const main: DocGroup[] = [];
  const optional: DocGroup[] = [];
  for (const section of sections) {
    if (section.variantGroup && !section.variantSelected) continue;
    const rows = itemsOf(section);
    if (rows.length === 0) continue;
    if (section.isOptional) {
      optional.push({ section, rows });
      continue;
    }
    const counted = rows.filter((i) => isCountedItem(i, section));
    const extras = rows.filter((i) => !isCountedItem(i, section));
    if (counted.length) main.push({ section, rows: counted });
    if (extras.length) {
      optional.push({
        section: { ...section, title: `${section.title} — pozycje dodatkowe`, isOptional: true },
        // Plakietka „opcja" w wierszu jest tu zbędna: cały blok ma nagłówek
        // „Propozycje dodatkowe" i plakietkę na sekcji; kursywa w KAŻDYM
        // wierszu tylko utrudniałaby czytanie cen.
        rows: extras.map((i) => ({ ...i, isOptional: false })),
      });
    }
  }
  return { main, optional };
}

/**
 * Czy wersja dla klienta ma cokolwiek do pokazania: choć JEDNĄ pozycję
 * wliczoną w kwotę (to samo kryterium co `computeOffer`). Same sekcje i pozycje
 * opcjonalne to nie oferta — link u klienta pokazywałby „0,00 zł do zapłaty".
 * Musi używać TEGO SAMEGO filtra co builder, dlatego mieszka tutaj, a nie
 * w komponencie.
 */
export function hasClientContent(detail: OfferDocInput): boolean {
  return groupsFor("client", detail.sections, detail.items).main.length > 0;
}

/** Nazwa pliku przy „Zapisz jako PDF" — ukośniki z numeru psują nazwę. */
const pdfTitle = (number: string) => `Oferta ${number.replace(/\//g, "-")}`;

// ---------------------------------------------------------------------------
// Arkusz stylów
// ---------------------------------------------------------------------------
/*
 * UWAGA: całość siedzi w template literalu — W ŚRODKU NIE MOŻE BYĆ BACKTICKA.
 * Okno wydruku nie ma Tailwinda ani resetu poza zerowaniem marginesów, więc
 * KAŻDY znacznik (także ten z markdownu) potrzebuje tu jawnego stylu.
 */
const STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
         font-size: 11px; color: #1c2733; padding: 26px 34px; background: #fff; }

  /* Podgląd na ekranie udaje kartkę, żeby wiersze łamały się jak na papierze. */
  @media screen {
    body.preview { width: 210mm; padding: 12mm 10mm; margin: 0 auto; }
  }

  .topbar { display: flex; align-items: center; gap: 16px;
            border-bottom: 3px solid ${NAVY}; padding-bottom: 14px; margin-bottom: 18px; }
  .topbar img { width: 64px; height: 64px; }
  .topbar .doc { margin-left: auto; text-align: right; }
  .topbar .doc h1 { font-size: 19px; color: ${NAVY_DARK}; font-weight: 700; }
  .topbar .doc .no { display: inline-block; margin-top: 5px; padding: 3px 12px;
                     background: ${NAVY}; color: #fff; border-radius: 4px;
                     font-size: 11.5px; font-weight: 600; letter-spacing: 0.6px; }
  .topbar .doc .ver { display: block; margin-top: 4px; font-size: 9.5px; color: #5a6673; }
  /* Kto wykonał ofertę — pod numerem, w tej samej kolumnie wyrównanej do prawej. */
  .topbar .doc .by { display: block; margin-top: 5px; font-size: 9.5px; color: #5a6673; }
  .topbar .doc .by b { color: ${NAVY_DARK}; font-size: 10.5px; }

  .meta { border: 1px solid #d5dce4; border-radius: 6px; overflow: hidden;
          margin-bottom: 16px; max-width: 520px; }
  .meta .row { display: flex; border-bottom: 1px solid #edf1f5; }
  .meta .row:last-child { border-bottom: none; }
  .meta .lbl { width: 90px; background: #f2f6fa; color: #5a6673; font-size: 10px; padding: 6px 10px; }
  .meta .val { flex: 1; padding: 6px 10px; font-weight: 600; }

  /* --- Bloki wersji dla klienta --- */
  .parties { display: flex; gap: 12px; margin-bottom: 12px;
             page-break-inside: avoid; break-inside: avoid; }
  .parties .party { flex: 1; border: 1px solid #d5dce4; border-radius: 6px;
                    padding: 8px 10px; line-height: 1.45; }
  .parties .party.solo { flex: 0 1 340px; }
  .parties .plbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.7px;
                   color: ${NAVY}; font-weight: 700; margin-bottom: 3px; }
  .parties b { font-size: 12px; color: ${NAVY_DARK}; display: block; }
  .parties .ids { font-size: 9.5px; color: #5a6673; margin-top: 2px; }

  .place { font-size: 10.5px; margin-bottom: 10px; }
  .place b { color: ${NAVY_DARK}; }

  .validbar { display: flex; justify-content: space-between; gap: 12px; align-items: baseline;
              background: #f2f6fa; border-left: 3px solid ${NAVY}; border-radius: 4px;
              padding: 7px 10px; margin-bottom: 14px; font-size: 10.5px;
              page-break-inside: avoid; break-inside: avoid; }
  .validbar b { color: ${NAVY_DARK}; font-size: 12px; }
  .validbar .net { color: #5a6673; }


  .section { margin-bottom: 14px; break-inside: avoid; }
  .section.muted { opacity: 0.75; }
  .section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .section-head h2 { font-size: 12.5px; color: ${NAVY_DARK}; }
  .secno { display: inline-block; min-width: 16px; color: ${NAVY}; font-weight: 700; }
  .badge { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px;
           padding: 2px 6px; border-radius: 3px; font-weight: 700; }
  .badge.opt { background: #fef3c7; color: #92400e; }
  .badge.alt { background: #e5e7eb; color: #4b5563; }
  .badge.sel { background: #d1fae5; color: #065f46; }
  .badge.mo { background: #d1fae5; color: #065f46; }

  table.items { width: 100%; border-collapse: collapse; }
  /* Sekcja na 40 pozycji i tak się złamie — ma się złamać z nagłówkiem. */
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; break-inside: avoid; }
  table.items th { background: ${NAVY}; color: #fff; font-size: 9px;
                   letter-spacing: 0.8px; text-transform: uppercase;
                   padding: 6px 8px; text-align: left; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items td { border-bottom: 1px solid #e4e9ef; padding: 5px 8px; font-size: 10.5px; }
  table.items tr:nth-child(even) td { background: #f7fafc; }
  td.lp { width: 30px; color: #8a94a0; text-align: center; }
  td.dim { color: #6b7480; }
  td.strong { font-weight: 700; }
  tr.opt-row td { color: #6b7480; font-style: italic; }
  tr.sum-row td { background: #eef3f8 !important; font-size: 10px; color: #43506080; }
  tr.sum-row td.strong { color: ${NAVY_DARK}; }
  /* Cena katalogowa przed rabatem — bez niej Ilość x Cena nie zgadza się z Wartością. */
  .was { color: #8a94a0; margin-right: 4px; font-weight: 400; }
  .per { font-size: 8.5px; color: #6b7480; font-weight: 400; }

  .optgroup { margin-top: 18px; padding-top: 10px; border-top: 2px solid #d5dce4; }
  .optgroup-head { font-size: 12.5px; color: ${NAVY_DARK};
                   page-break-after: avoid; break-after: avoid; }
  .optgroup-note { font-size: 10px; color: #6b7480; margin: 2px 0 8px;
                   page-break-after: avoid; break-after: avoid; }

  .summary { margin-top: 18px; margin-left: auto; max-width: 420px;
             border: 1px solid #d5dce4; border-radius: 6px; overflow: hidden;
             page-break-inside: avoid; break-inside: avoid; }
  .summary .row { display: flex; justify-content: space-between; gap: 16px;
                  padding: 7px 12px; border-bottom: 1px solid #edf1f5; font-size: 11px; }
  .summary .row:last-child { border-bottom: none; }
  .summary .row.info { color: #6b7480; font-size: 10px; background: #fafcfe; }
  .summary .row.total { background: ${NAVY}; color: #fff; font-size: 12.5px; font-weight: 700; }
  .summary .row.cost { background: #fff7ed; color: #9a3412; font-size: 10px; }
  .summary .cap { background: #eef3f8; font-size: 9px; text-transform: uppercase;
                  letter-spacing: 0.7px; color: ${NAVY}; font-weight: 700; }
  .netnote { margin-top: 5px; margin-left: auto; max-width: 420px;
             font-size: 9px; color: #6b7480; text-align: right; }

  .notes { margin-top: 16px; font-size: 10.5px; color: #43506080; white-space: pre-wrap; }

  /* Opisy: pełny kontrast (Uwagi mają 50% alfy), bo to treść ofertowa dla
     klienta, a nie dopisek na marginesie. Blok NIE dostaje break-inside: avoid —
     warunki gwarancji rutynowo przekraczają stronę, a taka reguła wymuszałaby
     pustą kartkę. Zamiast tego trzymamy nagłówki przy treści i pilnujemy sierot. */
  .textblock { margin-top: 16px; padding-top: 10px; border-top: 1px solid #d5dce4;
               font-size: 10.5px; color: #1c2733; line-height: 1.55; }
  .textblock + .textblock { margin-top: 12px; }
  /* Tytuł bloku musi być WIDOCZNIE poziom wyżej niż nagłówek ze środka treści —
     inaczej „Warunki gwarancji" i „Zakres gwarancji" czytają się jak dwa
     równorzędne nagłówki sklejone jeden pod drugim. */
  .textblock h3 { font-size: 11.5px; color: ${NAVY_DARK}; font-weight: 700; margin: 9px 0 4px; }
  .textblock h4 { font-size: 11px; color: ${NAVY}; font-weight: 700; margin: 8px 0 3px; }
  .textblock .tb-title { font-size: 10px; letter-spacing: 0.7px; text-transform: uppercase;
                         color: ${NAVY}; font-weight: 700; margin: 0 0 6px; }
  .textblock h3, .textblock h4, .textblock .tb-title {
    page-break-after: avoid; break-after: avoid; }
  .textblock p { margin-bottom: 5px; }
  .textblock p:last-child { margin-bottom: 0; }
  .textblock ul, .textblock ol { margin: 4px 0 6px; padding-left: 18px; }
  .textblock li { margin-bottom: 2px; }
  .textblock p, .textblock li { page-break-inside: avoid; break-inside: avoid;
                                orphans: 2; widows: 2; }
  .textblock strong { font-weight: 700; color: ${NAVY_DARK}; }

  /* Miejsce na podpisy — 1:1 z protocolPrint.ts, żeby oferta i protokół
     wyglądały na dokumenty tej samej firmy. */
  .accept { margin-top: 22px; page-break-inside: avoid; break-inside: avoid; }
  .accept-note { font-size: 10px; color: #43506080; margin-bottom: 4px; }
  .sign { display: flex; gap: 60px; margin-top: 24px; align-items: flex-end; }
  .sign .slot { flex: 1; text-align: center; }
  .sign .line { border-top: 1.5px solid ${NAVY}; padding-top: 5px;
                font-size: 9.5px; color: #5a6673; }
  .sign .slot-space { height: 52px; }

  .footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #d5dce4;
            font-size: 8.5px; color: #6b7480; line-height: 1.5; }
  /* ZNAK WODNY WERSJI WEWNĘTRZNEJ. Dopisek w stopce dawał się przeoczyć, a
     pomylenie wydruku wewnętrznego z wersją dla klienta kosztuje dużo więcej
     niż odrobina szumu na papierze. Stąd napis po skosie przez całą kartkę:
     nie da się go nie zauważyć ani odciąć nożyczkami.

     Pozycjonowanie fixed powtarza napis na KAŻDEJ stronie wydruku (Chrome),
     a print-color-adjust wymusza druk koloru, który drukarka by wygasiła.
     Zdanie łamiemy na dwie linie, bo skos na A4 ma około 1120 px — jedną linią
     napis nie mieści się w kartce. */
  .wm { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 99; }
  .wm-txt { position: absolute; top: 50%; left: 50%;
            transform: translate(-50%, -50%) rotate(-45deg); transform-origin: center;
            text-align: center; color: #9a3412; opacity: 0.13;
            -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .wm-txt b, .wm-txt i { display: block; white-space: nowrap; font-style: normal;
                         font-weight: 700; text-transform: uppercase; }
  .wm-txt b { font-size: 46px; letter-spacing: 6px; }
  .wm-txt i { font-size: 20px; letter-spacing: 3px; margin-top: 10px; }
  /* Przycisk druku jak w pozostałych wydrukach projektu (quotePrint,
     protocolPrint, hrPrint) — bez niego okno jest tylko podglądem, a użytkownik
     musi sam wpaść na Ctrl+P. */
  @media print { body { padding: 8mm 10mm; } .noprint { display: none; } }
  .noprint { text-align: center; margin: 0 0 14px; }
  .noprint button { padding: 9px 26px; font-size: 13px; cursor: pointer;
                    border: none; border-radius: 5px; background: ${NAVY};
                    color: #fff; font-weight: 600; }
  .noprint button:hover { background: ${NAVY_DARK}; }
  @page { size: A4; margin: 12mm; }
`;

// ---------------------------------------------------------------------------
// Fragmenty dokumentu
// ---------------------------------------------------------------------------

const sectionBadge = (s: DocSection, isClient: boolean) => {
  if (s.isOptional) return `<span class="badge opt">opcja dodatkowa</span>`;
  // U klienta warianty są już rozstrzygnięte — plakietka „wybrany wariant"
  // opisywałaby 100% sekcji wariantowych, czyli nie niosłaby informacji.
  if (isClient) return "";
  if (s.variantGroup && !s.variantSelected)
    return `<span class="badge alt">wariant niewybrany</span>`;
  if (s.variantGroup) return `<span class="badge sel">wybrany wariant</span>`;
  return "";
};

/**
 * Wiersz pozycji.
 *
 * CENA JEDNOSTKOWA JEST EFEKTYWNA (po rabacie pozycji), wyliczona z `lineTotal`,
 * a nie przeliczana od nowa — dzięki temu na papierze `Ilość × Cena = Wartość`
 * zgadza się co do grosza. Przy rabacie pokazujemy przekreśloną cenę katalogową,
 * żeby ustępstwo było widoczne.
 *
 * MARŻA TEŻ Z CENY EFEKTYWNEJ. Wcześniej liczyła się z katalogowego `unitPrice`,
 * więc przy rabacie pozycji dwie sąsiednie kolumny opisywały różne ceny, a
 * marża wiersza nie zgadzała się z marżą sumaryczną w podsumowaniu (ta idzie
 * z `lineTotal`, czyli po rabacie). Backend nie przysyła marży na pozycji,
 * więc liczymy ją tu tak, jak `marginOf` w src/lib/margin.ts: koszt albo cena
 * ≤ 0 to „brak danych" (kreska), nie 100% ani 0%.
 */
function itemRow(i: DocItem, n: number, withCosts: boolean): string {
  const effUnit = i.qty > 0 ? i.lineTotal / i.qty : i.unitPrice;
  const margin =
    withCosts && i.unitCost != null && i.unitCost > 0 && effUnit > 0
      ? ((effUnit - i.unitCost) / effUnit) * 100
      : null;
  const priceCell =
    i.discountPct > 0
      ? `<s class="was">${fmtPln(i.unitPrice)}</s>${fmtPln(effUnit)}`
      : fmtPln(effUnit);
  const monthly = i.billing === "monthly";
  return `<tr${i.isOptional ? ' class="opt-row"' : ""}>
          <td class="lp">${n + 1}</td>
          <td>${esc(i.name)}${i.isOptional ? ' <span class="badge opt">opcja</span>' : ""}${
            monthly ? ' <span class="badge mo">miesięcznie</span>' : ""
          }</td>
          <td class="c">${esc(i.unit)}</td>
          <td class="r">${fmtQty(i.qty)}</td>
          ${withCosts ? `<td class="r dim">${i.unitCost == null ? "—" : fmtPln(i.unitCost)}</td>` : ""}
          <td class="r">${priceCell}</td>
          ${withCosts ? `<td class="r dim">${fmtPct(margin)}</td>` : ""}
          <td class="r strong">${fmtPln(i.lineTotal)}${
            monthly ? '<span class="per"> / mies.</span>' : ""
          }</td>
        </tr>`;
}

/**
 * Tabela jednej sekcji. Suma jest ROZBITA na jednorazową i miesięczną — wcześniej
 * jeden wiersz sumował oba strumienie, więc sekcja „Abonament" drukowała kwotę
 * miesięczną tak, jakby była wartością do zapłaty.
 *
 * WIERSZ SUMY DRUKUJE SIĘ ZAWSZE, gdy sekcja ma pozycje danego strumienia —
 * także przy 0,00 zł. Zero to informacja („w cenie", 100% rabatu), a bez
 * wiersza sekcja wyglądała, jakby jej zapomniano podsumować. Sumy zaokrąglamy
 * do grosza jak `round2` w offer-calc, żeby zgadzały się z podsumowaniem.
 */
function sectionTable(
  s: DocSection,
  rows: DocItem[],
  opts: { withCosts: boolean; isClient: boolean; no?: number }
): string {
  const { withCosts, isClient, no } = opts;
  const colCount = withCosts ? 8 : 6;
  const oneTimeRows = rows.filter((i) => i.billing !== "monthly");
  const monthlyRows = rows.filter((i) => i.billing === "monthly");
  const oneTimeSum = round2(oneTimeRows.reduce((a, i) => a + i.lineTotal, 0));
  const monthlySum = round2(monthlyRows.reduce((a, i) => a + i.lineTotal, 0));

  const sumRow = (label: string, value: string) =>
    `<tr class="sum-row">
          <td colspan="${colCount - 1}" class="r">${label}</td>
          <td class="r strong">${value}</td>
        </tr>`;

  const sums = [
    oneTimeRows.length > 0
      ? sumRow(
          monthlyRows.length > 0 ? "Razem w sekcji (jednorazowo)" : "Razem w sekcji",
          fmtPln(oneTimeSum)
        )
      : "",
    monthlyRows.length > 0
      ? sumRow("Razem w sekcji (miesięcznie)", `${fmtPln(monthlySum)} / mies.`)
      : "",
  ].join("");

  return `
  <div class="section ${isCounted(s) || isClient ? "" : "muted"}">
    <div class="section-head">
      <h2>${no ? `<span class="secno">${no}.</span> ` : ""}${esc(s.title)}</h2>
      ${sectionBadge(s, isClient)}
    </div>
    <table class="items">
      <thead>
        <tr>
          <th class="lp">Lp.</th>
          <th>Pozycja</th>
          <th class="c">J.m.</th>
          <th class="r">Ilość</th>
          ${withCosts ? '<th class="r">Koszt jedn.</th>' : ""}
          <th class="r">Cena jedn.</th>
          ${withCosts ? '<th class="r">Marża</th>' : ""}
          <th class="r">Wartość</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((i, n) => itemRow(i, n, withCosts)).join("")}
        ${sums}
      </tbody>
    </table>
  </div>`;
}

/** Sprzedawca / Nabywca — nagłówek dokumentu handlowego (tylko dla klienta). */
function partiesHtml(offer: OfferDocInput["offer"], company: PrintCompany | null): string {
  const seller = company
    ? (() => {
        const ids = [
          company.nip && `NIP ${esc(company.nip)}`,
          company.regon && `REGON ${esc(company.regon)}`,
          company.krs && `KRS ${esc(company.krs)}`,
        ]
          .filter(Boolean)
          .join(" · ");
        const addr = esc(companyAddressLine(company));
        return `<div class="party">
      <div class="plbl">Sprzedawca</div>
      <b>${esc(company.fullName || company.name)}</b>
      ${addr ? `<div>${addr}</div>` : ""}
      ${ids ? `<div class="ids">${ids}</div>` : ""}
    </div>`;
      })()
    : "";

  // Bez wskazanej spółki NIE podstawiamy wystawcy „na wszelki wypadek" — zły NIP
  // na dokumencie handlowym jest gorszy niż jego brak (patrz printCompanyFooter).
  const buyer = `<div class="party${seller ? "" : " solo"}">
      <div class="plbl">Nabywca</div>
      <b>${esc(offer.clientName) || "—"}</b>
      ${offer.clientNip ? `<div class="ids">NIP ${esc(offer.clientNip)}</div>` : ""}
    </div>`;

  return `<div class="parties">${seller}${buyer}</div>`;
}

/** Blok akceptacji z miejscem na podpisy obu stron. */
const acceptHtml = () => `
  <div class="accept">
    <p class="accept-note">Akceptacja oferty: prosimy o odesłanie podpisanego egzemplarza
       lub potwierdzenie jej przyjęcia w odpowiedzi na wiadomość przesłaną wraz z ofertą.</p>
    <div class="sign">
      <div class="slot">
        <div class="slot-space"></div>
        <div class="line">data i podpis sprzedawcy</div>
      </div>
      <div class="slot">
        <div class="slot-space"></div>
        <div class="line">data i podpis nabywcy</div>
      </div>
    </div>
  </div>`;

/**
 * Opisy (warunki gwarancji, zakres wsparcia) — treść dla klienta. Blok bez
 * tytułu I bez treści pomijamy, żeby pusty wpis z edytora nie zostawiał dziury.
 */
const textBlocksHtml = (texts: { title: string; body: string }[]) =>
  texts
    .filter((b) => b.title.trim() || b.body.trim())
    .map(
      (b) => `
  <div class="textblock">
    ${b.title.trim() ? `<h3 class="tb-title">${esc(b.title)}</h3>` : ""}
    ${mdToHtml(b.body)}
  </div>`
    )
    .join("");

/** Wiersze podsumowania — trzy strumienie pieniędzy plus to, co poza kwotą. */
function summaryRowsHtml(
  detail: OfferDocInput,
  opts: { withCosts: boolean; isClient: boolean }
): string {
  const { offer, totals } = detail;
  const { withCosts, isClient } = opts;
  const leaseActive = offer.leaseMode !== "none" && totals.leaseMonthly > 0;
  const rows: string[] = [];

  if (!isClient || totals.oneTimePayable > 0 || !leaseActive) {
    rows.push(
      `<div class="row"><span>Do zapłaty jednorazowo (netto)</span><b>${fmtPln(
        totals.oneTimePayable
      )}</b></div>`
    );
  }
  if (leaseActive) {
    rows.push(
      `<div class="row info"><span>Wartość sprzętu w dzierżawie (informacyjnie)</span><b>${fmtPln(
        totals.equipmentValue
      )}</b></div>`,
      `<div class="row"><span>Dzierżawa sprzętu${
        offer.leaseMonthsEffective ? ` — ${offer.leaseMonthsEffective} mies.` : ""
      } (netto/mies.)</span><b>${fmtPln(totals.leaseMonthlyNet)}</b></div>`
    );
  }
  if (totals.monthlyPrice > 0) {
    rows.push(
      `<div class="row"><span>Abonament (netto/mies.)</span><b>${fmtPln(
        totals.monthlyPriceNet
      )}</b></div>`
    );
  }
  if (!isClient || totals.monthlyTotal > 0) {
    rows.push(
      `<div class="row total"><span>Razem miesięcznie (netto)</span><b>${fmtPln(
        totals.monthlyTotal
      )}</b></div>`
    );
  }
  const outside = isClient ? "nie wliczone w kwotę" : "poza kwotą";
  if (totals.optionsOneTime > 0) {
    rows.push(
      `<div class="row info"><span>Opcje dodatkowe, jednorazowo (${outside})</span><b>${fmtPln(
        totals.optionsOneTime
      )}</b></div>`
    );
  }
  if (totals.optionsMonthly > 0) {
    rows.push(
      `<div class="row info"><span>Opcje dodatkowe, miesięcznie (${outside})</span><b>${fmtPln(
        totals.optionsMonthly
      )}</b></div>`
    );
  }
  if (offer.discountPct > 0) {
    // Rabat zostaje TAKŻE u klienta: to ustępstwo wliczone już w kwoty powyżej,
    // a jego ukrycie gubi argument sprzedażowy.
    rows.push(
      `<div class="row info"><span>Uwzględniony rabat</span><b>${fmtPct(
        offer.discountPct
      )}</b></div>`
    );
  }
  if (withCosts) {
    // Strona zleceniobiorcy — wyłącznie na wersji wewnętrznej.
    rows.push(
      `<div class="row cost"><span>Koszt wdrożenia (sprzęt ${fmtPln(
        totals.oneTimeCostMaterial ?? 0
      )} + robocizna ${fmtPln(totals.oneTimeCostLabour ?? 0)})</span><b>${fmtPln(
        totals.oneTimeCost ?? 0
      )}</b></div>`
    );
    if (totals.margin) {
      rows.push(
        `<div class="row cost"><span>Koszt łączny / marża za ${totals.marginHorizonMonths} mies.</span><b>${fmtPln(
          totals.horizonCost ?? 0
        )} · ${fmtPct(totals.margin.marginPct)}</b></div>`
      );
    }
  }

  if (rows.length === 0) {
    return `<div class="row"><span>Kwoty do ustalenia — oferta zawiera wyłącznie pozycje opcjonalne.</span></div>`;
  }
  return rows.join("");
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Kompletny dokument HTML — wspólny dla okna wydruku, podglądu i strony klienta. */
export function buildOfferHtml(detail: OfferDocInput, opts: OfferDocOptions = {}): string {
  const audience = opts.audience ?? "internal";
  const isClient = audience === "client";
  // Twardy bezpiecznik: dla klienta koszty nie wychodzą niezależnie od `withCosts`.
  const withCosts = !isClient && (opts.withCosts ?? true);
  const withPrintButton = opts.withPrintButton ?? true;

  const { offer, sections, items } = detail;
  const logoUrl = `${window.location.origin}/alfa-logo.png`;

  // `groupsFor` oddaje już tylko sekcje z wierszami, więc numer to po prostu
  // indeks na liście. Wcześniej numerowaliśmy PRZED odrzuceniem pustych sekcji
  // i dokument klienta zaczynał się od „2.", gdy pierwsza sekcja była pusta.
  const { main, optional } = groupsFor(audience, sections, items);

  const renderGroup = (list: DocGroup[], numbered: boolean) =>
    list
      .map((g, idx) =>
        sectionTable(g.section, g.rows, {
          withCosts,
          isClient,
          no: numbered ? idx + 1 : undefined,
        })
      )
      .join("");

  const mainHtml = renderGroup(main, isClient);
  const optionalHtml = optional.length
    ? `
  <div class="optgroup">
    <h2 class="optgroup-head">Propozycje dodatkowe</h2>
    <p class="optgroup-note">Poniższe pozycje nie są wliczone w kwotę oferty —
       można je zamówić razem z ofertą albo później.</p>
    ${renderGroup(optional, false)}
  </div>`
    : "";

  const emptyMsg = isClient
    ? "Zakres oferty zostanie uzupełniony."
    : "Oferta nie ma jeszcze żadnych pozycji.";
  const bodySections =
    mainHtml || optionalHtml
      ? `${mainHtml}${optionalHtml}`
      : `<p class="notes">${emptyMsg}</p>`;

  // Skos przypięty do ODBIORCY, nie do kosztów — każdy wydruk wewnętrzny ma być
  // rozpoznawalny na pierwszy rzut oka, także ten bez dostępu do kosztów.
  const watermarkHtml = isClient
    ? ""
    : `<div class="wm" aria-hidden="true"><div class="wm-txt">
         <b>Dokument wewnętrzny</b><i>${
           withCosts ? "zawiera koszty własne i marżę" : "wersja robocza — nie dla klienta"
         }</i>
       </div></div>`;

  // --- Nagłówek: klient dostaje blok stron i pasek ważności, wewnętrznie zostaje
  // dotychczasowa tabelka meta.
  let headHtml: string;
  if (isClient) {
    const place =
      offer.site || offer.address
        ? `<div class="place">Miejsce realizacji: <b>${esc(offer.site)}</b>${
            offer.address ? ` — ${esc(offer.address)}` : ""
          }</div>`
        : "";
    const valid = offer.validUntil
      ? `<span>Oferta ważna do <b>${esc(offer.validUntil)}</b></span>`
      : `<span>Termin ważności oferty do uzgodnienia</span>`;
    /*
     * Bez wiersza „Data oferty · Zakres" — decyzja właściciela. Data wystawienia
     * i wewnętrzna nazwa zakresu („Montaż i uruchomienie") nic klientowi nie
     * mówią; termin, który go obchodzi, stoi w pasku ważności obok.
     */
    headHtml = `
  ${partiesHtml(offer, opts.company ?? null)}
  ${place}
  <div class="validbar">${valid}<span class="net">Wszystkie kwoty netto (bez podatku VAT)</span></div>`;
  } else {
    const meta = [
      ["Obiekt", offer.site],
      ["Adres", offer.address],
      ["Klient", offer.clientName],
      ["Data", offer.date],
      ["Ważna do", offer.validUntil || "—"],
      ["Zakres", OFFER_KIND_LABEL[offer.kind]],
    ]
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<div class="row"><div class="lbl">${esc(k)}</div><div class="val">${esc(
            String(v)
          )}</div></div>`
      )
      .join("");
    headHtml = `<div class="meta">${meta}</div>`;
  }

  const footer = companyFooterHtml(opts.company ?? null);
  const bodyClass = [opts.pageFrame ? "preview" : "", isClient ? "client" : ""]
    .filter(Boolean)
    .join(" ");

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(pdfTitle(offer.number))}</title>
<style>${STYLE}</style>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
  ${
    withPrintButton
      ? '<div class="noprint"><button onclick="window.print()">🖨 Drukuj / zapisz PDF</button></div>'
      : ""
  }
  <div class="topbar">
    <img src="${logoUrl}" alt="">
    <div class="doc">
      <h1>Oferta</h1>
      <span class="no">${esc(offer.number)}</span>
      ${offer.version > 1 ? `<span class="ver">wersja ${offer.version}</span>` : ""}
      ${
        // Brak handlowca i autora (null albo pusty ciąg) = brak wiersza, a nie
        // „Wykonanie oferty:" z pustką za dwukropkiem.
        offer.preparedBy?.trim()
          ? `<span class="by">Wykonanie oferty: <b>${esc(offer.preparedBy.trim())}</b></span>`
          : ""
      }
    </div>
  </div>

  ${headHtml}

  ${bodySections}

  <div class="summary">
    ${isClient ? '<div class="row cap"><span>Podsumowanie</span></div>' : ""}
    ${summaryRowsHtml(detail, { withCosts, isClient })}
  </div>
  ${
    isClient
      ? '<p class="netnote">Podane kwoty są kwotami netto i nie zawierają podatku VAT.</p>'
      : ""
  }

  ${!isClient && offer.notes ? `<div class="notes">${esc(offer.notes)}</div>` : ""}
  ${textBlocksHtml(detail.texts ?? [])}
  ${isClient ? acceptHtml() : ""}
  ${footer ? `<div class="footer">${footer}</div>` : ""}
  ${watermarkHtml}
</body>
</html>`;
}

/** Otwiera dokument w nowym oknie; użytkownik drukuje albo zapisuje PDF. */
export function printOffer(detail: OfferDocInput, opts: OfferDocOptions = {}) {
  const html = buildOfferHtml(detail, opts);
  const win = window.open("", "_blank", "width=900,height=1100");
  if (!win) {
    alert("Przeglądarka zablokowała okno wydruku — zezwól na wyskakujące okna.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
}
