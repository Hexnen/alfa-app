/**
 * Dojazd z biura do zlecenia — JEDNO liczenie na zlecenie na sesję.
 *
 * Ekran zlecenia („Z biura: 23,4 km · ok. 35 min”) i protokół (kilometry
 * w polu) pytały backend osobno, więc technik widział „Liczę odległość…” po
 * raz drugi tuż po tym, jak przeczytał wynik kafla. Backend i tak ma cache
 * geokodera, ale w terenie liczy się każda sekunda i każde żądanie.
 *
 * Pamięć: obietnica w module (deduplikacja żądań w locie) + `sessionStorage`
 * z terminem ważności, żeby wynik przeżył obrót ekranu i wejście w protokół.
 * `peekJobDistance` oddaje wynik synchronicznie — ekran, który go ma, nie
 * pokazuje w ogóle stanu ładowania.
 */
import { technikApi, type TechnikJobDistance } from "@/lib/api";

const TTL_MS = 30 * 60 * 1000;
const KEY = (id: number) => `technik.distance.${id}`;

const inflight = new Map<number, Promise<TechnikJobDistance>>();
const memory = new Map<number, { at: number; value: TechnikJobDistance }>();

function readStored(id: number): TechnikJobDistance | null {
  const hit = memory.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const raw = sessionStorage.getItem(KEY(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; value: TechnikJobDistance };
    if (Date.now() - parsed.at >= TTL_MS) return null;
    memory.set(id, parsed);
    return parsed.value;
  } catch {
    return null;
  }
}

function store(id: number, value: TechnikJobDistance): void {
  const entry = { at: Date.now(), value };
  memory.set(id, entry);
  try {
    sessionStorage.setItem(KEY(id), JSON.stringify(entry));
  } catch {
    /* tryb prywatny — zostaje pamięć modułu */
  }
}

/** Wynik z pamięci albo `null` — bez żądania. */
export function peekJobDistance(id: number): TechnikJobDistance | null {
  return readStored(id);
}

/** Dojazd z pamięci albo z backendu (jedno żądanie na zlecenie). Błąd → `{ km: null, reason }`. */
export function getJobDistance(id: number, opts: { force?: boolean } = {}): Promise<TechnikJobDistance> {
  if (!opts.force) {
    const stored = readStored(id);
    if (stored) return Promise.resolve(stored);
    const pending = inflight.get(id);
    if (pending) return pending;
  }
  const p = technikApi
    .jobDistance(id)
    .then((d) => {
      // Brak wyniku (geokoder, brak biura) też zapamiętujemy — inaczej każdy
      // ekran pytałby od nowa o to samo „nie da się”.
      store(id, d);
      return d;
    })
    .catch(() => {
      const d: TechnikJobDistance = { km: null, reason: "Nie udało się policzyć odległości" };
      return d;
    })
    .finally(() => {
      inflight.delete(id);
    });
  inflight.set(id, p);
  return p;
}
