// Wydruk protokołu końcowego w brandzie Alfa Group (granat #14447a, logo).
// Zawartość 1:1 z wzorem "Protokół powykonawczy WZÓR 01.26"; otwiera okno
// z podglądem i systemowym drukiem (można zapisać jako PDF).
import type { Protocol, ProtocolItem } from "./api";

const esc = (s: string | null | undefined) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WORK_TYPES: { key: string; label: string }[] = [
  { key: "serwis", label: "SERWIS" },
  { key: "montaz", label: "MONTAŻ" },
  { key: "wizja", label: "WIZJA" },
  { key: "inne", label: "INNE" },
];

const NAVY = "#14447a";
const NAVY_DARK = "#0e3560";

export function printProtocol(p: Protocol) {
  const items: ProtocolItem[] = [...p.items];
  while (items.length < 15) items.push({ name: "", serial: "", unit: "", qty: "" });

  const logoUrl = `${window.location.origin}/alfa-logo.png`;

  const field = (label: string, value: string | number | null | undefined) => `
    <div class="field">
      <div class="field-label">${label}</div>
      <div class="field-value">${esc(String(value ?? "")) || "&nbsp;"}</div>
    </div>`;

  const html = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${esc(p.number)} — Protokół końcowy</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
         font-size: 11px; color: #1c2733; padding: 26px 34px; background: #fff; }

  .topbar { display: flex; align-items: center; gap: 16px;
            border-bottom: 3px solid ${NAVY}; padding-bottom: 14px; margin-bottom: 16px; }
  .topbar img { width: 64px; height: 64px; }
  .topbar .co { line-height: 1.45; font-size: 9.5px; color: #5a6673; }
  .topbar .co b { display: block; font-size: 12.5px; color: ${NAVY_DARK};
                  letter-spacing: 0.4px; margin-bottom: 2px; }
  .topbar .doc { margin-left: auto; text-align: right; }
  .topbar .doc h1 { font-size: 21px; color: ${NAVY_DARK}; font-weight: 700;
                    letter-spacing: 0.3px; }
  .topbar .doc .no { display: inline-block; margin-top: 5px; padding: 3px 12px;
                     background: ${NAVY}; color: #fff; border-radius: 4px;
                     font-size: 11.5px; font-weight: 600; letter-spacing: 0.6px; }

  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .panel { border: 1px solid #d5dce4; border-radius: 6px; overflow: hidden; }
  .panel-title { background: ${NAVY}; color: #fff; font-size: 9.5px; font-weight: 700;
                 letter-spacing: 1.1px; text-transform: uppercase; padding: 5px 10px; }
  .panel-body { padding: 4px 10px 7px; }
  .field { display: flex; border-bottom: 1px solid #edf1f5; padding: 4px 0; }
  .field:last-child { border-bottom: none; }
  .field-label { width: 42%; color: #5a6673; font-size: 10px; padding-top: 1px; }
  .field-value { flex: 1; font-weight: 600; color: #1c2733; }

  .types { display: flex; gap: 8px; margin-bottom: 12px; }
  .type { flex: 1; text-align: center; padding: 6px 4px; border: 1.5px solid #d5dce4;
          border-radius: 6px; font-weight: 600; font-size: 10.5px; color: #8a94a0; }
  .type.on { border-color: ${NAVY}; background: ${NAVY}; color: #fff; }

  .section { border: 1px solid #d5dce4; border-radius: 6px; overflow: hidden;
             margin-bottom: 12px; }
  .activities { padding: 8px 12px; min-height: 108px; white-space: pre-wrap;
                line-height: 1.75; font-size: 11px;
                background-image: repeating-linear-gradient(#fff 0 18.5px, #eef2f6 18.5px 19.25px);
                background-origin: content-box; }

  .decl { background: #f2f6fa; border: 1px solid #d5dce4; border-radius: 6px;
          padding: 7px 12px; font-size: 9.5px; color: #3d4a58; text-align: center;
          margin-bottom: 12px; line-height: 1.5; }

  table.items { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  table.items th { background: ${NAVY}; color: #fff; font-size: 9px; letter-spacing: 0.8px;
                   text-transform: uppercase; padding: 5px 8px; text-align: left; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items td { border-bottom: 1px solid #e4e9ef; padding: 4.5px 8px; font-size: 10.5px; }
  table.items tr:nth-child(even) td { background: #f7fafc; }
  table.items td.lp { width: 30px; color: #8a94a0; text-align: center; }
  table.items td.serial { width: 130px; }
  table.items td.um { width: 46px; }
  table.items td.qty { width: 56px; font-weight: 600; }

  .sign { display: flex; gap: 60px; margin-top: 24px; align-items: flex-end; }
  .sign .slot { flex: 1; text-align: center; }
  .sign .sig-img { height: 52px; margin-bottom: 2px; }
  .sign .sig-meta { font-size: 8.5px; color: #5a6673; margin-bottom: 2px; }
  .sign .line { border-top: 1.5px solid ${NAVY}; padding-top: 5px;
                font-size: 9.5px; color: #5a6673; }
  .sign .slot-space { height: 52px; }

  .footer { margin-top: 24px; border-top: 1px solid #d5dce4; padding-top: 8px;
            text-align: center; font-size: 7.3px; color: #8a94a0; line-height: 1.6; }
  .footer b { color: ${NAVY_DARK}; }
  .ver { text-align: right; font-size: 7.5px; color: #b0b8c1; margin-top: 4px; }

  @media print {
    body { padding: 8mm 10mm; }
    .noprint { display: none; }
  }
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
      03-612 Warszawa, ul. Koniczynowa 2a<br>
      tel./fax +48 22 678 22 22 · tel. +48 504 155 222<br>
      helpdesk@alfagroup.com.pl · www.alfagroup.com.pl
    </div>
    <div class="doc">
      <h1>Protokół końcowy</h1>
      <span class="no">${esc(p.number)}</span>
    </div>
  </div>

  <div class="cols">
    <div class="panel">
      <div class="panel-title">Wykonanie</div>
      <div class="panel-body">
        ${field("Data wykonania", new Date(p.workDate).toLocaleDateString("pl-PL"))}
        ${field("Faktyczne godziny", p.actualHours || "")}
        ${field("Przejechane km", p.actualKm || "")}
        ${field("Wykonawca", p.contractor)}
        ${field("Handlowiec", p.salesperson)}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Zleceniodawca</div>
      <div class="panel-body">
        ${field("Zleceniodawca", p.clientName)}
        ${field("NIP", p.clientNip)}
        ${field("Miejscowość", p.clientCity)}
        ${field("Adres montażu", p.installationAddress)}
        ${field("Kontakt", p.contact)}
      </div>
    </div>
  </div>

  <div class="types">
    ${WORK_TYPES.map(
      (t) => `<div class="type${p.workType === t.key ? " on" : ""}">${t.label}</div>`
    ).join("")}
  </div>

  <div class="section">
    <div class="panel-title">Wykonane czynności / uwagi</div>
    <div class="activities">${esc(p.activities)}</div>
  </div>

  <div class="decl">
    Zleceniodawca oświadcza, że wszystkie prace zostały wykonane zgodnie z ustaleniami i przesłaną ofertą,
    oraz zgadza się z cennikiem załączonym do protokołu. Nie wnosi tym samym żadnych zastrzeżeń do wykonanej instalacji.
  </div>

  <div class="section">
    <table class="items">
      <tr>
        <th class="c">LP.</th><th>Nazwa urządzenia / model</th>
        <th>Nr seryjny</th><th class="c">J.M.</th><th class="c">Ilość</th>
      </tr>
      ${items
        .slice(0, 15)
        .map(
          (it, i) =>
            `<tr><td class="lp">${i + 1}</td><td>${esc(it.name) || "&nbsp;"}</td><td class="serial">${esc(
              it.serial
            )}</td><td class="um c">${esc(it.unit)}</td><td class="qty c">${esc(it.qty)}</td></tr>`
        )
        .join("")}
    </table>
  </div>

  <div class="sign">
    <div class="slot">
      <div class="slot-space"></div>
      <div class="line">data i podpis wykonawcy</div>
    </div>
    <div class="slot">
      ${
        p.signaturePng
          ? `<img class="sig-img" src="${p.signaturePng}" alt="Podpis zleceniodawcy">
             <div class="sig-meta">${esc(p.signerName)}${
               p.signedAt
                 ? " · " + new Date(p.signedAt).toLocaleString("pl-PL")
                 : ""
             }</div>`
          : `<div class="slot-space"></div>`
      }
      <div class="line">data i podpis zleceniodawcy</div>
    </div>
  </div>

  <div class="footer">
    <b>ALFA GROUP Sp. z o.o.</b> · 03-612 Warszawa, ul. Koniczynowa 2a ·
    Sąd Rejonowy dla m. st. Warszawy w Warszawie, XIII Wydział Gospodarczy Krajowego Rejestru Sądowego ·
    KRS 0000119104 · NIP 693-18-36-206 · REGON 390651040<br>
    Koncesja MSWiA Nr L-0264/05 z dnia 14 listopada 2007 roku · kapitał zakładowy 50 000,00 PLN
    <div class="ver">wer. 20260127</div>
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
