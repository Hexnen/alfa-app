/**
 * Test parsera linków Google Maps (`src/lib/maps-url.ts` → `parseGoogleMapsUrl`).
 *
 * CZYSTY: bez bazy, bez sieci — uruchamiaj wprost:
 *   npx tsx scripts/test-maps-url.ts
 *
 * Parser karmi kartę z mini-mapą pod notatką (`MapPreviewCard`), więc pilnujemy
 * tu dwóch rzeczy naraz: że rozpoznaje wszystkie kształty adresu, jakie Mapy
 * potrafią wygenerować, i że NIE udaje, że rozpoznał coś, czego nie ma
 * (współrzędne poza zakresem, zwykła wyszukiwarka Google).
 */
import { parseGoogleMapsUrl, isGoogleHost, isGoogleShortHost } from "../src/lib/maps-url.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

/** Skrót do porównań „czy punkt się zgadza" z tolerancją na zapis liczby. */
function at(v: ReturnType<typeof parseGoogleMapsUrl>, lat: number, lng: number): boolean {
  return !!v && v.lat === lat && v.lng === lng;
}

console.log("\n=== A. Hosty ===");
ok("google.pl", isGoogleHost("google.pl"));
ok("www.google.com", isGoogleHost("www.google.com"));
ok("maps.google.de", isGoogleHost("maps.google.de"));
ok("google.co.uk", isGoogleHost("google.co.uk"));
ok("google.evil.com NIE jest Google", !isGoogleHost("google.evil.com"));
ok("notgoogle.pl NIE jest Google", !isGoogleHost("notgoogle.pl"));
ok("maps.app.goo.gl to krótki link", isGoogleShortHost("maps.app.goo.gl"));
ok("goo.gl to krótki link", isGoogleShortHost("goo.gl"));
ok("g.co to krótki link", isGoogleShortHost("g.co"));
ok("goo.gl.evil.com NIE jest krótkim linkiem", !isGoogleShortHost("goo.gl.evil.com"));

console.log("\n=== B. Warianty adresu ===");

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/place/Pa%C5%82ac+Kultury+i+Nauki/@52.2317,21.0062,17z");
  ok("/place/<Nazwa>/@lat,lng,17z — punkt", at(v, 52.2317, 21.0062), v);
  ok("…zoom 17", v?.zoom === 17, v);
  ok("…nazwa zdekodowana, `+` → spacja", v?.label === "Pałac Kultury i Nauki", v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.pl/maps/@52.2297,21.0122,15z");
  ok("/maps/@lat,lng,15z", at(v, 52.2297, 21.0122) && v?.zoom === 15 && !v?.label, v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps?q=52.2297,21.0122");
  ok("/maps?q=lat,lng", at(v, 52.2297, 21.0122), v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps?q=Zielona%20G%C3%B3ra%20ratusz");
  ok("?q=<tekst> → query bez współrzędnych", v?.query === "Zielona Góra ratusz" && v?.lat === undefined, v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/search/Stacja+paliw/@51.1079,17.0385,14z");
  ok("/maps/search/<tekst>/@lat,lng", at(v, 51.1079, 17.0385) && v?.query === "Stacja paliw", v);
}

{
  const v = parseGoogleMapsUrl(
    "https://www.google.com/maps/dir/Warszawa,+Prosta+51/Kraków/@50.9,19.5,8z/data=!3m1!4b1"
  );
  ok("/maps/dir/…/@lat,lng — sam punkt, bez query ze startu", at(v, 50.9, 19.5) && !v?.query, v);
}

{
  const v = parseGoogleMapsUrl("https://maps.google.com/maps?ll=54.352,18.6466&z=13");
  ok("maps?ll=lat,lng + z=13", at(v, 54.352, 18.6466) && v?.zoom === 13, v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/place/Hotel+Bristol");
  ok("/place/<tekst> bez @ — tylko etykieta", v?.label === "Hotel Bristol" && v?.lat === undefined, v);
}

{
  const v = parseGoogleMapsUrl("https://maps.app.goo.gl/abc123XYZ");
  ok("maps.app.goo.gl/* → short, bez punktu", v?.short === true && v?.lat === undefined, v);
}

{
  const v = parseGoogleMapsUrl("https://goo.gl/maps/abc123");
  ok("goo.gl/maps/* → short", v?.short === true, v);
}

{
  const v = parseGoogleMapsUrl("https://g.co/kgs/abc123");
  ok("g.co/kgs/* → short", v?.short === true, v);
}

{
  const v = parseGoogleMapsUrl(
    "https://www.google.com/maps/place/Test/data=!4m2!3m1!1s0x0:0x0!3d52.4064!4d16.9252"
  );
  ok("!3d/!4d z bloku data= gdy nie ma @", at(v, 52.4064, 16.9252), v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/place/52.2297,21.0122/@52.2297,21.0122,16z");
  ok("/place/<lat,lng> — współrzędne to nie etykieta", at(v, 52.2297, 21.0122) && !v?.label, v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/dir/?api=1&destination=52.1,21.2");
  ok("dir?api=1&destination=lat,lng", at(v, 52.1, 21.2), v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/@52.2297,21.0122,17.5z");
  ok("zoom ułamkowy → zaokrąglony", v?.zoom === 18, v);
}

// Pinezka udostępniona z telefonu: krótki link rozwija się DOKŁADNIE w to —
// współrzędne w ścieżce `search`, z `+` w roli spacji i śmieciowymi parametrami.
// (Zgłoszenie z produkcji: maps.app.goo.gl/5NfwcwXEJZt45ZEZ6.)
{
  const v = parseGoogleMapsUrl(
    "https://www.google.com/maps/search/52.294366,+21.061768?entry=tts&g_ep=EgoyMDI2MDkwNi4w&skid=515741ae"
  );
  ok("/maps/search/<lat>,+<lng> z parametrami entry/g_ep/skid", at(v, 52.294366, 21.061768), v);
  ok("…same współrzędne nie robią etykiety ani frazy", !v?.label && !v?.query, v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/search/52.294366%2C+21.061768");
  ok("/maps/search/<lat>%2C+<lng> (zakodowany przecinek)", at(v, 52.294366, 21.061768), v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/search/52.294366%2C%2021.061768");
  ok("/maps/search/<lat>%2C%20<lng> (zakodowana spacja)", at(v, 52.294366, 21.061768), v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/search/52.294366,21.061768");
  ok("/maps/search/<lat>,<lng> bez spacji", at(v, 52.294366, 21.061768), v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps?q=52.29,+21.06");
  ok("?q=<lat>,+<lng>", at(v, 52.29, 21.06), v);
}

{
  const v = parseGoogleMapsUrl("https://www.google.com/maps/place/52.294366,+21.061768");
  ok("/maps/place/<lat>,+<lng>", at(v, 52.294366, 21.061768) && !v?.label, v);
}

console.log("\n=== C. Odrzucenia ===");

ok("lat=999 → null (nic sensownego w adresie)", parseGoogleMapsUrl("https://www.google.com/maps/@999,21,17z") === null);
ok(
  "lng=999 przy nazwie miejsca → nazwa zostaje, punktu nie ma",
  (() => {
    const v = parseGoogleMapsUrl("https://www.google.com/maps/place/Rynek/@52.2,999,17z");
    return v?.label === "Rynek" && v?.lat === undefined;
  })()
);
ok("google.com/search?q=… → null", parseGoogleMapsUrl("https://www.google.com/search?q=mapa+warszawy") === null);
ok("inny serwis map → null", parseGoogleMapsUrl("https://www.openstreetmap.org/#map=17/52.23/21.01") === null);
ok("google.evil.com/maps → null", parseGoogleMapsUrl("https://google.evil.com/maps/@52.2,21.0,17z") === null);
ok("nie-URL → null", parseGoogleMapsUrl("to nie jest adres") === null);
ok("javascript: → null", parseGoogleMapsUrl("javascript:alert(1)") === null);
ok("pusty → null", parseGoogleMapsUrl("") === null);
ok("zoom 0 odrzucony", parseGoogleMapsUrl("https://www.google.com/maps/@52.2,21.0,0z")?.zoom === undefined);
ok("zoom 99 odrzucony", parseGoogleMapsUrl("https://www.google.com/maps?ll=52.2,21.0&z=99")?.zoom === undefined);

console.log(failures === 0 ? "\nWszystko przeszło." : `\n${failures} testów nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
