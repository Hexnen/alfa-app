import { PlayCircle, type LucideIcon } from "lucide-react";
import type { TechnikJob } from "@/lib/api";
import {
  EVENT_STATUS_META,
  EVENT_TYPE_META,
  EVENT_TYPE_UI,
  PILL_TONE,
  type EventTypeMeta,
} from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { countLabel } from "./protocol";

/**
 * Stan zlecenia widziany przez technika. Backend nie ma statusu `in_progress`
 * (enum kalendarza czyta zbyt wiele miejsc), więc „w toku” wynika z pary
 * `startedAt` + status inny niż `done` — dokładnie tak, jak liczy to backend.
 */
export type JobState = "planned" | "running" | "done" | "cancelled";

export function jobStateOf(job: Pick<TechnikJob, "status" | "startedAt">): JobState {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "done") return "done";
  return job.startedAt ? "running" : "planned";
}

export const JOB_STATE_LABELS: Record<JobState, string> = {
  planned: EVENT_STATUS_META.planned.label,
  running: "W toku",
  done: "Zakończone",
  cancelled: EVENT_STATUS_META.cancelled.label,
};

/**
 * Ikony stanu — ten sam język znaków co w kalendarzu technicznym (status
 * wydarzenia), z jednym dodatkiem: „w toku” nie jest statusem w bazie, więc
 * nie ma swojego wpisu w EVENT_STATUS_META.
 */
export const JOB_STATE_ICONS: Record<JobState, LucideIcon> = {
  planned: EVENT_STATUS_META.planned.icon,
  running: PlayCircle,
  done: EVENT_STATUS_META.done.icon,
  cancelled: EVENT_STATUS_META.cancelled.icon,
};

/**
 * Klasy pigułki stanu. Kolory bierzemy WPROST z badge'y kalendarza
 * (EVENT_STATUS_META.badge), żeby ta sama robota wyglądała tak samo w panelu
 * i na ekranie biura — razem z wariantem ciemnym, którego własne
 * `bg-amber-100` nie miało. Kolor nigdy nie jest jedynym nośnikiem znaczenia:
 * obok stoi etykieta i ikona.
 */
export const JOB_STATE_CLASSES: Record<JobState, string> = {
  planned: EVENT_STATUS_META.planned.badge,
  // „W toku” to stan panelu, nie kalendarza — bierzemy ton pigułki z tej samej
  // palety (PILL_TONE), a nie przypadkowy odcień.
  running: PILL_TONE.amber,
  done: EVENT_STATUS_META.done.badge,
  cancelled: cn(PILL_TONE.muted, "line-through"),
};

/**
 * Metadane typu zlecenia = metadane typu WYDARZENIA z kalendarza (ikona,
 * etykieta, klasy chipa). Panel nie trzyma już własnej mapy kolorów — dwie
 * listy prawdy rozjeżdżały się przy każdym nowym typie.
 */
export function jobTypeMeta(type: string): EventTypeMeta | undefined {
  return (EVENT_TYPE_META as Record<string, EventTypeMeta>)[type];
}

/** Klasa paska koloru typu (jak kolorowy pasek kafelka w kalendarzu). */
export function typeBarClass(type: string): string {
  return (EVENT_TYPE_UI as Record<string, { bar: string } | undefined>)[type]?.bar ?? "bg-muted-foreground";
}

/** Klasa chipa typu — obramowanie i kolor tekstu jak przy filtrach kalendarza. */
export function typeChipClass(type: string): string {
  return jobTypeMeta(type)?.chip ?? "border-input text-muted-foreground";
}

/**
 * CZY TO ZLECENIE MA PAPIER.
 *
 * Panel pokazuje wszystkie typy przypisane technikowi, ale protokół powstaje
 * tylko z realizacji — „nagranie”, „biuro”, „przygotowanie” i urlop jej nie
 * dostają, więc przycisk „Protokół” kończyłby się komunikatem błędu. Decyduje
 * BACKEND (`canProtocol` liczone z ustawień kalendarza, nie ze sztywnej listy
 * typów); starsza odpowiedź bez tego pola zachowuje się jak dotąd.
 */
export function jobCanProtocol(job: Pick<TechnikJob, "canProtocol" | "protocol">): boolean {
  // Papier, który już jest, otwieramy zawsze — nawet gdyby admin właśnie zdjął
  // ten typ z listy objętych realizacją.
  return job.protocol != null || (job.canProtocol ?? true);
}

/** Czy mają sens „Rozpocznij”/„Zakończ”/„Wznów” (urlop: nie). */
export function jobCanProgress(job: Pick<TechnikJob, "canProgress">): boolean {
  return job.canProgress ?? true;
}

/**
 * Link do nawigacji. Gotowy `mapsUrl` z kartoteki wygrywa (pinezka stoi tam,
 * gdzie wjeżdża auto), a gdy go nie ma — wyszukiwanie po adresie. Sam adres
 * bez obiektu to i tak lepszy cel niż brak przycisku.
 */
export function mapsHref(job: {
  mapsUrl: string | null;
  address: string | null;
  objectName: string | null;
}): string | null {
  if (job.mapsUrl) return job.mapsUrl;
  const query = [job.objectName, job.address].filter(Boolean).join(", ");
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** `tel:` z numeru w dowolnym zapisie (spacje, myślniki, prefiks). */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned.length >= 6 ? `tel:${cleaned}` : null;
}

/**
 * Liczebnik zleceń — JEDNO miejsce dla mapy, licznika zakresu i etykiet
 * pinezek. Wcześniej każdy z tych trzech ekranów odmieniał po swojemu
 * („11 zlecenia”, „2 zleceń”), bo każdy miał własną kopię reguły.
 */
export function jobsLabel(n: number): string {
  return countLabel(n, "zlecenie", "zlecenia", "zleceń");
}

/** Liczebnik obiektów — tytuł pinezki, pod którą stoi kilka różnych obiektów. */
export function objectsLabel(n: number): string {
  return countLabel(n, "obiekt", "obiekty", "obiektów");
}
