/**
 * Wydruk oferty w brandzie Alfa Group — układ wzorowany na `quotePrint.ts`
 * (ten sam nagłówek, kolorystyka i mechanika `window.print()`; w projekcie nie
 * ma serwerowego generowania PDF).
 *
 * Różnice wobec wyceny wynikają z tego, czym oferta jest: trzy strumienie
 * pieniędzy (jednorazowo / abonament / dzierżawa), sekcje zamiast płaskiej
 * listy, pozycje opcjonalne poza sumą i — w wersji wewnętrznej — koszty z marżą.
 *
 * `withCosts` steruje wersją: dziś zawsze `true` (wersja wewnętrzna), ale
 * wariant dla klienta to wywołanie z `false`, bez dotykania szablonu.
 */
import type { Company, OfferDetail, OfferSection } from "./api";
import { companyFooterHtml } from "./printCompanyFooter";
import { fmtPct, fmtPln, fmtQty, OFFER_KIND_LABEL } from "@/components/offers/offersShared";

const esc = (s: string | null | undefined) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const NAVY = "#14447a";
const NAVY_DARK = "#0e3560";

interface PrintOptions {
  /** Wersja wewnętrzna: kolumny kosztu i marży. */
  withCosts?: boolean;
  /** Spółka wystawiająca — dane do stopki. */
  company?: Company | null;
}

export function printOffer(detail: OfferDetail, opts: PrintOptions = {}) {
  const withCosts = opts.withCosts ?? true;
  const { offer, sections, items, totals } = detail;
  const logoUrl = `${window.location.origin}/alfa-logo.png`;

  const itemsOf = (s: OfferSection) =>
    items.filter((i) => i.sectionId === s.id).sort((a, b) => a.position - b.position);

  /** Czy sekcja liczy się do kwoty — to samo kryterium co w offer-calc.ts. */
  const isCounted = (s: OfferSection) =>
    !s.isOptional && (!s.variantGroup || s.variantSelected);

  const sectionBadge = (s: OfferSection) => {
    if (s.isOptional) return `<span class="badge opt">opcja dodatkowa</span>`;
    if (s.variantGroup && !s.variantSelected)
      return `<span class="badge alt">wariant niewybrany</span>`;
    if (s.variantGroup) return `<span class="badge sel">wybrany wariant</span>`;
    return "";
  };

  const colCount = withCosts ? 8 : 6;

  const sectionHtml = sections
    .map((s) => {
      const rows = itemsOf(s);
      if (rows.length === 0) return "";
      const sectionSum = rows.reduce((a, i) => a + i.lineTotal, 0);
      return `
  <div class="section ${isCounted(s) ? "" : "muted"}">
    <div class="section-head">
      <h2>${esc(s.title)}</h2>
      ${sectionBadge(s)}
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
        ${rows
          .map((i, n) => {
            const margin =
              withCosts && i.unitCost != null && i.unitPrice > 0
                ? ((i.unitPrice - i.unitCost) / i.unitPrice) * 100
                : null;
            return `<tr${i.isOptional ? ' class="opt-row"' : ""}>
          <td class="lp">${n + 1}</td>
          <td>${esc(i.name)}${i.isOptional ? ' <span class="badge opt">opcja</span>' : ""}</td>
          <td class="c">${esc(i.unit)}</td>
          <td class="r">${fmtQty(i.qty)}</td>
          ${withCosts ? `<td class="r dim">${i.unitCost == null ? "—" : fmtPln(i.unitCost)}</td>` : ""}
          <td class="r">${fmtPln(i.unitPrice)}</td>
          ${withCosts ? `<td class="r dim">${fmtPct(margin)}</td>` : ""}
          <td class="r strong">${fmtPln(i.lineTotal)}</td>
        </tr>`;
          })
          .join("")}
        <tr class="sum-row">
          <td colspan="${colCount - 1}" class="r">Razem w sekcji</td>
          <td class="r strong">${fmtPln(sectionSum)}</td>
        </tr>
      </tbody>
    </table>
  </div>`;
    })
    .join("");

  const leaseActive = offer.leaseMode !== "none" && totals.leaseMonthly > 0;

  const summaryRows: string[] = [];
  summaryRows.push(
    `<div class="row"><span>Do zapłaty jednorazowo (netto)</span><b>${fmtPln(
      totals.oneTimePayable
    )}</b></div>`
  );
  if (leaseActive) {
    summaryRows.push(
      `<div class="row info"><span>Wartość sprzętu w dzierżawie (informacyjnie)</span><b>${fmtPln(
        totals.equipmentValue
      )}</b></div>`,
      `<div class="row"><span>Dzierżawa sprzętu${
        offer.leaseMonthsEffective ? ` — ${offer.leaseMonthsEffective} mies.` : ""
      } (netto/mies.)</span><b>${fmtPln(totals.leaseMonthlyNet)}</b></div>`
    );
  }
  if (totals.monthlyPrice > 0) {
    summaryRows.push(
      `<div class="row"><span>Abonament (netto/mies.)</span><b>${fmtPln(
        totals.monthlyPriceNet
      )}</b></div>`
    );
  }
  summaryRows.push(
    `<div class="row total"><span>Razem miesięcznie (netto)</span><b>${fmtPln(
      totals.monthlyTotal
    )}</b></div>`
  );
  if (totals.optionsOneTime > 0) {
    summaryRows.push(
      `<div class="row info"><span>Opcje dodatkowe, jednorazowo (poza kwotą)</span><b>${fmtPln(
        totals.optionsOneTime
      )}</b></div>`
    );
  }
  if (totals.optionsMonthly > 0) {
    summaryRows.push(
      `<div class="row info"><span>Opcje dodatkowe, miesięcznie (poza kwotą)</span><b>${fmtPln(
        totals.optionsMonthly
      )}</b></div>`
    );
  }
  if (offer.discountPct > 0) {
    summaryRows.push(
      `<div class="row info"><span>Uwzględniony rabat</span><b>${fmtPct(
        offer.discountPct
      )}</b></div>`
    );
  }
  if (withCosts) {
    // Strona zleceniobiorcy — wyłącznie na wersji wewnętrznej.
    summaryRows.push(
      `<div class="row cost"><span>Koszt wdrożenia (sprzęt ${fmtPln(
        totals.oneTimeCostMaterial ?? 0
      )} + robocizna ${fmtPln(totals.oneTimeCostLabour ?? 0)})</span><b>${fmtPln(
        totals.oneTimeCost ?? 0
      )}</b></div>`
    );
    if (totals.margin) {
      summaryRows.push(
        `<div class="row cost"><span>Koszt łączny / marża za ${totals.marginHorizonMonths} mies.</span><b>${fmtPln(
          totals.horizonCost ?? 0
        )} · ${fmtPct(totals.margin.marginPct)}</b></div>`
      );
    }
  }

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

  const footer = companyFooterHtml(opts.company ?? null);

  const html = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(offer.number)} — Oferta</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
         font-size: 11px; color: #1c2733; padding: 26px 34px; background: #fff; }

  .topbar { display: flex; align-items: center; gap: 16px;
            border-bottom: 3px solid ${NAVY}; padding-bottom: 14px; margin-bottom: 18px; }
  .topbar img { width: 64px; height: 64px; }
  .topbar .doc { margin-left: auto; text-align: right; }
  .topbar .doc h1 { font-size: 19px; color: ${NAVY_DARK}; font-weight: 700; }
  .topbar .doc .no { display: inline-block; margin-top: 5px; padding: 3px 12px;
                     background: ${NAVY}; color: #fff; border-radius: 4px;
                     font-size: 11.5px; font-weight: 600; letter-spacing: 0.6px; }
  .topbar .doc .ver { display: block; margin-top: 4px; font-size: 9.5px; color: #5a6673; }

  .meta { border: 1px solid #d5dce4; border-radius: 6px; overflow: hidden;
          margin-bottom: 16px; max-width: 520px; }
  .meta .row { display: flex; border-bottom: 1px solid #edf1f5; }
  .meta .row:last-child { border-bottom: none; }
  .meta .lbl { width: 90px; background: #f2f6fa; color: #5a6673; font-size: 10px; padding: 6px 10px; }
  .meta .val { flex: 1; padding: 6px 10px; font-weight: 600; }

  .section { margin-bottom: 14px; break-inside: avoid; }
  .section.muted { opacity: 0.75; }
  .section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .section-head h2 { font-size: 12.5px; color: ${NAVY_DARK}; }
  .badge { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px;
           padding: 2px 6px; border-radius: 3px; font-weight: 700; }
  .badge.opt { background: #fef3c7; color: #92400e; }
  .badge.alt { background: #e5e7eb; color: #4b5563; }
  .badge.sel { background: #d1fae5; color: #065f46; }

  table.items { width: 100%; border-collapse: collapse; }
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

  .summary { margin-top: 18px; margin-left: auto; max-width: 420px;
             border: 1px solid #d5dce4; border-radius: 6px; overflow: hidden; }
  .summary .row { display: flex; justify-content: space-between; gap: 16px;
                  padding: 7px 12px; border-bottom: 1px solid #edf1f5; font-size: 11px; }
  .summary .row:last-child { border-bottom: none; }
  .summary .row.info { color: #6b7480; font-size: 10px; background: #fafcfe; }
  .summary .row.total { background: ${NAVY}; color: #fff; font-size: 12.5px; font-weight: 700; }
  .summary .row.cost { background: #fff7ed; color: #9a3412; font-size: 10px; }

  .notes { margin-top: 16px; font-size: 10.5px; color: #43506080; white-space: pre-wrap; }
  .footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #d5dce4;
            font-size: 8.5px; color: #6b7480; line-height: 1.5; }
  .internal { margin-top: 10px; font-size: 9px; color: #9a3412; font-weight: 700;
              text-transform: uppercase; letter-spacing: 0.6px; }
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
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 Drukuj / zapisz PDF</button></div>
  <div class="topbar">
    <img src="${logoUrl}" alt="">
    <div class="doc">
      <h1>Oferta</h1>
      <span class="no">${esc(offer.number)}</span>
      ${offer.version > 1 ? `<span class="ver">wersja ${offer.version}</span>` : ""}
    </div>
  </div>

  <div class="meta">${meta}</div>

  ${sectionHtml || '<p class="notes">Oferta nie ma jeszcze żadnych pozycji.</p>'}

  <div class="summary">${summaryRows.join("")}</div>

  ${offer.notes ? `<div class="notes">${esc(offer.notes)}</div>` : ""}
  ${withCosts ? '<div class="internal">Dokument wewnętrzny — zawiera koszty własne i marżę</div>' : ""}
  ${footer ? `<div class="footer">${footer}</div>` : ""}
</body>
</html>`;

  const win = window.open("", "_blank", "width=900,height=1100");
  if (!win) {
    alert("Przeglądarka zablokowała okno wydruku — zezwól na wyskakujące okna.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
}
