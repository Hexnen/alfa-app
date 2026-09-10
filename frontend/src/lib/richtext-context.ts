/**
 * Kontekst wolnego tekstu — czego dotyczy notatka, którą właśnie renderujemy.
 *
 * Po co: karta z mini-mapą pokazuje pod pinezką „ile stąd do biura" i „ile stąd
 * do obiektu". Tego drugiego nie da się odczytać z samego tekstu — wie to
 * dopiero miejsce, w którym notatka wisi (dialog wydarzenia, kartoteka
 * obiektu). Przepychanie `objectId` przez `RichText` → `LinkPreviewCard` →
 * `MapPreviewCard` byłoby propsem wleczonym przez trzy warstwy tylko po to, by
 * użyła go jedna karta na dole — stąd kontekst.
 *
 * Domyślnie pusty: brak providera = brak „od obiektu", i tak ma być m.in. w
 * kartotece obiektu pod jego własną pinezką (dystans do samego siebie).
 *
 * Sam provider mieszka w `@/components/RichTextProvider` — tutaj zostaje to, co
 * nie jest komponentem (react-refresh nie lubi mieszania jednego z drugim).
 */
import { createContext, useContext } from "react";

export interface RichTextContextValue {
  /** Obiekt, którego dotyczy tekst; `null` = notatka bez obiektu. */
  objectId?: number | null;
}

export const RichTextContext = createContext<RichTextContextValue>({ objectId: null });

export function useRichTextContext(): RichTextContextValue {
  return useContext(RichTextContext);
}
