import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "-";
  return new Date(date).toLocaleDateString("pl-PL");
}

export function formatDateTime(date: string | null | undefined): string {
  if (!date) return "-";
  return new Date(date).toLocaleString("pl-PL");
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: "PLN",
  }).format(value);
}

/**
 * USŁUGI OBIEKTU — cztery niezależne flagi zamiast jednego „typu ochrony”.
 * Jeden wybór nie opisywał obiektu, na którym jest i alarm, i kamery, i warta,
 * a od zestawu usług zależy, którym kluczem liczy się koszt osobowy:
 *  - OFI (ochrona fizyczna) → koszt wprost z godzin pracowników TEGO obiektu,
 *  - kamery / SSWiN / wideorecepcja → udział w koszcie centrum monitorowania.
 *
 * Kolejność jest wspólna dla etykiet, filtrów i wykresów: najpierw usługi
 * dozorowane z centrum (w kolejności, w jakiej mówi o nich firma), na końcu
 * ochrona fizyczna, bo liczy się zupełnie inaczej.
 */
export const objectServiceLabels = {
  kamery: "Kamery",
  sswin: "SSWiN",
  wideorecepcja: "Wideorecepcja",
  ofi: "OFI",
} as const;

export type ObjectServiceKey = keyof typeof objectServiceLabels;

/** Kolejność wyświetlania usług — patrz komentarz przy `objectServiceLabels`. */
export const objectServiceKeys = Object.keys(objectServiceLabels) as ObjectServiceKey[];

/**
 * Zestaw usług obiektu w kształcie, w jakim przychodzi z API. Wszystko opcjonalne,
 * bo ten sam helper obsługuje wiersz listy, kartotekę i wiersz analityki — a te
 * ostatnie mogą (przejściowo) nie nieść jeszcze wszystkich pól.
 */
export interface ObjectServices {
  hasCameras?: boolean | null;
  /** null przy `hasCameras` = usługa jest, ale nikt nie policzył kamer — to NIE zero. */
  cameraCount?: number | null;
  hasSswin?: boolean | null;
  hasVideoreception?: boolean | null;
  hasOfi?: boolean | null;
}

/** Usługi obiektu jako lista kluczy, w kolejności wyświetlania. */
export function objectServicesOf(o: ObjectServices): ObjectServiceKey[] {
  return objectServiceKeys.filter((k) =>
    k === "kamery"
      ? !!o.hasCameras
      : k === "sswin"
        ? !!o.hasSswin
        : k === "wideorecepcja"
          ? !!o.hasVideoreception
          : !!o.hasOfi
  );
}

/**
 * Skład usług jednym napisem, np. „Kamery 8 · SSWiN”.
 *
 * Kamery bez podanej liczby to „Kamery (ilość?)”, a nie „Kamery 0”: brak liczby
 * znaczy, że nikt ich nie policzył, więc obiekt nie ma jak dostać wagi przy
 * podziale kosztu centrum monitorowania. Ten sam idiom, co kreska przy
 * nieuzupełnionym koszcie — brak danych ma być widać, a nie udawać zera.
 * Obiekt bez żadnej usługi → „—”, żeby luka w kartotece nie zniknęła w pustce.
 */
export function objectServicesLabel(o: ObjectServices, empty = "—"): string {
  const parts = objectServicesOf(o).map((k) =>
    k === "kamery"
      ? `Kamery ${o.cameraCount ?? "(ilość?)"}`
      : objectServiceLabels[k]
  );
  return parts.length > 0 ? parts.join(" · ") : empty;
}

/**
 * OKRESY USŁUG — ta sama usługa może wystąpić na obiekcie wiele razy (kamery
 * 2020–2022 i znów od 2024), więc flagi `hasX` wyżej są tylko CACHE stanu na
 * dziś, a źródłem prawdy jest lista okresów (`ObjectService[]` z api.ts).
 *
 * Typ jest strukturalny (a nie importowany z `./api`), bo `utils` nie zależy od
 * warstwy sieciowej i te same helpery muszą przyjąć zarówno wiersz z API, jak
 * i szkic z formularza (`ObjectServiceInput`, jeszcze bez `id`).
 */
export interface ObjectServicePeriod {
  service: ObjectServiceKey;
  /** YYYY-MM-DD, wymagana. */
  startDate: string;
  /** YYYY-MM-DD albo null/undefined = usługa trwa bezterminowo. */
  endDate?: string | null;
  /** Tylko kamery; null = usługa jest, ale kamer nikt nie policzył (≠ 0). */
  cameraCount?: number | null;
}

/**
 * Dzisiejsza data jako YYYY-MM-DD w strefie PRZEGLĄDARKI.
 *
 * `new Date().toISOString()` dałoby UTC, więc po polskiej 22:00 (CEST) pokazywałby
 * już jutro i okres kończący się „dziś” wyglądałby na zakończony. Daty usług są
 * kalendarzowe, nie chwilowe — porównujemy je jak napisy.
 */
export function todayIsoLocal(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Okres ZAKOŃCZONY = ma koniec wcześniejszy niż dziś. Ta sama reguła co na
 * backendzie (`isServiceEnded` w src/lib/object-services.ts): aktywny jest okres
 * z `endDate` pustym albo `>= dziś`, więc dzień końca jeszcze się liczy.
 */
export function isServicePeriodEnded(
  p: Pick<ObjectServicePeriod, "endDate">,
  today: string = todayIsoLocal()
): boolean {
  return !!p.endDate && p.endDate < today;
}

/**
 * Okres ZAPLANOWANY = start w przyszłości. Nadal jest AKTYWNY (wlicza się do flag
 * i analityki — literówka w roku nie może wyrzucić obiektu z raportów), UI tylko
 * oznacza go badge'em.
 */
export function isServicePeriodPlanned(
  p: Pick<ObjectServicePeriod, "startDate" | "endDate">,
  today: string = todayIsoLocal()
): boolean {
  return p.startDate > today && !isServicePeriodEnded(p, today);
}

/**
 * Jeden okres jednym napisem: „Kamery 8 · od 01.01.2024” albo
 * „Kamery 8 · 01.01.2020 – 31.12.2022”.
 *
 * Kamery bez liczby to „Kamery (ilość?)” — dokładnie jak w `objectServicesLabel`,
 * bo brak danych ma być widać, a nie udawać zera.
 */
export function servicePeriodLabel(p: ObjectServicePeriod): string {
  const name =
    p.service === "kamery"
      ? `Kamery ${p.cameraCount ?? "(ilość?)"}`
      : objectServiceLabels[p.service];
  const range = p.endDate
    ? `${formatDate(p.startDate)} – ${formatDate(p.endDate)}`
    : `od ${formatDate(p.startDate)}`;
  return `${name} · ${range}`;
}

/**
 * Flagi usług „na dziś” policzone z okresów — ten sam rachunek, co
 * `flagsFromServices` na backendzie, żeby formularz pokazywał to samo, co zapisze
 * serwer (podgląd przed zapisem, bez rundy po sieć).
 *
 * `cameraCount` to suma po AKTYWNYCH okresach kamer, ale `null`, gdy choć jeden
 * z nich nie ma liczby: suma „8 + nie wiadomo ile” nie jest ośmioma kamerami,
 * a od tej liczby zależy waga obiektu przy podziale kosztu centrum monitorowania.
 */
export function activeServiceFlagsOf(
  periods: readonly ObjectServicePeriod[],
  today: string = todayIsoLocal()
): Required<Pick<ObjectServices, "hasCameras" | "hasSswin" | "hasVideoreception" | "hasOfi">> & {
  cameraCount: number | null;
} {
  const active = periods.filter((p) => !isServicePeriodEnded(p, today));
  const cameras = active.filter((p) => p.service === "kamery");
  const cameraCount =
    cameras.length === 0
      ? null
      : cameras.some((p) => p.cameraCount == null)
        ? null
        : cameras.reduce((sum, p) => sum + (p.cameraCount ?? 0), 0);
  return {
    hasCameras: cameras.length > 0,
    hasSswin: active.some((p) => p.service === "sswin"),
    hasVideoreception: active.some((p) => p.service === "wideorecepcja"),
    hasOfi: active.some((p) => p.service === "ofi"),
    cameraCount,
  };
}

export const installationTypeLabels: Record<string, string> = {
  new: "Nowa instalacja",
  takeover: "Przejęcie",
};

export const statusLabels: Record<string, string> = {
  pending: "Oczekujący",
  in_progress: "W realizacji",
  active: "Aktywny",
  inactive: "Nieaktywny",
};

export const departmentLabels: Record<string, string> = {
  sales: "Handlowy",
  technical: "Techniczny",
  accounting: "Księgowość",
};

export const contractStatusLabels: Record<string, string> = {
  draft: "Szkic",
  active: "Aktywna",
  expired: "Wygasła",
  terminated: "Rozwiązana",
};
