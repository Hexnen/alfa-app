/** Pola karty „Raporty z podjazdów” we wspólnym formularzu poczty (CmaSettings). */
import type { CmaMailSettings } from "@/lib/api";

export interface PatrolMailForm {
  patrolEnabled: boolean;
  patrolFolder: string;
  patrolSubjectFilter: string;
  patrolFromFilter: string;
  patrolLookbackDays: string;
}

export function patrolFormFrom(s: CmaMailSettings): PatrolMailForm {
  return {
    patrolEnabled: s.patrolEnabled ?? true,
    patrolFolder: s.patrolFolder ?? "",
    patrolSubjectFilter: s.patrolSubjectFilter ?? "",
    patrolFromFilter: s.patrolFromFilter ?? "",
    patrolLookbackDays: String(s.patrolLookbackDays ?? 30),
  };
}

export function patrolLookbackValue(value: string): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30;
}
