/**
 * Wydruki modułu Kadry — zestawienie dla księgowości (A4 poziomo).
 *
 * Wspólny „chrom" wydruków (topbar z logo, granat #14447a, Segoe UI, stopka
 * spółki, okno druku) siedzi TUTAJ i jest importowany przez `hrPrintCash.ts`
 * — inaczej listy kasowe rozjechałyby się wizualnie z zestawieniem po
 * pierwszej poprawce stylu.
 *
 * Dane spółki nie są już wpisane w kodzie: biorą się z `/companies` przez
 * `printCompanyFooter` (patrz komentarz tam — zły NIP na dokumencie jest
 * gorszy niż brak stopki). Zestawienie zbiorcze obejmuje kilka spółek naraz,
 * więc stopkę pokazujemy tylko wtedy, gdy wydruk dotyczy jednej z nich.
 */
import type { HrPayrollRow } from "./api";
import { companyFooterHtml, type PrintCompany } from "./printCompanyFooter";
import { monthYearTitle, nowStamp } from "./plDates";

export const esc = (s: string | null | undefined) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const NAVY = "#14447a";
export const NAVY_DARK = "#0e3560";

const amountFmt = new Intl.NumberFormat("pl-PL", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Kwota bez symbolu waluty — „zł" stoi raz, w nagłówku tabeli. */
export const amt = (v: number | null | undefined) =>
  v == null ? "" : amountFmt.format(v);

/** Godziny: „168" / „7,5" — bez sztucznych zer po przecinku. */
export const hoursTxt = (v: number | null | undefined) =>
  v == null ? "" : String(Math.round(v * 100) / 100).replace(".", ",");

export const contractLabel = (t: string) => (t === "praca" ? "Praca" : "Zlecenie");

/**
 * Skrót spółki z umowy („ALFA S") → pełne dane z `/companies`.
 * Bez dopasowania zwraca `null` i wołający NIE podstawia nic w zamian.
 */
export function findPrintCompany<T extends { name: string }>(
  companies: T[] | undefined,
  name: string | null | undefined,
): T | null {
  if (!companies || !name) return null;
  const needle = name.trim().toLowerCase();
  return companies.find((c) => c.name.trim().toLowerCase() === needle) ?? null;
}

/**
 * NETTO CZY BRUTTO — stoi na każdym wydruku Kadr, przy nagłówku i w kolumnach.
 *
 * Wszystkie kwoty z `hr_payroll` i `hr_office_payroll` są NETTO w sensie
 * kadrowym: „na rękę", po podatku i składkach pracownika, BEZ składek
 * pracodawcy (komentarz nad tabelami w `src/db/schema.ts`; aplikacja kwot
 * brutto w ogóle nie zna — księgowość podaje wyłącznie netto). To inne „netto"
 * niż handlowe „bez VAT", więc na dokumencie mówimy to pełnym zdaniem, a nie
 * samym słowem „netto".
 */
export const AMOUNTS_NOTE = "wszystkie kwoty netto (do wypłaty)";
export const AMOUNTS_META = "wszystkie netto — do wypłaty „na rękę”, w zł";

/**
 * Składa opis filtrów do nagłówka: `joinFilters(["Spółka: ALFA S", gaps !== "all" && "tylko braki"])`.
 * Puste i `false` odpadają, więc wołający pisze warunki w miejscu, gdzie zna stan filtra.
 */
export const joinFilters = (parts: (string | false | null | undefined)[]) =>
  parts.filter((p): p is string => Boolean(p && p.trim())).join("; ");

/** Wspólne opcje wydruków Kadr. */
export interface HrPrintOptions {
  /** Spółki z `getCompanies()` — dopasowywane po `name` (skrót z umowy). */
  companies?: PrintCompany[];
  /** Opis aktywnych filtrów, np. „Spółka: ALFA S; tylko zlecenia". */
  filtersLabel?: string;
}

/**
 * Style wspólne dla wydruków Kadr.
 *
 * `thead { display: table-header-group }` powtarza nagłówek tabeli na każdej
 * stronie — bez tego druga strona zestawienia to kolumna liczb bez opisu.
 * Margines i orientację ustawia `@page`, bo księgowość drukuje to systemowym
 * oknem druku, gdzie nikt nie przestawia orientacji ręcznie.
 */
export function printBaseStyles(opts: { landscape: boolean }): string {
  return `
  @page {
    size: A4 ${opts.landscape ? "landscape" : "portrait"};
    margin: ${opts.landscape ? "10mm 8mm 12mm" : "14mm 12mm 16mm"};
    /* Numeracja stron — respektują ją silniki z CSS Paged Media. Chrome druku-
       je własną stopkę z numerem strony, więc tu jest to zapas, nie podstawa. */
    @bottom-right { content: counter(page) " / " counter(pages); font-size: 8px; color: #8a94a0; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
         font-size: 10px; color: #1c2733; padding: 18px 22px; background: #fff; }

  .topbar { display: flex; align-items: center; gap: 14px;
            border-bottom: 3px solid ${NAVY}; padding-bottom: 10px; margin-bottom: 10px; }
  .topbar img { width: 52px; height: 52px; flex: 0 0 auto; }
  /* min-width: 0 — bez tego długa nazwa spółki ("…SPÓŁKA Z OGRANICZONĄ
     ODPOWIEDZIALNOŚCIĄ") rozpycha flexa i wypycha tytuł poza margines strony. */
  .topbar .co { line-height: 1.45; font-size: 8.5px; color: #5a6673;
                flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .topbar .co b { display: block; font-size: 11.5px; color: ${NAVY_DARK};
                  letter-spacing: 0.4px; margin-bottom: 2px; }
  .topbar .doc { margin-left: auto; text-align: right; flex: 0 0 auto; max-width: 42%; }
  .topbar .doc h1 { font-size: 16px; color: ${NAVY_DARK}; font-weight: 700; }
  .topbar .doc .sub { font-size: 9px; color: #5a6673; margin-top: 3px; }

  .meta { display: flex; flex-wrap: wrap; gap: 6px 18px; background: #f2f6fa;
          border: 1px solid #d5dce4; border-radius: 5px; padding: 5px 10px;
          margin-bottom: 9px; font-size: 8.8px; color: #3d4a58; }
  .meta b { color: ${NAVY_DARK}; }

  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th { background: ${NAVY}; color: #fff; font-size: 7.4px; letter-spacing: 0.4px;
       text-transform: uppercase; padding: 5px 4px; text-align: left;
       vertical-align: bottom; line-height: 1.25; }
  th.r, td.r { text-align: right; }
  th.c, td.c { text-align: center; }
  td { border-bottom: 1px solid #e4e9ef; padding: 3.2px 4px; font-size: 8.4px;
       line-height: 1.3; }
  tbody tr:nth-child(even) td { background: #f7fafc; }
  td.lp { color: #8a94a0; text-align: center; }
  td.num { font-weight: 600; }
  tr.total td { background: #eef3f8; font-weight: 700; border-top: 2px solid ${NAVY};
                border-bottom: none; font-size: 8.8px; }

  .note { margin-top: 9px; font-size: 7.8px; color: #5a6673; line-height: 1.55; }
  .note b { color: ${NAVY_DARK}; }
  .note .warn { color: #a8560b; }

  .footer { margin-top: 16px; border-top: 1px solid #d5dce4; padding-top: 6px;
            text-align: center; font-size: 7.2px; color: #8a94a0; line-height: 1.6; }
  .footer b { color: ${NAVY_DARK}; }

  @media print { body { padding: 0; } .noprint { display: none; } }
  .noprint { text-align: center; margin: 0 0 12px; }
  .noprint button { padding: 9px 26px; font-size: 13px; cursor: pointer;
                    background: ${NAVY}; color: #fff; border: none; border-radius: 6px; }
  .noprint button:hover { background: ${NAVY_DARK}; }
  .noprint a { margin-left: 10px; font-size: 12px; color: ${NAVY}; }`;
}

/** Adres logo działa też poza przeglądarką (render podglądu w Node). */
export const logoUrl = () =>
  typeof window === "undefined"
    ? "/alfa-logo.png"
    : `${window.location.origin}/alfa-logo.png`;

/**
 * Nagłówek dokumentu. `company` = pełne dane jednej spółki (gdy wydruk jej
 * dotyczy), `companyNames` = skróty, gdy wydruk jest zbiorczy — wtedy zamiast
 * zgadywać wystawcę wypisujemy, czyje dane są w środku.
 */
/**
 * Lista spółek w nagłówku — pełna do ośmiu, dalej „i N innych".
 * Grupa ma ich blisko trzydzieści; wypisane w całości zajmowały trzy linijki
 * i spychały tytuł dokumentu poza krawędź strony.
 */
function companyNamesLabel(names: string[], max = 8): string {
  if (names.length <= max) return names.join(", ");
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} i ${rest} ${rest === 1 ? "inna" : "innych"}`;
}

export function printTopbar(o: {
  company?: PrintCompany | null;
  companyNames?: string[];
  title: string;
  subtitle?: string;
}): string {
  const co = o.company
    ? `<div class="co"><b>${esc(o.company.fullName || o.company.name)}</b>${
        [o.company.postalCode, o.company.city].filter(Boolean).join(" ")
          ? `${esc(
              [[o.company.postalCode, o.company.city].filter(Boolean).join(" "), o.company.address]
                .filter(Boolean)
                .join(", "),
            )}<br>`
          : ""
      }${o.company.nip ? `NIP ${esc(o.company.nip)}` : ""}</div>`
    : o.companyNames && o.companyNames.length
      ? `<div class="co"><b>Zestawienie zbiorcze</b>Spółki: ${esc(
          companyNamesLabel(o.companyNames),
        )}</div>`
      : "";
  return `<div class="topbar">
    <img src="${logoUrl()}" alt="">
    ${co}
    <div class="doc">
      <h1>${esc(o.title)}</h1>
      ${o.subtitle ? `<div class="sub">${esc(o.subtitle)}</div>` : ""}
    </div>
  </div>`;
}

/** Stopka z danymi spółki — pusta, gdy spółki nie wskazano (patrz nagłówek pliku). */
export function printFooter(company: PrintCompany | null): string {
  const html = companyFooterHtml(company);
  return html ? `<div class="footer">${html}</div>` : "";
}

/** Pasek meta: okres, data wygenerowania, filtry, liczba wierszy. */
export function metaBar(items: [string, string][]): string {
  return `<div class="meta">${items
    .filter(([, v]) => v)
    .map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`)
    .join("")}</div>`;
}

/** Otwiera okno z gotowym dokumentem i systemowym drukiem (można zapisać PDF). */
export function openPrintWindow(html: string, width = 1180, height = 1100) {
  const win = window.open("", "_blank", `width=${width},height=${height}`);
  if (!win) {
    alert("Przeglądarka zablokowała okno wydruku — zezwól na wyskakujące okna.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
}

/**
 * Wiersze ZZA pod ZUA tej samej osoby.
 *
 * ZZA to nadwyżka ponad normę umowy głównej — czytana osobno mówi tyle co nic,
 * a rozstrzelona po tabeli (np. przy sortowaniu po kwocie) każe księgowości
 * szukać drugiej połowy wypłaty. Kolejność pierwszych wystąpień pracowników
 * zostaje taka, jak przyszła z ekranu — wydruk ma odwzorowywać to, co widać.
 */
export function groupZzaUnderZua(rows: HrPayrollRow[]): HrPayrollRow[] {
  const order: number[] = [];
  const byEmployee = new Map<number, HrPayrollRow[]>();
  for (const r of rows) {
    if (!byEmployee.has(r.employeeId)) {
      byEmployee.set(r.employeeId, []);
      order.push(r.employeeId);
    }
    byEmployee.get(r.employeeId)!.push(r);
  }
  return order.flatMap((id) => {
    const group = byEmployee.get(id)!;
    return [
      ...group.filter((r) => r.registration !== "zza"),
      ...group.filter((r) => r.registration === "zza"),
    ];
  });
}

/** Wiersz wchodzi na zestawienie, jeśli niesie jakiekolwiek godziny albo kwoty. */
const hasContent = (r: HrPayrollRow) =>
  (r.faktGodziny ?? 0) > 0 ||
  r.godzinyDodatek > 0 ||
  r.premiaPotracenie != null ||
  r.kwotaGlowna != null ||
  r.wyplata > 0;

const REG_LABEL: Record<string, string> = { zua: "ZUA", zza: "ZZA" };

const sum = (rows: HrPayrollRow[], pick: (r: HrPayrollRow) => number | null | undefined) =>
  rows.reduce((s, r) => s + (pick(r) ?? 0), 0);

/**
 * HTML zestawienia — wydzielony z `printHrStatement`, żeby dało się je
 * wyrenderować bez przeglądarki (podglądy, testy).
 */
export function hrStatementHtml(
  rows: HrPayrollRow[],
  year: number,
  month: number,
  opts: HrPrintOptions = {},
): string {
  const title = "Zestawienie dla księgowości";
  const period = monthYearTitle(year, month);
  const kept = groupZzaUnderZua(rows.filter(hasContent));
  const skipped = rows.length - kept.length;

  const companyNames = [...new Set(kept.map((r) => r.company).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "pl"),
  );
  const single =
    companyNames.length === 1 ? findPrintCompany(opts.companies, companyNames[0]) : null;

  // Ostrzeżenia nie mieszczą się w tabeli (17 kolumn), więc idą przypisami:
  // numer przy nazwisku odsyła do listy pod tabelą.
  const notes: { no: number; text: string }[] = [];
  const noteNo = new Map<number, number>();
  for (const r of kept) {
    const parts = [...r.warnings];
    // `bonusPending` bywa już opisany w `warnings` („Dodatek do przeliczenia —
    // brak stawki") — bez tego sprawdzenia przypis powtarzał to samo dwa razy.
    if (r.bonusPending && !parts.some((w) => /przelicz/i.test(w))) {
      parts.push("dodatek do przeliczenia (brak stawki dodatku)");
    }
    if (!parts.length) continue;
    const no = notes.length + 1;
    noteNo.set(r.contractId, no);
    notes.push({
      no,
      text: `${r.employeeName}${r.company ? ` (${r.company})` : ""} — ${parts.join("; ")}`,
    });
  }

  const body = kept
    .map((r, i) => {
      const no = noteNo.get(r.contractId);
      return `<tr${r.registration === "zza" ? ' class="zza"' : ""}>
      <td class="lp">${i + 1}</td>
      <td>${esc(r.employeeName)}${no ? `<sup class="wref">${no}</sup>` : ""}</td>
      <td>${esc(r.company)}</td>
      <td class="c">${contractLabel(r.contractType)}</td>
      <td class="c">${r.registration ? REG_LABEL[r.registration] : ""}${r.chor ? " · chor." : ""}</td>
      <td class="r">${hoursTxt(r.maksGodziny)}</td>
      <td class="r num">${hoursTxt(r.faktGodziny)}</td>
      <td class="r">${r.godzinyDodatek ? hoursTxt(r.godzinyDodatek) : ""}</td>
      <td class="r">${amt(r.stawkaNetto)}</td>
      <td class="r num">${amt(r.kwotaGlowna)}</td>
      <td class="r">${amt(r.kwotaWyrownania)}</td>
      <td class="r">${amt(r.kwotaDodatku)}</td>
      <td class="r">${amt(r.premiaPotracenie)}</td>
      <td class="r">${amt(r.dodatekFinalny)}</td>
      <td class="r num">${amt(r.przelew || null)}</td>
      <td class="r num">${amt(r.gotowka || null)}</td>
      <td class="r num">${amt(r.wyplata || null)}</td>
    </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(`${title} — ${period}`)}</title>
<style>${printBaseStyles({ landscape: true })}
  col.c-lp { width: 2.4%; } col.c-name { width: 13%; } col.c-co { width: 6.4%; }
  col.c-type { width: 4.4%; } col.c-reg { width: 5%; } col.c-num { width: 5.73%; }
  td sup.wref { color: #a8560b; font-weight: 700; font-size: 6.6px; margin-left: 2px; }
  tr.zza td:nth-child(2) { padding-left: 12px; color: #3d4a58; font-style: italic; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 Drukuj / zapisz PDF</button></div>

  ${printTopbar({
    company: single,
    companyNames: single ? undefined : companyNames,
    title,
    subtitle: `${period} · ${AMOUNTS_NOTE}`,
  })}

  ${metaBar([
    ["Okres", period],
    ["Wygenerowano", nowStamp()],
    ["Zakres", opts.filtersLabel?.trim() || "wszystkie umowy"],
    ["Wierszy", `${kept.length}${skipped ? ` (pominięto ${skipped} bez godzin i kwot)` : ""}`],
    ["Kwoty", AMOUNTS_META],
  ])}

  <table>
    <colgroup>
      <col class="c-lp"><col class="c-name"><col class="c-co"><col class="c-type"><col class="c-reg">
      ${'<col class="c-num">'.repeat(12)}
    </colgroup>
    <thead>
      <tr>
        <th class="c">Lp.</th>
        <th>Pracownik</th>
        <th>Spółka</th>
        <th class="c">Umowa</th>
        <th class="c">Zgłoszenie</th>
        <th class="r">Maks godzin</th>
        <th class="r">Faktyczne godziny</th>
        <th class="r">Godziny dodatku</th>
        <th class="r">Stawka netto</th>
        <th class="r">Kwota główna netto</th>
        <th class="r">Wyrównanie netto</th>
        <th class="r">Kwota dodatku netto</th>
        <th class="r">Premia / potrącenie netto</th>
        <th class="r">Dodatek finalny netto</th>
        <th class="r">Przelew netto</th>
        <th class="r">Gotówka netto</th>
        <th class="r">Wypłata netto</th>
      </tr>
    </thead>
    <tbody>${body || `<tr><td colspan="17" class="c">Brak wierszy do wydruku</td></tr>`}</tbody>
    <tfoot>
      <tr class="total">
        <td colspan="5" class="r">Razem (${kept.length}):</td>
        <td class="r">${hoursTxt(sum(kept, (r) => r.maksGodziny))}</td>
        <td class="r">${hoursTxt(sum(kept, (r) => r.faktGodziny))}</td>
        <td class="r">${hoursTxt(sum(kept, (r) => r.godzinyDodatek))}</td>
        <td></td>
        <td class="r">${amt(sum(kept, (r) => r.kwotaGlowna))}</td>
        <td class="r">${amt(sum(kept, (r) => r.kwotaWyrownania))}</td>
        <td class="r">${amt(sum(kept, (r) => r.kwotaDodatku))}</td>
        <td class="r">${amt(sum(kept, (r) => r.premiaPotracenie))}</td>
        <td class="r">${amt(sum(kept, (r) => r.dodatekFinalny))}</td>
        <td class="r">${amt(sum(kept, (r) => r.przelew))}</td>
        <td class="r">${amt(sum(kept, (r) => r.gotowka))}</td>
        <td class="r">${amt(sum(kept, (r) => r.wyplata))}</td>
      </tr>
    </tfoot>
  </table>

  <div class="note">
    <b>Faktyczne godziny</b> — godziny do rozliczenia: przy ZUA wypracowane + UW (+ L4 przy umowie
    o pracę), ograniczone do maks; przy ZZA nadwyżka ponad normę umowy głównej.
    <b>Godziny dodatku</b> — nadwyżka ponad maks godziny, płatna wg stawki dodatku.
    <b>Premia / potrącenie</b> — suma DODATKI − POTRĄCENIA z wpisów godzin miesiąca.
    <b>Dodatek finalny</b> = kwota dodatku + premia/potrącenie + wyrównanie.
    <b>Wypłata</b> = przelew + gotówka. Wiersze ZZA stoją pod umową główną tej samej osoby.
    <b>Kwoty</b> — wszystkie NETTO w rozumieniu kadrowym: do wypłaty „na rękę”, po podatku
    i składkach pracownika, bez składek pracodawcy. Kwot brutto ten wydruk nie zawiera.
    ${
      notes.length
        ? `<div class="warn" style="margin-top:5px">Uwagi: ${notes
            .map((n) => `<sup>${n.no}</sup> ${esc(n.text)}`)
            .join(" · ")}</div>`
        : ""
    }
  </div>

  ${printFooter(single)}
</body>
</html>`;
  return html;
}

/** Zestawienie dla księgowości — A4 poziomo, okno z podglądem i drukiem. */
export function printHrStatement(
  rows: HrPayrollRow[],
  year: number,
  month: number,
  opts: HrPrintOptions = {},
) {
  openPrintWindow(hrStatementHtml(rows, year, month, opts), 1240, 1100);
}
