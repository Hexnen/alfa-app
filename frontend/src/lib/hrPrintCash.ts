/**
 * Listy wypłat modułu Kadry: gotówkowa (do podpisu w kasie) i przelewowa
 * (do wklejenia w bankowości) — A4 pionowo, chrom wspólny z `hrPrint.ts`.
 *
 * DLACZEGO PER SPÓŁKA. Gotówkę wypłaca każda spółka ze SWOJEJ kasy, a przelewy
 * idą z jej rachunku — jedna wspólna lista dla całej grupy nie ma gdzie trafić.
 * Stąd sekcja (i nowa strona) na spółkę, suma pod każdą z nich i zbiorcza na
 * końcu, żeby księgowość mogła spiąć całość jednym numerem.
 *
 * Wiersze biura (`HrOfficeRow`) idą na te same listy co ochrona — kasjer nie
 * rozlicza dwóch dokumentów na jedną wypłatę; kolumna „Umowa" mówi „Biuro".
 */
import type { HrOfficeRow, HrPayrollRow } from "./api";
import type { PrintCompany } from "./printCompanyFooter";
import { monthYearLabel, monthYearTitle, nowStamp, ymSlug } from "./plDates";
import {
  amt,
  contractLabel,
  esc,
  findPrintCompany,
  AMOUNTS_META,
  AMOUNTS_NOTE,
  metaBar,
  openPrintWindow,
  printBaseStyles,
  printFooter,
  printTopbar,
  type HrPrintOptions,
} from "./hrPrint";

/** Jedna pozycja listy wypłat — ochrona i biuro sprowadzone do wspólnego kształtu. */
interface PayEntry {
  company: string;
  name: string;
  /** „Praca" / „Zlecenie" / „Biuro" — skąd wynika kwota. */
  contract: string;
  amount: number;
}

const byName = (a: PayEntry, b: PayEntry) => a.name.localeCompare(b.name, "pl");

/**
 * Wybiera wypłaty jednym kanałem (gotówka albo przelew) z obu źródeł.
 *
 * Kwoty < 0,005 zł odpadają razem z zerami: grosz z zaokrąglenia nie jest
 * wypłatą, a wiersz „0,00" na liście do podpisu tylko generuje pytania.
 */
function collect(
  rows: HrPayrollRow[],
  office: HrOfficeRow[],
  channel: "cash" | "transfer",
): PayEntry[] {
  const out: PayEntry[] = [];
  for (const r of rows) {
    const value = channel === "cash" ? r.gotowka : r.przelew;
    if (!(value > 0.005)) continue;
    out.push({
      company: r.company || "—",
      name: r.employeeName,
      contract: contractLabel(r.contractType),
      amount: value,
    });
  }
  for (const o of office) {
    const value = channel === "cash" ? (o.cash ?? 0) : (o.rorBase ?? 0);
    if (!(value > 0.005)) continue;
    out.push({
      company: o.company || "—",
      name: o.employeeName,
      contract: "Biuro",
      amount: value,
    });
  }
  return out;
}

/**
 * Ile wierszy trafi na listę gotówkową / przelewową tego miesiąca.
 *
 * Menu „Wydruki" pyta o to ZANIM pozwoli kliknąć: pusta kartka z nagłówkiem
 * i napisem „brak pozycji" wygląda jak zepsuty wydruk, a nie jak odpowiedź
 * „w tym miesiącu nikt nie bierze gotówki".
 */
export const hrCashCount = (rows: HrPayrollRow[], office: HrOfficeRow[]): number =>
  collect(rows, office, "cash").length;

export const hrTransferCount = (rows: HrPayrollRow[], office: HrOfficeRow[]): number =>
  collect(rows, office, "transfer").length;

/** Komunikaty pustych list — jedno brzmienie w dymku menu i w pasku pod paskiem. */
export const HR_CASH_EMPTY = "Brak wypłat gotówkowych w tym miesiącu";
export const HR_TRANSFER_EMPTY = "Brak przelewów w tym miesiącu";

/** Pozycje pogrupowane po spółce, spółki i nazwiska alfabetycznie. */
function groupByCompany(entries: PayEntry[]): { company: string; items: PayEntry[] }[] {
  const map = new Map<string, PayEntry[]>();
  for (const e of entries) {
    if (!map.has(e.company)) map.set(e.company, []);
    map.get(e.company)!.push(e);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "pl"))
    .map(([company, items]) => ({ company, items: items.sort(byName) }));
}

const total = (items: PayEntry[]) => items.reduce((s, e) => s + e.amount, 0);

/** Nagłówek sekcji spółki — pełna nazwa i NIP, gdy spółka jest w `/companies`. */
function companyHead(company: string, resolved: PrintCompany | null, sumLabel: string): string {
  // Pierwszą linią idzie SKRÓT z umowy („TRUST 6"), bo tak spółkę nazywają
  // wszyscy w firmie i tak podpisana jest kasa. Nazwa z KRS (wersalikami, dwie
  // linijki) jest identyfikacją formalną i siedzi w drugiej linii, przy NIP-ie.
  const formal = [resolved?.fullName, resolved?.city, resolved?.nip && `NIP ${resolved.nip}`]
    .filter(Boolean)
    .join(" · ");
  return `<div class="cohead">
    <div>
      <div class="coname">${esc(company)}</div>
      ${formal ? `<div class="coids">${esc(formal)}</div>` : ""}
    </div>
    <div class="cosum">${esc(sumLabel)}</div>
  </div>`;
}

const EMPTY = `<p class="empty">Brak pozycji do wypłaty w tym miesiącu.</p>`;

/* ------------------------------- gotówka ---------------------------------- */

/** HTML listy gotówkowej — wydzielony, żeby dało się renderować bez przeglądarki. */
export function hrCashListHtml(
  rows: HrPayrollRow[],
  office: HrOfficeRow[],
  year: number,
  month: number,
  opts: HrPrintOptions = {},
): string {
  const title = `Lista wypłat gotówkowych — ${monthYearLabel(year, month)}`;
  const groups = groupByCompany(collect(rows, office, "cash"));
  const grand = groups.reduce((s, g) => s + total(g.items), 0);
  const count = groups.reduce((s, g) => s + g.items.length, 0);

  const sections = groups
    .map((g, gi) => {
      const resolved = findPrintCompany(opts.companies, g.company);
      return `<section class="co-section${gi ? " brk" : ""}">
    ${companyHead(g.company, resolved, `Razem gotówką (netto): ${amt(total(g.items))} zł`)}
    <table>
      <colgroup><col style="width:7%"><col style="width:33%"><col style="width:12%">
        <col style="width:14%"><col style="width:14%"><col style="width:20%"></colgroup>
      <thead>
        <tr>
          <th class="c">Lp.</th><th>Nazwisko i imię</th><th class="c">Umowa</th>
          <th class="r">Kwota gotówką (netto)</th><th class="c">Data odbioru</th><th class="c">Podpis</th>
        </tr>
      </thead>
      <tbody>
        ${g.items
          .map(
            (e, i) => `<tr class="sig">
          <td class="lp">${i + 1}</td>
          <td class="name">${esc(e.name)}</td>
          <td class="c">${esc(e.contract)}</td>
          <td class="r num">${amt(e.amount)}</td>
          <td class="c fill"></td>
          <td class="c fill"></td>
        </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr class="total">
          <td colspan="3" class="r">Razem — ${esc(g.company)} (${g.items.length}):</td>
          <td class="r">${amt(total(g.items))}</td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
    <div class="cashier">
      <div class="slot"><div class="line">wypłacił (data i podpis kasjera)</div></div>
      <div class="slot"><div class="line">zatwierdził</div></div>
    </div>
  </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${printBaseStyles({ landscape: false })}
  ${SECTION_STYLES}
  td.fill { border-bottom: 1px solid #b9c4d0; }
  /* Rubryka na datę i podpis musi mieć co podpisać — stąd wymuszona wysokość. */
  tr.sig td { height: 30px; }
  .cashier { display: flex; gap: 60px; margin-top: 26px; }
  .cashier .slot { flex: 1; }
  .cashier .line { border-top: 1.2px solid ${"#14447a"}; padding-top: 4px;
                   font-size: 8px; color: #5a6673; text-align: center; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 Drukuj / zapisz PDF</button></div>

  ${printTopbar({
    // Nagłówek strony tytułowej NIE nazywa spółki, nawet gdy jest jedna: przy
    // wydruku wielu spółek strona 2 należy już do innej, a szapka zostaje z 1.
    // Spółkę identyfikuje nagłówek sekcji, który stoi na każdej stronie.
    companyNames: groups.map((g) => g.company),
    title: "Lista wypłat gotówkowych",
    subtitle: `${monthYearTitle(year, month)} · ${AMOUNTS_NOTE}`,
  })}

  ${metaBar([
    ["Okres", monthYearTitle(year, month)],
    ["Wygenerowano", nowStamp()],
    ["Zakres", opts.filtersLabel?.trim() || "wszystkie umowy"],
    ["Pozycji", `${count} w ${groups.length} ${groups.length === 1 ? "spółce" : "spółkach"}`],
    ["Kwoty", AMOUNTS_META],
  ])}

  ${sections || EMPTY}

  ${
    groups.length > 1
      ? `<div class="grand">Razem wszystkie spółki (${count}), netto: <b>${amt(grand)} zł</b></div>`
      : ""
  }

  <div class="note">Kwoty NETTO — do wypłaty „na rękę”, po podatku i składkach pracownika,
  bez składek pracodawcy. Kwot brutto ta lista nie zawiera.</div>

  ${printFooter(groups.length === 1 ? findPrintCompany(opts.companies, groups[0].company) : null)}
</body>
</html>`;
}

/**
 * Lista wypłat gotówkowych — A4 pionowo, strona na spółkę.
 *
 * Zwraca `null`, gdy wydruk poszedł, albo powód, dla którego nie poszedł.
 * Zero pozycji NIE otwiera okna: użytkownik dostawał kartkę z nagłówkiem
 * i jednym zdaniem „brak pozycji", czyli wydruk, którego nie zamawiał.
 */
export function printHrCashList(
  rows: HrPayrollRow[],
  office: HrOfficeRow[],
  year: number,
  month: number,
  opts: HrPrintOptions = {},
): string | null {
  if (hrCashCount(rows, office) === 0) return `${HR_CASH_EMPTY} — nie ma czego drukować.`;
  openPrintWindow(hrCashListHtml(rows, office, year, month, opts), 900, 1100);
  return null;
}

/* ------------------------------- przelewy --------------------------------- */

/** HTML listy przelewów — bez rubryki podpisu, bo nikt jej na przelewie nie składa. */
export function hrTransferListHtml(
  rows: HrPayrollRow[],
  office: HrOfficeRow[],
  year: number,
  month: number,
  opts: HrPrintOptions = {},
): string {
  const title = `Lista przelewów — ${monthYearLabel(year, month)}`;
  const groups = groupByCompany(collect(rows, office, "transfer"));
  const grand = groups.reduce((s, g) => s + total(g.items), 0);
  const count = groups.reduce((s, g) => s + g.items.length, 0);

  // Przelewy PŁYNĄ jedna sekcja za drugą, bez łamania strony na spółkę: to jest
  // lista do przepisania w bankowości, a nie dokument kasowy do rozdania. Przy
  // trzydziestu spółkach strona na każdą dawała 31 kartek, w większości pustych.
  // Spółkę i tak widać w kolumnie, więc podział między stronami niczego nie gubi.
  const sections = groups
    .map((g) => {
      const resolved = findPrintCompany(opts.companies, g.company);
      return `<section class="co-section">
    ${companyHead(g.company, resolved, `Razem przelewem (netto): ${amt(total(g.items))} zł`)}
    <table>
      <colgroup><col style="width:8%"><col style="width:42%"><col style="width:18%">
        <col style="width:14%"><col style="width:18%"></colgroup>
      <thead>
        <tr>
          <th class="c">Lp.</th><th>Nazwisko i imię</th><th>Spółka</th>
          <th class="c">Umowa</th><th class="r">Kwota przelewu (netto)</th>
        </tr>
      </thead>
      <tbody>
        ${g.items
          .map(
            (e, i) => `<tr>
          <td class="lp">${i + 1}</td>
          <td class="name">${esc(e.name)}</td>
          <td>${esc(e.company)}</td>
          <td class="c">${esc(e.contract)}</td>
          <td class="r num">${amt(e.amount)}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr class="total">
          <td colspan="4" class="r">Razem — ${esc(g.company)} (${g.items.length}):</td>
          <td class="r">${amt(total(g.items))}</td>
        </tr>
      </tfoot>
    </table>
  </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${printBaseStyles({ landscape: false })}
  ${SECTION_STYLES}
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 Drukuj / zapisz PDF</button></div>

  ${printTopbar({
    companyNames: groups.map((g) => g.company),
    title: "Lista przelewów",
    subtitle: `${monthYearTitle(year, month)} · ${AMOUNTS_NOTE}`,
  })}

  ${metaBar([
    ["Okres", monthYearTitle(year, month)],
    ["Wygenerowano", nowStamp()],
    ["Zakres", opts.filtersLabel?.trim() || "wszystkie umowy"],
    ["Pozycji", `${count} w ${groups.length} ${groups.length === 1 ? "spółce" : "spółkach"}`],
    ["Kwoty", AMOUNTS_META],
  ])}

  ${sections || EMPTY}

  ${
    groups.length > 1
      ? `<div class="grand">Razem wszystkie spółki (${count}), netto: <b>${amt(grand)} zł</b></div>`
      : ""
  }

  <div class="note">Kwoty NETTO — do wypłaty „na rękę”, po podatku i składkach pracownika,
  bez składek pracodawcy. Kwot brutto ta lista nie zawiera.</div>

  ${printFooter(groups.length === 1 ? findPrintCompany(opts.companies, groups[0].company) : null)}
</body>
</html>`;
}

/** Lista przelewów — A4 pionowo. `null` = wydruk poszedł, tekst = powód odmowy. */
export function printHrTransferList(
  rows: HrPayrollRow[],
  office: HrOfficeRow[],
  year: number,
  month: number,
  opts: HrPrintOptions = {},
): string | null {
  if (hrTransferCount(rows, office) === 0) {
    return `${HR_TRANSFER_EMPTY} — nie ma czego drukować.`;
  }
  openPrintWindow(hrTransferListHtml(rows, office, year, month, opts), 900, 1100);
  return null;
}

/* --------------------------------- CSV ------------------------------------ */

/**
 * Komórka TEKSTOWA arkusza. Dwie rzeczy naraz:
 *
 *  1. cytowanie, gdy w treści jest separator, cudzysłów albo koniec wiersza;
 *  2. ochrona przed wstrzyknięciem formuły: Excel i LibreOffice traktują
 *     komórkę zaczynającą się od `=`, `+`, `-`, `@`, tabulatora albo CR jako
 *     FORMUŁĘ, nie tekst. Nazwisko albo nazwa spółki z takim początkiem
 *     (import, literówka, wklejka z maila) wykonałaby się po otwarciu pliku.
 *     Poprzedzamy apostrofem — arkusz pokazuje wtedy dosłowny tekst.
 *
 * Kwoty NIE przechodzą tędy: mają zostać liczbami, żeby dało się je w arkuszu
 * zsumować (i żaden format liczby nie zaczyna się od tych znaków).
 */
const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Lista przelewów jako CSV do arkusza/bankowości.
 *
 * Średnik i przecinek dziesiętny, bo to trafia do polskiego Excela, a CRLF —
 * bo tam też trafia. Świadomie BEZ wiersza sum: plik bywa wklejany wprost do
 * importu przelewów, gdzie „Razem" jest kolejnym zleceniem.
 */
export function hrTransferListCsv(
  rows: HrPayrollRow[],
  office: HrOfficeRow[],
  year: number,
  month: number,
): string {
  const groups = groupByCompany(collect(rows, office, "transfer"));
  const lines = ["Lp.;Nazwisko i imię;Spółka;Umowa;Kwota przelewu netto (zł);Okres"];
  let lp = 0;
  for (const g of groups) {
    for (const e of g.items) {
      lp += 1;
      lines.push(
        [
          String(lp),
          csvCell(e.name),
          csvCell(e.company),
          csvCell(e.contract),
          e.amount.toFixed(2).replace(".", ","),
          ymSlug(year, month),
        ].join(";"),
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Zapisuje CSV listy przelewów na dysk (BOM — inaczej Excel zjada ogonki).
 * Jak wydruki: pusty plik (sam nagłówek) nie powstaje, wraca powód.
 */
export function downloadHrTransferCsv(
  rows: HrPayrollRow[],
  office: HrOfficeRow[],
  year: number,
  month: number,
): string | null {
  if (hrTransferCount(rows, office) === 0) {
    return `${HR_TRANSFER_EMPTY} — plik miałby sam nagłówek.`;
  }
  const csv = hrTransferListCsv(rows, office, year, month);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `przelewy-${ymSlug(year, month)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Zwolnienie od razu po kliknięciu bywa za wcześnie w Safari — stąd opóźnienie.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}

/* --------------------------------- style ---------------------------------- */

const SECTION_STYLES = `
  .co-section { margin-bottom: 18px; }
  .co-section.brk { break-before: page; page-break-before: always; }
  .cohead { display: flex; align-items: flex-end; justify-content: space-between;
            gap: 12px; border-bottom: 1.5px solid #14447a; padding-bottom: 5px;
            margin-bottom: 7px; break-after: avoid; page-break-after: avoid; }
  .cohead > div:first-child { min-width: 0; }
  .cohead .coname { font-size: 11.5px; font-weight: 700; color: #0e3560;
                    overflow-wrap: anywhere; }
  .cohead .coids { font-size: 8px; color: #5a6673; margin-top: 1px;
                   overflow-wrap: anywhere; }
  .cohead .cosum { font-size: 9.6px; font-weight: 700; color: #0e3560;
                   white-space: nowrap; flex: 0 0 auto; }
  td { font-size: 9.6px; padding: 4px 6px; }
  th { font-size: 8px; }
  td.name { font-weight: 600; }
  .grand { margin-top: 14px; text-align: right; font-size: 11px; color: #0e3560;
           border-top: 2px solid #14447a; padding-top: 6px; }
  .empty { padding: 24px; text-align: center; color: #8a94a0; font-size: 10px; }`;
