// Wydruk zestawienia godzin dla księgowości (moduł Kadry) — brand Alfa Group.
// Na jego podstawie księgowość podaje kwoty główne NETTO do zakładki Wynagrodzenia.
import type { HrPayrollRow } from "./api";

const esc = (s: string | null | undefined) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const NAVY = "#14447a";
const NAVY_DARK = "#0e3560";

const MONTH_NAMES = [
  "Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec",
  "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień",
];

const h = (v: number | null | undefined) =>
  v == null ? "" : String(Math.round(v * 100) / 100).replace(".", ",");

export function printHrStatement(
  rows: HrPayrollRow[],
  year: number,
  month: number,
) {
  const logoUrl = `${window.location.origin}/alfa-logo.png`;
  const title = `Zestawienie godzin — ${MONTH_NAMES[month - 1]} ${year}`;
  // do zestawienia tylko wiersze z godzinami lub premią/potrąceniem
  const data = rows.filter(
    (r) =>
      (r.faktGodziny != null && r.faktGodziny > 0) ||
      r.godzinyDodatek > 0 ||
      r.premiaPotracenie != null,
  );
  const sumFakt = data.reduce((s, r) => s + (r.faktGodziny ?? 0), 0);
  const sumDodatek = data.reduce((s, r) => s + r.godzinyDodatek, 0);

  const html = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
         font-size: 10.5px; color: #1c2733; padding: 22px 28px; background: #fff; }

  .topbar { display: flex; align-items: center; gap: 16px;
            border-bottom: 3px solid ${NAVY}; padding-bottom: 12px; margin-bottom: 14px; }
  .topbar img { width: 56px; height: 56px; }
  .topbar .co { line-height: 1.45; font-size: 9px; color: #5a6673; }
  .topbar .co b { display: block; font-size: 12px; color: ${NAVY_DARK};
                  letter-spacing: 0.4px; margin-bottom: 2px; }
  .topbar .doc { margin-left: auto; text-align: right; }
  .topbar .doc h1 { font-size: 17px; color: ${NAVY_DARK}; font-weight: 700; }

  table { width: 100%; border-collapse: collapse; }
  th { background: ${NAVY}; color: #fff; font-size: 8.5px; letter-spacing: 0.6px;
       text-transform: uppercase; padding: 5px 6px; text-align: left; }
  th.r, td.r { text-align: right; }
  th.c, td.c { text-align: center; }
  td { border-bottom: 1px solid #e4e9ef; padding: 4px 6px; font-size: 10px; }
  tr:nth-child(even) td { background: #f7fafc; }
  td.lp { width: 26px; color: #8a94a0; text-align: center; }
  td.num { font-weight: 600; }
  tr.total td { background: #eef3f8; font-weight: 700; border-top: 2px solid ${NAVY};
                border-bottom: none; }

  .legend { margin-top: 10px; font-size: 8.5px; color: #8a94a0; line-height: 1.6; }

  @media print { body { padding: 8mm 9mm; } .noprint { display: none; } }
  .noprint { text-align: center; margin: 0 0 12px; }
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
      tel./fax +48 22 678 22 22 · sekretariat@alfagroup.com.pl
    </div>
    <div class="doc"><h1>${esc(title)}</h1></div>
  </div>

  <table>
    <tr>
      <th class="c">LP.</th><th>Pracownik</th><th>Spółka</th><th class="c">Umowa</th>
      <th class="c">chor.</th><th class="c">ZUA</th><th class="c">ZZA</th>
      <th class="r">Maks godz.</th><th class="r">Fakt godz.</th>
      <th class="r">Godz. dodatku</th><th class="r">Premia / potrącenie</th>
    </tr>
    ${data
      .map(
        (r, i) => `<tr>
        <td class="lp">${i + 1}</td>
        <td>${esc(r.employeeName)}</td>
        <td>${esc(r.company)}</td>
        <td class="c">${r.contractType === "praca" ? "Praca" : "Zlecenie"}</td>
        <td class="c">${r.chor ? "tak" : ""}</td>
        <td class="c">${esc(r.zua)}</td>
        <td class="c">${esc(r.zza)}</td>
        <td class="r">${h(r.maksGodziny)}</td>
        <td class="r num">${h(r.faktGodziny)}</td>
        <td class="r num">${r.godzinyDodatek ? h(r.godzinyDodatek) : ""}</td>
        <td class="r">${r.premiaPotracenie != null ? h(r.premiaPotracenie) + " zł" : ""}</td>
      </tr>`,
      )
      .join("")}
    <tr class="total">
      <td colspan="8" class="r">Razem:</td>
      <td class="r">${h(sumFakt)}</td>
      <td class="r">${h(sumDodatek)}</td>
      <td></td>
    </tr>
  </table>

  <div class="legend">
    Fakt godz. — godziny do rozliczenia: przy ZUA wypracowane + UW (+ L4 przy umowie o pracę),
    ograniczone do maks; przy ZZA nadwyżka ponad normę umowy głównej.
    Godz. dodatku — nadwyżka ponad maks godziny (wypłacana wg stawki dodatku).
    Premia / potrącenie — suma DODATKI − POTRĄCENIA z wpisów godzin miesiąca.
  </div>
</body>
</html>`;

  const win = window.open("", "_blank", "width=1000,height=1100");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
}
