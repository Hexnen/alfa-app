/**
 * Wspólne części szablonów umów: miejscownik nazw miast i drobne formatowanie
 * danych z kartoteki (adres, kwota, imię i nazwisko).
 *
 * DLACZEGO OSOBNY PLIK. Każdy wzór (ZDW, RODO, kolejne) ma własną definicję pól
 * i własny prefill, ale wszystkie sięgają po te same dane kartotekowe i muszą
 * je zapisywać TAK SAMO — inaczej ta sama firma wychodzi w dwóch umowach pod
 * dwoma adresami. Słownik miejscowników jest przy okazji zbyt kosztowny, żeby
 * go kopiować.
 */

// ---------------------------------------------------------------------------
// Miejscownik nazw miast
// ---------------------------------------------------------------------------

/**
 * Umowa mówi „świadczone wobec obiektu Heroldów 7 w Warszawie” i „zawarta
 * w Warszawie" — potrzebny jest MIEJSCOWNIK, a kartoteka trzyma mianownik.
 * Polskie miejscowniki nie dają się wyprowadzić regułą (Gdynia → Gdyni, ale
 * Warszawa → Warszawie), więc jest słownik największych miast, a dla reszty
 * zostaje mianownik + ostrzeżenie „popraw ręcznie”. Zgadywanie po końcówce
 * dawałoby „w Gdynie” w podpisanej umowie — lepiej powiedzieć wprost, że nie wiemy.
 */
const MIEJSCOWNIK: Record<string, string> = {
  warszawa: "Warszawie",
  kraków: "Krakowie",
  łódź: "Łodzi",
  wrocław: "Wrocławiu",
  poznań: "Poznaniu",
  gdańsk: "Gdańsku",
  szczecin: "Szczecinie",
  bydgoszcz: "Bydgoszczy",
  lublin: "Lublinie",
  białystok: "Białymstoku",
  katowice: "Katowicach",
  gdynia: "Gdyni",
  częstochowa: "Częstochowie",
  radom: "Radomiu",
  toruń: "Toruniu",
  sosnowiec: "Sosnowcu",
  rzeszów: "Rzeszowie",
  kielce: "Kielcach",
  gliwice: "Gliwicach",
  olsztyn: "Olsztynie",
  zabrze: "Zabrzu",
  "bielsko-biała": "Bielsku-Białej",
  bytom: "Bytomiu",
  "zielona góra": "Zielonej Górze",
  rybnik: "Rybniku",
  "ruda śląska": "Rudzie Śląskiej",
  opole: "Opolu",
  tychy: "Tychach",
  "gorzów wielkopolski": "Gorzowie Wielkopolskim",
  "dąbrowa górnicza": "Dąbrowie Górniczej",
  elbląg: "Elblągu",
  płock: "Płocku",
  wałbrzych: "Wałbrzychu",
  włocławek: "Włocławku",
  tarnów: "Tarnowie",
  chorzów: "Chorzowie",
  koszalin: "Koszalinie",
  kalisz: "Kaliszu",
  legnica: "Legnicy",
  grudziądz: "Grudziądzu",
  słupsk: "Słupsku",
  jaworzno: "Jaworznie",
  "nowy sącz": "Nowym Sączu",
  "jelenia góra": "Jeleniej Górze",
  siedlce: "Siedlcach",
  mysłowice: "Mysłowicach",
  konin: "Koninie",
  piła: "Pile",
  inowrocław: "Inowrocławiu",
  lubin: "Lubinie",
  suwałki: "Suwałkach",
  gniezno: "Gnieźnie",
  głogów: "Głogowie",
  pabianice: "Pabianicach",
  leszno: "Lesznie",
  zamość: "Zamościu",
  pruszków: "Pruszkowie",
  łomża: "Łomży",
  ełk: "Ełku",
  chełm: "Chełmie",
  mielec: "Mielcu",
  przemyśl: "Przemyślu",
  "stalowa wola": "Stalowej Woli",
  tczew: "Tczewie",
  bełchatów: "Bełchatowie",
  świdnica: "Świdnicy",
  będzin: "Będzinie",
  zgierz: "Zgierzu",
  racibórz: "Raciborzu",
  legionowo: "Legionowie",
  ostrołęka: "Ostrołęce",
  świnoujście: "Świnoujściu",
  wejherowo: "Wejherowie",
  puławy: "Puławach",
  tarnobrzeg: "Tarnobrzegu",
  kołobrzeg: "Kołobrzegu",
  krosno: "Krośnie",
  piaseczno: "Piasecznie",
  otwock: "Otwocku",
  marki: "Markach",
  ząbki: "Ząbkach",
  józefów: "Józefowie",
  wołomin: "Wołominie",
  "grodzisk mazowiecki": "Grodzisku Mazowieckim",
  "mińsk mazowiecki": "Mińsku Mazowieckim",
  "nowy dwór mazowiecki": "Nowym Dworze Mazowieckim",
};

/** Miejscownik miasta albo mianownik + `false`, gdy słownik go nie zna. */
export function miejscownik(city: string): { value: string; known: boolean } {
  const key = city.trim().toLowerCase();
  const hit = MIEJSCOWNIK[key];
  return hit ? { value: hit, known: true } : { value: city.trim(), known: false };
}

// ---------------------------------------------------------------------------
// Formatowanie danych z kartoteki
// ---------------------------------------------------------------------------

/** Kwota jako napis do `fields`: całkowita bez części dziesiętnej, reszta z dwoma miejscami. */
export function moneyFieldValue(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Adres z dopiskiem „ul.”, gdy w kartotece jest sama nazwa ulicy. */
export function withStreetPrefix(address: string): string {
  const a = address.trim();
  if (!a) return "";
  return /^(ul\.|al\.|pl\.|os\.|aleja|aleje|plac|osiedle|rondo)\b/i.test(a) ? a : `ul. ${a}`;
}

export function fullName(c: { firstName: string; lastName: string }): string {
  return `${c.firstName} ${c.lastName}`.trim();
}

/**
 * Adres kontrahenta w jednej linii: „ul. Heroldów 7, 01-991 Warszawa”.
 * Puste części wypadają razem z przecinkiem — umowa nie ma prawa wyjść
 * z wiszącym „, ” po nazwie ulicy.
 */
export function contractorAddressLine(c: {
  address: string | null;
  postalCode: string | null;
  city: string | null;
}): string {
  return [c.address, [c.postalCode, c.city].filter(Boolean).join(" ")]
    .filter((p) => p && p.trim())
    .join(", ");
}
