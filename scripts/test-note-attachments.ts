/**
 * Test załączników do notatek wydarzeń (calendar_note_attachments) — przez trasy Hono
 * (app.request) z podstawionym userem w kontekście, na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-note-attachments.ts
 *
 * Sprawdza: POST multipart z PNG (→ kind image, image/webp, plik .webp na dysku, width/height),
 * PDF bez zmian, JSON jak dotąd, notatka z samymi plikami (pusty tekst OK), odrzucenia
 * (16 plików, >5 MB, .exe, pusty tekst bez plików, obrazek nie do zdekodowania), loadNotes
 * z załącznikami (kształt JSON), GET (nagłówki, ?download=1, treść), DELETE (uprawnienia,
 * wiersz + plik znikają), kaskada FK po twardym usunięciu notatki, removeEventAttachmentDir,
 * maile .msg/.eml na białej liście (mail upuszczony na kalendarz zostaje przy notatce),
 * a także konsumentów notatki BEZ TEKSTU: dymek podglądu (GET /events/:id) i asystent
 * (get_event → liczba załączników).
 * Pliki lądują w <katalog bazy>/attachments — na kopii to katalog tymczasowy.
 * Sprząta po sobie HARD (events + notes + activity_log + katalog załączników), także przy błędzie.
 */
import { Hono } from "hono";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { db, schema } from "../src/db/index.js";
import { and, eq, inArray, like } from "drizzle-orm";
import calendarRoutes from "../src/routes/calendar.js";
import { ATTACHMENTS_DIR, removeEventAttachmentDir, resolveStoredPath } from "../src/lib/calendar-attachments.js";
import { loadNotes } from "../src/lib/calendar-queries.js";
import { buildCalendarTools } from "../src/lib/ai/calendarTools.js";
import { ASSISTANT_DEFAULTS } from "../src/lib/ai/assistantConfig.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const PREFIX = "__ATT_TEST__";

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const other = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !other) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");

function cleanup() {
  const ids = db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).all().map((r) => r.id);
  for (const id of ids) removeEventAttachmentDir(id);
  if (ids.length) {
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, ids)).run();
    db.delete(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, ids))).run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, ids)).run();
  }
  return ids.length;
}
cleanup();

/** Aplikacja testowa: router kalendarza pod /calendar (jak w src/routes/index.ts), user z kontekstu. */
function appFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.route("/calendar", calendarRoutes);
  return app;
}
const asAdmin = appFor(admin);
const asOther = appFor(other);

type NoteJson = { id: number; text: string; attachments: { id: number; fileName: string; mime: string; size: number; kind: string; width: number | null; height: number | null; url: string }[] };
type Resp = { success: boolean; data?: NoteJson; error?: string };

function multipart(text: string | null, files: { name: string; type: string; data: Buffer }[]): FormData {
  const fd = new FormData();
  if (text !== null) fd.set("text", text);
  for (const f of files) fd.append("files", new File([new Uint8Array(f.data)], f.name, { type: f.type }));
  return fd;
}
async function postNote(app: Hono, eventId: number, body: FormData | object): Promise<{ status: number; json: Resp }> {
  const res = await app.request(`/calendar/events/${eventId}/notes`, body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  return { status: res.status, json: (await res.json()) as Resp };
}
const storedPathOf = (attId: number) => db.select().from(schema.calendarNoteAttachments).where(eq(schema.calendarNoteAttachments.id, attId)).get()?.storedPath ?? null;
const fileExists = (attId: number) => {
  const p = storedPathOf(attId);
  const abs = p ? resolveStoredPath(p) : null;
  return !!abs && existsSync(abs);
};

const ev = db
  .insert(schema.calendarEvents)
  .values({ type: "serwis", title: `${PREFIX} Serwis`, startAt: "2026-09-07T09:00", endAt: "2026-09-07T11:00", allDay: false, status: "planned", department: "technical", createdBy: admin.id, updatedBy: admin.id })
  .returning()
  .get();

// Fikstury: PNG 3000×1500 (żeby sprawdzić zmniejszenie do 2560), mały PDF, "exe", >5 MB.
const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);

try {
  // --- PNG → WebP ---
  const r1 = await postNote(asOther, ev.id, multipart("Zdjęcie z serwisu", [{ name: "kamera 1.PNG", type: "image/png", data: png }]));
  const a1 = r1.json.data?.attachments?.[0];
  ok("POST multipart PNG → 201, kind image, mime image/webp, nazwa .webp", r1.status === 201 && a1?.kind === "image" && a1.mime === "image/webp" && a1.fileName === "kamera 1.webp", r1.json);
  ok("PNG: zmniejszony do 2560×1280, size = bajty na dysku > 0", a1?.width === 2560 && a1?.height === 1280 && (a1?.size ?? 0) > 0, a1);
  ok("PNG: url = /api/calendar/attachments/<id>", a1?.url === `/api/calendar/attachments/${a1?.id}`, a1?.url);
  ok("PNG: plik .webp na dysku w katalogu <eventId>/", !!a1 && fileExists(a1.id) && (storedPathOf(a1.id) ?? "").startsWith(`${ev.id}/`) && (storedPathOf(a1.id) ?? "").endsWith(".webp"), storedPathOf(a1?.id ?? 0));
  ok("PNG: text notatki zapisany", r1.json.data?.text === "Zdjęcie z serwisu");
  const log1 = db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, ev.id))).all();
  ok("activity_log note_added z liczbą załączników", log1.some((l) => l.action === "note_added" && /Dodano notatkę: Zdjęcie z serwisu \(załączniki: 1\)$/.test(l.summary ?? "")), log1.map((l) => l.summary));

  // --- PDF (octet-stream z przeglądarki — ufamy rozszerzeniu) + txt, pusty tekst ---
  const r2 = await postNote(asAdmin, ev.id, multipart("", [
    { name: "protokół.pdf", type: "application/octet-stream", data: pdf },
    { name: "notatki.txt", type: "text/plain", data: Buffer.from("abc") },
  ]));
  const a2 = r2.json.data?.attachments ?? [];
  ok("POST PDF+TXT, pusty tekst → 201, 2 załączniki kind file", r2.status === 201 && a2.length === 2 && a2.every((a) => a.kind === "file" && a.width === null && a.height === null), r2.json);
  ok("PDF: mime z rozszerzenia (application/pdf), size = surowy, nazwa bez zmian", a2[0]?.mime === "application/pdf" && a2[0]?.size === pdf.length && a2[0]?.fileName === "protokół.pdf", a2[0]);
  ok("PDF: plik na dysku z rozszerzeniem .pdf", !!a2[0] && fileExists(a2[0].id) && (storedPathOf(a2[0].id) ?? "").endsWith(".pdf"));
  ok("pusty tekst z załącznikami → text = \"\"", r2.json.data?.text === "");

  // --- JSON jak dotąd ---
  const r3 = await postNote(asAdmin, ev.id, { text: "Zwykła JSON-owa" });
  ok("POST JSON → 201, attachments: []", r3.status === 201 && r3.json.data?.text === "Zwykła JSON-owa" && Array.isArray(r3.json.data?.attachments) && r3.json.data!.attachments.length === 0, r3.json);

  // --- odrzucenia ---
  const before = readdirSync(join(ATTACHMENTS_DIR, String(ev.id))).length;
  const r4 = await postNote(asAdmin, ev.id, multipart("x", Array.from({ length: 16 }, (_, i) => ({ name: `p${i}.txt`, type: "text/plain", data: Buffer.from("a") }))));
  ok("16 plików → 400 „Maksymalnie 15 plików”", r4.status === 400 && r4.json.error === "Maksymalnie 15 plików", r4.json);
  const r5 = await postNote(asAdmin, ev.id, multipart("x", [{ name: "duży.pdf", type: "application/pdf", data: big }]));
  ok(">5 MB → 400 „Plik duży.pdf przekracza 5 MB”", r5.status === 400 && r5.json.error === "Plik duży.pdf przekracza 5 MB", r5.json);
  const r6 = await postNote(asAdmin, ev.id, multipart("x", [{ name: "wirus.exe", type: "application/octet-stream", data: Buffer.from("MZ") }]));
  ok(".exe → 400 „Nieobsługiwany typ pliku: wirus.exe”", r6.status === 400 && r6.json.error === "Nieobsługiwany typ pliku: wirus.exe", r6.json);
  const r7 = await postNote(asAdmin, ev.id, multipart("   ", []));
  ok("pusty tekst bez plików (multipart) → 400", r7.status === 400 && r7.json.error === "Treść notatki jest wymagana", r7.json);
  const r7b = await postNote(asAdmin, ev.id, { text: "" });
  ok("pusty tekst bez plików (JSON) → 400", r7b.status === 400, r7b.json);
  const r8 = await postNote(asAdmin, ev.id, multipart("x", [{ name: "zdjęcie.jpg", type: "image/jpeg", data: Buffer.from("to nie jest jpeg") }]));
  ok("obrazek nie do zdekodowania → 400 „Nie udało się przetworzyć obrazka: zdjęcie.jpg”", r8.status === 400 && r8.json.error === "Nie udało się przetworzyć obrazka: zdjęcie.jpg", r8.json);
  // Mieszany zestaw: 1 dobry + 1 zły — nic nie zostaje na dysku.
  const r9 = await postNote(asAdmin, ev.id, multipart("x", [{ name: "ok.png", type: "image/png", data: png }, { name: "zły.jpg", type: "image/jpeg", data: Buffer.from("nope") }]));
  ok("mieszany zestaw z błędem → 400 i brak osieroconych plików na dysku", r9.status === 400 && readdirSync(join(ATTACHMENTS_DIR, String(ev.id))).length === before, { status: r9.status, files: readdirSync(join(ATTACHMENTS_DIR, String(ev.id))).length, before });
  const r10 = await postNote(asAdmin, 99999999, multipart("x", [{ name: "ok.png", type: "image/png", data: png }]));
  ok("nieistniejące wydarzenie → 404 (bez zapisu pliku)", r10.status === 404 && !existsSync(join(ATTACHMENTS_DIR, "99999999")), r10.json);

  // --- loadNotes: kształt + bez N+1 (po prostu kształt) ---
  const notes = loadNotes(db, ev.id);
  ok("loadNotes: 3 notatki, załączniki [1, 2, 0]", notes.length === 3 && notes.map((n) => n.attachments.length).join() === "1,2,0", notes.map((n) => n.attachments.length));
  const keys = Object.keys(notes[0].attachments[0]).sort().join();
  // `origin` doszło z migracją 0096 (upload vs załącznik wypakowany z maila .msg).
  ok(
    "loadNotes: klucze załącznika id,fileName,mime,size,kind,origin,width,height,url",
    keys === "fileName,height,id,kind,mime,origin,size,url,width",
    keys
  );
  ok("loadNotes: zwykły upload ma origin=upload", notes[0].attachments[0].origin === "upload", notes[0].attachments[0].origin);
  const g = await asOther.request(`/calendar/events/${ev.id}/notes`);
  const gj = (await g.json()) as { data: NoteJson[] };
  ok("GET /events/:id/notes zwraca attachments", gj.data[0]?.attachments?.[0]?.id === a1?.id, gj.data[0]);
  const ge = await asOther.request(`/calendar/events/${ev.id}`);
  const gej = (await ge.json()) as { data: { notes: NoteJson[] } };
  ok("GET /events/:id → notes[].attachments", gej.data.notes[1]?.attachments?.length === 2, gej.data.notes.map((n) => n.attachments.length));
  // Dymek podglądu wydarzenia (frontend/src/pages/Calendar.tsx) bierze OSTATNIĄ notatkę
  // z tej odpowiedzi i przy pustym tekście pokazuje liczbę załączników — musi ją dostać.
  ok(
    "GET /events/:id → notatka bez tekstu wraca z załącznikami (dymek pokazuje „N załączników”)",
    gej.data.notes[1]?.text === "" && gej.data.notes[1]?.attachments?.length === 2,
    gej.data.notes[1]
  );

  // --- asystent: get_event pokazuje liczbę załączników (notatka bez tekstu nie może być „pusta”) ---
  const tools = buildCalendarTools(admin, { ...ASSISTANT_DEFAULTS, allowModifications: false });
  const ge2 = (await (tools.get_event as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
    { eventId: ev.id },
    { toolCallId: "t", messages: [] }
  )) as { event: { notes: { text: string; attachments?: number }[] } };
  ok(
    "get_event: notatka z plikami ma attachments, notatka bez plików nie ma tego pola",
    ge2.event.notes[0]?.attachments === 1 && ge2.event.notes[1]?.attachments === 2 && !("attachments" in (ge2.event.notes[2] ?? {})),
    ge2.event.notes
  );

  // --- GET pliku ---
  const f1 = await asOther.request(`/calendar/attachments/${a1!.id}`);
  const body1 = Buffer.from(await f1.arrayBuffer());
  ok("GET załącznika → 200, image/webp, Cache-Control private, inline", f1.status === 200 && f1.headers.get("content-type") === "image/webp" && f1.headers.get("cache-control") === "private, max-age=86400" && /^inline;/.test(f1.headers.get("content-disposition") ?? ""), Object.fromEntries(f1.headers));
  ok("GET załącznika → treść to WebP o rozmiarze = size", body1.length === a1!.size && body1.subarray(0, 4).toString() === "RIFF" && body1.subarray(8, 12).toString() === "WEBP", { len: body1.length, size: a1!.size });
  const meta = await sharp(body1).metadata();
  ok("GET załącznika → WebP 2560×1280", meta.format === "webp" && meta.width === 2560 && meta.height === 1280, meta);
  const f2 = await asOther.request(`/calendar/attachments/${a2[0].id}?download=1`);
  const cd = f2.headers.get("content-disposition") ?? "";
  ok("GET ?download=1 → attachment; filename*=UTF-8''protok%C3%B3%C5%82.pdf, application/pdf", f2.status === 200 && f2.headers.get("content-type") === "application/pdf" && /^attachment;/.test(cd) && cd.includes("filename*=UTF-8''protok%C3%B3%C5%82.pdf"), cd);
  ok("GET ?download=1 → bajty PDF bez zmian", Buffer.from(await f2.arrayBuffer()).equals(pdf));
  const f3 = await asOther.request(`/calendar/attachments/99999999`);
  ok("GET nieistniejący → 404", f3.status === 404);
  const f4 = await asOther.request(`/calendar/attachments/abc`);
  ok("GET złe id → 400", f4.status === 400);
  ok("resolveStoredPath: path traversal → null", resolveStoredPath("../alfa.db") === null && resolveStoredPath("/etc/passwd") === null && resolveStoredPath(`${ev.id}/x.webp`) !== null);

  // --- DELETE ---
  const d1 = await asOther.request(`/calendar/attachments/${a2[0].id}`, { method: "DELETE" });
  ok("DELETE cudzego załącznika (nie autor, nie admin) → 403, plik zostaje", d1.status === 403 && fileExists(a2[0].id), await d1.json());
  const d2 = await asOther.request(`/calendar/attachments/${a1!.id}`, { method: "DELETE" });
  const d2j = (await d2.json()) as { success: boolean; data?: { id: number; noteId: number } };
  ok("DELETE własnego → 200 {id, noteId}, wiersz i plik znikają", d2.status === 200 && d2j.data?.id === a1!.id && d2j.data?.noteId === r1.json.data!.id && storedPathOf(a1!.id) === null && loadNotes(db, ev.id)[0].attachments.length === 0, d2j);
  const d3 = await asAdmin.request(`/calendar/attachments/${a2[1].id}`, { method: "DELETE" });
  ok("DELETE przez admina cudzego → 200, plik znika", d3.status === 200 && storedPathOf(a2[1].id) === null);
  const d4 = await asAdmin.request(`/calendar/attachments/${a1!.id}`, { method: "DELETE" });
  ok("DELETE już usuniętego → 404", d4.status === 404);

  // --- maile na białej liście: .msg z Outlooka i .eml ---
  // Mail przeciągnięty z Outlooka na kalendarz zostaje załącznikiem pierwszej notatki
  // (src/lib/outlook-msg.ts, POST /calendar/msg/parse) — bez tych rozszerzeń w
  // DOC_MIME_BY_EXT oryginał maila nie miałby gdzie wylądować.
  const rMail = await postNote(asAdmin, ev.id, multipart("Mail z Outlooka", [
    // Przeglądarka przy drag&drop podaje octet-stream — decyduje rozszerzenie.
    { name: "Awaria kamery.msg", type: "application/octet-stream", data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
    { name: "kopia.eml", type: "message/rfc822", data: Buffer.from("From: a@b.invalid\r\n\r\ntreść") },
  ]));
  const aMail = rMail.json.data?.attachments ?? [];
  ok(
    ".msg + .eml → 201, kind file, MIME z rozszerzenia",
    rMail.status === 201 &&
      aMail.length === 2 &&
      aMail[0]?.mime === "application/vnd.ms-outlook" &&
      aMail[1]?.mime === "message/rfc822" &&
      aMail.every((a) => a.kind === "file"),
    rMail.json
  );
  ok(
    ".msg: plik na dysku z rozszerzeniem .msg, nazwa bez zmian",
    !!aMail[0] && fileExists(aMail[0].id) && (storedPathOf(aMail[0].id) ?? "").endsWith(".msg") && aMail[0].fileName === "Awaria kamery.msg",
    aMail[0]
  );

  // --- soft delete notatki nie rusza plików; kaskada FK przy twardym usunięciu ---
  const pdfPath = resolveStoredPath(storedPathOf(a2[0].id)!)!;
  const sd = await asAdmin.request(`/calendar/notes/${r2.json.data!.id}`, { method: "DELETE" });
  ok("soft delete notatki → 200, wiersz załącznika i plik zostają", sd.status === 200 && storedPathOf(a2[0].id) !== null && existsSync(pdfPath));
  db.delete(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, r2.json.data!.id)).run();
  ok("twarde usunięcie notatki → FK cascade kasuje wiersz załącznika", storedPathOf(a2[0].id) === null);
  removeEventAttachmentDir(ev.id);
  ok("removeEventAttachmentDir → katalog wydarzenia znika", !existsSync(join(ATTACHMENTS_DIR, String(ev.id))));
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}
console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
