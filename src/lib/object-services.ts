import type { ObjectType } from "../types/index.js";

/** Usługi obiektu w kształcie, w jakim przychodzą z formularzy. */
export interface ObjectServiceFlags {
  hasCameras?: boolean | null;
  hasSswin?: boolean | null;
  hasVideoreception?: boolean | null;
  hasOfi?: boolean | null;
}

/**
 * Dawny „typ ochrony” wyliczony z usług.
 *
 * Kolumna `objects.type` jest @deprecated, ale wciąż NOT NULL i wciąż czyta ją
 * kilka miejsc (m.in. analityka), więc każdy zapis musi ją czymś wypełnić.
 * Odwzorowanie jest odwrotnością migracji 0055 (monitoring → kamery, alarm →
 * SSWiN, physical → OFI, mixed → kamery + SSWiN), żeby dane zapisane po zmianie
 * wyglądały tak samo jak przemigrowane. Znika razem z kolumną.
 */
export function legacyObjectType(s: ObjectServiceFlags): ObjectType {
  const cameras = !!s.hasCameras || !!s.hasVideoreception;
  const sswin = !!s.hasSswin;
  if (cameras && sswin) return "mixed";
  if (cameras) return "monitoring";
  if (sswin) return "alarm";
  if (s.hasOfi) return "physical";
  // Obiekt bez ani jednej usługi: kolumna musi mieć wartość, a „monitoring” było
  // dotąd domyślnym wyborem formularzy. Prawda o usługach siedzi w has_*.
  return "monitoring";
}
