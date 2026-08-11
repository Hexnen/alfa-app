# -*- coding: utf-8 -*-
"""
Analiza + render DXF (po konwersji z DWG przez dwg2dxf) dla importu planów
w monitoring designerze.

Wejście:  dwg_analyze_render.py <fixed.dxf> <out.svg> <out.meta.json>
Wyjście:  out.svg (wektorowy render obszaru arkusza/głównego klastra),
          out.meta.json (jednostka, pewność, wymiary w metrach, skala...).
Postęp:   linie "PROG <frac> <etap>" na stdout (frac 0..1) — parsuje je Node.

Dlaczego wnioskujemy jednostkę zamiast czytać nagłówek: metadane DWG bywają
fałszywe ($INSUNITS=cale przy rysunku w cm), a $EXTMIN/EXTMAX to często śmieci.
Dowody: ramka arkusza ISO×skala, mediana wymiarów DIMENSION, rozmiar głównego
klastra encji. Outliery (resztki map w PL-2000, encje "w kosmosie") odcinamy
klastrowaniem bboxów per encja.
"""
import json
import math
import re
import sys
import time
from collections import Counter

import ezdxf
from ezdxf import bbox, recover
from ezdxf.addons.drawing import RenderContext, Frontend, config, layout
from ezdxf.addons.drawing.svg import SVGBackend


def prog(frac, stage):
    print(f"PROG {frac:.2f} {stage}", flush=True)


# ---------- stałe ----------
UNIT_TO_M = {"m": 1.0, "cm": 0.01, "mm": 0.001}
INSUNITS_NAME = {4: "mm", 5: "cm", 6: "m"}  # tylko metryczne mapujemy na kandydatów
# formaty ISO (mm, portret) — dopasowanie ramki arkusza
ISO_MM = {"A0": (841, 1189), "A1": (594, 841), "A2": (420, 594), "A3": (297, 420), "A4": (210, 297)}
SCALES = [50, 100, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000]
BUCKET = 100_000.0          # rozmiar koszyka klastrowania (jednostki rysunku)
MAX_SIDE_PX = 7000          # limity jak przy imporcie PDF
MAX_PIXELS = 16_000_000


def main():
    dxf_path, svg_path, meta_path = sys.argv[1], sys.argv[2], sys.argv[3]
    t_all = time.time()

    prog(0.02, "wczytywanie DXF")
    doc, auditor = recover.readfile(dxf_path)
    msp = doc.modelspace()
    prog(0.30, "bbox encji")

    # ---------- bbox per encja + klastrowanie ----------
    items = []  # (entity, cx, cy, x0, y0, x1, y1)
    ents = list(msp)
    n = len(ents)
    for idx, e in enumerate(ents):
        if idx % 500 == 0 and n:
            prog(0.30 + 0.25 * idx / n, "bbox encji")
        try:
            ext = bbox.extents([e], fast=True)
        except Exception:
            continue
        if not ext.has_data:
            continue
        x0, y0 = ext.extmin.x, ext.extmin.y
        x1, y1 = ext.extmax.x, ext.extmax.y
        if not all(map(math.isfinite, (x0, y0, x1, y1))):
            continue
        items.append((e, (x0 + x1) / 2, (y0 + y1) / 2, x0, y0, x1, y1))

    if not items:
        raise SystemExit("brak encji z geometrią w modelu")

    buckets = Counter((round(cx / BUCKET), round(cy / BUCKET)) for _, cx, cy, *_ in items)
    (mx, my), _ = buckets.most_common(1)[0]
    main_items = [it for it in items if abs(it[1] / BUCKET - mx) <= 1 and abs(it[2] / BUCKET - my) <= 1]
    outliers = len(items) - len(main_items)
    cl_x0 = min(it[3] for it in main_items); cl_y0 = min(it[4] for it in main_items)
    cl_x1 = max(it[5] for it in main_items); cl_y1 = max(it[6] for it in main_items)

    prog(0.58, "analiza jednostki")

    # ---------- kandydaci ramki arkusza ----------
    # Prostokąt: zamknięta polilinia, której obwód ≈ 2(w+h) bboxa (znosi punkty
    # współliniowe). Ramka arkusza: prostokąt zawierający większość encji klastra
    # (odróżnia ramkę od np. prostokątnego obrysu budynku).
    def rect_size(e, x0, y0, x1, y1):
        try:
            if e.dxftype() == "LWPOLYLINE":
                pts = [(p[0], p[1]) for p in e.get_points()]
                closed = e.closed or (len(pts) > 2 and abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6)
            elif e.dxftype() == "POLYLINE" and not e.is_3d_polyline:
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                closed = e.is_closed
            else:
                return None
        except Exception:
            return None
        if len(pts) < 4 or not closed:
            return None
        w, h = x1 - x0, y1 - y0
        if w <= 0 or h <= 0:
            return None
        per = 0.0
        for i in range(len(pts)):
            ax, ay = pts[i]; bx, by = pts[(i + 1) % len(pts)]
            per += math.hypot(bx - ax, by - ay)
        if abs(per - 2 * (w + h)) > 0.02 * 2 * (w + h):
            return None
        return (w, h, x0, y0, x1, y1)

    cl_w, cl_h = cl_x1 - cl_x0, cl_y1 - cl_y0
    rects = []
    for it in main_items:
        e, cx, cy, x0, y0, x1, y1 = it
        if (x1 - x0) < 0.2 * cl_w and (y1 - y0) < 0.2 * cl_h:
            continue  # za małe na ramkę arkusza
        r = rect_size(e, x0, y0, x1, y1)
        if r:
            rects.append(r)
    frame_candidates = []
    for (w, h, x0, y0, x1, y1) in rects:
        inside = sum(1 for it in main_items if x0 <= it[1] <= x1 and y0 <= it[2] <= y1)
        if inside >= 0.6 * len(main_items):
            frame_candidates.append((w, h, x0, y0, x1, y1, inside))
    # preferuj najbardziej zewnętrzną (największa powierzchnia)
    frame_candidates.sort(key=lambda r: -(r[0] * r[1]))

    ISO_SIDES = sorted({v for pair in ISO_MM.values() for v in pair})

    def frame_match(unit):
        """Dopasowanie ramki do formatu ISO × skala dla danej jednostki.
        Wystarczy JEDEN bok zgodny z bokiem ISO (arkusze bywają przycinane/
        wydłużane w drugim wymiarze). Zwraca (err, format, scale, bbox) | None."""
        u_mm = UNIT_TO_M[unit] * 1000
        best = None
        for (w, h, x0, y0, x1, y1, _inside) in frame_candidates:
            for s in SCALES:
                wmm, hmm = w * u_mm / s, h * u_mm / s
                if not (120 <= min(wmm, hmm) and max(wmm, hmm) <= 2500):
                    continue  # nierealny rozmiar papieru
                for side_mm in (wmm, hmm):
                    for iso in ISO_SIDES:
                        err = abs(side_mm - iso) / iso
                        if err < 0.02:
                            # format: ISO, którego jeden z boków = iso i proporcje najbliżej
                            fmt = min(ISO_MM, key=lambda n: min(
                                abs(ISO_MM[n][0] - min(wmm, hmm)) / ISO_MM[n][0] + abs(ISO_MM[n][1] - max(wmm, hmm)) / ISO_MM[n][1],
                                99))
                            if best is None or err < best[0]:
                                best = (err, fmt, s, (x0, y0, x1, y1))
        return best

    # ---------- mediana DIMENSION ----------
    dims = []
    for it in main_items:
        e = it[0]
        if e.dxftype() == "DIMENSION":
            try:
                m = e.get_measurement()
                if isinstance(m, (int, float)) and m > 0:
                    dims.append(m)
            except Exception:
                pass
    dims.sort()
    dim_med = dims[len(dims) // 2] if dims else None

    # ---------- tekst skali "1:NNN" ----------
    scale_texts = Counter()
    for it in main_items:
        e = it[0]
        try:
            if e.dxftype() == "TEXT":
                txt = e.dxf.text or ""
            elif e.dxftype() == "MTEXT":
                txt = e.plain_text()
            else:
                continue
        except Exception:
            continue
        for mtch in re.finditer(r"1\s*[:∶]\s*(\d{2,5})", txt):
            d = int(mtch.group(1))
            if 50 <= d <= 5000:
                scale_texts[d] += 1
    text_scale = scale_texts.most_common(1)[0][0] if scale_texts else None

    # ---------- scoring jednostek ----------
    insunits = None
    try:
        insunits = INSUNITS_NAME.get(int(doc.header.get("$INSUNITS", 0)))
    except Exception:
        pass

    scores, evidence = {}, {}
    frame_by_unit = {}
    for unit in ("m", "cm", "mm"):
        f = UNIT_TO_M[unit]
        sc, ev = 0.0, []
        fm = frame_match(unit)
        frame_by_unit[unit] = fm
        if fm:
            sc += 3.0
            ev.append(f"ramka {fm[1]} 1:{fm[2]} (błąd {fm[0]*100:.1f}%)")
            # tekst "SKALA 1:NNN" zgodny ze skalą wynikającą z ramki — rozstrzyga
            # niejednoznaczność cm@1:500 ≡ mm@1:50 (geometria arkusza identyczna)
            if text_scale and fm[2] == text_scale:
                sc += 2.0
                ev.append(f"tekst 1:{text_scale} zgodny ze skalą ramki")
        if dim_med is not None:
            dm = dim_med * f
            if 0.3 <= dm <= 200:
                sc += 1.0
                halves = dm / 0.5
                if halves > 0.5 and abs(halves - round(halves)) / halves < 0.01:
                    sc += 1.0
                    ev.append(f"mediana DIMENSION = {dm:g} m (okrągła)")
                else:
                    ev.append(f"mediana DIMENSION = {dm:.2f} m")
        if 20 <= max(cl_w, cl_h) * f <= 5000:
            sc += 1.0
            ev.append(f"klaster {cl_w*f:.0f}×{cl_h*f:.0f} m")
        if insunits == unit:
            sc += 0.5
            ev.append("zgodne $INSUNITS")
        scores[unit] = sc
        evidence[unit] = ev

    unit = max(scores, key=lambda u: scores[u])
    ranked = sorted(scores.values(), reverse=True)
    margin = ranked[0] - (ranked[1] if len(ranked) > 1 else 0)
    if frame_by_unit[unit] and margin >= 2:
        confidence = "high"
    elif margin >= 1.5 and scores[unit] >= 2:
        confidence = "medium"
    else:
        confidence = "low"
    factor = UNIT_TO_M[unit]
    fm = frame_by_unit[unit]

    # ---------- obszar renderu: ramka (preferowana) albo główny klaster ----------
    if fm:
        fx0, fy0, fx1, fy1 = fm[3]
        pad = 0.005 * max(fx1 - fx0, fy1 - fy0)
        area = (fx0 - pad, fy0 - pad, fx1 + pad, fy1 + pad)
    else:
        area = (cl_x0, cl_y0, cl_x1, cl_y1)

    prog(0.62, "filtrowanie encji")
    ax0, ay0, ax1, ay1 = area
    # przy wykrytej ramce: odrzuć też encje mocno WYSTAJĄCE poza arkusz (center bywa
    # w ramce, a np. szraf chodnika ciągnie się przez pół modelu i psuje bbox/obraz)
    ovx = 0.08 * (ax1 - ax0) if fm else float("inf")
    ovy = 0.08 * (ay1 - ay0) if fm else float("inf")
    kept = []
    for it in items:
        e, cx, cy, x0, y0, x1, y1 = it
        inside = ax0 <= cx <= ax1 and ay0 <= cy <= ay1
        fits = x0 >= ax0 - ovx and x1 <= ax1 + ovx and y0 >= ay0 - ovy and y1 <= ay1 + ovy
        if inside and fits:
            kept.append(it)
        else:
            msp.delete_entity(e)
    if not kept:
        raise SystemExit("obszar renderu nie zawiera encji")

    # finalny bbox TREŚCI (to on definiuje wymiary obrazu w metrach — nie ramka!)
    rx0 = min(it[3] for it in kept); ry0 = min(it[4] for it in kept)
    rx1 = max(it[5] for it in kept); ry1 = max(it[6] for it in kept)
    width_m = (rx1 - rx0) * factor
    height_m = (ry1 - ry0) * factor

    prog(0.68, "render SVG")
    cfg = config.Configuration(
        background_policy=config.BackgroundPolicy.WHITE,
        hatch_policy=config.HatchPolicy.SHOW_OUTLINE,
    )
    backend = SVGBackend()
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(msp, finalize=True)
    prog(0.90, "zapis SVG")

    ratio = (ry1 - ry0) / (rx1 - rx0)
    w_px = MAX_SIDE_PX if ratio <= 1 else max(64, round(MAX_SIDE_PX / ratio))
    h_px = max(64, round(w_px * ratio))
    # limit megapikseli
    if w_px * h_px > MAX_PIXELS:
        k = math.sqrt(MAX_PIXELS / (w_px * h_px))
        w_px, h_px = max(64, round(w_px * k)), max(64, round(h_px * k))
    page = layout.Page(w_px, h_px, layout.Units.px, margins=layout.Margins.all(0))
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(backend.get_string(page))

    meta = {
        "unit": unit,
        "unitFactor": factor,
        "confidence": confidence,
        "scores": scores,
        "evidence": evidence[unit],
        "widthM": round(width_m, 2),
        "heightM": round(height_m, 2),
        "frame": {"format": fm[1], "scale": fm[2]} if fm else None,
        "scaleDenom": (fm[2] if fm else text_scale),
        "textScale": text_scale,
        "insunits": insunits,
        "entityCount": len(kept),
        "outliers": outliers,
        "pxW": w_px,
        "pxH": h_px,
        "elapsedS": round(time.time() - t_all, 1),
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    prog(1.0, "gotowe")
    print("META " + json.dumps(meta, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
