/**
 * Test kalendarza „na żywo" (SSE) end-to-end, na KOPII bazy:
 *   npx tsx scripts/test-calendar-live.ts
 *
 * Co sprawdza:
 *  - GET /api/calendar/live wymaga sesji (bez cookie → 401),
 *  - po podłączeniu przychodzi ramka `ready` z listą działów,
 *  - każda mutacja wydarzenia publikuje zdarzenie z właściwym `kind` i `ids`:
 *    POST /events → created, PATCH /events/:id/move → moved, POST notatki → notes,
 *    PUT /events/:id → updated, DELETE → deleted, POST /restore → restored,
 *  - `actorUserId` wskazuje autora zmiany (front po tym pomija własne zapisy),
 *  - filtr działowy: subskrybent `?department=handlowy` NIE dostaje zmian technicznych.
 *
 * BEZPIECZEŃSTWO. Test NIGDY nie dotyka `data/alfa.db`: robi kopię (backup, bo baza chodzi
 * w WAL), przepuszcza przez nią migracje i uruchamia backend z `ALFA_DB_PATH` wskazującym
 * kopię. Katalog roboczy z kopią znika w `finally` — także po błędzie. Sam skrypt też nie
 * importuje `src/db/index.js` (otworzyłby produkcyjną bazę) — do sesji używa surowego
 * better-sqlite3 na kopii.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const SOURCE = process.env.ALFA_DB_PATH ?? "./data/alfa.db";
// Katalog roboczy poza drzewem projektu. `ALFA_TEST_DIR` pozwala wskazać scratchpad;
// świadomie NIE bierzemy `TMPDIR`, bo tam tsx trzyma swoje gniazda IPC i podrzucenie
// mu innego katalogu wywala proces potomny (EADDRINUSE na pliku .pipe).
const WORKDIR = join(process.env.ALFA_TEST_DIR ?? "/tmp", `alfa-live-${process.pid}`);
const COPY = join(WORKDIR, "alfa.db");

if (!existsSync(SOURCE)) {
  console.error(`Nie ma bazy źródłowej: ${SOURCE}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Zdarzenie SSE — kształt z src/lib/calendar-live.ts
// ---------------------------------------------------------------------------

interface LiveChange {
  department: "technical" | "handlowy";
  kind: "created" | "updated" | "moved" | "deleted" | "restored" | "notes";
  ids: number[];
  actorUserId: number | null;
  /** Karta, która zrobiła zapis (nagłówek `X-Alfa-Client`); null = zapis spoza przeglądarki. */
  actorClientId: string | null;
  ts: number;
}

/** Otwarty strumień SSE + bufor odebranych ramek. */
interface LiveStream {
  changes: LiveChange[];
  ready: Promise<string[]>;
  close: () => void;
}

/**
 * Parser SSE „ile trzeba": ramki rozdzielone pustą linią, interesują nas `event:` i `data:`.
 * Komentarze (`: ping`) pomijamy — są tylko po to, żeby proxy nie ubiło połączenia.
 */
function openLive(base: string, token: string, department?: string): Promise<LiveStream> {
  const controller = new AbortController();
  const changes: LiveChange[] = [];
  let readyResolve: (d: string[]) => void = () => {};
  let readyReject: (e: unknown) => void = () => {};
  const ready = new Promise<string[]>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  const url = `${base}/api/calendar/live${department ? `?department=${department}` : ""}`;

  return fetch(url, { headers: { cookie: `alfa_session=${token}` }, signal: controller.signal }).then((res) => {
    if (!res.ok || !res.body) throw new Error(`SSE ${url}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith(":")) continue; // heartbeat
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trim());
            }
            if (data.length === 0) continue;
            const payload = JSON.parse(data.join("\n"));
            if (event === "ready") readyResolve(payload.departments as string[]);
            else if (event === "calendar") changes.push(payload as LiveChange);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) readyReject(e);
      }
    })();
    return { changes, ready, close: () => controller.abort() };
  });
}

/** Czeka na pierwszą ramkę spełniającą warunek (albo `null` po timeoucie). */
async function waitFor(stream: LiveStream, pred: (c: LiveChange) => boolean, ms = 4000): Promise<LiveChange | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = stream.changes.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Uchwyt w obiekcie, nie w `let` — inaczej TS zawęża zmienną do `null` (przypisanie jest
// w `main()`, poza analizowanym przepływem) i `server?.kill()` w `finally` nie kompiluje się.
const proc: { server: ChildProcess | null } = { server: null };

async function main() {
  mkdirSync(WORKDIR, { recursive: true });

  // Kopia przez backup(): baza chodzi w WAL, sam plik .db bywa niekompletny.
  const src = new Database(SOURCE, { readonly: true });
  await src.backup(COPY);
  src.close();
  console.log(`Kopia bazy: ${COPY}`);

  // Migracje na kopii — test ma chodzić na aktualnym schemacie.
  const mig = spawnSync("npx", ["tsx", "src/db/migrate.ts"], {
    stdio: "inherit",
    env: { ...process.env, ALFA_DB_PATH: COPY },
  });
  if (mig.status !== 0) throw new Error("Migracje na kopii nie przeszły");

  // Sesja admina wprost w tabeli `sessions` — EventSource i tak niesie wyłącznie cookie.
  const raw = new Database(COPY);
  raw.pragma("busy_timeout = 5000");
  const admin = raw.prepare("SELECT id, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as
    | { id: number; email: string }
    | undefined;
  if (!admin) throw new Error("Brak administratora w bazie");
  const token = randomBytes(32).toString("hex");
  raw
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, admin.id, Date.now() + 60 * 60 * 1000);
  raw.close();
  console.log(`Sesja testowa: user #${admin.id} (${admin.email})`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("npx", ["tsx", "src/index.ts"], {
    env: { ...process.env, ALFA_DB_PATH: COPY, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.server = server;
  server.stderr?.on("data", (b) => process.stderr.write(`[serwer] ${b}`));

  // Czekamy na /healthz zamiast na tekst w logu — start robi migracje i seedy.
  const upDeadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode != null) throw new Error(`Backend zakończył się kodem ${server.exitCode}`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch {
      /* jeszcze nie wstał */
    }
    if (Date.now() > upDeadline) throw new Error("Backend nie wstał w 60 s");
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`Backend: ${base}`);

  // Identyfikator „karty", którą udaje test — backend ma go odesłać w `actorClientId`.
  const CLIENT_ID = `test-${randomBytes(8).toString("hex")}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie: `alfa_session=${token}`,
        "X-Alfa-Client": CLIENT_ID,
        ...(init?.headers ?? {}),
      },
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  // --- 1. Bez sesji: 401 --------------------------------------------------
  {
    const res = await fetch(`${base}/api/calendar/live`);
    ok("GET /calendar/live bez cookie → 401", res.status === 401, res.status);
    await res.body?.cancel();
  }

  // --- 1b. Nagłówki strumienia -------------------------------------------
  // `streamSSE` ustawia własny `Cache-Control: no-cache` tuż przed callbackiem, więc
  // nadpisanie musi lecieć W ŚRODKU callbacku — ten test pilnuje, że faktycznie leci.
  {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/calendar/live`, {
      headers: { cookie: `alfa_session=${token}` },
      signal: ctrl.signal,
    });
    const cc = res.headers.get("cache-control") ?? "";
    ok("Content-Type: text/event-stream", (res.headers.get("content-type") ?? "").includes("text/event-stream"), res.headers.get("content-type"));
    ok("Cache-Control ma no-cache i no-transform", cc.includes("no-cache") && cc.includes("no-transform"), cc);
    ok("X-Accel-Buffering: no", res.headers.get("x-accel-buffering") === "no", res.headers.get("x-accel-buffering"));
    ctrl.abort();
  }

  // --- 2. Podłączenie i ramka `ready` -------------------------------------
  const live = await openLive(base, token);
  const departments = await Promise.race([
    live.ready,
    new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("brak ramki ready w 5 s")), 5000)),
  ]);
  ok("ramka `ready` z działami admina", departments.includes("technical") && departments.includes("handlowy"), departments);

  // Drugi subskrybent — TYLKO dział handlowy; nie ma prawa dostać zmian technicznych.
  const salesLive = await openLive(base, token, "handlowy");
  await salesLive.ready;

  let eventId = 0;
  try {
    // --- 3. POST /events → created ----------------------------------------
    const created = await api("/calendar/events", {
      method: "POST",
      body: JSON.stringify({
        department: "technical",
        type: "biuro",
        title: `ZZ-LIVE ${Date.now()}`,
        startAt: "2027-04-12T09:00",
        endAt: "2027-04-12T10:00",
      }),
    });
    ok("POST /calendar/events → 201", created.status === 201, created.body);
    eventId = Number((created.body.data as Record<string, unknown> | undefined)?.id);
    const evCreated = await waitFor(live, (c) => c.kind === "created" && c.ids.includes(eventId));
    ok("SSE created dotarło", evCreated != null, live.changes);
    ok("created: dział techniczny", evCreated?.department === "technical", evCreated);
    ok("created: actorUserId = autor zmiany", evCreated?.actorUserId === admin.id, evCreated);
    // Klucz pomijania własnych zmian na froncie — MUSI być identyfikatorem KARTY z nagłówka,
    // nie użytkownika, inaczej druga karta tej samej osoby nigdy się nie odświeży.
    ok("created: actorClientId = nagłówek X-Alfa-Client", evCreated?.actorClientId === CLIENT_ID, evCreated);
    ok("created: ts jest liczbą", typeof evCreated?.ts === "number" && (evCreated?.ts ?? 0) > 0, evCreated);

    // --- 4. PATCH /events/:id/move → moved --------------------------------
    const moved = await api(`/calendar/events/${eventId}/move`, {
      method: "PATCH",
      body: JSON.stringify({ startAt: "2027-04-13T11:00", endAt: "2027-04-13T12:30", allDay: false }),
    });
    ok("PATCH /move → 200", moved.status === 200, moved.body);
    const evMoved = await waitFor(live, (c) => c.kind === "moved" && c.ids.includes(eventId));
    ok("SSE moved dotarło z ids = [id]", evMoved != null && evMoved.ids.length === 1, live.changes);
    ok("moved: dział techniczny", evMoved?.department === "technical", evMoved);
    ok("moved: actorClientId z nagłówka", evMoved?.actorClientId === CLIENT_ID, evMoved);

    // Mutacja BEZ nagłówka (skrypt, integracja) → actorClientId null, czyli nikt nie pomija.
    const movedAnon = await fetch(`${base}/api/calendar/events/${eventId}/move`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: `alfa_session=${token}` },
      body: JSON.stringify({ startAt: "2027-04-14T11:00", endAt: "2027-04-14T12:30", allDay: false }),
    });
    ok("PATCH /move bez X-Alfa-Client → 200", movedAnon.status === 200, movedAnon.status);
    const evAnon = await waitFor(live, (c) => c.kind === "moved" && c.actorClientId === null);
    ok("bez nagłówka: actorClientId = null", evAnon != null, live.changes);

    // --- 5. Notatka → notes -----------------------------------------------
    const note = await api(`/calendar/events/${eventId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text: "ZZ-LIVE notatka testowa" }),
    });
    ok("POST notatki → 201", note.status === 201, note.body);
    const noteId = Number((note.body.data as Record<string, unknown> | undefined)?.id);
    ok("SSE notes dotarło", (await waitFor(live, (c) => c.kind === "notes" && c.ids.includes(eventId))) != null, live.changes);

    // --- 6. PUT /events/:id → updated -------------------------------------
    const updated = await api(`/calendar/events/${eventId}`, {
      method: "PUT",
      body: JSON.stringify({
        department: "technical",
        type: "biuro",
        title: "ZZ-LIVE po edycji",
        startAt: "2027-04-13T11:00",
        endAt: "2027-04-13T13:00",
      }),
    });
    ok("PUT /events/:id → 200", updated.status === 200, updated.body);
    ok("SSE updated dotarło", (await waitFor(live, (c) => c.kind === "updated" && c.ids.includes(eventId))) != null, live.changes);

    // --- 7. DELETE + restore ----------------------------------------------
    ok("DELETE notatki → 200", (await api(`/calendar/notes/${noteId}`, { method: "DELETE" })).status === 200);
    const del = await api(`/calendar/events/${eventId}`, { method: "DELETE" });
    ok("DELETE /events/:id → 200", del.status === 200, del.body);
    ok("SSE deleted dotarło", (await waitFor(live, (c) => c.kind === "deleted" && c.ids.includes(eventId))) != null, live.changes);

    const restored = await api(`/calendar/events/${eventId}/restore`, { method: "POST" });
    ok("POST /restore → 200", restored.status === 200, restored.body);
    ok("SSE restored dotarło", (await waitFor(live, (c) => c.kind === "restored" && c.ids.includes(eventId))) != null, live.changes);

    // --- 8. Filtr działowy -------------------------------------------------
    ok(
      "subskrybent działu handlowego NIE dostał zmian technicznych",
      salesLive.changes.length === 0,
      salesLive.changes
    );
  } finally {
    live.close();
    salesLive.close();
  }
}

try {
  await main();
} catch (error) {
  failures++;
  console.error("FAIL (wyjątek):", error);
} finally {
  proc.server?.kill("SIGTERM");
  // Kopia znika niezależnie od wyniku — nie zostawiamy śmieci.
  rmSync(WORKDIR, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} asercji nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
