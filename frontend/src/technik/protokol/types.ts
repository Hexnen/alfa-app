import type { TechnikJobDetails, TechnikProtocol } from "@/lib/api";
import type { FormState } from "../lib/protocol";

/**
 * Wspólny zestaw propsów kroku protokołu. Stan trzyma strona (`pages/Protokol
 * .tsx`), bo to ona zapisuje na serwer — kroki są czystymi widokami nad jednym
 * `FormState` i nie wiedzą nic o autozapisie.
 */
export interface StepProps {
  protocol: TechnikProtocol;
  /** `null` = zlecenie się nie wczytało; protokół i tak ma się dać wypełnić. */
  job: TechnikJobDetails | null;
  form: FormState;
  /** Zmiana jednego pola (oznacza formularz jako brudny). */
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  /** Zmiana kilku pól naraz albo wyliczana z poprzedniego stanu. */
  update: (fn: (prev: FormState) => FormState) => void;
  readOnly: boolean;
}
