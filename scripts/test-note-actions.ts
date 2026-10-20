/**
 * Kafle z treści notatki (frontend/src/technik/lib/note-actions.ts):
 *   npx tsx scripts/test-note-actions.ts
 *
 * Telefony PL w różnych zapisach i linki do map → kafle „Zadzwoń”/„Nawiguj”
 * w panelu technika i na stronie linku `/u/:token`. Czysta funkcja, bez sieci.
 */
import {
  extractMaps,
  extractNoteActions,
  extractPhones,
  formatPlPhone,
} from "../frontend/src/technik/lib/note-actions.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const phones = (t: string) => extractPhones(t).map((p) => `${p.display}|${p.href}`);

// --- telefony ---
ok("komórka 3-3-3 spacje", phones("Dzwonić: 600 123 456").join() === "600 123 456|tel:+48600123456", phones("Dzwonić: 600 123 456"));
ok("komórka z myślnikami", phones("tel 600-123-456.").join() === "600 123 456|tel:+48600123456", phones("tel 600-123-456."));
ok("komórka ciągiem", phones("600123456").join() === "600 123 456|tel:+48600123456");
ok("+48 z spacjami", phones("kontakt +48 600 123 456").join() === "600 123 456|tel:+48600123456", phones("kontakt +48 600 123 456"));
ok("+48 bez spacji", phones("+48600123456").join() === "600 123 456|tel:+48600123456");
ok("0048", phones("0048 600 123 456").join() === "600 123 456|tel:+48600123456", phones("0048 600 123 456"));
ok("stacjonarny 2-3-2-2", phones("biuro 22 123 45 67").join() === "22 123 45 67|tel:+48221234567", phones("biuro 22 123 45 67"));
ok("stacjonarny (22)", phones("(22) 123 45 67").join() === "22 123 45 67|tel:+48221234567", phones("(22) 123 45 67"));
ok("stacjonarny ciągiem → 2-3-2-2", phones("221234567").join() === "22 123 45 67|tel:+48221234567");
ok("tel:600123456", phones("tel:600123456").length === 1, phones("tel:600123456"));
ok("NIP 10 cyfr — nic", phones("NIP 123-456-78-90").length === 0, phones("NIP 123-456-78-90"));
ok("NIP ciągiem — nic", phones("NIP 1234567890").length === 0);
ok("kwota z przecinkiem — nic", phones("razem 123 456 789,50 zł").length === 0, phones("razem 123 456 789,50 zł"));
ok("cyfry w linku — nic", phones("https://example.com/a/600123456").length === 0, phones("https://example.com/a/600123456"));
ok("data — nic", phones("2026-10-20 12:30").length === 0);
ok("deduplikacja", phones("600 123 456 albo 600-123-456 albo +48600123456").length === 1);
ok("dwa różne", phones("Jan 600 123 456, Ola 501 222 333").length === 2);
ok("format mobile", formatPlPhone("501222333", false) === "501 222 333");
ok("format landline", formatPlPhone("124567890", true) === "+48 12 456 78 90");

// --- mapy ---
const m1 = extractMaps("Wjazd tu: https://www.google.com/maps/place/X/@52.2297,21.0122,17z bramą");
ok("google @lat,lng", m1.length === 1 && m1[0].lat === 52.2297 && m1[0].lng === 21.0122 && m1[0].provider === "Google Maps" && !!m1[0].navHref, m1);
const m2 = extractMaps("https://maps.app.goo.gl/AbCd123");
ok("krótki link bez współrzędnych", m2.length === 1 && m2[0].lat === null && m2[0].navHref === null, m2);
ok("goo.gl/maps", extractMaps("https://goo.gl/maps/xyz").length === 1);
ok("maps.google.pl ?q=", extractMaps("https://maps.google.pl/?q=50.06,19.94")[0]?.lat === 50.06);
ok("apple ll", extractMaps("https://maps.apple.com/?ll=52.1,21.2&q=Brama")[0]?.lng === 21.2, extractMaps("https://maps.apple.com/?ll=52.1,21.2&q=Brama"));
ok("osm mlat", extractMaps("https://www.openstreetmap.org/?mlat=52.5&mlon=21.5#map=16/52.5/21.5")[0]?.lat === 52.5);
ok("osm #map", extractMaps("https://www.openstreetmap.org/#map=16/52.4/21.4")[0]?.lng === 21.4);
ok("zwykły link google — nie mapa", extractMaps("https://www.google.com/search?q=alfa").length === 0);
ok("zwykła strona — nie mapa", extractMaps("https://example.com/maps").length === 0);
ok("deduplikacja map (www, /)", extractMaps("https://maps.app.goo.gl/Ab https://maps.app.goo.gl/Ab/").length === 1);

// --- całość ---
const all = extractNoteActions(
  "Klient: 600 123 456\nMapa: https://maps.app.goo.gl/Ab\nPortier 22 123 45 67",
  { phones: ["+48 600-123-456"] },
);
ok("mapy pierwsze, wykluczony telefon kontaktowy", all.map((a) => a.kind).join() === "map,phone" && all[1].kind === "phone" && all[1].href === "tel:+48221234567", all);
ok("pusty tekst", extractNoteActions("").length === 0 && extractNoteActions(null).length === 0);
ok(
  "limit 6",
  extractNoteActions(Array.from({ length: 9 }, (_, i) => `60${i} 123 456`).join("\n")).length === 6,
);

console.log(failures ? `\n${failures} FAIL` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
