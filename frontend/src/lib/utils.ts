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

export const objectTypeLabels: Record<string, string> = {
  monitoring: "Monitoring",
  physical: "Ochrona fizyczna",
  alarm: "Alarm",
  mixed: "Mieszany",
};

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
