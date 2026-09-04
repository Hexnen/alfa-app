// Generator oferty monitoringu — jeden samodzielny plik HTML do wysyłki:
// interaktywny plan kamer (Leaflet + Esri) z projektu designera, osadzone
// (base64) zdjęcia z wizji i edytowalne sekcje tekstowe.
// Przepisane 1:1 z oferta-template.html + generuj-oferte.ps1
// (monitoring-system-aluzyjna25.zip); tam działało to jako skrypt PowerShell.
import type { MonitoringPhoto, MonitoringProject } from "../db/schema.js";

// Pola edytowalne w dialogu "Oferta" (JSON w monitoring_projects.offer)
export interface OfferFields {
  kicker: string; // nagłówek nad tytułem
  subtitle: string; // podtytuł (domyślnie adres)
  visitDate: string; // data wizji
  purpose: string; // cel opracowania
  contact: string; // kontakt na obiekcie
  summary: string; // "W skrócie" — jedna pozycja na linię
  calloutTitle: string; // nagłówek wyróżnionej uwagi
  callout: string; // treść wyróżnionej uwagi
  existing: string; // "Stan istniejący i uwarunkowania" — jedna pozycja na linię
}

export const DEFAULT_OFFER: OfferFields = {
  kicker: "Wizja — materiał do wyceny (dział techniczny)",
  subtitle: "",
  visitDate: "",
  purpose: "wycena kosztów przez dział techniczny",
  contact: "",
  summary: "",
  calloutTitle: "",
  callout: "",
  existing: "",
};

export function parseOffer(raw: string): OfferFields {
  try {
    return { ...DEFAULT_OFFER, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_OFFER };
  }
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// **pogrubienie** jak w oryginalnych punktach oferty
const rich = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

const bullets = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .map((l) => `<li>${rich(l)}</li>`)
    .join("\n        ");

// ── Legenda grup kamer ──────────────────────────────────────────────────────
// Kolor pinu i stożka kamery na planie = kolor jej grupy z designera, więc w ofercie
// (także po wydrukowaniu do PDF) legenda tłumaczy te kolory na nazwy grup.
interface OfferCam {
  color?: string;
  group?: string | null;
}
interface OfferGroup {
  id: string;
  name?: string;
  color?: string;
}

const plCams = (n: number) => {
  const d = n % 10;
  const s = n % 100;
  if (n === 1) return "1 kamera";
  if (d >= 2 && d <= 4 && !(s >= 12 && s <= 14)) return `${n} kamery`;
  return `${n} kamer`;
};

const swatches = (colors: string[]) =>
  colors
    .map((c) => `<span class="sw" style="background:${esc(c)}"></span>`)
    .join("");

function legendSection(dataRaw: string): string {
  let d: { cameras?: OfferCam[]; camGroups?: OfferGroup[] };
  try {
    d = JSON.parse(dataRaw);
  } catch {
    return "";
  }
  const cams = Array.isArray(d.cameras) ? d.cameras : [];
  const groups = Array.isArray(d.camGroups) ? d.camGroups : [];
  // bez grup nie ma czego tłumaczyć — starsze projekty zostają bez tej sekcji
  if (!groups.length || !cams.length) return "";

  const known = new Set(groups.map((g) => g.id));
  const items = groups
    .map((g) => ({
      name: g.name?.trim() || "Grupa",
      colors: [g.color || "#22d3ee"],
      n: cams.filter((c) => c.group === g.id).length,
    }))
    .filter((g) => g.n > 0);
  if (!items.length) return "";

  const loose = cams.filter((c) => !c.group || !known.has(c.group));
  if (loose.length) {
    // kamery spoza grup bywają w różnych kolorach — pokaż do czterech próbek
    const cols = [...new Set(loose.map((c) => c.color || "#22d3ee"))].slice(0, 4);
    items.push({ name: "Pozostałe kamery", colors: cols, n: loose.length });
  }

  return `
  <section>
    <h2>Legenda — grupy kamer</h2>
    <div class="card">
      <div class="legend">
        ${items
          .map(
            (i) =>
              `<div class="li"><span class="sws">${swatches(i.colors)}</span><span>${esc(i.name)} <span class="n">— ${plCams(i.n)}</span></span></div>`
          )
          .join("\n        ")}
      </div>
      <p class="legend-note">Kolor pinu i stożka widoczności na planie odpowiada grupie, do której należy kamera.</p>
    </div>
  </section>`;
}

export function renderOffer(
  project: MonitoringProject,
  photos: MonitoringPhoto[]
): string {
  const o = parseOffer(project.offer);
  const subtitle = o.subtitle || project.address;

  // JSON projektu wstawiany do <script> — < zapobiega wstrzyknięciu </script>
  let projectJson = "{}";
  try {
    projectJson = JSON.stringify(JSON.parse(project.data)).replace(
      /</g,
      "\\u003c"
    );
  } catch {
    /* projekt bez stanu — mapa pokaże domyślny widok */
  }

  const meta = [
    o.visitDate && `<span>Wizja: <b>${esc(o.visitDate)}</b></span>`,
    o.purpose && `<span>Cel: <b>${esc(o.purpose)}</b></span>`,
    o.contact && `<span>Kontakt na obiekcie: <b>${esc(o.contact)}</b></span>`,
  ]
    .filter(Boolean)
    .join("\n      ");

  const photosHtml = photos
    .map((p) => {
      const cap = esc(p.caption);
      return `<figure class="${p.attention ? "ph attn" : "ph"}"><img loading="lazy" alt="${cap}" src="${p.data}"><figcaption>${cap}</figcaption></figure>`;
    })
    .join("\n      ");

  const summarySection = o.summary.trim()
    ? `
  <section>
    <h2>W skrócie</h2>
    <div class="card">
      <ul class="lean">
        ${bullets(o.summary)}
      </ul>
    </div>
  </section>`
    : "";

  const calloutSection = o.callout.trim()
    ? `
  <section>
    ${o.calloutTitle.trim() ? `<h2>${esc(o.calloutTitle)}</h2>` : ""}
    <div class="callout">${rich(o.callout)}</div>
  </section>`
    : "";

  const gallerySection = photos.length
    ? `
  <section>
    <h2>Dokumentacja fotograficzna</h2>
    <div class="gallery">
      ${photosHtml}
    </div>
  </section>`
    : "";

  const groupLegendSection = legendSection(project.data);

  const existingSection = o.existing.trim()
    ? `
  <section>
    <h2>Stan istniejący i uwarunkowania</h2>
    <div class="card">
      <ul class="lean">
        ${bullets(o.existing)}
      </ul>
    </div>
  </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monitoring wizyjny — ${esc(project.name)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
      integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<style>
  :root{--ink:#0f172a;--muted:#5b6472;--line:#e2e8f0;--bg:#ffffff;--soft:#f8fafc;--accent:#0ea5b7;--warn:#b45309;--warnbg:#fff7ed}
  *{box-sizing:border-box}
  body{margin:0;font-family:"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--soft);line-height:1.5}
  .wrap{max-width:1000px;margin:0 auto;padding:0 18px 60px}
  header.cover{background:var(--ink);color:#fff;padding:34px 18px}
  header.cover .in{max-width:1000px;margin:0 auto}
  header.cover .kicker{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#7dd3dc}
  header.cover h1{margin:.2rem 0 .3rem;font-size:26px}
  header.cover .sub{color:#cbd5e1;font-size:14px}
  header.cover .meta{margin-top:14px;display:flex;flex-wrap:wrap;gap:6px 22px;font-size:13px;color:#e2e8f0}
  header.cover .meta b{color:#fff}
  section{margin-top:30px}
  h2{font-size:18px;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid var(--ink);display:inline-block}
  .card{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
  ul.lean{margin:0;padding-left:18px}
  ul.lean li{margin:4px 0}
  .callout{background:var(--warnbg);border:1px solid #fed7aa;border-left:4px solid var(--warn);border-radius:8px;padding:12px 14px;color:#7c2d12}
  .callout b{color:var(--warn)}
  #map{height:520px;border:1px solid var(--line);border-radius:12px}
  .maphint{font-size:13px;color:var(--muted);margin-top:8px}
  .legend{display:flex;flex-wrap:wrap;gap:10px 26px}
  .legend .li{display:flex;align-items:center;gap:9px;font-size:14px}
  .legend .sws{display:inline-flex;gap:3px;flex:0 0 auto}
  .legend .sw{width:15px;height:15px;border-radius:4px;border:1px solid rgba(15,23,42,.28);display:inline-block}
  .legend .n{color:var(--muted);font-size:13px}
  .legend-note{margin:12px 0 0;font-size:13px;color:var(--muted)}
  .cam-pin{width:24px;height:24px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.5)}
  .cam-pin span{transform:rotate(45deg);font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.7)}
  .pt-pin{width:26px;height:26px;border-radius:6px;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 1px 5px rgba(0,0,0,.5)}
  .leaflet-tooltip.lbl{background:rgba(15,23,42,.85);border:none;color:#fff;font-size:11px;padding:1px 6px;border-radius:4px}
  .leaflet-tooltip.lbl:before{display:none}
  .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
  figure.ph{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:zoom-in}
  figure.ph img{width:100%;height:170px;object-fit:cover;display:block}
  figure.ph figcaption{padding:8px 10px;font-size:13px;color:var(--ink)}
  figure.ph.attn{border-color:#fdba74;box-shadow:0 0 0 1px #fdba74}
  .lb{position:fixed;inset:0;background:rgba(2,6,23,.94);display:none;align-items:center;justify-content:center;z-index:9999;overflow:hidden}
  .lb.open{display:flex}
  .lb img{max-width:94vw;max-height:88vh;transform-origin:center;cursor:grab;user-select:none;-webkit-user-drag:none}
  .lb .x{position:absolute;top:14px;right:20px;color:#fff;font-size:30px;cursor:pointer;line-height:1}
  .lb .cap{position:absolute;bottom:16px;left:0;right:0;text-align:center;color:#e2e8f0;font-size:14px}
  .lb .zoomhint{position:absolute;top:16px;left:20px;color:#94a3b8;font-size:12px}
  footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;text-align:center}
  @media print{body{background:#fff}.legend .sw{print-color-adjust:exact;-webkit-print-color-adjust:exact}section{break-inside:avoid}header.cover{background:#fff;color:#000;border-bottom:2px solid #000}header.cover .kicker,header.cover .sub,header.cover .meta{color:#333}#map{height:420px}.lb{display:none!important}figure.ph{break-inside:avoid}}
</style>
</head>
<body>
<header class="cover">
  <div class="in">
    ${o.kicker.trim() ? `<div class="kicker">${esc(o.kicker)}</div>` : ""}
    <h1>${esc(project.name)}</h1>
    ${subtitle.trim() ? `<div class="sub">${esc(subtitle)}</div>` : ""}
    ${meta ? `<div class="meta">\n      ${meta}\n    </div>` : ""}
  </div>
</header>

<div class="wrap">
${summarySection}

  <section>
    <h2>Plan rozmieszczenia kamer</h2>
    <div id="map"></div>
    <div class="maphint">Wstępny projekt obejmuje <b id="camCnt">—</b> kamer rozmieszczonych dla maksymalnego pokrycia terenu. Interaktywna mapa — <b>przewiń kółkiem, aby przybliżyć</b>, przeciągnij, aby przesunąć. <b>Skala</b> w lewym dolnym rogu. Stożki pokazują pole widzenia i zasięg kamer.</div>
  </section>
${groupLegendSection}
${calloutSection}
${gallerySection}
${existingSection}

</div>

<div class="lb" id="lb">
  <span class="x" id="lbX">✕</span>
  <div class="zoomhint">Kółko = zoom · przeciągnij = przesuń · Esc = zamknij</div>
  <img id="lbImg" alt="">
  <div class="cap" id="lbCap"></div>
</div>

<script>
const PROJECT = ${projectJson};

/* ===== MAPA (podgląd tylko do odczytu) ===== */
const R=6378137,toR=d=>d*Math.PI/180,toD=r=>r*180/Math.PI;
function destination(lat,lng,brng,d){const dr=d/R,br=toR(brng),la1=toR(lat),lo1=toR(lng);
  const la2=Math.asin(Math.sin(la1)*Math.cos(dr)+Math.cos(la1)*Math.sin(dr)*Math.cos(br));
  const lo2=lo1+Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(la1),Math.cos(dr)-Math.sin(la1)*Math.sin(la2));
  return [toD(la2),toD(lo2)];}
function coverageLatLngs(c){const o=[[c.lat,c.lng]],s=c.az-c.fov/2,e=c.az+c.fov/2,st=Math.max(2,c.fov/40);
  for(let a=s;a<=e;a+=st)o.push(destination(c.lat,c.lng,a,c.range));o.push(destination(c.lat,c.lng,e,c.range));o.push([c.lat,c.lng]);return o;}
const PT={nvr:{bg:'#ef4444',emoji:'🖥️'},szlaban:{bg:'#f59e0b',emoji:'🚧'},budka:{bg:'#3b82f6',emoji:'🛡️'}};
const fmtA=a=>a>=10000?(a/10000).toLocaleString('pl-PL',{maximumFractionDigits:2})+' ha':Math.round(a).toLocaleString('pl-PL')+' m²';

const P=PROJECT||{};
const map=L.map('map',{center:P.center||[52.2297,21.0122],zoom:P.zoom||18,maxZoom:22,scrollWheelZoom:true});
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:22,maxNativeZoom:19,attribution:'Esri'}).addTo(map);
L.control.scale({metric:true,imperial:false,position:'bottomleft'}).addTo(map);
const group=[];
(P.cameras||[]).forEach(c=>{const col=c.color||'#22d3ee';
  const cov=(c.type==='pano'||c.fov>=360)?L.circle([c.lat,c.lng],{radius:c.range,color:col,weight:1,fillColor:col,fillOpacity:.22}):L.polygon(coverageLatLngs(c),{color:col,weight:1,fillColor:col,fillOpacity:.22});
  cov.addTo(map); group.push(cov);
  L.marker([c.lat,c.lng],{icon:L.divIcon({className:'',iconSize:[24,24],iconAnchor:[12,24],html:\`<div class="cam-pin" style="background:\${col}"><span>\${c.num}</span></div>\`})}).addTo(map);
});
(P.points||[]).forEach(p=>{const t=PT[p.type]||PT.nvr;
  const m=L.marker([p.lat,p.lng],{icon:L.divIcon({className:'',iconSize:[26,26],iconAnchor:[13,13],html:\`<div class="pt-pin" style="background:\${t.bg}">\${t.emoji}</div>\`})}).addTo(map);
  m.bindTooltip(p.name,{permanent:true,direction:'top',offset:[0,-14],className:'lbl'}); group.push(m);
});
(P.zones||[]).forEach(z=>{const col=z.color||'#f472b6';
  const pl=L.polygon(z.pts,{color:col,weight:2,fillColor:col,fillOpacity:.25}).addTo(map);
  pl.bindTooltip(z.name+(z.area?(' — '+fmtA(z.area)):''),{permanent:true,direction:'center',className:'lbl'}); group.push(pl);
});
if(group.length){try{const fg=L.featureGroup(group);map.fitBounds(fg.getBounds().pad(0.25));}catch(e){}}
const _cc=document.getElementById('camCnt'); if(_cc)_cc.textContent=(P.cameras||[]).length;

/* ===== LIGHTBOX ze zoomem ===== */
const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');
let zs=1,tx=0,ty=0,drag=false,px=0,py=0;
function apply(){lbImg.style.transform=\`translate(\${tx}px,\${ty}px) scale(\${zs})\`;}
function openLb(src,cap){zs=1;tx=0;ty=0;apply();lbImg.src=src;lbCap.textContent=cap||'';lb.classList.add('open');}
function closeLb(){lb.classList.remove('open');lbImg.src='';}
document.querySelectorAll('figure.ph').forEach(f=>{const img=f.querySelector('img'),cap=(f.querySelector('figcaption')||{}).textContent;
  f.addEventListener('click',()=>openLb(img.dataset.full||img.src,cap));});
document.getElementById('lbX').onclick=closeLb;
lb.addEventListener('click',e=>{if(e.target===lb)closeLb();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLb();});
lb.addEventListener('wheel',e=>{e.preventDefault();zs=Math.min(6,Math.max(1,zs*(e.deltaY<0?1.15:0.87)));if(zs===1){tx=0;ty=0;}apply();},{passive:false});
lbImg.addEventListener('mousedown',e=>{if(zs<=1)return;drag=true;px=e.clientX-tx;py=e.clientY-ty;lbImg.style.cursor='grabbing';e.preventDefault();});
window.addEventListener('mousemove',e=>{if(!drag)return;tx=e.clientX-px;ty=e.clientY-py;apply();});
window.addEventListener('mouseup',()=>{drag=false;lbImg.style.cursor='grab';});
</script>
</body>
</html>`;
}
