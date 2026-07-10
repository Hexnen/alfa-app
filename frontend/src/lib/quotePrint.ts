// Wydruk wyceny usług serwisowych w brandzie Alfa Group — układ wg wzoru
// "20260610 wycena" (Obiekt/Adres/Data + tabela pozycji + Razem netto).
import type { Quote, QuoteItem } from "./api";

const esc = (s: string | null | undefined) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const NAVY = "#14447a";
const NAVY_DARK = "#0e3560";

const pln = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});

const num = (v: string) => {
  const n = parseFloat((v || "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

export function printQuote(q: Quote) {
  const items: QuoteItem[] = q.items.filter(
    (i) => i.name.trim() || num(i.qty) > 0
  );
  while (items.length < 12) items.push({ name: "", qty: "", unit: "", price: "" });

  const total = q.items.reduce((a, i) => a + num(i.qty) * num(i.price), 0);
  const logoUrl = `${window.location.origin}/alfa-logo.png`;

  const html = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(q.number)} — Wycena usług serwisowych</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
         font-size: 11px; color: #1c2733; padding: 26px 34px; background: #fff; }

  .topbar { display: flex; align-items: center; gap: 16px;
            border-bottom: 3px solid ${NAVY}; padding-bottom: 14px; margin-bottom: 18px; }
  .topbar img { width: 64px; height: 64px; }
  .topbar .co { line-height: 1.45; font-size: 9.5px; color: #5a6673; }
  .topbar .co b { display: block; font-size: 12.5px; color: ${NAVY_DARK};
                  letter-spacing: 0.4px; margin-bottom: 2px; }
  .topbar .doc { margin-left: auto; text-align: right; }
  .topbar .doc h1 { font-size: 19px; color: ${NAVY_DARK}; font-weight: 700; }
  .topbar .doc .no { display: inline-block; margin-top: 5px; padding: 3px 12px;
                     background: ${NAVY}; color: #fff; border-radius: 4px;
                     font-size: 11.5px; font-weight: 600; letter-spacing: 0.6px; }

  .meta { border: 1px solid #d5dce4; border-radius: 6px; overflow: hidden;
          margin-bottom: 16px; max-width: 480px; }
  .meta .row { display: flex; border-bottom: 1px solid #edf1f5; }
  .meta .row:last-child { border-bottom: none; }
  .meta .lbl { width: 90px; background: #f2f6fa; color: #5a6673; font-size: 10px;
               padding: 6px 10px; }
  .meta .val { flex: 1; padding: 6px 10px; font-weight: 600; }

  table.items { width: 100%; border-collapse: collapse; }
  table.items th { background: ${NAVY}; color: #fff; font-size: 9px;
                   letter-spacing: 0.8px; text-transform: uppercase;
                   padding: 6px 8px; text-align: left; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items td { border-bottom: 1px solid #e4e9ef; padding: 5px 8px; font-size: 10.5px; }
  table.items tr:nth-child(even) td { background: #f7fafc; }
  td.lp { width: 30px; color: #8a94a0; text-align: center; }
  td.qty { width: 56px; font-weight: 600; }
  td.um { width: 46px; }
  td.price { width: 96px; }
  td.sum { width: 100px; font-weight: 600; }

  .total { display: flex; justify-content: flex-end; margin-top: 12px; }
  .total .box { background: ${NAVY}; color: #fff; border-radius: 6px;
                padding: 8px 18px; font-size: 13px; font-weight: 700; }
  .total .box small { font-weight: 400; opacity: 0.85; margin-right: 12px; }

  .footer { margin-top: 28px; border-top: 1px solid #d5dce4; padding-top: 8px;
            text-align: center; font-size: 7.3px; color: #8a94a0; line-height: 1.6; }
  .footer b { color: ${NAVY_DARK}; }

  @media print { body { padding: 8mm 10mm; } .noprint { display: none; } }
  .noprint { text-align: center; margin: 0 0 14px; }
  .noprint button { padding: 9px 26px; font-size: 13px; cursor: pointer;
                    background: ${NAVY}; color: #fff; border: none; border-radius: 6px; }
  .noprint button:hover { background: ${NAVY_DARK}; }
</style>
</head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨 Drukuj / zapisz PDF</button></div>

  <div class="topbar">
    <img src="${logoUrl}" alt="Alfa Group">
    <div class="co">
      <b>ALFA GROUP Sp. z o.o.</b>
      03-876 Warszawa, ul. Matuszewska 20<br>
      tel./fax +48 22 678 22 22 · tel. +48 504 155 222<br>
      sekretariat@alfagroup.com.pl · www.alfagroup.com.pl
    </div>
    <div class="doc">
      <h1>Wycena usług serwisowych</h1>
      <span class="no">${esc(q.number)}</span>
    </div>
  </div>

  <div class="meta">
    <div class="row"><div class="lbl">Obiekt</div><div class="val">${esc(q.site) || "&nbsp;"}</div></div>
    <div class="row"><div class="lbl">Adres</div><div class="val">${esc(q.address) || "&nbsp;"}</div></div>
    <div class="row"><div class="lbl">Data</div><div class="val">${esc(
      new Date(q.date).toLocaleDateString("pl-PL")
    )}</div></div>
  </div>

  <table class="items">
    <tr>
      <th class="c">LP.</th><th>Usługa / Sprzęt</th><th class="c">Ilość</th>
      <th class="c">J.M.</th><th class="r">Cena netto</th><th class="r">Suma</th>
    </tr>
    ${items
      .map((it, i) => {
        const rowSum = num(it.qty) * num(it.price);
        return `<tr>
          <td class="lp">${i + 1}</td>
          <td>${esc(it.name) || "&nbsp;"}</td>
          <td class="qty c">${esc(it.qty)}</td>
          <td class="um c">${esc(it.unit)}</td>
          <td class="price r">${it.price ? pln.format(num(it.price)) : ""}</td>
          <td class="sum r">${it.name.trim() ? pln.format(rowSum) : ""}</td>
        </tr>`;
      })
      .join("")}
  </table>

  <div class="total">
    <div class="box"><small>Razem (netto):</small>${pln.format(total)}</div>
  </div>

  <div class="footer">
    <b>ALFA GROUP Sp. z o.o.</b> · 03-876 Warszawa, ul. Matuszewska 20 ·
    Sąd Rejonowy dla m. st. Warszawy w Warszawie, XIII Wydział Gospodarczy Krajowego Rejestru Sądowego ·
    KRS 0000119104 · NIP 693-18-36-206 · REGON 390651040<br>
    Koncesja MSWiA Nr L-0264/05 z dnia 14 listopada 2007 roku · kapitał zakładowy 50 000,00 PLN
  </div>
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
