// Import DWG w monitoring designerze: DWG → (dwg2dxf, LibreDWG) → DXF
// → naprawa MTEXT → (python + ezdxf) analiza jednostki/skali + render SVG
// → (resvg-js) rasteryzacja PNG. Joby asynchroniczne, jeden na raz (globalna
// kolejka), stan w pamięci (po restarcie przepadają — świadomie).
//
// Metadane DWG bywają fałszywe ($INSUNITS, $EXTMIN) — jednostkę WNIOSKUJE
// skrypt Pythona (ramka arkusza ISO×skala, mediana DIMENSION, rozmiar
// klastra encji); szczegóły w scripts/dwg/dwg_analyze_render.py.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface DwgJobResult {
  meta: Record<string, unknown>;
  pngPath: string;
  pngBytes: number;
}

export interface DwgJob {
  id: string;
  projectId: number;
  fileName: string;
  stage: "queued" | "convert" | "analyze" | "render" | "done" | "error" | "cancelled";
  stageLabel: string;
  progress: number; // 0..1 całości backendu
  error?: string;
  result?: DwgJobResult;
  tmpDir?: string;
  child?: ChildProcess | null;
  cancelled: boolean;
  createdAt: number;
}

const JOB_TIMEOUT_MS = 5 * 60_000;
const JOB_TTL_MS = 15 * 60_000; // po tym czasie job + pliki tymczasowe znikają
const jobs = new Map<string, DwgJob>();
let queue: Promise<void> = Promise.resolve(); // serializacja: jeden job na raz

const BIN_DIR = process.env.LIBREDWG_BIN_DIR || "";
const PYTHON = process.env.DWG_PYTHON || "python3";
const SCRIPT = path.resolve(process.cwd(), "scripts/dwg/dwg_analyze_render.py");

const bin = (name: string) => (BIN_DIR ? path.join(BIN_DIR, name) : name);

// sprzątanie przeterminowanych jobów
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      if (job.tmpDir) rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}, 60_000).unref();

function setStage(job: DwgJob, stage: DwgJob["stage"], label: string, progress: number) {
  if (job.cancelled) return;
  job.stage = stage;
  job.stageLabel = label;
  job.progress = Math.max(job.progress, progress);
}

function runChild(
  job: DwgJob,
  cmd: string,
  args: string[],
  onStdoutLine?: (line: string) => void
): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    job.child = child;
    let stderrTail = "";
    let stdoutBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      if (!onStdoutLine) return;
      stdoutBuf += d.toString("utf8");
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        onStdoutLine(stdoutBuf.slice(0, nl).trimEnd());
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString("utf8")).slice(-4000);
    });
    child.on("error", (err) => {
      job.child = null;
      reject(new Error(`${path.basename(cmd)}: ${err.message}`));
    });
    child.on("close", (code) => {
      job.child = null;
      resolve({ code: code ?? -1, stderrTail });
    });
  });
}

/** Naprawa DXF z dwg2dxf: surowe \n w wartościach MTEXT łamią strukturę
 *  par (kod, wartość) — doklejamy kontynuacje do poprzedniej wartości jako \P. */
export function fixDxf(raw: Buffer): Buffer {
  const CODE_RE = /^\s*-?\d+\s*$/;
  const lines = raw.toString("latin1").split("\r\n");
  const out: string[] = [];
  let expectCode = true;
  for (const ln of lines) {
    if (expectCode) {
      if (CODE_RE.test(ln)) {
        out.push(ln);
        expectCode = false;
      } else if (out.length) {
        out[out.length - 1] += "\\P" + ln; // kontynuacja poprzedniej wartości
      } else {
        out.push(ln);
      }
    } else {
      out.push(ln);
      expectCode = true;
    }
  }
  return Buffer.from(out.join("\r\n"), "latin1");
}

async function runJob(job: DwgJob, dwgBuffer: Buffer): Promise<void> {
  const tmp = await mkdtemp(path.join(tmpdir(), "dwg-import-"));
  job.tmpDir = tmp;
  const dwgPath = path.join(tmp, "in.dwg");
  const dxfPath = path.join(tmp, "out.dxf");
  const fixedPath = path.join(tmp, "fixed.dxf");
  const svgPath = path.join(tmp, "out.svg");
  const metaPath = path.join(tmp, "out.meta.json");
  const pngPath = path.join(tmp, "out.png");

  const timeout = setTimeout(() => {
    job.cancelled = true;
    job.stage = "error";
    job.error = "Przekroczono limit czasu konwersji (5 min)";
    try { job.child?.kill("SIGKILL"); } catch { /* noop */ }
  }, JOB_TIMEOUT_MS);

  try {
    await writeFile(dwgPath, dwgBuffer);

    // ── convert: DWG → DXF (LibreDWG) + naprawa MTEXT ──
    setStage(job, "convert", "Konwersja DWG → DXF", 0.02);
    const conv = await runChild(job, bin("dwg2dxf"), ["-y", "-o", dxfPath, dwgPath]);
    if (job.cancelled) return;
    // dwg2dxf potrafi zwrócić kod !=0 mimo poprawnego wyjścia — decyduje istnienie pliku
    let dxfRaw: Buffer;
    try {
      dxfRaw = await readFile(dxfPath);
    } catch {
      throw new Error(
        `dwg2dxf nie wygenerował DXF (kod ${conv.code}). ${conv.stderrTail.slice(-300)}`
      );
    }
    if (dxfRaw.length < 1000) throw new Error("dwg2dxf: pusty/uszkodzony DXF");
    setStage(job, "convert", "Naprawa DXF", 0.1);
    await writeFile(fixedPath, fixDxf(dxfRaw));
    if (job.cancelled) return;

    // ── analyze + render SVG (python/ezdxf; postęp z linii "PROG f etap") ──
    setStage(job, "analyze", "Analiza rysunku", 0.15);
    let metaLine = "";
    const py = await runChild(job, PYTHON, [SCRIPT, fixedPath, svgPath, metaPath], (line) => {
      if (line.startsWith("PROG ")) {
        const sp = line.indexOf(" ", 5);
        const frac = parseFloat(line.slice(5, sp < 0 ? undefined : sp));
        const label = sp < 0 ? "" : line.slice(sp + 1);
        if (Number.isFinite(frac)) {
          // frac<0.68 = analiza, dalej render SVG
          const stage = frac < 0.68 ? "analyze" : "render";
          setStage(job, stage, label || (stage === "analyze" ? "Analiza rysunku" : "Render"), 0.15 + 0.6 * frac);
        }
      } else if (line.startsWith("META ")) {
        metaLine = line.slice(5);
      }
    });
    if (job.cancelled) return;
    if (py.code !== 0 || !metaLine) {
      throw new Error(`analiza DXF nie powiodła się (kod ${py.code}). ${py.stderrTail.slice(-300)}`);
    }
    const meta = JSON.parse(metaLine) as Record<string, unknown>;

    // ── raster: SVG → PNG (resvg, wątek natywny — nie blokuje pętli zdarzeń) ──
    setStage(job, "render", "Rasteryzacja", 0.78);
    const { Resvg } = await import("@resvg/resvg-js");
    const svg = await readFile(svgPath, "utf8");
    if (job.cancelled) return;
    const png = new Resvg(svg, { background: "#ffffff" }).render().asPng();
    await writeFile(pngPath, png);
    await rm(svgPath, { force: true }); // SVG bywa >20 MB — nie trzymaj bez potrzeby
    if (job.cancelled) return;

    setStage(job, "done", "Gotowe", 1);
    job.result = { meta, pngPath, pngBytes: png.length };
  } finally {
    clearTimeout(timeout);
    // pliki pośrednie zawsze do kosza; PNG zostaje do odbioru (TTL sprząta resztę)
    await Promise.all(
      [dwgPath, dxfPath, fixedPath, svgPath, metaPath].map((f) => rm(f, { force: true }).catch(() => {}))
    );
    if (job.cancelled && job.stage !== "error") {
      job.stage = "cancelled";
      if (job.tmpDir) await rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function createDwgJob(projectId: number, fileName: string, dwgBuffer: Buffer): DwgJob {
  const job: DwgJob = {
    id: randomBytes(12).toString("hex"),
    projectId,
    fileName,
    stage: "queued",
    stageLabel: "W kolejce",
    progress: 0,
    cancelled: false,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  queue = queue
    .then(async () => {
      if (job.cancelled) return;
      try {
        await runJob(job, dwgBuffer);
      } catch (err) {
        if (!job.cancelled) {
          job.stage = "error";
          job.error = err instanceof Error ? err.message : String(err);
        }
        if (job.tmpDir) await rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    })
    .catch(() => {});
  return job;
}

export function getDwgJob(id: string): DwgJob | undefined {
  return jobs.get(id);
}

export function cancelDwgJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  if (job.stage !== "done") job.stage = "cancelled";
  try { job.child?.kill("SIGKILL"); } catch { /* noop */ }
  if (job.tmpDir) rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
  jobs.delete(id);
  return true;
}
