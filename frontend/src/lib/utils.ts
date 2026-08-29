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
